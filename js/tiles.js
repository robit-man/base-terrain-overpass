// tiles.js
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { UniformHexGrid, HexCenterPoint } from './grid.js';
import { now } from './utils.js';
import { worldToLatLon, latLonToWorld } from './geolocate.js';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';
import { TerrainRelay } from './terrainRelay.js';
import { GrassManager } from './grass.js';
import { AdaptiveBatchScheduler } from './adaptiveBatchScheduler.js';

const DEFAULT_TERRAIN_RELAY = 'forwarder.4658c990865d63ad367a3f9e26203df9ad544f9d58ef27668db4f3ebc570eb5f';
const DEFAULT_TERRAIN_DATASET = 'mapzen';
const IS_MOBILE =
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
  (globalThis.matchMedia?.('(pointer: coarse)').matches ?? false);

// Smaller per-message budget + far fewer items per batch → lower parse/mem spikes
const DM_BUDGET_BYTES = 12000;
const MAX_LOCATIONS_PER_BATCH = IS_MOBILE ? 96 : 384;   // was 1800 (!)
const TERRAIN_FETCH_BOOST = IS_MOBILE ? 1 : 2;          // don't accelerate fetch on mobile

const PIN_SIDE_INNER_RATIO = 0.501; // 0.94 ≈ outer 6% of the tile; try 0.92 for thicker band
const FARFIELD_ADAPTER_INNER_RATIO = 0.985;
const EQ_TRI_ALTITUDE_SCALE = Math.sqrt(3) / 2;
const TAU = Math.PI * 2;
const HORIZON_SEGMENTS_DESKTOP = 96;
const HORIZON_SEGMENTS_MOBILE = 48;
const HORIZON_RADIAL_STEPS = 3;
const HORIZON_FOCUS_STRENGTH_DESKTOP = 2.8;
const HORIZON_FOCUS_STRENGTH_MOBILE = 1.6;
const HORIZON_FOCUS_SPEED_THRESHOLD = 12; // m/s before densifying forward tessellation
const HORIZON_UPDATE_INTERVAL_MS = 750;
const HORIZON_TEXTURE_SCALE = 1 / 120000;
const WAYBACK_WMTS_ROOT = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer';
const WAYBACK_WMTS_CAPABILITIES = 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml';
const DEFAULT_WAYBACK_VERSION = '49849';

// phased acquisition for interactive tiles
const PHASE_SEED = 0; // center + 6 tips
const PHASE_EDGE = 1; // midpoints on 6 sides
const PHASE_FULL = 2; // remaining unknowns / full pass

// axial neighbors for hex tiles (pointy-top)
const HEX_DIRS = [
  [1, 0], [1, -1], [0, -1],
  [-1, 0], [-1, 1], [0, 1],
];

// Normal map generation parameters (defaults - adjustable via UI)
const NORMAL_MAP_PROMINENCE = 0.8;  // Reduced from 2.0
const NORMAL_MAP_GAMMA = 1.0;
const NORMAL_MAP_HIGHPASS = 2;

/**
 * Normal map generation utilities (ported from normals-tiles.html)
 */

function boxBlur1DFloat(src, w, h, r, horizontal) {
  const N = src.length;
  const out = new Float32Array(N);
  if (r <= 0) { out.set(src); return out; }
  const norm = 1 / (2 * r + 1);

  if (horizontal) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) {
        const xx = Math.min(w - 1, Math.max(0, x));
        sum += src[y * w + xx];
      }
      out[y * w] = sum * norm;
      for (let x = 1; x < w; x++) {
        const add = Math.min(w - 1, x + r);
        const rem = Math.max(0, x - 1 - r);
        sum += src[y * w + add] - src[y * w + rem];
        out[y * w + x] = sum * norm;
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) {
        const yy = Math.min(h - 1, Math.max(0, y));
        sum += src[yy * w + x];
      }
      out[x] = sum * norm;
      for (let y = 1; y < h; y++) {
        const add = Math.min(h - 1, y + r);
        const rem = Math.max(0, y - 1 - r);
        sum += src[add * w + x] - src[rem * w + x];
        out[y * w + x] = sum * norm;
      }
    }
  }
  return out;
}

function blurFloat(src, w, h, r) {
  if (r <= 0) return new Float32Array(src);
  return boxBlur1DFloat(boxBlur1DFloat(src, w, h, r, true), w, h, r, false);
}

function computeNormalMapFromImage(img, opts = {}) {
  const { prominence = NORMAL_MAP_PROMINENCE, gamma = NORMAL_MAP_GAMMA, highpass = NORMAL_MAP_HIGHPASS, size = 256 } = opts;
  const w = size, h = size;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  let imgData;
  try { imgData = ctx.getImageData(0, 0, w, h); } catch (e) { console.warn('[TileManager] Cannot read image pixels (CORS):', e); return null; }
  const pixels = imgData.data;
  const H = new Float32Array(w * h);
  for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
    const luma = pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
    H[p] = Math.pow(luma / 255, gamma);
  }
  if (highpass > 0) {
    const B = blurFloat(H, w, h, highpass);
    for (let i = 0; i < H.length; i++) H[i] -= B[i];
  }
  const p = new Float32Array(w * h), q = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, xm = (x > 0 ? x - 1 : 0), xp = (x < w - 1 ? x + 1 : w - 1), ym = (y > 0 ? y - 1 : 0), yp = (y < h - 1 ? y + 1 : h - 1);
      p[i] = (H[y * w + xp] - H[y * w + xm]) * prominence;
      q[i] = (H[yp * w + x] - H[ym * w + x]) * prominence;
    }
  }
  const nrgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    let nx = -p[i], ny = -q[i], nz = 1;
    const inv = 1 / Math.hypot(nx, ny, nz);
    nx *= inv; ny *= inv; nz *= inv;
    const o = i * 4;
    nrgba[o] = ((nx * 0.5 + 0.5) * 255) | 0;
    nrgba[o + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
    nrgba[o + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
    nrgba[o + 3] = 255;
  }
  return nrgba;
}

export class TileManager {
  constructor(scene, spacing = 20, tileRadius = 100, audio = null, opts = {}) {
    this.scene = scene; this.spacing = spacing; this.tileRadius = tileRadius;
    this.audio = audio;   // spatial audio engine
    this.camera = opts.camera || null;  // camera for grass shader updates
    this.progressiveLoader = opts.progressiveLoader || null;  // unified progressive loading queue
    this.tiles = new Map(); this.origin = null;
    this._perfLogNext = 0;
    this._perfUpdateNext = 0;
    this._nextFarfieldLog = 0;
    this._deferredInteractive = new Set();
    this._interactiveSecondPass = false;

    // ---- LOD configuration ----
    this.INTERACTIVE_RING = 2;
    this.VISUAL_RING = 4;
    this.FARFIELD_EXTRA = 20;
    this.FARFIELD_RING = this.VISUAL_RING + this.FARFIELD_EXTRA;
    // turbo: do not throttle per-frame visual tile creation
    this.VISUAL_CREATE_BUDGET = 120;
    this.FARFIELD_CREATE_BUDGET = 360;
    this.FARFIELD_BATCH_SIZE = 360;
    this.FARFIELD_NEAR_PAD = 3;
    this.FARFIELD_ADAPTER_SEGMENTS = this._isMobile ? 4 : 8;
    this.HORIZON_EXTRA_METERS = 60000;
    this.HORIZON_TARGET_RADIUS = 100000;
    this.HORIZON_SEGMENTS = this._isMobile ? HORIZON_SEGMENTS_MOBILE : HORIZON_SEGMENTS_DESKTOP;
    this.HORIZON_RADIAL_STEPS = HORIZON_RADIAL_STEPS;
    this.HORIZON_FOCUS_STRENGTH = this._isMobile ? HORIZON_FOCUS_STRENGTH_MOBILE : HORIZON_FOCUS_STRENGTH_DESKTOP;
    this.HORIZON_FOCUS_THRESHOLD = HORIZON_FOCUS_SPEED_THRESHOLD;
    this.HORIZON_UPDATE_INTERVAL_MS = HORIZON_UPDATE_INTERVAL_MS;
    this.HORIZON_INNER_GAP = this.tileRadius * 0.5;
    this.HORIZON_TEXTURE_SCALE = HORIZON_TEXTURE_SCALE;

    // ---- interactive (high-res) relaxation ----
    // CRITICAL: Reduce relaxation iterations on mobile to prevent frame stalls
    this.RELAX_ITERS_PER_FRAME = this._isMobile ? 10 : 80;  // Mobile: 10 iters, Desktop: 20 iters
    this.RELAX_ALPHA = 0.1;
    this.NORMALS_EVERY = this._isMobile ? 20 : 5;  // Mobile: compute normals less frequently
    // keep relax cheap so fetching dominates
    this.RELAX_FRAME_BUDGET_MS = this._isMobile ? 0.5 : 1;  // Mobile: tighter budget

    // ---- GLOBAL grayscale controls (altitude => luminance) ----
    this.LUM_MIN = 0.20;   
    this.LUM_MAX = 0.26; 
    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._globalDirty = false;
    this._lastRecolorAt = 0;

    // ---- wireframe colors ----
    this.VISUAL_WIREFRAME_COLOR = 0x222222;
    this.INTERACTIVE_WIREFRAME_COLOR = 0x222222;

    // ---- normal map parameters ----
    this.normalMapsEnabled = false;  // Disabled by default
    this.normalProminence = NORMAL_MAP_PROMINENCE;
    this.normalGamma = NORMAL_MAP_GAMMA;
    this.normalHighpass = NORMAL_MAP_HIGHPASS;

    // ---- caching config ----
    this.CACHE_VER = 'v1';
    this._originCacheKey = 'na';
    this._fetchPhase = 'interactive';

    // Clean up old cache versions on initialization
    this._cleanupOldCacheVersions();

    this.ray = new THREE.Raycaster();
    this.ray.layers.enable(1);
    this.DOWN = new THREE.Vector3(0, -1, 0);
    this._tmpHorizonVec = new THREE.Vector3();
    this._lastHeight = 0;

    // Mobile guard: disable heavy trees on phones/tablets by default
    const _tmOnMobile = (typeof navigator !== 'undefined')
      && /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i.test(navigator.userAgent);

    // ---- Movement prediction for tile preloading ----
    this._lastPlayerPos = null;
    this._playerVelocity = new THREE.Vector3();
    this._velocityHistory = [];
    this._velocityHistorySize = 5;
    this.PREDICT_TILES_THRESHOLD = 2.0;  // m/s minimum velocity to trigger prediction
    this.PREDICT_LOOKAHEAD_TIME = 2.0;   // seconds to look ahead
    this.TILE_REMOVAL_HYSTERESIS = 2;    // extra rings to keep before removing tiles
    this.TILE_DOWNGRADE_HYSTERESIS = 1;  // extra rings before downgrading visual->farfield

    this._relaxKeys = [];
    this._relaxCursor = 0;
    this._relaxKeysDirty = true;
    this._roadStamps = [];
    this._roadStampIndex = new Map();
    this._farfieldMerge = {
      mesh: null,
      dirty: false,
      nextBuild: 0,
      debounceMs: 220,
      lastBuildCount: 0,
      lastBuildTime: 0,
    };
    this._horizonField = null;
    this._horizonDirty = true;
    this._nextHorizonUpdate = 0;
    this._overlayEnabled = _tmOnMobile ? false : true;
    this._overlayZoom = 16;
    this._overlayCache = new Map();
    this._overlayCanvas = null;
    this._overlayCtx = null;
    this._overlayVersion = DEFAULT_WAYBACK_VERSION;
    this._overlayVersions = [];
    this._overlayVersionPromise = null;
    this._overlayVersionLastFetch = 0;

    // Persist this so other systems (populate/relay throttling, finalize budget) can branch on mobile
    this._isMobile = _tmOnMobile;

    this._treeEnabled = !_tmOnMobile; // off on mobile, on otherwise

    this._treeLib = (typeof window !== 'undefined') ? window['@dgreenheck/ez-tree'] || null : null;
    this._treeLibPromise = null;
    this._treeLibWarned = false;

    // Dial back complexity on mobile to reduce instance counts and leaf density
    this._treeComplexity = _tmOnMobile ? 0.12 : 0.55;        // min is clamped at 0.20 internally
    this._treeTargetComplexity = this._treeComplexity;

    this._treePerfSamples = [];
    this._treePerfSampleTime = 0;

    this._treePerfEvalTimer = 0;
    this._treeRegenQueue = null;
    this._treeRegenSet = new Set();
    this._primeWaybackVersions();

    // On mobile: don't even construct the manager (avoids buffers & per-frame update)
    this.grassManager = _tmOnMobile ? null : new GrassManager({
      scene: this.scene,
      tileManager: this,
      camera: this.camera
    });

    // Toggle for generation + per-frame updates (used elsewhere in the file)
    this._grassEnabled = !_tmOnMobile;

    this._initHorizonField();


    if (!scene.userData._tmLightsAdded) {
      scene.add(new THREE.AmbientLight(0xffffff, .055));
      const sun = new THREE.DirectionalLight(0xffffff, .065);
      sun.position.set(50, 100, 50); sun.castShadow = false; scene.add(sun);
      scene.userData._tmLightsAdded = true;
    }


    this._baseLod = {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      visualCreateBudget: this.VISUAL_CREATE_BUDGET,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      relaxIters: this.RELAX_ITERS_PER_FRAME,
      relaxBudget: this.RELAX_FRAME_BUDGET_MS,
    };
    this._defaultTerrainSettings = {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      tileRadius: this.tileRadius,
      spacing: this.spacing,
    };
    this._lodQuality = 1;

    // ---- Relay wiring ----
    this.relayMode = 'geohash';
    this.relayAddress = DEFAULT_TERRAIN_RELAY;
    this.relayDataset = DEFAULT_TERRAIN_DATASET;
    this.relayTimeoutMs = 45000;
    this._relayStatus = {
      text: 'idle',
      level: 'info',
      connected: false,
      metrics: null,
      heartbeat: null,
      address: this.relayAddress,
    };
    this._relayWasConnected = false;
    this._relayWarmupActive = false;
    this._relayWarmupTimer = null;

    this.terrainRelay = new TerrainRelay({
      defaultRelay: this.relayAddress,
      dataset: this.relayDataset,
      mode: this.relayMode,
      onStatus: (text, level) => this._onRelayStatus(text, level),
    });

    // CRITICAL: Adaptive Batch Scheduler - prevents crash on NKN connect
    // Dynamically adjusts batch sizes based on real-time FPS monitoring
    // Starts with 1 tile (center only), increases when FPS > 50, pauses when FPS < 25
    this.adaptiveBatchScheduler = new AdaptiveBatchScheduler({
      isMobile: this._isMobile,
      tileManager: this,
      onBatchSizeChange: (sizes) => {
        console.log('[AdaptiveBatch] Batch sizes:', sizes);
      },
      onStatusChange: (status) => {
        // Optional: could update UI status indicator here
        if (status.paused) {
          console.warn('[AdaptiveBatch] Processing paused:', status.pauseReason);
        }
      }
    });

    // ---- populate plumbing (PHASED) ----
    this._populateQueue = [];          // entries: { tile, phase, priority }
    this._populateInflight = 0;
    this._populateBusy = false;        // legacy flag
    this._populateDrainPending = false;

    // CRITICAL: Global queue size limits to prevent crash on NKN connect
    this.MAX_POPULATE_QUEUE_SIZE = this._isMobile ? 30 : 100;

    // mobile vs desktop defaults for how hard we slam the relay / geometry
    if (this._isMobile) {
      this.MAX_CONCURRENT_POPULATES = 16;
      this.RATE_QPS = 6;               // max terrainRelay calls per second
      this.RATE_BPS = 160 * 1024;      // max payload bytes per second
    } else {
      this.MAX_CONCURRENT_POPULATES = 32; // allow aggressive concurrent fetch/populate passes
      this.RATE_QPS = 72;               // max terrainRelay calls per second
      this.RATE_BPS = 1536 * 1024;       // max payload bytes per second
    }

    this._mobileSafeModeActive = !!this._isMobile;
    this._mobileSafeModeInteractiveDone = 0;
    this._mobileSafeModeTimer = null;
    if (this._mobileSafeModeActive && typeof setTimeout === 'function') {
      this._mobileSafeModeTimer = setTimeout(() => this._exitMobileSafeMode('timeout'), 20000);
    }
    this._applyMobileSafeModeLimits();

    this._encoder = new TextEncoder();

    // ---- finalize queue (post-populate smoothing / normals / color) ----
    // instead of finalizing every tile immediately (which can nuke FPS when NKN connects),
    // we queue that heavy work and drain it incrementally each frame.
    this._finalizeQueue = [];
    // CRITICAL: Budget needs to be large enough to actually process tiles
    // Each tile takes ~10-20ms to finalize (BFS + smooth + normals)
    // Too small = queue balloons and tiles stay unfinalized forever
    this._finalizeBudgetMs = this._isMobile ? 18 : 45;

    // CRITICAL: Texture and grass queues - deferred until AFTER elevation fetch
    // NO TEXTURES until terrain elevation data is fetched
    // NO GRASS until terrain elevation data is fetched
    this._textureQueue = [];   // Tiles waiting for texture application
    this._grassQueue = [];     // Tiles waiting for grass injection

    // ---- network governor (token bucket) ----
    this._rateTokensQ = this.RATE_QPS;
    this._rateTokensB = this.RATE_BPS;
    this._rateLastRefillAt = this._nowMs();
    this._rateTicker = null;



    // Backfill scheduler (faster cadence)
    this._backfillTimer = null;
    this._lastBackfillTime = 0; // Track last backfill time for debouncing
    this._backfillIntervalMs = 600; // Reduced from 1200ms to prevent excessive re-queuing
    this._backfillMinDebounceMs = 250; // Minimum time between backfill executions
    this._periodicBackfillPaused = false; // Pause periodic during warmup
    this._periodicBackfill = setInterval(
      () => {
        // CRITICAL: Pause periodic backfill during warmup to prevent cascade
        if (this._periodicBackfillPaused) return;
        this._backfillMissing({ onlyIfRelayReady: true });
      },
      this._backfillIntervalMs
    );

    this._heightCache = new Map();
    this._heightCacheTTL = 250;
    this._heightCacheScale = 2;
    this._heightMeshesFallback = [];
    this._heightListeners = new Set();
    this._farfieldAdapterDirty = new Set();
    this._tmpSampleVec = new THREE.Vector3();
    this._treeHeightListener = this.addHeightListener((sample) => this._onTreeHeightSample(sample));
  }

  /* ---------------- small helpers ---------------- */

  _axialWorld(q, r) {
    const a = this.tileRadius;
    return { x: 1.5 * a * q, z: a * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r) };
  }
  _hexCorners(a) {
    const out = []; for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 3) * i; out.push({ x: a * Math.cos(ang), z: a * Math.sin(ang) });
    } return out;
  }
  _hexDist(q1, r1, q2, r2) {
    const dq = q1 - q2, dr = r1 - r2, ds = (-q1 - r1) - (-q2 - r2);
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
  }

  _interactiveWireFade(dist) {
    if (!Number.isFinite(this.INTERACTIVE_RING) || this.INTERACTIVE_RING <= 0) return 0;
    const t = THREE.MathUtils.clamp(dist / Math.max(1, this.INTERACTIVE_RING), 0, 1);
    const smooth = THREE.MathUtils.smoothstep(0, 1, t);
    return THREE.MathUtils.clamp(smooth * 0.55, 0, 0.55);
  }

  _visualWireFade(dist) {
    const span = Math.max(1, this.VISUAL_RING - this.INTERACTIVE_RING);
    const t = THREE.MathUtils.clamp((dist - this.INTERACTIVE_RING) / span, 0, 1);
    const smooth = THREE.MathUtils.smoothstep(0, 1, t);
    return THREE.MathUtils.clamp(0.20 + smooth * 0.75, 0, 0.95);
  }

  _makeDisintegratingWireMaterial(color, fade = 0.5) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0,
      depthWrite: false
    });

    mat.userData.uFade = THREE.MathUtils.clamp(fade, 0.0, 0.99);
    mat.userData.uTileRadius = this.tileRadius;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFade = { value: mat.userData.uFade };
      shader.uniforms.uTileRadius = { value: mat.userData.uTileRadius };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n varying vec3 vWorldPos;\n varying vec3 vLocalPos;\n')
        .replace('#include <project_vertex>', '#include <project_vertex>\n vLocalPos = position;\n vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;\n');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n varying vec3 vWorldPos;\n varying vec3 vLocalPos;\n uniform float uFade;\n uniform float uTileRadius;\n float hash13(vec3 p) {\n   p = fract(p * 0.3183099 + vec3(0.1,0.3,0.7));\n   p += dot(p, p.yzx + 19.19);\n   return fract((p.x + p.y) * p.z);\n }\n')
        .replace('#include <output_fragment>', 'float radial = clamp(length(vLocalPos.xz) / max(uTileRadius, 1e-3), 0.0, 1.0);\n vec3 hashInput = vec3(floor(vWorldPos.x * 0.35), floor(vWorldPos.z * 0.35), 0.0);\n float noise = hash13(hashInput);\n float radialBoost = mix(0.05, 0.55, radial);\n float fragFade = clamp(uFade + radialBoost * uFade + radial * 0.15, 0.0, 0.975);\n if (noise < fragFade) discard;\n #include <output_fragment>');

      mat.userData.shader = shader;
    };

    mat.onBeforeRender = () => {
      if (mat.userData.shader) {
        mat.userData.shader.uniforms.uFade.value = mat.userData.uFade;
        mat.userData.shader.uniforms.uTileRadius.value = mat.userData.uTileRadius;
      }
    };

    mat.customProgramCacheKey = () => `disintegrating-${color}`;
    return mat;
  }

  _getTile(q, r) { return this.tiles.get(`${q},${r}`) || null; }
  _getMeshForTile(t) { return t?.grid?.mesh || null; }
  _gatherNeighborMeshes(q, r) {
    const out = [];
    for (const [dq, dr] of HEX_DIRS) {
      const n = this._getTile(q + dq, r + dr);
      const m = this._getMeshForTile(n);
      if (m) out.push(m);
    }
    return out;
  }

/* =======================
   Overlay handoff helpers
   ======================= */

// Keeps a short-lived cache of overlay entries by tile id ("q,r")
_initOverlayHandoffMap() {
  if (!this._overlayHandoff) this._overlayHandoff = new Map();
}

// Capture the overlay from an existing tile before it is discarded
_stashOverlayForId(id, tile) {
  this._initOverlayHandoffMap();
  if (!tile || !tile._overlay) return;
  const cacheKey = tile._overlay.cacheKey;
  const entry = cacheKey ? this._overlayCache?.get(cacheKey) : tile._overlay.entry;
  const texture = entry?.texture || tile.grid?.mesh?.material?.map;
  if (!texture) return;

  this._overlayHandoff.set(id, {
    cacheKey: cacheKey || null,
    entry: entry || null,
    texture
  });

  // Auto-expire to avoid leaks if a new tile isn't created immediately
  if (this._overlayHandoffTimer) clearTimeout(this._overlayHandoffTimer);
  this._overlayHandoffTimer = setTimeout(() => this._overlayHandoff.clear(), 1500);
}

// Apply (and consume) a previously stashed overlay to a newly created tile
_applyOverlayHandoff(id, tile) {
  this._initOverlayHandoffMap();
  const hand = this._overlayHandoff.get(id);
  if (!hand || !tile || !tile.grid?.mesh) return false;

  // Mark overlay as "ready" on the new tile so _ensureTileOverlay() is a no-op
  tile._overlay = tile._overlay || {};
  tile._overlay.status = 'ready';
  tile._overlay.cacheKey = hand.cacheKey || tile._overlay.cacheKey || null;
  tile._overlay.entry = hand.entry || tile._overlay.entry || null;

  // Reuse the exact same texture object to avoid a visible change
  try {
    this._applyOverlayTexture(tile, hand.texture);
  } catch (e) {
    // Fallback: nothing fatal; let normal ensure path run later
    console.warn('[Tiles] overlay handoff failed, will re-ensure:', e);
    tile._overlay.status = 'pending';
  }

  this._overlayHandoff.delete(id);
  return true;
}

// Direct tile→tile handoff (used during promote where both tiles exist briefly)
_handoffOverlayBetweenTiles(fromTile, toTile) {
  if (!fromTile || !toTile) return false;
  const id = `${toTile.q},${toTile.r}`;
  // Prefer explicit cache entry; fall back to live material.map
  const cacheKey = fromTile._overlay?.cacheKey || null;
  const entry = cacheKey ? this._overlayCache?.get(cacheKey) : (fromTile._overlay?.entry || null);
  const texture = entry?.texture || fromTile.grid?.mesh?.material?.map;
  if (!texture) return false;

  toTile._overlay = toTile._overlay || {};
  toTile._overlay.status = 'ready';
  toTile._overlay.cacheKey = cacheKey;
  toTile._overlay.entry = entry || null;

  try {
    this._applyOverlayTexture(toTile, texture);
  } catch (e) {
    console.warn('[Tiles] direct overlay handoff failed:', e);
    toTile._overlay.status = 'pending';
    return false;
  }
  // Also stash for safety in case code later discards/creates again this tick
  this._stashOverlayForId(id, { _overlay: { cacheKey }, grid: { mesh: { material: { map: texture } } } });
  return true;
}



  // only locks the true rim (not the inner band), and uses a robust height sampler.
//
// - If the neighbor tile is visual/farfield: sample its mesh to define the straight edge.
// - If the neighbor is missing/unfetched: planarize to the straight line between OUR two corner tips.
// - Feather a short band inward so there are no kinks.
// - Lock ONLY the rim vertices so the relaxer won’t open cracks, but inner band can still smooth.

_stitchInteractiveToVisualEdges(tile, {
  bandRatio = 0.07,              // ~7% of radius inward is blended
  sideArc   = Math.PI / 10       // angular width considered "this side"
} = {}) {
  if (!tile || tile.type !== 'interactive') return;

  const pos  = tile.pos;
  const aR   = this.tileRadius;
  const base = tile.grid.group.position;
  const tips = this._selectCornerTipIndices(tile);
  if (!tips || tips.length < 6) return;

  // angular centers for the 6 sides (halfway between corners)
  const sideAng    = Array.from({ length: 6 }, (_, i) => (i + 0.5) * (Math.PI / 3));
  const RIM_STRICT = aR * 0.985;                                           // true outer rim
  const BAND_INNER = aR * (1 - Math.max(0.02, Math.min(0.2, bandRatio)));  // inner edge of blend band

  const newLocks = new Set();
  if (!tile.locked) tile.locked = new Uint8Array(pos.count);
  const lockArray = tile.locked;

  for (let s = 0; s < 6; s++) {
    // neighbor across side s
    const nq = tile.q + HEX_DIRS[s][0];
    const nr = tile.r + HEX_DIRS[s][1];
    const nTile = this._getTile(nq, nr);
    const neighborQuality = this._classifyNeighborDetailForSeam(nTile);

    // the two corner tips that bound side s
    const iA = tips[s];
    const iB = tips[(s + 1) % 6];
    if (iA == null || iB == null) continue;

    // world positions of those corner tips on THIS tile
    const Ax = base.x + pos.getX(iA), Az = base.z + pos.getZ(iA), Ay0 = pos.getY(iA);
    const Bx = base.x + pos.getX(iB), Bz = base.z + pos.getZ(iB), By0 = pos.getY(iB);

    // Determine authoritative heights along the shared edge:
    // - If neighbor exists and is non-interactive, sample it robustly.
    // - Otherwise (missing neighbor), fall back to our own corner heights (planarize).
    let Ay = Ay0, By = By0;
    if (nTile && nTile.type !== 'interactive') {
      const primaryMesh   = this._getMeshForTile(nTile);
      const neighborMeshes = []; // (hook for merged/adapter meshes if you have them)
      const nearestAttr    = nTile.grid?.geometry?.getAttribute?.('position');
      const aHit = this._robustSampleHeight(Ax, Az, primaryMesh, neighborMeshes, nearestAttr, Ay0);
      const bHit = this._robustSampleHeight(Bx, Bz, primaryMesh, neighborMeshes, nearestAttr, By0);
      if (Number.isFinite(aHit)) Ay = aHit;
      if (Number.isFinite(bHit)) By = bHit;
    }

    if (neighborQuality !== 'high') {
      const weight = neighborQuality === 'missing' ? 1.0 : 0.7;
      if (Number.isFinite(Ay)) {
        const curr = pos.getY(iA);
        const blended = curr + (Ay - curr) * weight;
        pos.setY(iA, blended);
        this._updateGlobalFromValue?.(blended);
        lockArray[iA] = 1;
        Ay = blended;
      }
      if (Number.isFinite(By)) {
        const curr = pos.getY(iB);
        const blended = curr + (By - curr) * weight;
        pos.setY(iB, blended);
        this._updateGlobalFromValue?.(blended);
        lockArray[iB] = 1;
        By = blended;
      }
    }

    // AB for projecting t along the edge segment
    const ABx = (Bx - Ax), ABz = (Bz - Az);
    const denom = ABx * ABx + ABz * ABz;
    if (denom < 1e-8) continue;

    // pass 1: snap the *rim* exactly to the straight line; collect inner-band verts to feather
    const bandIdx = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < BAND_INNER) continue; // only edge band and rim

      // Is this vertex aligned with side s by angle?
      const a = this._angleOf(x, z);
      const d = this._angDiff(a, sideAng[s]);
      if (d > sideArc) continue;

      const wx = base.x + x, wz = base.z + z;
      // param t along AB (0 at A, 1 at B)
      let t = ((wx - Ax) * ABx + (wz - Az) * ABz) / denom;
      if (!Number.isFinite(t)) t = 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;

      // straight-line height at this edge point
      const yLine = Ay + t * (By - Ay);

      if (r >= RIM_STRICT) {
        // true rim: snap exactly to straight line and keep it pinned
        pos.setY(i, yLine);
        lockArray[i] = 1;     // lock ONLY the rim
        newLocks.add(i);
      } else {
        // inside the rim: we’ll feather (do NOT lock inner band)
        bandIdx.push({ i, r, yLine });
      }
    }

    // pass 2: feather the inner band (smoothly blend original -> line as we approach the rim)
    if (bandIdx.length) {
      const span = Math.max(1e-4, aR - BAND_INNER);
      for (const { i, r, yLine } of bandIdx) {
        const y0 = pos.getY(i);
        let w = (r - BAND_INNER) / span;          // 0 at BAND_INNER, 1 at rim
        if (w < 0) w = 0; else if (w > 1) w = 1;
        w = w * w * (3 - 2 * w);                  // smoothstep
        pos.setY(i, y0 + (yLine - y0) * w);
        lockArray[i] = 1;
      }
    }
  }

  pos.needsUpdate = true;
  this._harmonizeCornerHeights(tile);

  // normals: compute fast on desktop; defer on mobile like elsewhere
  try {
    if (!this._isMobile) {
      tile.grid.geometry.computeVertexNormals();
    } else if (tile.grid?.geometry) {
      if (!tile._deferredNormalsUpdate) {
        tile._deferredNormalsUpdate = true;
        if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
        this._deferredNormalsTiles.add(tile);
      }
    }
  } catch {}

  // keep CPU buffers & color in sync for relax/coloring:
  this._pullGeometryToBuffers?.(tile);
  this._applyAllColorsGlobal?.(tile);

  // Update lock set: unlock any previous rim verts that are no longer part of this pass.
  if (!tile._visualEdgeLocks) tile._visualEdgeLocks = new Set();
  for (const idx of tile._visualEdgeLocks) {
    if (!newLocks.has(idx) && tile.locked) tile.locked[idx] = 0;
  }
  tile._visualEdgeLocks = newLocks;
}

// Robust sampler used above: unchanged in signature, but safe for missing meshes and provides
// a nearest-vertex fallback when raycasts miss (e.g., merged farfield or adapter quads).
_robustSampleHeight(wx, wz, primaryMesh, neighborMeshes, nearestGeomAttr, approx = this._lastHeight) {
  this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);

  if (primaryMesh) {
    const hit = this.ray.intersectObject(primaryMesh, true);
    if (hit && hit.length) return hit[0].point.y;
  }
  if (neighborMeshes && neighborMeshes.length) {
    for (let i = 0; i < neighborMeshes.length; i++) {
      const hit = this.ray.intersectObject(neighborMeshes[i], true);
      if (hit && hit.length) return hit[0].point.y;
    }
  }

  if (nearestGeomAttr?.isBufferAttribute) {
    let best = Infinity, bestY = approx;
    const arr = nearestGeomAttr.array;
    const px = (primaryMesh?.parent?.position.x || 0);
    const pz = (primaryMesh?.parent?.position.z || 0);
    for (let i = 0; i < arr.length; i += 3) {
      const dx = (arr[i]     + px) - wx;
      const dz = (arr[i + 2] + pz) - wz;
      const d2 = dx * dx + dz * dz;
      if (d2 < best) { best = d2; bestY = arr[i + 1]; }
    }
    return bestY;
  }

  return approx;
}

