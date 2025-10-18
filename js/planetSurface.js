import * as THREE from 'three';
import { now } from './utils.js';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';
import { clampLat, wrapLon, latLonToECEF, computeLocalFrame } from './geolocate.js';

const EARTH_RADIUS = 6378137;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const TWO_PI = Math.PI * 2;

const DEFAULT_DAYMAP = null;
const DEFAULT_NIGHTMAP = null;
const DEFAULT_CLOUDMAP = null;
const DEFAULT_HEIGHTMAP = null;
const DEFAULT_GEOJSON = 'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson';

const DEFAULT_PATCH_SUBDIV = 64;
const DEFAULT_PATCH_RADIUS_METERS = 120000; // 120 km window

const UV_YAW = 0.5; // align Greenwich meridian

function addEquirectUVs(geometry) {
  const pos = geometry.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    let u = (Math.atan2(v.z, -v.x) + Math.PI) / TWO_PI;
    u = (u + UV_YAW) % 1;
    const vv = 1 - Math.acos(THREE.MathUtils.clamp(v.y, -1, 1)) / Math.PI;
    uv[i * 2 + 0] = u;
    uv[i * 2 + 1] = vv;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * PlanetSurface wraps a globe mesh with day/night shading, clouds and draped GeoJSON overlays.
 * It also manages a small adaptive-patch mesh that refines vertices near the active observer.
 */
export class PlanetSurface {
  constructor({
    radius = EARTH_RADIUS,
    scene = null,
    renderer = null,
    dayMap = DEFAULT_DAYMAP,
    nightMap = DEFAULT_NIGHTMAP,
    cloudMap = DEFAULT_CLOUDMAP,
    heightMap = DEFAULT_HEIGHTMAP,
    initialGeoJSON = DEFAULT_GEOJSON,
    baseSubdivisions = 6,
    displacementScale = 0.03,
    displacementBias = -0.015,
  } = {}) {
    if (!scene || !scene.isScene) {
      throw new Error('PlanetSurface requires a THREE.Scene');
    }
    this.scene = scene;
    this.renderer = renderer;
    this.radius = radius;
    this.baseSubdivisions = clamp(Math.floor(baseSubdivisions), 3, 8);
    this.displacementScale = displacementScale;
    this.displacementBias = displacementBias;

    this.dayMapPath = dayMap;
    this.nightMapPath = nightMap;
    this.cloudMapPath = cloudMap;
    this.heightMapPath = heightMap;
    this.initialGeoJSON = initialGeoJSON;

    this.group = new THREE.Group();
    this.group.name = 'planet-surface-root';
    this.scene.add(this.group);

    this.planetMesh = null;
    this.patchMesh = null;
    this._patchMaterial = new THREE.MeshStandardMaterial({
      color: 0x7088a0,
      roughness: 0.85,
      metalness: 0.0,
    });
    this._shaderUniforms = null;
    this.cloudMesh = null;
    this.geoLayer = new THREE.Group();
    this.geoLayer.name = 'planet-geojson-layer';
    this.geoLayer.renderOrder = 4;
    this.group.add(this.geoLayer);

    this.detailRadiusMeters = 75000;
    this.detailSpacingMeters = 200;
    this.detailHeightLift = 0;
    this.detailSmoothIterations = 2;
    this._detailUpdateThreshold = 1e-4; // ~11m lat delta
    this._lastPatchRefresh = 0;

    this._frames = {
      originLat: 0,
      originLon: 0,
      east: new THREE.Vector3(1, 0, 0),
      north: new THREE.Vector3(0, 0, -1),
      up: new THREE.Vector3(0, 1, 0),
    };
    this.origin = { lat: 0, lon: 0 };
    this._anchorPosition = new THREE.Vector3();
    this._anchorQuaternion = new THREE.Quaternion();

    this.terrainRelay = null;
    this.relayAddress = null;
    this.relayDataset = 'mapzen';
    this.relayMode = 'geohash';
    this.relayTimeoutMs = 45000;
    this.cacheTtlMs = 45000;
    this._cache = new Map();
    this._pendingRequests = new Map();
    this._requestQueue = [];
    this._maxRequestsPerFrame = 4;
    this._needsPatchRefresh = false;

    this._baseGeometry = null;
    this._baseMaterial = null;
    this._heightSampler = null;
    this._patchGeometry = null;
    this._detailState = {
      lat: null,
      lon: null,
      radius: this.detailRadiusMeters,
      subdiv: DEFAULT_PATCH_SUBDIV,
    };
    this._lastRequestPump = 0;
    this._latestFocusLat = null;
    this._latestFocusLon = null;

    this._loader = new THREE.TextureLoader();
    this._loader.setCrossOrigin('anonymous');

    this._status = { geojson: null, heightmap: null, textures: null };

    this.ready = this._init();

    this.GLOBAL_MIN_Y = -8000;
    this.GLOBAL_MAX_Y = 9000;
    this.LUM_MIN = 0.05;
    this.LUM_MAX = 0.9;
    this.maxUpdateMs = 4;
  }

  async _init() {
    await this._loadTextures();
    await this._buildBaseMesh();
    if (this.initialGeoJSON) {
      this.loadGeoJSON(this.initialGeoJSON).catch(() => {});
    }
    this.rebuildLocalPatch({ lat: this._frames.originLat, lon: this._frames.originLon });
    this._lastPatchRefresh = now();
  }

  async _loadTextures() {
    this.dayTexture = null;
    this.nightTexture = null;
    this.displacementTexture = null;
    this._heightSampler = null;
    this._status.textures = now();
  }

  async _buildBaseMesh() {
    if (this.planetMesh) {
      this.group.remove(this.planetMesh);
      this.planetMesh.geometry?.dispose?.();
      this.planetMesh.material?.dispose?.();
    }

    const geom = new THREE.IcosahedronGeometry(this.radius, this.baseSubdivisions);
    addEquirectUVs(geom);
    this._baseGeometry = geom;

    const material = this._buildEarthMaterial({
      day: this.dayTexture,
      night: this.nightTexture,
      displacement: this.displacementTexture,
      scale: this.displacementScale,
      bias: this.displacementBias,
    });
    this._baseMaterial = material;

    this.planetMesh = new THREE.Mesh(this._baseGeometry, this._baseMaterial);
    this.planetMesh.name = 'planet-earth';
    this.planetMesh.receiveShadow = false;
    this.planetMesh.castShadow = false;
    this.group.add(this.planetMesh);
  }

  _buildEarthMaterial({ day, night, displacement, scale, bias }) {
    const mat = new THREE.MeshStandardMaterial({
      color: 0x445060,
      roughness: 0.95,
      metalness: 0.0,
      wireframe: false,
    });

    return mat;
  }

  async _ensureCloudLayer() { /* no-op without textures */ }

  setSunDirection(dir) {
    if (!this._shaderUniforms) return;
    this._shaderUniforms.sunDir.value.copy(dir).normalize();
  }

  setTwilight(value) {
    if (!this._shaderUniforms) return;
    this._shaderUniforms.twilight.value = value;
  }

  get mesh() {
    return this.planetMesh;
  }

  async loadGeoJSON(url) {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      this._drawGeoJSON(data);
      this._status.geojson = now();
    } catch (err) {
      console.warn('[PlanetSurface] GeoJSON load failed', err);
      throw err;
    }
  }

  _drawGeoJSON(gj) {
    clearGroup(this.geoLayer);
    if (!gj) return;

    const matOuter = new THREE.LineBasicMaterial({
      color: 0x84c5ff,
      transparent: true,
      opacity: 0.96,
      depthWrite: false,
    });
    const matInner = new THREE.LineBasicMaterial({
      color: 0x3aa0ff,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
    });

    const addLine = (points, isOuter) => {
      const positions = new Float32Array(points.length * 3);
      for (let i = 0; i < points.length; i++) {
        const { lat, lon } = points[i];
        const ecef = latLonToECEF(lat, lon, 0);
        const v = new THREE.Vector3(ecef.x, ecef.y, ecef.z).normalize().multiplyScalar(this.radius * 1.0012);
        positions[i * 3 + 0] = v.x;
        positions[i * 3 + 1] = v.y;
        positions[i * 3 + 2] = v.z;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      this.geoLayer.add(new THREE.Line(geo, isOuter ? matOuter : matInner));
    };

    const densify = (path, maxDeg = 2) => {
      if (path.length < 2) return path.map(([lon, lat]) => ({ lat, lon }));
      const out = [];
      for (let i = 0; i < path.length - 1; i++) {
        const [lon1, lat1] = path[i];
        const [lon2, lat2] = path[i + 1];
        let dLon = ((lon2 - lon1 + 540) % 360) - 180;
        const dLat = lat2 - lat1;
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dLon), Math.abs(dLat)) / maxDeg));
        for (let s = 0; s < steps; s++) {
          const t = s / steps;
          out.push({ lat: lat1 + dLat * t, lon: lon1 + dLon * t });
        }
      }
      const [lonF, latF] = path[path.length - 1];
      out.push({ lat: latF, lon: lonF });
      return out;
    };

    const walkGeom = (geom) => {
      if (!geom) return;
      if (geom.type === 'Polygon') {
        const rings = geom.coordinates.map((ring) => ring.map(([lon, lat]) => [lon, lat]));
        if (rings.length) addLine(densify(rings[0]), true);
        for (let i = 1; i < rings.length; i++) addLine(densify(rings[i]), false);
      } else if (geom.type === 'MultiPolygon') {
        geom.coordinates.forEach((poly) => {
          const rings = poly.map((ring) => ring.map(([lon, lat]) => [lon, lat]));
          if (rings.length) addLine(densify(rings[0]), true);
          for (let i = 1; i < rings.length; i++) addLine(densify(rings[i]), false);
        });
      } else if (geom.type === 'LineString') {
        addLine(densify(geom.coordinates.map(([lon, lat]) => [lon, lat])), true);
      } else if (geom.type === 'MultiLineString') {
        geom.coordinates.forEach((line) => addLine(densify(line.map(([lon, lat]) => [lon, lat])), true));
      } else if (geom.type === 'GeometryCollection') {
        (geom.geometries || []).forEach(walkGeom);
      }
    };

    if (gj.type === 'FeatureCollection') {
      (gj.features || []).forEach((f) => walkGeom(f.geometry));
    } else if (gj.type === 'Feature') {
      walkGeom(gj.geometry);
    } else {
      walkGeom(gj);
    }
  }

  /**
   * Update the local tangent frame transform so the avatar stands on the sphere and feels upright.
   */
  setOrigin(lat, lon, { height = 0 } = {}) {
    const clampedLat = clampLat(lat);
    const wrappedLon = wrapLon(lon);
    const prevLat = this._frames.originLat;
    const prevLon = this._frames.originLon;
    const latDelta = Math.abs(clampedLat - prevLat);
    let lonDelta = Math.abs(wrappedLon - prevLon);
    if (lonDelta > 180) lonDelta = 360 - lonDelta;
    if (latDelta > 0.5 || lonDelta > 0.5) {
      this._clearHeightCaches();
    }
    const frame = computeLocalFrame(clampedLat, wrappedLon);
    this._frames.originLat = clampedLat;
    this._frames.originLon = wrappedLon;
    this._frames.east.set(frame.east.x, frame.east.y, frame.east.z).normalize();
    this._frames.north.set(frame.north.x, frame.north.y, frame.north.z).normalize();

    const originEcef = latLonToECEF(clampedLat, wrappedLon, height);
    const upVec = new THREE.Vector3(originEcef.x, originEcef.y, originEcef.z).normalize();
    this._frames.up.copy(upVec);

    const southVec = this._frames.north.clone().multiplyScalar(-1);
    const basis = new THREE.Matrix4().makeBasis(
      this._frames.east,
      upVec,
      southVec
    );
    this._anchorQuaternion.setFromRotationMatrix(basis);
    this._anchorPosition.set(originEcef.x, originEcef.y, originEcef.z);
    this.origin = { lat: clampedLat, lon: wrappedLon };

    this._detailState.lat = clampedLat;
    this._detailState.lon = wrappedLon;
    this._needsPatchRefresh = true;

    return true;
  }

  /**
   * Convert local tangent-plane metres (east, south) into latitude/longitude relative to current origin.
   */
  localDeltaToLatLon(x, z) {
    const { originLat, originLon } = this._frames;
    const latRad = originLat * DEG2RAD;
    const cosLat = Math.cos(latRad);
    const safeCos = Math.max(1e-6, cosLat);
    const dLat = (-z) / EARTH_RADIUS;
    const dLon = x / (EARTH_RADIUS * safeCos);
    const lat = clampLat(originLat + dLat * RAD2DEG);
    let lon = wrapLon(originLon + dLon * RAD2DEG);
    return { lat, lon };
  }

  sampleHeight(lat, lon) {
    if (!this._heightSampler) return 0;
    return this._heightSampler.sample(lat, lon) * this.displacementScale * this.radius;
  }

  _clearHeightCaches() {
    this._cache.clear();
    this._pendingRequests.clear();
    this._requestQueue.length = 0;
  }

  latLonToLocal(lat, lon) {
    const originLatRad = this._frames.originLat * DEG2RAD;
    const originLonRad = this._frames.originLon * DEG2RAD;
    const latRad = lat * DEG2RAD;
    let lonRad = lon * DEG2RAD;
    let dLon = lonRad - originLonRad;
    while (dLon > Math.PI) dLon -= TWO_PI;
    while (dLon < -Math.PI) dLon += TWO_PI;
    const dLat = latRad - originLatRad;
    const cosLat = Math.max(1e-6, Math.cos(originLatRad));
    const x = dLon * cosLat * EARTH_RADIUS;
    const z = -dLat * EARTH_RADIUS;
    return { x, z };
  }

  /**
   * Convert latitude/longitude/height into world coordinates in metres.
   */
  latLonHeightToWorld(lat, lon, height = 0) {
    const ecef = latLonToECEF(lat, lon, height);
    return new THREE.Vector3(ecef.x, ecef.y, ecef.z);
  }

  getAnchorTransform() {
    return {
      position: this._anchorPosition.clone(),
      quaternion: this._anchorQuaternion.clone(),
      originLat: this._frames.originLat,
      originLon: this._frames.originLon,
    };
  }

  _resolveElevation(lat, lon, spacingMeters, fallbackHeight) {
    const spacing = Math.max(1, Number.isFinite(spacingMeters) ? spacingMeters : 1);
    const precision = pickGeohashPrecision(spacing);
    const key = geohashEncode(lat, lon, precision);
    const nowMs = now();
    const cached = this._cache.get(key);
    if (cached && Number.isFinite(cached.y)) {
      if ((nowMs - cached.t) >= this.cacheTtlMs) {
        this._queueHeightRequest(key, lat, lon, precision);
      }
      return { value: cached.y, key };
    }
    this._queueHeightRequest(key, lat, lon, precision);
    return { value: fallbackHeight, key };
  }

  /**
   * Retrieve the surface height at local tangent coordinates (metres).
   */
  getHeightAt(x, z) {
    const { lat, lon } = this.localDeltaToLatLon(x, z);
    const fallback = this.sampleHeight(lat, lon);
    const resolved = this._resolveElevation(lat, lon, this.detailSpacingMeters, fallback);
    return Number.isFinite(resolved.value) ? resolved.value : fallback;
  }

  _pumpHeightRequests() {
    if (!this._requestQueue.length) return;
    if (!this.terrainRelay || typeof this.terrainRelay.queryBatch !== 'function') return;
    if (!this.relayAddress) return;

    const nowMs = now();
    const maxPerFrame = Math.max(1, this._maxRequestsPerFrame | 0);
    let sent = 0;
    const deferred = [];

    while (this._requestQueue.length && sent < maxPerFrame) {
      const entry = this._requestQueue.shift();
      if (!entry) continue;
      if (!this._pendingRequests.has(entry.key)) continue;
      if (entry.inflight) {
        deferred.push(entry);
        continue;
      }
      if ((nowMs - entry.lastAttempt) < 150) {
        deferred.push(entry);
        continue;
      }

      entry.inflight = true;
      entry.lastAttempt = nowMs;
      sent += 1;

      const payload = { type: 'elev.query', dataset: this.relayDataset };
      if (this.relayMode === 'geohash') {
        payload.geohashes = [entry.key];
        payload.enc = 'geohash';
        payload.prec = entry.precision;
      } else {
        payload.locations = [{ lat: entry.lat, lng: entry.lon }];
      }

      this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs)
        .then((json) => {
          const results = Array.isArray(json?.results) ? json.results : [];
          if (!results.length) return;
          const raw = results[0];
          const value = Number(raw?.elev ?? raw?.height ?? raw?.z ?? raw?.value ?? raw?.h);
          if (!Number.isFinite(value)) return;
          this._cache.set(entry.key, { y: value, t: now() });
          this._needsPatchRefresh = true;
        })
        .catch(() => {})
        .finally(() => {
          entry.inflight = false;
          this._pendingRequests.delete(entry.key);
        });
    }

    if (deferred.length) this._requestQueue.push(...deferred);
  }

  _queueHeightRequest(key, lat, lon, precision) {
    if (!this.terrainRelay || !this.relayAddress || !key) return;
    let entry = this._pendingRequests.get(key);
    if (!entry) {
      entry = {
        key,
        lat,
        lon,
        precision,
        inflight: false,
        lastAttempt: 0,
      };
      this._pendingRequests.set(key, entry);
      this._requestQueue.push(entry);
      if (this._requestQueue.length > 512) this._requestQueue.splice(0, this._requestQueue.length - 512);
    } else {
      entry.lat = lat;
      entry.lon = lon;
      entry.precision = precision;
      if (!entry.inflight && !this._requestQueue.includes(entry)) {
        this._requestQueue.push(entry);
      }
    }
  }

  addHeightListener(fn) {
    if (typeof fn !== 'function') return () => {};
    if (!this._heightListeners) this._heightListeners = new Set();
    this._heightListeners.add(fn);
    return () => this._heightListeners.delete(fn);
  }

  removeHeightListener(fn) {
    this._heightListeners?.delete(fn);
  }

  notifyHeightListeners(bounds) {
    if (!this._heightListeners || !this._heightListeners.size) return;
    const center = this.latLonToLocal(this._frames.originLat, this._frames.originLon);
    const payload = {
      worldBounds: bounds,
      world: center,
      timestamp: now(),
    };
    for (const fn of this._heightListeners) {
      try { fn(payload); } catch (_) { /* noop */ }
    }
  }

  /**
   * Rebuilds a high-resolution patch around the origin and merges it into the planet mesh.
   */
  rebuildLocalPatch({
    lat = this._frames.originLat,
    lon = this._frames.originLon,
    radiusMeters = this.detailRadiusMeters,
    subdivisions = null,
  } = {}) {
    if (!this._baseGeometry || !this.planetMesh) return;
    const targetGrid = subdivisions != null
      ? Math.floor(subdivisions)
      : Math.floor((radiusMeters * 2) / Math.max(10, this.detailSpacingMeters));
    const grid = clamp(targetGrid, 24, 256);
    const radius = Math.max(1000, radiusMeters);
    const halfSize = radius;
    const step = (halfSize * 2) / grid;
    const size = grid + 1;

    const heights = new Float32Array(size * size);
    const latitudes = new Float32Array(size * size);
    const longitudes = new Float32Array(size * size);

    for (let row = 0; row <= grid; row++) {
      for (let col = 0; col <= grid; col++) {
        const x = -halfSize + col * step;
        const z = -halfSize + row * step;
        const { lat: sampleLat, lon: sampleLon } = this.localDeltaToLatLon(x, z);
        const fallbackHeight = this.sampleHeight(sampleLat, sampleLon);
        const resolved = this._resolveElevation(sampleLat, sampleLon, step, fallbackHeight);
        const height = Number.isFinite(resolved.value) ? resolved.value : fallbackHeight;
        const idx = row * size + col;
        heights[idx] = height;
        latitudes[idx] = sampleLat;
        longitudes[idx] = sampleLon;
      }
    }

    if (this.detailSmoothIterations > 0) {
      const iterations = Math.max(1, Math.floor(this.detailSmoothIterations));
      const temp = new Float32Array(size * size);
      for (let it = 0; it < iterations; it++) {
        for (let r = 0; r < size; r++) {
          for (let c = 0; c < size; c++) {
            const idx = r * size + c;
            let sum = heights[idx];
            let count = 1;
            if (r > 0) { sum += heights[(r - 1) * size + c]; count++; }
            if (r < size - 1) { sum += heights[(r + 1) * size + c]; count++; }
            if (c > 0) { sum += heights[r * size + (c - 1)]; count++; }
            if (c < size - 1) { sum += heights[r * size + (c + 1)]; count++; }
            temp[idx] = sum / count;
          }
        }
        heights.set(temp);
      }
    }

    const positions = new Float32Array(size * size * 3);
    const normals = new Float32Array(size * size * 3);
    const uvs = new Float32Array(size * size * 2);
    const indices = [];

    const featherStart = radius * 0.75;
    for (let row = 0; row <= grid; row++) {
      for (let col = 0; col <= grid; col++) {
        const x = -halfSize + col * step;
        const z = -halfSize + row * step;
        const idx = row * size + col;
        const lat = latitudes[idx];
        const lon = longitudes[idx];
        const baseHeight = heights[idx];
        const dist = Math.sqrt(x * x + z * z);
        let weight = 1;
        if (dist > featherStart) {
          weight = Math.max(0, 1 - ((dist - featherStart) / Math.max(1, radius - featherStart)));
        }
        const height = baseHeight * weight + this.detailHeightLift;
        const ecef = latLonToECEF(lat, lon, height);
        const posVec = new THREE.Vector3(ecef.x, ecef.y, ecef.z);
        const normalVec = posVec.clone().normalize();
        const pOffset = idx * 3;
        positions[pOffset + 0] = posVec.x;
        positions[pOffset + 1] = posVec.y;
        positions[pOffset + 2] = posVec.z;
        normals[pOffset + 0] = normalVec.x;
        normals[pOffset + 1] = normalVec.y;
        normals[pOffset + 2] = normalVec.z;
        let u = (Math.atan2(normalVec.z, -normalVec.x) + Math.PI) / TWO_PI;
        u = (u + UV_YAW) % 1;
        if (u < 0) u += 1;
        const vv = 1 - (Math.acos(THREE.MathUtils.clamp(normalVec.y, -1, 1)) / Math.PI);
        const uvOffset = idx * 2;
        uvs[uvOffset + 0] = u;
        uvs[uvOffset + 1] = vv;
      }
    }

    for (let row = 0; row < grid; row++) {
      for (let col = 0; col < grid; col++) {
        const a = row * (grid + 1) + col;
        const b = a + 1;
        const c = a + (grid + 1);
        const d = c + 1;
        indices.push(a, c, b);
        indices.push(b, c, d);
      }
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geom.setIndex(new THREE.BufferAttribute(new Uint32Array(indices), 1));
    geom.computeVertexNormals();
    geom.computeBoundingSphere();

    if (!this.patchMesh) {
      this.patchMesh = new THREE.Mesh(geom, this._patchMaterial);
      this.patchMesh.name = 'planet-detail-patch';
      this.patchMesh.renderOrder = 2;
      this.group.add(this.patchMesh);
    } else {
      this.patchMesh.geometry.dispose?.();
      this.patchMesh.geometry = geom;
    }

    this.detailSpacingMeters = step;
    this.detailRadiusMeters = radius;
    this._detailState = { lat, lon, radius, subdiv: grid };
    this._needsPatchRefresh = false;
    this._lastPatchRefresh = now();

    this.notifyHeightListeners({
      minX: -radius,
      maxX: radius,
      minZ: -radius,
      maxZ: radius,
      minY: -10000,
      maxY: 10000,
    });
  }

  refreshAll() {
    this._needsPatchRefresh = true;
  }

  setDetailConfig({ radiusMeters = null, spacingMeters = null, maxRequestsPerFrame = null } = {}) {
    if (Number.isFinite(radiusMeters)) this.detailRadiusMeters = Math.max(1000, radiusMeters);
    if (Number.isFinite(spacingMeters)) this.detailSpacingMeters = Math.max(10, spacingMeters);
    if (Number.isFinite(maxRequestsPerFrame)) this._maxRequestsPerFrame = Math.max(1, Math.floor(maxRequestsPerFrame));
    this._needsPatchRefresh = true;
  }

  setRelay({ terrainRelay = null, relayAddress = null, relayDataset = null, relayMode = null, relayTimeoutMs = null } = {}) {
    if (terrainRelay) this.terrainRelay = terrainRelay;
    if (relayAddress != null) this.relayAddress = relayAddress;
    if (relayDataset != null) this.relayDataset = relayDataset;
    if (relayMode != null) this.relayMode = relayMode === 'latlng' ? 'latlng' : 'geohash';
    if (relayTimeoutMs != null && Number.isFinite(relayTimeoutMs)) {
      this.relayTimeoutMs = Math.max(1000, relayTimeoutMs);
    }
    this._clearHeightCaches();
    this._needsPatchRefresh = true;
  }

  update(dt, camera, dolly) {
    if (!this.planetMesh) return;
    this._pumpHeightRequests();
    const nowMs = now();

    if (dolly) {
      const { lat, lon } = this.localDeltaToLatLon(dolly.position.x, dolly.position.z);
      this._latestFocusLat = lat;
      this._latestFocusLon = lon;
      const prevLat = this._detailState.lat ?? this._frames.originLat;
      const prevLon = this._detailState.lon ?? this._frames.originLon;
      const latDelta = Math.abs(lat - prevLat);
      let lonDelta = Math.abs(lon - prevLon);
      if (lonDelta > 180) lonDelta = 360 - lonDelta;
      if (latDelta > this._detailUpdateThreshold || lonDelta > this._detailUpdateThreshold) {
        this.rebuildLocalPatch({ lat, lon });
      }
    }

    if (this._needsPatchRefresh && (nowMs - this._lastPatchRefresh) > 200) {
      const lat = this._detailState.lat ?? this._frames.originLat;
      const lon = this._detailState.lon ?? this._frames.originLon;
      this.rebuildLocalPatch({ lat, lon });
    }

  }

  dispose() {
    if (this.planetMesh) {
      this.group.remove(this.planetMesh);
      this.planetMesh.geometry?.dispose?.();
      this.planetMesh.material?.dispose?.();
      this.planetMesh = null;
    }
    if (this.patchMesh) {
      this.group.remove(this.patchMesh);
      this.patchMesh.geometry?.dispose?.();
      this.patchMesh = null;
    }
    this._patchMaterial?.dispose?.();
    clearGroup(this.geoLayer);
    this.group.removeFromParent();
  }
}

