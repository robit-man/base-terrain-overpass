import * as THREE from 'three';
import { metresPerDegree, latLonToWorld, worldToLatLon } from './geolocate.js';
import { TerrainRelay } from './terrainRelay.js';
import { pickGeohashPrecision, geohashEncode } from './geohash.js';
import { now } from './utils.js';

export const DEFAULT_TERRAIN_RELAY = 'forwarder.4658c990865d63ad367a3f9e26203df9ad544f9d58ef27668db4f3ebc570eb5f';
export const DEFAULT_TERRAIN_DATASET = 'mapzen';
const PIPELINE_TYPES = ['interactive', 'visual', 'farfield'];
const TILE_SIZE_METERS = 1000;
const DEFAULT_SUBDIVISIONS = 64;
const DM_BUDGET_BYTES = 2800;
const MAX_LOCATIONS_PER_BATCH = 800;
const MAX_FETCH_CONCURRENCY = 1;
const HEIGHT_RETRY_LIMIT = 2;
const WEBMERC_TILE_SIZE = 256;
const MAX_TEXTURE_ANISOTROPY = 8;
const SMOOTHING_PASSES = 2;
const SMOOTH_BLEND = 0.35;
const DEFAULT_TILE_SOURCE = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
const GRID_OFFSETS_4 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

const clamp = (val, min, max) => Math.max(min, Math.min(max, val));

function lerp(a, b, t) { return a + (b - a) * t; }

function approxEqual(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }

