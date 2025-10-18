import * as THREE from 'three';
import { now } from './utils.js';
import { TerrainRelay } from './terrainRelay.js';
import { UnifiedTerrainMesh } from './unifiedTerrain.js';

const DEFAULT_TERRAIN_RELAY = 'forwarder.4658c990865d63ad367a3f9e26203df9ad544f9d58ef27668db4f3ebc570eb5f';
const DEFAULT_TERRAIN_DATASET = 'mapzen';

const CONFIG_DEFAULTS = {
  innerRadius: 1200,
  outerRadius: 28000,
  baseStep: 3,
  bands: [1, 2, 4, 8, 16],
  ringFeather: 0.08,
  maxUpdateMs: 3,
};

const QUALITY_BAND_THRESHOLDS = {
  high: 0.85,
  medium: 0.65,
  low: 0.5,
};

function cloneConfig(config) {
  return {
    innerRadius: config.innerRadius,
    outerRadius: config.outerRadius,
    baseStep: config.baseStep,
    bands: Array.isArray(config.bands) ? config.bands.slice() : CONFIG_DEFAULTS.bands.slice(),
    ringFeather: config.ringFeather,
    maxUpdateMs: config.maxUpdateMs,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export class TileManager {
  constructor(scene, spacing = 20, tileRadius = 100, audio = null, {
    terrainRelayClient = null,
    planetSurface = null,
  } = {}) {
    if (!scene || !(scene.isScene || scene.isObject3D)) {
      throw new Error('TileManager requires a THREE.Scene or Object3D root');
    }

    this.scene = scene;
    this.spacing = spacing;
    this.tileRadius = tileRadius;
    this._defaultTileRadius = tileRadius;
    this.audio = audio;

    this.tiles = new Map();
    this._compatTile = null;
    this._terrainReady = false;

    this.origin = { lat: 0, lon: 0 };
    this.relayMode = 'geohash';
    this.relayAddress = DEFAULT_TERRAIN_RELAY;
    this.relayDataset = DEFAULT_TERRAIN_DATASET;
    this.relayTimeoutMs = 45000;

    this._terrainRelayClientFactory = typeof terrainRelayClient === 'function'
      ? terrainRelayClient
      : null;

    this._relayStatus = {
      text: 'idle',
      level: 'info',
      connected: false,
      metrics: null,
      heartbeat: null,
      address: this.relayAddress,
      updatedAt: now(),
    };

    this.terrainRelay = new TerrainRelay({
      defaultRelay: this.relayAddress,
      dataset: this.relayDataset,
      mode: this.relayMode,
      onStatus: (text, level) => {
        this._relayStatus = {
          ...this._relayStatus,
          text,
          level,
          updatedAt: now(),
        };
      },
      clientProvider: this._terrainRelayClientFactory,
    });

    this.planetSurface = planetSurface ?? null;

    this._config = cloneConfig(CONFIG_DEFAULTS);
    this._lastProfile = null;
    this.unified = null;

    this._buildUnifiedMesh();
  }

  /* ---------------------------------------------------------------------- */
  /* Public API                                                             */
  /* ---------------------------------------------------------------------- */

  get GLOBAL_MIN_Y() {
    return this.unified?.GLOBAL_MIN_Y ?? 0;
  }

  set GLOBAL_MIN_Y(value) {
    if (this.unified) this.unified.GLOBAL_MIN_Y = value;
  }

  get GLOBAL_MAX_Y() {
    return this.unified?.GLOBAL_MAX_Y ?? 0;
  }

  set GLOBAL_MAX_Y(value) {
    if (this.unified) this.unified.GLOBAL_MAX_Y = value;
  }

  get LUM_MIN() {
    return this.unified?.LUM_MIN ?? 0.05;
  }

  set LUM_MIN(value) {
    if (this.unified) this.unified.LUM_MIN = value;
  }

  get LUM_MAX() {
    return this.unified?.LUM_MAX ?? 0.9;
  }

  set LUM_MAX(value) {
    if (this.unified) this.unified.LUM_MAX = value;
  }

  setOrigin(lat, lon, { immediate = false } = {}) {
    const changed = this.unified?.setOrigin?.(lat, lon) ?? false;
    if (changed) {
      this.origin = this.unified?.origin
        ? { lat: this.unified.origin.lat, lon: this.unified.origin.lon }
        : { lat, lon };
      this._syncTerrainReady();
      this._updateCompatTileDescriptor();
      if (immediate) this.refreshTiles();
    }
  }

  getHeightAt(x, z) {
    return this.unified?.getHeightAt?.(x, z) ?? 0;
  }

  addHeightListener(fn) {
    return this.unified?.addHeightListener?.(fn) || (() => {});
  }

  removeHeightListener(fn) {
    this.unified?.removeHeightListener?.(fn);
  }

  update(arg0, arg1 = null, arg2 = null) {
    if (!this.unified) return;
    let dt = 0;
    let camera = null;
    let dolly = null;

    if (typeof arg0 === 'number') {
      dt = arg0;
      camera = arg1;
      dolly = arg2;
    } else {
      camera = arg1;
      dolly = arg2 ?? arg0;
    }

    if (dolly && dolly.isVector3) {
      dolly = { position: dolly };
    } else if (dolly && typeof dolly.position !== 'object') {
      dolly = null;
    }

    if (!camera && dolly && dolly.camera) {
      camera = dolly.camera;
    }

    this.unified.update(dt, camera, dolly);
    this._syncTerrainReady();
    if (this._terrainReady) this._updateCompatTileDescriptor();
  }

  refreshTiles() {
    this.unified?.refreshAll?.();
    this._syncTerrainReady();
    this._updateCompatTileDescriptor();
  }

  getTerrainMesh() {
    return this.unified?.mesh ?? null;
  }

  isTerrainReady() {
    return !!this._terrainReady;
  }

  hasInteractiveTerrainAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const mesh = this.getTerrainMesh();
    if (!mesh) return false;
    const center = mesh.position;
    const dx = x - center.x;
    const dz = z - center.z;
    const dist = Math.hypot(dx, dz);
    return Number.isFinite(dist) && dist <= Math.max(this._config.innerRadius, this._config.baseStep * 4);
  }

  getTerrainSettings() {
    this._updateRingEstimates();
    return {
      ...cloneConfig(this._config),
      tileRadius: this.tileRadius,
      maxUpdateMs: this._config.maxUpdateMs,
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldRing: this.FARFIELD_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      relayAddress: this.relayAddress,
      relayDataset: this.relayDataset,
      relayMode: this.relayMode,
    };
  }

  updateTerrainSettings(settings = {}) {
    const next = this._normalizeConfig(settings);
    const changed = this._differs(this._config, next);
    if (!changed) return this.getTerrainSettings();
    this._config = next;
    this._buildUnifiedMesh();
    return this.getTerrainSettings();
  }

  resetTerrainSettings() {
    this._config = cloneConfig(CONFIG_DEFAULTS);
    if (Number.isFinite(this._defaultTileRadius)) this.tileRadius = this._defaultTileRadius;
    this._buildUnifiedMesh();
    return this.getTerrainSettings();
  }

  applyPerfProfile(profile) {
    if (!profile || typeof profile !== 'object') return null;
    this._lastProfile = profile;

    const quality = Number.isFinite(profile.quality)
      ? clamp(profile.quality, 0.2, 1.4)
      : 1;

    const base = cloneConfig(CONFIG_DEFAULTS);
    const next = cloneConfig(this._config);

    const outerMin = base.innerRadius * 2;
    const outerMax = base.outerRadius;
    const lerpOuter = THREE.MathUtils.lerp(outerMin, outerMax, clamp(quality, 0.25, 1));
    next.outerRadius = clamp(lerpOuter, base.innerRadius + 200, outerMax);

    if (quality < QUALITY_BAND_THRESHOLDS.low && next.bands.length > 2) {
      next.bands = next.bands.slice(0, -2);
    } else if (quality < QUALITY_BAND_THRESHOLDS.medium && next.bands.length > 3) {
      next.bands = next.bands.slice(0, -1);
    } else {
      next.bands = cloneConfig(base).bands;
    }

    const maxUpdate = THREE.MathUtils.lerp(6, 2, clamp(quality, 0.25, 1));
    next.maxUpdateMs = clamp(maxUpdate, 1.5, 8);

    if (this._differs(this._config, next)) {
      this._config = next;
      this._buildUnifiedMesh();
    } else if (this.unified) {
      this.unified.maxUpdateMs = next.maxUpdateMs;
      this._config.maxUpdateMs = next.maxUpdateMs;
      this._syncTerrainReady();
      this._updateCompatTileDescriptor();
    }

    return {
      appliedQuality: quality,
      settings: cloneConfig(this._config),
    };
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
    this.terrainRelay?.setRelayAddress?.(this.relayAddress);
    this.unified?.setRelay?.({ relayAddress: this.relayAddress });
  }

  setRelayDataset(dataset) {
    this.relayDataset = (dataset || '').trim() || DEFAULT_TERRAIN_DATASET;
    this.terrainRelay?.setDataset?.(this.relayDataset);
    this.unified?.setRelay?.({ relayDataset: this.relayDataset });
  }

  setRelayMode(mode) {
    const nextMode = mode === 'latlng' ? 'latlng' : 'geohash';
    if (nextMode === this.relayMode) return;
    this.relayMode = nextMode;
    this.terrainRelay?.setMode?.(this.relayMode);
    this.unified?.setRelay?.({ relayMode: this.relayMode });
    this.refreshTiles();
  }

  getRelayStatus() {
    const relay = this.terrainRelay?.getHealth?.() || null;
    return {
      ...(relay || {}),
      status: this._relayStatus,
    };
  }

  dispose() {
    if (this.unified && this.unified !== this.planetSurface) {
      this.unified.dispose?.();
    }
    this.unified = null;
    this.tiles.clear();
    this._compatTile = null;
    this._terrainReady = false;
  }

  /* ---------------------------------------------------------------------- */
  /* Internal helpers                                                       */
  /* ---------------------------------------------------------------------- */

  _normalizeConfig(settings) {
    const cfg = cloneConfig(this._config);
    if (settings.tileRadius != null) {
      const nextTile = clamp(Number(settings.tileRadius) || this.tileRadius, 10, 4000);
      this.tileRadius = nextTile;
    }
    if (settings.innerRadius != null) {
      cfg.innerRadius = clamp(Number(settings.innerRadius) || cfg.innerRadius, 100, 20000);
    }
    if (settings.outerRadius != null) {
      cfg.outerRadius = clamp(Number(settings.outerRadius) || cfg.outerRadius, cfg.innerRadius + 200, 60000);
    }
    if (settings.baseStep != null) {
      cfg.baseStep = clamp(Number(settings.baseStep) || cfg.baseStep, 1, 50);
    }
    if (settings.ringFeather != null) {
      cfg.ringFeather = clamp(Number(settings.ringFeather) || cfg.ringFeather, 0, 0.5);
    }
    if (settings.maxUpdateMs != null) {
      cfg.maxUpdateMs = clamp(Number(settings.maxUpdateMs) || cfg.maxUpdateMs, 0.5, 16);
    }
    if (Array.isArray(settings.bands) && settings.bands.length) {
      cfg.bands = settings.bands
        .map((n) => Math.max(1, Math.round(Number(n) || 1)))
        .sort((a, b) => a - b);
    }

    const baseTile = Math.max(1, this.tileRadius);
    if (settings.interactiveRing != null) {
      const interactiveRing = Math.max(1, Number(settings.interactiveRing) || 1);
      cfg.innerRadius = clamp(interactiveRing * baseTile, 200, cfg.outerRadius - baseTile);
    }

    let visualRing = this.VISUAL_RING;
    if (settings.visualRing != null) {
      visualRing = Math.max(1, Number(settings.visualRing) || this.VISUAL_RING || 1);
    }

    let farExtra = this.FARFIELD_EXTRA;
    if (settings.farfieldExtra != null) {
      farExtra = Math.max(0, Number(settings.farfieldExtra) || 0);
    }

    const farRing = Math.max(visualRing + Math.max(1, farExtra), visualRing + 1);
    const approxOuter = farRing * baseTile;
    cfg.outerRadius = clamp(approxOuter, cfg.innerRadius + baseTile, 80000);

    return cfg;
  }

  _differs(a, b) {
    if (!a || !b) return true;
    if (a.innerRadius !== b.innerRadius) return true;
    if (a.outerRadius !== b.outerRadius) return true;
    if (a.baseStep !== b.baseStep) return true;
    if (a.ringFeather !== b.ringFeather) return true;
    if (a.maxUpdateMs !== b.maxUpdateMs) return true;
    if (a.bands.length !== b.bands.length) return true;
    for (let i = 0; i < a.bands.length; i++) {
      if (a.bands[i] !== b.bands[i]) return true;
    }
    return false;
  }

  _buildUnifiedMesh() {
    if (this.unified && this.unified !== this.planetSurface) {
      this.unified.dispose();
      this.unified = null;
    }

    if (this.planetSurface) {
      this.unified = this.planetSurface;
    } else {
      this.unified = new UnifiedTerrainMesh(this.scene, {
        origin: this.origin,
        innerRadius: this._config.innerRadius,
        outerRadius: this._config.outerRadius,
        baseStep: this._config.baseStep,
        bands: this._config.bands,
        ringFeather: this._config.ringFeather,
        maxUpdateMs: this._config.maxUpdateMs,
        terrainRelay: this.terrainRelay,
        relayAddress: this.relayAddress,
        relayDataset: this.relayDataset,
        relayMode: this.relayMode,
        relayTimeoutMs: this.relayTimeoutMs,
      });
    }

    this.unified?.setRelay?.({
      terrainRelay: this.terrainRelay,
      relayAddress: this.relayAddress,
      relayDataset: this.relayDataset,
      relayMode: this.relayMode,
      relayTimeoutMs: this.relayTimeoutMs,
    });
    this.unified?.setDetailConfig?.({
      radiusMeters: Math.max(60000, this.tileRadius * 6),
      spacingMeters: Math.max(40, this._config.baseStep * 20),
      maxRequestsPerFrame: 8,
    });

    this.origin = this.unified?.origin
      ? { lat: this.unified.origin.lat, lon: this.unified.origin.lon }
      : this.origin;

    this._syncTerrainReady();
    this._updateCompatTileDescriptor();

    this._updateRingEstimates();
  }

  _syncTerrainReady() {
    const mesh = this.getTerrainMesh();
    if (!mesh) {
      this._terrainReady = false;
      this._compatTile = null;
      this.tiles.clear();
      return;
    }
    const posAttr = mesh.geometry?.getAttribute?.('position') ?? mesh.geometry?.attributes?.position;
    this._terrainReady = !!posAttr && Number.isFinite(posAttr.count) && posAttr.count > 0;
  }

  _updateCompatTileDescriptor() {
    const mesh = this.getTerrainMesh();
    if (!mesh || !this._terrainReady) {
      this.tiles.clear();
      this._compatTile = null;
      return;
    }
    const key = '0,0';
    if (!this._compatTile) {
      this._compatTile = {
        key,
        type: 'interactive',
        q: 0,
        r: 0,
        grid: { mesh },
        ready: true,
        unreadyCount: 0,
        updatedAt: now(),
      };
    } else {
      this._compatTile.grid.mesh = mesh;
      this._compatTile.ready = true;
      this._compatTile.unreadyCount = 0;
      this._compatTile.updatedAt = now();
    }
    this.tiles.set(key, this._compatTile);
  }

  _updateRingEstimates() {
    const base = Math.max(1, this.tileRadius || 1);
    const innerRing = Math.max(1, Math.round(this._config.innerRadius / base));
    const farRing = Math.max(innerRing + 2, Math.round(this._config.outerRadius / base));
    const visualRing = Math.max(innerRing + 1, Math.min(farRing - 1, Math.round((innerRing + farRing) * 0.5)));

    this.INTERACTIVE_RING = innerRing;
    this.VISUAL_RING = visualRing;
    this.FARFIELD_RING = farRing;
    this.FARFIELD_EXTRA = Math.max(0, farRing - visualRing);
    this.VISUAL_CREATE_BUDGET = 0;
    this.FARFIELD_CREATE_BUDGET = 0;
    this.FARFIELD_BATCH_SIZE = 0;
    this.FARFIELD_NEAR_PAD = 0;
  }
}
