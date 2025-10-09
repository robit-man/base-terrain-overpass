import * as THREE from 'three';
import { generateHexSurface } from './grid.js';
import { now } from './utils.js';
import { latLonToWorld } from './geolocate.js';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';
import { TerrainRelay } from './terrainRelay.js';

const DEFAULT_TERRAIN_RELAY = 'forwarder.4658c990865d63ad367a3f9e26203df9ad544f9d58ef27668db4f3ebc570eb5f';
const DEFAULT_TERRAIN_DATASET = 'mapzen';
const DM_BUDGET_BYTES = 2800;
const MAX_LOCATIONS_PER_BATCH = 900;

const DEFAULT_SPACING_CENTER = 8;
const DEFAULT_SPACING_EDGE = 220;
const DEFAULT_FALLOFF = 1.6;
const DEFAULT_RADIUS_METERS = 420;

const MIN_APOTHEM_METERS = 40;
const MAX_APOTHEM_METERS = 2400;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function latLonKey(lat, lon) {
  return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

function defaultColor() {
  return { r: 0.18, g: 0.21, b: 0.26 };
}

function colorFromHeight(t) {
  if (t < 0.25) {
    return { r: 0.12, g: 0.2 + t * 0.6, b: 0.45 + t * 0.8 };
  }
  if (t < 0.5) {
    const k = (t - 0.25) / 0.25;
    return { r: 0.12 + k * 0.55, g: 0.5 + k * 0.4, b: 0.22 };
  }
  if (t < 0.8) {
    const k = (t - 0.5) / 0.3;
    return { r: 0.67 + k * 0.28, g: 0.55 + k * 0.3, b: 0.2 - k * 0.05 };
  }
  const k = (t - 0.8) / 0.2;
  return { r: 0.95 + k * 0.05, g: 0.85 + k * 0.12, b: 0.7 + k * 0.25 };
}

export class TileManager {
  constructor(scene, spacing = DEFAULT_SPACING_CENTER, radiusMeters = DEFAULT_RADIUS_METERS, audio = null, options = {}) {
    this.scene = scene;
    this.audio = audio || null;

    this.spacingMin = Math.max(0.5, Number.isFinite(spacing) ? spacing : DEFAULT_SPACING_CENTER);
    this.spacingMax = Math.max(this.spacingMin + 0.5, DEFAULT_SPACING_EDGE);
    this.spacingFalloff = DEFAULT_FALLOFF;
    this.expandRatioSetting = 0.68;
    this.growthFactorSetting = 1.45;

    const initialApothem = clamp(
      (Number.isFinite(radiusMeters) ? radiusMeters : DEFAULT_RADIUS_METERS) * Math.sqrt(3) / 2,
      MIN_APOTHEM_METERS,
      MAX_APOTHEM_METERS
    );
    this.apothemMeters = initialApothem;
    this.radiusMeters = (2 * this.apothemMeters) / Math.sqrt(3);

    this.origin = null;
    this.vertexCount = 0;
    this.sampleCount = 0;
    this.levelCursor = 0;

    this.meshGroup = new THREE.Group();
    this.meshGroup.name = 'hex-terrain';
    scene.add(this.meshGroup);

    this.geometry = new THREE.BufferGeometry();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      metalness: 0.05,
      roughness: 0.88,
      flatShading: false,
      side: THREE.FrontSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.receiveShadow = true;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.meshGroup.add(this.mesh);

    const wireMaterial = new THREE.MeshBasicMaterial({
      color: 0x4f5b71,
      wireframe: true,
      opacity: 0.28,
      transparent: true,
      depthWrite: false,
    });
    this.wire = new THREE.Mesh(this.geometry, wireMaterial);
    this.wire.frustumCulled = false;
    this.wire.renderOrder = 1;
    this.meshGroup.add(this.wire);

    this.positionAttr = null;
    this.colorAttr = null;

    this.heightArray = new Float32Array(0);
    this.readyArray = new Uint8Array(0);
    this.sampleFetchState = new Uint8Array(0);
    this.sampleMask = new Uint8Array(0);
    this.vertexNeighbors = [];
    this.coreLevels = [];

    this.latLonSamples = new Float32Array(0);
    this.geohashSamples = [];
    this.latLonToSample = new Map();
    this.geohashToSample = new Map();
    this.sampleCache = new Map();

    this.fetchQueue = [];
    this._fetchQueueDirty = false;
    this._fetchLoopActive = false;

    this._currentPlayerPos = new THREE.Vector3(0, 0, 0);
    this._lastPlayerPos = new THREE.Vector3(Infinity, 0, Infinity);
    this._movementDir = new THREE.Vector3(0, 0, 0);
    this._tmpVec = new THREE.Vector3();

    this.RATE_QPS = 12;
    this.RATE_BPS = 256 * 1024;
    this._rateTokensQ = this.RATE_QPS;
    this._rateTokensB = this.RATE_BPS;
    this._rateBucketResetAt = (performance?.now?.() ?? Date.now());
    this._rateTicker = setInterval(() => {
      this._rateTokensQ = this.RATE_QPS;
      this._rateTokensB = this.RATE_BPS;
      this._drainFetchQueue();
    }, 1000);

    this.relayMode = options.relayMode === 'latlng' ? 'latlng' : 'geohash';
    this.relayAddress = (options.relayAddress || DEFAULT_TERRAIN_RELAY).trim();
    this.relayDataset = (options.relayDataset || DEFAULT_TERRAIN_DATASET).trim() || DEFAULT_TERRAIN_DATASET;
    this.relayTimeoutMs = 45000;
    this._relayStatus = {
      text: 'idle',
      level: 'info',
      connected: false,
      metrics: null,
      heartbeat: null,
      address: this.relayAddress,
    };

    this.terrainRelay = new TerrainRelay({
      defaultRelay: this.relayAddress,
      dataset: this.relayDataset,
      mode: this.relayMode,
      onStatus: (text, level) => this._onRelayStatus(text, level),
      clientProvider: options.terrainRelayClient || null,
    });

    this.GLOBAL_MIN_Y = Infinity;
    this.GLOBAL_MAX_Y = -Infinity;

    this._raycaster = new THREE.Raycaster();
    this._down = new THREE.Vector3(0, -1, 0);
    this._lastHeight = 0;

    this._normalsIntervalMs = 450;
    this._lastNormalsUpdate = 0;

    this._backfillInterval = 1600;
    this._backfillLoop = setInterval(() => this._scheduleBackfill(), this._backfillInterval);
  }

  /* ------------------------------------------------------------------ */
  /* Hex surface generation                                             */
  /* ------------------------------------------------------------------ */

  _rebuildSurface() {
    if (!this.origin) return;
    const surface = generateHexSurface({
      centerLat: this.origin.lat,
      centerLon: this.origin.lon,
      apothem: this.apothemMeters,
      spacingCenter: this.spacingMin,
      spacingEdge: this.spacingMax,
      falloff: this.spacingFalloff,
    });

    const points = surface.points;
    const total = points.length;
    const coreCount = surface.coreCount;

    this.vertexCount = total;
    this.sampleCount = coreCount;
    this.coreLevels = surface.levels || [];

    this.heightArray = new Float32Array(total);
    this.readyArray = new Uint8Array(total);
    this.sampleFetchState = new Uint8Array(coreCount);
    this.sampleMask = new Uint8Array(total);
    for (let i = 0; i < coreCount; i++) this.sampleMask[i] = 1;

    this.latLonSamples = new Float32Array(coreCount * 2);
    this.geohashSamples = new Array(coreCount);
    this.latLonToSample.clear();
    this.geohashToSample.clear();
    this.sampleCache.clear();

    const positions = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);
    const baseColor = defaultColor();

    for (let i = 0; i < total; i++) {
      const pt = points[i];
      const world = latLonToWorld(pt.lat, pt.lon, this.origin.lat, this.origin.lon) || { x: 0, z: 0 };
      positions[i * 3 + 0] = world.x;
      positions[i * 3 + 1] = 0;
      positions[i * 3 + 2] = world.z;
      colors[i * 3 + 0] = baseColor.r;
      colors[i * 3 + 1] = baseColor.g;
      colors[i * 3 + 2] = baseColor.b;
      if (i < coreCount) {
        this.latLonSamples[i * 2 + 0] = pt.lat;
        this.latLonSamples[i * 2 + 1] = pt.lon;
        this.latLonToSample.set(latLonKey(pt.lat, pt.lon), i);
      }
    }

    this.geometry?.dispose?.();
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setIndex(surface.triangles);
    this.geometry.computeVertexNormals();

    this.mesh.geometry = this.geometry;
    this.wire.geometry = this.geometry;
    this.positionAttr = this.geometry.getAttribute('position');
    this.colorAttr = this.geometry.getAttribute('color');

    this.vertexNeighbors = this._buildVertexNeighbors(surface.triangles, total);
    this.levelCursor = 0;
    this.fetchQueue.length = 0;
    this._fetchQueueDirty = false;

    this._updateGeohashes();
    this._markAllHeights({ resetHeights: true });
    this._queueInitialLevels();
  }

  _buildVertexNeighbors(indices, count) {
    const neighbors = Array.from({ length: count }, () => new Set());
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i];
      const b = indices[i + 1];
      const c = indices[i + 2];
      neighbors[a].add(b); neighbors[a].add(c);
      neighbors[b].add(a); neighbors[b].add(c);
      neighbors[c].add(a); neighbors[c].add(b);
    }
    return neighbors.map((set) => Array.from(set));
  }

  _updateGeohashes() {
    const precision = pickGeohashPrecision(this.spacingMin);
    this.geohashToSample.clear();
    for (let i = 0; i < this.sampleCount; i++) {
      const lat = this.latLonSamples[i * 2 + 0];
      const lon = this.latLonSamples[i * 2 + 1];
      const gh = geohashEncode(lat, lon, precision);
      this.geohashSamples[i] = gh;
      if (gh) this.geohashToSample.set(gh, i);
    }
  }

  _markAllHeights({ resetHeights = true } = {}) {
    this.sampleCache.clear();
    this.readyArray.fill(0);
    this.sampleFetchState.fill(0);
    this.levelCursor = 0;
    this.fetchQueue.length = 0;
    this._fetchQueueDirty = false;
    if (resetHeights) {
      this.heightArray.fill(0);
      if (this.positionAttr) {
        for (let i = 0; i < this.vertexCount; i++) {
          this.positionAttr.array[i * 3 + 1] = 0;
        }
        this.positionAttr.needsUpdate = true;
      }
      this.GLOBAL_MIN_Y = Infinity;
      this.GLOBAL_MAX_Y = -Infinity;
    }
    if (this.colorAttr) {
      const base = defaultColor();
      for (let i = 0; i < this.vertexCount; i++) {
        this.colorAttr.array[i * 3 + 0] = base.r;
        this.colorAttr.array[i * 3 + 1] = base.g;
        this.colorAttr.array[i * 3 + 2] = base.b;
      }
      this.colorAttr.needsUpdate = true;
    }
  }

  _queueInitialLevels() {
    if (!this.coreLevels.length) return;
    this._queueLevel(0, this._currentPlayerPos, this._movementDir);
    if (this.coreLevels.length > 1) this._queueLevel(1, this._currentPlayerPos, this._movementDir);
    if (this.coreLevels.length > 2) this._queueLevel(2, this._currentPlayerPos, this._movementDir);
  }

  /* ------------------------------------------------------------------ */
  /* Fetch scheduling                                                   */
  /* ------------------------------------------------------------------ */

  _queueLevel(levelIndex, playerPos = this._currentPlayerPos, movementDir = this._movementDir) {
    if (!this.coreLevels || levelIndex < 0 || levelIndex >= this.coreLevels.length) return;
    const level = this.coreLevels[levelIndex];
    if (!level || !level.length) return;
    const hasDir = movementDir && (Math.abs(movementDir.x) > 1e-4 || Math.abs(movementDir.z) > 1e-4);
    for (const idx of level) {
      if (idx == null || idx < 0 || idx >= this.sampleCount) continue;
      if (this.readyArray[idx]) continue;
      if (this.sampleFetchState[idx] !== 0) continue;
      this.sampleFetchState[idx] = 1;
      let weight = 1;
      if (playerPos && this.positionAttr) {
        const vx = this.positionAttr.array[idx * 3 + 0];
        const vz = this.positionAttr.array[idx * 3 + 2];
        this._tmpVec.set(vx - playerPos.x, 0, vz - playerPos.z);
        const dist = this._tmpVec.length();
        if (dist > 1e-4) {
          this._tmpVec.divideScalar(dist);
          if (hasDir) {
            const dot = clamp(this._tmpVec.x * movementDir.x + this._tmpVec.z * movementDir.z, -1, 1);
            weight += Math.max(0, dot) * 2.0;
          }
          weight += Math.max(0, 1 - dist / Math.max(this.radiusMeters, 1)) * 0.6;
        }
      }
      this.fetchQueue.push({ idx, weight });
      this._fetchQueueDirty = true;
    }
    this._drainFetchQueue();
  }

  _advanceLevels() {
    while (this.levelCursor < this.coreLevels.length) {
      const level = this.coreLevels[this.levelCursor];
      let allReady = true;
      for (const idx of level) {
        if (!this.readyArray[idx]) {
          allReady = false;
          break;
        }
      }
      if (!allReady) break;
      this.levelCursor += 1;
      if (this.levelCursor < this.coreLevels.length) {
        this._queueLevel(this.levelCursor, this._currentPlayerPos, this._movementDir);
      }
    }
  }

  _scheduleBackfill() {
    if (!this.origin || !this.vertexCount || this.levelCursor >= this.coreLevels.length) return;
    this._queueLevel(this.levelCursor, this._currentPlayerPos, this._movementDir);
  }

  async _acquireNetBudget(bytes) {
    const needed = Math.max(96, bytes | 0);
    for (let attempts = 0; attempts < 60; attempts++) {
      const nowT = (performance?.now?.() ?? Date.now());
      if (!this._rateBucketResetAt || nowT - this._rateBucketResetAt >= 1000) {
        this._rateBucketResetAt = nowT;
        this._rateTokensQ = this.RATE_QPS;
        this._rateTokensB = this.RATE_BPS;
      }
      if (this._rateTokensQ > 0 && this._rateTokensB >= needed) {
        this._rateTokensQ -= 1;
        this._rateTokensB -= needed;
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, 12));
    }
    return false;
  }

  _takeBatch() {
    if (!this.fetchQueue.length) return null;
    if (this._fetchQueueDirty) {
      this.fetchQueue.sort((a, b) => b.weight - a.weight);
      this._fetchQueueDirty = false;
    }

    const encoder = new TextEncoder();
    const mode = this.relayMode;
    const precision = pickGeohashPrecision(this.spacingMin);
    const indices = [];
    let estimatedBytes = 0;

    while (this.fetchQueue.length && indices.length < MAX_LOCATIONS_PER_BATCH) {
      const entry = this.fetchQueue.shift();
      if (!entry) continue;
      const idx = entry.idx;
      if (idx == null || idx < 0 || idx >= this.sampleCount) continue;
      if (this.readyArray[idx]) continue;
      if (this.sampleFetchState[idx] === 2) continue;
      this.sampleFetchState[idx] = 2;
      indices.push(idx);

      if (mode === 'geohash') {
        const payload = {
          type: 'elev.query',
          dataset: this.relayDataset,
          geohashes: indices.map((i) => this.geohashSamples[i]),
          enc: 'geohash',
          prec: precision,
        };
        estimatedBytes = encoder.encode(JSON.stringify(payload)).length;
      } else {
        const payload = {
          type: 'elev.query',
          dataset: this.relayDataset,
          locations: indices.map((i) => ({
            lat: this.latLonSamples[i * 2 + 0],
            lng: this.latLonSamples[i * 2 + 1],
          })),
        };
        estimatedBytes = encoder.encode(JSON.stringify(payload)).length;
      }
      if (estimatedBytes >= DM_BUDGET_BYTES) break;
    }

    if (!indices.length) return null;
    return { indices, estimatedBytes };
  }

  async _drainFetchQueue() {
    if (this._fetchLoopActive) return;
    if (!this.fetchQueue.length) return;
    this._fetchLoopActive = true;
    try {
      while (this.fetchQueue.length) {
        const batch = this._takeBatch();
        if (!batch) break;
        const allowed = await this._acquireNetBudget(batch.estimatedBytes);
        if (!allowed) break;
        await this._dispatchBatch(batch.indices);
      }
    } finally {
      this._fetchLoopActive = false;
    }
  }

  async _dispatchBatch(sampleIndices) {
    const mode = this.relayMode;
    const precision = pickGeohashPrecision(this.spacingMin);
    const payload = { type: 'elev.query', dataset: this.relayDataset };
    if (mode === 'geohash') {
      payload.geohashes = sampleIndices.map((i) => this.geohashSamples[i]);
      payload.enc = 'geohash';
      payload.prec = precision;
    } else {
      payload.locations = sampleIndices.map((i) => ({
        lat: this.latLonSamples[i * 2 + 0],
        lng: this.latLonSamples[i * 2 + 1],
      }));
    }

    try {
      const response = await this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs);
      const results = response?.results || [];
      if (results.length) {
        this._applyRelayResults(results);
      } else {
        this._flagRetry(sampleIndices);
      }
    } catch {
      this._flagRetry(sampleIndices);
    }
  }

  _flagRetry(sampleIndices) {
    for (const idx of sampleIndices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= this.sampleCount) continue;
      if (this.readyArray[idx]) continue;
      this.sampleFetchState[idx] = 0;
      this.fetchQueue.push({ idx, weight: 0.5 });
    }
    this._fetchQueueDirty = true;
  }

  _applyRelayResults(results) {
    let touched = false;
    for (const res of results) {
      let idx = null;
      if (this.relayMode === 'geohash' && res.geohash) {
        idx = this.geohashToSample.get(res.geohash) ?? null;
      }
      if (idx == null && res.location) {
        const { lat, lng } = res.location;
        idx = this.latLonToSample.get(latLonKey(+lat, +lng)) ?? null;
      }
      if (idx == null || idx < 0 || idx >= this.sampleCount) continue;
      const elevation = Number(res.elevation);
      if (!Number.isFinite(elevation)) continue;
      this.heightArray[idx] = elevation;
      this.positionAttr.array[idx * 3 + 1] = elevation;
      this.readyArray[idx] = 1;
      this.sampleFetchState[idx] = 3;
      this.sampleCache.set(latLonKey(this.latLonSamples[idx * 2 + 0], this.latLonSamples[idx * 2 + 1]), elevation);
      touched = true;
    }

    if (!touched) return;

    this._recomputeGlobalRange();
    this._nearestAnchorFill();
    this._smoothAux(2);
    this._recomputeGlobalRange();
    this._updateColorsForAll();

    this.positionAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;

    const nowT = performance?.now?.();
    if (!this._lastNormalsUpdate || !nowT || nowT - this._lastNormalsUpdate > this._normalsIntervalMs) {
      this.geometry.computeVertexNormals();
      this._lastNormalsUpdate = nowT ?? Date.now();
    }

    this._advanceLevels();
  }

  _nearestAnchorFill() {
    if (!this.vertexNeighbors || !this.vertexNeighbors.length) return;
    const nearest = new Int32Array(this.vertexCount).fill(-1);
    const queue = new Int32Array(this.vertexCount);
    let qh = 0;
    let qt = 0;

    for (let i = 0; i < this.sampleCount; i++) {
      if (!this.readyArray[i]) continue;
      nearest[i] = i;
      queue[qt++] = i;
    }
    if (!qt) return;

    while (qh < qt) {
      const v = queue[qh++];
      const src = nearest[v];
      const neighbors = this.vertexNeighbors[v];
      for (const nb of neighbors) {
        if (nearest[nb] !== -1) continue;
        nearest[nb] = src;
        queue[qt++] = nb;
      }
    }

    for (let i = this.sampleCount; i < this.vertexCount; i++) {
      const src = nearest[i];
      if (src < 0) continue;
      const h = this.heightArray[src];
      if (!Number.isFinite(h)) continue;
      this.heightArray[i] = h;
      this.positionAttr.array[i * 3 + 1] = h;
      this.readyArray[i] = 1;
    }

    this.positionAttr.needsUpdate = true;
  }

  _smoothAux(iterations = 1) {
    if (!this.vertexNeighbors || !this.vertexNeighbors.length) return;
    const buffer = new Float32Array(this.vertexCount);
    for (let iter = 0; iter < iterations; iter++) {
      buffer.set(this.heightArray);
      for (let i = 0; i < this.vertexCount; i++) {
        if (this.sampleMask[i]) continue;
        const neighbors = this.vertexNeighbors[i];
        if (!neighbors || !neighbors.length) continue;
        let sum = 0;
        let count = 0;
        for (const nb of neighbors) {
          const h = this.heightArray[nb];
          if (!Number.isFinite(h)) continue;
          sum += h;
          count++;
        }
        if (count > 0) {
          buffer[i] = (this.heightArray[i] * 0.25) + (sum / count) * 0.75;
        }
      }
      this.heightArray.set(buffer);
    }

    for (let i = this.sampleCount; i < this.vertexCount; i++) {
      this.positionAttr.array[i * 3 + 1] = this.heightArray[i];
      this.readyArray[i] = 1;
    }
    this.positionAttr.needsUpdate = true;
  }

  _recomputeGlobalRange() {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < this.sampleCount; i++) {
      if (!this.readyArray[i]) continue;
      const h = this.heightArray[i];
      if (!Number.isFinite(h)) continue;
      if (h < min) min = h;
      if (h > max) max = h;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = 0;
      max = 1;
    }
    this.GLOBAL_MIN_Y = min;
    this.GLOBAL_MAX_Y = max;
  }

  _updateColorsForAll() {
    for (let i = 0; i < this.vertexCount; i++) {
      this._applyColorForVertex(i, this.heightArray[i]);
    }
    this.colorAttr.needsUpdate = true;
  }

  _applyColorForVertex(idx, height) {
    const min = this.GLOBAL_MIN_Y;
    const max = this.GLOBAL_MAX_Y;
    if (!Number.isFinite(height) || !Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-6) {
      return;
    }
    const t = clamp((height - min) / (max - min), 0, 1);
    const c = colorFromHeight(t);
    this.colorAttr.array[idx * 3 + 0] = c.r;
    this.colorAttr.array[idx * 3 + 1] = c.g;
    this.colorAttr.array[idx * 3 + 2] = c.b;
  }

  _updateGlobalFromHeight(height) {
    if (!Number.isFinite(height)) return;
    if (height < this.GLOBAL_MIN_Y) this.GLOBAL_MIN_Y = height;
    if (height > this.GLOBAL_MAX_Y) this.GLOBAL_MAX_Y = height;
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                         */
  /* ------------------------------------------------------------------ */

  setOrigin(lat, lon, { immediate = false } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const changed =
      !this.origin ||
      Math.abs(lat - this.origin.lat) > 1e-6 ||
      Math.abs(lon - this.origin.lon) > 1e-6;

    this.origin = { lat, lon };
    this._rebuildSurface();
    if (immediate || changed) {
      this.update(this._currentPlayerPos);
    }
  }

  setHexApothem(apothemMeters) {
    if (!Number.isFinite(apothemMeters) || apothemMeters <= 0) return false;
    const clamped = clamp(apothemMeters, MIN_APOTHEM_METERS, MAX_APOTHEM_METERS);
    if (Math.abs(clamped - this.apothemMeters) < 1e-3) return false;
    this.apothemMeters = clamped;
    this.radiusMeters = (2 * this.apothemMeters) / Math.sqrt(3);
    if (this.origin) {
      this._rebuildSurface();
      this._drainFetchQueue();
    }
    return true;
  }

  update(playerPos) {
    if (!this.origin) return;
    if (playerPos instanceof THREE.Vector3) {
      if (Number.isFinite(this._lastPlayerPos.x)) {
        this._movementDir.set(
          playerPos.x - this._lastPlayerPos.x,
          0,
          playerPos.z - this._lastPlayerPos.z
        );
        const len = this._movementDir.length();
        if (len > 0.1) {
          this._movementDir.divideScalar(len);
        } else {
          this._movementDir.set(0, 0, 0);
        }
      }
      this._currentPlayerPos.copy(playerPos);
      this._lastPlayerPos.copy(playerPos);
    }

    this._drainFetchQueue();
  }

  getHeightAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return this._lastHeight;
    this._raycaster.set(new THREE.Vector3(x, 2000, z), this._down);
    const hits = this._raycaster.intersectObject(this.mesh, true);
    if (hits && hits.length) {
      this._lastHeight = hits[0].point.y;
      return this._lastHeight;
    }
    return this._lastHeight;
  }

  refreshTiles() {
    if (!this.origin) return;
    this._markAllHeights({ resetHeights: true });
    this._queueInitialLevels();
    this._drainFetchQueue();
  }

  applyPerfProfile(profile) {
    if (!profile) return null;
    if (profile.quality && Number.isFinite(profile.quality)) {
      const q = clamp(profile.quality, 0.35, 2.0);
      const newApothem = clamp(this.apothemMeters * q, MIN_APOTHEM_METERS, MAX_APOTHEM_METERS);
      if (Math.abs(newApothem - this.apothemMeters) > 1) {
        this.apothemMeters = newApothem;
        this.radiusMeters = (2 * this.apothemMeters) / Math.sqrt(3);
        if (this.origin) {
          this._rebuildSurface();
          this._drainFetchQueue();
        }
      }
    }
    return {
      spacingMin: this.spacingMin,
      spacingMax: this.spacingMax,
      falloff: this.spacingFalloff,
      radius: this.radiusMeters,
      recenterDistance: this.radiusMeters,
      expandRatio: this.expandRatioSetting,
      growthFactor: this.growthFactorSetting,
    };
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
    this.terrainRelay?.setRelayAddress(this.relayAddress);
    if (this._relayStatus) this._relayStatus.address = this.relayAddress || null;
  }

  setRelayDataset(dataset) {
    this.relayDataset = (dataset || '').trim() || DEFAULT_TERRAIN_DATASET;
    this.terrainRelay?.setDataset(this.relayDataset);
    this.refreshTiles();
  }

  setRelayMode(mode) {
    this.relayMode = mode === 'latlng' ? 'latlng' : 'geohash';
    this.terrainRelay?.setMode(this.relayMode);
    this._updateGeohashes();
    this.refreshTiles();
  }

  getRelayStatus() {
    return { ...this._relayStatus };
  }

  setTerrainResolution({
    min,
    max,
    falloff,
    radius,
    recenterDistance,
    expandRatio,
    growthFactor,
    apothem,
  } = {}) {
    let anyChange = false;
    let rebuild = false;

    if (Number.isFinite(min) && Math.abs(min - this.spacingMin) > 1e-3) {
      this.spacingMin = Math.max(0.5, min);
      anyChange = true;
      rebuild = true;
    }

    if (Number.isFinite(max) && Math.abs(max - this.spacingMax) > 1e-3) {
      this.spacingMax = Math.max(this.spacingMin + 0.5, max);
      anyChange = true;
      rebuild = true;
    }

    if (Number.isFinite(falloff) && Math.abs(falloff - this.spacingFalloff) > 1e-3) {
      this.spacingFalloff = Math.max(0.3, falloff);
      anyChange = true;
      rebuild = true;
    }

    if (Number.isFinite(apothem)) {
      const clamped = clamp(apothem, MIN_APOTHEM_METERS, MAX_APOTHEM_METERS);
      if (Math.abs(clamped - this.apothemMeters) > 1e-3) {
        this.apothemMeters = clamped;
        this.radiusMeters = (2 * this.apothemMeters) / Math.sqrt(3);
        anyChange = true;
        rebuild = true;
      }
    } else if (Number.isFinite(radius)) {
      const ap = clamp(radius * Math.sqrt(3) / 2, MIN_APOTHEM_METERS, MAX_APOTHEM_METERS);
      if (Math.abs(ap - this.apothemMeters) > 1e-3) {
        this.apothemMeters = ap;
        this.radiusMeters = (2 * this.apothemMeters) / Math.sqrt(3);
        anyChange = true;
        rebuild = true;
      }
    }
    if (Number.isFinite(expandRatio) && Math.abs(expandRatio - this.expandRatioSetting) > 1e-3) {
      this.expandRatioSetting = clamp(expandRatio, 0.3, 0.9);
      anyChange = true;
    }
    if (Number.isFinite(growthFactor) && Math.abs(growthFactor - this.growthFactorSetting) > 1e-3) {
      this.growthFactorSetting = clamp(growthFactor, 1.05, 2.5);
      anyChange = true;
    }

    if (!anyChange) return false;

    if (rebuild) {
      if (this.origin) {
        this._rebuildSurface();
        this._drainFetchQueue();
      }
    }
    return true;
  }

  get spacingMaxMeters() {
    return this.spacingMax;
  }

  get spacingMinMeters() {
    return this.spacingMin;
  }

  get recenterDistanceMeters() {
    return this.radiusMeters;
  }

  get expandRatio() {
    return this.expandRatioSetting;
  }

  get growthFactor() {
    return this.growthFactorSetting;
  }

  get tileRadius() {
    return this.radiusMeters;
  }

  invalidateHeightCache() {
    this._markAllHeights({ resetHeights: true });
    this._queueInitialLevels();
    this._drainFetchQueue();
  }

  dispose() {
    clearInterval(this._rateTicker);
    clearInterval(this._backfillLoop);
    this.meshGroup?.parent?.remove(this.meshGroup);
    this.geometry?.dispose?.();
    this.mesh?.material?.dispose?.();
    this.wire?.material?.dispose?.();
    this.fetchQueue.length = 0;
    this._fetchQueueDirty = false;
  }

  /* ------------------------------------------------------------------ */
  /* Relay status                                                       */
  /* ------------------------------------------------------------------ */

  _onRelayStatus(text, level) {
    this._relayStatus = {
      text,
      level,
      connected: level === 'ok',
      metrics: null,
      heartbeat: now(),
      address: this.relayAddress,
    };
  }
}