function vectorToLatLon(vec) {
  const n = vec.clone().normalize();
  const phi = Math.acos(THREE.MathUtils.clamp(n.y, -1, 1));
  const lat = 90 - (phi * RAD2DEG);
  const theta = Math.atan2(n.z, -n.x);
  let lon = 180 - (theta * RAD2DEG);
  lon = ((lon + 540) % 360) - 180;
  return { lat, lon };
}

function clearGroup(group) {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const child = group.children[i];
    child.geometry?.dispose?.();
    if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose?.());
    else child.material?.dispose?.();
    group.remove(child);
  }
}

class HeightSampler {
  static async fromTexture(texture) {
    const canvas = document.createElement('canvas');
    canvas.width = texture.image.width;
    canvas.height = texture.image.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(texture.image, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return new HeightSampler(imageData);
  }

  constructor(imageData) {
    this.w = imageData.width;
    this.h = imageData.height;
    this.data = imageData.data;
  }

  sample(lat, lon) {
    const uRaw = (lon + 180) / 360;
    const vRaw = (90 - lat) / 180;
    let u = (uRaw + UV_YAW) % 1;
    if (u < 0) u += 1;
    const v = THREE.MathUtils.clamp(vRaw, 0, 1);
    const x = Math.floor(u * (this.w - 1));
    const y = Math.floor(v * (this.h - 1));
    const idx = (y * this.w + x) * 4;
    return this.data[idx] / 255.0;
  }
}