// When a neighbor is missing (not yet fetched), keep our shared side planar
// so there’s never a crack when the neighbor arrives later.
_planarizeEdgeWhenNeighborMissing(tile, {
  bandRatio = 0.06,        // ~6% of radius inward
  sideArc = Math.PI / 10   // angular width considered "this side"
} = {}) {
  if (!tile || !tile.pos) return;
  const pos = tile.pos;
  const aR = this.tileRadius;
  const base = tile.grid.group.position;

  // same side centers as in _stitchInteractiveToVisualEdges
  const sideAng = Array.from({ length: 6 }, (_, i) => (i + 0.5) * (Math.PI / 3));
  const RIM_STRICT = aR * 0.985;
  const BAND_INNER = aR * (1 - Math.max(0.02, Math.min(0.2, bandRatio)));

  const tips = this._selectCornerTipIndices?.(tile);
  if (!tips || tips.length < 6) return;
  if (!tile.locked) tile.locked = new Uint8Array(pos.count);
  const lockArray = tile.locked;

  for (let s = 0; s < 6; s++) {
    // neighbor across side s
    const nq = tile.q + (HEX_DIRS[s]?.[0] ?? 0);
    const nr = tile.r + (HEX_DIRS[s]?.[1] ?? 0);
    const nTile = this._getTile(nq, nr);

    // Only run this when neighbor doesn't exist yet
    if (nTile) continue;

    const iA = tips[s];
    const iB = tips[(s + 1) % 6];
    if (iA == null || iB == null) continue;

    // Use our own corner heights to define the straight edge
    const Ax = base.x + pos.getX(iA), Az = base.z + pos.getZ(iA), Ay = pos.getY(iA);
    const Bx = base.x + pos.getX(iB), Bz = base.z + pos.getZ(iB), By = pos.getY(iB);

    const ABx = (Bx - Ax), ABz = (Bz - Az);
    const denom = ABx * ABx + ABz * ABz; if (denom < 1e-8) continue;

    const bandIdx = [];

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < BAND_INNER) continue;

      // Is this vertex aligned with side s by angle?
      const a = this._angleOf(x, z);     // existing helper
      const d = this._angDiff(a, sideAng[s]);  // existing helper
      if (d > sideArc) continue;

      const wx = base.x + x, wz = base.z + z;
      let t = ((wx - Ax) * ABx + (wz - Az) * ABz) / denom;
      if (!Number.isFinite(t)) t = 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;

      const yLine = Ay + t * (By - Ay);

      if (r >= RIM_STRICT) {
        pos.setY(i, yLine);
        lockArray[i] = 1;  // keep edge flat until neighbor shows
      } else {
        bandIdx.push({ i, r, yLine });
      }
    }

    if (bandIdx.length) {
      const span = Math.max(1e-4, aR - BAND_INNER);
      for (const { i, r, yLine } of bandIdx) {
        const y0 = pos.getY(i);
        let w = (r - BAND_INNER) / span; // 0..1
        w = Math.max(0, Math.min(1, w));
        w = w * w * (3 - 2 * w); // smoothstep
        pos.setY(i, y0 + (yLine - y0) * w);
        lockArray[i] = 1;
      }
    }
  }

  pos.needsUpdate = true;
  this._harmonizeCornerHeights(tile);

  // Defer normals on mobile like elsewhere
  if (!this._isMobile) {
    try { tile.grid.geometry.computeVertexNormals(); } catch {}
  } else {
    if (!tile._deferredNormalsUpdate) {
      tile._deferredNormalsUpdate = true;
      if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
      this._deferredNormalsTiles.add(tile);
    }
  }

  // Keep CPU buffers & color in sync
  this._pullGeometryToBuffers?.(tile);
  this._applyAllColorsGlobal?.(tile);
}

  _restitchInteractiveNeighbors(q, r) {
    if (!Number.isFinite(q) || !Number.isFinite(r)) return;
    for (const [dq, dr] of HEX_DIRS) {
      const neighbor = this._getTile(q + dq, r + dr);
      if (!neighbor || neighbor.type !== 'interactive') continue;
      this._stitchInteractiveToVisualEdges(neighbor);
      this._planarizeEdgeWhenNeighborMissing(neighbor);
      this._harmonizeCornerHeights(neighbor);
    }
  }

  _markHorizonDirty() {
    this._horizonDirty = true;
    this._nextHorizonUpdate = 0;
  }

  _tileCornerPriority(tile) {
    if (!tile) return Infinity;
    if (tile.type === 'visual') return 0;
    if (tile.type === 'farfield') return 1;
    if (tile.type === 'interactive') {
      if (!tile._elevationFetched || !tile._phase?.fullDone) return 3;
      return 2;
    }
    return 4;
  }

  _findNearestCornerVertex(tile, wx, wz, epsilon = 0.25) {
    if (!tile || !tile.pos || !tile.grid?.group) return null;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const eps2 = epsilon * epsilon;
    let best = null;
    const tips = this._selectCornerTipIndices(tile);
    const indices = tips && tips.length ? tips : Array.from({ length: pos.count }, (_, i) => i);
    for (const idx of indices) {
      if (idx == null || idx < 0 || idx >= pos.count) continue;
      const vx = base.x + pos.getX(idx);
      const vz = base.z + pos.getZ(idx);
      const dx = vx - wx;
      const dz = vz - wz;
      const dist2 = dx * dx + dz * dz;
      if (dist2 <= eps2 && (!best || dist2 < best.dist2)) {
        best = { idx, height: pos.getY(idx), dist2 };
      }
    }
    return best;
  }

  _setWorldVertexHeight(tile, wx, wz, targetY, epsilon = 0.18, indices = null, touched = null) {
    if (!tile || !tile.pos || !tile.grid?.group) return false;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const eps2 = epsilon * epsilon;
    let updated = false;
    const iterator = Array.isArray(indices) && indices.length
      ? indices
      : Array.from({ length: pos.count }, (_, i) => i);
    for (const idx of iterator) {
      const vx = base.x + pos.getX(idx);
      const vz = base.z + pos.getZ(idx);
      const dx = vx - wx;
      const dz = vz - wz;
      if (dx * dx + dz * dz <= eps2) {
        pos.setY(idx, targetY);
        if (!tile.locked) tile.locked = new Uint8Array(pos.count);
        tile.locked[idx] = 1;
        updated = true;
      }
    }
    if (updated) {
      pos.needsUpdate = true;
      if (touched) touched.add(tile);
    }
    return updated;
  }

  _harmonizeCornerHeights(tile) {
    if (!tile || !tile.pos || !tile.grid?.group) return;
    const tips = this._selectCornerTipIndices(tile);
    if (!tips || tips.length < 6) return;
    const touched = new Set();
    const base = tile.grid.group.position;
    for (let s = 0; s < tips.length; s++) {
      const idx = tips[s];
      if (idx == null) continue;
      const wx = base.x + tile.pos.getX(idx);
      const wz = base.z + tile.pos.getZ(idx);
      const neighborA = this._getTile(tile.q + HEX_DIRS[s][0], tile.r + HEX_DIRS[s][1]);
      const neighborB = this._getTile(tile.q + HEX_DIRS[(s + 5) % 6][0], tile.r + HEX_DIRS[(s + 5) % 6][1]);
      const candidates = [tile, neighborA, neighborB].filter((t) => t && t.pos && t.grid?.group);

      let bestTile = null;
      let bestData = null;
      let bestPriority = Infinity;
      for (const candidate of candidates) {
        const vertex = this._findNearestCornerVertex(candidate, wx, wz, 0.28);
        if (!vertex) continue;
        const priority = this._tileCornerPriority(candidate);
        if (priority < bestPriority || (priority === bestPriority && vertex.dist2 < (bestData?.dist2 ?? Infinity))) {
          bestPriority = priority;
          bestTile = candidate;
          bestData = vertex;
        }
      }

      let targetHeight = bestData?.height;
      if (!Number.isFinite(targetHeight)) {
        targetHeight = this.getHeightAt(wx, wz);
      }
      if (!Number.isFinite(targetHeight)) continue;

      for (const candidate of candidates) {
        const eps = candidate.type === 'visual' ? 0.3 : 0.2;
        this._setWorldVertexHeight(candidate, wx, wz, targetHeight, eps, null, touched);
      }
    }
    for (const t of touched) {
      if (!t?.grid?.geometry) continue;
      try {
        if (!this._isMobile) t.grid.geometry.computeVertexNormals();
        else {
          if (!t._deferredNormalsUpdate) {
            t._deferredNormalsUpdate = true;
            if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
            this._deferredNormalsTiles.add(t);
          }
        }
      } catch { }
      this._pullGeometryToBuffers?.(t);
      this._applyAllColorsGlobal?.(t);
    }
  }

  _classifyNeighborDetailForSeam(tile) {
    if (!tile) return 'missing';
    if (tile.type !== 'interactive') return 'low';
    if (!tile._elevationFetched) return 'low';
    if (!tile._phase?.fullDone) return 'low';
    return 'high';
  }

  // tighter rim: only the true outermost ring
  _isRimVertex(tile, idx) {
    const x = tile.pos.getX(idx), z = tile.pos.getZ(idx);
    const r2 = x * x + z * z;
    const a = this.tileRadius;
    const rim = a * 0.985; // tighter than before: avoid grabbing near-rim neighbors
    return r2 >= rim * rim;
  }

  _angleOf(x, z) {
    let a = Math.atan2(z, x);
    if (a < 0) a += Math.PI * 2;
    return a; // [0, 2π)
  }
  _angDiff(a, b) {
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  /* ---------------- Movement prediction for tile preloading ---------------- */

  _updateVelocity(currentPos, deltaTime) {
    if (!this._lastPlayerPos) {
      this._lastPlayerPos = currentPos.clone();
      return;
    }

    // Calculate instantaneous velocity
    const displacement = new THREE.Vector3().subVectors(currentPos, this._lastPlayerPos);
    const speed = displacement.length();

    // Only track significant movement (> 0.1 m/frame to filter noise)
    if (speed > 0.1 && deltaTime > 0) {
      const velocity = displacement.divideScalar(deltaTime);

      // Add to history
      this._velocityHistory.push(velocity.clone());
      if (this._velocityHistory.length > this._velocityHistorySize) {
        this._velocityHistory.shift();
      }

      // Calculate smoothed velocity (average of recent history)
      if (this._velocityHistory.length > 0) {
        this._playerVelocity.set(0, 0, 0);
        for (const v of this._velocityHistory) {
          this._playerVelocity.add(v);
        }
        this._playerVelocity.divideScalar(this._velocityHistory.length);
      }
    }

    this._lastPlayerPos.copy(currentPos);
  }

  _predictivePreloadTiles(currentPos, q0, r0) {
    const speed = this._playerVelocity.length();

    // Only predict if moving faster than threshold
    if (speed < this.PREDICT_TILES_THRESHOLD) return;

    // Predict future position
    const futurePos = new THREE.Vector3()
      .copy(currentPos)
      .add(
        this._playerVelocity.clone().multiplyScalar(this.PREDICT_LOOKAHEAD_TIME)
      );

    // Convert future position to hex coordinates
    const a = this.tileRadius;
    const qf = (2 / 3 * futurePos.x) / a;
    const rf = ((-1 / 3 * futurePos.x) + (Math.sqrt(3) / 3 * futurePos.z)) / a;
    const futureQ = Math.round(qf);
    const futureR = Math.round(rf);

    // Calculate direction vector in hex space
    const dq = futureQ - q0;
    const dr = futureR - r0;
    const hexDist = Math.abs(dq) + Math.abs(dr) + Math.abs(-dq - dr);

    // Only preload if we're predicting movement to a different tile
    if (hexDist === 0) return;

    // Preload tiles in the direction of movement (visual ring only for efficiency)
    const preloadRadius = Math.min(2, this.VISUAL_RING);
    let preloaded = 0;
    const maxPreload = 6; // Limit to 6 tiles to avoid overwhelming the system

    for (let d = 1; d <= preloadRadius; d++) {
      for (let s = 0; s < 6; s++) {
        if (preloaded >= maxPreload) break;

        // Calculate tile position in direction of movement
        const q = futureQ + Math.round(dq * d / Math.max(1, hexDist));
        const r = futureR + Math.round(dr * d / Math.max(1, hexDist));

        const id = `${q},${r}`;
        const tile = this.tiles.get(id);

        // Preload if tile doesn't exist or needs population
        if (!tile) {
          const dist = this._hexDist(q, r, q0, r0);
          if (dist <= this.VISUAL_RING && dist > this.INTERACTIVE_RING) {
            this._addVisualTile(q, r);
            preloaded++;
          }
        } else if (tile.type === 'visual' || tile.type === 'interactive') {
          this._queuePopulateIfNeeded?.(tile, false);
        }
      }
    }
  }

  _getTerrainMaterial() {
    if (!this._terrainMat) {
      this._terrainMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.BackSide,  // CHANGED: DoubleSide to receive shadows properly
        metalness: 0.005,
        roughness: 0.85,
        receiveShadow: true,
      });
    }
    return this._terrainMat;
  }
  addHeightListener(fn) {
    if (typeof fn !== 'function') return () => { };
    this._heightListeners.add(fn);
    return () => this._heightListeners.delete(fn);
  }
  removeHeightListener(fn) {
    if (!fn) return;
    this._heightListeners.delete(fn);
  }
  _notifyHeightListeners(tile, idx, wx, wy, wz) {
    if (!this._heightListeners || !this._heightListeners.size) return;
    const payload = {
      tile,
      index: idx,
      world: { x: wx, y: wy, z: wz },
      type: tile?.type || null,
    };
    for (const listener of this._heightListeners) {
      try { listener(payload); } catch { /* ignore listener error */ }
    }
  }

  _notifyHeightListenersBatch(tile, samples) {
    // CRITICAL: Batch notification to prevent RAF flooding during NKN connect
    // Fire listeners ONCE per tile instead of once per sample
    if (!this._heightListeners || !this._heightListeners.size) return;
    if (!samples || !samples.length) return;

    // Use first sample as representative (listeners like tree resnap work per-tile anyway)
    const firstSample = samples[0];
    const payload = {
      tile,
      index: firstSample.idx,
      world: { x: firstSample.wx, y: firstSample.wy, z: firstSample.wz },
      type: tile?.type || null,
      batchSize: samples.length, // signal this is a batch update
    };

    for (const listener of this._heightListeners) {
      try { listener(payload); } catch { /* ignore listener error */ }
    }
  }
  _getFarfieldMaterial() {
    if (!this._farfieldMat) {
      this._farfieldMat = this._getTerrainMaterial().clone();
      this._farfieldMat.side = THREE.DoubleSide;
      this._farfieldMat.polygonOffset = true;
      this._farfieldMat.polygonOffsetFactor = 1;
      this._farfieldMat.polygonOffsetUnits = 2;
      this._farfieldMat.name = 'TileFarfieldMaterial';
      this._farfieldMat.needsUpdate = true;
    }
    return this._farfieldMat;
  }
  _applyTerrainMaterial(mesh) {
    if (!mesh) return;
    const mat = this._getTerrainMaterial();
    try { mesh.material?.dispose?.(); } catch { }
    mesh.material = mat;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
  }
  // classify outer ring into 6 sides and 6 corners (by angle & radius)
  _classifyRimAndCorners(tile) {
    const pos = tile.pos;
    const aR = this.tileRadius;
    const RIM_MIN = aR * 0.972;     // outer band
    const CORNER_MIN = aR * 0.985;  // the very tips
    const CORNER_ARC = Math.PI / 15; // ~12°
    const SIDE_ARC = Math.PI / 12;   // classify to nearest side direction

    // corner directions at 0,60,120...
    const cornerAng = Array.from({ length: 6 }, (_, i) => i * (Math.PI / 3));
    // side directions halfway between corners (30°, 90°, ...)
    const sideAng = Array.from({ length: 6 }, (_, i) => (i + 0.5) * (Math.PI / 3));

    const sides = Array.from({ length: 6 }, () => []);
    const corners = Array.from({ length: 6 }, () => []);
    const rim = [];

    // inner band near corners (helps prevent folding right behind the tip)
    const innerCornerBand = new Set();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < RIM_MIN) {
        // mark inner band around corners
        if (r >= aR * 0.92) {
          const a = this._angleOf(x, z);
          for (let c = 0; c < 6; c++) {
            if (this._angDiff(a, cornerAng[c]) < CORNER_ARC) {
              innerCornerBand.add(i);
              break;
            }
          }
        }
        continue;
      }
      rim.push(i);

      const a = this._angleOf(x, z);
      // corner?
      let isCorner = false;
      if (r >= CORNER_MIN) {
        for (let c = 0; c < 6; c++) {
          if (this._angDiff(a, cornerAng[c]) < CORNER_ARC) {
            corners[c].push(i);
            isCorner = true;
            break;
          }
        }
      }
      if (isCorner) continue;

      // otherwise side: pick nearest side direction
      let best = 0, bestD = Infinity;
      for (let s = 0; s < 6; s++) {
        const d = this._angDiff(a, sideAng[s]);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (bestD < SIDE_ARC) sides[best].push(i);
      else {
        // fallback: still treat as side using nearest
        sides[best].push(i);
      }
    }

    return { rim, sides, corners, innerCornerBand };
  }

  /* ---------- adjacency & buffers (interactive) ---------- */

  _buildAdjacency(indexAttr, vertCount) {
    const idx = indexAttr.array;
    const adj = Array.from({ length: vertCount }, () => new Set());
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      adj[a].add(b); adj[a].add(c);
      adj[b].add(a); adj[b].add(c);
      adj[c].add(a); adj[c].add(b);
    }
    return adj;
  }
  _ensureTileBuffers(tile) {
    const n = tile.pos.count;
    if (!tile.yA || tile.yA.length !== n) {
      tile.yA = new Float32Array(n);
      tile.yB = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const y = tile.pos.getY(i);
        tile.yA[i] = y; tile.yB[i] = y;
      }
    }
    // ensure lock mask
    if (!tile.locked || tile.locked.length !== n) {
      tile.locked = new Uint8Array(n); // 1 => pinned (do not relax/smooth)
    }
  }
  _relaxOnce(tile) {
    if (tile.type !== 'interactive') return false;
    if (tile.relaxEnabled !== true) return false;
    if (tile.fetched.size === 0) return false;
    if (typeof tile.unreadyCount !== 'number') tile.unreadyCount = tile.pos.count;
    if (tile.unreadyCount === 0) return false;

    const ready = tile.ready;
    const locked = tile.locked || new Uint8Array(tile.pos.count);
    const adj = tile.neighbors;
    const read = tile.flip ? tile.yB : tile.yA;
    const write = tile.flip ? tile.yA : tile.yB;
    const alpha = this.RELAX_ALPHA;

    for (let i = 0; i < tile.pos.count; i++) {
      if (ready[i] || locked[i]) { write[i] = read[i]; continue; }
      let sum = 0, cnt = 0;
      for (const j of adj[i]) { sum += read[j]; cnt++; }
      write[i] = (cnt > 0) ? read[i] + (sum / cnt - read[i]) * alpha : read[i];
    }
    tile.flip = !tile.flip;
    return true;
  }
  _pushBuffersToGeometry(tile) {
    if (tile.type !== 'interactive') return;
    const cur = tile.flip ? tile.yB : tile.yA;
    const pos = tile.pos;
    for (let i = 0; i < pos.count; i++) pos.setY(i, cur[i]);
    pos.needsUpdate = true;

    tile.normTick = (tile.normTick + 1) % this.NORMALS_EVERY;
    if (tile.normTick === 0) {
      // CRITICAL: Defer expensive computeVertexNormals to reduce GPU sync stalls
      // Only recompute if there's been significant height changes
      if (tile.type !== 'farfield') {
        if (!tile._deferredNormalsUpdate) {
          tile._deferredNormalsUpdate = true;
          // Queue for batch processing instead of immediate compute
          if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
          this._deferredNormalsTiles.add(tile);
        }
      }
      this._applyAllColorsGlobal(tile);
    }
  }
  _pullGeometryToBuffers(tile, onlyChangedIndex = -1) {
    if (tile.type !== 'interactive') return;
    const tgt = tile.flip ? tile.yB : tile.yA;
    const alt = tile.flip ? tile.yA : tile.yB;
    if (onlyChangedIndex >= 0) {
      const y = tile.pos.getY(onlyChangedIndex);
      tgt[onlyChangedIndex] = y; alt[onlyChangedIndex] = y;
    } else {
      for (let i = 0; i < tile.pos.count; i++) {
        const y = tile.pos.getY(i); tgt[i] = y; alt[i] = y;
      }
    }
  }

  _farfieldTierForDist(dist) {
    // OPTIMIZED: Removed padding rings (was +6 rings at full res)
    // Now use edge subdivision for seamless transition
    if (dist <= this.VISUAL_RING + 1) return { stride: 1, scale: 2, samples: 'all', minPrec: 6, subdivideEdges: true };
    if (dist <= this.VISUAL_RING + 24) return { stride: 2, scale: 2, samples: 'tips', minPrec: 5 };
    if (dist <= this.VISUAL_RING + 128) return { stride: 6, scale: 4, samples: 'tips', minPrec: 4 };
    if (dist <= this.VISUAL_RING + 384) return { stride: 12, scale: 8, samples: 'tips', minPrec: 3 };
    return { stride: 24, scale: 12, samples: 'center', minPrec: 3 }; // keep corners so seams match
  }
  _sealFarfieldCornersAgainstNeighbors(tile) {
    if (!tile || tile.type !== 'farfield') return;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const neighborMeshes = this._gatherNeighborMeshes(tile.q, tile.r); // includes visual/interactive nearby

    if (!neighborMeshes.length) return;

    // corners are indices 1..6
    for (let i = 1; i <= 6; i++) {
      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);
      this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
      const hits = this.ray.intersectObjects(neighborMeshes, true);
      if (hits && hits.length) {
        // take the first (nearest) for determinism
        const y = hits[0].point.y;
        if (Number.isFinite(y)) pos.setY(i, y);
      }
    }

    pos.needsUpdate = true;
    this._markFarfieldAdapterDirty(tile);
    // CRITICAL: Skip expensive normal computation on mobile
    if (!this._isMobile) {
      try { tile.grid.geometry.computeVertexNormals(); } catch { }
    }
  }

  /* ---------------- Edge subdivision for seamless farfield transitions ---------------- */

  _subdivideInterfaceEdges(tile) {
    if (!tile || tile.type !== 'farfield') return;
    if (!tile._subdivideEdges) return; // Only for tiles flagged for subdivision

    const dist = this._hexDist(tile.q, tile.r, 0, 0);
    if (dist !== this.VISUAL_RING + 1) return; // Only first farfield ring

    // Find which sides interface with visual tiles
    const interfaceSides = [];
    for (let s = 0; s < 6; s++) {
      const nq = tile.q + HEX_DIRS[s][0];
      const nr = tile.r + HEX_DIRS[s][1];
      const nTile = this._getTile(nq, nr);
      if (nTile && (nTile.type === 'visual' || nTile.type === 'interactive')) {
        interfaceSides.push({ side: s, neighbor: nTile });
      }
    }

    if (!interfaceSides.length) return;

    // For each interface side, refine the edge band
    for (const { side, neighbor } of interfaceSides) {
      this._refineEdgeBand(tile, side, neighbor, {
        bandRatio: 0.25           // Refine outer 25% of tile radius
      });
    }
  }

  _refineEdgeBand(tile, side, neighbor, { bandRatio = 0.25 }) {
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const aR = this.tileRadius;
    const innerBand = aR * (1 - bandRatio);
    const nMesh = this._getMeshForTile(neighbor);

    if (!nMesh) return;

    // Get the two corner vertices for this side
    const cornerA = side + 1;
    const cornerB = ((side + 1) % 6) + 1;

    const Ax = pos.getX(cornerA), Az = pos.getZ(cornerA);
    const Bx = pos.getX(cornerB), Bz = pos.getZ(cornerB);

    // Sample heights from neighbor at corners
    let Ay = this._robustSampleHeightFromMesh(nMesh, base.x + Ax, base.z + Az);
    let By = this._robustSampleHeightFromMesh(nMesh, base.x + Bx, base.z + Bz);

    if (!Number.isFinite(Ay)) Ay = pos.getY(cornerA);
    if (!Number.isFinite(By)) By = pos.getY(cornerB);

    // Update corner heights to match neighbor
    pos.setY(cornerA, Ay);
    pos.setY(cornerB, By);

    // Find all vertices in the edge band for this side and blend their heights
    const sideAngle = (side + 0.5) * (Math.PI / 3);
    const sideArc = Math.PI / 10;

    for (let i = 0; i < pos.count; i++) {
      if (i === 0 || i === cornerA || i === cornerB) continue; // Skip center and corners

      const x = pos.getX(i);
      const z = pos.getZ(i);
      const r = Math.hypot(x, z);

      if (r < innerBand) continue; // Only process edge band

      // Check if this vertex is on this side
      const angle = this._angleOf(x, z);
      const angleDiff = this._angDiff(angle, sideAngle);
      if (angleDiff > sideArc) continue;

      // Sample height from neighbor at this position
      const wx = base.x + x;
      const wz = base.z + z;
      let neighborHeight = this._robustSampleHeightFromMesh(nMesh, wx, wz);

      if (Number.isFinite(neighborHeight)) {
        // Blend between tile's original height and neighbor's height
        const blendWeight = (r - innerBand) / (aR - innerBand);
        const smoothWeight = blendWeight * blendWeight * (3 - 2 * blendWeight); // Smoothstep
        const originalHeight = pos.getY(i);
        const blendedHeight = originalHeight + (neighborHeight - originalHeight) * smoothWeight;
        pos.setY(i, blendedHeight);
      }
    }

    pos.needsUpdate = true;
    // CRITICAL: Skip expensive normal computation on mobile
    if (!this._isMobile) {
      try { tile.grid.geometry.computeVertexNormals(); } catch { }
    }
  }

  _robustSampleHeightFromMesh(mesh, wx, wz) {
    if (!mesh) return null;
    this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
    const hits = this.ray.intersectObject(mesh, true);
    if (hits && hits.length > 0) {
      return hits[0].point.y;
    }
    return null;
  }

  // JS % is weird for negatives; normalize
  _divisible(n, k) { n = Math.round(n); k = Math.max(1, Math.round(k)); return ((n % k) + k) % k === 0; }
  _barycentric2D(p, a, b, c) {
    const v0x = b.x - a.x;
    const v0z = b.z - a.z;
    const v1x = c.x - a.x;
    const v1z = c.z - a.z;
    const v2x = p.x - a.x;
    const v2z = p.z - a.z;
    const denom = v0x * v1z - v1x * v0z;
    if (Math.abs(denom) < 1e-6) return null;
    const inv = 1 / denom;
    const v = (v2x * v1z - v1x * v2z) * inv;
    const w = (v0x * v2z - v2x * v0z) * inv;
    const u = 1 - v - w;
    return { u, v, w };
  }
  _approxTileHeight(tile, x, z) {
    if (!tile || !tile.pos) return 0;
    const pos = tile.pos;
    const center = { x: pos.getX(0), y: pos.getY(0), z: pos.getZ(0) };
    const target = { x, z };
    for (let i = 1; i <= 6; i++) {
      const j = (i === 6) ? 1 : i + 1;
      const b = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) };
      const c = { x: pos.getX(j), y: pos.getY(j), z: pos.getZ(j) };
      const bary = this._barycentric2D(target, center, b, c);
      if (!bary) continue;
      const { u, v, w } = bary;
      if (u >= -1e-4 && v >= -1e-4 && w >= -1e-4) {
        return u * center.y + v * b.y + w * c.y;
      }
    }
    return Number.isFinite(center.y) ? center.y : 0;
  }
  _farfieldAdapterKey(tile) {
    if (!tile) return null;
    return `${tile.q},${tile.r}`;
  }
  _markFarfieldAdapterDirty(tile) {
    if (!tile || tile.type !== 'farfield') return;
    tile._adapterDirty = true;
    const key = this._farfieldAdapterKey(tile);
    if (key) this._farfieldAdapterDirty.add(key);
    this._markFarfieldMergeDirty(tile);
  }

  _markFarfieldMergeDirty(tile = null) {
    if (!this._farfieldMerge) return;
    const t = (typeof now === 'function') ? now() : Date.now();
    const debounce = Math.max(30, this._farfieldMerge.debounceMs || 0);
    this._farfieldMerge.dirty = true;
    this._farfieldMerge.nextBuild = t + debounce;
    if (tile) tile._mergedDirty = true;
    this._markHorizonDirty();
  }

  _disposeFarfieldMergedMesh() {
    if (!this._farfieldMerge?.mesh) return;
    try {
      this.scene.remove(this._farfieldMerge.mesh);
      this._farfieldMerge.mesh.geometry?.dispose?.();
    } catch { }
    this._farfieldMerge.mesh = null;
    this._farfieldMerge.dirty = false;
    this._farfieldMerge.nextBuild = 0;
    this._farfieldMerge.lastBuildCount = 0;
    this._restoreFarfieldTileVisibility();
    this._markHorizonDirty();
  }

  _updateFarfieldMergedMesh({ force = false } = {}) {
    if (!this._farfieldMerge) return;
    const state = this._farfieldMerge;
    const tNow = (typeof now === 'function') ? now() : Date.now();

    // When overlay is on, kill the merged mesh and ensure per-tile farfield are visible
    if (this._overlayEnabled) {
      if (state.mesh) this._disposeFarfieldMergedMesh();
      // Make sure individual farfield tiles are visible (and any overlay rings can be hidden elsewhere)
      for (const tile of this.tiles.values()) {
        if (tile && tile.type === 'farfield' && tile.grid?.group) {
          tile.grid.group.visible = true;
        }
      }
      state.dirty = false;
      state.lastBuildTime = tNow;
      return;
    }

    if (!force) {
      if (!state.dirty) return;
      if (tNow < (state.nextBuild || 0)) return;
    }

    // --- PREVENT TRANSIENT DOUBLE-DRAW (pre-hide per-tile groups) ---
    const preHiddenFarTiles = [];
    {
      for (const t of this.tiles.values()) {
        if (t && t.type === 'farfield' && t.grid?.group && t.grid.group.visible) {
          t.grid.group.visible = false;
          preHiddenFarTiles.push(t);
        }
      }
    }

    const geometries = [];
    const farTiles = [];
    const attributeMeta = new Map();

    const recordAttribute = (name, attribute) => {
      if (!attribute) return;
      if (!attributeMeta.has(name)) {
        attributeMeta.set(name, {
          itemSize: attribute.itemSize || 1,
          normalized: attribute.normalized || false,
          arrayType: attribute.array?.constructor || Float32Array
        });
      }
    };

    for (const tile of this.tiles.values()) {
      if (!tile || tile.type !== 'farfield') continue;
      const geom = tile.grid?.geometry;
      const group = tile.grid?.group;
      if (!geom || !group) continue;

      group.updateMatrixWorld(true);
      const clone = geom.clone();
      clone.applyMatrix4(group.matrixWorld);

      const attributes = clone.attributes || clone.getAttributes?.() || {};
      for (const name in attributes) recordAttribute(name, attributes[name]);
      recordAttribute('normal', attributes.normal);
      recordAttribute('color', attributes.color);
      recordAttribute('uv', attributes.uv);

      geometries.push(clone);
      farTiles.push(tile);
    }

    if (!geometries.length) {
      // Nothing to merge: restore pre-hidden tiles and dispose merged
      for (const t of preHiddenFarTiles) if (t.grid?.group) t.grid.group.visible = true;
      this._disposeFarfieldMergedMesh();
      state.dirty = false;
      state.lastBuildTime = tNow;
      return;
    }

    const attributeNames = Array.from(attributeMeta.keys()).filter((name) => name !== 'position');
    for (const clone of geometries) {
      const position = clone.getAttribute('position');
      const count = position ? position.count : 0;
      for (const name of attributeNames) {
        if (clone.getAttribute(name)) continue;
        const meta = attributeMeta.get(name);
        if (!meta || !count) continue;

        const ArrayType = meta.arrayType || Float32Array;
        const array = new ArrayType(count * meta.itemSize);

        if (name === 'color') {
          for (let i = 0; i < count; i++) {
            const idx = i * meta.itemSize;
            array[idx] = 1;
            if (meta.itemSize > 1) array[idx + 1] = 1;
            if (meta.itemSize > 2) array[idx + 2] = 1;
          }
        } else if (name === 'normal') {
          for (let i = 0; i < count; i++) {
            const idx = i * meta.itemSize;
            array[idx] = 0;
            if (meta.itemSize > 1) array[idx + 1] = 1;
            if (meta.itemSize > 2) array[idx + 2] = 0;
          }
        }

        const attr = new THREE.BufferAttribute(array, meta.itemSize, meta.normalized);
        clone.setAttribute(name, attr);
      }
    }

    let merged = null;
    try {
      merged = mergeGeometries(geometries, false);
      if (merged) merged.computeVertexNormals();
    } catch (err) {
      console.warn('[tiles] farfield merge failed, falling back to individual tiles', err);
      merged = null;
    }
    for (const g of geometries) g.dispose?.();

    if (!merged) {
      // Merge failed: restore pre-hidden tiles and dispose merged
      for (const t of preHiddenFarTiles) if (t.grid?.group) t.grid.group.visible = true;
      this._disposeFarfieldMergedMesh();
      state.dirty = false;
      state.lastBuildTime = tNow;
      return;
    }

    const material = this._getFarfieldMaterial();
    let mesh = state.mesh;
    if (!mesh) {
      mesh = new THREE.Mesh(merged, material);
      mesh.name = 'tile-farfield-merged';
      mesh.frustumCulled = false;
      mesh.renderOrder = -12;
      mesh.matrixAutoUpdate = false;
      mesh.layers.enable(0);
      mesh.updateMatrix();
      this.scene.add(mesh);
      state.mesh = mesh;
    } else {
      mesh.geometry?.dispose?.();
      mesh.geometry = merged;
      if (mesh.material !== material) mesh.material = material;
      mesh.layers.enable(0);
      mesh.visible = true;
      mesh.updateMatrix();
    }

    // Keep per-tile farfield hidden while the merged mesh is active
    for (const tile of farTiles) {
      tile._mergedDirty = false;
      if (tile.grid?.group) tile.grid.group.visible = false;
    }

    state.dirty = false;
    state.lastBuildTime = tNow;
    state.lastBuildCount = farTiles.length;
    this._markHorizonDirty();
  }

  _restoreFarfieldTileVisibility() {
    // Restore visibility of individual farfield tiles when merged mesh is removed
    for (const tile of this.tiles.values()) {
      if (tile && tile.type === 'farfield' && tile.grid?.group) {
        tile.grid.group.visible = true;
      }
    }
  }
  _resetFarfieldTileState(tile) {
    if (!tile || tile.type !== 'farfield') return;
    if (tile.ready) tile.ready.fill(0);
    tile.unreadyCount = tile.pos?.count ?? 0;
    if (tile.fetched) tile.fetched.clear();
    tile.populating = false;
    tile._fetchedEver = false;
    this._ensureRoadMask(tile, { reset: true });
    if (this._roadStamps.length) this._applyExistingRoadStampsToTile(tile);
    else this._applyAllColorsGlobal(tile);
  }
  _fallbackFarfieldTile(tile) {
    if (!tile || tile.type !== 'farfield') return false;
    const currentMode = tile._farSampleMode || 'all';
    if (currentMode !== 'all') {
      tile._farSampleMode = 'all';
      this._resetFarfieldTileState(tile);
      this._queuePopulatePhase(tile, PHASE_FULL, true);
      return true;
    }
    const scale = Math.max(1, Math.round(tile.scale || 1));
    if (scale > 1) {
      const id = `${tile.q},${tile.r}`;
      const minPrec = Math.max(5, tile._farMinPrec || 5);
      this._discardTile(id);
      const t = this._addFarfieldTile(tile.q, tile.r, 1, 'all');
      t._farMinPrec = minPrec;
      this._queuePopulateIfNeeded(t, true);
      return true;
    }
    return false;
  }
  _ensureFarfieldAdapter(tile) {
    if (!tile || tile.type !== 'farfield') return;
    const segments = Math.max(3, Math.round(this.FARFIELD_ADAPTER_SEGMENTS || 6));
    const outerCount = segments * 6;
    const vertexCount = outerCount * 2;

    const needRebuild =
      !tile._adapter ||
      tile._adapter.segments !== segments ||
      !tile._adapter.posAttr ||
      tile._adapter.posAttr.count !== vertexCount;

    if (needRebuild) {
      if (tile._adapter?.mesh) {
        try {
          tile.grid.group.remove(tile._adapter.mesh);
          tile._adapter.mesh.geometry?.dispose?.();
        } catch { /* noop */ }
      }

      const geom = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const colAttr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute('position', posAttr);
      geom.setAttribute('color', colAttr);

      const idx = [];
      for (let i = 0; i < outerCount; i++) {
        const next = (i + 1) % outerCount;
        const apex = outerCount + i;
        const apexNext = outerCount + next;
        idx.push(i, next, apex);
        idx.push(next, apexNext, apex);
      }
      geom.setIndex(idx);

      const mesh = new THREE.Mesh(geom, this._getFarfieldMaterial());
      mesh.frustumCulled = false;
      mesh.renderOrder = tile.grid.mesh ? tile.grid.mesh.renderOrder - 1 : -5;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      tile.grid.group.add(mesh);

      const cArr = colAttr.array;
      for (let i = 0; i < cArr.length; i += 3) {
        cArr[i] = cArr[i + 1] = cArr[i + 2] = 0.22;
      }
      colAttr.needsUpdate = true;

      tile._adapter = { mesh, geometry: geom, posAttr, colAttr, segments, outerCount };
    }

    tile._adapterDirty = true;
    this._updateFarfieldAdapter(tile);
    tile._adapterDirty = false;
    const key = this._farfieldAdapterKey(tile);
    if (key) this._farfieldAdapterDirty.delete(key);
  }
  _updateFarfieldAdapter(tile) {
    const adapter = tile?._adapter;
    if (!adapter) return;
    const posAttr = adapter.posAttr;
    const colAttr = adapter.colAttr;
    const segments = adapter.segments || Math.max(3, Math.round(this.FARFIELD_ADAPTER_SEGMENTS || 6));
    const outerCount = adapter.outerCount || segments * 6;
    const base = tile.grid.group.position;
    const innerRadius = this.tileRadius * FARFIELD_ADAPTER_INNER_RATIO;

    const neighborMeshes = [];
    for (const [dq, dr] of HEX_DIRS) {
      const n = this._getTile(tile.q + dq, tile.r + dr);
      if (!n || n.type === 'farfield') continue;
      const mesh = this._getMeshForTile(n);
      if (mesh) neighborMeshes.push(mesh);
    }

    const sampleNeighborHeight = (wx, wz, fallback) => {
      if (neighborMeshes.length) {
        this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
        const hits = this.ray.intersectObjects(neighborMeshes, true);
        if (hits && hits.length) {
          const y = hits[0]?.point?.y;
          if (Number.isFinite(y)) return y;
        }
      }
      return fallback;
    };

    const setColor = (idx, lum) => {
      const o = idx * 3;
      colAttr.array[o] = colAttr.array[o + 1] = colAttr.array[o + 2] = lum;
    };

    const outerVertices = [];
    const corners = this._hexCorners(this.tileRadius);
    let idx = 0;
    const outerLum = this.LUM_MAX;

    for (let s = 0; s < 6; s++) {
      const a = corners[s];
      const b = corners[(s + 1) % 6];
      for (let k = 0; k <= segments; k++) {
        if (s > 0 && k === 0) continue; // skip duplicate corner
        if (s === 5 && k === segments) continue; // avoid wrapping duplicate
        const t = k / segments;
        const lx = a.x + (b.x - a.x) * t;
        const lz = a.z + (b.z - a.z) * t;
        const wx = base.x + lx;
        const wz = base.z + lz;
        let height = sampleNeighborHeight(wx, wz, this._approxTileHeight(tile, lx, lz));
        if (!Number.isFinite(height)) height = this._approxTileHeight(tile, lx, lz);
        posAttr.setXYZ(idx, lx, height, lz);
        setColor(idx, outerLum);
        outerVertices[idx] = { x: lx, z: lz, y: height };
        idx++;
      }
    }

    const maxShiftFactor = Math.max(1e-3, this.tileRadius - innerRadius);

    for (let i = 0; i < outerCount; i++) {
      const next = (i + 1) % outerCount;
      const curr = outerVertices[i];
      const nxt = outerVertices[next];
      const edgeX = nxt.x - curr.x;
      const edgeZ = nxt.z - curr.z;
      const baseLen = Math.hypot(edgeX, edgeZ);
      if (baseLen < 1e-6) {
        posAttr.setXYZ(outerCount + i, curr.x, curr.y, curr.z);
        setColor(outerCount + i, this.LUM_MIN);
        continue;
      }

      const midX = (curr.x + nxt.x) * 0.5;
      const midZ = (curr.z + nxt.z) * 0.5;

      let normalX = -edgeZ / baseLen;
      let normalZ = edgeX / baseLen;
      const toCenterDot = midX * normalX + midZ * normalZ;
      if (toCenterDot < 0) {
        normalX *= -1;
        normalZ *= -1;
      }

      let desiredShift = baseLen * EQ_TRI_ALTITUDE_SCALE;
      const midRadius = Math.hypot(midX, midZ);
      const maxShift = Math.max(0, midRadius - innerRadius);
      if (maxShift <= 1e-4) {
        desiredShift = Math.min(desiredShift, maxShiftFactor * 0.25);
      } else {
        desiredShift = Math.min(desiredShift, maxShift);
      }

      const innerX = midX - normalX * desiredShift;
      const innerZ = midZ - normalZ * desiredShift;
      const wx = base.x + innerX;
      const wz = base.z + innerZ;

      const farfieldHeight = this._approxTileHeight(tile, innerX, innerZ);
      const neighborHeight = sampleNeighborHeight(wx, wz, farfieldHeight);
      const blend = maxShift > 1e-4 ? THREE.MathUtils.clamp(desiredShift / maxShift, 0, 1) : 1;
      const smoothBlend = THREE.MathUtils.smoothstep(0, 1, blend);
      const innerY = THREE.MathUtils.lerp(neighborHeight, farfieldHeight, smoothBlend);

      posAttr.setXYZ(outerCount + i, innerX, innerY, innerZ);
      const innerLum = THREE.MathUtils.lerp(outerLum, this.LUM_MIN, smoothBlend);
      setColor(outerCount + i, innerLum);
    }

    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    try { adapter.geometry.computeVertexNormals(); } catch { }
  }
  _refreshFarfieldAdapters(q0, r0) {
    if (!this._farfieldAdapterDirty.size) return;
    const seamMax = this.VISUAL_RING + 4;
    const budget = Math.max(1, Math.floor(this.FARFIELD_CREATE_BUDGET * 0.1) || 3);
    let processed = 0;
    for (const key of Array.from(this._farfieldAdapterDirty)) {
      if (processed >= budget) break;
      const tile = this.tiles.get(key);
      if (!tile || tile.type !== 'farfield') {
        this._farfieldAdapterDirty.delete(key);
        continue;
      }
      const dist = this._hexDist(tile.q, tile.r, q0, r0);
      if (dist < this.VISUAL_RING || dist > seamMax) {
        tile._adapterDirty = false;
        this._farfieldAdapterDirty.delete(key);
        continue;
      }
      if (!tile._adapter) this._ensureFarfieldAdapter(tile);
      else {
        this._updateFarfieldAdapter(tile);
        tile._adapterDirty = false;
        this._farfieldAdapterDirty.delete(key);
      }
      processed++;
    }
  }

  _computeFarfieldOuterRadius() {
    let maxRadius = this.tileRadius * (this.FARFIELD_RING + 1);
    for (const tile of this.tiles.values()) {
      if (!tile || tile.type !== 'farfield') continue;
      const center = this._axialWorld(tile.q, tile.r);
      const tileRadius = Number.isFinite(tile._radiusOverride)
        ? tile._radiusOverride
        : this.tileRadius * Math.max(1, tile.scale || 1);
      const dist = Math.hypot(center.x, center.z) + tileRadius;
      if (dist > maxRadius) maxRadius = dist;
    }
    return maxRadius;
  }

  _sampleHorizonHeight(x, z, fallback = this._lastHeight) {
    const mergeMesh = this._farfieldMerge?.mesh;
    if (mergeMesh) {
      const origin = this._tmpHorizonVec.set(x, 100000, z);
      this.ray.set(origin, this.DOWN);
      const hits = this.ray.intersectObject(mergeMesh, true);
      if (hits && hits.length) {
        const y = hits[0]?.point?.y;
        if (Number.isFinite(y)) return y;
      }
    }
    const h = this.getHeightAt(x, z);
    if (Number.isFinite(h)) return h;
    return fallback;
  }

  _initHorizonField() {
    if (this._horizonField || !this.scene) return;
    const segments = Math.max(12, Math.round(this.HORIZON_SEGMENTS || 48));
    const radialSteps = Math.max(2, Math.round(this.HORIZON_RADIAL_STEPS || 3));
    const vertCount = segments * radialSteps;

    const geom = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
    const uvAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 2), 2).setUsage(THREE.DynamicDrawUsage);
    const colAttr = new THREE.BufferAttribute(new Float32Array(vertCount * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geom.setAttribute('position', posAttr);
    geom.setAttribute('uv', uvAttr);
    geom.setAttribute('color', colAttr);

    const indices = [];
    for (let r = 0; r < radialSteps - 1; r++) {
      const ringStart = r * segments;
      const nextRingStart = (r + 1) * segments;
      for (let s = 0; s < segments; s++) {
        const next = (s + 1) % segments;
        indices.push(ringStart + s, nextRingStart + s, nextRingStart + next);
        indices.push(ringStart + s, nextRingStart + next, ringStart + next);
      }
    }
    geom.setIndex(indices);

    const baseMat = this._getFarfieldMaterial();
    const material = baseMat.clone();
    material.name = 'HorizonFieldMaterial';
    material.vertexColors = true;
    material.transparent = false;
    material.depthWrite = true;
    material.side = THREE.FrontSide;
    material.toneMapped = true;

    const mesh = new THREE.Mesh(geom, material);
    mesh.frustumCulled = false;
    mesh.renderOrder = -20;
    mesh.receiveShadow = false;
    mesh.castShadow = false;
    mesh.layers.set(1);
    this.scene.add(mesh);

    const colArr = colAttr.array;
    for (let i = 0; i < colArr.length; i += 3) {
      colArr[i] = 0.22;
      colArr[i + 1] = 0.24;
      colArr[i + 2] = 0.27;
    }
    colAttr.needsUpdate = true;

    this._horizonField = {
      mesh,
      geometry: geom,
      posAttr,
      uvAttr,
      colAttr,
      segments,
      radialSteps,
      angles: new Float32Array(segments),
      weights: new Float32Array(segments),
      focusGain: new Float32Array(segments),
      innerHeights: new Float32Array(segments),
      innerRadius: 0,
      outerRadius: 0,
    };
    this._horizonDirty = true;
    this._nextHorizonUpdate = 0;
  }

  _disposeHorizonField() {
    if (!this._horizonField) return;
    try {
      this.scene.remove(this._horizonField.mesh);
      this._horizonField.geometry?.dispose?.();
      this._horizonField.mesh.material?.dispose?.();
    } catch { /* noop */ }
    this._horizonField = null;
  }

  _updateHorizonField(playerPos, deltaTime = 0) {
    if (!this._horizonField) {
      this._initHorizonField();
      if (!this._horizonField) return;
    }
    const hf = this._horizonField;
    const now = performance?.now ? performance.now() : Date.now();
    const velocity = this._playerVelocity.length();
    const needFocus = velocity > this.HORIZON_FOCUS_THRESHOLD;
    if (!this._horizonDirty && now < this._nextHorizonUpdate && !needFocus) return;

    const innerRadius = Math.max(
      this._computeFarfieldOuterRadius() + this.HORIZON_INNER_GAP,
      this.tileRadius * (this.VISUAL_RING + this.FARFIELD_EXTRA * 0.5)
    );
    const outerRadius = Math.max(
      innerRadius + this.HORIZON_EXTRA_METERS,
      this.HORIZON_TARGET_RADIUS
    );

    const segments = hf.segments;
    const radialSteps = hf.radialSteps;
    const weights = hf.weights;
    const focusGain = hf.focusGain;
    const angles = hf.angles;
    const innerHeights = hf.innerHeights;

    const focusDir = needFocus ? Math.atan2(this._playerVelocity.z, this._playerVelocity.x) : null;
    let totalWeight = 0;
    for (let i = 0; i < segments; i++) {
      const baseAngle = (i / segments) * TAU;
      let weight = 1;
      let gain = 0;
      if (focusDir !== null) {
        const diff = Math.atan2(Math.sin(baseAngle - focusDir), Math.cos(baseAngle - focusDir));
        gain = Math.max(0, Math.cos(diff));
        weight += this.HORIZON_FOCUS_STRENGTH * gain * gain;
      }
      weights[i] = weight;
      focusGain[i] = gain;
      totalWeight += weight;
    }
    if (!Number.isFinite(totalWeight) || totalWeight <= 0) totalWeight = segments;

    let cumulative = 0;
    for (let i = 0; i < segments; i++) {
      const w = weights[i];
      const start = cumulative / totalWeight;
      cumulative += w;
      const end = cumulative / totalWeight;
      angles[i] = ((start + end) * 0.5) * TAU;
    }

    const posAttr = hf.posAttr;
    const uvAttr = hf.uvAttr;

    const baseHeight = this._lastHeight;
    for (let i = 0; i < segments; i++) {
      const angle = angles[i];
      const cosA = Math.cos(angle);
      const sinA = Math.sin(angle);
      const x = innerRadius * cosA;
      const z = innerRadius * sinA;
      const y = this._sampleHorizonHeight(x, z, baseHeight);
      innerHeights[i] = y;
      posAttr.setXYZ(i, x, y, z);
      uvAttr.setXY(i, 0.5 + x * this.HORIZON_TEXTURE_SCALE, 0.5 + z * this.HORIZON_TEXTURE_SCALE);
    }

    for (let band = 1; band < radialSteps; band++) {
      const bandT = band / (radialSteps - 1);
      const radius = THREE.MathUtils.lerp(innerRadius, outerRadius, Math.pow(bandT, 1.15));
      const heightBlend = Math.pow(bandT, 1.6);
      for (let i = 0; i < segments; i++) {
        const angle = angles[i];
        let radial = radius;
        if (focusDir !== null && band === radialSteps - 1) {
          radial += radius * 0.12 * focusGain[i];
        }
        const x = radial * Math.cos(angle);
        const z = radial * Math.sin(angle);
        const innerY = innerHeights[i];
        const farY = innerY * 0.25;
        const y = THREE.MathUtils.lerp(innerY, farY, heightBlend);
        const idx = band * segments + i;
        posAttr.setXYZ(idx, x, y, z);
        uvAttr.setXY(idx, 0.5 + x * this.HORIZON_TEXTURE_SCALE, 0.5 + z * this.HORIZON_TEXTURE_SCALE);
      }
    }

    posAttr.needsUpdate = true;
    uvAttr.needsUpdate = true;
    try { hf.geometry.computeVertexNormals(); } catch { }

    hf.innerRadius = innerRadius;
    hf.outerRadius = outerRadius;
    hf.mesh.visible = true;
    this._horizonDirty = false;
    this._nextHorizonUpdate = now + this.HORIZON_UPDATE_INTERVAL_MS;
  }

  _forEachAxialRing(q0, r0, radius, step, cb) {
    step = Math.max(1, Math.floor(step));
    if (radius <= 0) { cb(q0, r0); return; }
    let q = q0 + HEX_DIRS[4][0] * radius;
    let r = r0 + HEX_DIRS[4][1] * radius;
    for (let side = 0; side < 6; side++) {
      const dir = HEX_DIRS[side];
      let remaining = radius;
      while (remaining > 0) {
        cb(q, r);
        const hop = Math.min(step, remaining);
        q += dir[0] * hop;
        r += dir[1] * hop;
        remaining -= hop;
      }
    }
  }

  /* ---------- GLOBAL grayscale helpers ---------- */

  _ensureColorAttr(tile) {
    let col = tile.grid.geometry.attributes.color;
    if (col && col.usage !== THREE.DynamicDrawUsage) col.setUsage(THREE.DynamicDrawUsage);
    if (!col) {
      const n = tile.pos.count;
      col = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      tile.grid.geometry.setAttribute('color', col);
    }
    tile.col = col;
    return col;
  }
  _ensureRoadMask(tile, { reset = false } = {}) {
    if (!tile || !tile.pos) return null;
    const count = tile.pos.count;
    if (!(count > 0)) return null;
    if (!tile._roadMask || tile._roadMask.length !== count) {
      tile._roadMask = new Float32Array(count);
      reset = true;
    }
    if (reset) {
      tile._roadMask.fill(1);
    }
    return tile._roadMask;
  }
  _initColorsNearBlack(tile) {
    const col = this._ensureColorAttr(tile);
    this._ensureRoadMask(tile, { reset: true });
    const arr = col.array;
    for (let i = 0; i < tile.pos.count; i++) {
      const o = 3 * i;
      arr[o] = arr[o + 1] = arr[o + 2] = 0.1;
    }
    col.needsUpdate = true;
  }
  _initFarfieldColors(tile) {
    const col = this._ensureColorAttr(tile);
    this._ensureRoadMask(tile, { reset: true });
    const arr = col.array;
    for (let i = 0; i < tile.pos.count; i++) {
      const o = 3 * i;
      arr[o] = arr[o + 1] = arr[o + 2] = 0.2;
    }
    col.needsUpdate = true;
    if (tile.grid?.mat) tile.grid.mat.color?.set?.(0xffffff);
  }
  _updateGlobalFromValue(y) {
    let changed = false;
    if (y < this.GLOBAL_MIN_Y) { this.GLOBAL_MIN_Y = y; changed = true; }
    if (y > this.GLOBAL_MAX_Y) { this.GLOBAL_MAX_Y = y; changed = true; }
    if (changed) this._globalDirty = true;
  }
  _updateGlobalFromArray(arr) { for (let i = 0; i < arr.length; i++) this._updateGlobalFromValue(arr[i]); }
  _lumFromYGlobal(y) {
    const minY = this.GLOBAL_MIN_Y, maxY = this.GLOBAL_MAX_Y;
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY - minY < 1e-6) return this.LUM_MIN;
    const t = THREE.MathUtils.clamp((y - minY) / (maxY - minY), 0, 1);
    return this.LUM_MIN + t * (this.LUM_MAX - this.LUM_MIN);
  }
  _colorFromNormalized(t) {
    const low = { r: 0.18, g: 0.2, b: 0.24 };
    const high = { r: 0.82, g: 0.86, b: 0.9 };
    return {
      r: low.r + (high.r - low.r) * t,
      g: low.g + (high.g - low.g) * t,
      b: low.b + (high.b - low.b) * t,
    };
  }
  _normalizedHeight(y) {
    const minY = this.GLOBAL_MIN_Y;
    const maxY = this.GLOBAL_MAX_Y;
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY - minY < 1e-6) return 0;
    return THREE.MathUtils.clamp((y - minY) / (maxY - minY), 0, 1);
  }
  _applyAllColorsGlobal(tile) {
    // CRITICAL: BLOCK ALL TEXTURE APPLICATION UNTIL ELEVATION DATA IS FETCHED
    // This prevents ARCGIS textures from appearing before terrain geometry
    if (!tile || !tile._elevationFetched) {
      // Elevation data not fetched yet - skip texture application
      return;
    }

    this._ensureColorAttr(tile);
    const roadMask = this._ensureRoadMask(tile);
    const arr = tile.col.array;
    const pos = tile.pos;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = this._normalizedHeight(y);
      const color = this._colorFromNormalized(t);
      const o = 3 * i;
      let r = color.r;
      let g = color.g;
      let b = color.b;
      if (roadMask) {
        const mask = THREE.MathUtils.clamp(roadMask[i] ?? 1, 0, 1);
        r *= mask;
        g *= mask;
        b *= mask;
      }
      arr[o] = r;
      arr[o + 1] = g;
      arr[o + 2] = b;
    }
    tile.col.needsUpdate = true;
    if (tile.grid?.mesh?.material) tile.grid.mesh.material.needsUpdate = true;
  }
  _slippyLonLatToTile(lon, lat, zoom) {
    const n = Math.pow(2, zoom);
    const latClamped = THREE.MathUtils.clamp(lat, -85, 85);
    const lonWrapped = ((lon + 180) % 360 + 360) % 360 - 180;
    const xt = Math.floor(((lonWrapped + 180) / 360) * n);
    const latRad = THREE.MathUtils.degToRad(latClamped);
    const yt = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    return { x: xt, y: yt };
  }
  _slippyTileToLon(x, zoom) {
    return (x / Math.pow(2, zoom)) * 360 - 180;
  }
  _slippyTileToLat(y, zoom) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, zoom);
    return THREE.MathUtils.radToDeg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))));
  }
  _slippyTileBounds(x, y, zoom) {
    return {
      lonMin: this._slippyTileToLon(x, zoom),
      lonMax: this._slippyTileToLon(x + 1, zoom),
      latMax: this._slippyTileToLat(y, zoom),
      latMin: this._slippyTileToLat(y + 1, zoom),
    };
  }
  _boundsContain(outer, inner) {
    if (!outer || !inner) return false;
    const lonSpan = Math.max(1e-9, outer.lonMax - outer.lonMin);
    const latSpan = Math.max(1e-9, outer.latMax - outer.latMin);
    const lonMargin = Math.max(1e-6, lonSpan * 0.02);
    const latMargin = Math.max(1e-6, latSpan * 0.02);
    return (
      inner.lonMin >= outer.lonMin - lonMargin &&
      inner.lonMax <= outer.lonMax + lonMargin &&
      inner.latMin >= outer.latMin - latMargin &&
      inner.latMax <= outer.latMax + latMargin
    );
  }
  _estimateTileCoverageLatLon(tile) {
    if (!tile || !this.origin) return null;
    const group = tile.grid?.group;
    if (!group) return null;
    let latMin = Infinity;
    let latMax = -Infinity;
    let lonMin = Infinity;
    let lonMax = -Infinity;
    const pos = tile.pos;
    if (pos?.count) {
      const stride = Math.max(1, Math.floor(pos.count / 2000));
      for (let i = 0; i < pos.count; i += stride) {
        const wx = group.position.x + pos.getX(i);
        const wz = group.position.z + pos.getZ(i);
        const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
        if (!ll) continue;
        if (ll.lat < latMin) latMin = ll.lat;
        if (ll.lat > latMax) latMax = ll.lat;
        if (ll.lon < lonMin) lonMin = ll.lon;
        if (ll.lon > lonMax) lonMax = ll.lon;
      }
      // ensure last vertex included
      const lastIdx = pos.count - 1;
      if (lastIdx >= 0) {
        const wx = group.position.x + pos.getX(lastIdx);
        const wz = group.position.z + pos.getZ(lastIdx);
        const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
        if (ll) {
          if (ll.lat < latMin) latMin = ll.lat;
          if (ll.lat > latMax) latMax = ll.lat;
          if (ll.lon < lonMin) lonMin = ll.lon;
          if (ll.lon > lonMax) lonMax = ll.lon;
        }
      }
    } else {
      const radius = tile._radiusOverride ?? this.tileRadius;
      if (!Number.isFinite(radius) || radius <= 0) return null;
      const samples = [{ x: 0, z: 0 }, ...this._hexCorners(radius), ...this._hexCorners(radius * 0.55)];
      for (const pt of samples) {
        const wx = group.position.x + pt.x;
        const wz = group.position.z + pt.z;
        const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
        if (!ll) continue;
        if (ll.lat < latMin) latMin = ll.lat;
        if (ll.lat > latMax) latMax = ll.lat;
        if (ll.lon < lonMin) lonMin = ll.lon;
        if (ll.lon > lonMax) lonMax = ll.lon;
      }
    }
    if (!Number.isFinite(latMin) || !Number.isFinite(latMax) || !Number.isFinite(lonMin) || !Number.isFinite(lonMax)) {
      return null;
    }
    // add tiny padding to account for numeric jitter
    const epsilonLat = Math.max(1e-7, (latMax - latMin) * 0.005);
    const epsilonLon = Math.max(1e-7, (lonMax - lonMin) * 0.005);
    return { latMin: latMin - epsilonLat, latMax: latMax + epsilonLat, lonMin: lonMin - epsilonLon, lonMax: lonMax + epsilonLon };
  }
  _primeWaybackVersions() {
    if (typeof window === 'undefined') return;
    if (typeof fetch !== 'function' || typeof DOMParser === 'undefined') return;
    if (this._overlayVersionPromise) return;
    this._overlayVersionPromise = (async () => {
      try {
        const res = await fetch(WAYBACK_WMTS_CAPABILITIES, { mode: 'cors' });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching Wayback capabilities`);
        const text = await res.text();
        const parser = new DOMParser();
        const xml = parser.parseFromString(text, 'application/xml');
        const layers = Array.from(xml.querySelectorAll('Contents > Layer'));
        const versions = [];
        for (const layer of layers) {
          const id = (layer.querySelector('ows\\:Identifier') || layer.querySelector('Identifier'))?.textContent?.trim() || '';
          const title = (layer.querySelector('ows\\:Title') || layer.querySelector('Title'))?.textContent?.trim() || id;
          const resURL = layer.querySelector('ResourceURL[resourceType="tile"]')?.getAttribute('template') || '';
          const versionMatch = resURL.match(/\/tile\/(\d+)\/\{?TileMatrix/i);
          const version = versionMatch ? versionMatch[1] : '';
          if (!version) continue;
          let sortKey = version;
          let label = title || version;
          const dateMatch = title.match(/(\d{4}-\d{2}-\d{2})/);
          if (dateMatch) {
            sortKey = dateMatch[1];
            label = `${dateMatch[1]}  (v${version})`;
          } else {
            label = `${label}  (v${version})`;
          }
          versions.push({ id: version, label, sortKey });
        }
        versions.sort((a, b) => (a.sortKey < b.sortKey ? 1 : (a.sortKey > b.sortKey ? -1 : 0)));
        if (versions.length) {
          this._overlayVersions = versions;
          const latest = versions[0]?.id;
          if (latest) this._applyOverlayVersion(latest);
        }
      } catch (err) {
        console.warn('[TileManager] Wayback capabilities fetch failed', err);
      } finally {
        this._overlayVersionPromise = null;
      }
    })();
  }
  _applyOverlayVersion(version) {
    if (!version || this._overlayVersion === version) return;
    this._overlayVersion = version;
    const tiles = Array.from(this.tiles.values());
    for (const tile of tiles) this._teardownOverlayForTile(tile);
    for (const entry of this._overlayCache.values()) {
      try {
        entry.texture?.dispose?.();
      } catch { /* noop */ }
    }
    this._overlayCache.clear();
    for (const tile of tiles) this._ensureTileOverlay(tile);
  }
  _teardownOverlayForTile(tile) {
    if (!tile) return;
    const mesh = tile.grid?.mesh;
    if (mesh?.material) {
      const mat = mesh.material;
      const backup = mesh.userData?._overlayBackup;

      if (backup) {
        // restore baseline material & flags
        if (backup.color && mat.color?.isColor) mat.color.copy(backup.color);
        if (backup.shared && backup.clone && mat === backup.clone) {
          try { mat.dispose?.(); } catch { }
          mesh.material = backup.original;
          backup.clone = null;
        } else {
          mat.vertexColors = true;
        }
        mesh.userData._overlayBackup = null;
      }

      mat.needsUpdate = true;
      mesh.receiveShadow = true;
    }

    // NEW: restore adapter visibility for farfield
    if (tile?.type === 'farfield' && tile._adapter?.mesh) {
      const prev = tile._adapter._visBackup;
      tile._adapter.mesh.visible = (prev !== undefined) ? prev : true;
      tile._adapter._visBackup = undefined;
    }

    if (tile._overlay?.status) tile._overlay = null;
    this._clearTileTrees(tile);
  }



  _buildWaybackTileUrl(version, zoom, x, y) {
    if (!version) return null;
    return `${WAYBACK_WMTS_ROOT}/tile/${version}/${zoom}/${y}/${x}`;
  }
  _ensureTileOverlay(tile) {
    if (!this._overlayEnabled || !tile || !this.origin) return;
    const eligible = ['interactive', 'visual', 'farfield'];
    if (!eligible.includes(tile.type)) return;

    // already loading/ready? bail
    if (tile._overlay && (tile._overlay.status === 'loading' || tile._overlay.status === 'ready')) return;

    // Version & zoom selection (no more zoom step-down fallback)
    this._primeWaybackVersions();
    const version = this._overlayVersion || DEFAULT_WAYBACK_VERSION;
    if (!version) return;

    const center = this._tileCenterLatLon(tile);
    const coverage = this._estimateTileCoverageLatLon(tile);
    if (!center || !coverage) return;

    const zoom = this._overlayZoom; // keep the requested zoom

    // Slippy tile(s) that cover the hex at THIS zoom
    const tl = this._slippyLonLatToTile(coverage.lonMin, coverage.latMax, zoom);
    const tr = this._slippyLonLatToTile(coverage.lonMax, coverage.latMax, zoom);
    const bl = this._slippyLonLatToTile(coverage.lonMin, coverage.latMin, zoom);
    const br = this._slippyLonLatToTile(coverage.lonMax, coverage.latMin, zoom);

    let minX = Math.min(tl.x, tr.x, bl.x, br.x);
    let maxX = Math.max(tl.x, tr.x, bl.x, br.x);
    let minY = Math.min(tl.y, tr.y, bl.y, br.y);
    let maxY = Math.max(tl.y, tr.y, bl.y, br.y);

    // limit to a compact 3×3 neighborhood around the tile that contains the hex center
    const n = 1 << zoom;
    const c = this._slippyLonLatToTile(center.lon, center.lat, zoom);
    const x0 = Math.max(0, c.x - 1), x1 = Math.min(n - 1, c.x + 1);
    const y0 = Math.max(0, c.y - 1), y1 = Math.min(n - 1, c.y + 1);

    // If hex fits in a single tile, keep it; otherwise use the 3×3 around center
    const multi = (minX !== maxX) || (minY !== maxY);
    if (multi) { minX = x0; maxX = x1; minY = y0; maxY = y1; }

    // Cache key encodes a composite range when needed
    const key = multi
      ? `${version}/${zoom}/${minX}-${maxX}/${minY}-${maxY}`
      : `${version}/${zoom}/${c.x}/${c.y}`;

    let entry = this._overlayCache.get(key);
    if (!entry) {
      const unionBounds = multi
        ? this._unionTileBounds(minX, maxX, minY, maxY, zoom)   // new helper below
        : this._slippyTileBounds(c.x, c.y, zoom);

      entry = {
        status: 'loading',
        waiters: new Set(),
        version,
        zoom,
        // single or composite range
        x: c.x, y: c.y,
        x0: minX, x1: maxX,
        y0: minY, y1: maxY,
        composite: multi,
        bounds: unionBounds,
        coverage
      };
      this._overlayCache.set(key, entry);
      this._fetchOverlayTile(key, entry);          // (replaced) now supports composite
    } else if (!entry.bounds) {
      entry.bounds = multi
        ? this._unionTileBounds(minX, maxX, minY, maxY, zoom)
        : this._slippyTileBounds(entry.x, entry.y, zoom);
    }

    // normal waiter bookkeeping
    entry.waiters.add(tile);
    tile._overlay = { status: 'loading', cacheKey: key };
  }



  _upgradeOverlayResolution(tile, version, zoom, slippy, bounds, coverage) {
    if (!tile || !this.tiles.has(`${tile.q},${tile.r}`)) return;

    const key = `${version}/${zoom}/${slippy.x}/${slippy.y}`;
    let entry = this._overlayCache.get(key);

    if (entry && entry.status === 'ready') {
      // Store entry reference so we can apply it after elevation is fetched
      tile._overlay = { status: 'ready', cacheKey: key, entry };
      // Try to apply overlay (will be blocked if elevation not fetched yet)
      this._applyOverlayEntryToTile(tile, entry);
      return;
    }

    if (!entry) {
      entry = {
        status: 'loading',
        waiters: new Set(),
        zoom,
        x: slippy.x,
        y: slippy.y,
        version,
        bounds,
        coverage,
      };
      this._overlayCache.set(key, entry);
      this._fetchOverlayTile(key, entry);
    }

    entry.waiters.add(tile);
    tile._overlay = { status: 'upgrading', cacheKey: key };
  }

  _fetchOverlayTile(cacheKey, entry) {
    const { version, zoom } = entry;
    if (!version) { entry.status = 'error'; return; }

    // helper to finish & notify waiters
    const finalizeReady = (canvas, bounds) => {
      // Reuse your existing processing so samples/etc keep working
      const overlayData = this._processOverlayImage(canvas, bounds);
      const texCanvas = overlayData.canvas || canvas;

      // Create texture from canvas (works for <img> or <canvas>)
      const texture = new THREE.CanvasTexture(texCanvas);
      texture.wrapS = THREE.ClampToEdgeWrapping;
      texture.wrapT = THREE.ClampToEdgeWrapping;
      texture.minFilter = THREE.LinearMipmapLinearFilter;
      texture.magFilter = THREE.LinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = (this.renderer?.capabilities?.getMaxAnisotropy?.() || 1);
      texture.encoding = THREE.sRGBEncoding;

      texture.flipY = false;               // ★ IMPORTANT: keep Mercator v “top-origin”
      texture.needsUpdate = true;          // ★ ensure the flip takes effect

      entry.texture = texture;
      entry.samples = overlayData.samples || [];
      entry.imageSize = overlayData.imageSize || { width: texCanvas.width, height: texCanvas.height };
      entry.status = 'ready';

      // wake the tiles waiting for this entry
      const waiters = entry.waiters ? Array.from(entry.waiters) : [];
      entry.waiters?.clear?.();
      for (const t of waiters) {
        if (!t || !this.tiles.has(`${t.q},${t.r}`)) continue;
        // Store entry reference so we can apply it after elevation is fetched
        t._overlay = { status: 'ready', cacheKey, entry };
        // Try to apply overlay (will be blocked if elevation not fetched yet)
        this._applyOverlayEntryToTile(t, entry);
      }
    };

    const fail = () => {
      entry.status = 'error';
      const waiters = entry.waiters ? Array.from(entry.waiters) : [];
      entry.waiters?.clear?.();
      for (const t of waiters) { if (t) t._overlay = null; }
    };

    // ---- SINGLE TILE path ----------------------------------------------------
    if (!entry.composite) {
      const bounds = entry.bounds || this._slippyTileBounds(entry.x, entry.y, zoom);
      const url = this._buildWaybackTileUrl(version, zoom, entry.x, entry.y);
      if (!url || typeof Image === 'undefined') return fail();

      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.onload = () => finalizeReady(image, bounds);   // handled above (flipY=false)
      image.onerror = fail;
      image.src = url;
      return;
    }

    // ---- COMPOSITE (3×3) path -----------------------------------------------
    if (typeof document === 'undefined' || typeof Image === 'undefined') return fail();

    const x0 = entry.x0, x1 = entry.x1, y0 = entry.y0, y1 = entry.y1;
    const cols = Math.max(1, x1 - x0 + 1);
    const rows = Math.max(1, y1 - y0 + 1);

    // assume 256px tiles initially; will resize after first load if needed
    const tileSizeGuess = 256;
    const canvas = document.createElement('canvas');
    canvas.width = cols * tileSizeGuess;
    canvas.height = rows * tileSizeGuess;
    const ctx = canvas.getContext('2d', { willReadFrequently: false });

    const N = 1 << zoom;
    let remaining = cols * rows;
    let tileSizeKnown = false;

    const drawAt = (img, cx, cy) => {
      const ts = img.naturalWidth || img.width || tileSizeGuess;
      if (!tileSizeKnown && ts !== tileSizeGuess) {
        const prev = document.createElement('canvas');
        prev.width = canvas.width; prev.height = canvas.height;
        prev.getContext('2d').drawImage(canvas, 0, 0);
        canvas.width = cols * ts; canvas.height = rows * ts;
        ctx.drawImage(prev, 0, 0);
        tileSizeKnown = true;
      }
      const tileSize = tileSizeKnown ? (canvas.width / cols) : tileSizeGuess;
      ctx.drawImage(img, cx * tileSize, cy * tileSize, tileSize, tileSize);
    };

    const loadOne = (x, y, cx, cy) => {
      const nx = ((x % N) + N) % N;                    // wrap X
      const ny = Math.max(0, Math.min(N - 1, y));      // clamp Y
      const url = this._buildWaybackTileUrl(version, zoom, nx, ny);
      if (!url) { remaining--; if (remaining <= 0) finalizeReady(canvas, entry.bounds); return; }
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => { drawAt(img, cx, cy); remaining--; if (remaining <= 0) finalizeReady(canvas, entry.bounds); };
      img.onerror = () => { remaining--; if (remaining <= 0) finalizeReady(canvas, entry.bounds); };
      img.src = url;
    };

    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        loadOne(xx, yy, xx - x0, yy - y0);
      }
    }
  }

  _unionTileBounds(x0, x1, y0, y1, zoom) {
    const N = 1 << zoom;
    let lonMin = Infinity, lonMax = -Infinity;
    let latMin = Infinity, latMax = -Infinity;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const nx = ((x % N) + N) % N;                       // wrap x
        const ny = Math.max(0, Math.min(N - 1, y));         // clamp y
        const b = this._slippyTileBounds(nx, ny, zoom);
        if (b.lonMin < lonMin) lonMin = b.lonMin;
        if (b.lonMax > lonMax) lonMax = b.lonMax;
        if (b.latMin < latMin) latMin = b.latMin;
        if (b.latMax > latMax) latMax = b.latMax;
      }
    }
    return { lonMin, lonMax, latMin, latMax };
  }

  _tileCenterLatLon(tile) {
    if (!tile || !this.origin) return null;
    const group = tile.grid?.group;
    if (!group) return null;
    const wx = group.position.x;
    const wz = group.position.z;
    return worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
  }
  _applyOverlayEntryToTile(tile, entry) {
    if (!tile || !entry || entry.status !== 'ready') return;
    const bounds = entry.bounds;
    if (!bounds) return;

    // Pass image size for half-texel inset in UVs
    this._ensureTileUv(tile, bounds, entry.imageSize);

    this._applyOverlayTexture(tile, entry.texture);

    const allowTrees = tile.type === 'interactive';
    if (allowTrees && this._treeEnabled) this._applyTreeSeeds(tile, entry);
    else this._clearTileTrees(tile);

    // CRITICAL: BLOCK grass injection until elevation fetched AND textures applied
    const allowGrass = tile.type === 'interactive' || tile.type === 'visual';
    if (allowGrass && this._grassEnabled && entry.samples && tile._texturesApplied) {
      this.grassManager?.generateGrassForTile(tile, entry.samples, bounds);
    } else {
      this.grassManager?.removeGrassForTile(tile);
    }
    tile._overlay = {
      status: 'ready',
      cacheKey: `${entry.version}/${entry.zoom}/${entry.x}/${entry.y}`,
    };
  }
  // DROP-IN REPLACEMENT
  _ensureTileUv(tile, bounds) {
    if (!tile || !bounds || !this.origin) return;

    const geom = tile.grid?.geometry;
    const pos = tile.pos;
    const group = tile.grid?.group;
    if (!geom || !pos || !group) return;

    // Ensure a UV buffer sized to positions
    let uv = geom.getAttribute('uv');
    if (!uv || uv.count !== pos.count) {
      uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2)
        .setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute('uv', uv);
    }

    const data = uv.array;

    // ---- Slippy math ---------------------------------------------------------
    // u is linear in longitude
    const lonMin = bounds.lonMin;
    const lonMax = bounds.lonMax;
    const lonSpan = Math.max(1e-12, lonMax - lonMin);

    // v is linear in Web Mercator Y, not latitude
    const mercY = (latDeg) => {
      // clamp to valid Web Mercator range to avoid infinities
      const lat = THREE.MathUtils.clamp(latDeg, -85.05112878, 85.05112878);
      const phi = THREE.MathUtils.degToRad(lat);
      return Math.log(Math.tan(Math.PI * 0.25 + phi * 0.5));
    };
    const mMax = mercY(bounds.latMax);
    const mMin = mercY(bounds.latMin);
    const mSpan = Math.max(1e-12, mMax - mMin);
    // -------------------------------------------------------------------------

    // small clamp to avoid border texel sampling (keeps alignment exact)
    const epsU = 1 / 2048;
    const epsV = 1 / 2048;

    const base = group.position;
    for (let i = 0; i < pos.count; i++) {
      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);

      // world -> WGS84
      const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
      const lon = Number.isFinite(ll?.lon) ? ll.lon : (lonMin + lonMax) * 0.5;
      const lat = Number.isFinite(ll?.lat) ? ll.lat : (bounds.latMin + bounds.latMax) * 0.5;

      // u: linear in lon; v: linear in Mercator-Y (top = latMax)
      const u = (lon - lonMin) / lonSpan;
      const v = (mMax - mercY(lat)) / mSpan;

      data[i * 2] = THREE.MathUtils.clamp(u, epsU, 1 - epsU);
      data[i * 2 + 1] = THREE.MathUtils.clamp(v, epsV, 1 - epsV);
    }

    uv.needsUpdate = true;
  }


  _applyOverlayTexture(tile, texture) {
    if (!tile || !texture) return;
    const mesh = tile.grid?.mesh;
    if (!mesh) return;

    // Ensure these draw in the main camera layer
    tile.grid?.group?.layers?.set?.(0);
    mesh.layers?.set?.(0);

    // Hide the farfield adapter while overlay is active (prevents double draw/z-fighting)
    if (tile.type === 'farfield' && tile._adapter?.mesh) {
      if (!tile._adapter._visBackup) tile._adapter._visBackup = tile._adapter.mesh.visible;
      tile._adapter.mesh.visible = false;
      this._markFarfieldAdapterDirty(tile);
    }

    if (!mesh.userData) mesh.userData = {};
    let backup = mesh.userData._overlayBackup;
    if (!backup) {
      const original = mesh.material;
      const shared = (original === this._terrainMat || original === this._farfieldMat);
      let material = original;
      if (shared) { material = original.clone(); mesh.material = material; }
      backup = {
        original, shared,
        clone: shared ? mesh.material : null,
        vertexColors: original?.vertexColors ?? false,
        transparent: original?.transparent ?? false,
        opacity: original?.opacity ?? 1,
        depthWrite: original?.depthWrite ?? true,
        alphaTest: original?.alphaTest ?? 0,
        side: original?.side ?? THREE.BackSide,
        color: original?.color?.isColor ? original.color.clone() : null,
      };
      mesh.userData._overlayBackup = backup;
    } else if (backup.shared && (!backup.clone || mesh.material === backup.original)) {
      const clone = backup.original.clone();
      mesh.material = clone;
      backup.clone = clone;
    }

    const mat = mesh.material;
    if (!mat) return;

    // --- NEW: Half-texel inset to prevent edge-bleed / smearing -----------------
    // Determine texture size (fall back to 256x256 if unknown)
    const imgW = Math.max(1, texture.image?.width || texture.source?.data?.width || 256);
    const imgH = Math.max(1, texture.image?.height || texture.source?.data?.height || 256);
    const padU = 0.5 / imgW;
    const padV = 0.5 / imgH;

    // Ensure clamp-to-edge and shrink the sampled region to stay inside [0,1]
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.offset.set(padU, padV);                    // inset from each edge
    texture.repeat.set(1 - 2 * padU, 1 - 2 * padV);    // shrink sampling window
    // Improve mip sampling stability
    if (texture.generateMipmaps !== false) texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    // Optional but helpful on oblique views
    texture.anisotropy = Math.max(texture.anisotropy || 1, 8);
    texture.needsUpdate = true;
    // ---------------------------------------------------------------------------

    // Texture setup on the material
    if (mat.map && mat.map !== texture) mat.map = null;
    mat.vertexColors = false;
    if (mat.color?.isColor) mat.color.set(0xffffff);
    mat.map = texture;
    mat.transparent = false;
    mat.opacity = 1;
    mat.alphaTest = 0;
    mat.depthWrite = true;

    // IMPORTANT: use BackSide for your setup (as you confirmed)
    mat.side = THREE.BackSide;

    // Generate and apply normal map from texture (if enabled)
    if (this.normalMapsEnabled && texture.image && !mat.normalMap) {
      try {
        const normalData = computeNormalMapFromImage(texture.image, {
          size: imgW,
          prominence: this.normalProminence,
          gamma: this.normalGamma,
          highpass: this.normalHighpass
        });
        if (normalData) {
          const normalCanvas = document.createElement('canvas');
          normalCanvas.width = imgW;
          normalCanvas.height = imgH;
          const normalCtx = normalCanvas.getContext('2d');
          const normalImageData = new ImageData(normalData, imgW, imgH);
          normalCtx.putImageData(normalImageData, 0, 0);

          const normalTexture = new THREE.CanvasTexture(normalCanvas);
          normalTexture.wrapS = THREE.ClampToEdgeWrapping;
          normalTexture.wrapT = THREE.ClampToEdgeWrapping;
          normalTexture.needsUpdate = true;

          mat.normalMap = normalTexture;
          mat.normalScale = new THREE.Vector2(1, 1);
        }
      } catch (e) {
        console.warn('[TileManager] Normal map generation failed:', e);
      }
    }

    // Keep ordering stable (farfield < visual < interactive)
    if (typeof mesh.renderOrder === 'number') {
      if (tile.type === 'farfield') mesh.renderOrder = -2;
      else if (tile.type === 'visual') mesh.renderOrder = -1;
      else mesh.renderOrder = 0;
    }

    mat.needsUpdate = true;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
  }



  _processOverlayImage(image, bounds) {
    if (typeof document === 'undefined') {
      const w = image.naturalWidth || image.width || 256;
      const h = image.naturalHeight || image.height || 256;
      return { samples: [], imageSize: { width: w, height: h }, bounds, canvas: null };
    }
    const canvas = this._overlayCanvas || document.createElement('canvas');
    const ctx = this._overlayCtx || canvas.getContext('2d', { willReadFrequently: true });
    this._overlayCanvas = canvas;
    this._overlayCtx = ctx;
    const w = image.naturalWidth || image.width;
    const h = image.naturalHeight || image.height;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, 0, 0, w, h);
    let samples = [];
    try {
      const imageData = ctx.getImageData(0, 0, w, h);
      samples = this._extractGreenSamples(imageData.data, w, h);
    } catch (err) {
      try {
        const fallback = ctx.getImageData(0, 0, w, h).data;
        samples = this._extractGreenSamples(fallback, w, h);
      } catch {
        samples = [];
      }
    }
    let textureCanvas = null;
    try {
      textureCanvas = document.createElement('canvas');
      textureCanvas.width = w;
      textureCanvas.height = h;
      const tctx = textureCanvas.getContext('2d');
      tctx.drawImage(canvas, 0, 0, w, h);
    } catch {
      textureCanvas = null;
    }
    return { samples, imageSize: { width: w, height: h }, bounds, canvas: textureCanvas };
  }
  _extractGreenSamples(data, width, height) {
    const step = Math.max(2, Math.floor(Math.min(width, height) / 64));
    const complexity = THREE.MathUtils.clamp(this._treeComplexity ?? 0.35, 0.2, 1);
    const maxSamples = Math.round(120 + complexity * 120);
    const spawnBias = THREE.MathUtils.lerp(0.22, 0.48, complexity);
    const out = [];
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const a = data[idx + 3];
        if (a < 180) continue;
        const brightness = (r + g + b) / 3;
        if (brightness < 45) continue;
        if (g < 90) continue;
        if (g < r * 1.15 || g < b * 1.25) continue;
        if (Math.random() > spawnBias) continue;
        out.push({
          u: x / width,
          v: y / height,
          color: { r, g, b }
        });
        if (out.length >= maxSamples) return out;
      }
    }
    return out;
  }
  _randGaussian(mu = 0, sigma = 1) {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    const mag = Math.sqrt(-2 * Math.log(u));
    const z = mag * Math.cos(2 * Math.PI * v);
    return mu + z * sigma;
  }
  _applyTreeSeeds(tile, entry) {
    if (!tile || !entry || !Array.isArray(entry.samples) || !entry.samples.length) {
      this._clearTileTrees(tile);
      return;
    }
    const bounds = entry.bounds;
    if (!bounds || !this.origin) return;
    const samples = entry.samples;
    const worldPositions = [];
    const complexity = THREE.MathUtils.clamp(this._treeComplexity ?? 0.35, 0.2, 1);
    const maxCount = Math.max(3, Math.round(4 + complexity * 40));
    const densityScalar = THREE.MathUtils.lerp(0.18, 0.9, complexity);
    const center = tile.grid.group.position;
    const radius = tile._radiusOverride ?? this.tileRadius;
    const lonSpan = bounds.lonMax - bounds.lonMin || 1;
    const latSpan = bounds.latMax - bounds.latMin || 1;
    const used = new Set();
    for (let i = 0; i < samples.length && worldPositions.length < maxCount; i++) {
      const s = samples[i];
      const distCenter = Math.hypot(s.u - 0.5, s.v - 0.5);
      const densityWeight = Math.max(0, 1 - distCenter);
      const spawnChance = Math.min(1, densityWeight * densityScalar);
      if (Math.random() > spawnChance) continue;

      const lon = bounds.lonMin + lonSpan * s.u;
      const lat = bounds.latMax - latSpan * s.v;
      const world = latLonToWorld(lat, lon, this.origin.lat, this.origin.lon);
      if (!world) continue;
      const wx = world.x;
      const wz = world.z;
      const dx = wx - center.x;
      const dz = wz - center.z;
      if ((dx * dx + dz * dz) > radius * radius * 1.05) continue;
      const height = this.getHeightAt(wx, wz);
      if (!Number.isFinite(height)) continue;
      const key = `${Math.round(wx * 2)},${Math.round(wz * 2)}`;
      if (used.has(key)) continue;
      used.add(key);
      worldPositions.push({ x: wx, y: height, z: wz });
    }
    this._spawnTreesForTile(tile, worldPositions);
  }

  _ensureTreeLibrary() {
    if (this._treeLib) return Promise.resolve(this._treeLib);
    if (this._treeLibPromise) return this._treeLibPromise;
    if (typeof window === 'undefined') return Promise.resolve(null);

    if (window['@dgreenheck/ez-tree']) {
      this._treeLib = window['@dgreenheck/ez-tree'];
      return Promise.resolve(this._treeLib);
    }

    const src = 'https://cdn.jsdelivr.net/npm/ez-tree-fork@1.0.3/build/ez-tree.es.js';
    this._treeLibPromise = import(src)
      .then((mod) => {
        this._treeLib = mod;
        return this._treeLib;
      })
      .catch((err) => {
        if (!this._treeLibWarned) {
          console.warn('[tiles] EZ-Tree library failed to load', err);
          this._treeLibWarned = true;
        }
        this._treeLibPromise = null;
        return null;
      });
    return this._treeLibPromise;
  }

  _hashTreeSeed(x, z) {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    let seed = (xi * 374761393) ^ (zi * 668265263);
    seed = (seed ^ (seed >> 13)) >>> 0;
    return seed || 1;
  }

  _seededRandom(seed, offset = 0) {
    const value = Math.sin(seed + offset * 374761393) * 43758.5453123;
    return value - Math.floor(value);
  }

  /**
   * Determine tree biome based on latitude with enhanced regional accuracy
   * Based on Köppen climate classification and global forest distribution data
   * References:
   * - Global Forest Watch (globalforestwatch.org)
   * - Köppen-Geiger climate classification
   * - FAO Global Forest Resources Assessment
   */
  _pickTreeProfile(lat, lon = null) {
    const absLat = Math.abs(lat || 0);

    // Boreal/Taiga (60°-90° N/S): Conifers dominate
    // Examples: Siberian larch, Norway spruce, black spruce, lodgepole pine
    if (absLat >= 60) return 'boreal';

    // Temperate (30°-60° N/S): Mix of deciduous and conifers
    // Northern temperate (45°-60°): More conifers
    // Southern temperate (30°-45°): More deciduous
    if (absLat >= 45) return 'temperate-cool';  // More conifers (Douglas fir, white pine)
    if (absLat >= 30) return 'temperate-warm';  // More deciduous (oak, maple, beech)

    // Subtropical (23°-30° N/S): Evergreen broadleaf, some conifers
    // Examples: Southern pine, live oak, eucalyptus
    if (absLat >= 23) return 'subtropical';

    // Tropical (0°-23° N/S): Dense evergreen broadleaf rainforests
    // Examples: Mahogany, teak, rubber trees, palms
    return 'tropical';
  }

  updateTreePerformanceSample(fps, dt = 0) {
    if (!this._treeEnabled) return;
    if (!Number.isFinite(fps) || !Number.isFinite(dt) || dt <= 0) return;
    if (!Array.isArray(this._treePerfSamples)) {
      this._treePerfSamples = [];
      this._treePerfSampleTime = 0;
      this._treePerfEvalTimer = 0;
    }
    this._treePerfSamples.push({ fps, dt });
    this._treePerfSampleTime += dt;
    while (this._treePerfSamples.length > 0 && this._treePerfSampleTime > 6) {
      const oldest = this._treePerfSamples.shift();
      this._treePerfSampleTime -= oldest.dt;
    }

    this._treePerfEvalTimer += dt;
    if (this._treePerfEvalTimer >= 5 && this._treePerfSampleTime >= 2.5) {
      let totalFps = 0;
      let totalDt = 0;
      for (const sample of this._treePerfSamples) {
        totalFps += sample.fps * sample.dt;
        totalDt += sample.dt;
      }
      const avgFps = totalDt > 1e-6 ? totalFps / totalDt : fps;
      const prevTarget = this._treeTargetComplexity;
      if (avgFps >= 54) {
        this._treeTargetComplexity = Math.min(1, this._treeTargetComplexity + 0.12);
      } else if (avgFps <= 44) {
        this._treeTargetComplexity = Math.max(0.25, this._treeTargetComplexity - 0.15);
      }
      if (Math.abs(this._treeTargetComplexity - prevTarget) < 0.01) {
        this._treeTargetComplexity = THREE.MathUtils.clamp(this._treeTargetComplexity, 0.25, 1);
      }
      if (Math.abs(this._treeTargetComplexity - prevTarget) > 0.1) {
        this._scheduleTreeRefresh();
      }
      this._treePerfEvalTimer = 0;
    }

    const lerpRate = THREE.MathUtils.clamp(dt * 0.35, 0, 0.35);
    this._treeComplexity = THREE.MathUtils.lerp(this._treeComplexity, this._treeTargetComplexity, lerpRate);
    this._treeComplexity = THREE.MathUtils.clamp(this._treeComplexity, 0.25, 1);
  }

  /**
   * Configure tree appearance based on geographic location and biome
   *
   * This system uses latitude-based biome classification to render realistic tree species
   * distributions globally. The species selection and characteristics are informed by:
   *
   * Data Sources:
   * - Global Forest Watch (https://www.globalforestwatch.org/)
   *   World's most comprehensive forest monitoring platform with real-time data
   * - FAO Global Forest Resources Assessment (https://www.fao.org/forest-resources-assessment/)
   *   UN's comprehensive assessment of world's forests and their management
   * - Köppen-Geiger Climate Classification
   *   Scientific climate classification system correlating with forest types
   * - GBIF (Global Biodiversity Information Facility) - https://www.gbif.org/
   *   Open-access database of species occurrences worldwide
   * - TreeLib by Max Bittker - https://github.com/mxbck/tree-lib
   *   Procedural tree generation reference
   *
   * Tree species distributions are probabilistic within each biome to reflect
   * natural ecological variation. Conifer vs deciduous ratios are based on
   * ecological survey data from the above sources.
   *
   * @param {Object} tree - EZ-Tree instance to configure
   * @param {Object} latLon - Location { lat, lon }
   * @param {Number} seed - Deterministic seed for variation
   * @param {Object} lib - EZ-Tree library reference
   */
  _configureTreeForRegion(tree, latLon, seed, lib = this._treeLib) {
    if (!lib) return;

    const { TreeType, BarkType, LeafType, Billboard } = lib;
    const opts = tree.options || tree._options || {};

    if (opts.seed !== undefined) opts.seed = seed;

    const lat = latLon?.lat ?? 0;
    const profile = this._pickTreeProfile(lat);
    const complexity = THREE.MathUtils.clamp(this._treeComplexity ?? 0.35, 0.2, 1);
    const seedNoise = (offset, min, max) => min + this._seededRandom(seed, offset) * (max - min);
    const angleScale = THREE.MathUtils.lerp(0.85, 1.1, complexity);
    const applyAngleRange = (baseMin, baseMax) => {
      if (!opts.branch?.angle) return;
      Object.keys(opts.branch.angle).forEach((level) => {
        opts.branch.angle[level] = seedNoise(40 + Number(level), baseMin * angleScale, baseMax * angleScale);
      });
    };

    const levelMin = THREE.MathUtils.lerp(1, 2.1, complexity);
    const levelMax = THREE.MathUtils.lerp(1.5, 4.0, complexity);
    if (opts.branch?.levels != null) {
      const rawLevels = seedNoise(1, levelMin, levelMax);
      opts.branch.levels = Math.max(1, Math.round(rawLevels));
    }

    const twistScale = THREE.MathUtils.lerp(0.4, 1, complexity);
    if (opts.branch?.twist) {
      Object.keys(opts.branch.twist).forEach((level, idx) => {
        opts.branch.twist[level] = seedNoise(20 + idx, -0.2, 0.4) * twistScale;
      });
    }

    // Configure tree appearance based on biome with realistic species distribution
    switch (profile) {
      case 'boreal':
        // Boreal forests: Primarily conifers (spruce, pine, larch, fir)
        // Characteristics: Conical shape, narrow branches for snow shedding
        if (opts.type != null && TreeType?.Evergreen) opts.type = TreeType.Evergreen;
        if (opts.bark?.type != null && BarkType?.Pine) opts.bark.type = BarkType.Pine;
        if (opts.leaves?.type != null && LeafType?.Pine) opts.leaves.type = LeafType.Pine;
        if (opts.leaves?.billboard != null && Billboard?.Single) opts.leaves.billboard = Billboard.Single;
        applyAngleRange(28, 42); // Narrow, upright branches
        break;

      case 'temperate-cool':
        // Cool temperate: Mix with conifer dominance (Douglas fir, white pine, hemlock)
        // Also includes some deciduous (aspen, birch)
        const isConiferCool = seedNoise(100, 0, 1) < 0.65; // 65% conifers
        if (isConiferCool) {
          if (opts.type != null && TreeType?.Evergreen) opts.type = TreeType.Evergreen;
          if (opts.bark?.type != null && BarkType?.Pine) opts.bark.type = BarkType.Pine;
          if (opts.leaves?.type != null && LeafType?.Pine) opts.leaves.type = LeafType.Pine;
          if (opts.leaves?.billboard != null && Billboard?.Single) opts.leaves.billboard = Billboard.Single;
          applyAngleRange(35, 52);
        } else {
          if (opts.type != null && TreeType?.Deciduous) opts.type = TreeType.Deciduous;
          if (opts.bark?.type != null && BarkType?.Birch) opts.bark.type = BarkType.Birch;
          if (opts.leaves?.type != null && LeafType?.Aspen) opts.leaves.type = LeafType.Aspen;
          if (opts.leaves?.billboard != null && Billboard?.Double) opts.leaves.billboard = Billboard.Double;
          applyAngleRange(42, 65);
        }
        break;

      case 'temperate-warm':
        // Warm temperate: Deciduous dominance (oak, maple, beech, hickory)
        // Some conifers in drier/mountainous areas
        const isConiferWarm = seedNoise(100, 0, 1) < 0.25; // 25% conifers
        if (isConiferWarm) {
          if (opts.type != null && TreeType?.Evergreen) opts.type = TreeType.Evergreen;
          if (opts.bark?.type != null && BarkType?.Pine) opts.bark.type = BarkType.Pine;
          if (opts.leaves?.type != null && LeafType?.Pine) opts.leaves.type = LeafType.Pine;
          applyAngleRange(38, 55);
        } else {
          if (opts.type != null && TreeType?.Deciduous) opts.type = TreeType.Deciduous;
          if (opts.bark?.type != null && BarkType?.Oak) opts.bark.type = BarkType.Oak;
          if (opts.leaves?.type != null && LeafType?.Oak) opts.leaves.type = LeafType.Oak;
          if (opts.leaves?.billboard != null && Billboard?.Double) opts.leaves.billboard = Billboard.Double;
          applyAngleRange(48, 72);
        }
        break;

      case 'subtropical':
        // Subtropical: Evergreen broadleaf, southern pine, live oak, eucalyptus
        // Mix of deciduous and evergreen depending on moisture
        const isEvergreenSub = seedNoise(100, 0, 1) < 0.6; // 60% evergreen
        if (isEvergreenSub) {
          if (opts.type != null && TreeType?.Evergreen) opts.type = TreeType.Evergreen;
          if (opts.bark?.type != null && BarkType?.Willow) opts.bark.type = BarkType.Willow;
          if (opts.leaves?.type != null && LeafType?.Ash) opts.leaves.type = LeafType.Ash;
          applyAngleRange(45, 65);
        } else {
          if (opts.type != null && TreeType?.Deciduous) opts.type = TreeType.Deciduous;
          if (opts.bark?.type != null && BarkType?.Oak) opts.bark.type = BarkType.Oak;
          if (opts.leaves?.type != null && LeafType?.Oak) opts.leaves.type = LeafType.Oak;
          applyAngleRange(52, 75);
        }
        break;

      case 'tropical':
        // Tropical rainforest: Dense evergreen broadleaf (mahogany, teak, rubber)
        // Characteristics: Broad canopy, large leaves, tall trunks
        if (opts.type != null && TreeType?.Deciduous) opts.type = TreeType.Deciduous;
        if (opts.bark?.type != null && BarkType?.Willow) opts.bark.type = BarkType.Willow;
        if (opts.leaves?.type != null && LeafType?.Ash) opts.leaves.type = LeafType.Ash;
        if (opts.leaves?.billboard != null && Billboard?.Double) opts.leaves.billboard = Billboard.Double;
        applyAngleRange(55, 80); // Wide, spreading canopy
        break;

      default:
        // Fallback: Generic temperate deciduous
        if (opts.type != null && TreeType?.Deciduous) opts.type = TreeType.Deciduous;
        if (opts.bark?.type != null && BarkType?.Birch) opts.bark.type = BarkType.Birch;
        if (opts.leaves?.type != null && LeafType?.Aspen) opts.leaves.type = LeafType.Aspen;
        applyAngleRange(40, 70);
        break;
    }

    const lengthScale = THREE.MathUtils.lerp(0.6, 1.05, complexity);
    if (opts.branch?.length) {
      const base = seedNoise(5, 16, 28) * lengthScale;
      opts.branch.length[0] = base;
      if (opts.branch.length[1] != null) opts.branch.length[1] = base * seedNoise(6, 0.45, 0.68) * lengthScale;
      if (opts.branch.length[2] != null) opts.branch.length[2] = base * seedNoise(7, 0.25, 0.45) * lengthScale;
    }

    const childScale = THREE.MathUtils.lerp(0.45, 1.05, complexity);
    if (opts.branch?.children) {
      Object.keys(opts.branch.children).forEach((level, idx) => {
        // Adjust branch density based on biome
        let baseChildren;
        switch (profile) {
          case 'boreal':
            baseChildren = 4;  // Sparse, narrow branches for snow
            break;
          case 'temperate-cool':
            baseChildren = 5;  // Moderate branching
            break;
          case 'temperate-warm':
            baseChildren = 6;  // Fuller deciduous canopy
            break;
          case 'subtropical':
            baseChildren = 7;  // Dense subtropical growth
            break;
          case 'tropical':
            baseChildren = 8;  // Very dense tropical canopy
            break;
          default:
            baseChildren = 5;
        }
        const raw = baseChildren * seedNoise(10 + idx, 0.75, 1.25) * childScale;
        opts.branch.children[level] = Math.max(1, Math.round(raw));
      });
    }

    const radiusScale = THREE.MathUtils.lerp(0.55, 1.0, complexity);
    if (opts.branch?.radius) {
      Object.keys(opts.branch.radius).forEach((level) => {
        opts.branch.radius[level] = (opts.branch.radius[level] || 0.7) * radiusScale;
      });
    }

    const sectionScale = THREE.MathUtils.lerp(0.6, 1.0, complexity);
    if (opts.branch?.sections) {
      Object.keys(opts.branch.sections).forEach((level) => {
        const base = opts.branch.sections[level] || 6;
        opts.branch.sections[level] = Math.max(3, Math.round(base * sectionScale));
      });
    }

    const segmentScale = THREE.MathUtils.lerp(0.6, 1.0, complexity);
    if (opts.branch?.segments) {
      Object.keys(opts.branch.segments).forEach((level) => {
        const base = opts.branch.segments[level] || 4;
        opts.branch.segments[level] = Math.max(3, Math.round(base * segmentScale));
      });
    }

    if (opts.branch?.gnarliness) {
      const gnarlScale = THREE.MathUtils.lerp(0.5, 1.0, complexity);
      Object.keys(opts.branch.gnarliness).forEach((level) => {
        opts.branch.gnarliness[level] = (opts.branch.gnarliness[level] || 0.1) * gnarlScale;
      });
    }

    if (opts.branch?.force?.strength != null) {
      opts.branch.force.strength *= THREE.MathUtils.lerp(0.6, 1.0, complexity);
    }

    if (opts.leaves?.count != null) {
      // Adjust leaf density based on biome and climate
      let baseLeafCount;
      switch (profile) {
        case 'boreal':
          baseLeafCount = 3;   // Sparse needles on conifers
          break;
        case 'temperate-cool':
          baseLeafCount = 8;   // Moderate foliage
          break;
        case 'temperate-warm':
          baseLeafCount = 14;  // Fuller deciduous leaves
          break;
        case 'subtropical':
          baseLeafCount = 18;  // Dense subtropical foliage
          break;
        case 'tropical':
          baseLeafCount = 24;  // Very dense tropical leaves
          break;
        default:
          baseLeafCount = 12;
      }
      const countScale = THREE.MathUtils.lerp(0.4, 1.25, complexity);
      opts.leaves.count = Math.max(2, Math.round(baseLeafCount * seedNoise(12, 0.8, 1.4) * countScale));
    }

    if (opts.leaves?.size != null) {
      const sizeScale = THREE.MathUtils.lerp(0.8, 1.15, complexity);
      opts.leaves.size = seedNoise(13, 1.6, 3.5) * sizeScale;
    }

    if (opts.leaves?.sizeVariance != null) {
      const varianceScale = THREE.MathUtils.lerp(0.6, 1.05, complexity);
      opts.leaves.sizeVariance = seedNoise(14, 0.35, 0.8) * varianceScale;
    }

    if (opts.leaves?.billboard != null && Billboard) {
      opts.leaves.billboard = complexity < 0.5
        ? (Billboard.Single ?? opts.leaves.billboard)
        : (Billboard.Double ?? opts.leaves.billboard);
    }
  }
  _scheduleTreeRefresh() {
    if (!this.tiles?.size) return;
    if (Array.isArray(this._treeRegenQueue) && this._treeRegenQueue.length) return;
    const tiles = Array.from(this.tiles.values()).filter((tile) => tile && tile.type === 'interactive');
    if (!tiles.length) return;
    this._treeRegenQueue = tiles;
  }

  _serviceTreeRefresh() {
    // DISABLED: Don't regenerate trees on complexity changes
    // Trees should stay stable with only LOD adjustments (leaf density)
    // This prevents "flapping" when moving around
    return;

    // OLD CODE DISABLED - was causing tree regeneration
    /*
    if (!Array.isArray(this._treeRegenQueue) || !this._treeRegenQueue.length) return;
    const start = performance?.now ? performance.now() : Date.now();
    const budgetMs = 1.2;
    let processed = 0;
    while (this._treeRegenQueue.length && processed < maxTilesPerFrame) {
      if (performance?.now && performance.now() - start > budgetMs) break;
      const tile = this._treeRegenQueue.shift();
      if (!tile || !this.tiles.has(`${tile.q},${tile.r}`)) continue;
      if (tile._overlay?.status !== 'ready') {
        this._treeRegenQueue.push(tile);
        processed += 1;
        continue;
      }
      const entryKey = tile._overlay?.cacheKey;
      const entry = entryKey ? this._overlayCache.get(entryKey) : null;
      if (!entry || !Array.isArray(entry.samples) || !entry.samples.length) {
        this._treeRegenQueue.push(tile);
        processed += 1;
        continue;
      }
      this._applyTreeSeeds(tile, entry);
      processed += 1;
    }
    if (!this._treeRegenQueue.length) {
      this._treeRegenQueue = null;
    }
    */
  }



  async _spawnTreesForTile(tile, worldPositions = []) {
    try {
      this._clearTileTrees(tile);
      if (!this._treeEnabled || !worldPositions.length) return;

      const treeLib = await this._ensureTreeLibrary();
      if (!treeLib || !treeLib.Tree) return;

      const complexity = THREE.MathUtils.clamp(this._treeComplexity ?? 0.35, 0.2, 1);
      const jitterRange = THREE.MathUtils.lerp(0.6, 1.6, complexity);
      const basePos = tile.grid.group.position;
      const group = new THREE.Group();
      group.name = 'tile-trees';

      tile._treeInstances = [];
      tile._treeSamples = [];

      for (const pos of worldPositions) {
        const jitterX = THREE.MathUtils.randFloatSpread(jitterRange);
        const jitterZ = THREE.MathUtils.randFloatSpread(jitterRange);
        const localX = pos.x - basePos.x + jitterX;
        const localZ = pos.z - basePos.z + jitterZ;
        const worldX = basePos.x + localX;
        const worldZ = basePos.z + localZ;
        const groundY = this.getHeightAt(worldX, worldZ);
        if (!Number.isFinite(groundY)) continue;

        const seed = this._hashTreeSeed(worldX, worldZ);
        const latLon = this.origin ? worldToLatLon(worldX, worldZ, this.origin.lat, this.origin.lon) : null;
        const tree = new treeLib.Tree();

        this._configureTreeForRegion(tree, latLon, seed, treeLib);
        try {
          tree.generate();
        } catch (err) {
          console.warn('[tiles] ez-tree generation failed', err);
          continue;
        }

        const scaleBase = THREE.MathUtils.lerp(0.5, 0.98, complexity);
        const scaleVariance = THREE.MathUtils.lerp(0.2, 0.45, complexity);
        const scaleNoise = this._seededRandom(seed, 80) - 0.5;
        const scale = THREE.MathUtils.clamp(scaleBase + scaleNoise * scaleVariance, 0.32, 1.3);
        tree.scale.setScalar(scale);
        tree.position.set(localX, groundY, localZ);
        tree.rotation.y = this._seededRandom(seed, 3) * Math.PI * 2;
        tree.userData.anchor = { worldX, worldZ, seed };

        tree.traverse((child) => {
          if (child.isMesh || child.isPoints) {
            child.castShadow = true;
            child.receiveShadow = !child.isPoints;
          }
        });

        group.add(tree);
        tile._treeInstances.push({ object: tree, worldX, worldZ });
        tile._treeSamples.push({ x: worldX, z: worldZ });
      }

      if (!tile._treeInstances.length) {
        tile._treeInstances = null;
        tile._treeSamples = null;
        return;
      }

      tile.grid.group.add(group);
      tile._treeGroup = group;
      this._resnapTreesForTile(tile);
    } catch (err) {
      console.warn('[tiles] tree generation aborted', err);
    }
  }

  _resnapTreesForTile(tile) {
    if (!tile || !tile._treeInstances || !tile._treeInstances.length) return;
    let anyVisible = false;
    for (const inst of tile._treeInstances) {
      const height = this.getHeightAt(inst.worldX, inst.worldZ);
      if (!Number.isFinite(height)) {
        inst.object.visible = false;
        continue;
      }
      inst.object.visible = true;
      inst.object.position.y = height;
      anyVisible = true;
    }
    if (tile._treeGroup) tile._treeGroup.visible = anyVisible;
  }

  _onTreeHeightSample(sample = {}) {
    const tile = sample?.tile;
    if (!tile || !tile._treeInstances || !tile._treeInstances.length) return;
    if (tile._treeSnapScheduled) return;

    // CRITICAL: During warmup, defer tree resnap to prevent RAF flooding
    // Hundreds of tiles populating simultaneously would queue hundreds of RAF callbacks
    if (this._relayWarmupActive) {
      // Mark for resnap but don't schedule RAF yet - will be handled after warmup
      tile._treeResnapPending = true;
      return;
    }

    tile._treeSnapScheduled = true;
    requestAnimationFrame(() => {
      tile._treeSnapScheduled = false;
      this._resnapTreesForTile(tile);
    });
  }

  _processPendingTreeResnaps() {
    // CRITICAL: Process deferred tree resnaps gradually after warmup
    // Spread across multiple frames to avoid RAF spike
    const tilesToResnap = [];
    for (const tile of this.tiles.values()) {
      if (tile._treeResnapPending) {
        tilesToResnap.push(tile);
        tile._treeResnapPending = false;
      }
    }

    if (!tilesToResnap.length) return;

    // Process 3-5 tiles per frame
    const perFrame = this._isMobile ? 2 : 4;
    let currentIndex = 0;

    const processNextBatch = () => {
      const end = Math.min(currentIndex + perFrame, tilesToResnap.length);
      for (let i = currentIndex; i < end; i++) {
        const tile = tilesToResnap[i];
        if (tile && tile._treeInstances?.length) {
          this._resnapTreesForTile(tile);
        }
      }
      currentIndex = end;

      if (currentIndex < tilesToResnap.length) {
        requestAnimationFrame(processNextBatch);
      }
    };

    requestAnimationFrame(processNextBatch);
  }

  _disposeTreeObject(obj) {
    if (!obj) return;
    obj.traverse((child) => {
      if (child.isMesh || child.isPoints || child.isLine) {
        if (child.geometry) child.geometry.dispose?.();
        if (child.material) {
          if (Array.isArray(child.material)) child.material.forEach((mat) => mat?.dispose?.());
          else child.material.dispose?.();
        }
      }
    });
  }

  _clearTileTrees(tile) {
    if (!tile) return;
    if (tile._treeGroup) {
      try { tile.grid.group.remove(tile._treeGroup); } catch { }
    }
    tile._treeGroup = null;
    tile._treeSnapScheduled = false;
    if (Array.isArray(tile._treeInstances)) {
      for (const inst of tile._treeInstances) {
        this._disposeTreeObject(inst?.object);
      }
      tile._treeInstances.length = 0;
    }
    tile._treeInstances = null;
    if (tile._treeSamples) tile._treeSamples.length = 0;
  }
  _prepareRoadStamp(stamp) {
    if (!stamp || !Array.isArray(stamp.points) || stamp.points.length < 2) return null;

    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;

    for (const pt of stamp.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.z < minZ) minZ = pt.z;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.z > maxZ) maxZ = pt.z;
    }

    const preparedSegments = [];
    if (Array.isArray(stamp.rawSegments) && stamp.rawSegments.length) {
      for (const seg of stamp.rawSegments) {
        if (!seg) continue;
        const ax = Number(seg.ax);
        const ay = Number(seg.ay);
        const az = Number(seg.az);
        const bx = Number(seg.bx);
        const by = Number(seg.by);
        const bz = Number(seg.bz);
        if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) continue;
        let dirX = bx - ax;
        let dirZ = bz - az;
        const lenSq = dirX * dirX + dirZ * dirZ;
        if (lenSq < 1e-6) continue;
        const len = Math.sqrt(lenSq);
        dirX /= len;
        dirZ /= len;
        const perpX = -dirZ;
        const perpZ = dirX;
        const halfWidth = Math.max(0.1, Number.isFinite(seg.halfWidth) ? seg.halfWidth : (stamp.width * 0.5));
        preparedSegments.push({
          ax, ay, az, bx, by, bz,
          dirX,
          dirZ,
          len,
          perpX,
          perpZ,
          halfWidth,
        });
        const offsetX = perpX * halfWidth;
        const offsetZ = perpZ * halfWidth;
        const candidates = [
          { x: ax + offsetX, z: az + offsetZ },
          { x: ax - offsetX, z: az - offsetZ },
          { x: bx + offsetX, z: bz + offsetZ },
          { x: bx - offsetX, z: bz - offsetZ },
        ];
        for (const c of candidates) {
          if (c.x < minX) minX = c.x;
          if (c.z < minZ) minZ = c.z;
          if (c.x > maxX) maxX = c.x;
          if (c.z > maxZ) maxZ = c.z;
        }
      }
    }

    if (!preparedSegments.length) {
      const centerSegments = [];
      for (let i = 0; i < stamp.points.length - 1; i++) {
        const a = stamp.points[i];
        const b = stamp.points[i + 1];
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const lenSq = dx * dx + dz * dz;
        if (lenSq < 1e-8) continue;
        centerSegments.push({
          ax: a.x,
          az: a.z,
          bx: b.x,
          bz: b.z,
          dx,
          dz,
          lenSq,
        });
      }
      stamp.centerSegments = centerSegments;
      const pad = Math.max(0.1, (stamp.width ?? this.tileRadius * 0.6) * 0.5);
      minX -= pad;
      maxX += pad;
      minZ -= pad;
      maxZ += pad;
    } else {
      stamp.centerSegments = null;
    }

    if (!Number.isFinite(minX)) minX = stamp.points[0]?.x ?? 0;
    if (!Number.isFinite(minZ)) minZ = stamp.points[0]?.z ?? 0;
    if (!Number.isFinite(maxX)) maxX = minX;
    if (!Number.isFinite(maxZ)) maxZ = minZ;

    stamp.segmentData = preparedSegments;
    stamp.bounds = { minX, minZ, maxX, maxZ };

    const minHalf = preparedSegments.reduce((acc, seg) => Math.min(acc, seg.halfWidth), Infinity);
    const maxHalf = preparedSegments.reduce((acc, seg) => Math.max(acc, seg.halfWidth), 0);
    const baseWidth = Math.max(0.5, stamp.width ?? 1);
    const coreRadius = Number.isFinite(minHalf) ? Math.max(0.15, minHalf) : Math.max(0.15, baseWidth * 0.5);
    const falloffBase = Number.isFinite(stamp.falloff) ? stamp.falloff : (Number.isFinite(maxHalf) && maxHalf > 0 ? maxHalf * 1.1 : baseWidth * 0.65);
    const falloff = Math.max(coreRadius + 0.2, falloffBase);

    stamp.coreRadius = coreRadius;
    stamp.falloff = falloff;
    stamp.falloffSq = falloff * falloff;
    stamp.strength = THREE.MathUtils.clamp(stamp.strength ?? 0.6, 0, 0.95);
    return stamp;
  }
  _minDistanceSqToStamp(stamp, x, z) {
    if (stamp?.segmentData?.length) {
      let min = Infinity;
      for (const seg of stamp.segmentData) {
        const relX = x - seg.ax;
        const relZ = z - seg.az;
        const rawProj = relX * seg.dirX + relZ * seg.dirZ;
        const proj = THREE.MathUtils.clamp(rawProj, 0, seg.len);
        const px = seg.ax + seg.dirX * proj;
        const pz = seg.az + seg.dirZ * proj;
        const offX = x - px;
        const offZ = z - pz;
        const lateral = offX * seg.perpX + offZ * seg.perpZ;
        const radial = Math.max(0, Math.abs(lateral) - seg.halfWidth);
        const longitudinal = Math.abs(rawProj - proj);
        const dist = Math.hypot(radial, longitudinal);
        const distSq = dist * dist;
        if (distSq < min) min = distSq;
        if (min <= 0) break;
      }
      return min;
    }
    if (stamp?.centerSegments?.length) {
      let minSq = Infinity;
      for (const seg of stamp.centerSegments) {
        const vx = x - seg.ax;
        const vz = z - seg.az;
        const t = THREE.MathUtils.clamp((vx * seg.dx + vz * seg.dz) / seg.lenSq, 0, 1);
        const px = seg.ax + seg.dx * t;
        const pz = seg.az + seg.dz * t;
        const dx = x - px;
        const dz = z - pz;
        const distSq = dx * dx + dz * dz;
        if (distSq < minSq) minSq = distSq;
        if (minSq <= 0) break;
      }
      return minSq;
    }
    return Infinity;
  }
  _roadMaskValueForDistance(dist, stamp) {
    const core = stamp.coreRadius;
    const fall = stamp.falloff;
    const strength = stamp.strength;
    if (dist <= core) {
      return Math.max(0.15, 1 - strength);
    }
    const span = Math.max(1e-5, fall - core);
    const t = THREE.MathUtils.clamp((dist - core) / span, 0, 1);
    const smooth = t * t * (3 - 2 * t);
    const base = Math.max(0.15, 1 - strength);
    return THREE.MathUtils.clamp(base + strength * smooth, 0.1, 1);
  }
  _applyRoadStampToTile(tile, stamp) {
    if (!tile || !stamp) return false;
    if (!tile.pos || !tile.grid?.group) return false;
    const mask = this._ensureRoadMask(tile);
    if (!mask) return false;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const bounds = stamp.bounds || null;
    const pad = Number.isFinite(stamp.falloff) ? stamp.falloff : 0;
    let changed = false;
    for (let i = 0; i < pos.count; i++) {
      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);
      if (bounds) {
        if (wx < bounds.minX - pad || wx > bounds.maxX + pad) continue;
        if (wz < bounds.minZ - pad || wz > bounds.maxZ + pad) continue;
      }
      const distSq = this._minDistanceSqToStamp(stamp, wx, wz);
      if (distSq > stamp.falloffSq) continue;
      const dist = Math.sqrt(distSq);
      const value = this._roadMaskValueForDistance(dist, stamp);
      if (value < mask[i]) {
        mask[i] = value;
        changed = true;
      }
    }
    return changed;
  }
  _applyExistingRoadStampsToTile(tile) {
    if (!this._roadStamps.length) return;
    this._repaintTileRoadMask(tile);
  }
  _reapplyAllRoadStamps() {
    if (!this._roadStamps.length) {
      for (const tile of this.tiles.values()) {
        if (!tile || !tile.pos) continue;
        this._ensureRoadMask(tile, { reset: true });
        this._applyAllColorsGlobal(tile);
      }
      return;
    }

    for (const tile of this.tiles.values()) {
      if (!tile || !tile.pos) continue;
      this._ensureRoadMask(tile, { reset: true });
    }

    for (const tile of this.tiles.values()) {
      if (!tile || !tile.pos || !tile.grid?.group) continue;
      this._repaintTileRoadMask(tile);
    }
  }
  _reapplyRoadStampsForStamp(stamp) {
    if (!stamp) return;
    const hasSegments = stamp.segmentData?.length || stamp.centerSegments?.length;
    if (!hasSegments) return;
    const pad = Number.isFinite(stamp.falloff) ? stamp.falloff : 0;
    for (const tile of this.tiles.values()) {
      if (!tile || tile.type !== 'interactive' || !tile.pos || !tile.grid?.group) continue;
      const center = tile.grid.group.position;
      const tileRadiusWorld = tile._radiusOverride ?? this.tileRadius;
      const radius = tileRadiusWorld + pad;
      const radiusSq = radius * radius;
      const distSq = this._minDistanceSqToStamp(stamp, center.x, center.z);
      if (distSq > radiusSq) continue;
      this._repaintTileRoadMask(tile);
    }
  }
  _repaintTileRoadMask(tile) {
    if (!tile || !tile.pos || !tile.grid?.group) return;
    this._ensureRoadMask(tile, { reset: true });
    if (tile.type !== 'interactive') {
      this._applyAllColorsGlobal(tile);
      return;
    }
    const center = tile.grid.group.position;
    const tileRadiusWorld = tile._radiusOverride ?? this.tileRadius;
    for (const stamp of this._roadStamps) {
      if (!stamp) continue;
      const hasSegments = stamp.segmentData?.length || stamp.centerSegments?.length;
      if (!hasSegments) continue;
      const radius = tileRadiusWorld + stamp.falloff;
      const radiusSq = radius * radius;
      const distSq = this._minDistanceSqToStamp(stamp, center.x, center.z);
      if (distSq > radiusSq) continue;
      this._applyRoadStampToTile(tile, stamp);
    }
    this._applyAllColorsGlobal(tile);
  }
  applyRoadPaint({
    id = null,
    points = [],
    segments = [],
    width = this.tileRadius * 0.6,
    strength = 0.6,
    falloff = null,
  } = {}) {
    if (!Array.isArray(points) || points.length < 2) return;
    const sanitizedPoints = [];
    for (const p of points) {
      if (!p) continue;
      const x = Number.isFinite(p.x) ? p.x : (Array.isArray(p) && Number.isFinite(p[0]) ? p[0] : null);
      const z = Number.isFinite(p.z) ? p.z : (Array.isArray(p) && Number.isFinite(p[1]) ? p[1] : null);
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
      sanitizedPoints.push({ x, z });
    }
    if (sanitizedPoints.length < 2) return;

    const sanitizedSegments = Array.isArray(segments)
      ? segments
        .map((seg) => {
          if (!seg) return null;
          const ax = Number(seg.ax);
          const ay = Number(seg.ay);
          const az = Number(seg.az);
          const bx = Number(seg.bx);
          const by = Number(seg.by);
          const bz = Number(seg.bz);
          const halfWidth = Number(seg.halfWidth);
          if (![ax, ay, az, bx, by, bz].every(Number.isFinite)) return null;
          return {
            ax, ay, az,
            bx, by, bz,
            halfWidth: Number.isFinite(halfWidth) ? halfWidth : undefined,
          };
        })
        .filter(Boolean)
      : [];

    const stampId = id || `road-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const existed = this._roadStampIndex.has(stampId);
    let stamp = existed ? (this._roadStamps[this._roadStampIndex.get(stampId)] || null) : null;
    if (existed && !stamp) return;

    const widthClamped = Math.max(0.5, width);
    const strengthClamped = THREE.MathUtils.clamp(strength ?? 0.6, 0, 0.95);

    if (existed) {
      stamp.points = sanitizedPoints;
      stamp.rawSegments = sanitizedSegments;
      stamp.width = widthClamped;
      stamp.strength = strengthClamped;
      stamp.falloff = falloff;
      stamp.id = stampId;
    } else {
      stamp = {
        id: stampId,
        points: sanitizedPoints,
        rawSegments: sanitizedSegments,
        width: widthClamped,
        strength: strengthClamped,
        falloff,
      };
      this._roadStampIndex.set(stampId, this._roadStamps.length);
      this._roadStamps.push(stamp);
    }

    this._prepareRoadStamp(stamp);
    if (existed) this._reapplyAllRoadStamps();
    else this._reapplyRoadStampsForStamp(stamp);
  }

  _collectTileLatLon(tile) {
    const pos = tile.pos;
    const out = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const wx = tile.grid.group.position.x + pos.getX(i);
      const wz = tile.grid.group.position.z + pos.getZ(i);
      const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
      const lat = Number.isFinite(ll?.lat) ? ll.lat : this.origin.lat;
      const lon = Number.isFinite(ll?.lon) ? ll.lon : this.origin.lon;
      out[i] = { lat: Number(lat.toFixed(6)), lng: Number(lon.toFixed(6)) };
    }
    return out;
  }

  _indicesToBatchesLatLng(indices, latLon) {
    const batches = [];
    let cur = [];
    let curBytes = 0;
    for (const idx of indices) {
      const loc = latLon[idx];
      const candidate = { type: 'elev.query', dataset: this.relayDataset, locations: cur.concat([loc]) };
      const bytes = this._encoder.encode(JSON.stringify(candidate)).length;
      if (bytes <= DM_BUDGET_BYTES && candidate.locations.length <= MAX_LOCATIONS_PER_BATCH) {
        cur.push(loc);
        curBytes = bytes;
      } else {
        if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes });
        cur = [loc];
        curBytes = this._encoder.encode(JSON.stringify({ type: 'elev.query', dataset: this.relayDataset, locations: cur })).length;
      }
    }
    if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes });
    return batches;
  }

  _indicesToBatchesGeohash(indices, geohashes, precision) {
    const meta = { enc: 'geohash', prec: precision };
    const batches = [];
    let cur = [];
    let curBytes = 0;
    for (const idx of indices) {
      const gh = geohashes[idx];
      const candidate = { type: 'elev.query', dataset: this.relayDataset, geohashes: cur.concat([gh]), ...meta };
      const bytes = this._encoder.encode(JSON.stringify(candidate)).length;
      if (bytes <= DM_BUDGET_BYTES && candidate.geohashes.length <= MAX_LOCATIONS_PER_BATCH) {
        cur.push(gh);
        curBytes = bytes;
      } else {
        if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes, meta });
        cur = [gh];
        curBytes = this._encoder.encode(JSON.stringify({ type: 'elev.query', dataset: this.relayDataset, geohashes: cur, ...meta })).length;
      }
    }
    if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes, meta });
    return batches;
  }

  _applyRelayResults(tile, results, { mode, indexByLatLon, indexByGeohash }) {
    // CRITICAL: Batch sample updates to reduce GPU sync stalls
    // Instead of marking needsUpdate per sample, collect all updates and mark once
    const updates = [];

    for (const res of results) {
      let idx;
      if (mode === 'geohash') {
        const key = res.geohash || res.hash;
        idx = key ? indexByGeohash?.get(key) : undefined;
      } else if (res.location) {
        const { lat, lng } = res.location;
        const key = `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
        idx = indexByLatLon?.get(key);
      }
      if (idx == null) continue;
      const rawHeight = res?.elev ?? res?.height ?? res?.z ?? res?.h ?? res?.value ?? res?.elevation;
      const height = rawHeight != null ? Number(rawHeight) : NaN;
      if (!Number.isFinite(height)) continue;
      // unlock if we had pinned this vertex previously
      if (tile.locked) tile.locked[idx] = 0;
      updates.push({ idx, height });
    }

    // Apply all samples in batch
    if (updates.length > 0) {
      this._applySampleBatch(tile, updates);
    }
  }

  _applySampleBatch(tile, updates) {
    // CRITICAL: Process multiple samples in single batch to minimize GPU sync
    const pos = tile.pos;
    if (!tile.col) this._ensureColorAttr(tile);

    // CRITICAL: Track samples for batch listener notification to prevent RAF flooding
    const listenerSamples = [];

    for (const { idx, height } of updates) {
      // Update position
      pos.setY(idx, height);

      // Update readiness tracking
      if (tile.ready[idx] !== 1) tile.unreadyCount = Math.max(0, tile.unreadyCount - 1);
      tile.ready[idx] = 1;
      tile.fetched.add(idx);
      tile._fetchedEver = true;

      // Release pin
      if (tile.locked) tile.locked[idx] = 0;

      // Update buffer
      this._pullGeometryToBuffers(tile, idx);
      this._updateGlobalFromValue(height);

      // Update color
      const o = 3 * idx;
      const color = this._colorFromNormalized(this._normalizedHeight(height));
      tile.col.array[o] = color.r;
      tile.col.array[o + 1] = color.g;
      tile.col.array[o + 2] = color.b;

      // Collect samples for batch notification (don't fire per-sample)
      if (this._heightListeners?.size) {
        const wx = tile.grid.group.position.x + tile.pos.getX(idx);
        const wy = height;
        const wz = tile.grid.group.position.z + tile.pos.getZ(idx);
        listenerSamples.push({ tile, idx, wx, wy, wz });
      }
    }

    // CRITICAL: Fire height listeners ONCE per batch, not per sample
    // This prevents thousands of RAF callbacks flooding the main thread during NKN connect
    if (listenerSamples.length > 0) {
      this._notifyHeightListenersBatch(tile, listenerSamples);
    }

    // CRITICAL: Mark needsUpdate ONCE for entire batch instead of per sample
    pos.needsUpdate = true;
    tile.col.needsUpdate = true;
    if (tile.grid?.mesh?.material) tile.grid.mesh.material.needsUpdate = true;

    // Mark farfield adapter dirty if this is a farfield tile
    if (tile.type === 'farfield') {
      this._markFarfieldAdapterDirty(tile);
    }
  }

  _applySample(tile, idx, height) {
    // Legacy single-sample path - use batch internally
    this._applySampleBatch(tile, [{ idx, height }]);
  }

  _nearestAnchorFill(tile) {
    const ready = tile.ready;
    const locked = tile.locked || new Uint8Array(tile.pos.count);
    const pos = tile.pos;
    const n = pos.count;
    const nearest = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0; let tail = 0;

    for (let i = 0; i < n; i++) {
      // treat locked surface as seeds too
      if (ready[i] || locked[i]) {
        nearest[i] = i;
        queue[tail++] = i;
      }
    }
    if (tail === 0) return;

    while (head < tail) {
      const cur = queue[head++];
      for (const nbr of tile.neighbors[cur]) {
        if (nearest[nbr] !== -1) continue;
        nearest[nbr] = nearest[cur];
        queue[tail++] = nbr;
      }
    }

    for (let i = 0; i < n; i++) {
      if (ready[i] || locked[i]) continue;
      const src = nearest[i];
      if (src === -1) continue;
      const y = pos.getY(src);
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    if (tile.col) tile.col.needsUpdate = true;
  }

  _smoothUnknowns(tile, iterations = 1) {
    const pos = tile.pos;
    const ready = tile.ready;
    const locked = tile.locked || new Uint8Array(pos.count);
    const next = new Float32Array(pos.count);

    for (let iter = 0; iter < iterations; iter++) {
      let touched = false;
      for (let i = 0; i < pos.count; i++) {
        if (ready[i] || locked[i]) continue;
        let sum = 0;
        let cnt = 0;
        for (const nbr of tile.neighbors[i]) {
          const y = pos.getY(nbr);
          if (Number.isFinite(y)) { sum += y; cnt++; }
        }
        if (cnt >= 2) {
          const val = sum / cnt;
          next[i] = val;
          touched = true;
        } else {
          next[i] = pos.getY(i);
        }
      }
      if (!touched) break;
      for (let i = 0; i < pos.count; i++) {
        if (ready[i] || locked[i]) continue;
        pos.setY(i, next[i]);
      }
      pos.needsUpdate = true;
    }
  }

  /* ---------- caching helpers ---------- */

  _originKeyForCache(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'na';
    const quant = (value) => (Math.round(value * 100000) / 100000).toFixed(5);
    return `${quant(lat)},${quant(lon)}`;
  }
  _cacheKey(tile) {
    const originKey = this._originCacheKey || 'na';
    const datasetKey = (this.relayDataset || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40);
    const effRadius = (tile && tile._radiusOverride) ? tile._radiusOverride : this.tileRadius;
    const sampleMode = (tile && tile._farSampleMode) ? tile._farSampleMode : 'all';
    return `tile:${this.CACHE_VER}:${originKey}:${tile.type}:${this.spacing}:${effRadius}:${datasetKey}:${this.relayMode}:${sampleMode}:${tile.q},${tile.r}`;
  }


  _tryLoadTileFromCache(tile) {
    try {
      const key = this._cacheKey(tile);
      const raw = localStorage.getItem(key);
      if (!raw) return false;

      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.y)) return false;
      if (data.spacing !== this.spacing || data.tileRadius !== this.tileRadius) return false;
      if (data.type !== tile.type) return false;
      if (data.y.length !== tile.pos.count) return false;

      const pos = tile.pos;
      for (let i = 0; i < data.y.length; i++) pos.setY(i, data.y[i]);
      pos.needsUpdate = true;
      if (tile.type !== 'farfield') tile.grid.geometry.computeVertexNormals();

      tile.ready = new Uint8Array(tile.pos.count);
      tile.ready.fill(1);
      tile.fetched = new Set();
      tile.populating = false;
      tile.unreadyCount = 0;
      if (tile._retryCounts) {
        if ('seed' in tile._retryCounts) tile._retryCounts.seed = 0;
        if ('edge' in tile._retryCounts) tile._retryCounts.edge = 0;
        if ('full' in tile._retryCounts) tile._retryCounts.full = 0;
      }

      this._ensureTileBuffers(tile);
      this._pullGeometryToBuffers(tile);

      this._updateGlobalFromArray(data.y);
      this._applyAllColorsGlobal(tile);

      // consider interactive cache as full-done
      if (!tile._phase) tile._phase = {};
      if (tile.type === 'interactive') {
        tile._phase.seedDone = true;
        tile._phase.edgeDone = true;
        tile._phase.fullDone = true;
        tile.relaxEnabled = false;
      } else {
        tile._phase.fullDone = true;
      }

      if (!this._tileNeedsFetch(tile)) this._tryAdvanceFetchPhase(tile);
      return true;
    } catch { return false; }
  }
  _saveTileToCache(tile) {
    try {
      const pos = tile.pos;
      const y = new Array(pos.count);
      for (let i = 0; i < pos.count; i++) y[i] = +pos.getY(i).toFixed(2);
      const payload = {
        v: this.CACHE_VER,
        type: tile.type,
        spacing: this.spacing,
        tileRadius: this.tileRadius,
        q: tile.q,
        r: tile.r,
        y
      };

      // Include farfield-specific metadata for proper restoration
      if (tile.type === 'farfield') {
        payload.scale = tile.scale || 1;
        payload.sampleMode = tile._farSampleMode || 'all';
      }

      localStorage.setItem(this._cacheKey(tile), JSON.stringify(payload));
      if (tile.type === 'interactive') {
        try { localStorage.removeItem(this._seedCacheKey(tile)); } catch { /* ignore */ }
      }
    } catch { /* ignore quota */ }
  }

  _seedCacheKey(tile) {
    const originKey = this._originCacheKey || 'na';
    const datasetKey = (this.relayDataset || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40);
    return `tileSeed:${this.CACHE_VER}:${originKey}:${this.spacing}:${this.tileRadius}:${datasetKey}:${this.relayMode}:${tile.q},${tile.r}`;
  }

  _saveInteractiveSeed(tile) {
    if (!tile || tile.type !== 'interactive') return;
    if (!tile._phase?.seedDone || tile._phase?.edgeDone) return;
    if (!tile.fetched || tile.fetched.size === 0) return;
    try {
      const pos = tile.pos;
      const y = new Array(pos.count);
      for (let i = 0; i < pos.count; i++) y[i] = +pos.getY(i).toFixed(2);
      const samples = Array.from(tile.fetched).map((idx) => ({
        i: idx,
        y: +pos.getY(idx).toFixed(2),
      }));
      if (!samples.length) return;
      const payload = {
        v: this.CACHE_VER,
        phase: 'seed',
        type: 'interactive',
        spacing: this.spacing,
        tileRadius: this.tileRadius,
        q: tile.q,
        r: tile.r,
        y,
        samples,
      };
      localStorage.setItem(this._seedCacheKey(tile), JSON.stringify(payload));
    } catch { /* ignore */ }
  }

  _tryLoadInteractiveSeed(tile) {
    if (!tile || tile.type !== 'interactive') return false;
    try {
      const raw = localStorage.getItem(this._seedCacheKey(tile));
      if (!raw) return false;

      const data = JSON.parse(raw);
      if (!data || data.phase !== 'seed') return false;
      if (data.spacing !== this.spacing || data.tileRadius !== this.tileRadius) return false;
      if (!Array.isArray(data.y) || data.y.length !== tile.pos.count) return false;

      const pos = tile.pos;
      for (let i = 0; i < data.y.length; i++) pos.setY(i, data.y[i]);
      pos.needsUpdate = true;
      tile.grid.geometry.computeVertexNormals?.();

      const ready = tile.ready;
      if (ready && ready.length === pos.count) ready.fill(0);
      else tile.ready = new Uint8Array(pos.count);

      tile.fetched?.clear?.();
      if (!tile.fetched) tile.fetched = new Set();

      let readyCount = 0;
      if (Array.isArray(data.samples)) {
        for (const sample of data.samples) {
          const idx = Number(sample?.i);
          const val = Number(sample?.y);
          if (!Number.isInteger(idx) || idx < 0 || idx >= pos.count) continue;
          if (!Number.isFinite(val)) continue;
          tile.ready[idx] = 1;
          tile.fetched.add(idx);
          readyCount += 1;
        }
      }
      if (readyCount === 0) return false;

      tile.unreadyCount = Math.max(0, pos.count - readyCount);
      tile.populating = false;
      if (!tile._phase) tile._phase = {};
      tile._phase.seedDone = true;
      tile._phase.edgeDone = false;
      tile._phase.fullDone = false;
      tile.relaxEnabled = false;
      if (tile._retryCounts) {
        tile._retryCounts.seed = 0;
        if ('edge' in tile._retryCounts) tile._retryCounts.edge = 0;
        if ('full' in tile._retryCounts) tile._retryCounts.full = 0;
      }

      this._ensureTileBuffers(tile);
      this._pullGeometryToBuffers(tile);
      this._updateGlobalFromArray(data.y);
      this._applyAllColorsGlobal(tile);
      this._ensureTileOverlay(tile);

      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- Restore tiles from cache on reload ---------------- */

  _restoreTilesFromCache() {
    if (!this.origin || !this._originCacheKey || this._originCacheKey === 'na') {
      return 0;
    }

    const tilePrefix = `tile:${this.CACHE_VER}:${this._originCacheKey}:`;
    let restoredCount = 0;

    try {
      // Scan localStorage for cached tiles matching current origin
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(tilePrefix)) continue;

        try {
          const raw = localStorage.getItem(key);
          if (!raw) continue;

          const data = JSON.parse(raw);
          if (!data || !Array.isArray(data.y)) continue;
          if (data.spacing !== this.spacing) continue;

          // Extract tile coordinates from the cache key
          const parts = key.split(':');
          if (parts.length < 10) continue;

          const coordStr = parts[parts.length - 1]; // Last part is "q,r"
          const coords = coordStr.split(',');
          if (coords.length !== 2) continue;

          const q = parseInt(coords[0], 10);
          const r = parseInt(coords[1], 10);
          if (!Number.isFinite(q) || !Number.isFinite(r)) continue;

          const id = `${q},${r}`;
          if (this.tiles.has(id)) continue; // Skip if tile already exists

          // Determine tile type from cache data
          const tileType = data.type || 'interactive';

          // Create the tile based on its type
          let tile = null;
          if (tileType === 'interactive') {
            tile = this._addInteractiveTile(q, r);
          } else if (tileType === 'visual') {
            tile = this._addVisualTile(q, r);
          } else if (tileType === 'farfield') {
            const scale = data.scale || 1;
            const sampleMode = data.sampleMode || 'all';
            tile = this._addFarfieldTile(q, r, scale, sampleMode);
          }

          if (!tile) continue;

          // The tile creation already tried to load from cache, so if it succeeded
          // it's already loaded. We just count it.
          if (tile.unreadyCount === 0 || tile._phase?.fullDone) {
            restoredCount++;
          }

        } catch (err) {
          // Skip invalid cache entries
          console.warn('[tiles] Failed to restore cached tile:', err);
          continue;
        }
      }

      if (restoredCount > 0) {
        console.log(`[tiles] Restored ${restoredCount} tiles from cache`);
        this._invalidateHeightCache();
      }

    } catch (err) {
      console.warn('[tiles] Error during cache restoration:', err);
    }

    return restoredCount;
  }

  /* ---------------- creation: interactive tile ---------------- */

  _addInteractiveTile(q, r) {
    const id = `${q},${r}`;
    if (this.tiles.has(id)) return this.tiles.get(id);

    const grid = new UniformHexGrid(this.spacing, this.tileRadius * 2);
    grid.group.name = `tile-${id}`;
    const wp = this._axialWorld(q, r);
    grid.group.position.set(wp.x, 0, wp.z);
    this.scene.add(grid.group);
    // Set renderOrder to ensure proper layering: farfield < visual < interactive
    if (grid.mesh) grid.mesh.renderOrder = 0;

    const dist = this._hexDist(q, r, 0, 0);
    const interactiveFade = this._interactiveWireFade(dist);
    const wireMat = this._makeDisintegratingWireMaterial(this.INTERACTIVE_WIREFRAME_COLOR, interactiveFade);
    const wire = new THREE.Mesh(grid.geometry, wireMat);
    wire.frustumCulled = false; wire.renderOrder = 1;
    //grid.group.add(wire);
    //grid.wire = wire;

    const pos = grid.geometry.attributes.position;
    const neighbors = this._buildAdjacency(grid.geometry.getIndex(), pos.count);
    const ready = new Uint8Array(pos.count);

    const tile = {
      type: 'interactive',
      grid, q, r,
      pos,
      neighbors,
      ready,
      fetched: new Set(),
      populating: false,
      yA: null, yB: null, flip: false,
      normTick: 0,
      col: null,
      unreadyCount: pos.count,
      _phase: { seedDone: false, edgeDone: false, fullDone: false },
      _queuedPhases: new Set(),
      locked: new Uint8Array(pos.count),
      _visualEdgeLocks: new Set(),
      relaxEnabled: false,
      _retryCounts: { seed: 0, edge: 0, full: 0 },
      wire
    };
    this._ensureTileBuffers(tile);
    this.tiles.set(id, tile);
    const seededFromNeighbors = this._seedTileFromNeighbors(tile);

    this._initColorsNearBlack(tile);
    if (seededFromNeighbors) this._applyAllColorsGlobal(tile);
    if (this._roadStamps.length) this._applyExistingRoadStampsToTile(tile);
    this._ensureTileOverlay(tile);
    this._markRelaxListDirty();
    this._invalidateHeightCache();

    if (!this._tryLoadTileFromCache(tile)) {
      if (this._tryLoadInteractiveSeed(tile)) {
        this._deferredInteractive.add(tile);
        this._markRelaxListDirty();
        this._scheduleBackfill(0);
        this._tryAdvanceFetchPhase(tile);
      } else {
        this._queuePopulate(tile, true);
      }
    }
    return tile;
  }

  /* ---------------- creation: visual tile (7 verts) ---------------- */
  _makeLowResHexMeshForRadius(a) {
    const center = { x: 0, z: 0 };
    const corners = this._hexCorners(a);
    const verts = [center, ...corners];

    const pos = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      pos[3 * i + 0] = verts[i].x;
      pos[3 * i + 1] = 0;
      pos[3 * i + 2] = verts[i].z;
    }
    const idx = [];
    for (let i = 1; i <= 6; i++) { const j = i === 6 ? 1 : i + 1; idx.push(0, i, j); }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setIndex(idx);

    const cols = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) { const o = 3 * i; cols[o] = cols[o + 1] = cols[o + 2] = this.LUM_MIN; }
    geom.setAttribute('color', new THREE.BufferAttribute(cols, 3).setUsage(THREE.DynamicDrawUsage));
    // CRITICAL: Skip expensive normal computation on mobile
    if (!this._isMobile) {
      geom.computeVertexNormals();
    }

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    const mesh = new THREE.Mesh(geom, this._getTerrainMaterial());
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;

    const group = new THREE.Group(); group.add(mesh);
    return { group, mesh, geometry: geom, mat };
  }

  // pick stride/scale/sample strategy by distance
  _farfieldTierForDist(dist) {
    // tune these bands freely; goal is to cap #tiles & #queries
    if (dist <= this.VISUAL_RING + 24) return { stride: 3, scale: 3, samples: 'all', minPrec: 5 };
    if (dist <= this.VISUAL_RING + 128) return { stride: 6, scale: 6, samples: 'tips', minPrec: 4 };
    if (dist <= this.VISUAL_RING + 384) return { stride: 12, scale: 12, samples: 'tips', minPrec: 3 };
    return { stride: 24, scale: 24, samples: 'center', minPrec: 3 }; // absurd horizon: 1 sample/tile
  }

  // normalize modulo for negatives
  _divisible(n, k) { n = Math.round(n); k = Math.max(1, Math.round(k)); return ((n % k) + k) % k === 0; }

  // which indices to fetch for a farfield tile (geometry is [center, corner1..6])
  _farfieldSampleIndices(tile) {
    const mode = tile._farSampleMode || 'all';
    if (mode === 'tips') return [1, 2, 3, 4, 5, 6];
    // default: fetch everything (center + tips)
    return [0, 1, 2, 3, 4, 5, 6];
  }

  // after sparse fetch, fill the rest locally to avoid extra network
  _completeFarfieldFromSparse(tile) {
    const pos = tile.pos;
    const ready = tile.ready;
    const mode = tile._farSampleMode || 'all';

    if (mode === 'tips') {
      // set center to average of tips (gives large-scale slope continuity)
      let sum = 0, cnt = 0;
      for (let i = 1; i <= 6; i++) { const y = pos.getY(i); if (Number.isFinite(y)) { sum += y; cnt++; } }
      const cy = cnt ? (sum / cnt) : 0;
      pos.setY(0, cy);
    }
    for (let i = 0; i < pos.count; i++) ready[i] = 1;
    tile.unreadyCount = 0;
    pos.needsUpdate = true;
    // CRITICAL: Skip expensive normal computation on mobile
    if (!this._isMobile) {
      try { tile.grid.geometry.computeVertexNormals(); } catch { }
    }
    this._applyAllColorsGlobal(tile);
  }

  // effective spacing for a tile (used to choose coarse geohash precision)
  _effectiveSpacingForTile(tile) {
    const s = this.spacing;
    const sc = Number.isFinite(tile?.scale) ? tile.scale : 1;
    return s * Math.max(1, sc);
  }

  _makeLowResHexMesh() {
    const a = this.tileRadius;
    const center = { x: 0, z: 0 };
    const corners = this._hexCorners(a);
    const verts = [center, ...corners];

    const pos = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      pos[3 * i + 0] = verts[i].x;
      pos[3 * i + 1] = 0;
      pos[3 * i + 2] = verts[i].z;
    }
    const idx = [];
    for (let i = 1; i <= 6; i++) { const j = i === 6 ? 1 : i + 1; idx.push(0, i, j); }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setIndex(idx);

    const cols = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) { const o = 3 * i; cols[o] = cols[o + 1] = cols[o + 2] = this.LUM_MIN; }
    geom.setAttribute('color', new THREE.BufferAttribute(cols, 3).setUsage(THREE.DynamicDrawUsage));
    // CRITICAL: Skip expensive normal computation on mobile
    if (!this._isMobile) {
      geom.computeVertexNormals();
    }

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      metalness: 0.05,
      roughness: 0.75,
    });
    const mesh = new THREE.Mesh(geom, this._getTerrainMaterial());
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;

    const group = new THREE.Group(); group.add(mesh);
    return { group, mesh, geometry: geom, mat };
  }

  _addVisualTile(q, r) {
    const id = `${q},${r}`;
    if (this.tiles.has(id)) return this.tiles.get(id);

    const low = this._makeLowResHexMesh();
    low.group.name = `tile-low-${id}`;
    const wp = this._axialWorld(q, r);
    low.group.position.set(wp.x, 0, wp.z);
    this.scene.add(low.group);
    // Set renderOrder to ensure proper layering: farfield < visual < interactive
    if (low.mesh) low.mesh.renderOrder = -1;

    const pos = low.geometry.attributes.position;
    const ready = new Uint8Array(pos.count);
    const neighbors = this._buildAdjacency(low.geometry.getIndex(), pos.count);

    const dist = this._hexDist(q, r, 0, 0);
    const visualFade = this._visualWireFade(dist);
    const wireMat = this._makeDisintegratingWireMaterial(this.VISUAL_WIREFRAME_COLOR, visualFade);
    const wire = new THREE.Mesh(low.geometry, wireMat);
    wire.frustumCulled = false; wire.renderOrder = 1;
    //low.group.add(wire);
    //low.wire = wire;

    const tile = {
      type: 'visual',
      grid: { group: low.group, mesh: low.mesh, geometry: low.geometry, mat: low.mat },
      q, r,
      pos,
      neighbors,
      ready,
      fetched: new Set(),
      populating: false,
      unreadyCount: pos.count,
      col: low.geometry.attributes.color,
      _phase: { fullDone: false },
      _queuedPhases: new Set(),
      _retryCounts: { full: 0 },
      wire
    };
    this.tiles.set(id, tile);
    const seededFromNeighbors = this._seedTileFromNeighbors(tile);
    this._ensureRoadMask(tile, { reset: true });
    if (seededFromNeighbors) this._applyAllColorsGlobal(tile); this._ensureTileOverlay(tile);
    if (this._roadStamps.length) this._applyExistingRoadStampsToTile(tile);
    this._ensureTileOverlay(tile);
    this._restitchInteractiveNeighbors(q, r);
    for (const [dq, dr] of HEX_DIRS) {
      const n = this._getTile(q + dq, r + dr);
      if (n && n.type === 'farfield') this._markFarfieldAdapterDirty(n);
    }

    if (!this._tryLoadTileFromCache(tile)) {
      this._queuePopulate(tile, false);
    }
    return tile;
  }
  _addFarfieldTile(q, r, scale = 1, sampleMode = 'all') {
    const id = `${q},${r}`;
    const existing = this.tiles.get(id);
    if (existing) {
      if (existing.type === 'farfield' && ((existing.scale || 1) !== scale || (existing._farSampleMode || 'all') !== sampleMode)) {
        this._discardTile(id);
      } else {
        return existing;
      }
      this._ensureTileOverlay(tile);

    }

    const radius = this.tileRadius * Math.max(1, Math.round(scale));
    const low = this._makeLowResHexMeshForRadius(radius);
    low.group.name = `tile-far-${id}`;
    const farfieldMat = this._getFarfieldMaterial();
    if (low.mesh) {
      low.mesh.material = farfieldMat;
      low.mesh.renderOrder = -10;
    }
    const wp = this._axialWorld(q, r);
    low.group.position.set(wp.x, 0, wp.z);
    this.scene.add(low.group);
    low.group.layers.set(1);
    low.mesh.layers.set(1);

    // allow farfield meshes to answer height queries when no interactive terrain is nearby
    if (low.mesh) low.mesh.raycast = THREE.Mesh.prototype.raycast;

    const pos = low.geometry.attributes.position;
    const ready = new Uint8Array(pos.count);
    const neighbors = this._buildAdjacency(low.geometry.getIndex(), pos.count);
    const colAttr = low.geometry.attributes.color;
    if (colAttr) colAttr.setUsage(THREE.DynamicDrawUsage);

    const tile = {
      type: 'farfield',
      grid: { group: low.group, mesh: low.mesh, geometry: low.geometry, mat: low.mat },
      q, r,
      pos,
      neighbors,
      ready,
      fetched: new Set(),
      populating: false,
      unreadyCount: pos.count,
      col: low.geometry.attributes.color,
      _phase: { fullDone: false },
      _queuedPhases: new Set(),
      _retryCounts: { full: 0 },
      scale,
      _radiusOverride: radius,
      _farSampleMode: sampleMode,
      _adapter: null,
      _adapterDirty: true,
      _fetchedEver: false
    };
    this.tiles.set(id, tile);
    const seededFromNeighbors = this._seedTileFromNeighbors(tile);

    this._initColorsNearBlack(tile);
    if (seededFromNeighbors) this._applyAllColorsGlobal(tile);
    if (this._roadStamps.length) this._applyExistingRoadStampsToTile(tile);
    this._ensureTileOverlay(tile);
    this._invalidateHeightCache();
    this._ensureFarfieldAdapter(tile);
    this._restitchInteractiveNeighbors(q, r);
    for (const [dq, dr] of HEX_DIRS) {
      const neighbor = this._getTile(q + dq, r + dr);
      if (neighbor && neighbor.type === 'farfield') this._markFarfieldAdapterDirty(neighbor);
    }

    if (!this._nextFarfieldLog || this._nowMs() >= this._nextFarfieldLog) {
      console.log('[tiles.farfield] add', { id, verts: tile.pos.count, scale, sampleMode });
      this._nextFarfieldLog = this._nowMs() + 2000;
    }

    if (!this._tryLoadTileFromCache(tile)) {
      this._queuePopulate(tile, false);
    }
    this._markFarfieldMergeDirty(tile);
    this._markHorizonDirty();
    return tile;
  }

  /* ---------------- promotion: visual -> interactive (seam + corner safe) ---------------- */

  _promoteVisualToInteractive(q, r) {
    const id = `${q},${r}`;
    const v = this.tiles.get(id);
    if (!v || v.type !== 'visual') return this._addInteractiveTile(q, r);

    const grid = new UniformHexGrid(this.spacing, this.tileRadius * 2);
    grid.group.name = `tile-${id}`;
    grid.group.position.copy(v.grid.group.position);
    this.scene.add(grid.group);
    // Set renderOrder to ensure proper layering: farfield < visual < interactive
    if (grid.mesh) grid.mesh.renderOrder = 0;

    const dist = this._hexDist(q, r, 0, 0);
    const interactiveFade = this._interactiveWireFade(dist);
    const wireMat = this._makeDisintegratingWireMaterial(this.INTERACTIVE_WIREFRAME_COLOR, interactiveFade);
    const wire = new THREE.Mesh(grid.geometry, wireMat);
    wire.frustumCulled = false; wire.renderOrder = 1;
    grid.group.add(wire);
    grid.wire = wire;

    const pos = grid.geometry.attributes.position;
    const neighbors = this._buildAdjacency(grid.geometry.getIndex(), pos.count);
    const ready = new Uint8Array(pos.count);

    const t = {
      type: 'interactive',
      grid, q, r,
      pos,
      neighbors,
      ready,
      fetched: new Set(),
      populating: false,
      yA: null, yB: null, flip: false,
      normTick: 0,
      col: null,
      unreadyCount: pos.count,
      _phase: { seedDone: false, edgeDone: false, fullDone: false },
      _queuedPhases: new Set(),
      locked: new Uint8Array(pos.count),
      relaxEnabled: false,
      wire
    };

    // Seed heights from visual + neighbors, but corner-aware
    const lowMesh = v.grid.mesh;
    const lowPosAttr = v.grid.geometry?.attributes?.position || null;
    const neighborMeshes = this._gatherNeighborMeshes(q, r);
    const base = grid.group.position;

    for (let i = 0; i < pos.count; i++) {
      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);

      const y = this._robustSampleHeight(wx, wz, lowMesh, neighborMeshes, lowPosAttr, this._lastHeight);
      pos.setY(i, Number.isFinite(y) ? y : 0);
    }
    this._handoffOverlayBetweenTiles(v, t);
    pos.needsUpdate = true;
    // CRITICAL: Skip expensive normal computation on mobile
    if (!this._isMobile) {
      grid.geometry.computeVertexNormals();
    }

    this._ensureTileBuffers(t);
    this._pullGeometryToBuffers(t);
    this._initColorsNearBlack(t);
    this._applyAllColorsGlobal(t);
    this._ensureTileOverlay(t);

    // Swap into map, dispose low-res
    this.tiles.set(id, t);
    this._invalidateHeightCache();
    this._markRelaxListDirty();
    try {
      this.scene.remove(v.grid.group);
      v.grid.geometry?.dispose?.();
      v.grid.mat?.dispose?.();
      v.wire?.material?.dispose?.();
    } catch { }

    // CRITICAL: Defer heavy edge sealing work to finalize queue
    // Running synchronously here causes lag spike when promoting many tiles
    this._queueTileFinalize(t, { skipBlend: false, phase: null, isPromotion: true });

    // Fetch phased full-res now
    this._queuePopulate(t, true);
    return t;
  }

  /* ---------------- hard edge sealing from corners (pin) ---------------- */

  _selectCenterIndex(tile) {
    let best = 0, bestR2 = Infinity;
    const pos = tile.pos;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r2 = x * x + z * z;
      if (r2 < bestR2) { bestR2 = r2; best = i; }
    }
    return best;
  }

  _selectCornerTipIndices(tile) {
    const cls = this._classifyRimAndCorners(tile);
    const tips = [];
    for (let c = 0; c < 6; c++) {
      const arr = cls.corners[c];
      if (!arr || !arr.length) continue;
      let pick = arr[0], best = -Infinity;
      for (const i of arr) {
        const x = tile.pos.getX(i), z = tile.pos.getZ(i);
        const r2 = x * x + z * z;
        if (r2 > best) { best = r2; pick = i; }
      }
      tips.push(pick);
    }
    return tips;
  }

  _selectEdgeMidpointIndices(tile) {
    const aR = this.tileRadius;
    const sideAng = Array.from({ length: 6 }, (_, i) => (i + 0.5) * (Math.PI / 3));
    const cls = this._classifyRimAndCorners(tile);
    const picks = [];
    for (let s = 0; s < 6; s++) {
      const arr = cls.sides[s];
      if (!arr || !arr.length) continue;
      let pick = arr[0], best = Infinity;
      for (const i of arr) {
        const x = tile.pos.getX(i), z = tile.pos.getZ(i);
        const r = Math.hypot(x, z);
        if (r < aR * 0.96) continue; // prefer near rim
        const a = this._angleOf(x, z);
        const d = this._angDiff(a, sideAng[s]);
        if (d < best) { best = d; pick = i; }
      }
      picks.push(pick);
    }
    return picks;
  }
  // Make the perimeter identical to the visual hex: for each of the 6 sides,
  // force the TRUE rim vertices to lie on the straight segment between its
  // adjacent corner tips. Lock them so relax/smooth cannot curve the edge.
  _pinEdgesFromCorners(tile) {
    if (!tile || tile.type !== 'interactive') return;

    const pos = tile.pos;
    const n = pos.count;
    const aR = this.tileRadius;

    // Use the classifier to find rim + per-side membership, but filter to the *true* rim.
    const cls = this._classifyRimAndCorners(tile);
    const tips = this._selectCornerTipIndices(tile);
    if (!tips || tips.length < 6) return;

    // We only want the outermost ring for each side.
    const RIM_STRICT = aR * 0.985; // match _isRimVertex threshold
    const sideRimStrict = Array.from({ length: 6 }, () => []);
    for (let s = 0; s < 6; s++) {
      const list = cls.sides[s] || [];
      for (const i of list) {
        const x = pos.getX(i), z = pos.getZ(i);
        if (x * x + z * z >= RIM_STRICT * RIM_STRICT) sideRimStrict[s].push(i);
      }
    }

    const locked = tile.locked || new Uint8Array(n);

    // For each side, project rim verts onto the side segment (tip->tip) and set y by linear interpolation
    for (let s = 0; s < 6; s++) {
      const iA = tips[s];
      const iB = tips[(s + 1) % 6];
      if (iA == null || iB == null) continue;

      const Ax = pos.getX(iA), Az = pos.getZ(iA), Ay = pos.getY(iA);
      const Bx = pos.getX(iB), Bz = pos.getZ(iB), By = pos.getY(iB);

      // if tips aren't finite yet (e.g. before SEED lands), skip this side
      if (!Number.isFinite(Ay) || !Number.isFinite(By)) continue;

      const ABx = Bx - Ax, ABz = Bz - Az;
      const denom = ABx * ABx + ABz * ABz;
      if (denom < 1e-8) continue;

      for (const i of sideRimStrict[s]) {
        if (tile.ready[i]) continue;  // don't overwrite fetched data

        // Parametric projection onto AB -> t in [0..1]
        const Px = pos.getX(i), Pz = pos.getZ(i);
        let t = ((Px - Ax) * ABx + (Pz - Az) * ABz) / denom;
        if (!Number.isFinite(t)) t = 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;

        // Interpolate height along the straight edge
        const y = Ay + t * (By - Ay);
        pos.setY(i, y);
        locked[i] = 1;               // keep the rim straight; relax/smooth ignore locked
      }
    }

    tile.locked = locked;
    pos.needsUpdate = true;
  }

  _projectInteractiveSeed(tile) {
    if (!tile || tile.type !== 'interactive') return false;

    const centerIdx = this._selectCenterIndex(tile);
    const cornerIdx = this._selectCornerTipIndices(tile);
    if (!Number.isInteger(centerIdx) || !cornerIdx || cornerIdx.length < 6) return false;
    if (!tile.ready[centerIdx]) return false;

    const pos = tile.pos;
    const locked = tile.locked || new Uint8Array(pos.count);
    const centerX = pos.getX(centerIdx);
    const centerZ = pos.getZ(centerIdx);
    const centerY = pos.getY(centerIdx);

    const cornerSet = new Set(cornerIdx);
    const triangles = [];
    for (let i = 0; i < 6; i++) {
      const idxA = cornerIdx[i];
      const idxB = cornerIdx[(i + 1) % 6];
      if (!tile.ready[idxA] || !tile.ready[idxB]) continue;

      const ax = pos.getX(idxA) - centerX;
      const az = pos.getZ(idxA) - centerZ;
      const ay = pos.getY(idxA);
      const bx = pos.getX(idxB) - centerX;
      const bz = pos.getZ(idxB) - centerZ;
      const by = pos.getY(idxB);
      const denom = ax * bz - bx * az;
      if (Math.abs(denom) < 1e-6) continue;

      triangles.push({
        idxA,
        idxB,
        ax,
        az,
        ay,
        bx,
        bz,
        by,
        denom
      });
    }

    if (triangles.length === 0) return false;

    let changed = false;
    for (let i = 0; i < pos.count; i++) {
      if (i === centerIdx) continue;
      if (cornerSet.has(i)) continue;
      if (tile.ready[i]) continue;
      if (locked[i]) continue;

      const px = pos.getX(i) - centerX;
      const pz = pos.getZ(i) - centerZ;

      let height = null;
      for (const tri of triangles) {
        const u = (px * tri.bz - tri.bx * pz) / tri.denom;
        const v = (tri.ax * pz - px * tri.az) / tri.denom;
        const w = 1 - u - v;
        if (u >= -1e-5 && v >= -1e-5 && w >= -1e-5) {
          height = w * centerY + u * tri.ay + v * tri.by;
          break;
        }
      }

      if (height == null) height = centerY;
      pos.setY(i, height);
      changed = true;
    }

    if (changed) {
      pos.needsUpdate = true;
      this._pullGeometryToBuffers(tile);
    }

    return changed;
  }



  _sealEdgesCornerSafe(tile) {
    if (!tile || tile.type !== 'interactive') return;

    const cls = this._classifyRimAndCorners(tile);
    const pos = tile.pos;
    const base = tile.grid.group.position;

    const locked = tile.locked || new Uint8Array(pos.count);

    // helper: raycast to a specific neighbor first
    const rayToMesh = (mesh, x, z) => {
      if (!mesh) return null;
      this.ray.set(new THREE.Vector3(x, 1e6, z), this.DOWN);
      const hit = this.ray.intersectObject(mesh, true);
      return (hit && hit.length) ? hit[0].point.y : null;
    };

    // side snapping: prefer the opposite side neighbor
    for (let s = 0; s < 6; s++) {
      const nq = tile.q + HEX_DIRS[s][0];
      const nr = tile.r + HEX_DIRS[s][1];
      const nTile = this._getTile(nq, nr);
      const nMesh = this._getMeshForTile(nTile);

      for (const i of cls.sides[s]) {
        if (locked[i]) continue; // don't override pinned straight edge
        const wx = base.x + pos.getX(i);
        const wz = base.z + pos.getZ(i);

        let y = null;
        if (nMesh) y = rayToMesh(nMesh, wx, wz);
        if (y == null) {
          // fallback: any neighbor
          this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
          const hits = this.ray.intersectObjects(this._gatherNeighborMeshes(tile.q, tile.r), true);
          if (hits && hits.length) y = hits[0].point.y;
        }
        if (Number.isFinite(y)) pos.setY(i, y);
      }
    }

    // corner snapping: median of the two adjacent neighbors
    for (let c = 0; c < 6; c++) {
      const sa = c; // adjacent sides: c and c+1
      const sb = (c + 1) % 6;

      const nAq = tile.q + HEX_DIRS[sa][0], nAr = tile.r + HEX_DIRS[sa][1];
      const nBq = tile.q + HEX_DIRS[sb][0], nBr = tile.r + HEX_DIRS[sb][1];
      const mA = this._getMeshForTile(this._getTile(nAq, nAr));
      const mB = this._getMeshForTile(this._getTile(nBq, nBr));

      for (const i of cls.corners[c]) {
        if (locked[i]) continue; // respect pins if any
        const wx = base.x + pos.getX(i);
        const wz = base.z + pos.getZ(i);

        const a = mA ? rayToMesh(mA, wx, wz) : null;
        const b = mB ? rayToMesh(mB, wx, wz) : null;
        let y = null;

        if (Number.isFinite(a) && Number.isFinite(b)) {
          y = (a + b) * 0.5;
        } else if (Number.isFinite(a)) {
          y = a;
        } else if (Number.isFinite(b)) {
          y = b;
        } else {
          this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
          const hits = this.ray.intersectObjects(this._gatherNeighborMeshes(tile.q, tile.r), true);
          if (hits && hits.length) y = hits[0].point.y;
        }

        if (Number.isFinite(y)) pos.setY(i, y);
      }
    }

    // small, local relaxation just behind the tips with the rim held fixed
    this._relaxCornerInnerBand(tile, cls, 2);

    pos.needsUpdate = true;

    // CRITICAL: Defer expensive normal computation
    if (!this._isMobile) {
      try { tile.grid.geometry.computeVertexNormals(); } catch { }
    } else if (tile.grid?.geometry) {
      if (!tile._deferredNormalsUpdate) {
        tile._deferredNormalsUpdate = true;
        if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
        this._deferredNormalsTiles.add(tile);
      }
    }
  }

  _relaxCornerInnerBand(tile, cls, iters = 1) {
    if (!cls?.innerCornerBand?.size) return;
    const pos = tile.pos;
    const fixed = new Set(cls.rim); // keep the true rim fixed

    const band = Array.from(cls.innerCornerBand);
    for (let k = 0; k < iters; k++) {
      for (const i of band) {
        if (fixed.has(i)) continue;
        // 1 Laplacian step using only band neighbors + rim
        let sum = 0, cnt = 0;
        for (const j of tile.neighbors[i]) {
          if (fixed.has(j) || cls.innerCornerBand.has(j)) {
            const y = pos.getY(j);
            if (Number.isFinite(y)) { sum += y; cnt++; }
          }
        }
        if (cnt >= 2) {
          pos.setY(i, sum / cnt);
        }
      }
    }
  }

  _fixStuckZeros(tile, rimOnly = true) {
    if (!tile) return;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const neighborMeshes = [];
    for (const t of this.tiles.values()) {
      if (t === tile) continue;
      const m = this._getMeshForTile(t);
      if (m) neighborMeshes.push(m);
    }
    if (!neighborMeshes.length) return;

    const locked = tile.locked || new Uint8Array(pos.count);

    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      if (rimOnly && !this._isRimVertex(tile, i)) continue;
      if (locked[i]) continue;
      const curY = pos.getY(i);
      if (Math.abs(curY) > 1e-4) continue;

      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);
      const y = this._robustSampleHeight(wx, wz, null, neighborMeshes, null, curY);
      if (Number.isFinite(y) && Math.abs(y) > 1e-4) {
        pos.setY(i, y);
        touched = true;
      }
    }
    if (touched) {
      pos.needsUpdate = true;
      // CRITICAL: Skip expensive normal computation on mobile - defer to batch processor
      if (!this._isMobile) {
        tile.grid.geometry.computeVertexNormals();
      } else if (tile.grid?.geometry) {
        if (!tile._deferredNormalsUpdate) {
          tile._deferredNormalsUpdate = true;
          if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
          this._deferredNormalsTiles.add(tile);
        }
      }
    }
  }

  /* ---------------- fetching & backfill (PHASED) ---------------- */

  _tileNeedsFetch(tile) {
    if (!tile) return false;
    if (!Number.isFinite(tile.unreadyCount)) tile.unreadyCount = tile.pos.count;

    if (tile.type === 'visual' || tile.type === 'farfield') {
      return !(tile._phase?.fullDone) || tile.unreadyCount > 0;
    }
    // interactive: any phase not done OR there are still unknowns
    return !(tile._phase?.seedDone && tile._phase?.edgeDone && tile._phase?.fullDone) || tile.unreadyCount > 0;
  }

  _interactiveTilesPending(exclude = null) {
    for (const tile of this.tiles.values()) {
      if (tile === exclude) continue;
      if (tile.type !== 'interactive') continue;
      if (!tile._phase?.seedDone) return true;
      if (this._interactiveSecondPass && this._tileNeedsFetch(tile)) return true;
    }
    return false;
  }

  _visualTilesPending(exclude = null) {
    for (const tile of this.tiles.values()) {
      if (tile === exclude) continue;
      if (tile.type !== 'visual') continue;
      if (this._tileNeedsFetch(tile)) return true;
    }
    return false;
  }

  _farfieldTilesPending(exclude = null) {
    for (const tile of this.tiles.values()) {
      if (tile === exclude) continue;
      if (tile.type !== 'farfield') continue;
      if (this._tileNeedsFetch(tile) || tile.populating) return true;
    }
    return false;
  }

  _activateInteractiveSecondPass() {
    if (this._interactiveSecondPass) return;
    this._interactiveSecondPass = true;
    this._fetchPhase = 'interactive-final';
    console.log('[tiles] interactive second pass activated');
    this._primePhaseWork('interactive-final');
  }

  _releaseDeferredInteractivePhases() {
    if (!this._deferredInteractive.size) return;
    for (const tile of this._deferredInteractive) {
      if (!tile || tile.type !== 'interactive') continue;
      if (!tile._phase?.seedDone) continue;
      if (!tile._phase.edgeDone && !this._isPhaseQueued(tile, PHASE_EDGE)) {
        this._queuePopulatePhase(tile, PHASE_EDGE);
        continue;
      }
      if (tile._phase.edgeDone && !tile._phase.fullDone && !this._isPhaseQueued(tile, PHASE_FULL)) {
        this._queuePopulatePhase(tile, PHASE_FULL);
      }
    }
    this._deferredInteractive.clear();
  }

  _tryAdvanceFetchPhase(exclude = null) {
    if (this._fetchPhase === 'interactive') {
      if (this._interactiveTilesPending(exclude)) return;
      this._fetchPhase = 'visual';
      this._primePhaseWork('visual');
      this._markRelaxListDirty();
      this._scheduleBackfill(0);
      return;
    }
    if (this._fetchPhase === 'visual') {
      if (this._visualTilesPending(exclude)) {
        // Count tiny holes and allow a soft advance
        let holes = 0;
        for (const t of this.tiles.values()) if (t.type === 'visual') holes += (t.unreadyCount || 0);
        if (holes > 0 && holes <= (this.VISUAL_HOLE_TOLERANCE || 24)) {
          // proceed to farfield despite tiny holes
        } else {
          return; // keep waiting
        }
      }
      this._fetchPhase = 'farfield';
      this._primePhaseWork('farfield');
      this._kickFarfieldIfIdle();
      this._scheduleBackfill(0);
    }
    if (this._fetchPhase === 'farfield') {
      if (this._farfieldTilesPending(exclude)) return;
      this._activateInteractiveSecondPass();
      return;
    }
  }

  _primePhaseWork(phase) {
    const wantVisual = phase === 'visual' || phase === 'farfield' || phase === 'interactive-final';
    const wantFarfield = phase === 'farfield' || phase === 'interactive-final';

    if (phase === 'interactive') {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'interactive') continue;
        if (tile._phase?.seedDone) continue;
        this._queuePopulatePhase(tile, PHASE_SEED, true);
      }
      return;
    }

    if (wantVisual) {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'visual') continue;
        if (!this._tileNeedsFetch(tile)) continue;
        this._queuePopulatePhase(tile, PHASE_FULL, true);
      }
    }

    if (wantFarfield) {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'farfield') continue;
        if (!this._tileNeedsFetch(tile)) continue;
        this._queuePopulatePhase(tile, PHASE_FULL, true);
      }
    }

    if (phase === 'interactive-final') {
      this._releaseDeferredInteractivePhases();
    }
  }

  _collectPipelineStats() {
    const stats = {
      phase: this._fetchPhase,
      queue: this._populateQueue.length,
      inflight: this._populateInflight,
      totals: { interactive: 0, visual: 0, farfield: 0 },
      pending: { interactive: 0, visual: 0, farfield: 0 },
      queued: { interactive: 0, visual: 0, farfield: 0 },
      deferredInteractive: this._deferredInteractive.size,
      interactiveSecondPass: this._interactiveSecondPass,
    };

    for (const tile of this.tiles.values()) {
      const type = tile.type;
      if (!(type in stats.totals)) stats.totals[type] = 0;
      if (!(type in stats.pending)) stats.pending[type] = 0;
      if (!(type in stats.queued)) stats.queued[type] = 0;

      stats.totals[type] += 1;
      if (this._tileNeedsFetch(tile)) stats.pending[type] += 1;
      if (tile._queuedPhases?.size) stats.queued[type] += tile._queuedPhases.size;
    }

    return stats;
  }

  _phaseKey(phase) {
    return phase === PHASE_SEED ? 'seed' : (phase === PHASE_EDGE ? 'edge' : 'full');
  }

  _phaseName(phase) {
    return phase === PHASE_SEED ? 'seed' : (phase === PHASE_EDGE ? 'edge' : 'full');
  }

  _registerPhaseRetry(tile, phase) {
    if (!tile) return false;
    if (!tile._retryCounts) tile._retryCounts = { seed: 0, edge: 0, full: 0 };
    const key = this._phaseName(phase);
    const cap = key === 'seed' ? 4 : 3;
    tile._retryCounts[key] = (tile._retryCounts[key] || 0) + 1;
    return tile._retryCounts[key] <= cap;
  }

  _resetPhaseRetry(tile, phase) {
    if (!tile || !tile._retryCounts) return;
    const key = this._phaseName(phase);
    tile._retryCounts[key] = 0;
  }

  _isPhaseQueued(tile, phase) {
    const key = this._phaseKey(phase);
    if (tile._queuedPhases?.has(key)) return true;
    for (const e of this._populateQueue) {
      if (e.tile === tile && e.phase === phase) return true;
    }
    return false;
  }

  _queuePopulateIfNeeded(tile, priority = false) {
    if (!tile) return;
    if (!this._tileNeedsFetch(tile)) return;
    if (tile.populating) return;
    if (tile.type === 'visual' && this._fetchPhase === 'interactive') return;
    if (tile.type === 'farfield' && this._fetchPhase !== 'farfield') return;

    if (tile.type === 'visual' || tile.type === 'farfield') {
      if (!tile._phase.fullDone) this._queuePopulatePhase(tile, PHASE_FULL, priority);
      return;
    }
    if (!tile._phase.seedDone) {
      this._queuePopulatePhase(tile, PHASE_SEED, priority);
    } else if (!this._interactiveSecondPass) {
      this._deferredInteractive.add(tile);
    } else if (!tile._phase.edgeDone) {
      this._queuePopulatePhase(tile, PHASE_EDGE, priority);
    } else if (!tile._phase.fullDone) {
      this._queuePopulatePhase(tile, PHASE_FULL, priority);
    }
  }

  _queuePopulate(tile, priority = false) {
    this._queuePopulateIfNeeded(tile, priority);
  }

  _queuePopulatePhase(tile, phase, priority = false) {
    if (!tile) return;
    if (this._isPhaseQueued(tile, phase)) return;

    // CRITICAL: Enforce global queue size limit to prevent crash on NKN connect
    if (this._populateQueue.length >= this.MAX_POPULATE_QUEUE_SIZE) {
      // Queue is full - skip this tile, it will be picked up by next backfill
      return;
    }

    const key = this._phaseKey(phase);
    tile._queuedPhases?.add(key);
    const entry = { tile, phase, priority: !!priority };
    if (priority) this._populateQueue.unshift(entry);
    else this._populateQueue.push(entry);
    this._drainPopulateQueue({ budgetMs: 2.8, maxBatch: 3 });
    if (this._populateQueue.length) this._schedulePopulateDrain();
  }

  _handleInteractivePhaseCompletion(tile, phase) {
    if (!tile || tile.type !== 'interactive') return;
    if (phase === PHASE_SEED) {
      tile._phase.seedDone = true;
      if (this._interactiveSecondPass) this._queuePopulatePhase(tile, PHASE_EDGE);
      else this._deferredInteractive.add(tile);
      this._saveInteractiveSeed(tile);
      if (this._fetchPhase === 'interactive') this._tryAdvanceFetchPhase(tile);
    } else if (phase === PHASE_EDGE) {
      tile._phase.edgeDone = true;
      if (this._interactiveSecondPass) this._queuePopulatePhase(tile, PHASE_FULL);
      else this._deferredInteractive.add(tile);
    } else {
      tile._phase.fullDone = true;
      this._deferredInteractive.delete(tile);
      if (tile.locked) tile.locked.fill(0);
      this._saveTileToCache(tile);
      this._noteMobileInteractiveCompletion(tile);
    }
  }

  _refillRateTokens(nowMs = this._nowMs()) {
    if (!Number.isFinite(this._rateLastRefillAt)) {
      this._rateLastRefillAt = nowMs;
      return;
    }
    const elapsed = Math.max(0, nowMs - this._rateLastRefillAt);
    if (elapsed <= 0) return;
    const seconds = elapsed / 1000;
    this._rateTokensQ = Math.min(this.RATE_QPS, this._rateTokensQ + this.RATE_QPS * seconds);
    this._rateTokensB = Math.min(this.RATE_BPS, this._rateTokensB + this.RATE_BPS * seconds);
    this._rateLastRefillAt = nowMs;
  }

  async _acquireNetBudget(bytes) {
    const bytesCost = Math.max(0, bytes | 0);
    while (true) {
      const nowT = this._nowMs();
      this._refillRateTokens(nowT);
      if (this._rateTokensQ > 0 && this._rateTokensB >= bytesCost) {
        this._rateTokensQ = Math.max(0, this._rateTokensQ - 1);
        this._rateTokensB = Math.max(0, this._rateTokensB - bytesCost);
        return;
      }
      await new Promise(r => setTimeout(r, 8));
    }
  }

  _schedulePopulateDrain() {
    this._populateDrainPending = true;
  }

  _drainPopulateQueue({ budgetMs = 3.2, maxBatch = 4 } = {}) {
    if (!this._populateQueue.length && this._populateInflight < this.MAX_CONCURRENT_POPULATES) {
      this._populateDrainPending = false;
      return;
    }

    const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 0;
    const batchLimit = Number.isFinite(maxBatch) ? Math.max(1, Math.floor(maxBatch)) : 4;
    const start = this._nowMs();
    let startedThisPass = 0;

    this._populateDrainPending = false;
    this._refillRateTokens(start);

    while (this._populateInflight < this.MAX_CONCURRENT_POPULATES && this._populateQueue.length) {
      const elapsed = this._nowMs() - start;
      if (budget > 0 && elapsed > budget) break;
      if (startedThisPass >= batchLimit) break;

      const next = this._populateQueue.shift();
      if (!next) continue;

      const { tile, phase } = next;
      if (!tile) continue;

      if (tile.type === 'visual' && this._fetchPhase === 'interactive') {
        const k = this._phaseKey(phase);
        tile._queuedPhases?.delete(k);
        tile.populating = false;
        continue;
      }

      if (tile.populating) {
        this._populateQueue.push(next);
        break;
      }

      this._populateInflight++;
      tile.populating = true;
      startedThisPass++;

      this._populateTilePhase(tile, phase)
        .catch(() => { /* ignore; backfill will retry */ })
        .finally(() => {
          const k = this._phaseKey(phase);
          tile._queuedPhases?.delete(k);
          tile.populating = false;
          this._populateInflight = Math.max(0, this._populateInflight - 1);
          this._schedulePopulateDrain();
        });
    }

    if (this._populateQueue.length && this._populateInflight < this.MAX_CONCURRENT_POPULATES) {
      this._schedulePopulateDrain();
    }
  }

  async _populateTilePhase(tile, phase) {
    if (!tile || !this.origin) { if (tile) tile.populating = false; return; }
    if (!this.relayAddress) { tile.populating = false; return; }

    if (tile.type === 'farfield') {
      await this._populateFarfieldBatch(tile);
      return;
    }

    const pos = tile.pos;
    const count = pos.count;
    if (!Number.isFinite(count) || count === 0) { tile.populating = false; return; }

    // ---- choose indices for this phase ----
    let indices = null;
    if (tile.type === 'visual') {
      // visuals fetch the full 7 verts
      indices = Array.from({ length: count }, (_, i) => i);
    } else {
      if (phase === PHASE_SEED) {
        const center = this._selectCenterIndex(tile);
        const tips = this._selectCornerTipIndices(tile);
        indices = Array.from(new Set([center, ...tips]));
      } else if (phase === PHASE_EDGE) {
        indices = this._selectEdgeMidpointIndices(tile);
      } else {
        // PHASE_FULL: fetch remaining unknowns only
        indices = [];
        for (let i = 0; i < count; i++) if (!tile.ready[i]) indices.push(i);
        if (indices.length === 0) {
          // nothing left; mark done & finish phase chain
          if (tile.type === 'interactive') {
            tile._phase.fullDone = true;
            if (tile.locked) tile.locked.fill(0);
            this._saveTileToCache(tile);
          } else {
            tile._phase.fullDone = true;
            this._saveTileToCache(tile);
          }
          return;
        }
      }
    }

    // If truly nothing to do in this phase, mark + chain forward immediately
    if (!indices || indices.length === 0) {
      if (tile.type === 'interactive') {
        this._handleInteractivePhaseCompletion(tile, phase);
      } else {
        tile._phase.fullDone = true;
        this._saveTileToCache(tile);
      }
      if (!this._tileNeedsFetch(tile)) this._tryAdvanceFetchPhase(tile);
      return;
    }

    // ---- build batches & fire queries (with net budget gating) ----
    const latLon = this._collectTileLatLon(tile);
    const mode = this.relayMode;
    const precision = pickGeohashPrecision(this.spacing);
    const geohashes = mode === 'geohash'
      ? latLon.map(({ lat, lng }) => geohashEncode(lat, lng, precision))
      : null;

    const indexByLatLon = new Map();
    if (mode === 'latlng') {
      for (let i = 0; i < latLon.length; i++) {
        const { lat, lng } = latLon[i];
        indexByLatLon.set(`${lat.toFixed(6)},${lng.toFixed(6)}`, i);
      }
    }
    const indexByGeohash = geohashes ? new Map(geohashes.map((gh, i) => [gh, i])) : null;

    const batches = (mode === 'geohash')
      ? this._indicesToBatchesGeohash(indices, geohashes, precision)
      : this._indicesToBatchesLatLng(indices, latLon);

    const queries = batches.map((batch) => {
      const payload = { type: 'elev.query', dataset: this.relayDataset };
      if (mode === 'geohash') {
        payload.geohashes = batch.items;
        payload.enc = 'geohash';
        payload.prec = precision;
      } else {
        payload.locations = batch.items;
      }

      const approxBytes = batch.bytes ?? JSON.stringify(payload).length;

      return this._acquireNetBudget(approxBytes).then(() =>
        this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs)
          .then((json) => {
            const results = json?.results || [];
            if (results.length) {
              this._applyRelayResults(tile, results, { mode, indexByLatLon, indexByGeohash });
            }
          })
          .catch(() => { /* swallow; backfill/next phases will retry */ })
      );
    });

    await Promise.allSettled(queries);

    // Yield back to the event loop before heavy finalize work (normals / smoothing / color rebuild).
    await new Promise(r => setTimeout(r, 0));

    const missing = Array.isArray(indices)
      ? indices.filter((idx) => tile.ready[idx] !== 1)
      : [];

    if (missing.length) {
      if (tile.type === 'farfield' && this._fallbackFarfieldTile(tile)) {
        if (tile && typeof tile === 'object') tile.populating = false;
        return;
      }
      const allowRetry = this._registerPhaseRetry(tile, phase);
      if (allowRetry) {
        const key = this._phaseKey(phase);
        tile._queuedPhases?.delete(key);
        console.warn(`[tiles] retry ${this._phaseName(phase)} tile ${tile.q},${tile.r} · missing ${missing.length}`);
        this._queuePopulatePhase(tile, phase, true);
        return;
      }
      console.warn(`[tiles] exhausted retries for ${this._phaseName(phase)} tile ${tile.q},${tile.r} · unresolved ${missing.length}`);
    } else {
      this._resetPhaseRetry(tile, phase);
    }

    let skipBlend = false;
    if (tile.type === 'interactive') {
      if (phase === PHASE_SEED) {
        this._pinEdgesFromCorners(tile);
        skipBlend = this._projectInteractiveSeed(tile);
      } else if (phase === PHASE_EDGE) {
        this._pinEdgesFromCorners(tile);
      }
    }

    // CRITICAL: Queue heavy finalize work instead of running synchronously
    // When 100+ tiles finish simultaneously, running this synchronously crashes the browser
    this._queueTileFinalize(tile, { skipBlend, phase });
  }

  _queueTileFinalize(tile, opts = {}) {
    if (!tile) return;

    // CRITICAL: Use unified progressive loader if available
    // This spreads terrain finalize across frames with buildings/trees/grass
    if (this.progressiveLoader) {
      this.progressiveLoader.enqueue('terrain', tile, opts);
      return;
    }

    // Fallback: use local queue if no progressive loader
    const existingIndex = this._finalizeQueue.findIndex(entry => entry.tile === tile);
    if (existingIndex !== -1) {
      this._finalizeQueue.splice(existingIndex, 1);
    }
    this._finalizeQueue.push({ tile, opts });
  }

  _drainFinalizeQueue() {
    if (!this._finalizeQueue.length) return;

    // CRITICAL: Process ONLY 1 tile per frame to prevent main thread blocking
    // Each tile takes 100-400ms to finalize (_nearestAnchorFill, _smoothUnknowns, etc.)
    // Processing multiple tiles = instant crash on mobile
    const maxTilesPerFrame = 1;
    let processed = 0;

    while (this._finalizeQueue.length > 0 && processed < maxTilesPerFrame) {
      const entry = this._finalizeQueue.shift();
      if (!entry || !entry.tile) continue;

      this._finalizeTile(entry.tile, entry.opts);
      processed++;
    }
  }

  // CRITICAL: Texture application queue - ONLY processes tiles with elevation data
  _queueTextureApplication(tile) {
    //if (!tile || !tile._elevationFetched) return;
    //if (!this._textureQueue) this._textureQueue = [];
    //if (this._textureQueue.includes(tile)) return;
    this._textureQueue.push(tile);
  }

  _drainTextureQueue() {
    if (!this._textureQueue || !this._textureQueue.length) return;

    // Apply textures even under poor FPS, but throttle aggressively when needed
    const fpsHealth = this.adaptiveBatchScheduler?._fpsHealth;
    let budget = this._isMobile ? 4 : 8; // ms
    let maxPerFrame = this._isMobile ? 2 : 4;
    if (fpsHealth === 'POOR') {
      budget = this._isMobile ? 3 : 5;
      maxPerFrame = 1;
    } else if (fpsHealth === 'CRITICAL') {
      budget = this._isMobile ? 2 : 4;
      maxPerFrame = 1;
    }

    const start = performance.now();
    let processed = 0;

    while (this._textureQueue.length > 0 && processed < maxPerFrame) {
      if (performance.now() - start > budget) break;

      const tile = this._textureQueue.shift();
      if (tile && tile._elevationFetched && tile.grid?.geometry) {
        // Apply textures now that elevation is fetched
        this._applyAllColorsGlobal(tile);
        tile._texturesApplied = true;
        processed++;
      }
    }
  }

  // CRITICAL: Grass injection queue - ONLY processes tiles with elevation data
  _queueGrassInjection(tile) {
    if (!tile || !tile._elevationFetched) return;
    if (!this.grassManager) return; // No grass on mobile
    if (!this._grassQueue) this._grassQueue = [];
    if (this._grassQueue.includes(tile)) return;
    this._grassQueue.push(tile);
  }

  _drainGrassQueue() {
    if (!this._grassQueue || !this._grassQueue.length) return;
    if (!this.grassManager) return;

    // Only inject grass if FPS is healthy AND textures are mostly done
    const fpsHealth = this.adaptiveBatchScheduler?._fpsHealth;
    if (fpsHealth === 'POOR' || fpsHealth === 'CRITICAL') {
      // Skip grass injection when FPS is struggling
      return;
    }

    // Wait for texture queue to be mostly drained
    if (this._textureQueue && this._textureQueue.length > 5) {
      return;
    }

    const budget = this._isMobile ? 3 : 6; // ms
    const start = performance.now();
    let processed = 0;
    const maxPerFrame = this._isMobile ? 1 : 2;

    while (this._grassQueue.length > 0 && processed < maxPerFrame) {
      if (performance.now() - start > budget) break;

      const tile = this._grassQueue.shift();
      if (tile && tile._elevationFetched && tile._texturesApplied && !tile._grassInjected) {
        // Inject grass now that elevation and textures are ready
        if (this.grassManager.addGrassForTile) {
          this.grassManager.addGrassForTile(tile);
        }
        tile._grassInjected = true;
        processed++;
      }
    }
  }

  _finalizeTile(tile, opts = {}) {
    const { skipBlend = false, phase, isPromotion = false } = opts;
    const pos = tile.pos;

    if (skipBlend) {
      pos.needsUpdate = true;
      // CRITICAL: Skip expensive normal computation on mobile - defer to batch processor
      if (!this._isMobile) {
        tile.grid.geometry.computeVertexNormals();
      } else if (tile.grid?.geometry) {
        if (!tile._deferredNormalsUpdate) {
          tile._deferredNormalsUpdate = true;
          if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
          this._deferredNormalsTiles.add(tile);
        }
      }
      // CRITICAL: DO NOT apply textures during finalize - defer until after elevation fetch
      // this._applyAllColorsGlobal(tile);  // REMOVED - moved to deferred queue
    } else {
      // CRITICAL: On MOBILE skip ALL expensive synchronous operations
      // These operations block main thread for 200-400ms and CRASH the tab
      if (!this._isMobile) {
        // Desktop only - run blend/seal operations
        this._nearestAnchorFill(tile);
        this._smoothUnknowns(tile, 1);
        this._sealEdgesCornerSafe(tile);
        this._fixStuckZeros(tile, /*rimOnly=*/true);
      }

      pos.needsUpdate = true;
      // CRITICAL: Skip expensive normal computation on mobile - defer to batch processor
      if (!this._isMobile) {
        tile.grid.geometry.computeVertexNormals();
      } else if (tile.grid?.geometry) {
        if (!tile._deferredNormalsUpdate) {
          tile._deferredNormalsUpdate = true;
          if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
          this._deferredNormalsTiles.add(tile);
        }
      }
      // CRITICAL: DO NOT apply textures during finalize - defer until after elevation fetch
      // this._applyAllColorsGlobal(tile);  // REMOVED - moved to deferred queue
    }

    // Finally, if any side borders a visual/farfield tile, feather to a straight edge line
    // derived from the neighbor's tip heights. This guarantees no cracks at the LOD boundary.
    if (tile.type === 'interactive') {
      this._stitchInteractiveToVisualEdges(tile, { bandRatio: 0.07, sideArc: Math.PI / 10 });
      this._planarizeEdgeWhenNeighborMissing(tile); // when any neighbor is absent
    } else if (tile.type === 'visual' || tile.type === 'farfield') {
      this._restitchInteractiveNeighbors(tile.q, tile.r);
    }

    // CRITICAL: Mark tile as having elevation data BEFORE queueing textures/grass
    // This ensures textures and grass are only applied AFTER terrain elevation is fetched
    tile._elevationFetched = true;

    // CRITICAL: If overlay was loaded while waiting for elevation, apply it now
    if (tile._overlay && tile._overlay.status === 'ready' && tile._overlay.entry) {
      this._applyOverlayEntryToTile(tile, tile._overlay.entry);
    }

    // CRITICAL: Queue texture application AFTER elevation fetch completes
    // Textures MUST NOT be applied during finalize to reduce GPU sync overhead
    this._queueTextureApplication(tile);

    // CRITICAL: Queue grass injection AFTER elevation fetch completes
    // Grass MUST NOT be injected until terrain geometry is stable
    if (this._grassEnabled && tile.type !== 'farfield') {
      this._queueGrassInjection(tile);
    }

    // ---- mark phase complete & chain next ----
    // Skip phase completion for promotions (they don't have a phase)
    if (!isPromotion) {
      if (tile.type === 'interactive' && phase != null) {
        this._handleInteractivePhaseCompletion(tile, phase);
      } else {
        tile._phase.fullDone = true;
        this._saveTileToCache(tile);
      }
      if (!this._tileNeedsFetch(tile)) this._tryAdvanceFetchPhase(tile);
    }
  }

  _gatherFarfieldBatch(primary) {
    const target = Math.max(1, Math.floor(this.FARFIELD_BATCH_SIZE) || 1);
    const batch = [];
    const include = (tile) => {
      if (!tile) return false;
      if (batch.includes(tile)) return false;
      if (!this._tileNeedsFetch(tile)) return false;
      if (tile.populating) return false;
      tile.populating = true;
      tile._queuedPhases?.delete?.('full');
      batch.push(tile);
      return true;
    };

    include(primary);

    if (batch.length < target) {
      for (const entry of this._populateQueue) {
        if (batch.length >= target) break;
        const tile = entry.tile;
        if (!tile || tile.type !== 'farfield') continue;
        include(tile);
      }
    }

    if (batch.length < target) {
      for (const tile of this.tiles.values()) {
        if (batch.length >= target) break;
        if (tile === primary) continue;
        if (tile.type !== 'farfield') continue;
        include(tile);
      }
    }

    if (batch.length > 1) {
      const set = new Set(batch);
      this._populateQueue = this._populateQueue.filter(entry => !set.has(entry.tile));
    }

    return batch;
  }

  async _populateFarfieldBatch(primary) {
    const tiles = this._gatherFarfieldBatch(primary);
    if (!tiles.length) { if (primary) primary.populating = false; return; }

    // Build a single, coarse precision for the whole batch based on the "worst" (biggest) tiles.
    const effSpacings = tiles.map(t => this._effectiveSpacingForTile(t));
    const maxEffSpacing = effSpacings.length ? Math.max(...effSpacings) : this.spacing;
    let precision = pickGeohashPrecision(maxEffSpacing);
    // obey per-tile minimum precision hints (coarser == smaller number of chars)
    let forcedMin = 99;
    for (const t of tiles) if (Number.isFinite(t._farMinPrec)) forcedMin = Math.min(forcedMin, t._farMinPrec);
    if (Number.isFinite(forcedMin)) precision = Math.max(forcedMin, precision);

    const mode = this.relayMode;

    // Gather only the indices we truly want for each far tile (center / tips / all).
    const latLonAll = [];
    const refs = [];
    for (const tile of tiles) {
      const pos = tile.pos;
      const ready = tile.ready;
      const idxs = this._farfieldSampleIndices(tile);
      const latLon = this._collectTileLatLon(tile);
      for (const i of idxs) {
        if (ready && ready[i]) continue;
        latLonAll.push(latLon[i]);
        refs.push({ tile, index: i });
      }
    }

    if (!latLonAll.length) {
      for (const tile of tiles) {
        tile.populating = false;
        // derive missing verts locally (e.g., set corners from center)
        this._completeFarfieldFromSparse(tile);
        tile._phase.fullDone = true;
        this._saveTileToCache(tile);
        this._tryAdvanceFetchPhase(tile);
      }
      return;
    }

    const indices = latLonAll.map((_, i) => i);
    const geohashes = mode === 'geohash'
      ? latLonAll.map(({ lat, lng }) => geohashEncode(lat, lng, precision))
      : null;

    const dedupeKeyForRes = (res) => {
      if (mode === 'geohash') {
        return res.geohash || res.hash || null;
      }
      const loc = res.location;
      if (!loc) return null;
      const lat = Number(loc.lat ?? loc.latitude ?? loc[0]);
      const lng = Number(loc.lng ?? loc.lon ?? loc.longitude ?? loc[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return `${lat.toFixed(6)},${lng.toFixed(6)}`;
    };

    const batches = (mode === 'geohash')
      ? this._indicesToBatchesGeohash(indices, geohashes, precision)
      : this._indicesToBatchesLatLng(indices, latLonAll);

    // Dedup maps so multiple refs share the same response (huge savings with coarse precision).
    const geohashMap = geohashes ? new Map() : null;
    if (geohashMap) {
      geohashes.forEach((gh, i) => {
        if (!geohashMap.has(gh)) geohashMap.set(gh, []);
        geohashMap.get(gh).push(i);
      });
    }
    const latLngMap = geohashes ? null : new Map();
    if (latLngMap) {
      latLonAll.forEach(({ lat, lng }, i) => {
        const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
        if (!latLngMap.has(key)) latLngMap.set(key, []);
        latLngMap.get(key).push(i);
      });
    }

    const CONC = IS_MOBILE ? 3 : 16;

    // Reuse locals from your scope: mode, precision, geohashMap, lookupIndex, indexToRef, etc.
    const _handleBatch = (batch) => {
      const payload = { type: 'elev.query', dataset: this.relayDataset };
      if (mode === 'geohash') {
        payload.geohashes = batch.items;
        payload.enc = 'geohash';
        payload.prec = precision;
      } else {
        payload.locations = batch.items;
      }

      const approxBytes = batch.bytes ?? JSON.stringify(payload).length;

      return this._acquireNetBudget(approxBytes)
        .then(() => this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs))
        .then((json) => {
          const results = json?.results || [];
          const seen = new Set();
          for (const res of results) {
            const dKey = dedupeKeyForRes(res);
            if (dKey && seen.has(dKey)) continue;

            let idx = null;
            if (mode === 'geohash') {
              const key = res.geohash || res.hash;
              const list = key ? geohashMap?.get(key) : null;
              if (list && list.length) idx = list.shift();
            } else if (res.location) {
              const { lat, lng } = res.location;
              const key = `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
              const list = latLngMap?.get(key);
              if (list && list.length) idx = list.shift();
            }

            if (idx == null) {
              const altKey = dedupeKeyForRes(res);
              if (altKey && latLngMap) {
                const list = latLngMap.get(altKey);
                if (list && list.length) idx = list.shift();
              }
            }

            const ref = idx != null ? refs[idx] : null;
            const rawHeight = res?.elev ?? res?.height ?? res?.z ?? res?.h ?? res?.value ?? res?.elevation;
            const height = rawHeight != null ? Number(rawHeight) : NaN;
            if (!ref || !Number.isFinite(height)) continue;
            if (dKey) seen.add(dKey);
            this._applySample(ref.tile, ref.index, height);
          }
        })
        .catch((err) => console.warn('[Tiles] elevation batch failed', err));
    };

    let cursor = 0, active = 0;

    await new Promise((resolve) => {
      // tiles.js (inside the populate batching loop)
      const tick = () => {
        while (active < CONC && cursor < batches.length) {
          active++;
          const b = batches[cursor++];
          _handleBatch(b)
            .finally(() => {
              active--;
                // Push any landed vertices right away so users see terrain “fill in”
                this._applyPendingSamples?.();                 // stream updates mid-batch
                // If we still have headroom, keep ticking in a microtask to reduce idle gaps.
                if (active < CONC && cursor < batches.length) {
                  Promise.resolve().then(tick);
                } else {
                  requestAnimationFrame(tick);
                }
                if (active === 0 && cursor >= batches.length) {
                  this._applyPendingSamples();
                  resolve();
                }
            });
        }
        if (active === 0 && cursor >= batches.length) {
          this._applyPendingSamples();
          resolve();
        }
      };
      tick();

    });

    // finalize tiles (derive missing verts if we used sparse sampling)
    for (const tile of tiles) {
      tile.populating = false;

      // If we fetched sparse samples, complete locally now.
      if ((tile._farSampleMode === 'center' || tile._farSampleMode === 'tips') && tile.unreadyCount > 0) {
        // Only complete if at least one sample landed; otherwise let retry logic handle.
        if (tile._fetchedEver) {
          this._completeFarfieldFromSparse(tile);
        }
      }
      this._sealFarfieldCornersAgainstNeighbors(tile);

      if (tile.unreadyCount > 0) {
        const allowRetry = this._registerPhaseRetry(tile, PHASE_FULL);
        if (allowRetry) {
          tile._queuedPhases?.delete('full');
          console.warn(`[tiles] retry farfield tile ${tile.q},${tile.r} · pending ${tile.unreadyCount}`);
          this._queuePopulatePhase(tile, PHASE_FULL, true);
          continue;
        }
        console.warn(`[tiles] exhausted farfield retries tile ${tile.q},${tile.r} · remaining ${tile.unreadyCount}`);
      } else {
        this._resetPhaseRetry(tile, PHASE_FULL);
      }

      const done = tile.unreadyCount === 0;
      tile._phase.fullDone = done;
      if (done) this._saveTileToCache(tile);
      else this._queuePopulate(tile, false);

      this._tryAdvanceFetchPhase(tile);
    }
  }



  /* ---------------- backfill orchestration ---------------- */

  _scheduleBackfill(delayMs = 0) {
    if (this._backfillTimer) clearTimeout(this._backfillTimer);

    // Enforce minimum 500ms between backfills to prevent excessive re-queuing
    const now = this._nowMs();
    const timeSinceLastBackfill = this._lastBackfillTime ? (now - this._lastBackfillTime) : Infinity;
    const minDelay = 500;
    const actualDelay = Math.max(minDelay, delayMs, minDelay - timeSinceLastBackfill);

    this._backfillTimer = setTimeout(() => {
      // Note: _backfillMissing will update _lastBackfillTime internally
      this._backfillMissing({ onlyIfRelayReady: false });
    }, actualDelay);
  }

  // Nudge farfield fetch if everything looks idle
