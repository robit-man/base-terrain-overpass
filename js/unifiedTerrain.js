import * as THREE from 'three';
import { now } from './utils.js';
import { worldToLatLon, latLonToWorld } from './geolocate.js';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';

const SQRT3 = Math.sqrt(3);
const TWO_PI = Math.PI * 2;
const HEX_SEGMENTS = 6;
const DEFAULT_BANDS = [1, 2, 4, 8, 16];
const DEFAULT_BASE_STEP = 3;
const DEFAULT_INNER_RADIUS = 1200;
const DEFAULT_OUTER_RADIUS = 28000;
const DEFAULT_FEATHER = 0.08;
const DEFAULT_UPDATE_BUDGET_MS = 3;
const DEFAULT_CACHE_TTL_MS = 45 * 1000;

const DEFAULT_LUM_MIN = 0.05;
const DEFAULT_LUM_MAX = 0.9;

const RING_FEATHER_MIN_VERTS = 2;

const MIN_ANGULAR_SEGMENTS = 36;
const MAX_ANGULAR_SEGMENTS = 240;
const MIN_RADIAL_SEGMENTS = 2;
const MAX_RADIAL_SEGMENTS = 24;
const ANGULAR_SPACING_MULTIPLIER = 1.75;
const RADIAL_SPACING_MULTIPLIER = 8;

export class UnifiedTerrainMesh {
  constructor(scene, {
    origin = { lat: 0, lon: 0 },
    innerRadius = DEFAULT_INNER_RADIUS,
    outerRadius = DEFAULT_OUTER_RADIUS,
    baseStep = DEFAULT_BASE_STEP,
    bands = DEFAULT_BANDS,
    ringFeather = DEFAULT_FEATHER,
    maxUpdateMs = DEFAULT_UPDATE_BUDGET_MS,
    terrainRelay = null,
    relayAddress = null,
    relayDataset = 'mapzen',
    relayMode = 'geohash',
    relayTimeoutMs = 45000,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    materialFactory = null,
  } = {}) {
    if (!scene || !scene.isScene) {
      throw new Error('UnifiedTerrainMesh requires a THREE.Scene reference');
    }

    this.scene = scene;
    this.origin = {
      lat: Number.isFinite(origin?.lat) ? origin.lat : 0,
      lon: Number.isFinite(origin?.lon) ? origin.lon : 0,
    };

    this.innerRadius = Math.max(50, innerRadius || DEFAULT_INNER_RADIUS);
    this.outerRadius = Math.max(this.innerRadius + baseStep * 4, outerRadius || DEFAULT_OUTER_RADIUS);
    this.baseStep = Math.max(0.5, baseStep || DEFAULT_BASE_STEP);
    this.bands = Array.isArray(bands) && bands.length ? bands.slice() : DEFAULT_BANDS.slice();
    this.ringFeather = Math.max(0, ringFeather ?? DEFAULT_FEATHER);
    this.maxUpdateMs = Math.max(0.25, maxUpdateMs || DEFAULT_UPDATE_BUDGET_MS);
    this.cacheTtlMs = Math.max(1000, cacheTtlMs || DEFAULT_CACHE_TTL_MS);

    this.terrainRelay = terrainRelay;
    this.relayAddress = relayAddress || null;
    this.relayDataset = relayDataset || 'mapzen';
    this.relayMode = relayMode === 'latlng' ? 'latlng' : 'geohash';
    this.relayTimeoutMs = Math.max(5000, relayTimeoutMs || 45000);

    this._materialFactory = typeof materialFactory === 'function' ? materialFactory : null;

    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this.LUM_MIN = DEFAULT_LUM_MIN;
    this.LUM_MAX = DEFAULT_LUM_MAX;

    this._center = new THREE.Vector3();
    this._meshPosition = new THREE.Vector3();
    this._prevQuantized = new THREE.Vector2(Infinity, Infinity);
    this._quantizeStep = Math.max(this.baseStep * 8, this.innerRadius / 12);
    this._heightListeners = new Set();
    this._heightDirtyWorldBounds = null;

    this._vertexRecords = [];
    this._rings = [];
    this._bandInfo = [];
    this._positionAttr = null;
    this._normalAttr = null;
    this._colorAttr = null;
    this._index = null;
    this._geometry = null;
    this._mesh = null;

    this._yCurrent = null;
    this._yLow = null;
    this._yHigh = null;
    this._featherWeights = null;

    this._updateQueue = [];
    this._updateCursor = 0;
    this._lastUpdateMs = 0;
    this._cache = new Map();
    this._pendingRequests = new Map();
    this._requestQueue = [];
    this._maxRequestsPerFrame = 4;
    this._lastRequestPump = 0;

    this._normalDirty = new Set();
    this._normalTimer = 0;
    this._normalCadence = 200; // ms

    this._buildGeometry();
    this._scheduleFullRefresh();
  }