function byteLength(obj) {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

function highestPow2LE(n) {
  if (!Number.isFinite(n) || n <= 0) return 1;
  return 2 ** Math.floor(Math.log2(n));
}

function part1By1(n) {
  n &= 0x0000ffff;
  n = (n | (n << 8)) & 0x00ff00ff;
  n = (n | (n << 4)) & 0x0f0f0f0f;
  n = (n | (n << 2)) & 0x33333333;
  n = (n | (n << 1)) & 0x55555555;
  return n;
}

function morton2(x, y) {
  return (part1By1(y) << 1) | part1By1(x);
}

export class TileManager {
  constructor(scene, spacing = 10, tileRadius = 500, audio = null, options = {}) {
    if (!scene) throw new Error('TileManager requires a THREE.Scene');
    this.scene = scene;
    this.audio = audio || null;
    this.tileSize = TILE_SIZE_METERS;
    const spacingHint = Math.max(1, spacing);
    const samplesOverride = Number.isFinite(options.samplesPerSide) ? Math.floor(options.samplesPerSide) : null;
    const subdivisionsOverride = Number.isFinite(options.subdivisions) ? Math.floor(options.subdivisions) : null;
    const defaultSubdiv = clamp(Math.round(this.tileSize / Math.max(5, spacingHint)), 8, 256);
    const initialSubdiv = samplesOverride != null ? Math.max(2, samplesOverride - 1) : (subdivisionsOverride ?? defaultSubdiv);
    this.subdivisions = clamp(initialSubdiv, 8, 256);
    this.vertexCountPerSide = this.subdivisions + 1;
    this.vertexCount = this.vertexCountPerSide * this.vertexCountPerSide;
    this.samplesPerSide = this.vertexCountPerSide;
    this.tileRadius = this.tileSize * 0.5;
    this.sampleSpacing = this.subdivisions > 0 ? this.tileSize / this.subdivisions : this.tileSize;
    this.spacing = this.sampleSpacing;

    this.INTERACTIVE_RING = clamp(options.interactiveRing ?? 1, 0, 6);
    this.VISUAL_RING = clamp(options.visualRing ?? 2, this.INTERACTIVE_RING, 8);
    this.FARFIELD_RING = clamp(
      options.farfieldRing ?? Math.max(this.VISUAL_RING + 1, 3),
      this.VISUAL_RING,
      12,
    );
    this.FARFIELD_EXTRA = Math.max(0, this.FARFIELD_RING - this.VISUAL_RING);
    this.FARFIELD_NEAR_PAD = 0;
    this.FARFIELD_CREATE_BUDGET = 32;
    this.FARFIELD_BATCH_SIZE = 128;

    this.tiles = new Map();
    this.tilesGroup = new THREE.Group();
    this.tilesGroup.name = 'terrain-tiles';
    this.scene.add(this.tilesGroup);

    this.origin = null;
    this._gridOffsetX = 0;
    this._gridOffsetZ = 0;
    this._activeBounds = null;
    this._lastUpdateCenter = { i: NaN, j: NaN };
    this._lastUpdateKey = null;
    this._lastUpdateTime = 0;

    this.GLOBAL_MIN_Y = Infinity;
    this.GLOBAL_MAX_Y = -Infinity;

    this._heightListeners = new Set();

    this.relayAddress = (options.relayAddress || DEFAULT_TERRAIN_RELAY).trim();
    this.relayDataset = (options.relayDataset || DEFAULT_TERRAIN_DATASET).trim() || DEFAULT_TERRAIN_DATASET;
    this.relayMode = options.relayMode === 'latlng' ? 'latlng' : 'geohash';
    this.relayTimeoutMs = options.relayTimeoutMs || 25000;
    this._relayStatus = {
      text: 'idle',
      level: 'info',
      connected: false,
      metrics: null,
      heartbeat: null,
      address: this.relayAddress,
    };
    this._pipelineState = this._makeEmptyPipelineState();

    this.renderer = options.renderer || null;
    this.enableTextures = options.enableTextures !== false;
    this._textureUrl = typeof options.textureUrl === 'function' ? options.textureUrl : DEFAULT_TILE_SOURCE;
    this._tileTextureCache = new Map();
    this._tileTextureInflight = new Map();

    this.terrainRelay = new TerrainRelay({
      defaultRelay: this.relayAddress,
      dataset: this.relayDataset,
      mode: this.relayMode,
      onStatus: (text, level) => this._onRelayStatus(text, level),
      clientProvider: options.terrainRelayClient || null,
    });
    this._relayConnected = false;

    if (typeof options.deferWarm !== 'boolean' || !options.deferWarm) {
      this._warmRelayClient();
    }

    this._pendingFetch = new Map();
    this._fetchInflight = new Set();
    this._warmingRelay = false;
    this._terrainSettingsBase = {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldRing: this.FARFIELD_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      tileSize: this.tileSize,
      tileRadius: this.tileRadius,
      subdivisions: this.subdivisions,
      samplesPerSide: this.samplesPerSide,
      spacing: this.spacing,
    };
    this._updatePipelineStatus();
  }

  /* ------------------------------------------------------------------ Relay */

  _onRelayStatus(text, level) {
    this._relayStatus = {
      ...this._relayStatus,
      text,
      level,
      connected: level !== 'error',
      address: this.relayAddress,
      metrics: this.terrainRelay?._metrics || null,
    };
    const nowConnected = this._relayStatus.connected && !!this.terrainRelay?.client;
    if (nowConnected && !this._relayConnected) {
      this._relayConnected = true;
      this._processFetchQueue();
    } else if (!nowConnected) {
      this._relayConnected = false;
    }
    this._updatePipelineStatus();
  }

  async _warmRelayClient() {
    if (this._relayConnected || this._warmingRelay) return;
    this._warmingRelay = true;
    try {
      await this.terrainRelay?.ensureClient();
      this._relayConnected = true;
      this._processFetchQueue();
    } catch {
      this._relayConnected = false;
    } finally {
      this._warmingRelay = false;
      this._updatePipelineStatus();
    }
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
    this._relayStatus.address = this.relayAddress;
    this.terrainRelay?.setRelayAddress(this.relayAddress);
    this._warmRelayClient();
     this._updatePipelineStatus();
    return this.relayAddress;
  }

  setRelayDataset(dataset) {
    this.relayDataset = (dataset || '').trim() || DEFAULT_TERRAIN_DATASET;
    this.terrainRelay?.setDataset(this.relayDataset);
    this._warmRelayClient();
    this._updatePipelineStatus();
    return this.relayDataset;
  }

  setRelayMode(mode) {
    this.relayMode = mode === 'latlng' ? 'latlng' : 'geohash';
    this.terrainRelay?.setMode(this.relayMode);
    this._warmRelayClient();
    this._updatePipelineStatus();
    return this.relayMode;
  }

  getRelayStatus() {
    const status = this._relayStatus || {};
    const pipeline = status.pipeline ? this._clonePipelineState(status.pipeline) : null;
    const metrics = status.metrics ? { ...status.metrics } : null;
    const heartbeat = status.heartbeat ? { ...status.heartbeat } : null;
    return {
      ...status,
      metrics,
      heartbeat,
      pipeline,
    };
  }

  /* ----------------------------------------------------------- Origin/grid */

  _computeGridAlignment(lat, lon) {
    const scale = metresPerDegree(lat);
    const latStepDeg = this.tileSize / scale.dLat;
    const lonStepDeg = this.tileSize / scale.dLon;
    const baseLat = Math.floor(lat / latStepDeg) * latStepDeg;
    const baseLon = Math.floor(lon / lonStepDeg) * lonStepDeg;
    const world = latLonToWorld(baseLat, baseLon, lat, lon);
    return {
      offsetX: Number.isFinite(world?.x) ? world.x : 0,
      offsetZ: Number.isFinite(world?.z) ? world.z : 0,
    };
  }

  async setOrigin(lat, lon, { immediate = false } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    if (this.origin && approxEqual(this.origin.lat, lat) && approxEqual(this.origin.lon, lon)) {
      return false;
    }

    this.origin = { lat, lon };
    const alignment = this._computeGridAlignment(lat, lon);
    this._gridOffsetX = alignment.offsetX;
    this._gridOffsetZ = alignment.offsetZ;
    this.refreshTiles();

    if (immediate) {
      const center = new THREE.Vector3(0, 0, 0);
      this.update(center);
    }
    return true;
  }

  refreshTiles() {
    for (const tile of this.tiles.values()) this._disposeTile(tile);
    this.tiles.clear();
    this._pendingFetch.clear();
    this._fetchInflight.clear();
    this.GLOBAL_MIN_Y = Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._activeBounds = null;
    this._lastUpdateCenter = { i: NaN, j: NaN };
    this._lastUpdateKey = null;
   this._lastUpdateTime = 0;
    this._pipelineState = this._makeEmptyPipelineState();
    this._updatePipelineStatus();
  }

  /* --------------------------------------------------------------- Helpers */

  _tileKey(i, j) { return `${i},${j}`; }

  _tileIndexFromWorld(x, z) {
    const i = Math.floor((x + this._gridOffsetX) / this.tileSize);
    const j = Math.floor((z + this._gridOffsetZ) / this.tileSize);
    return { i, j };
  }

  _tileBounds(i, j) {
    const minX = (i * this.tileSize) - this._gridOffsetX;
    const minZ = (j * this.tileSize) - this._gridOffsetZ;
    return { minX, minZ, maxX: minX + this.tileSize, maxZ: minZ + this.tileSize };
  }

  _parseTileKey(key) {
    if (!key || typeof key !== 'string') return null;
    const parts = key.split(',');
    if (parts.length !== 2) return null;
    const i = Number(parts[0]);
    const j = Number(parts[1]);
    if (!Number.isFinite(i) || !Number.isFinite(j)) return null;
    return { i, j };
  }

  tileKeyForWorld(x, z) {
    const { i, j } = this._tileIndexFromWorld(x, z);
    return this._tileKey(i, j);
  }

  worldBoundsForKey(key) {
    const idx = this._parseTileKey(key);
    if (!idx) return null;
    return this._tileBounds(idx.i, idx.j);
  }

  latLonBoundsForKey(key) {
    if (!this.origin) return null;
    const tile = this.tiles.get(key);
    if (tile?.boundsLatLon) return tile.boundsLatLon;
    const bounds = this.worldBoundsForKey(key);
    if (!bounds) return null;
    const corners = [
      worldToLatLon(bounds.minX, bounds.minZ, this.origin.lat, this.origin.lon),
      worldToLatLon(bounds.maxX, bounds.minZ, this.origin.lat, this.origin.lon),
      worldToLatLon(bounds.minX, bounds.maxZ, this.origin.lat, this.origin.lon),
      worldToLatLon(bounds.maxX, bounds.maxZ, this.origin.lat, this.origin.lon),
    ].filter((pt) => Number.isFinite(pt?.lat) && Number.isFinite(pt?.lon));
    if (!corners.length) return null;
    let minLat = Infinity; let maxLat = -Infinity;
    let minLon = Infinity; let maxLon = -Infinity;
    for (const pt of corners) {
      minLat = Math.min(minLat, pt.lat);
      maxLat = Math.max(maxLat, pt.lat);
      minLon = Math.min(minLon, pt.lon);
      maxLon = Math.max(maxLon, pt.lon);
    }
    return { minLat, maxLat, minLon, maxLon };
  }

  neighborKeysForKey(key) {
    const idx = this._parseTileKey(key);
    if (!idx) return [];
    const offsets = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    return offsets.map(([di, dj]) => this._tileKey(idx.i + di, idx.j + dj));
  }

  _buildProgressiveIndexLevels(nx, ny) {
    const maxStride = highestPow2LE(Math.min(Math.max(nx - 1, 1), Math.max(ny - 1, 1)));
    const strides = [];
    for (let step = maxStride; step >= 1; step >>= 1) strides.push(step);
    const scheduled = new Uint8Array(nx * ny);
    const levels = [];
    for (const step of strides) {
      const level = [];
      for (let y = 0; y < ny; y += step) {
        for (let x = 0; x < nx; x += step) {
          const idx = y * nx + x;
          if (scheduled[idx]) continue;
          scheduled[idx] = 1;
          level.push(idx);
        }
      }
      const mortonSorted = level
        .map((idx) => {
          const y = Math.floor(idx / nx);
          const x = idx % nx;
          return { idx, key: morton2(Math.floor(x / step), Math.floor(y / step)) };
        })
        .sort((a, b) => a.key - b.key)
        .map((entry) => entry.idx);
      levels.push(mortonSorted);
    }
    return levels;
  }

  _indicesToBatchesLatLng(dataset, indices, latLon) {
    const batches = [];
    let current = [];
    let curBytes = 0;
    for (const idx of indices) {
      const loc = latLon[idx];
      if (!loc) continue;
      const lngValRaw = Number.isFinite(loc.lng) ? loc.lng : loc.lon;
      if (!Number.isFinite(loc.lat) || !Number.isFinite(lngValRaw)) continue;
      const payloadLoc = {
        lat: Number.parseFloat((+loc.lat).toFixed(6)),
        lng: Number.parseFloat((+lngValRaw).toFixed(6)),
      };
      const candidate = { type: 'elev.query', dataset, locations: [...current, payloadLoc] };
      const bytes = byteLength(candidate);
      if (bytes <= DM_BUDGET_BYTES && candidate.locations.length <= MAX_LOCATIONS_PER_BATCH) {
        current.push(payloadLoc);
        curBytes = bytes;
      } else {
        if (current.length) batches.push({ mode: 'latlng', locations: current.slice(), bytes: curBytes });
        current = [payloadLoc];
        curBytes = byteLength({ type: 'elev.query', dataset, locations: current });
      }
    }
    if (current.length) batches.push({ mode: 'latlng', locations: current.slice(), bytes: curBytes });
    return batches;
  }

  _indicesToBatchesGeohash(dataset, indices, geohashes, meta) {
    const batches = [];
    let current = [];
    let curBytes = 0;
    for (const idx of indices) {
      const gh = geohashes[idx];
      if (!gh) continue;
      const candidate = { type: 'elev.query', dataset, geohashes: [...current, gh], ...meta };
      const bytes = byteLength(candidate);
      if (bytes <= DM_BUDGET_BYTES && candidate.geohashes.length <= MAX_LOCATIONS_PER_BATCH) {
        current.push(gh);
        curBytes = bytes;
      } else {
        if (current.length) batches.push({ mode: 'geohash', geohashes: current.slice(), bytes: curBytes, meta });
        current = [gh];
        curBytes = byteLength({ type: 'elev.query', dataset, geohashes: current, ...meta });
      }
    }
    if (current.length) batches.push({ mode: 'geohash', geohashes: current.slice(), bytes: curBytes, meta });
    return batches;
  }

  get gridOffset() {
    return { x: this._gridOffsetX, z: this._gridOffsetZ };
  }

  _disposeTile(tile) {
    if (!tile) return;
    if (tile.mesh) {
      tile.mesh.parent?.remove(tile.mesh);
      tile.mesh.geometry?.dispose?.();
      if (tile.mesh.material?.map) {
        tile.mesh.material.map.dispose?.();
        tile.mesh.material.map = null;
      }
      tile.mesh.material?.dispose?.();
    }
    if (tile.texture && typeof tile.texture.dispose === 'function') {
      tile.texture.dispose();
    }
    tile.texture = null;
    tile.texturePromise = null;
    tile.fetchAbort?.abort?.();
    this._pendingFetch.delete(tile.key);
    this._fetchInflight.delete(tile);
  }

  _ensureTile(i, j, type) {
    const key = this._tileKey(i, j);
    const existing = this.tiles.get(key);
    if (existing) {
      if (existing.type !== type) existing.type = type;
      return existing;
    }
    const tile = this._buildTile(i, j, type);
    this.tiles.set(key, tile);
    this._pendingFetch.set(key, tile);
    if (this.enableTextures) {
      this._prepareTileTexture(tile).catch((err) => {
        console.warn(`[tiles] texture prep failed for tile ${tile.key}`, err);
      });
    }
    return tile;
  }

  _buildTile(i, j, type) {
    const bounds = this._tileBounds(i, j);
    const centerX = (bounds.minX + bounds.maxX) * 0.5;
    const centerZ = (bounds.minZ + bounds.maxZ) * 0.5;

    const geometry = new THREE.PlaneGeometry(this.tileSize, this.tileSize, this.subdivisions, this.subdivisions);
    geometry.rotateX(-Math.PI / 2);

    const posAttr = geometry.getAttribute('position');
    posAttr.setUsage(THREE.DynamicDrawUsage);
    const colorAttr = new THREE.BufferAttribute(new Float32Array(posAttr.count * 3), 3);
    for (let idx = 0; idx < posAttr.count; idx++) {
      const base = idx * 3;
      colorAttr.array[base + 0] = 0.36;
      colorAttr.array[base + 1] = 0.42;
      colorAttr.array[base + 2] = 0.32;
    }
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('color', colorAttr);
    const uvAttr = new THREE.BufferAttribute(new Float32Array(posAttr.count * 2), 2);
    uvAttr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('uv', uvAttr);
    const vertexCount = posAttr.count;
    const sampleMask = new Uint8Array(vertexCount);
    const provisionalMask = new Uint8Array(vertexCount);
    const heightData = new Float32Array(vertexCount);
    heightData.fill(NaN);

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      metalness: 0.05,
      roughness: 0.85,
      flatShading: false,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.frustumCulled = false;
    mesh.position.set(centerX, 0, centerZ);
    mesh.name = `terrain-tile-${i}-${j}`;

    const latLon = new Array(vertexCount);
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;

    if (this.origin) {
      for (let idx = 0; idx < vertexCount; idx++) {
        const localX = posAttr.getX(idx);
        const localZ = posAttr.getZ(idx);
        const worldX = centerX + localX;
        const worldZ = centerZ + localZ;
        const ll = worldToLatLon(worldX, worldZ, this.origin.lat, this.origin.lon) || {};
        const latVal = Number.isFinite(ll.lat) ? ll.lat : this.origin.lat;
        const lonVal = Number.isFinite(ll.lon) ? ll.lon : this.origin.lon;
        const entry = { lat: latVal, lon: lonVal, lng: lonVal };
        latLon[idx] = entry;
        if (Number.isFinite(latVal)) {
          minLat = Math.min(minLat, latVal);
          maxLat = Math.max(maxLat, latVal);
        }
        if (Number.isFinite(lonVal)) {
          minLon = Math.min(minLon, lonVal);
          maxLon = Math.max(maxLon, lonVal);
        }
      }
    }

    this.tilesGroup.add(mesh);

    return {
      key: this._tileKey(i, j),
      i,
      j,
      type,
      mesh,
      geometry,
      posAttr,
      pos: posAttr,
      colorAttr,
      uvAttr,
      latLon,
      boundsLatLon: (Number.isFinite(minLat) && Number.isFinite(minLon))
        ? { minLat, maxLat, minLon, maxLon }
        : null,
      minX: bounds.minX,
      minZ: bounds.minZ,
      maxX: bounds.maxX,
      maxZ: bounds.maxZ,
      step: this.tileSize / this.subdivisions,
      heightData,
      sampleMask,
      provisionalMask,
      totalVertices: vertexCount,
      vertexCountPerSide: this.vertexCountPerSide,
      readyCount: 0,
      unreadyCount: vertexCount,
      retries: 0,
      fetching: false,
      ready: false,
      createdAt: now(),
      texture: null,
      textureInfo: null,
      texturePromise: null,
      textureReady: false,
    };
  }

  _updateActiveBounds() {
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let found = false;

    for (const tile of this.tiles.values()) {
      const bounds = tile.boundsLatLon;
      if (!bounds) continue;
      minLat = Math.min(minLat, bounds.minLat);
      maxLat = Math.max(maxLat, bounds.maxLat);
      minLon = Math.min(minLon, bounds.minLon);
      maxLon = Math.max(maxLon, bounds.maxLon);
      found = true;
    }

    this._activeBounds = found ? { minLat, maxLat, minLon, maxLon } : null;
  }

  getActiveBounds() {
    return this._activeBounds ? { ...this._activeBounds } : null;
  }

  /* ----------------------------------------------------------- Pipeline */

  _makeEmptyPipelineState() {
    const makeBuckets = () => ({
      interactive: 0,
      visual: 0,
      farfield: 0,
    });
    return {
      phase: 'idle',
      queue: 0,
      inflight: 0,
      pending: makeBuckets(),
      queued: makeBuckets(),
      inflightByType: makeBuckets(),
      deferredInteractive: 0,
      interactiveSecondPass: false,
      updatedAt: now(),
    };
  }

  _clonePipelineState(src) {
    if (!src) return this._makeEmptyPipelineState();
    const cloneBuckets = (bucket) => ({
      interactive: bucket?.interactive ?? 0,
      visual: bucket?.visual ?? 0,
      farfield: bucket?.farfield ?? 0,
    });
    return {
      ...src,
      pending: cloneBuckets(src.pending),
      queued: cloneBuckets(src.queued),
      inflightByType: cloneBuckets(src.inflightByType),
    };
  }

  _updatePipelineStatus() {
    const pipeline = this._makeEmptyPipelineState();
    pipeline.updatedAt = now();

    for (const tile of this._fetchInflight) {
      const type = PIPELINE_TYPES.includes(tile?.type) ? tile.type : 'farfield';
      pipeline.inflightByType[type] = (pipeline.inflightByType[type] ?? 0) + 1;
    }
    pipeline.inflight = PIPELINE_TYPES.reduce(
      (sum, type) => sum + (pipeline.inflightByType[type] ?? 0),
      0,
    );

    for (const tile of this.tiles.values()) {
      const type = PIPELINE_TYPES.includes(tile?.type) ? tile.type : 'farfield';
      if (!tile.ready) {
        pipeline.pending[type] = (pipeline.pending[type] ?? 0) + 1;
      }
      if (this._pendingFetch.has(tile.key) && !tile.fetching && !tile.ready) {
        pipeline.queued[type] = (pipeline.queued[type] ?? 0) + 1;
      }
    }

    pipeline.queue = PIPELINE_TYPES.reduce(
      (sum, type) => sum + (pipeline.queued[type] ?? 0),
      0,
    );

    if ((pipeline.pending.interactive + pipeline.queued.interactive + pipeline.inflightByType.interactive) > 0) {
      pipeline.phase = 'interactive';
    } else if ((pipeline.pending.visual + pipeline.queued.visual + pipeline.inflightByType.visual) > 0) {
      pipeline.phase = 'visual';
    } else if ((pipeline.pending.farfield + pipeline.queued.farfield + pipeline.inflightByType.farfield) > 0) {
      pipeline.phase = 'farfield';
    } else {
      pipeline.phase = 'idle';
    }

    this._pipelineState = pipeline;

    const health = this.terrainRelay?.getHealth?.();
    const metrics = health?.metrics ? { ...health.metrics } : (this._relayStatus.metrics ? { ...this._relayStatus.metrics } : null);
    const heartbeat = health?.heartbeat ? { ...health.heartbeat } : (this._relayStatus.heartbeat ? { ...this._relayStatus.heartbeat } : null);

    this._relayStatus = {
      ...this._relayStatus,
      address: health?.address || this.relayAddress,
      connected: health?.connected ?? this._relayStatus.connected,
      dataset: health?.dataset || this.relayDataset,
      mode: health?.mode || this.relayMode,
      metrics,
      heartbeat,
      pipeline,
    };
  }

  getPipelineState() {
    return this._clonePipelineState(this._pipelineState);
  }

  _fillUnknownHeights(tile) {
    if (!tile || !tile.heightData || !tile.sampleMask) return false;
    const total = tile.heightData.length;
    if (!Number.isFinite(total) || total <= 0) return false;
    const n = tile.vertexCountPerSide || Math.round(Math.sqrt(total));
    if (!Number.isFinite(n) || n <= 1) return false;
    const queue = [];
    const dist = new Int32Array(total);
    dist.fill(-1);
    for (let idx = 0; idx < total; idx++) {
      if (tile.sampleMask[idx]) {
        dist[idx] = 0;
        queue.push(idx);
      }
    }
    if (!queue.length) return false;
    let filled = false;
    let head = 0;
    while (head < queue.length) {
      const idx = queue[head++];
      const x = idx % n;
      const y = Math.floor(idx / n);
      const sourceHeight = tile.heightData[idx];
      for (const [dx, dy] of GRID_OFFSETS_4) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        const nIdx = ny * n + nx;
        if (dist[nIdx] !== -1) continue;
        dist[nIdx] = dist[idx] + 1;
        queue.push(nIdx);
        if (!Number.isFinite(tile.heightData[nIdx]) && Number.isFinite(sourceHeight)) {
          tile.heightData[nIdx] = sourceHeight;
          tile.posAttr.setY(nIdx, sourceHeight);
          if (tile.provisionalMask) tile.provisionalMask[nIdx] = 1;
          filled = true;
        }
      }
    }
    if (filled) tile.posAttr.needsUpdate = true;
    return filled;
  }

  _smoothUnknownHeights(tile, passes = SMOOTHING_PASSES) {
    if (!tile || !tile.heightData || !tile.sampleMask) return false;
    const total = tile.heightData.length;
    if (!Number.isFinite(total) || total <= 0) return false;
    const n = tile.vertexCountPerSide || Math.round(Math.sqrt(total));
    if (!Number.isFinite(n) || n <= 1) return false;
    const buffer = new Float32Array(total);
    let anyChange = false;
    for (let pass = 0; pass < passes; pass++) {
      let passChanged = false;
      for (let idx = 0; idx < total; idx++) {
        if (tile.sampleMask[idx]) {
          buffer[idx] = tile.heightData[idx];
          continue;
        }
        const x = idx % n;
        const y = Math.floor(idx / n);
        let sum = 0;
        let count = 0;
        for (const [dx, dy] of GRID_OFFSETS_4) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
          const nIdx = ny * n + nx;
          const neighbor = tile.heightData[nIdx];
          if (Number.isFinite(neighbor)) {
            sum += neighbor;
            count += 1;
          }
        }
        if (!count) {
          buffer[idx] = tile.heightData[idx];
          continue;
        }
        const current = tile.heightData[idx];
        const avg = sum / count;
        const next = Number.isFinite(current)
          ? THREE.MathUtils.lerp(current, avg, SMOOTH_BLEND)
          : avg;
        buffer[idx] = next;
        if (!Number.isFinite(current) || Math.abs(next - current) > 1e-3) passChanged = true;
      }
      if (!passChanged) break;
      for (let idx = 0; idx < total; idx++) {
        if (tile.sampleMask[idx]) continue;
        const next = buffer[idx];
        if (!Number.isFinite(next)) continue;
        tile.heightData[idx] = next;
        tile.posAttr.setY(idx, next);
      }
      tile.posAttr.needsUpdate = true;
      anyChange = true;
    }
    return anyChange;
  }

  _metersPerPixel(lat, zoom) {
    const clampedLat = THREE.MathUtils.clamp(lat, -85.05112878, 85.05112878);
    const latRad = THREE.MathUtils.degToRad(clampedLat);
    const earthCircumference = 40075016.68557849;
    return earthCircumference * Math.cos(latRad) / (Math.pow(2, zoom) * WEBMERC_TILE_SIZE);
  }

  _latLonToPixels(lat, lon, zoom) {
    const clampedLat = THREE.MathUtils.clamp(lat, -85.05112878, 85.05112878);
    const latRad = THREE.MathUtils.degToRad(clampedLat);
    const sinLat = Math.sin(latRad);
    const scale = Math.pow(2, zoom) * WEBMERC_TILE_SIZE;
    const x = ((lon + 180) / 360) * scale;
    const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;
    return { x, y };
  }

  _pickTextureZoom(tile) {
    const bounds = tile?.boundsLatLon;
    if (!bounds) return 14;
    const latCenter = (bounds.minLat + bounds.maxLat) * 0.5;
    const targetPixels = THREE.MathUtils.clamp((this.tileSize / Math.max(1, this.spacing)) * 4, 256, 1024);
    let bestZoom = 14;
    let bestDiff = Infinity;
    for (let zoom = 6; zoom <= 18; zoom++) {
      const mpp = this._metersPerPixel(latCenter, zoom);
      const pixels = this.tileSize / mpp;
      const diff = Math.abs(pixels - targetPixels);
      if (diff < bestDiff) {
        bestDiff = diff;
        bestZoom = zoom;
      }
    }
    return bestZoom;
  }

  async _prepareTileTexture(tile) {
    if (!this.enableTextures || !tile || tile.texturePromise) return tile?.texturePromise || null;
    if (typeof document === 'undefined' || typeof fetch !== 'function') return null;
    if (!tile.boundsLatLon) return null;
    const promise = this._buildTileTexture(tile).catch((err) => {
      tile.textureReady = false;
      tile.texture = null;
      throw err;
    });
    tile.texturePromise = promise;
    return promise;
  }

  async _buildTileTexture(tile) {
    const bounds = tile?.boundsLatLon;
    if (!bounds) return null;
    const zoom = this._pickTextureZoom(tile);
    const corners = [
      { lat: bounds.minLat, lon: bounds.minLon },
      { lat: bounds.maxLat, lon: bounds.minLon },
      { lat: bounds.minLat, lon: bounds.maxLon },
      { lat: bounds.maxLat, lon: bounds.maxLon },
    ];
    let minPx = Infinity;
    let maxPx = -Infinity;
    let minPy = Infinity;
    let maxPy = -Infinity;
    for (const corner of corners) {
      const px = this._latLonToPixels(corner.lat, corner.lon, zoom);
      minPx = Math.min(minPx, px.x);
      maxPx = Math.max(maxPx, px.x);
      minPy = Math.min(minPy, px.y);
      maxPy = Math.max(maxPy, px.y);
    }
    const pad = WEBMERC_TILE_SIZE * 0.5;
    minPx -= pad;
    maxPx += pad;
    minPy -= pad;
    maxPy += pad;
    const maxIndex = Math.pow(2, zoom) * WEBMERC_TILE_SIZE - 1;
    minPx = THREE.MathUtils.clamp(minPx, 0, maxIndex);
    minPy = THREE.MathUtils.clamp(minPy, 0, maxIndex);
    maxPx = THREE.MathUtils.clamp(maxPx, 0, maxIndex);
    maxPy = THREE.MathUtils.clamp(maxPy, 0, maxIndex);
    const tileX0 = Math.max(0, Math.floor(minPx / WEBMERC_TILE_SIZE));
    const tileY0 = Math.max(0, Math.floor(minPy / WEBMERC_TILE_SIZE));
    const tileX1 = Math.max(tileX0, Math.floor(Math.max(minPx, maxPx) / WEBMERC_TILE_SIZE));
    const tileY1 = Math.max(tileY0, Math.floor(Math.max(minPy, maxPy) / WEBMERC_TILE_SIZE));
    const tileCountX = tileX1 - tileX0 + 1;
    const tileCountY = tileY1 - tileY0 + 1;
    const canvasWidth = tileCountX * WEBMERC_TILE_SIZE;
    const canvasHeight = tileCountY * WEBMERC_TILE_SIZE;
    const offsetX = tileX0 * WEBMERC_TILE_SIZE;
    const offsetY = tileY0 * WEBMERC_TILE_SIZE;
    const info = {
      zoom,
      tileX0,
      tileY0,
      tileX1,
      tileY1,
      tileCountX,
      tileCountY,
      canvasWidth,
      canvasHeight,
      offsetX,
      offsetY,
    };
    tile.textureInfo = info;

    if (tile.uvAttr && tile.latLon) {
      for (let idx = 0; idx < tile.latLon.length; idx++) {
        const ll = tile.latLon[idx];
        if (!ll) {
          tile.uvAttr.setXY(idx, 0, 0);
          continue;
        }
        const lonVal = Number.isFinite(ll.lng) ? ll.lng : ll.lon;
        const px = this._latLonToPixels(ll.lat, lonVal, zoom);
        const u = THREE.MathUtils.clamp((px.x - offsetX) / canvasWidth, 0, 1);
        const v = THREE.MathUtils.clamp(1 - (px.y - offsetY) / canvasHeight, 0, 1);
        tile.uvAttr.setXY(idx, u, v);
      }
      tile.uvAttr.needsUpdate = true;
    }

    const canvas = await this._composeTileCanvas(info);
    if (!canvas) return null;
    if (!this.tiles.has(tile.key)) return null;

    const texture = new THREE.CanvasTexture(canvas);
    texture.flipY = false;
    if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
    else if (typeof THREE.sRGBEncoding !== 'undefined') texture.encoding = THREE.sRGBEncoding;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = Math.min(
      MAX_TEXTURE_ANISOTROPY,
      this.renderer?.capabilities?.getMaxAnisotropy?.() ?? MAX_TEXTURE_ANISOTROPY,
    );
    texture.needsUpdate = true;

    tile.texture = texture;
    tile.textureReady = true;

    if (tile.mesh?.material) {
      if (tile.mesh.material.map && tile.mesh.material.map !== texture) {
        tile.mesh.material.map.dispose?.();
      }
      tile.mesh.material.map = texture;
      tile.mesh.material.vertexColors = false;
      tile.mesh.material.needsUpdate = true;
    }
    return texture;
  }

  async _composeTileCanvas(info) {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = info.canvasWidth;
    canvas.height = info.canvasHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const jobs = [];
    for (let ty = info.tileY0; ty <= info.tileY1; ty++) {
      for (let tx = info.tileX0; tx <= info.tileX1; tx++) {
        jobs.push(
          this._fetchTileImage(info.zoom, tx, ty).then((img) => ({ img, tx, ty })).catch(() => null),
        );
      }
    }
    const tiles = await Promise.all(jobs);
    for (const entry of tiles) {
      if (!entry?.img) continue;
      const dx = (entry.tx - info.tileX0) * WEBMERC_TILE_SIZE;
      const dy = (entry.ty - info.tileY0) * WEBMERC_TILE_SIZE;
      ctx.drawImage(entry.img, dx, dy, WEBMERC_TILE_SIZE, WEBMERC_TILE_SIZE);
    }
    return canvas;
  }

  async _fetchTileImage(zoom, x, y) {
    const key = `${zoom}/${x}/${y}`;
    if (this._tileTextureCache.has(key)) return this._tileTextureCache.get(key);
    if (this._tileTextureInflight.has(key)) return this._tileTextureInflight.get(key);
    const url = this._textureUrl?.(zoom, x, y);
    if (!url) throw new Error('texture url unavailable');
    const promise = (async () => {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) throw new Error(`tile ${key} http ${response.status}`);
      const blob = await response.blob();
      if (typeof createImageBitmap === 'function') {
        return createImageBitmap(blob);
      }
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const objectUrl = URL.createObjectURL(blob);
        img.onload = () => {
          URL.revokeObjectURL(objectUrl);
          resolve(img);
        };
        img.onerror = (err) => {
          URL.revokeObjectURL(objectUrl);
          reject(err || new Error('image load failed'));
        };
        img.src = objectUrl;
      });
    })()
      .then((img) => {
        this._tileTextureCache.set(key, img);
        this._tileTextureInflight.delete(key);
        return img;
      })
      .catch((err) => {
        this._tileTextureInflight.delete(key);
        throw err;
      });
    this._tileTextureInflight.set(key, promise);
    return promise;
  }

  /* ------------------------------------------------------------- Listeners */

  addHeightListener(fn) {
    if (typeof fn !== 'function') return () => {};
    this._heightListeners.add(fn);
    return () => this._heightListeners.delete(fn);
  }

  _notifyHeightListeners(tile) {
    if (!this._heightListeners.size || !tile) return;
    const info = {
      tileKey: tile.key,
      bounds: {
        minX: tile.minX,
        maxX: tile.maxX,
        minZ: tile.minZ,
        maxZ: tile.maxZ,
      },
    };
    for (const fn of this._heightListeners) {
      try { fn(info); } catch { /* ignore */ }
    }
  }

  /* --------------------------------------------------------------- Updates */

  update(worldPosition) {
    if (!this.origin || !worldPosition) return;

    const center = this._tileIndexFromWorld(worldPosition.x, worldPosition.z);
    const sameTile = (center.i === this._lastUpdateCenter.i) && (center.j === this._lastUpdateCenter.j);
    const nowMs = now();
    if (sameTile && (nowMs - this._lastUpdateTime) < 200) {
      this._processFetchQueue();
      return;
    }

    this._lastUpdateCenter = center;
    this._lastUpdateTime = nowMs;
    const radius = this.FARFIELD_RING;
    const needed = new Set();

    for (let di = -radius; di <= radius; di++) {
      for (let dj = -radius; dj <= radius; dj++) {
        const i = center.i + di;
        const j = center.j + dj;
        const dist = Math.max(Math.abs(di), Math.abs(dj));
        let type = 'farfield';
        if (dist <= this.INTERACTIVE_RING) type = 'interactive';
        else if (dist <= this.VISUAL_RING) type = 'visual';
        const tile = this._ensureTile(i, j, type);
        needed.add(tile.key);
      }
    }

    for (const key of Array.from(this.tiles.keys())) {
      if (!needed.has(key)) {
        const tile = this.tiles.get(key);
        this._disposeTile(tile);
        this.tiles.delete(key);
      }
    }

    this._updateActiveBounds();
    this._updatePipelineStatus();
    this._processFetchQueue();
  }

  _processFetchQueue() {
    if (!this.relayAddress) {
      this._updatePipelineStatus();
      return;
    }
    if (!this._relayConnected) {
      this._warmRelayClient();
      this._updatePipelineStatus();
      return;
    }
    if (!this._pendingFetch.size) {
      this._updatePipelineStatus();
      return;
    }

    const buckets = {
      interactive: [],
      visual: [],
      farfield: [],
      other: [],
    };

    for (const tile of this._pendingFetch.values()) {
      if (!tile || tile.fetching || tile.ready) continue;
      const bucketKey = PIPELINE_TYPES.includes(tile.type) ? tile.type : 'other';
      buckets[bucketKey].push(tile);
    }

    let dispatched = false;
    const order = ['interactive', 'visual', 'farfield', 'other'];
    outer: for (const key of order) {
      const list = buckets[key];
      if (!list || !list.length) continue;
      for (const tile of list) {
        if (this._fetchInflight.size >= MAX_FETCH_CONCURRENCY) break outer;
        tile.fetching = true;
        this._fetchInflight.add(tile);
        dispatched = true;
        this._updatePipelineStatus();
        this._fetchTileHeights(tile)
          .catch(() => {})
          .finally(() => {
            tile.fetching = false;
            this._fetchInflight.delete(tile);
            if (!tile.ready && tile.retries < HEIGHT_RETRY_LIMIT) {
              tile.retries += 1;
              this._pendingFetch.set(tile.key, tile);
            } else {
              this._pendingFetch.delete(tile.key);
            }
            this._updatePipelineStatus();
            this._processFetchQueue();
          });
        if (this._fetchInflight.size >= MAX_FETCH_CONCURRENCY) break outer;
      }
    }

    if (!dispatched) this._updatePipelineStatus();
  }

  async _fetchTileHeights(tile) {
    if (!tile || !this.origin) return;
    try {
      await this.terrainRelay.ensureClient();
    } catch (err) {
      console.warn('[tiles] relay unavailable', err);
      return;
    }

    const dataset = this.relayDataset;
    const mode = this.relayMode === 'geohash' ? 'geohash' : 'latlng';
    const total = tile.latLon?.length || 0;
    if (!total) {
      this._finalizeTileHeights(tile);
      return;
    }
    const side = tile.vertexCountPerSide || Math.round(Math.sqrt(total));
    if (!Number.isFinite(side) || side <= 1 || side * side !== total) {
      console.warn('[tiles] unexpected vertex grid for tile', tile.key);
    }

    const precision = pickGeohashPrecision(this.spacing);
    const latLonList = tile.latLon;
    const latKeyMap = new Map();
    for (let idx = 0; idx < total; idx++) {
      const ll = latLonList[idx];
      if (!ll) continue;
      const lonVal = Number.isFinite(ll.lng) ? ll.lng : ll.lon;
      const key = `${(+ll.lat).toFixed(6)},${(+lonVal).toFixed(6)}`;
      if (!latKeyMap.has(key)) latKeyMap.set(key, []);
      latKeyMap.get(key).push(idx);
    }
    const geohashList = mode === 'geohash' ? new Array(total) : null;
    const geohashBuckets = mode === 'geohash' ? new Map() : null;
    if (mode === 'geohash' && geohashList && geohashBuckets) {
      for (let idx = 0; idx < total; idx++) {
        const ll = latLonList[idx];
        if (!ll) continue;
        const lonVal = Number.isFinite(ll.lng) ? ll.lng : ll.lon;
        const gh = geohashEncode(ll.lat, lonVal, precision);
        geohashList[idx] = gh;
        if (!geohashBuckets.has(gh)) geohashBuckets.set(gh, []);
        geohashBuckets.get(gh).push(idx);
      }
    }

    const levels = this._buildProgressiveIndexLevels(side, side);
    for (const levelIndices of levels) {
      if (!this.tiles.has(tile.key)) return;
      let levelApplied = false;

      const batches = mode === 'geohash'
        ? this._indicesToBatchesGeohash(dataset, levelIndices, geohashList, { enc: 'geohash', prec: precision })
        : this._indicesToBatchesLatLng(dataset, levelIndices, latLonList);

      for (const batch of batches) {
        if (!this.tiles.has(tile.key)) return;
        let payload;
        let batchApplied = false;
        if (batch.mode === 'geohash') {
          payload = { type: 'elev.query', dataset, geohashes: batch.geohashes, enc: 'geohash', prec: precision };
        } else {
          payload = { type: 'elev.query', dataset, locations: batch.locations };
        }

        let reply = null;
        try {
          reply = await this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs);
        } catch (err) {
          console.warn(`[tiles] relay query failed for tile ${tile.key}`, err);
          continue;
        }
        const results = reply?.results || [];
        for (const res of results) {
          if (mode === 'geohash') {
            const hash = res.geohash || res.hash;
            const bucket = hash ? geohashBuckets?.get(hash) : null;
            if (!bucket || !bucket.length) continue;
            const height = Number(res.elevation);
            if (!Number.isFinite(height)) continue;
            while (bucket.length) {
              const idx = bucket.shift();
              this._applyHeightSample(tile, idx, height);
              levelApplied = true;
              batchApplied = true;
            }
            geohashBuckets?.delete(hash);
          } else if (res.location) {
            const key = `${(+res.location.lat).toFixed(6)},${(+res.location.lng).toFixed(6)}`;
            const list = latKeyMap.get(key);
            if (!list || !list.length) continue;
            const height = Number(res.elevation);
            if (!Number.isFinite(height)) continue;
            while (list.length) {
              const idx = list.shift();
              this._applyHeightSample(tile, idx, height);
              levelApplied = true;
              batchApplied = true;
            }
            latKeyMap.delete(key);
          }
        }

        if (batchApplied) {
          this._fillUnknownHeights(tile);
          this._smoothUnknownHeights(tile, SMOOTHING_PASSES);
        }
      }

      if (levelApplied) {
        try { tile.geometry.computeVertexNormals(); } catch { /* ignore */ }
        this._updateTileColors(tile);
      }
    }

    this._finalizeTileHeights(tile);
  }

  _applyHeightSample(tile, idx, height) {
    if (!tile || !Number.isFinite(idx) || !Number.isFinite(height)) return;
    if (tile.sampleMask && !tile.sampleMask[idx]) {
      tile.sampleMask[idx] = 1;
      tile.readyCount = (tile.readyCount ?? 0) + 1;
      tile.unreadyCount = Math.max(0, (tile.unreadyCount ?? 0) - 1);
    }
    if (tile.provisionalMask) tile.provisionalMask[idx] = 0;
    tile.heightData[idx] = height;
    if (height < this.GLOBAL_MIN_Y) this.GLOBAL_MIN_Y = height;
    if (height > this.GLOBAL_MAX_Y) this.GLOBAL_MAX_Y = height;
    tile.posAttr.setY(idx, height);
    tile.posAttr.needsUpdate = true;
  }

  _finalizeTileHeights(tile) {
    if (!tile) return;
    if (tile.unreadyCount > 0) {
      let sum = 0;
      let samples = 0;
      for (let i = 0; i < tile.heightData.length; i++) {
        const val = tile.heightData[i];
        if (Number.isFinite(val)) {
          sum += val;
          samples += 1;
        }
      }
      const fallback = samples > 0 ? (sum / samples) : 0;
      for (let i = 0; i < tile.heightData.length; i++) {
        if (tile.sampleMask && tile.sampleMask[i]) continue;
        tile.heightData[i] = fallback;
        tile.posAttr.setY(i, fallback);
        if (tile.sampleMask) tile.sampleMask[i] = 1;
        if (tile.provisionalMask) tile.provisionalMask[i] = 0;
      }
      tile.readyCount = tile.totalVertices;
      tile.unreadyCount = 0;
      if (fallback < this.GLOBAL_MIN_Y) this.GLOBAL_MIN_Y = fallback;
      if (fallback > this.GLOBAL_MAX_Y) this.GLOBAL_MAX_Y = fallback;
    } else {
      tile.readyCount = tile.totalVertices;
      tile.unreadyCount = 0;
      if (tile.sampleMask) tile.sampleMask.fill(1);
      if (tile.provisionalMask) tile.provisionalMask.fill(0);
    }

    tile.posAttr.needsUpdate = true;
    tile.geometry.computeVertexNormals();
    tile.ready = true;
    this._updateTileColors(tile);
    this._notifyHeightListeners(tile);
    this._updatePipelineStatus();
  }

  _updateTileColors(tile) {
    if (!tile?.colorAttr || !tile?.posAttr) return;
    const minY = Number.isFinite(this.GLOBAL_MIN_Y) ? this.GLOBAL_MIN_Y : 0;
    const maxY = Number.isFinite(this.GLOBAL_MAX_Y) ? this.GLOBAL_MAX_Y : minY + 1;
    const span = Math.max(1e-6, maxY - minY);
    const arr = tile.colorAttr.array;
    for (let i = 0; i < tile.posAttr.count; i++) {
      const y = tile.posAttr.getY(i);
      const t = THREE.MathUtils.clamp((y - minY) / span, 0, 1);
      const r = 0.22 + 0.48 * t;
      const g = 0.28 + 0.54 * t;
      const b = 0.32 + 0.44 * t;
      const base = i * 3;
      arr[base] = r;
      arr[base + 1] = g;
      arr[base + 2] = b;
    }
    tile.colorAttr.needsUpdate = true;
    if (tile.mesh?.material) tile.mesh.material.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- Height */

  getHeightAt(x, z) {
    if (!this.tiles.size) return 0;
    const { i, j } = this._tileIndexFromWorld(x, z);
    const tile = this.tiles.get(this._tileKey(i, j));
    if (!tile || !tile.ready) return 0;

    const localX = clamp(x - tile.minX, 0, this.tileSize);
    const localZ = clamp(z - tile.minZ, 0, this.tileSize);
    const fx = localX / tile.step;
    const fz = localZ / tile.step;
    const segments = Math.max(1, (tile.vertexCountPerSide || this.vertexCountPerSide) - 1);
    const ix = clamp(Math.floor(fx), 0, segments - 1);
    const iz = clamp(Math.floor(fz), 0, segments - 1);
    const tx = fx - ix;
    const tz = fz - iz;
    const n = tile.vertexCountPerSide || this.vertexCountPerSide;

    const idx00 = iz * n + ix;
    const idx10 = iz * n + (ix + 1);
    const idx01 = (iz + 1) * n + ix;
    const idx11 = (iz + 1) * n + (ix + 1);

    const h00 = tile.heightData[idx00];
    const h10 = tile.heightData[idx10];
    const h01 = tile.heightData[idx01];
    const h11 = tile.heightData[idx11];

    const hx0 = lerp(h00, h10, tx);
    const hx1 = lerp(h01, h11, tx);
    const value = lerp(hx0, hx1, tz);
    return Number.isFinite(value) ? value : 0;
  }

  hasInteractiveTerrainAt(x, z) {
    const { i, j } = this._tileIndexFromWorld(x, z);
    const tile = this.tiles.get(this._tileKey(i, j));
    return !!(tile && tile.type === 'interactive' && tile.ready);
  }

  applyRoadPaint() {
    // Road painting is not supported in the square-grid implementation.
    return false;
  }

  /* ------------------------------------------------------------- Perf tune */

  applyPerfProfile(profile = null) {
    if (!profile || typeof profile !== 'object') return null;
    const nextInteractive = Number.isFinite(profile.interactiveRing) ? Math.max(0, Math.floor(profile.interactiveRing)) : this.INTERACTIVE_RING;
    const nextVisual = Number.isFinite(profile.visualRing) ? Math.max(nextInteractive, Math.floor(profile.visualRing)) : this.VISUAL_RING;
    const nextFar = Number.isFinite(profile.farfieldRing) ? Math.max(nextVisual, Math.floor(profile.farfieldRing)) : this.FARFIELD_RING;
    const nextTileSize = Number.isFinite(profile.tileSize) ? Math.max(50, profile.tileSize) : this.tileSize;
    let nextSamples = Number.isFinite(profile.samplesPerSide)
      ? Math.max(3, Math.floor(profile.samplesPerSide))
      : this.samplesPerSide;
    if (nextSamples % 2 === 0) nextSamples += 1;
    const nextSubdiv = clamp(nextSamples - 1, 8, 256);
    nextSamples = nextSubdiv + 1;
    const nextSpacing = nextSubdiv > 0 ? nextTileSize / nextSubdiv : nextTileSize;
    const nextFarExtra = Number.isFinite(profile.farfieldExtra)
      ? Math.max(0, Math.floor(profile.farfieldExtra))
      : this.FARFIELD_EXTRA;
    const nextNearPad = Number.isFinite(profile.farfieldNearPad)
      ? Math.max(0, Math.floor(profile.farfieldNearPad))
      : this.FARFIELD_NEAR_PAD;
    const nextFarBudget = Number.isFinite(profile.farfieldCreateBudget)
      ? Math.max(1, Math.floor(profile.farfieldCreateBudget))
      : this.FARFIELD_CREATE_BUDGET;
    const nextFarBatch = Number.isFinite(profile.farfieldBatchSize)
      ? Math.max(1, Math.floor(profile.farfieldBatchSize))
      : this.FARFIELD_BATCH_SIZE;

    const changed = (
      nextInteractive !== this.INTERACTIVE_RING ||
      nextVisual !== this.VISUAL_RING ||
      nextFar !== this.FARFIELD_RING ||
      nextTileSize !== this.tileSize ||
      nextSamples !== this.samplesPerSide ||
      nextFarExtra !== this.FARFIELD_EXTRA ||
      nextNearPad !== this.FARFIELD_NEAR_PAD ||
      nextFarBudget !== this.FARFIELD_CREATE_BUDGET ||
      nextFarBatch !== this.FARFIELD_BATCH_SIZE
    );
    if (!changed) return null;

    this.INTERACTIVE_RING = nextInteractive;
    this.VISUAL_RING = nextVisual;
    this.FARFIELD_RING = nextFar;
    this.tileSize = nextTileSize;
    this.tileRadius = nextTileSize * 0.5;
    this.subdivisions = nextSubdiv;
    this.vertexCountPerSide = nextSamples;
    this.vertexCount = this.vertexCountPerSide * this.vertexCountPerSide;
    this.samplesPerSide = nextSamples;
    this.sampleSpacing = nextSpacing;
    this.spacing = nextSpacing;
    this.FARFIELD_EXTRA = nextFarExtra;
    this.FARFIELD_NEAR_PAD = nextNearPad;
    this.FARFIELD_CREATE_BUDGET = nextFarBudget;
    this.FARFIELD_BATCH_SIZE = nextFarBatch;

    this.refreshTiles();
    return {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldRing: this.FARFIELD_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      tileSize: this.tileSize,
      tileRadius: this.tileRadius,
      samplesPerSide: this.samplesPerSide,
      spacing: this.sampleSpacing,
    };
  }

  getTerrainSettings() {
    return {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldRing: this.FARFIELD_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      tileSize: this.tileSize,
      tileRadius: this.tileRadius,
      subdivisions: this.subdivisions,
      samplesPerSide: this.samplesPerSide,
      spacing: this.sampleSpacing,
    };
  }

  updateTerrainSettings(cfg = {}) {
    if (!cfg || typeof cfg !== 'object') return;
    const profile = {
      interactiveRing: cfg.interactiveRing,
      visualRing: cfg.visualRing,
      farfieldRing: cfg.farfieldRing,
      farfieldExtra: cfg.farfieldExtra,
      farfieldNearPad: cfg.farfieldNearPad,
      farfieldCreateBudget: cfg.farfieldCreateBudget,
      farfieldBatchSize: cfg.farfieldBatchSize,
      tileSize: cfg.tileSize,
      samplesPerSide: cfg.samplesPerSide,
    };
    this.applyPerfProfile(profile);
  }

  resetTerrainSettings() {
    this.applyPerfProfile(this._terrainSettingsBase);
  }
}
