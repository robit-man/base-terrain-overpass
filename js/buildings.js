import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const FEATURES = {
  BUILDINGS: true,
  ROADS: true,
  WATERWAYS: true,
  AREAS: false,
};

const OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
const CACHE_PREFIX = 'bm.tile';
const CACHE_LIMIT = 160;
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
const MERGE_BUDGET_MS = 6; // milliseconds per idle slice
const BUILD_FRAME_BUDGET_MS = 2.0; // ms budget to spend per frame on feature builds
const BUILD_IDLE_BUDGET_MS = 8.0; // ms budget when we have idle time available
const RESNAP_INTERVAL = 1.0; // seconds between ground rescan passes
const RESNAP_FRAME_BUDGET_MS = 1.5; // ms per frame allotted to resnap tiles

function metresPerDegree(lat) {
  const phi = THREE.MathUtils.degToRad(lat);
  return {
    dLat: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    dLon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

function averagePoint(flat) {
  let sx = 0;
  let sz = 0;
  let n = 0;
  for (let i = 0; i < flat.length; i += 2) {
    sx += flat[i];
    sz += flat[i + 1];
    n++;
  }
  if (!n) return { x: 0, z: 0 };
  return { x: sx / n, z: sz / n };
}

function buildOverpassQuery(bbox) {
  const [minLat, minLon, maxLat, maxLon] = bbox;
  return `
    [out:json][timeout:25];
    (
      way["building"](${minLat},${minLon},${maxLat},${maxLon});
      way["highway"] (${minLat},${minLon},${maxLat},${maxLon});
      way["waterway"](${minLat},${minLon},${maxLat},${maxLon});
      way["leisure"="park"](${minLat},${minLon},${maxLat},${maxLon});
      way["landuse"] (${minLat},${minLon},${maxLat},${maxLon});
    );
    (._;>;);
    out body;
  `.trim();
}

function formatAddress(tags = {}) {
  if (!tags) return 'Unknown address';

  const full =
    tags['addr:full'] ||
    tags['addr:full:en'] ||
    tags['addr:full:local'];
  if (full) return full;

  const segments = [];

  if (tags['addr:housename']) segments.push(tags['addr:housename']);

  const streetParts = [];
  if (tags['addr:housenumber']) streetParts.push(tags['addr:housenumber']);
  if (tags['addr:street']) streetParts.push(tags['addr:street']);
  if (!segments.length && tags['addr:place']) streetParts.push(tags['addr:place']);
  if (streetParts.length) segments.push(streetParts.join(' '));

  const localityParts = [];
  if (tags['addr:unit']) localityParts.push(`Unit ${tags['addr:unit']}`);
  if (tags['addr:city']) localityParts.push(tags['addr:city']);
  if (tags['addr:state']) localityParts.push(tags['addr:state']);
  if (tags['addr:postcode']) localityParts.push(tags['addr:postcode']);
  if (localityParts.length) segments.push(localityParts.join(', '));

  if (!segments.length && tags.name) segments.push(tags.name);
  if (!segments.length && tags['shop']) segments.push(tags['shop']);
  if (!segments.length && tags['amenity']) segments.push(tags['amenity']);
  if (!segments.length && tags['building']) segments.push(tags['building']);

  const text = segments
    .map((s) => String(s).trim())
    .filter(Boolean)
    .join(', ');
  return text || 'Unknown address';
}

export class BuildingManager {
  constructor({
    scene,
    camera,
    tileManager,
    radius = 800,
    tileSize,
    color = 0xffffff,
    roadWidth = 14,
    roadOffset = 0.06,
    extraDepth = 0.02,
    extensionHeight = 2,
    maxConcurrentFetches = 1, // retained for API compatibility
  } = {}) {
    this.scene = scene;
    this.camera = camera;
    this.tileManager = tileManager;
    this.radius = radius;
    this.tileSize = tileSize || (tileManager?.tileRadius ? tileManager.tileRadius * 1.75 : 160);
    this.color = color;
    this.roadWidth = roadWidth;
    this.roadOffset = roadOffset;
    this.roadHeightOffset = 0.12;
    this.extraDepth = extraDepth;
    this.extensionHeight = extensionHeight;

    this.group = new THREE.Group();
    this.group.name = 'osm-buildings';
    this.scene?.add(this.group);

    this._pickerRoot = new THREE.Group();
    this._pickerRoot.name = 'building-picker-root';
    this._pickerRoot.visible = true;
    this.group.add(this._pickerRoot);

    this._hoverGroup = new THREE.Group();
    this._hoverGroup.name = 'building-hover';
    this._hoverGroup.visible = false;
    this.group.add(this._hoverGroup);

    this._hoverEdges = null;
    this._hoverStem = null;
    this._hoverLabel = null;
    this._hoverLabelCanvas = null;
    this._hoverLabelCtx = null;
    this._hoverLabelTexture = null;
    this._hoverInfo = null;

    this.lat0 = null;
    this.lon0 = null;
    this.lat = null;
    this.lon = null;
    this._hasOrigin = false;

    this._tileStates = new Map();
    this._neededTiles = new Set();
    this._currentCenter = null;
    this._patchInflight = false;

    this._mergeQueue = [];
    this._pendingMergeTiles = new Set();
    this._activeMerge = null;

    this._buildQueue = [];
    this._buildJobMap = new Map();
    this._activeBuildJob = null;
    this._buildTickScheduled = false;

    this._resnapQueue = [];
    this._resnapIndex = 0;

    this._waterMaterials = new Set();

    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();

    this._waterTime = 0;

    this._edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85 });
    this._highlightEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xffd166, linewidth: 1, transparent: true, opacity: 1 });
    this._stemMaterial = new THREE.LineBasicMaterial({ color: 0xffd166, linewidth: 1, transparent: true, opacity: 0.9 });
    this._pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
    this._pickMaterial.depthWrite = false;
    this._pickMaterial.depthTest = false;

    this._cachePrefix = `${CACHE_PREFIX}:${this.tileSize}:`;
  }

  setOrigin(lat, lon) {
    const baseLat = this.tileManager?.origin?.lat ?? lat;
    const baseLon = this.tileManager?.origin?.lon ?? lon;
    const originChanged =
      !this._hasOrigin ||
      Math.abs((baseLat ?? 0) - (this.lat0 ?? Infinity)) > 1e-6 ||
      Math.abs((baseLon ?? 0) - (this.lon0 ?? Infinity)) > 1e-6;

    if (originChanged) {
      this.lat0 = baseLat;
      this.lon0 = baseLon;
      if (this._hasOrigin) this._clearAllTiles();
    }

    this.lat = lat;
    this.lon = lon;

    if (!this._hasOrigin) {
      this._hasOrigin = true;
      this._clearAllTiles();
      this._updateTiles(true);
    }
  }

  update(dt = 0) {
    if (!this._hasOrigin || !this.camera) return;

    this._updateTiles();
    this._drainBuildQueue(BUILD_FRAME_BUDGET_MS);
    this._processMergeQueue();

    this._resnapTimer = (this._resnapTimer || 0) + dt;
    if (this._resnapTimer > RESNAP_INTERVAL) {
      this._resnapTimer = 0;
      this._queueResnapSweep();
    }
    this._drainResnapQueue(RESNAP_FRAME_BUDGET_MS);

    this._waterTime += dt;
    for (const mat of this._waterMaterials) mat.uniforms.uTime.value = this._waterTime;

    if (this._hoverGroup.visible) this._orientLabel(this.camera);
  }

  dispose() {
    this.scene?.remove(this.group);
    this.clearHover();
    this._clearAllTiles();
    this._edgeMaterial.dispose();
    this._highlightEdgeMaterial.dispose();
    this._stemMaterial.dispose();
    this._pickMaterial.dispose();
  }

  _updateTiles(force = false) {
    this.camera.getWorldPosition(this._tmpVec);
    const key = this._tileKeyForWorld(this._tmpVec.x, this._tmpVec.z);
    if (!force && key === this._currentCenter) return;
    this._currentCenter = key;

    const [tx, tz] = key.split(',').map(Number);
    const needed = new Set();
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) needed.add(`${tx + dx},${tz + dz}`);
    }
    this._neededTiles = needed;

    const missing = [];
    for (const tileKey of needed) {
      let state = this._tileStates.get(tileKey);
      if (!state) {
        state = this._createTileState(tileKey);
        this._tileStates.set(tileKey, state);
      }

      if (state.status !== 'pending' && state.status !== 'error') continue;

      const cached = this._loadTileFromCache(tileKey);
      if (cached) {
        this._applyTileData(tileKey, cached, true);
        continue;
      }

      state.status = 'pending';
      missing.push(tileKey);
    }

    for (const tileKey of Array.from(this._tileStates.keys())) {
      if (!needed.has(tileKey)) this._unloadTile(tileKey);
    }

    if (missing.length && !this._patchInflight) {
      this._fetchPatch(Array.from(needed), missing);
    }
  }

  _createTileState(tileKey) {
    return {
      status: 'pending',
      buildings: [],
      extras: [],
      mergedGroup: null,
      raw: null,
      tileKey,
    };
  }

  async _fetchPatch(allTiles, targetTiles) {
    this._patchInflight = true;
    const bbox = this._combinedBbox(allTiles);
    try {
      const res = await fetch(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: buildOverpassQuery(bbox),
      });
      if (!res.ok) throw new Error(`Overpass ${res.status}`);
      const patchData = await res.json();
      this._distributePatchData(patchData, new Set(targetTiles));
      console.log(`[Buildings] patch fetched for tiles ${targetTiles.join(', ')}`);
    } catch (err) {
      console.warn('[Buildings] patch fetch failed', err);
      for (const key of targetTiles) {
        const state = this._tileStates.get(key);
        if (state) state.status = 'error';
      }
    } finally {
      this._patchInflight = false;
    }
  }

  _combinedBbox(tileKeys) {
    const lats = [];
    const lons = [];
    for (const key of tileKeys) {
      const [minLat, minLon, maxLat, maxLon] = this._bboxForTile(key);
      lats.push(minLat, maxLat);
      lons.push(minLon, maxLon);
    }
    return [Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons)];
  }

  _distributePatchData(patchData, targetSet) {
    const nodeMap = new Map();
    for (const el of patchData?.elements || []) if (el.type === 'node') nodeMap.set(el.id, el);

    const tileWays = new Map();
    const tileNodeIds = new Map();

    for (const el of patchData?.elements || []) {
      if (el.type !== 'way') continue;
      const pts = [];
      for (const nid of el.nodes || []) {
        const node = nodeMap.get(nid);
        if (!node) continue;
        const { x, z } = this._latLonToWorld(node.lat, node.lon);
        pts.push(x, z);
      }
      if (pts.length < 4) continue;

      const centre = averagePoint(pts);
      const tileKey = this._tileKeyForWorld(centre.x, centre.z);
      if (!targetSet.has(tileKey)) continue;

      if (!tileWays.has(tileKey)) {
        tileWays.set(tileKey, []);
        tileNodeIds.set(tileKey, new Set());
      }
      tileWays.get(tileKey).push({ way: el, points: pts });
      const idSet = tileNodeIds.get(tileKey);
      for (const nid of el.nodes || []) idSet.add(nid);
    }

    for (const tileKey of targetSet) {
      const state = this._tileStates.get(tileKey);
      if (!state) continue;

      const ways = tileWays.get(tileKey) || [];
      const ids = tileNodeIds.get(tileKey) || new Set();

      const tileData = { elements: [] };
      for (const nid of ids) {
        const node = nodeMap.get(nid);
        if (node) tileData.elements.push({ ...node });
      }
      for (const { way } of ways) tileData.elements.push({ ...way, nodes: way.nodes.slice() });

      this._applyTileData(tileKey, tileData, false);
      this._saveTileToCache(tileKey, tileData);
    }
  }

  _applyTileData(tileKey, data, fromCache) {
    const state = this._tileStates.get(tileKey);
    if (!state) return;

    this._cancelMerge(tileKey);
    this._cancelBuildJob(tileKey);
    this._removeTileObjects(tileKey);

    const nodeMap = new Map();
    for (const el of data?.elements || []) if (el.type === 'node') nodeMap.set(el.id, el);

    const features = [];
    let buildingCount = 0;
    let extraCount = 0;

    for (const el of data?.elements || []) {
      if (el.type !== 'way') continue;
      const tags = el.tags || {};
      const flat = [];
      for (const nid of el.nodes || []) {
        const node = nodeMap.get(nid);
        if (!node) continue;
        const { x, z } = this._latLonToWorld(node.lat, node.lon);
        flat.push(x, z);
      }
      if (flat.length < 4) continue;

      if (tags.building && FEATURES.BUILDINGS) {
        features.push({ kind: 'building', flat, tags, id: el.id });
        buildingCount++;
      } else if (tags.highway && FEATURES.ROADS) {
        features.push({ kind: 'road', flat, tags, id: el.id });
        extraCount++;
      } else if (tags.waterway && FEATURES.WATERWAYS) {
        features.push({ kind: 'water', flat, tags, id: el.id });
        extraCount++;
      } else if (FEATURES.AREAS && (tags.leisure === 'park' || tags.landuse)) {
        features.push({ kind: 'area', flat, tags, id: el.id });
        extraCount++;
      }
    }

    state.status = features.length ? 'building' : 'ready';
    state.buildings = [];
    state.extras = [];
    state.mergedGroup = null;
    state.raw = data;

    if (!features.length) {
      console.log(`[Buildings] applied 0 buildings + 0 extras for ${tileKey}${fromCache ? ' (cache)' : ''}`);
      return;
    }

    const job = {
      tileKey,
      features,
      featureIndex: 0,
      fromCache: !!fromCache,
      expected: { buildings: buildingCount, extras: extraCount },
    };

    this._enqueueBuildJob(job);
  }

  _buildBuilding(flat, tags, id) {
    const rawFootprint = flat.slice();
    const dense = this._densifyPolygon(flat, 1.5);
    if (dense.length < 6) return null;

    const shape = new THREE.Shape();
    for (let i = 0; i < dense.length; i += 2) {
      const x = dense[i];
      const z = dense[i + 1];
      if (i === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    }
    shape.autoClose = true;

    const height = this._chooseBuildingHeight(tags);
    const extrusion = height + this.extensionHeight;

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: extrusion,
      bevelEnabled: false,
    })
      .rotateX(-Math.PI / 2)
      .translate(0, -this.extraDepth, 0);

    const baseline = this._lowestGround(flat) + this.extraDepth;
    const groundBase = baseline - this.extraDepth;
    const wireGeom = this._makeWireGeometry(rawFootprint, groundBase, extrusion);
    const edges = new THREE.LineSegments(wireGeom, this._edgeMaterial);
    edges.position.set(0, 0, 0);
    edges.castShadow = false;
    edges.receiveShadow = false;

    const address = formatAddress(tags);

    const pickMesh = new THREE.Mesh(geo.clone(), this._pickMaterial);
    pickMesh.position.set(0, baseline, 0);

    const centroid = averagePoint(dense);

    const info = {
      id,
      address,
      rawFootprint,
      height: extrusion,
      baseHeight: groundBase,
      centroid,
      tags: { ...tags },
      tile: null,
    };

    pickMesh.userData.buildingInfo = info;
    edges.userData.buildingInfo = info;

    return { render: edges, pick: pickMesh, info };
  }

  _enqueueMerge(tileKey) {
    if (this._pendingMergeTiles.has(tileKey)) return;
    this._pendingMergeTiles.add(tileKey);
    this._mergeQueue.push(tileKey);
  }

  _enqueueBuildJob(job) {
    const state = this._tileStates.get(job.tileKey);
    if (state) state.status = 'building';
    job.cancelled = false;
    job.done = false;
    this._buildJobMap.set(job.tileKey, job);
    this._buildQueue.push(job);
    this._scheduleBuildTick();
  }

  _scheduleBuildTick() {
    if (this._buildTickScheduled) return;
    this._buildTickScheduled = true;
    const run = (deadline) => {
      this._buildTickScheduled = false;
      this._drainBuildQueue(BUILD_IDLE_BUDGET_MS, deadline);
      if (this._activeBuildJob || this._buildQueue.length) this._scheduleBuildTick();
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 32 });
    } else {
      setTimeout(() => run(), 0);
    }
  }

  _drainBuildQueue(budgetMs = BUILD_FRAME_BUDGET_MS, deadline) {
    if (!this._activeBuildJob && !this._buildQueue.length) return;

    const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const start = now();
    const hasDeadline = deadline && typeof deadline.timeRemaining === 'function';
    const timeRemaining = () => {
      const budgetLeft = budgetMs - (now() - start);
      const idleLeft = hasDeadline ? deadline.timeRemaining() : Infinity;
      return Math.min(budgetLeft, idleLeft);
    };

    while (timeRemaining() > 0) {
      if (!this._activeBuildJob) this._activeBuildJob = this._nextBuildJob();
      const job = this._activeBuildJob;
      if (!job) break;

      if (job.cancelled || !this._tileStates.has(job.tileKey)) {
        this._finishBuildJob(job, true);
        this._activeBuildJob = null;
        continue;
      }

      const progressed = this._advanceBuildJob(job, timeRemaining);
      if (!progressed) break;

      if (job.done || job.featureIndex >= job.features.length) {
        job.done = true;
        this._finishBuildJob(job, false);
        this._activeBuildJob = null;
      }

      if (timeRemaining() <= 0) break;
    }
  }

  _nextBuildJob() {
    while (this._buildQueue.length) {
      const job = this._buildQueue.shift();
      if (job && !job.cancelled) return job;
    }
    return null;
  }

  _advanceBuildJob(job, timeRemainingFn) {
    const state = this._tileStates.get(job.tileKey);
    if (!state) {
      job.cancelled = true;
      job.done = true;
      return true;
    }

    while (job.featureIndex < job.features.length && timeRemainingFn() > 0) {
      const feature = job.features[job.featureIndex++];
      this._instantiateFeature(state, job, feature);
      if (timeRemainingFn() <= 0) break;
    }

    if (job.featureIndex >= job.features.length) job.done = true;
    return true;
  }

  _instantiateFeature(state, job, feature) {
    const tileKey = job.tileKey;
    if (!state) return;

    switch (feature.kind) {
      case 'building': {
        const building = this._buildBuilding(feature.flat, feature.tags, feature.id);
        if (!building) return;
        const { render, pick, info } = building;
        info.tile = tileKey;
        this.group.add(render);
        this._pickerRoot.add(pick);
        render.updateMatrixWorld(true);
        pick.updateMatrixWorld(true);
        this._resnapBuilding(building);
        state.buildings.push(building);
        break;
      }
      case 'road': {
        const road = this._buildRoad(feature.flat, feature.tags, feature.id);
        if (!road) return;
        road.userData.tile = tileKey;
        this.group.add(road);
        state.extras.push(road);
        break;
      }
      case 'water': {
        const water = this._buildWater(feature.flat, feature.tags, feature.id);
        if (!water) return;
        water.userData.tile = tileKey;
        this.group.add(water);
        state.extras.push(water);
        break;
      }
      case 'area': {
        const area = this._buildArea(feature.flat, feature.tags, feature.id);
        if (!area) return;
        area.userData.tile = tileKey;
        this.group.add(area);
        state.extras.push(area);
        break;
      }
      default:
        break;
    }
  }

  _finishBuildJob(job, cancelled) {
    this._buildJobMap.delete(job.tileKey);
    if (cancelled) return;

    const state = this._tileStates.get(job.tileKey);
    if (!state) return;

    state.status = 'ready';
    if (state.buildings.length) this._enqueueMerge(job.tileKey);
    const builtBuildings = state.buildings.length;
    const builtExtras = state.extras.length;
    const expected = job.expected || { buildings: builtBuildings, extras: builtExtras };
    const mismatch =
      expected && (expected.buildings !== builtBuildings || expected.extras !== builtExtras)
        ? ` (expected ${expected.buildings}/${expected.extras})`
        : '';
    console.log(
      `[Buildings] applied ${builtBuildings} buildings + ${builtExtras} extras for ${job.tileKey}` +
        (job.fromCache ? ' (cache)' : '') +
        mismatch
    );
  }

  _processMergeQueue() {
    if (this._activeMerge || !this._mergeQueue.length) return;
    const tileKey = this._mergeQueue.shift();
    this._pendingMergeTiles.delete(tileKey);

    const state = this._tileStates.get(tileKey);
    if (!state || !state.buildings.length) {
      this._processMergeQueue();
      return;
    }

    this._activeMerge = {
      tileKey,
      state,
      sources: state.buildings.slice(),
      index: 0,
    };

    this._scheduleMergeTick();
  }

  _scheduleMergeTick() {
    if (!this._activeMerge) return;
    const run = (deadline) => this._runMergeTick(deadline);
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 32 });
    } else {
      setTimeout(() => run(), 0);
    }
  }

  _runMergeTick(deadline) {
    const job = this._activeMerge;
    if (!job) return;

    const start = performance.now();
    while (job.index < job.sources.length) {
      const b = job.sources[job.index++];
      if (!b.render) continue;
      // we only need to ensure matrixWorld up-to-date
      b.render.updateMatrixWorld(true);
      const elapsed = performance.now() - start;
      if (elapsed > MERGE_BUDGET_MS) break;
      if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 1) break;
    }

    if (job.index < job.sources.length) {
      this._scheduleMergeTick();
      return;
    }

    this._finalizeMerge(job);
    this._activeMerge = null;
    this._processMergeQueue();
  }

  _finalizeMerge(job) {
    const { tileKey, state, sources } = job;

    for (const building of sources) {
      if (!building.render) continue;
      this.group.remove(building.render);
      building.render.geometry.dispose();
      building.render = null;
    }

    const segCount = this._rebuildMergedTile(tileKey, state);
    console.log(`[Buildings] merged ${state.buildings.length} wireframes into ${segCount} segments for ${tileKey}`);
  }

  _rebuildMergedTile(tileKey, state) {
    const geos = [];
    for (const building of state.buildings) {
      const info = building?.info;
      if (!info) continue;
      const geom = this._makeWireGeometry(info.rawFootprint, info.baseHeight, info.height);
      geos.push(geom);
    }

    if (!geos.length) {
      if (state.mergedGroup) {
        this.group.remove(state.mergedGroup);
        state.mergedGroup.geometry.dispose();
        state.mergedGroup = null;
      }
      return 0;
    }

    const mergedGeom = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());

    if (state.mergedGroup) {
      state.mergedGroup.geometry.dispose();
      state.mergedGroup.geometry = mergedGeom;
    } else {
      const merged = new THREE.LineSegments(mergedGeom, this._edgeMaterial);
      merged.name = `merged-${tileKey}`;
      merged.userData = { type: 'buildingMerged', tile: tileKey };
      this.group.add(merged);
      state.mergedGroup = merged;
    }

    return mergedGeom.getAttribute('position').count / 2;
  }

  updateHover(raycaster, camera) {
    if (!this._pickerRoot.children.length) {
      this.clearHover();
      return;
    }
    const intersects = raycaster.intersectObjects(this._pickerRoot.children, false);
    if (!intersects.length) {
      this.clearHover();
      return;
    }

    const hit = intersects[0];
    const info = hit.object.userData.buildingInfo;
    if (!info) {
      this.clearHover();
      return;
    }

    this._showHover(info, hit.point, camera);
  }

  clearHover() {
    if (this._hoverEdges) {
      this._hoverEdges.geometry.dispose();
      this._hoverEdges.geometry = new THREE.BufferGeometry();
      this._hoverEdges.visible = false;
    }
    if (this._hoverStem) {
      this._hoverStem.geometry.dispose();
      this._hoverStem.geometry = new THREE.BufferGeometry();
      this._hoverStem.visible = false;
    }
    if (this._hoverLabel) this._hoverLabel.visible = false;
    if (this._hoverGroup) this._hoverGroup.visible = false;
    this._hoverInfo = null;
  }

  _showHover(info, point, camera) {
    this._ensureHoverArtifacts();

    if (this._hoverInfo !== info) {
      const highlightGeom = this._buildHighlightGeometry(info);
      this._hoverEdges.geometry.dispose();
      this._hoverEdges.geometry = highlightGeom;
      this._hoverEdges.position.set(0, 0, 0);
      const labelText = info.address || 'Unknown';
      this._updateLabelText(labelText);
      this._hoverInfo = info;
      console.log(`[Buildings] hover ${info.id}: ${labelText}`);
    }

    this._hoverGroup.visible = true;
    this._hoverEdges.visible = true;

    const anchorTop = this._chooseAnchorTop(info, point);
    const camPos = camera.getWorldPosition(this._tmpVec2);

    const dir = camPos.clone().sub(anchorTop);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const stemLength = 2.3;
    const offset = dir.multiplyScalar(stemLength);
    const labelPos = anchorTop.clone().add(offset);
    labelPos.y += stemLength;

    const stemGeom = new THREE.BufferGeometry().setFromPoints([anchorTop, labelPos]);
    this._hoverStem.geometry.dispose();
    this._hoverStem.geometry = stemGeom;
    this._hoverStem.visible = true;

    this._hoverLabel.position.copy(labelPos);
    this._hoverLabel.visible = true;
    this._hoverLabel.lookAt(camPos);
  }

  _ensureHoverArtifacts() {
    if (this._hoverEdges) return;

    this._hoverEdges = new THREE.LineSegments(new THREE.BufferGeometry(), this._highlightEdgeMaterial);
    this._hoverStem = new THREE.Line(new THREE.BufferGeometry(), this._stemMaterial);
    this._hoverEdges.visible = false;
    this._hoverStem.visible = false;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false });
    const geometry = new THREE.PlaneGeometry(1.6, 0.6);
    const label = new THREE.Mesh(geometry, material);
    label.visible = false;
    label.renderOrder = 10;

    this._hoverLabelCanvas = canvas;
    this._hoverLabelCtx = ctx;
    this._hoverLabelTexture = texture;
    this._hoverLabel = label;

    this._hoverGroup.add(this._hoverEdges);
    this._hoverGroup.add(this._hoverStem);
    this._hoverGroup.add(label);
  }

  _updateLabelText(text) {
    if (!this._hoverLabelCtx || !this._hoverLabelTexture) return;
    const ctx = this._hoverLabelCtx;
    const canvas = this._hoverLabelCanvas;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(18,18,18,0.82)';
    const pad = 24;
    ctx.fillRect(pad / 2, pad / 2, canvas.width - pad, canvas.height - pad);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 56px "Inter", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
    this._hoverLabelTexture.needsUpdate = true;

    const metrics = ctx.measureText(text);
    const w = THREE.MathUtils.clamp(metrics.width / canvas.width, 0.2, 0.85);
    const width = 1.6 + w * 1.5;
    this._hoverLabel.scale.set(width, 0.75, 1);
  }

  _buildHighlightGeometry(info) {
    return this._makeWireGeometry(info.rawFootprint, info.baseHeight, info.height);
  }

  _chooseAnchorTop(info, point) {
    const pts = info.rawFootprint;
    let best = null;
    let bestDist = Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const vx = pts[i];
      const vz = pts[i + 1];
      const world = this._tmpVec.set(vx, info.baseHeight, vz);
      const dist = point ? point.distanceToSquared(world) : world.distanceToSquared(this.camera.position);
      if (dist < bestDist) {
        bestDist = dist;
        best = world.clone();
      }
    }
    if (!best) best = new THREE.Vector3(info.centroid.x, info.baseHeight, info.centroid.z);
    best.y += info.height;
    return best;
  }

  _orientLabel(camera) {
    if (!this._hoverLabel || !this._hoverLabel.visible) return;
    this._hoverLabel.lookAt(camera.getWorldPosition(this._tmpVec3));
  }

  _queueResnapSweep() {
    if (!this._tileStates.size) return;
    if (this._resnapQueue && this._resnapIndex < this._resnapQueue.length) return;
    this._resnapQueue = Array.from(this._tileStates.keys());
    this._resnapIndex = 0;
  }

  _drainResnapQueue(budgetMs = RESNAP_FRAME_BUDGET_MS) {
    if (!this._resnapQueue || this._resnapIndex >= this._resnapQueue.length) return;

    const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const start = now();

    while (this._resnapIndex < this._resnapQueue.length) {
      const elapsed = now() - start;
      if (elapsed > budgetMs) break;

      const tileKey = this._resnapQueue[this._resnapIndex++];
      const state = this._tileStates.get(tileKey);
      if (!state) continue;
      this._resnapTile(tileKey, state);
    }

    if (this._resnapIndex >= this._resnapQueue.length) {
      this._resnapQueue = [];
      this._resnapIndex = 0;
    }
  }

  _resnapTile(tileKey, state) {
    let dirty = false;
    for (const building of state.buildings) {
      if (this._resnapBuilding(building)) dirty = true;
    }
    if (dirty) this._rebuildMergedTile(tileKey, state);

    for (const extra of state.extras) {
      const type = extra.userData?.type;
      if (type === 'road') this._resnapRoad(extra);
      else if (type === 'water') this._resnapWater(extra);
      else if (type === 'area') this._resnapArea(extra);
    }
  }

  _resnapBuilding(building) {
    if (!building || !building.info) return false;
    const info = building.info;
    const baseline = this._lowestGround(info.rawFootprint) + this.extraDepth;
    const groundBase = baseline - this.extraDepth;
    const prev = info.baseHeight;
    const changed = !Number.isFinite(prev) || Math.abs(prev - groundBase) > 0.02;
    info.baseHeight = groundBase;

    if (changed && building.render) {
      const newGeom = this._makeWireGeometry(info.rawFootprint, groundBase, info.height);
      building.render.geometry.dispose();
      building.render.geometry = newGeom;
      building.render.position.set(0, 0, 0);
      building.render.updateMatrixWorld(true);
    }
    if (building.pick) {
      building.pick.position.y = baseline;
      building.pick.updateMatrixWorld(true);
    }
    if (changed && this._hoverInfo === info) {
      this.clearHover();
    }
    return changed;
  }

  _resnapRoad(mesh) {
    const attr = mesh.geometry.getAttribute('position');
    const base = mesh.userData.basePos;
    if (!attr || !base) return;
    const arr = attr.array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = base[i];
      const z = base[i + 2];
      const h = this._groundHeight(x, z);
      arr[i] = x;
      arr[i + 1] = h + this.roadOffset + this.roadHeightOffset;
      arr[i + 2] = z;
    }
    attr.needsUpdate = true;
    mesh.geometry.computeVertexNormals();
  }

  _resnapWater(mesh) {
    const pts = mesh.userData.basePts;
    if (!pts) return;
    const base = this._lowestGround(pts) - 0.2;
    mesh.position.y = base;
  }

  _resnapArea(mesh) {
    const pts = mesh.userData.basePts;
    if (!pts) return;
    const base = this._lowestGround(pts) + 0.02;
    mesh.position.y = base;
  }

  _buildRoad(flat, tags, id) {
    const geomData = this._makeRoadGeometry(flat);
    if (!geomData) return null;
    const { geo, basePos, center } = geomData;
    const mat = new THREE.MeshStandardMaterial({
      color: 0xd8d8d8,
      metalness: 0.4,
      roughness: 0.25,
      emissive: 0x000000,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.type = 'road';
    mesh.userData.osmId = id;
    mesh.userData.basePos = basePos;
    mesh.userData.center = center;
    mesh.visible = this._isInsideRadius(center);
    return mesh;
  }

  _buildWater(flat, tags, id) {
    const shape = new THREE.Shape();
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i];
      const z = flat[i + 1];
      if (i === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    }
    shape.autoClose = true;

    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    const mat = this._waterMaterial();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.type = 'water';
    mesh.userData.osmId = id;
    mesh.userData.basePts = flat.slice();
    mesh.userData.waterMaterial = mat;
    this._waterMaterials.add(mat);

    const base = this._lowestGround(flat) - 0.2;
    mesh.position.set(0, base, 0);

    const centre = averagePoint(flat);
    mesh.userData.center = centre;
    mesh.visible = this._isInsideRadius(centre);
    return mesh;
  }

  _buildArea(flat, tags, id) {
    const shape = new THREE.Shape();
    for (let i = 0; i < flat.length; i += 2) {
      const x = flat[i];
      const z = flat[i + 1];
      if (i === 0) shape.moveTo(x, z);
      else shape.lineTo(x, z);
    }
    shape.autoClose = true;

    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, wireframe: true, opacity: 0.4, transparent: true });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.type = 'area';
    mesh.userData.osmId = id;
    mesh.userData.basePts = flat.slice();

    const base = this._lowestGround(flat) + 0.02;
    mesh.position.set(0, base, 0);

    const centre = averagePoint(flat);
    mesh.userData.center = centre;
    mesh.visible = this._isInsideRadius(centre);
    return mesh;
  }

  _makeWireGeometry(footprint, baseHeight, height) {
    const n = footprint.length / 2;
    if (n < 2) return new THREE.BufferGeometry();

    const segments = n * 3; // base, top, vertical
    const positions = new Float32Array(segments * 2 * 3);
    let ptr = 0;
    const topY = baseHeight + height;

    for (let i = 0; i < n; i++) {
      const ni = (i + 1) % n;
      const x0 = footprint[i * 2];
      const z0 = footprint[i * 2 + 1];
      const x1 = footprint[ni * 2];
      const z1 = footprint[ni * 2 + 1];

      // base edge
      positions[ptr++] = x0;
      positions[ptr++] = baseHeight;
      positions[ptr++] = z0;
      positions[ptr++] = x1;
      positions[ptr++] = baseHeight;
      positions[ptr++] = z1;

      // top edge
      positions[ptr++] = x0;
      positions[ptr++] = topY;
      positions[ptr++] = z0;
      positions[ptr++] = x1;
      positions[ptr++] = topY;
      positions[ptr++] = z1;
    }

    for (let i = 0; i < n; i++) {
      const x = footprint[i * 2];
      const z = footprint[i * 2 + 1];
      positions[ptr++] = x;
      positions[ptr++] = baseHeight;
      positions[ptr++] = z;
      positions[ptr++] = x;
      positions[ptr++] = topY;
      positions[ptr++] = z;
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.computeBoundingSphere();
    return geom;
  }

  _chooseBuildingHeight(tags = {}) {
    if (tags.height) {
      const h = parseFloat(tags.height);
      if (Number.isFinite(h)) return h;
    }
    if (tags['building:levels']) {
      const levels = parseInt(tags['building:levels'], 10);
      if (Number.isFinite(levels)) return levels * 3;
    }

    const presets = {
      apartment: 12,
      residential: 9,
      house: 7,
      detached: 7,
      terrace: 8,
      commercial: 10,
      retail: 10,
      warehouse: 11,
      hangar: 14,
      stadium: 15,
      grandstand: 14,
      shed: 5,
    };
    return presets[(tags.building || '').toLowerCase()] ?? 7;
  }

  _makeRoadGeometry(flat) {
    if (flat.length < 4) return null;
    const line = this._densifyLine(flat, 1.25);
    const segments = line.length / 2;
    if (segments < 2) return null;

    const rawH = new Float32Array(segments);
    const smH = new Float32Array(segments);
    for (let i = 0, j = 0; i < segments; i++, j += 2) {
      rawH[i] = this._groundHeight(line[j], line[j + 1]) + this.roadOffset + this.roadHeightOffset;
    }
    this._smoothHeights(rawH, smH);

    const halfW = this.roadWidth * 0.5;
    const pos = [];
    const idx = [];
    const centres = [];

    for (let i = 0, j = 0; i < segments; i++, j += 2) {
      const cx = line[j];
      const cz = line[j + 1];
      const cy = smH[i];
      centres.push(new THREE.Vector3(cx, cy, cz));
    }

    for (let i = 0; i < segments; i++) {
      const cur = centres[i];
      const dir = i < segments - 1 ? centres[i + 1].clone().sub(cur) : cur.clone().sub(centres[i - 1]);
      dir.setY(0).normalize();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      const left = cur.clone().addScaledVector(perp, halfW);
      const right = cur.clone().addScaledVector(perp, -halfW);
      pos.push(left.x, left.y, left.z, right.x, right.y, right.z);
      if (i < segments - 1) {
        const a = i * 2;
        idx.push(a, a + 2, a + 1, a + 2, a + 3, a + 1);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();

    const basePos = new Float32Array(pos);
    const centre = centres[Math.floor(centres.length / 2)] ?? { x: 0, z: 0 };
    return { geo, basePos, center: centre };
  }

  _groundHeight(x, z) {
    if (this.tileManager && typeof this.tileManager.getHeightAt === 'function') {
      return this.tileManager.getHeightAt(x, z);
    }
    return 0;
  }

  _lowestGround(flat) {
    let min = Infinity;
    for (let i = 0; i < flat.length; i += 2) {
      const h = this._groundHeight(flat[i], flat[i + 1]);
      if (h < min) min = h;
    }
    return Number.isFinite(min) ? min : 0;
  }

  _densifyPolygon(pts, step = 1.5) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i += 2) {
      const x0 = pts[i];
      const z0 = pts[i + 1];
      const x1 = pts[(i + 2) % n];
      const z1 = pts[(i + 3) % n];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const seg = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s < seg; s++) {
        const t = s / seg;
        out.push(x0 + dx * t, z0 + dz * t);
      }
    }
    return out;
  }

  _densifyLine(base, step = 1.5) {
    const out = [];
    for (let i = 0; i < base.length - 2; i += 2) {
      const x0 = base[i];
      const z0 = base[i + 1];
      const x1 = base[i + 2];
      const z1 = base[i + 3];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      const seg = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s < seg; s++) {
        const t = s / seg;
        out.push(x0 + dx * t, z0 + dz * t);
      }
    }
    out.push(base[base.length - 2], base[base.length - 1]);
    return out;
  }

  _smoothHeights(src, out) {
    const n = src.length;
    const radius = 2;
    for (let i = 0; i < n; i++) {
      let sum = 0;
      let count = 0;
      for (let k = -radius; k <= radius; k++) {
        const j = i + k;
        if (j < 0 || j >= n) continue;
        sum += src[j];
        count++;
      }
      out[i] = count ? sum / count : src[i];
    }
  }

  _tileKeyForWorld(x, z) {
    const tx = Math.floor(x / this.tileSize);
    const tz = Math.floor(z / this.tileSize);
    return `${tx},${tz}`;
  }

  _bboxForTile(tileKey) {
    const [tx, tz] = tileKey.split(',').map(Number);
    const minX = tx * this.tileSize;
    const maxX = (tx + 1) * this.tileSize;
    const minZ = tz * this.tileSize;
    const maxZ = (tz + 1) * this.tileSize;
    const { dLat, dLon } = metresPerDegree(this.lat0);
    const minLon = this.lon0 + minX / dLon;
    const maxLon = this.lon0 + maxX / dLon;
    const minLat = this.lat0 + minZ / dLat;
    const maxLat = this.lat0 + maxZ / dLat;
    return [minLat, minLon, maxLat, maxLon];
  }

  _latLonToWorld(lat, lon) {
    const { dLat, dLon } = metresPerDegree(this.lat0);
    return {
      x: (lon - this.lon0) * dLon,
      z: (lat - this.lat0) * dLat,
    };
  }

  _isInsideRadius({ x, z }) {
    const r2 = this.radius * this.radius;
    return x * x + z * z <= r2;
  }

  _cacheKey(tileKey) {
    if (!this._hasOrigin) return null;
    return `${this._cachePrefix}${this.lat0.toFixed(4)},${this.lon0.toFixed(4)}:${tileKey}`;
  }

  _loadTileFromCache(tileKey) {
    try {
      if (typeof localStorage === 'undefined') return null;
      const key = this._cacheKey(tileKey);
      if (!key) return null;
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const payload = JSON.parse(raw);
      if (!payload || typeof payload.ts !== 'number' || !payload.data) return null;
      if (Date.now() - payload.ts > CACHE_TTL) {
        localStorage.removeItem(key);
        return null;
      }
      return payload.data;
    } catch {
      return null;
    }
  }

  _saveTileToCache(tileKey, data) {
    try {
      if (typeof localStorage === 'undefined') return;
      const key = this._cacheKey(tileKey);
      if (!key) return;
      const payload = { ts: Date.now(), data };
      localStorage.setItem(key, JSON.stringify(payload));
      this._pruneCache();
      console.log(`[Buildings] cached ${tileKey}`);
    } catch (err) {
      console.warn('[Buildings] cache write failed', err);
    }
  }

  _pruneCache() {
    if (typeof localStorage === 'undefined') return;
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(this._cachePrefix)) {
        try {
          const payload = JSON.parse(localStorage.getItem(key));
          entries.push({ key, ts: payload?.ts ?? 0 });
        } catch {
          entries.push({ key, ts: 0 });
        }
      }
    }
    if (entries.length <= CACHE_LIMIT) return;
    entries.sort((a, b) => a.ts - b.ts);
    for (let i = 0; i < entries.length - CACHE_LIMIT; i++) {
      localStorage.removeItem(entries[i].key);
    }
  }

  _cancelMerge(tileKey) {
    this._pendingMergeTiles.delete(tileKey);
    this._mergeQueue = this._mergeQueue.filter((key) => key !== tileKey);
    if (this._activeMerge && this._activeMerge.tileKey === tileKey) this._activeMerge = null;
  }

  _cancelBuildJob(tileKey) {
    const job = this._buildJobMap.get(tileKey);
    if (!job) return;
    job.cancelled = true;
    this._buildJobMap.delete(tileKey);
    this._buildQueue = this._buildQueue.filter((j) => j.tileKey !== tileKey);
    if (this._activeBuildJob && this._activeBuildJob.tileKey === tileKey) {
      this._activeBuildJob.cancelled = true;
    }
  }

  _removeTileObjects(tileKey) {
    this._cancelBuildJob(tileKey);
    const state = this._tileStates.get(tileKey);
    if (!state) return;

    for (const building of state.buildings) {
      if (building.render) {
        this.group.remove(building.render);
        building.render.geometry.dispose();
        building.render = null;
      }
      if (building.pick) {
        this._pickerRoot.remove(building.pick);
        building.pick.geometry.dispose();
        building.pick = null;
      }
    }
    state.buildings = [];

    for (const extra of state.extras) {
      this.group.remove(extra);
      if (extra.geometry) extra.geometry.dispose();
      if (extra.material && extra.material.dispose) extra.material.dispose();
    }
    state.extras = [];

    if (state.mergedGroup) {
      this.group.remove(state.mergedGroup);
      state.mergedGroup.geometry?.dispose();
      state.mergedGroup = null;
    }

    if (this._hoverInfo && this._hoverInfo.tile === tileKey) this.clearHover();
  }

  _unloadTile(tileKey) {
    this._cancelMerge(tileKey);
    this._removeTileObjects(tileKey);
    this._tileStates.delete(tileKey);
    console.log(`[Buildings] purged tile ${tileKey}`);
  }

  _clearAllTiles() {
    this._mergeQueue.length = 0;
    this._pendingMergeTiles.clear();
    this._activeMerge = null;
    this._buildQueue.length = 0;
    this._buildJobMap.clear();
    this._activeBuildJob = null;
    this._buildTickScheduled = false;
    this._resnapQueue = [];
    this._resnapIndex = 0;
    for (const tileKey of Array.from(this._tileStates.keys())) this._removeTileObjects(tileKey);
    this._tileStates.clear();
  }

  _disposeObject(obj) {
    obj.traverse?.((child) => {
      if (child.isMesh) {
        if (child.material?.uniforms?.uTime) this._waterMaterials.delete(child.material);
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach((m) => m?.dispose?.());
        else child.material?.dispose?.();
      }
    });
  }

  _waterMaterial() {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: this._waterTime },
        uColor: { value: new THREE.Color(0x888888) },
      },
      vertexShader: `
        uniform float uTime;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec3 pos = position;
          pos.y += 0.05 * sin((position.x + position.z) * 0.12 + uTime * 1.4);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          float ripple = 0.4 + 0.2 * sin((vUv.x + vUv.y) * 14.0);
          float alpha = 0.4;
          gl_FragColor = vec4(uColor * (0.85 + ripple * 0.15), alpha);
        }
      `,
      transparent: true,
      side: THREE.DoubleSide,
    });
  }
}