_kickFarfieldIfIdle() {
  // Only kick if nothing is currently being populated
  const idle =
    (this._populateInflight === 0) &&
    (this._populateQueue.length === 0);

  if (!idle) return;

  // Make sure we’re actually in farfield fetch phase
  if (this._fetchPhase !== 'farfield') {
    this._fetchPhase = 'farfield';
  }

  // Ensure farfield tiles are prewarmed for the current center
  const q = this._lastQR?.q ?? 0;
  const r = this._lastQR?.r ?? 0;
  this._prewarmFarfieldRing?.(q, r);

  // Immediately schedule a backfill pass
  this._scheduleBackfill(0);
}


  _backfillMissing({ onlyIfRelayReady = false } = {}) {
    if (!this.origin) return;

    if (onlyIfRelayReady && !(this._relayStatus?.text === 'connected' || this._relayStatus?.level === 'ok')) return;

    // CRITICAL: Debounce to prevent multiple overlapping backfills during NKN connect
    const now = this._nowMs();
    const timeSinceLastBackfill = this._lastBackfillTime ? (now - this._lastBackfillTime) : Infinity;
    if (timeSinceLastBackfill < this._backfillMinDebounceMs) {
      // Too soon since last backfill - skip this call
      return;
    }
    this._lastBackfillTime = now;

    // CRITICAL: Collect tiles that need fetching, but DON'T queue them directly
    // Instead, pass them to the AdaptiveBatchScheduler which will queue them
    // progressively based on real-time FPS monitoring
    const tilesToEnqueue = [...this.tiles.values()]
      .filter(t =>
        this._tileNeedsFetch(t) &&
        !t.populating &&
        !this._isPhaseQueued(t, PHASE_SEED) &&
        !this._isPhaseQueued(t, PHASE_EDGE) &&
        !this._isPhaseQueued(t, PHASE_FULL)
      );

    // Pass to adaptive scheduler instead of queuing directly
    // The scheduler will batch them based on FPS health
    if (tilesToEnqueue.length > 0 && this.adaptiveBatchScheduler) {
      this.adaptiveBatchScheduler.enqueueTiles(tilesToEnqueue);
    } else if (tilesToEnqueue.length > 0) {
      // Fallback: if adaptive scheduler not available, use conservative fixed batching
      console.warn('[TileManager] Adaptive scheduler not available, using fallback batching');
      const maxFallback = this._isMobile ? 3 : 6;
      const batch = tilesToEnqueue
        .map(t => ({ t, d: this._hexDist(t.q, t.r, 0, 0) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, maxFallback);

      for (const { t } of batch) {
        const p = (t.type === 'interactive') || (t.q === 0 && t.r === 0);
        this._queuePopulateIfNeeded(t, p);
      }
    }
  }

  _prewarmVisualRing(q0 = 0, r0 = 0) {
    for (let dq = -this.VISUAL_RING; dq <= this.VISUAL_RING; dq++) {
      const rMin = Math.max(-this.VISUAL_RING, -dq - this.VISUAL_RING);
      const rMax = Math.min(this.VISUAL_RING, -dq + this.VISUAL_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.INTERACTIVE_RING) continue;
        if (!this.tiles.has(`${q},${r}`)) {
          this._addVisualTile(q, r);
        } else {
          const t = this.tiles.get(`${q},${r}`);
          this._queuePopulateIfNeeded(t, false);
        }
      }
    }
    this._scheduleBackfill(0);
  }

  _prewarmFarfieldRing(q0 = 0, r0 = 0) {
    for (let d = this.VISUAL_RING + 1; d <= this.FARFIELD_RING; d++) {
      const tier = this._farfieldTierForDist(d);
      const { stride, scale, samples, minPrec } = tier;
      this._forEachAxialRing(q0, r0, d, stride, (q, r) => {
        const id = `${q},${r}`;
        if (!this.tiles.has(id)) {
          const t = this._addFarfieldTile(q, r, scale, samples);
          t._farMinPrec = minPrec;
        }
      });
    }
    this._scheduleBackfill(0);
  }


  /* ---------------- per-frame: ensure LOD, relax, prune ---------------- */
  update(playerPos) {
    if (!this.origin) return;

    // ⚙️ Safety floor: never allow 0 interactive ring
    this.INTERACTIVE_RING = Math.max(1, (this.INTERACTIVE_RING | 0));

    const startMs = performance?.now ? performance.now() : Date.now();
    const nowMs = () => (performance?.now ? performance.now() : Date.now());
    const HARD_BUDGET_MS = (this.UPDATE_BUDGET_MS ?? 4.5);

    // Update velocity tracking for predictive preloading
    const deltaTime = this._lastUpdateTime ? (startMs - this._lastUpdateTime) / 1000 : 0.016;
    this._lastUpdateTime = startMs;
    this._updateVelocity(playerPos, deltaTime);

    this._refillRateTokens(startMs);
    if (this._populateDrainPending || (this._populateQueue.length && this._populateInflight < this.MAX_CONCURRENT_POPULATES)) {
      this._drainPopulateQueue({ budgetMs: 3.6, maxBatch: 4 });
    }

    const a = this.tileRadius;
    const qf = (2 / 3 * playerPos.x) / a;
    const rf = ((-1 / 3 * playerPos.x) + (Math.sqrt(3) / 3 * playerPos.z)) / a;
    const q0 = Math.round(qf), r0 = Math.round(rf);
    const key = `${q0},${r0}`;

    const tileChanged = !this._lastQR || this._lastQR.q !== q0 || this._lastQR.r !== r0;
    if (tileChanged) {
      this._lastQR = { q: q0, r: r0 };
      this._pendingHeavySweep = true; // 🔁 ensure we continue filling ring next frames
    }

    // Predictive preloading based on movement direction
    this._predictivePreloadTiles(playerPos, q0, r0);

    const maintenance = () => {
      // CRITICAL: Drain finalize queue FIRST - this processes heavy geometry ops incrementally
      this._drainFinalizeQueue?.();

      // CRITICAL: Drain texture queue AFTER finalize - only when elevation data is fetched
      // Textures are applied progressively to reduce GPU sync overhead
      this._drainTextureQueue?.();

      // CRITICAL: Drain grass queue AFTER textures - only when elevation and textures are ready
      // Grass injection is deferred until terrain is fully stable
      this._drainGrassQueue?.();

      this._ensureRelaxList?.();
      this._drainRelaxQueue?.();
      if (this._globalDirty) {
        const t = (typeof now === 'function' ? now() : Date.now());
        if (!this._lastRecolorAt || (t - this._lastRecolorAt > 100)) {
          // CRITICAL: Only apply colors to tiles that have elevation data fetched
          // Skip tiles that haven't been finalized yet
          for (const tile of this.tiles.values()) {
            if (tile._elevationFetched) {
              this._applyAllColorsGlobal(tile);
            }
          }
          this._globalDirty = false;
          this._lastRecolorAt = t;
        }
      }

      // CRITICAL: Process deferred normals updates in batches to reduce GPU sync stalls
      // Limit to 2-3 tiles per frame to stay under budget
      if (this._deferredNormalsTiles && this._deferredNormalsTiles.size > 0) {
        const maxPerFrame = this._isMobile ? 1 : 2;
        let processed = 0;
        for (const tile of this._deferredNormalsTiles) {
          if (processed >= maxPerFrame) break;
          if (tile.grid?.geometry && tile.type !== 'farfield') {
            // CRITICAL: Skip expensive normal computation on mobile - defer to batch processor
            if (!this._isMobile) {
              tile.grid.geometry.computeVertexNormals();
            } else if (tile.grid?.geometry) {
              if (!tile._deferredNormalsUpdate) {
                tile._deferredNormalsUpdate = true;
                if (!this._deferredNormalsTiles) this._deferredNormalsTiles = new Set();
                this._deferredNormalsTiles.add(tile);
              }
            }
          }
          tile._deferredNormalsUpdate = false;
          this._deferredNormalsTiles.delete(tile);
          processed++;
        }
      }

      this._updateFarfieldMergedMesh();
      this._updateHorizonField(playerPos, deltaTime);
      const treeRefreshPerFrame = Math.max(1, Math.round(THREE.MathUtils.lerp(1, 3, this._treeComplexity ?? 0.35)));
      this._serviceTreeRefresh(treeRefreshPerFrame);

      // Update grass animation
      if (this.grassManager && this._grassEnabled) {
        this.grassManager.update(deltaTime);
      }
    };

    // Decide whether to do heavy work this frame
    const doHeavy = tileChanged || this._pendingHeavySweep === true;

    // Always do cheap maintenance each frame
    maintenance();

    if (!doHeavy) {
      // Light populate ping near the edge to keep things lively without cost
      let created = 0;
      const MAX_PINGS = Math.max(1, Math.floor((this.VISUAL_CREATE_BUDGET || 4) * 0.25));
      const R = Math.min(this.VISUAL_RING || 0, (this.INTERACTIVE_RING + 1));
      outerPing:
      for (let dq = -R; dq <= R; dq++) {
        const rMin = Math.max(-R, -dq - R);
        const rMax = Math.min(R, -dq + R);
        for (let dr = rMin; dr <= rMax; dr++) {
          if (nowMs() - startMs > HARD_BUDGET_MS) break outerPing;
          const q = q0 + dq, r = r0 + dr;
          const dist = this._hexDist(q, r, q0, r0);
          if (dist <= this.INTERACTIVE_RING) continue;
          const existing = this.tiles.get(`${q},${r}`);
          if (!existing) {
            this._addVisualTile(q, r);
            if (++created >= MAX_PINGS) break outerPing;
          } else {
            this._queuePopulateIfNeeded?.(existing, false);
          }
        }
      }
      return;
    }

    // ────────────────────────────────────────────────────────────────────────────
    // HEAVY SWEEP (runs on tile change AND keeps resuming while pending)
    // ────────────────────────────────────────────────────────────────────────────
    let budgetHit = false;
    let workDone = 0;

    // CRITICAL: During warmup, severely limit tile creation to prevent cascade
    const warmupTileLimit = this._relayWarmupActive ? (this._isMobile ? 3 : 6) : Infinity;

    // 1) interactive ring
    for (let dq = -this.INTERACTIVE_RING; dq <= this.INTERACTIVE_RING; dq++) {
      if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
      if (workDone >= warmupTileLimit) { budgetHit = true; break; }
      const rMin = Math.max(-this.INTERACTIVE_RING, -dq - this.INTERACTIVE_RING);
      const rMax = Math.min(this.INTERACTIVE_RING, -dq + this.INTERACTIVE_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
        if (workDone >= warmupTileLimit) { budgetHit = true; break; }
        const q = q0 + dq, r = r0 + dr;
        const id = `${q},${r}`;
        const cur = this.tiles.get(id);
        if (!cur) {
          this._addInteractiveTile(q, r); workDone++;
        } else if (cur.type === 'visual') {
          this._promoteVisualToInteractive(q, r); workDone++;
        } else if (cur.type === 'farfield') {
          this._discardTile(id); this._addInteractiveTile(q, r); workDone++;
        }
      }
    }

    // 2) visual ring (respect budget)
    // CRITICAL: Skip visual ring creation entirely during warmup
    if (!budgetHit && !this._relayWarmupActive) {
      let created = 0;
      outerVisual:
      for (let dq = -this.VISUAL_RING; dq <= this.VISUAL_RING; dq++) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
        const rMin = Math.max(-this.VISUAL_RING, -dq - this.VISUAL_RING);
        const rMax = Math.min(this.VISUAL_RING, -dq + this.VISUAL_RING);
        for (let dr = rMin; dr <= rMax; dr++) {
          if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break outerVisual; }
          const q = q0 + dq, r = r0 + dr;
          const dist = this._hexDist(q, r, q0, r0);
          if (dist <= this.INTERACTIVE_RING) continue;
          const id = `${q},${r}`;
          const existing = this.tiles.get(id);
          if (!existing) {
            this._addVisualTile(q, r); workDone++;
            if (++created >= (this.VISUAL_CREATE_BUDGET || 6)) break outerVisual;
          } else {
            if (existing.type === 'farfield') {
              this._discardTile(id); this._addVisualTile(q, r); workDone++;
            } else {
              this._queuePopulateIfNeeded?.(existing, false);
            }
          }
        }
      }
    }

    // 3) farfield (strided + sparse) (respect budget)
    // CRITICAL: Skip farfield creation entirely during warmup
    if (!budgetHit && !this._relayWarmupActive) {
      let farCreated = 0;
      farOuter:
      for (let dq = -this.FARFIELD_RING; dq <= this.FARFIELD_RING; dq++) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
        const rMin = Math.max(-this.FARFIELD_RING, -dq - this.FARFIELD_RING);
        const rMax = Math.min(this.FARFIELD_RING, -dq + this.FARFIELD_RING);
        for (let dr = rMin; dr <= rMax; dr++) {
          if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break farOuter; }
          const q = q0 + dq, r = r0 + dr;
          const dist = this._hexDist(q, r, q0, r0);
          if (dist <= this.VISUAL_RING) continue;

          const tier = this._farfieldTierForDist?.(dist) || { stride: 3, scale: 2, samples: 'sparse', minPrec: 6 };
          const { stride, scale, samples, minPrec, subdivideEdges } = tier;
          if (!this._divisible?.(q - q0, stride) || !this._divisible?.(r - r0, stride)) continue;

          const id = `${q},${r}`;
          const existing = this.tiles.get(id);

          if (!existing) {
            const t = this._addFarfieldTile(q, r, scale, samples);
            t._farMinPrec = minPrec;
            t._subdivideEdges = subdivideEdges || false;
            if (subdivideEdges) this._subdivideInterfaceEdges(t);
            workDone++;
            if (++farCreated >= (this.FARFIELD_CREATE_BUDGET || 16)) break farOuter;
          } else if (existing.type !== 'farfield' ||
            (existing.scale || 1) !== scale ||
            (existing._farSampleMode || 'all') !== samples) {
            this._discardTile(id);
            const t = this._addFarfieldTile(q, r, scale, samples);
            t._farMinPrec = minPrec;
            t._subdivideEdges = subdivideEdges || false;
            if (subdivideEdges) this._subdivideInterfaceEdges(t);
            workDone++;
            if (++farCreated >= (this.FARFIELD_CREATE_BUDGET || 16)) break farOuter;
          } else {
            existing._farMinPrec = minPrec;
            existing._subdivideEdges = subdivideEdges || false;
            if (subdivideEdges) this._subdivideInterfaceEdges(existing);
            this._queuePopulateIfNeeded?.(existing, false);
          }
        }
      }
    }

    // 4) prune/downgrade (respect budget, with hysteresis to prevent thrashing)
    if (!budgetHit) {
      const toRemove = [];
      const toFarfield = [];
      const removalThreshold = this.FARFIELD_RING + this.TILE_REMOVAL_HYSTERESIS;
      const downgradeThreshold = this.VISUAL_RING + this.TILE_DOWNGRADE_HYSTERESIS;

      for (const [id, t] of this.tiles) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
        const dist = this._hexDist(t.q, t.r, q0, r0);

        // Only remove tiles beyond farfield ring + hysteresis buffer
        if (dist > removalThreshold) { toRemove.push(id); continue; }

        // Only downgrade visual->farfield beyond visual ring + hysteresis buffer
        if (dist > downgradeThreshold) {
          if (t.type !== 'farfield') toFarfield.push({ q: t.q, r: t.r });
        }
      }
      for (const id of toRemove) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
        this._discardTile(id); workDone++;
      }
      if (!budgetHit) {
        for (const { q, r } of toFarfield) {
          if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
          const id = `${q},${r}`;
          this._discardTile(id);
          this._addFarfieldTile(q, r); workDone++;
        }
      }
      this._refreshFarfieldAdapters?.(q0, r0);
    }

    // Keep sweeping next frame if we hit the budget or we still did meaningful work
    this._pendingHeavySweep = budgetHit || (workDone > 0);
    this._kickFarfieldIfIdle();

    // (Optional) one-time faster fill: bump budget for first few frames after spawn
    // if (this._spawnBoostUntil && nowMs() < this._spawnBoostUntil) this._pendingHeavySweep = true;
  }


  _ensureType(q, r, want) {
    const id = `${q},${r}`;
    const cur = this.tiles.get(id);
    if (!cur) {
      if (want === 'interactive') return this._addInteractiveTile(q, r);
      if (want === 'visual') return this._addVisualTile(q, r);
      if (want === 'farfield') return this._addFarfieldTile(q, r);
      return null;
    }
    if (cur.type === want) return cur;
    if (want === 'interactive') {
      if (cur.type === 'visual') return this._promoteVisualToInteractive(q, r);
      this._discardTile(id);
      return this._addInteractiveTile(q, r);
    }
    this._discardTile(id);
    if (want === 'visual') return this._addVisualTile(q, r);
    if (want === 'farfield') return this._addFarfieldTile(q, r);
    return null;
  }

  /* ---------------- Origin & relay hooks ---------------- */

  setOrigin(lat, lon, { immediate = false } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const changed =
      !this.origin ||
      Math.abs(lat - this.origin.lat) > 1e-6 ||
      Math.abs(lon - this.origin.lon) > 1e-6;

    this.origin = { lat, lon };
    this._originCacheKey = this._originKeyForCache(lat, lon);

    if (changed) {
      this._resetAllTiles();

      // Try to restore tiles from cache first
      const restoredCount = this._restoreTilesFromCache();

      // If no tiles were restored from cache, create the default ring
      if (restoredCount === 0) {
        // FIX: Create full interactive ring immediately, not just center tile
        // This ensures all nearby tiles are visible on teleport
        for (let dq = -this.INTERACTIVE_RING; dq <= this.INTERACTIVE_RING; dq++) {
          const rMin = Math.max(-this.INTERACTIVE_RING, -dq - this.INTERACTIVE_RING);
          const rMax = Math.min(this.INTERACTIVE_RING, -dq + this.INTERACTIVE_RING);
          for (let dr = rMin; dr <= rMax; dr++) {
            this._ensureType(dq, dr, 'interactive');
          }
        }

        this._prewarmVisualRing(0, 0);
        this._prewarmFarfieldRing(0, 0);
      }

      // FIX: Force heavy sweep to continue populating tiles
      this._pendingHeavySweep = true;
      this._lastQR = { q: 0, r: 0 };
    } else if (immediate && !this.tiles.size) {
      // Try to restore tiles from cache first
      const restoredCount = this._restoreTilesFromCache();

      // If no tiles were restored from cache, create the default ring
      if (restoredCount === 0) {
        // FIX: Same logic for immediate spawn with no tiles
        for (let dq = -this.INTERACTIVE_RING; dq <= this.INTERACTIVE_RING; dq++) {
          const rMin = Math.max(-this.INTERACTIVE_RING, -dq - this.INTERACTIVE_RING);
          const rMax = Math.min(this.INTERACTIVE_RING, -dq + this.INTERACTIVE_RING);
          for (let dr = rMin; dr <= rMax; dr++) {
            this._ensureType(dq, dr, 'interactive');
          }
        }
        this._prewarmVisualRing(0, 0);
        this._prewarmFarfieldRing(0, 0);
      }
      this._pendingHeavySweep = true;
      this._lastQR = { q: 0, r: 0 };
    }

    if (immediate && this.origin) {
      if (!this._originVec) this._originVec = new THREE.Vector3();
      this._originVec.set(0, 0, 0);
      this.update(this._originVec);
    }

    this._scheduleBackfill(10);
  }

  _onRelayStatus(text, level) {
    const health = typeof this.terrainRelay?.getHealth === 'function' ? this.terrainRelay.getHealth() : null;
    const metrics = health?.metrics || null;
    const isConnected = !!(health?.connected || text === 'connected' || level === 'ok');

    this._relayStatus = {
      text,
      level,
      connected: !!health?.connected,
      address: health?.address || this.relayAddress || null,
      metrics,
      heartbeat: health?.heartbeat || null,
    };

    const consecutive = metrics?.consecutiveFailures ?? 0;
    const heartbeatFail = metrics?.heartbeatFail ?? 0;

    // If we're in warmup period after initial connect, skip normal logic
    if (this._relayWarmupActive) {
      // Warmup logic manages concurrency levels
    } else if (!isConnected) {
      this.MAX_CONCURRENT_POPULATES = 6;
      this.RATE_QPS = 6; this.RATE_BPS = 160 * 1024;
    } else if (consecutive >= 6 || heartbeatFail > 2) {
      this.MAX_CONCURRENT_POPULATES = 6;
      this.RATE_QPS = 6; this.RATE_BPS = 160 * 1024;
    } else if (consecutive > 0 || heartbeatFail > 0) {
      this.MAX_CONCURRENT_POPULATES = 12;
      this.RATE_QPS = 18; this.RATE_BPS = 384 * 1024;
    } else {
      this.MAX_CONCURRENT_POPULATES = 18;
      this.RATE_QPS = 36; this.RATE_BPS = 768 * 1024;
    }
    if (this._periodicBackfillPaused && this._relayWasConnected) {
      this._periodicBackfillPaused = false; // resume periodic backfill
    }

    if (this._isMobile) {
      this._applyMobileSafeModeLimits();
    }

    if (isConnected && !this._relayWasConnected) {
      this._relayWasConnected = true;

      console.log('[Terrain] Relay connected - FPS-based adaptive batching enabled');
      console.log('[Terrain] Starting with 1 tile batch (center only), will scale based on FPS');

      // CRITICAL: No more warmup timer - FPS monitor handles concurrency dynamically
      // The AdaptiveBatchScheduler will start with 1 tile and scale up when FPS is healthy

      // Clear any existing warmup timer from previous implementation
      if (this._relayWarmupTimer) {
        clearInterval(this._relayWarmupTimer);
        this._relayWarmupTimer = null;
      }

      // Mark warmup as inactive - adaptive scheduler handles this now
      this._relayWarmupActive = false;
      this._periodicBackfillPaused = false;
      this._kickFarfieldIfIdle();


      // Set conservative initial concurrency - adaptive scheduler will override based on FPS
      this.MAX_CONCURRENT_POPULATES = this._isMobile ? 3 : 6;
      this.RATE_QPS = 6;
      this.RATE_BPS = 160 * 1024;

      if (this._isMobile) this._applyMobileSafeModeLimits();

      // Trigger initial backfill after brief delay to let connection stabilize
      // AdaptiveBatchScheduler will control how many tiles actually get queued
      this._scheduleBackfill(1000);
    }
  }

  _applyMobileSafeModeLimits() {
    if (!this._isMobile) return;
    if (this._mobileSafeModeActive) {
      this.MAX_CONCURRENT_POPULATES = Math.min(this.MAX_CONCURRENT_POPULATES, 1);
      this.RATE_QPS = Math.min(this.RATE_QPS, 2);
      this.RATE_BPS = Math.min(this.RATE_BPS, 96 * 1024);
    } else {
      this.MAX_CONCURRENT_POPULATES = Math.min(this.MAX_CONCURRENT_POPULATES, 4);
      this.RATE_QPS = Math.min(this.RATE_QPS, 8);
      this.RATE_BPS = Math.min(this.RATE_BPS, 256 * 1024);
    }
  }

  _noteMobileInteractiveCompletion(tile) {
    if (!this._mobileSafeModeActive || !tile) return;
    if (tile._mobileSafeCounted) return;
    tile._mobileSafeCounted = true;
    this._mobileSafeModeInteractiveDone = (this._mobileSafeModeInteractiveDone || 0) + 1;
    if (this._mobileSafeModeInteractiveDone >= 6) {
      this._exitMobileSafeMode('interactive');
    }
  }

  _exitMobileSafeMode(reason = 'manual') {
    if (!this._mobileSafeModeActive) return;
    this._mobileSafeModeActive = false;
    if (this._mobileSafeModeTimer) {
      clearTimeout(this._mobileSafeModeTimer);
      this._mobileSafeModeTimer = null;
    }
    this._applyMobileSafeModeLimits();
    console.log(`[tiles] mobile safe mode released (${reason})`);
  }