  dispose() {
    if (this._mesh) {
      this.scene.remove(this._mesh);
      try { this._mesh.geometry?.dispose?.(); } catch (_) { /* noop */ }
      try { this._mesh.material?.dispose?.(); } catch (_) { /* noop */ }
    }
    this._mesh = null;
    this._geometry = null;
    this._positionAttr = null;
    this._normalAttr = null;
    this._colorAttr = null;
    this._vertexRecords.length = 0;
    this._updateQueue.length = 0;
    this._cache.clear();
    this._pendingRequests.clear();
    this._requestQueue.length = 0;
  }

  setOrigin(lat, lon) {
    const clampedLat = Number.isFinite(lat) ? Math.max(-85, Math.min(85, lat)) : this.origin.lat;
    const wrapLon = (value) => {
      if (!Number.isFinite(value)) return this.origin.lon;
      let L = value;
      while (L < -180) L += 360;
      while (L > 180) L -= 360;
      return L;
    };
    const updated = (Math.abs(clampedLat - this.origin.lat) > 1e-6) ||
      (Math.abs(wrapLon(lon) - this.origin.lon) > 1e-6);
    if (!updated) return false;
    this.origin = { lat: clampedLat, lon: wrapLon(lon) };
    this._cache.clear();
    this._pendingRequests.clear();
    this._requestQueue.length = 0;
    this._scheduleFullRefresh();
    return true;
  }

  setRelay({ terrainRelay = null, relayAddress = null, relayDataset = null, relayMode = null, relayTimeoutMs = null } = {}) {
    if (terrainRelay) this.terrainRelay = terrainRelay;
    if (relayAddress != null) this.relayAddress = relayAddress;
    if (relayDataset != null) this.relayDataset = relayDataset;
    if (relayMode != null) this.relayMode = relayMode === 'latlng' ? 'latlng' : 'geohash';
    if (relayTimeoutMs != null && Number.isFinite(relayTimeoutMs)) this.relayTimeoutMs = Math.max(5000, relayTimeoutMs);
  }

  addHeightListener(fn) {
    if (typeof fn !== 'function') return () => {};
    this._heightListeners.add(fn);
    return () => this._heightListeners.delete(fn);
  }

  removeHeightListener(fn) {
    if (!fn) return;
    this._heightListeners.delete(fn);
  }

  get mesh() {
    return this._mesh;
  }

  getHeightAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !this._positionAttr) return 0;
    const tmp = { best: null, distSq: Infinity };
    const arr = this._positionAttr.array;
    for (let i = 0; i < arr.length; i += 3) {
      const vx = arr[i] + this._meshPosition.x;
      const vz = arr[i + 2] + this._meshPosition.z;
      const dx = vx - x;
      const dz = vz - z;
      const dSq = dx * dx + dz * dz;
      if (dSq < tmp.distSq) {
        tmp.distSq = dSq;
        tmp.best = arr[i + 1];
      }
    }
    return tmp.best ?? 0;
  }

  update(dt, camera, dolly) {
    const cam = camera && camera.isCamera ? camera : null;
    const rig = dolly && dolly.isObject3D ? dolly : null;
    const position = rig?.position || cam?.position || null;
    if (!position) return;

    const qx = Math.round(position.x / this._quantizeStep) * this._quantizeStep;
    const qz = Math.round(position.z / this._quantizeStep) * this._quantizeStep;
    if (!Number.isFinite(qx) || !Number.isFinite(qz)) return;

    const quantChanged = (Math.abs(qx - this._prevQuantized.x) > 1e-4) ||
      (Math.abs(qz - this._prevQuantized.y) > 1e-4);
    if (quantChanged) {
      this._prevQuantized.set(qx, qz);
      this._meshPosition.set(qx, 0, qz);
      if (this._mesh) this._mesh.position.copy(this._meshPosition);
      this._scheduleFullRefresh();
    }

    this._pumpHeightRequests();
    this._pumpUpdateQueue(dt);

    const nowMs = now();
    if ((nowMs - this._normalTimer) > this._normalCadence) {
      this._recomputeNormalsIncremental();
      this._normalTimer = nowMs;
    }
  }

  estimateVertexCount() {
    return this._vertexRecords.length;
  }

  static estimateMemory({
    bands = DEFAULT_BANDS,
    baseStep = DEFAULT_BASE_STEP,
    innerRadius = DEFAULT_INNER_RADIUS,
    outerRadius = DEFAULT_OUTER_RADIUS,
  } = {}) {
    const radii = UnifiedTerrainMesh._computeBandRadii(innerRadius, outerRadius, bands, baseStep);
    const ringCounts = radii.map((R, idx) => {
      const step = baseStep * (bands[idx] || 1);
      const approx = Math.max(1, Math.round(R / (step * 0.9)));
      return approx;
    });
    const totalVerts = ringCounts.reduce((acc, count) => acc + (count * HEX_SEGMENTS), 1);
    const perVertexBytes = (3 + 3 + 3) * 4; // pos + normal + color float32
    const memoryBytes = totalVerts * perVertexBytes;
    return {
      vertices: totalVerts,
      bytes: memoryBytes,
      megabytes: memoryBytes / (1024 * 1024),
      rings: ringCounts,
      radii,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Internal helpers                                                       */
  /* ---------------------------------------------------------------------- */

  static _computeBandRadii(innerRadius, outerRadius, bands, baseStep) {
    const out = [];
    const minStep = Math.max(baseStep, 0.5);
    const inner = Math.max(minStep * 4, innerRadius);
    const outer = Math.max(inner + minStep * 8, outerRadius);
    let current = inner;
    for (let i = 0; i < bands.length; i++) {
      if (i === 0) {
        out.push(current);
      } else if (i === bands.length - 1) {
        out.push(outer);
      } else {
        current = Math.min(outer, current * 2);
        out.push(current);
      }
    }
    if (out[out.length - 1] < outer) out[out.length - 1] = outer;
    return out;
  }

  _buildGeometry() {
    this._bandInfo = [];
    this._rings = [];
    this._vertexRecords.length = 0;

    const vertices = [];
    const colors = [];
    const normals = [];
    const indices = [];

    const bandRadii = UnifiedTerrainMesh._computeBandRadii(this.innerRadius, this.outerRadius, this.bands, this.baseStep);
    let prevRadius = 0;
    for (let b = 0; b < this.bands.length; b++) {
      const step = this.baseStep * (this.bands[b] || 1);
      const maxRadius = bandRadii[b];
      const minRadius = prevRadius;
      this._bandInfo.push({
        step,
        minRadius,
        maxRadius,
        rings: [],
        angularSegments: 0,
        radialSegments: 0,
      });
      prevRadius = maxRadius;
    }

    const determineAngularSegments = () => {
      const targetRadius = Math.max(this.innerRadius, this.baseStep * 8);
      const spacing = Math.max(this.baseStep * ANGULAR_SPACING_MULTIPLIER, 1);
      let approx = Math.round((2 * Math.PI * targetRadius) / spacing);
      if (!Number.isFinite(approx) || approx < MIN_ANGULAR_SEGMENTS) approx = MIN_ANGULAR_SEGMENTS;
      approx = Math.min(MAX_ANGULAR_SEGMENTS, approx);
      approx = Math.max(MIN_ANGULAR_SEGMENTS, approx);
      const multiple = Math.max(1, Math.round(approx / 6));
      return Math.max(6, multiple * 6);
    };

    const angularSegments = determineAngularSegments();
    const angleOffset = Math.PI / 6;
    const angleStep = TWO_PI / angularSegments;

    const recordRing = (radius, bandIndex, ringLocalIndex) => {
      const ring = {
        index: this._rings.length,
        radius,
        band: bandIndex,
        vertexStart: vertices.length / 3,
        vertexCount: 0,
        step: this._bandInfo[bandIndex].step,
        ringLocalIndex,
      };
      this._rings.push(ring);
      this._bandInfo[bandIndex].rings.push(ring.index);
      return ring;
    };

    const ensureFeatherWeight = (radius, band) => {
      const bandInfo = this._bandInfo[band];
      if (!bandInfo) return 0;
      const { minRadius, maxRadius, step } = bandInfo;

      const innerBoundary = minRadius;
      const outerBoundary = maxRadius;
      const featherWidth = Math.max(step, (maxRadius - minRadius) * this.ringFeather);
      if (featherWidth <= 0) return 0;
      if (radius <= innerBoundary) return 1;
      if (radius >= outerBoundary) return 0;
      const distToOuter = outerBoundary - radius;
      if (distToOuter <= 0) return 0;
      if (distToOuter >= featherWidth) return 1;
      const t = Math.max(0, Math.min(1, distToOuter / featherWidth));
      return t * t * (3 - 2 * t);
    };

    const addCenterVertex = () => {
      const ring = recordRing(0, 0, 0, 0);
      vertices.push(0, 0, 0);
      normals.push(0, 1, 0);
      colors.push(0.5, 0.5, 0.5);
      this._vertexRecords.push({
        ring: ring.index,
        band: 0,
        radius: 0,
        localIndex: 0,
        localAngle: 0,
        localX: 0,
        localZ: 0,
        feather: 1,
      });
      ring.vertexCount = 1;
      return ring;
    };

    const connectRings = (prev, curr) => {
      if (!prev || !curr) return;
      if (prev.vertexCount === 1) {
        const centerIndex = prev.vertexStart;
        const start = curr.vertexStart;
        for (let i = 0; i < curr.vertexCount; i++) {
          const next = (i + 1) % curr.vertexCount;
          indices.push(centerIndex, start + i, start + next);
        }
        return;
      }

      const prevStart = prev.vertexStart;
      const currStart = curr.vertexStart;
      const count = Math.min(prev.vertexCount, curr.vertexCount);
      for (let i = 0; i < count; i++) {
        const next = (i + 1) % count;
        indices.push(prevStart + i, currStart + i, prevStart + next);
        indices.push(prevStart + next, currStart + i, currStart + next);
      }
    };

    const addRingVertices = (radius, bandIndex, ringLocalIndex) => {
      const ring = recordRing(radius, bandIndex, ringLocalIndex);
      if (radius === 0) {
        ring.vertexCount = 1;
        return ring;
      }
      for (let i = 0; i < angularSegments; i++) {
        const angle = angleOffset + i * angleStep;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        vertices.push(x, 0, z);
        normals.push(0, 1, 0);
        colors.push(0.5, 0.5, 0.5);
        this._vertexRecords.push({
          ring: ring.index,
          band: bandIndex,
          radius,
          localIndex: i,
          localAngle: angle,
          localX: x,
          localZ: z,
          feather: ensureFeatherWeight(radius, bandIndex),
        });
      }
      ring.vertexCount = angularSegments;
      return ring;
    }

    const centerRing = addCenterVertex();
    let previousRing = centerRing;

    for (let bandIndex = 0; bandIndex < this._bandInfo.length; bandIndex++) {
      const info = this._bandInfo[bandIndex];
      const minRadius = info.minRadius;
      const maxRadius = info.maxRadius;
      const thickness = Math.max(maxRadius - minRadius, info.step);
      const desiredRadialStep = Math.max(info.step * RADIAL_SPACING_MULTIPLIER, info.step);
      let radialSegments = Math.round(thickness / desiredRadialStep);
      if (!Number.isFinite(radialSegments) || radialSegments < MIN_RADIAL_SEGMENTS) radialSegments = MIN_RADIAL_SEGMENTS;
      radialSegments = Math.min(MAX_RADIAL_SEGMENTS, radialSegments);
      info.radialSegments = radialSegments;
      info.angularSegments = angularSegments;

      const segmentCount = Math.max(1, radialSegments);
      for (let r = 0; r <= segmentCount; r++) {
        let t = r / segmentCount;
        let radius = minRadius + t * (maxRadius - minRadius);
        if (bandIndex === 0 && minRadius === 0 && r === 0) {
          continue; // center already added
        }
        if (bandIndex === 0 && radius < info.step * 0.5) radius = info.step * 0.5;
        if (previousRing && Math.abs(previousRing.radius - radius) < 1e-4) continue;
        const ring = addRingVertices(radius, bandIndex, r);
        connectRings(previousRing, ring);
        previousRing = ring;
      }
    }

    const innerInfo = this._bandInfo[0];
    if (innerInfo) {
      const coarse = Math.max(innerInfo.step * 6, innerInfo.maxRadius / 24);
      this._quantizeStep = Math.max(this.baseStep * 4, coarse);
    }

    const geometry = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(vertices), 3);
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const normAttr = new THREE.BufferAttribute(new Float32Array(normals), 3);
    normAttr.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.BufferAttribute(new Float32Array(colors), 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);

    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('normal', normAttr);
    geometry.setAttribute('color', colorAttr);
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();

    const material = this._materialFactory
      ? this._materialFactory()
      : new THREE.MeshStandardMaterial({
          color: 0xffffff,
          vertexColors: true,
          metalness: 0.04,
          roughness: 0.85,
          flatShading: false,
          side: THREE.DoubleSide,
        });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'UnifiedTerrainMesh';

    this.scene.add(mesh);
    this._geometry = geometry;
    this._mesh = mesh;
    this._positionAttr = posAttr;
    this._normalAttr = normAttr;
    this._colorAttr = colorAttr;
    this._index = geometry.index;

    this._mesh.position.copy(this._meshPosition);

    const count = this._vertexRecords.length;
    this._yCurrent = new Float32Array(count);
    this._yLow = new Float32Array(count);
    this._yHigh = new Float32Array(count);
    this._featherWeights = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      this._yCurrent[i] = 0;
      this._yLow[i] = 0;
      this._yHigh[i] = 0;
      this._featherWeights[i] = this._vertexRecords[i]?.feather ?? 0;
    }
  }

  _scheduleFullRefresh() {
    this._updateQueue.length = 0;
    for (let i = 0; i < this._vertexRecords.length; i++) {
      this._updateQueue.push(i);
    }
    this._updateCursor = 0;
    this._heightDirtyWorldBounds = null;
  }

  _pumpUpdateQueue(dt) {
    if (!this._positionAttr || !this._mesh) return;
    if (!this._updateQueue.length) return;

    const start = now();
    const budgetMs = Math.max(0.5, this.maxUpdateMs);
    const positionArray = this._positionAttr.array;
    const colorArray = this._colorAttr.array;

    while (this._updateCursor < this._updateQueue.length) {
      const idx = this._updateQueue[this._updateCursor++];
      this._sampleVertex(idx, positionArray, colorArray);
      this._normalDirty.add(idx);
      if ((now() - start) >= budgetMs) break;
    }

    if (this._updateCursor >= this._updateQueue.length) {
      this._updateQueue.length = 0;
      this._updateCursor = 0;
    }

    this._positionAttr.needsUpdate = true;
    this._colorAttr.needsUpdate = true;
  }

  _pumpHeightRequests() {
    if (!this._requestQueue.length) return;
    if (!this.terrainRelay || typeof this.terrainRelay.queryBatch !== 'function') return;
    if (!this.relayAddress) return;

    const nowMs = now();
    const maxPerFrame = Math.max(1, this._maxRequestsPerFrame | 0);
    let sent = 0;

    const nextBatch = [];
    while (this._requestQueue.length && sent < maxPerFrame) {
      const entry = this._requestQueue.shift();
      if (!entry) continue;
      if (entry.inflight) continue;
      if (!entry.vertices || entry.vertices.size === 0) {
        this._pendingRequests.delete(entry.key);
        continue;
      }
      if ((nowMs - entry.lastAttempt) < 150) {
        nextBatch.push(entry);
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
        payload.locations = [{ lat: entry.latLon.lat, lng: entry.latLon.lon }];
      }

      const finalize = () => {
        entry.inflight = false;
        if (!this._pendingRequests.has(entry.key)) return;
        if (entry.vertices.size) {
          this._requestQueue.push(entry);
        } else {
          this._pendingRequests.delete(entry.key);
        }
      };

      this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs)
        .then((json) => {
          const results = Array.isArray(json?.results) ? json.results : [];
          if (!results.length) return;
          const raw = results[0];
          const value = Number(raw?.elev ?? raw?.height ?? raw?.z ?? raw?.value ?? raw?.h);
          if (!Number.isFinite(value)) return;
          this._cache.set(entry.key, { y: value, t: now() });
          for (const vert of entry.vertices) {
            this._updateQueue.push(vert);
          }
          entry.vertices.clear();
        })
        .catch(() => {
          // swallow
        })
        .finally(() => finalize());
    }

    if (nextBatch.length) {
      this._requestQueue.push(...nextBatch);
    }
  }

  _sampleVertex(index, positionArray, colorArray) {
    const record = this._vertexRecords[index];
    if (!record) return;

    const localX = record.localX;
    const localZ = record.localZ;
    const worldX = this._meshPosition.x + localX;
    const worldZ = this._meshPosition.z + localZ;

    const height = this._fetchHeight(worldX, worldZ, record, index);
    const prevHeight = this._yCurrent[index];
    const newHeight = Number.isFinite(height) ? height : prevHeight;

    this._yHigh[index] = newHeight;
    this._yLow[index] = Number.isFinite(prevHeight) ? prevHeight : newHeight;
    const feather = this._featherWeights[index] ?? 1;
    const blended = this._mixHeights(index, feather);
    this._yCurrent[index] = blended;

    const i3 = index * 3;
    positionArray[i3] = localX;
    positionArray[i3 + 1] = blended;
    positionArray[i3 + 2] = localZ;

    this._updateGlobalMinMax(blended);
    this._applyColor(index, blended, colorArray);
    this._markHeightDirty(worldX, blended, worldZ);
  }

  _mixHeights(index, feather) {
    if (feather == null) return this._yHigh[index];
    const low = this._yLow[index];
    const high = this._yHigh[index];
    const t = feather;
    return low + (high - low) * t;
  }

  _updateGlobalMinMax(y) {
    let changed = false;
    if (Number.isFinite(y)) {
      if (y < this.GLOBAL_MIN_Y) { this.GLOBAL_MIN_Y = y; changed = true; }
      if (y > this.GLOBAL_MAX_Y) { this.GLOBAL_MAX_Y = y; changed = true; }
    }
    if (changed) this._refreshColors();
  }

  _refreshColors() {
    const min = this.GLOBAL_MIN_Y;
    const max = this.GLOBAL_MAX_Y;
    if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-4) return;
    const colors = this._colorAttr.array;
    for (let i = 0; i < this._vertexRecords.length; i++) {
      this._applyColor(i, this._yCurrent[i], colors);
    }
    this._colorAttr.needsUpdate = true;
  }

  _applyColor(index, y, colorArray) {
    const min = Number.isFinite(this.GLOBAL_MIN_Y) ? this.GLOBAL_MIN_Y : y;
    const max = Number.isFinite(this.GLOBAL_MAX_Y) ? this.GLOBAL_MAX_Y : y + 1;
    const lumMin = this.LUM_MIN;
    const lumMax = this.LUM_MAX;
    const t = Math.max(0, Math.min(1, (y - min) / Math.max(1e-3, max - min)));
    const lum = lumMin + (lumMax - lumMin) * t;
    const i3 = index * 3;
    colorArray[i3] = lum;
    colorArray[i3 + 1] = lum;
    colorArray[i3 + 2] = lum;
  }

  _markHeightDirty(wx, wy, wz) {
    if (!Number.isFinite(wx) || !Number.isFinite(wy) || !Number.isFinite(wz)) return;
    if (!this._heightDirtyWorldBounds) {
      this._heightDirtyWorldBounds = {
        minX: wx, maxX: wx,
        minY: wy, maxY: wy,
        minZ: wz, maxZ: wz,
      };
    } else {
      const b = this._heightDirtyWorldBounds;
      if (wx < b.minX) b.minX = wx;
      if (wx > b.maxX) b.maxX = wx;
      if (wy < b.minY) b.minY = wy;
      if (wy > b.maxY) b.maxY = wy;
      if (wz < b.minZ) b.minZ = wz;
      if (wz > b.maxZ) b.maxZ = wz;
    }

    if (this._heightDirtyWorldBounds) this._notifyHeightListeners();
  }

  _notifyHeightListeners() {
    if (!this._heightDirtyWorldBounds || !this._heightListeners.size) return;
    const payload = {
      worldBounds: { ...this._heightDirtyWorldBounds },
      timestamp: now(),
    };
    for (const fn of this._heightListeners) {
      try { fn(payload); } catch (_) { /* noop */ }
    }
    this._heightDirtyWorldBounds = null;
  }

  _fetchHeight(worldX, worldZ, record, vertexIndex) {
    if (!Number.isFinite(worldX) || !Number.isFinite(worldZ)) return 0;
    if (!Number.isFinite(this.origin.lat) || !Number.isFinite(this.origin.lon)) return 0;

    const latLon = worldToLatLon(worldX, worldZ, this.origin.lat, this.origin.lon);
    if (!latLon) return 0;

    const spacing = record ? this._bandInfo[record.band]?.step ?? this.baseStep : this.baseStep;
    const precision = pickGeohashPrecision(spacing * (record?.band ?? 1));
    const key = (this.relayMode === 'geohash')
      ? geohashEncode(latLon.lat, latLon.lon, precision)
      : `${latLon.lat.toFixed(5)},${latLon.lon.toFixed(5)}`;

    const nowMs = now();
    const cached = this._cache.get(key);
    if (cached && (nowMs - cached.t) < this.cacheTtlMs) {
      return cached.y;
    }

    this._queueHeightRequest(key, latLon, vertexIndex, record.band, precision);
    return cached ? cached.y : 0;
  }

  _queueHeightRequest(key, latLon, vertexIndex, bandIndex, precision) {
    if (!this.terrainRelay || !this.relayAddress) return;
    if (!key) return;

    let entry = this._pendingRequests.get(key);
    if (!entry) {
      entry = {
        key,
        latLon,
        precision,
        band: bandIndex,
        vertices: new Set(),
        inflight: false,
        lastAttempt: 0,
      };
      this._pendingRequests.set(key, entry);
      this._requestQueue.push(entry);
    }
    entry.vertices.add(vertexIndex);
  }

  _recomputeNormalsIncremental() {
    if (!this._normalDirty.size || !this._normalAttr || !this._positionAttr) return;
    const normals = this._normalAttr.array;
    const positions = this._positionAttr.array;
    const tmpSet = Array.from(this._normalDirty);
    this._normalDirty.clear();

    const indexArray = this._index?.array || [];

    const accumulate = new Array(this._vertexRecords.length).fill(null).map(() => new THREE.Vector3());
    const tri = new THREE.Triangle();
    const va = new THREE.Vector3();
    const vb = new THREE.Vector3();
    const vc = new THREE.Vector3();

    for (let i = 0; i < indexArray.length; i += 3) {
      const a = indexArray[i];
      const b = indexArray[i + 1];
      const c = indexArray[i + 2];

      va.fromArray(positions, a * 3);
      vb.fromArray(positions, b * 3);
      vc.fromArray(positions, c * 3);

      tri.set(va, vb, vc);
      const faceNormal = new THREE.Vector3();
      tri.getNormal(faceNormal);

      accumulate[a].add(faceNormal);
      accumulate[b].add(faceNormal);
      accumulate[c].add(faceNormal);
    }

    for (let i = 0; i < accumulate.length; i++) {
      const n = accumulate[i];
      if (!n.lengthSq()) continue;
      n.normalize();
      normals[i * 3] = n.x;
      normals[i * 3 + 1] = n.y;
      normals[i * 3 + 2] = n.z;
    }

    this._normalAttr.needsUpdate = true;
  }

  refreshAll() {
    this._cache.clear();
    this._pendingRequests.clear();
    this._requestQueue.length = 0;
    this._scheduleFullRefresh();
  }
}