// tiles.js
_applyPendingSamples() {
  if (!this.tiles) return;
  for (const tile of this.tiles.values()) {
    if (!tile?.pos) continue;

    // If this batch actually wrote vertices, push them once
    if (tile.fetched && tile.fetched.size > 0) {
      this._pushBuffersToGeometry?.(tile);

      // When all verts are ready, flip the elevation gate
      if ((tile.unreadyCount | 0) === 0) {
        tile._elevationFetched = true;
      }

      if (tile.unreadyCount === 0) {
        tile._queuedPhases?.clear?.();
        tile._phase = tile._phase || {};
        tile._phase.fullDone = true;
        tile.populating = false;
      }

      tile.fetched?.clear?.();
    }
  }
  // Let global color/texture passes run
  this._globalDirty = true;
}

  /* ---------------- LOD / perf ---------------- */

  _markRelaxListDirty() { this._relaxKeysDirty = true; }

  _ensureRelaxList() {
    if (!this._relaxKeysDirty) return;
    this._relaxKeys = [];
    for (const [id, tile] of this.tiles.entries()) {
      if (tile.type === 'interactive' && tile.relaxEnabled === true) this._relaxKeys.push(id);
    }
    this._relaxCursor = this._relaxKeys.length ? this._relaxCursor % this._relaxKeys.length : 0;
    this._relaxKeysDirty = false;
  }

  _drainRelaxQueue() {
    if (!this._relaxKeys.length) return;

    const nowPerf = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const start = nowPerf();
    const len = this._relaxKeys.length;
    let processed = 0;

    while (processed < len) {
      if (nowPerf() - start > this.RELAX_FRAME_BUDGET_MS) break;

      if (!this._relaxKeys.length) break;
      const idx = this._relaxCursor % this._relaxKeys.length;
      const tileKey = this._relaxKeys[idx];
      this._relaxCursor = (this._relaxCursor + 1) % this._relaxKeys.length;
      processed++;

      const tile = this.tiles.get(tileKey);
      if (!tile || tile.type !== 'interactive') {
        this._markRelaxListDirty();
        continue;
      }

      if (tile.unreadyCount === 0) continue;

      this._ensureTileBuffers(tile);
      let did = false;
      for (let k = 0; k < this.RELAX_ITERS_PER_FRAME; k++) {
        if (this._relaxOnce(tile)) did = true;
        if (nowPerf() - start > this.RELAX_FRAME_BUDGET_MS) break;
      }
      if (did) this._pushBuffersToGeometry(tile);
    }
  }

  applyPerfProfile(profile = {}) {
    const qualityRaw = Number.isFinite(profile?.quality) ? profile.quality : this._lodQuality;
    const qualityClamp = THREE.MathUtils.clamp(qualityRaw, 0.3, 1.2);
    this._lodQuality = qualityClamp;

    const qMin = 0.3;
    const qMax = 1.05;
    const norm = THREE.MathUtils.clamp((qualityClamp - qMin) / (qMax - qMin), 0, 1);

    const baseInteractive = this._baseLod.interactiveRing;
    const baseVisual = this._baseLod.visualRing;
    const baseFarfieldExtra = Number.isFinite(this._baseLod.farfieldExtra)
      ? this._baseLod.farfieldExtra
      : Math.max(1, this._baseLod.farfieldRing - this._baseLod.visualRing);
    const baseVisualBudget = this._baseLod.visualCreateBudget || 4;
    const baseFarfieldBudget = this._baseLod.farfieldCreateBudget || 60;
    const baseFarfieldBatch = this._baseLod.farfieldBatchSize || this.FARFIELD_BATCH_SIZE;
    const baseRelaxIters = this._baseLod.relaxIters || this.RELAX_ITERS_PER_FRAME;
    const baseRelaxBudget = this._baseLod.relaxBudget || this.RELAX_FRAME_BUDGET_MS;

    const interactiveMin = Math.max(1, Math.round(baseInteractive * 0.5));
    const interactiveMax = Math.max(interactiveMin + 1, Math.round(baseInteractive * 1.35));
    const interactiveRing = Math.max(1, Math.round(THREE.MathUtils.lerp(interactiveMin, interactiveMax, norm)));

    const visualMin = Math.max(interactiveRing + 1, Math.round(baseVisual * 0.55));
    const visualMax = Math.max(visualMin + 1, Math.round(baseVisual * 1.25));
    const visualRing = Math.max(interactiveRing + 1, Math.round(THREE.MathUtils.lerp(visualMin, visualMax, norm)));

    const farfieldExtraMin = Math.max(4, Math.round(baseFarfieldExtra * 0.4));
    const farfieldExtraMax = Math.max(farfieldExtraMin, Math.round(baseFarfieldExtra * 1.3));
    const farfieldExtra = Math.max(1, Math.round(THREE.MathUtils.lerp(farfieldExtraMin, farfieldExtraMax, norm)));

    let ringChanged = false;
    if (this.INTERACTIVE_RING !== interactiveRing) { this.INTERACTIVE_RING = interactiveRing; ringChanged = true; }
    if (this.VISUAL_RING !== visualRing) { this.VISUAL_RING = visualRing; ringChanged = true; }
    const targetFarfieldRing = this.VISUAL_RING + farfieldExtra;
    if (this.FARFIELD_RING !== targetFarfieldRing) {
      this.FARFIELD_RING = targetFarfieldRing;
      this.FARFIELD_EXTRA = farfieldExtra;
      ringChanged = true;
    }
    if (ringChanged) {
      this._markRelaxListDirty();
      this._prewarmVisualRing(0, 0);
      this._prewarmFarfieldRing(0, 0);
      this._scheduleBackfill(0);
    }

    const visualBudgetBase = Math.max(1, Math.round(THREE.MathUtils.lerp(baseVisualBudget * 0.25, baseVisualBudget, norm)));
    const farfieldCreateBase = Math.max(4, Math.round(THREE.MathUtils.lerp(baseFarfieldBudget * 0.35, baseFarfieldBudget * 1.15, norm)));
    const farfieldBatchBase = Math.max(4, Math.round(THREE.MathUtils.lerp(Math.max(8, baseFarfieldBatch * 0.5), baseFarfieldBatch * 1.1, norm)));

    const fetchBoost = TERRAIN_FETCH_BOOST;
    const boostedVisualBudget = Math.max(visualBudgetBase, Math.round(baseVisualBudget * fetchBoost));
    const boostedFarfieldCreate = Math.max(farfieldCreateBase, Math.round(baseFarfieldBudget * fetchBoost));
    const boostedFarfieldBatch = Math.max(farfieldBatchBase, Math.round(baseFarfieldBatch * fetchBoost));

    this.VISUAL_CREATE_BUDGET = boostedVisualBudget;
    this.FARFIELD_CREATE_BUDGET = boostedFarfieldCreate;
    this.FARFIELD_BATCH_SIZE = boostedFarfieldBatch;

    this.RELAX_ITERS_PER_FRAME = Math.max(1, Math.round(THREE.MathUtils.lerp(Math.max(4, baseRelaxIters * 0.45), baseRelaxIters * 1.25, norm)));
    this.RELAX_FRAME_BUDGET_MS = +(THREE.MathUtils.lerp(Math.max(0.6, baseRelaxBudget * 0.6), baseRelaxBudget * 1.45, norm).toFixed(2));

    for (const tile of this.tiles.values()) {
      if (!tile?.wire?.material?.userData) continue;
      const dist = this._hexDist(tile.q, tile.r, 0, 0);
      let fade = tile.wire.material.userData.uFade;
      if (tile.type === 'interactive') fade = this._interactiveWireFade(dist);
      else if (tile.type === 'visual') fade = this._visualWireFade(dist);
      tile.wire.material.userData.uFade = fade;
    }

    return {
      quality: this._lodQuality,
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldRing: this.FARFIELD_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      visualCreateBudget: this.VISUAL_CREATE_BUDGET,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      relaxIters: this.RELAX_ITERS_PER_FRAME,
      relaxBudget: Number(this.RELAX_FRAME_BUDGET_MS.toFixed(2)),
    };
  }

  getTerrainSettings() {
    return {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      tileRadius: this.tileRadius,
      spacing: this.spacing,
    };
  }

  getDefaultTerrainSettings() {
    return { ...this._defaultTerrainSettings };
  }

  updateTerrainSettings({
    interactiveRing,
    visualRing,
    farfieldExtra,
    farfieldCreateBudget,
    farfieldBatchSize,
    farfieldNearPad,
    tileRadius,
    spacing,
  } = {}) {
    let needReset = false;
    if (Number.isFinite(tileRadius) && tileRadius > 10 && tileRadius !== this.tileRadius) {
      this.tileRadius = tileRadius;
      needReset = true;
    }
    if (Number.isFinite(spacing) && spacing > 0 && spacing !== this.spacing) {
      this.spacing = spacing;
      needReset = true;
    }

    if (Number.isFinite(interactiveRing)) {
      this.INTERACTIVE_RING = Math.max(1, Math.round(interactiveRing));
    }
    if (Number.isFinite(visualRing)) {
      this.VISUAL_RING = Math.max(this.INTERACTIVE_RING + 1, Math.round(visualRing));
    }
    if (Number.isFinite(farfieldExtra)) {
      this.FARFIELD_EXTRA = Math.max(1, Math.round(farfieldExtra));
    }
    this.FARFIELD_RING = this.VISUAL_RING + this.FARFIELD_EXTRA;

    if (Number.isFinite(farfieldCreateBudget)) {
      this.FARFIELD_CREATE_BUDGET = Math.max(1, Math.round(farfieldCreateBudget));
    }
    if (Number.isFinite(farfieldBatchSize)) {
      this.FARFIELD_BATCH_SIZE = Math.max(1, Math.round(farfieldBatchSize));
    }
    if (Number.isFinite(farfieldNearPad)) {
      this.FARFIELD_NEAR_PAD = Math.max(0, Math.round(farfieldNearPad));
    }

    this._baseLod = {
      ...this._baseLod,
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
    };

    if (needReset) {
      this._resetAllTiles();
      if (this.origin) {
        this._ensureType(0, 0, 'interactive');
        this._prewarmVisualRing(0, 0);
        this._prewarmFarfieldRing(0, 0);
      }
    } else {
      this._markRelaxListDirty();
      if (this.origin) {
        this._prewarmVisualRing(0, 0);
        this._prewarmFarfieldRing(0, 0);
      }
    }
    this._markHorizonDirty();
    this._scheduleBackfill(0);
  }

  resetTerrainSettings() {
    this.updateTerrainSettings(this.getDefaultTerrainSettings());
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  /* ---------------- Queries & controls ---------------- */

  _worldToAxialFloat(x, z) {
    const a = this.tileRadius;
    const q = (2 / 3) * (x / a);
    const r = ((-1 / 3) * (x / a)) + ((Math.sqrt(3) / 3) * (z / a));
    return { q, r };
  }

  _axialRound(q, r) {
    let x = q;
    let y = r;
    let z = -x - y;
    let rx = Math.round(x);
    let ry = Math.round(y);
    let rz = Math.round(z);

    const xDiff = Math.abs(rx - x);
    const yDiff = Math.abs(ry - y);
    const zDiff = Math.abs(rz - z);

    if (xDiff > yDiff && xDiff > zDiff) {
      rx = -ry - rz;
    } else if (yDiff > zDiff) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }
    return { q: rx, r: ry };
  }

  _axialNeighbors(q, r) {
    return [
      { q: q + 1, r },
      { q: q + 1, r: r - 1 },
      { q, r: r - 1 },
      { q: q - 1, r },
      { q: q - 1, r: r + 1 },
      { q, r: r + 1 },
    ];
  }

  _collectHeightMeshesNear(x, z) {
    const centerFloat = this._worldToAxialFloat(x, z);
    const center = this._axialRound(centerFloat.q, centerFloat.r);
    const coords = [center, ...this._axialNeighbors(center.q, center.r)];
    const meshes = [];
    for (const { q, r } of coords) {
      const tile = this.tiles.get(`${q},${r}`);
      if (tile?.type === 'interactive' && tile.grid?.mesh) meshes.push(tile.grid.mesh);
    }
    if (meshes.length) return meshes;
    if (!this._heightMeshesFallback.length) {
      for (const t of this.tiles.values()) {
        if (t.type === 'interactive' && t.grid?.mesh) this._heightMeshesFallback.push(t.grid.mesh);
      }
    }
    return this._heightMeshesFallback;
  }

  _sampleHeightFromNeighbors(x, z, excludeTile = null) {
    const meshes = this._collectHeightMeshesNear(x, z).slice();
    if (excludeTile?.grid?.mesh) {
      const idx = meshes.indexOf(excludeTile.grid.mesh);
      if (idx !== -1) meshes.splice(idx, 1);
    }
    if (!meshes.length) return null;
    this._tmpSampleVec.set(x, 10000, z);
    this.ray.set(this._tmpSampleVec, this.DOWN);
    const hits = this.ray.intersectObjects(meshes, true);
    if (!hits.length) return null;
    return hits[0].point.y;
  }

  _collectMeshesNearByType(x, z, types = []) {
    if (!Array.isArray(types) || !types.length) return [];
    if (!Number.isFinite(x) || !Number.isFinite(z)) return [];
    const axialFloat = this._worldToAxialFloat(x, z);
    if (!axialFloat) return [];
    const center = this._axialRound(axialFloat.q, axialFloat.r);
    if (!center) return [];
    const coords = [center, ...this._axialNeighbors(center.q, center.r)];
    const out = [];
    for (const { q, r } of coords) {
      const tile = this.tiles.get(`${q},${r}`);
      if (!tile || !types.includes(tile.type)) continue;
      const mesh = tile.grid?.mesh;
      if (!mesh || mesh.visible === false) continue;
      out.push(mesh);
    }
    return out;
  }

  _seedTileFromNeighbors(tile) {
    if (!tile || !this.origin || !tile.pos || !tile.grid?.group) return false;
    const pos = tile.pos;
    const ready = tile.ready;
    const base = tile.grid.group.position;
    let seeded = 0;
    for (let i = 0; i < pos.count; i++) {
      if (ready && ready[i]) continue;
      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);
      const sampled = this._sampleHeightFromNeighbors(wx, wz, tile);
      if (!Number.isFinite(sampled)) continue;
      const current = pos.getY(i);
      if (Number.isFinite(current) && Math.abs(current - sampled) < 0.01) continue;
      pos.setY(i, sampled);
      this._updateGlobalFromValue(sampled);
      seeded++;
    }
    if (seeded) {
      pos.needsUpdate = true;
      tile.grid.geometry?.computeVertexNormals?.();
    }
    return seeded > 0;
  }

  _heightCacheKey(x, z) {
    const scale = this._heightCacheScale;
    const qx = Math.round(x * scale);
    const qz = Math.round(z * scale);
    return `${qx}:${qz}`;
  }

  _invalidateHeightCache() {
    this._heightCache.clear();
    this._heightMeshesFallback.length = 0;
  }

  getHeightAt(x, z) {
    const perfNow = performance?.now ? performance.now.bind(performance) : null;
    const start = perfNow ? perfNow() : Date.now();
    const now = perfNow ? perfNow() : Date.now();
    const key = this._heightCacheKey(x, z);
    const cached = this._heightCache.get(key);
    if (cached && (now - cached.t) < this._heightCacheTTL) {
      return cached.h;
    }

    const tmp = new THREE.Vector3(x, 10000, z);
    let source = 'interactive';
    let meshes = this._collectHeightMeshesNear(x, z) || [];
    this.ray.set(tmp, this.DOWN);
    let hit = meshes.length ? this.ray.intersectObjects(meshes, true) : [];

    if (!hit.length) {
      const visualMeshes = this._collectMeshesNearByType(x, z, ['visual']);
      if (visualMeshes.length) {
        source = 'visual';
        meshes = visualMeshes;
        hit = this.ray.intersectObjects(visualMeshes, true);
      }
    }

    if (!hit.length) {
      const farfieldMeshes = [];
      const mergedMesh = (this._farfieldMerge?.mesh && this._farfieldMerge.mesh.visible !== false)
        ? this._farfieldMerge.mesh
        : null;
      if (mergedMesh) farfieldMeshes.push(mergedMesh);
      const nearbyFarfield = this._collectMeshesNearByType(x, z, ['farfield']);
      if (nearbyFarfield.length) {
        for (const mesh of nearbyFarfield) {
          if (!mesh || mesh.visible === false) continue;
          farfieldMeshes.push(mesh);
        }
      }
      if (farfieldMeshes.length) {
        source = mergedMesh && farfieldMeshes.length === 1 ? 'farfield-merged' : 'farfield';
        meshes = farfieldMeshes;
        hit = this.ray.intersectObjects(farfieldMeshes, true);
      }
    }

    let result = this._lastHeight;
    if (hit.length) {
      result = hit[0].point.y;
      this._lastHeight = result;
    }
    this._heightCache.set(key, { h: result, t: now });
    if (this._heightCache.size > 4096) this._heightCache.clear();

    const duration = (perfNow ? perfNow() : Date.now()) - start;
    const logNow = perfNow ? perfNow() : Date.now();
    if ((!this._perfLogNext || logNow >= this._perfLogNext) && duration > 2) {
      console.log(`[tiles.getHeightAt] source=${source} meshes=${meshes.length} hit=${hit.length > 0} duration=${duration.toFixed(2)}ms`);
      this._perfLogNext = logNow + 2000;
    }
    return result;
  }

  hasInteractiveTerrainAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const axialFloat = this._worldToAxialFloat(x, z);
    if (!axialFloat) return false;
    const axial = this._axialRound(axialFloat.q, axialFloat.r);
    const tile = this.tiles.get(`${axial.q},${axial.r}`);
    if (!tile || tile.type !== 'interactive') return false;
    const seedDone = tile._phase?.seedDone;
    if (!seedDone) return false;
    if (!Number.isFinite(tile.unreadyCount)) return true;
    const total = Number.isFinite(tile.pos?.count) ? tile.pos.count : Infinity;
    return tile.unreadyCount < total;
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
    this.terrainRelay?.setRelayAddress(this.relayAddress);
    if (this._relayStatus) this._relayStatus.address = this.relayAddress || null;
    this._scheduleBackfill(0);
  }

  setRelayDataset(dataset) {
    this.relayDataset = (dataset || '').trim() || DEFAULT_TERRAIN_DATASET;
    this.terrainRelay?.setDataset(this.relayDataset);
    this._scheduleBackfill(0);
  }

  setRelayMode(mode) {
    this.relayMode = mode === 'latlng' ? 'latlng' : 'geohash';
    this.terrainRelay?.setMode(this.relayMode);
    this._scheduleBackfill(0);
  }

  getRelayStatus() {
    const pipeline = this._collectPipelineStats();
    return { ...this._relayStatus, pipeline };
  }

  // tiles.js — inside TileManager
setOverlayEnabled(on) {
  const want = !!on;
  if (this._overlayEnabled === want) return;
  this._overlayEnabled = want;
  // Tear down or ensure for current tiles
  for (const t of this.tiles.values()) {
    if (want) this._ensureTileOverlay(t);
    else this._teardownOverlayForTile(t);
  }
}


getRasterColorAt(x, z, { averageRadius = 0, samples = 1 } = {}) {
  // If overlays are disabled, nothing to sample
  if (!this._overlayEnabled || !this.origin) return null;

  // Find the tile we’re on by rounding axial coords
  const { q, r } = this._axialRound(this._worldToAxialFloat(x, z));
  const tile = this.tiles.get(`${q},${r}`);
  if (!tile) return null;

  // Ensure an overlay request is in-flight for this tile (won’t block)
  this._ensureTileOverlay(tile);

  // Try to find a ready overlay entry (texture.image is the canvas we drew)
  const cacheKey = tile._overlay?.cacheKey;
  const entry = cacheKey ? this._overlayCache.get(cacheKey) : tile._overlay?.entry;
  const canvas = entry?.texture?.image || entry?.canvas;
  const bounds = entry?.bounds;
  const imgSize = entry?.imageSize;
  if (!canvas || !bounds || !imgSize) return null;

  // World -> lat/lon -> UV in the entry bounds
  const toUV = (wx, wz) => {
    const { lat, lon } = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
    const lonSpan = Math.max(1e-12, bounds.lonMax - bounds.lonMin);
    const latSpan = Math.max(1e-12, bounds.latMax - bounds.latMin);
    const u = (lon - bounds.lonMin) / lonSpan;
    const v = (bounds.latMax - lat) / latSpan;  // Mercator tiles are top-origin
    return { u, v };
  };

  // Read a single pixel (clamped) from the canvas
  const readUV = (u, v) => {
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    // Half-texel inset to match your UV padding approach
    const px = Math.max(0, Math.min(canvas.width  - 1, Math.floor(u * (canvas.width  - 1))));
    const py = Math.max(0, Math.min(canvas.height - 1, Math.floor(v * (canvas.height - 1))));
    const d = ctx.getImageData(px, py, 1, 1).data;
    return { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255 };
  };

  if (!Number.isFinite(averageRadius) || averageRadius <= 0 || !Number.isFinite(samples) || samples <= 1) {
    const { u, v } = toUV(x, z);
    return readUV(u, v);
  }

  // Average N jittered taps in a disk of averageRadius
  let acc = { r: 0, g: 0, b: 0 }, hit = 0;
  for (let i = 0; i < samples; i++) {
    const a = Math.random() * Math.PI * 2;
    const rj = Math.random() * averageRadius;
    const { u, v } = toUV(x + Math.cos(a) * rj, z + Math.sin(a) * rj);
    const c = readUV(u, v);
    if (c) { acc.r += c.r; acc.g += c.g; acc.b += c.b; hit++; }
  }
  return hit ? { r: acc.r / hit, g: acc.g / hit, b: acc.b / hit } : null;
}
  refreshTiles() {
    this._invalidateHeightCache();
    for (const tile of this.tiles.values()) {
      tile.ready.fill(0);
      tile.fetched.clear();
      tile.unreadyCount = tile.pos.count;
      this._initColorsNearBlack(tile);
      tile.populating = false;
      tile._queuedPhases?.clear?.();

      if (!tile._phase) tile._phase = {};
      if (tile.type === 'interactive') tile._phase = { seedDone: false, edgeDone: false, fullDone: false };
      else tile._phase = { fullDone: false };

      if (!tile.locked || tile.locked.length !== tile.pos.count) tile.locked = new Uint8Array(tile.pos.count);
      else tile.locked.fill(0);
      if (tile.type === 'interactive') tile.relaxEnabled = false;

      if (tile.wire?.material?.userData) {
        const dist = this._hexDist(tile.q, tile.r, 0, 0);
        const fade = tile.type === 'interactive'
          ? this._interactiveWireFade(dist)
          : (tile.type === 'visual' ? this._visualWireFade(dist) : tile.wire.material.userData.uFade);
        tile.wire.material.userData.uFade = fade;
      }

      this._queuePopulate(tile, tile.type === 'interactive');
    }
    this._fetchPhase = 'interactive';
    this._markRelaxListDirty();
    this._scheduleBackfill(0);
  }

  invalidateHeightCache() {
    this._invalidateHeightCache();
  }

  /* ---------------- Cleanup ---------------- */

  _discardTile(id) {
    const t = this.tiles.get(id);
    const q = Number.isFinite(t?.q) ? t.q : null;
    const r = Number.isFinite(t?.r) ? t.r : null;
    if (t) this._stashOverlayForId(id, t);
    if (!t) return;
    if (t._treeGroup) this._clearTileTrees(t);
    if (t._overlay?.cacheKey) {
      const entry = this._overlayCache.get(t._overlay.cacheKey);
      entry?.waiters?.delete?.(t);
    }
    this._teardownOverlayForTile(t);
    if (t._overlay) t._overlay = null;
    if (t.type === 'farfield') {
      const key = this._farfieldAdapterKey(t);
      if (key) this._farfieldAdapterDirty.delete(key);
      this._markFarfieldMergeDirty(t);
    }
    this.scene.remove(t.grid.group);
    try {
      if (t._adapter?.mesh) {
        t._adapter.mesh.geometry?.dispose?.();
      }
      t.grid.geometry?.dispose?.();
      t.grid.mat?.dispose?.();
      const mesh = t.grid?.mesh;
      if (mesh?.material) {
        const mat = mesh.material;
        if (mat !== this._terrainMat && mat !== this._farfieldMat) {
          try { mat.map = null; } catch { /* noop */ }
          mat.dispose?.();
        }
      }
      t.wire?.material?.dispose?.();
    } catch { }
    t._adapter = null;
    t._adapterDirty = false;
    this._deferredInteractive.delete(t);
    this.tiles.delete(id);
    this._markRelaxListDirty();
    if (Number.isFinite(q) && Number.isFinite(r)) {
      this._restitchInteractiveNeighbors(q, r);
    }
    this._markHorizonDirty();
  }

  _resetAllTiles() {
    for (const id of Array.from(this.tiles.keys())) this._discardTile(id);
    this.tiles.clear();
    this._disposeFarfieldMergedMesh();
    this._disposeHorizonField();
    this._populateQueue.length = 0;
    this._populateBusy = false;
    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._globalDirty = true;
    this._lastRecolorAt = 0;
    this._relaxKeys = [];
    this._relaxCursor = 0;
    this._relaxKeysDirty = true;
    this._lastHeight = 0;
    this._fetchPhase = 'interactive';
    this._deferredInteractive.clear();
    this._interactiveSecondPass = false;
    this._farfieldAdapterDirty.clear();
  }

  /* ---------------- Public cache management API ---------------- */

  /**
   * Manually restore all cached tiles for the current origin.
   * Useful for reloading terrain data after a page refresh.
   * @returns {number} Number of tiles restored from cache
   */
  restoreCachedTiles() {
    return this._restoreTilesFromCache();
  }

  /**
   * Clear all cached tile data from localStorage.
   * @param {Object} options - Cleanup options
   * @param {boolean} options.currentOriginOnly - Only clear tiles for current origin
   * @param {boolean} options.oldVersionsOnly - Only clear tiles from old cache versions
   */
  clearTileCache({ currentOriginOnly = false, oldVersionsOnly = false } = {}) {
    try {
      const keysToRemove = [];

      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;

        // Match tile cache keys and seed cache keys
        if (key.startsWith('tile:') || key.startsWith('tileSeed:')) {
          if (oldVersionsOnly) {
            // Only remove if not current version
            if (!key.startsWith(`tile:${this.CACHE_VER}:`) && !key.startsWith(`tileSeed:${this.CACHE_VER}:`)) {
              keysToRemove.push(key);
            }
          } else if (currentOriginOnly) {
            // Only remove if matches current origin
            const prefix1 = `tile:${this.CACHE_VER}:${this._originCacheKey}:`;
            const prefix2 = `tileSeed:${this.CACHE_VER}:${this._originCacheKey}:`;
            if (key.startsWith(prefix1) || key.startsWith(prefix2)) {
              keysToRemove.push(key);
            }
          } else {
            // Remove all tile cache entries
            keysToRemove.push(key);
          }
        }
      }

      for (const key of keysToRemove) {
        localStorage.removeItem(key);
      }

      console.log(`[tiles] Cleared ${keysToRemove.length} cached tiles`);
      return keysToRemove.length;

    } catch (err) {
      console.warn('[tiles] Error clearing cache:', err);
      return 0;
    }
  }

  /**
   * Private: Clean up old cache versions on initialization
   */
  _cleanupOldCacheVersions() {
    try {
      const removed = this.clearTileCache({ oldVersionsOnly: true });
      if (removed > 0) {
        console.log(`[tiles] Cleaned up ${removed} old cache entries on initialization`);
      }
    } catch (err) {
      console.warn('[tiles] Error cleaning up old cache:', err);
    }
  }

  dispose() {
    if (this._backfillTimer) { clearTimeout(this._backfillTimer); this._backfillTimer = null; }
    if (this._periodicBackfill) { clearInterval(this._periodicBackfill); this._periodicBackfill = null; }
    if (this._rateTicker) { clearInterval(this._rateTicker); this._rateTicker = null; }
    if (this._relayWarmupTimer) { clearInterval(this._relayWarmupTimer); this._relayWarmupTimer = null; }
    if (this._mobileSafeModeTimer) { clearTimeout(this._mobileSafeModeTimer); this._mobileSafeModeTimer = null; }
    this._resetAllTiles();
    this.tiles.clear();
    if (this._farfieldMat) {
      this._farfieldMat.dispose();
      this._farfieldMat = null;
    }
    this._heightListeners?.clear?.();
  }
}
