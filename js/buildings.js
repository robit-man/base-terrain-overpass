import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CSS3DRenderer, CSS3DObject } from 'three/addons/renderers/CSS3DRenderer.js';
import { metresPerDegree } from './geolocate.js';

const FEATURES = {
  BUILDINGS: true,
  ROADS: true,
  WATERWAYS: true,
  AREAS: false,
};

const OVERPASS_URL = 'https://overpass.kumi.systems/api/interpreter';
const CACHE_PREFIX = 'bm.tile';
const CACHE_LIMIT = 1320;
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
const MERGE_BUDGET_MS = 8; // milliseconds per idle slice
const BUILD_FRAME_BUDGET_MS = 8; // ms budget to spend per frame on feature builds
const BUILD_IDLE_BUDGET_MS = 8; // ms budget when we have idle time available
const RESNAP_INTERVAL = 0.2; // seconds between ground rescan passes
const RESNAP_FRAME_BUDGET_MS = 10; // ms per frame allotted to resnap tiles
const TARGET_FPS = 60;

/* ---------------- helpers ---------------- */
// --- DuckDuckGo helpers (use HTML/Lite for embeddable results) ---
const DDG_ENDPOINTS = [
  'https://html.duckduckgo.com/html/?q=', // primary
  'https://duckduckgo.com/html/?q=',
  'https://duckduckgo.com/lite/?q='       // minimal fallback
];

const ddgEncode = (s) => encodeURIComponent(s).replace(/%20/g, '+'); // "spaces" -> '+'
const ddgMainUrl = (q) => `https://duckduckgo.com/?q=${ddgEncode(q)}&ia=web`; // your requested format

function setDuckIframeSrc(iframe, query, onFail) {
  let i = 0, loaded = false;
  const tryNext = () => {
    if (i >= DDG_ENDPOINTS.length) { onFail?.(); return; }
    loaded = false;
    iframe.onload = () => { loaded = true; };
    iframe.src = `${DDG_ENDPOINTS[i]}${ddgEncode(query)}&ia=web`;
    // If CSP blocks, 'load' won't fire — advance after a short timeout
    setTimeout(() => { if (!loaded) { i += 1; tryNext(); } }, 1200);
  };
  tryNext();
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

/* ========================================================================== */
/*                            BuildingManager                                  */
/* ========================================================================== */

export class BuildingManager {
  constructor({
    scene,
    camera,
    tileManager,
    radius = 1000,
    tileSize,
    color = 0x333333,
    roadWidth = 3,
    roadOffset = 0.05,
    roadStep = 14,
    roadAdaptive = true,
    roadMinStep = 1,
    roadMaxStep = 28,
    roadAngleThresh = 0.15,
    roadMaxSegments = 36,
    roadLit = false,
    roadShadows = false,
    roadColor = 0x202020,
    extraDepth = -3.5,
    extensionHeight = 3.5,
    inputEl = null,            // NEW
    holdToOpenMs = 200,        // NEW (optional override)

    maxConcurrentFetches = 1, // retained for API compatibility
  } = {}) {
    this._duckScale = 0.10; // 10% of current size
    this._duckPersistMs = 0;
    this._duckHideTimer = null;
    this.scene = scene;
    this.camera = camera;
    this.tileManager = tileManager;
    this._radiusOverride = Number.isFinite(radius) ? radius : null;
    const visualRadius = this._computeVisualRingRadius();
    const initialRadius = Number.isFinite(this._radiusOverride)
      ? this._radiusOverride
      : (Number.isFinite(visualRadius) ? visualRadius : 1000);
    this.radius = initialRadius;
    this._baseRadius = initialRadius;
    this._defaultRadius = initialRadius;
    this._currentPerfQuality = 1;
    this.tileSize = tileSize || (tileManager?.tileRadius ? tileManager.tileRadius * 1.75 : 160);
    this._tileDiagHalf = this.tileSize * Math.SQRT2 * 0.5;
    const spanBase = Math.ceil((this.radius + this.tileSize) / Math.max(1, this.tileSize));
    this._tileSpanCap = Math.max(6, spanBase + 2);
    this.color = color;
    this.roadWidth = roadWidth;
    this.roadOffset = roadOffset;
    this.roadStep = roadStep;
    this.roadAdaptive = roadAdaptive;
    this.roadMinStep = roadMinStep;
    this.roadMaxStep = roadMaxStep;
    this.roadAngleThresh = roadAngleThresh;
    this.roadMaxSegments = roadMaxSegments;
    this.roadLit = roadLit;
    this.roadShadows = roadShadows;
    this.roadColor = roadColor;
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
    this._hoverLabel = null;                 // (kept, but hidden when CSS3D panel is shown)
    this._hoverLabelCanvas = null;
    this._hoverLabelCtx = null;
    this._hoverLabelTexture = null;
    this._hoverInfo = null;
    this.physics = null;
    this._addressToast = null;
    this._addressToastNameEl = null;
    this._addressToastAddrEl = null;
    this._addressToastHideTimer = null;

    // ---------- CSS3D panel (DuckDuckGo) ----------
    this._holdToOpenMs = holdToOpenMs;

    this._cssEnabled = false;

    // NEW: optionally pass the canvas (or container) so we can listen for pointer events
    this._inputEl = inputEl || (typeof document !== 'undefined' ? document.querySelector('canvas') : null);

    // only create CSS3D if explicitly re-enabled later
    if (this._cssEnabled) this._ensureCSS3DLayer();

    // NEW: press-and-hold wiring
    this._pressTimer = null;
    this._pressActive = false;
    this._pressInfo = null;
    this._pressDownPos = null;
    this._pressMoveSlop = 8;      // px tolerance while holding

    // Debug / diagnostics
    this._debugEnabled = true;
    this._debugLogIntervalMs = 1500;
    this._nextBuildLogMs = 0;
    this._nextMergeLogMs = 0;
    this._nextResnapLogMs = 0;
    this._nextRoadLogMs = 0;
    this._bindPressListeners();

    this._cssScene = null;
    this._cssRenderer = null;
    this._cssRootEl = null;
    this._cssPanelObj = null;
    this._cssPanelQueryKey = null; // track last query
    this._cssPanelVisible = false;

    this.lat0 = null;
    this.lon0 = null;
    this.lat = null;
    this.lon = null;
    this._hasOrigin = false;

    // NOTE: signs UI kept for compatibility
    this.solidSign = [1, 1, 1, 1, 1, 1];

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
    this._resnapDirtyQueue = [];
    this._resnapDirtyIndex = 0;
    this._resnapDirtyTiles = new Set();
    this._resnapDirtyMaxPerFrame = 2;
    this._resnapHotBudgetMs = 0.6;
    this._fetchBatchSize = 8;
    this._fetchCooldownMs = 250;
    this._lastFetchMs = -Infinity;
    this._pendingFetchTiles = new Set();
    this._resnapVerifyIntervalMs = 1500;
    this._resnapVerifyNextMs = 0;
    this._resnapVerifyCursor = 0;
    this._resnapVerifyBatch = 12;
    this._resnapVerifyTolerance = 0.12;
    this._pendingTerrainTiles = new Set();

    this._wireframeMode = false;

    const envTexture = scene?.environment || null;
    this._buildingMaterial = new THREE.MeshPhysicalMaterial({
      //color: new THREE.Color(0xaeb6c2),
      transmission: 1,
      thickness: 2,
      roughness: 0.65,
      //metalness: 0,
      iridescence: 1,
      iridescenceIOR: 1.2,
      clearcoat: 0.1,
      clearcoatRoughness: 0.05,
      envMap: envTexture,
      envMapIntensity: 0.6,
      //vertexColors: true,
      //transparent: true,
      //opacity: 0.96,
      side: THREE.BackSide
    });
    this._roadMaterial = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      thickness: 2,
      roughness: 0.65,
      //metalness: 0,
      iridescence: 1,
      iridescenceIOR: 1.2,
      clearcoat: 0.1,
      clearcoatRoughness: 0.05,
      envMap: envTexture,
      envMapIntensity: 0.6,
      side: THREE.FrontSide
    });
    this._waterMaterialShared = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0x1f3f55),
      envMap: envTexture,
      envMapIntensity: 0.4,
      transparent: true,
      opacity: 0.65,
      vertexColors: true,
    });
    this._areaMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0x7c8b95),
      transparent: true,
      opacity: 0.35,
      vertexColors: true,
      depthWrite: false
    });

    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();

    this._edgeMaterial = new THREE.LineBasicMaterial({ color: 0xa7adb7, transparent: true, opacity: 0.05 });
    this._highlightEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, transparent: true, opacity: 1 });
    this._stemMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, linewidth: 1, transparent: true, opacity: 0.9 });
    this._pickMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0 });
    this._pickMaterial.depthWrite = false;
    this._pickMaterial.depthTest = false;

    this._trackingNode = null;
    if (camera?.parent?.isObject3D) {
      this._trackingNode = camera.parent;
    } else if (scene?.getObjectByName) {
      this._trackingNode = scene.getObjectByName('player-dolly') || null;
    }

    this._cachePrefix = `${CACHE_PREFIX}:${this.tileSize}:`;
    const offsetBase = Math.max(4, this.tileSize * 0.6);
    this._resnapOffsets = [
      [0, 0],
      [offsetBase, 0],
      [-offsetBase, 0],
      [0, offsetBase],
      [0, -offsetBase],
      [offsetBase, offsetBase],
      [offsetBase, -offsetBase],
      [-offsetBase, offsetBase],
      [-offsetBase, -offsetBase],
    ];
    if (this.tileManager?.addHeightListener) {
      this._heightListenerDispose = this.tileManager.addHeightListener((evt) => this._handleTerrainHeightChange(evt));
    }

    // QoS / performance state (auto-tuned via updateQoS)
    this._qosLevel = 'high';
    this._smoothedFps = TARGET_FPS;
    this._frameBudgetMs = BUILD_FRAME_BUDGET_MS;
    this._idleBudgetMs = BUILD_IDLE_BUDGET_MS;
    this._mergeBudgetMs = MERGE_BUDGET_MS;
    this._resnapFrameBudgetMs = RESNAP_FRAME_BUDGET_MS;
    this._resnapInterval = RESNAP_INTERVAL;
    this._tileUpdateInterval = 0.25; // seconds — 0 = every frame
    this._tileUpdateTimer = 0;
    this._resnapTimer = 0;
    this._qosTargetFps = TARGET_FPS;

    // Init CSS3D (non-invasive overlay)
    this._ensureCSS3DLayer();
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  _debugLog(tag, payload = {}, force = false) {
    if (!this._debugEnabled) return;
    if (!force && payload?.durationMs != null && payload.durationMs < 1) return;
    console.log(`[buildings.${tag}]`, payload);
  }

  _elevationColor(elevation) {
    const min = Number.isFinite(this.tileManager?.GLOBAL_MIN_Y) ? this.tileManager.GLOBAL_MIN_Y : elevation;
    const max = Number.isFinite(this.tileManager?.GLOBAL_MAX_Y) ? this.tileManager.GLOBAL_MAX_Y : elevation + 1;
    const span = Math.max(1e-6, max - min);
    const t = THREE.MathUtils.clamp((elevation - min) / span, 0, 1);
    const low = { r: 0.18, g: 0.2, b: 0.24 };
    const high = { r: 0.82, g: 0.86, b: 0.9 };
    return new THREE.Color(
      low.r + (high.r - low.r) * t,
      low.g + (high.g - low.g) * t,
      low.b + (high.b - low.b) * t,
    );
  }

  /* ---------------- public API ---------------- */

  setPhysicsEngine(physics) {
    this.physics = physics || null;
    if (!this.physics) return;
    for (const state of this._tileStates.values()) {
      if (!state?.buildings) continue;
      for (const building of state.buildings) {
        if (building?.solid) this.physics.registerStaticMesh(building.solid, { forceUpdate: true });
      }
    }
  }

  applyPerfProfile(profile = {}) {
  const nowMs = performance?.now ? performance.now() : Date.now();

  // ── Inputs + clamps ──────────────────────────────────────────────────────────
  const qualityRaw = Number.isFinite(profile?.quality) ? profile.quality : this._currentPerfQuality;
  const qualityClamp = THREE.MathUtils.clamp(qualityRaw ?? 1, 0.3, 1.1);
  this._currentPerfQuality = qualityClamp;

  const fps = Number.isFinite(profile?.smoothedFps) ? profile.smoothedFps : this._smoothedFps;
  if (Number.isFinite(fps)) this._smoothedFps = fps;

  const target = Number.isFinite(profile?.targetFps) && profile.targetFps > 0
    ? profile.targetFps
    : (this._qosTargetFps || TARGET_FPS);
  this._qosTargetFps = target;

  // ── Hysteresis on quality (avoid flapping) ───────────────────────────────────
  // Round quality to 0.05 steps and only "apply" when step changes.
  const QUALITY_STEP = (this._qualityStep ?? 0.05);
  const qMin = 0.3, qMax = 1.05;
  const qNorm = THREE.MathUtils.clamp((qualityClamp - qMin) / (qMax - qMin), 0, 1);
  const qStep = Math.round(THREE.MathUtils.clamp(qualityClamp, qMin, qMax) / QUALITY_STEP) * QUALITY_STEP;

  const lastStep = this._lastAppliedQualityStep;
  const stepChanged = (lastStep == null) || (Math.abs(qStep - lastStep) >= QUALITY_STEP);

  // ── Budgets scale with normalized quality (safe to adjust every call) ───────
  this._frameBudgetMs       = THREE.MathUtils.lerp(0.35, BUILD_FRAME_BUDGET_MS, qNorm);
  this._idleBudgetMs        = THREE.MathUtils.lerp(1.8,  BUILD_IDLE_BUDGET_MS, qNorm);
  this._mergeBudgetMs       = THREE.MathUtils.lerp(1.1,  MERGE_BUDGET_MS, qNorm);
  this._resnapFrameBudgetMs = THREE.MathUtils.lerp(0.25, RESNAP_FRAME_BUDGET_MS, qNorm);
  this._resnapInterval      = THREE.MathUtils.lerp(RESNAP_INTERVAL * 4.5, RESNAP_INTERVAL, qNorm);
  this._resnapHotBudgetMs   = THREE.MathUtils.lerp(0.18, 0.8, qNorm);
  this._resnapDirtyMaxPerFrame = Math.max(1, Math.round(THREE.MathUtils.lerp(1, 5, qNorm)));
  this._tileUpdateInterval  = THREE.MathUtils.lerp(0.65, 0.08, qNorm);
  this._tileUpdateTimer     = Math.min(this._tileUpdateTimer, this._tileUpdateInterval);
  if (this._tileUpdateInterval <= 0) this._tileUpdateTimer = 0;

  // ── QoS level (for UI/telemetry) ────────────────────────────────────────────
  const level = qualityClamp >= 0.82 ? 'high' : (qualityClamp >= 0.6 ? 'medium' : 'low');
  this._qosLevel = level;

  // ── Pressure metrics (fetch cadence) ─────────────────────────────────────────
  const targetFps = Number.isFinite(target) && target > 0 ? target : TARGET_FPS;
  const smoothedFps = Number.isFinite(this._smoothedFps) ? this._smoothedFps : targetFps;
  const fpsRatio = THREE.MathUtils.clamp(smoothedFps / Math.max(1, targetFps), 0, 1.5);
  const pressure = fpsRatio >= 1 ? 0 : (1 - fpsRatio);
  const qualityNorm = THREE.MathUtils.clamp((qualityClamp - 0.3) / 0.8, 0, 1);

  this._fetchBatchSize  = Math.max(2, Math.round(THREE.MathUtils.lerp(18, 6, pressure)));
  this._fetchCooldownMs = Math.round(THREE.MathUtils.lerp(180, 900, pressure));

  // ── Compute desired radius for this quality (but don't thrash) ───────────────
  // We only recompute base radius when no manual override is in place.
  if (this._radiusOverride == null) {
    const baseline = this._computeVisualRingRadius();
    const baseRadius = Number.isFinite(baseline) && baseline > 0 ? baseline : this._defaultRadius;
    const scaledRadius = Math.max(
      200,
      Math.round(THREE.MathUtils.lerp(baseRadius * 0.45, baseRadius * 1.2, qNorm))
    );
    if (Number.isFinite(scaledRadius) && scaledRadius > 0) {
      this._baseRadius = scaledRadius;
    }
  }

  const desiredRadius = this._radiusOverride ?? this._baseRadius;

  // ── Cooldown + hysteresis gate for heavy updates ─────────────────────────────
  // Prevents _refreshRadiusVisibility/_updateTiles(true) stampede.
  const COOLDOWN_MS = Number.isFinite(this._applyCooldownMs) ? this._applyCooldownMs : 800;
  const inCooldown  = (this._applyCooldownUntil && nowMs < this._applyCooldownUntil);

  // Only consider applying heavy changes if:
  //  - quality step changed (avoids tiny oscillations), AND
  //  - we are not in cooldown.
  let appliedHeavy = false;

  // Determine whether radius change is "meaningful" (>= 1 tile or >= 5%).
  // This avoids reflow when change is tiny.
  const prevRadius = Number.isFinite(this.radius) ? this.radius : desiredRadius;
  const radiusDelta = Math.abs(desiredRadius - prevRadius);
  const radiusMeaningful = radiusDelta >= Math.max(1, prevRadius * 0.05);

  if (!inCooldown && (stepChanged || radiusMeaningful)) {
    // Update state that tracks quality hysteresis:
    this._lastAppliedQualityStep = qStep;

    // Apply radius if it meaningfully changed.
    if (radiusMeaningful) {
      this.radius = desiredRadius;

      // Span cap derived from radius & tile size, with minimum safety floor.
      const spanBase = Math.ceil((this.radius + this.tileSize) / Math.max(1, this.tileSize));
      this._tileSpanCap = Math.max(6, spanBase + 2);

      // Visibility recompute is cheap; defer heavy tile graph updates unless radius really changed.
      this._refreshRadiusVisibility?.();

      // If your pipeline expects a tiles rebuild on radius change, call it here,
      // but only when the change was meaningful (we already checked).
      this._updateTiles?.(true);
    }

    // Start cooldown to avoid thrash.
    this._applyCooldownUntil = nowMs + COOLDOWN_MS;
    appliedHeavy = radiusMeaningful || stepChanged;
  }

  // If we were in cooldown or nothing meaningful changed, we still return a summary,
  // but we skip heavy work. This keeps budgets updated while avoiding tile thrash.
  const summary = {
    quality: qualityClamp,
    qualityStep: qStep,
    level,
    frameBudget: this._frameBudgetMs,
    idleBudget: this._idleBudgetMs,
    mergeBudget: this._mergeBudgetMs,
    resnapBudget: this._resnapFrameBudgetMs,
    resnapInterval: this._resnapInterval,
    radius: this.radius,
    desiredRadius,
    tileUpdateInterval: this._tileUpdateInterval,
    throttled: !!inCooldown,
    cooldownMsRemaining: inCooldown ? Math.max(0, Math.round(this._applyCooldownUntil - nowMs)) : 0,
    appliedHeavy,
  };

  return summary;
}

  getBuildingSettings() {
    return {
      radius: this.radius,
      baseRadius: this._baseRadius,
      override: this._radiusOverride,
    };
  }

  updateBuildingSettings({ radius } = {}) {
    if (Number.isFinite(radius) && radius > 0) {
      const r = Math.max(200, Number(radius));
      this._radiusOverride = r;
      this._baseRadius = r;
      this.radius = r;
      this._refreshRadiusVisibility();
      this._updateTiles(true);
    }
  }

  resetBuildingSettings() {
    this._radiusOverride = null;
    this._baseRadius = this._defaultRadius;
    this.radius = this._defaultRadius;
    this._refreshRadiusVisibility();
    this._updateTiles(true);
  }

  updateQoS({ fps, target = TARGET_FPS, quality } = {}) {
    if (Number.isFinite(fps) && fps > 0) {
      const alpha = 0.12;
      this._smoothedFps = this._smoothedFps * (1 - alpha) + fps * alpha;
    }
    if (!Number.isFinite(target) || target <= 0) target = TARGET_FPS;
    this._qosTargetFps = target;

    let resolvedQuality = quality;
    if (!Number.isFinite(resolvedQuality)) {
      const safeTarget = target || TARGET_FPS;
      const ratio = safeTarget > 0 ? this._smoothedFps / safeTarget : 1;
      if (ratio >= 1.0) resolvedQuality = 1;
      else if (ratio >= 0.92) resolvedQuality = 0.85;
      else if (ratio >= 0.75) resolvedQuality = 0.65;
      else resolvedQuality = 0.45;
    }

    return this.applyPerfProfile({
      quality: resolvedQuality,
      smoothedFps: this._smoothedFps,
      targetFps: target,
    });
  }

  setOrigin(lat, lon, { forceRefresh = false } = {}) {
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
    } else if (forceRefresh) {
      this._clearAllTiles();
      this._currentCenter = null;
      this._updateTiles(true);
    }
  }

  update(dt = 0) {
    if (!this._hasOrigin || !this.camera) {
      // still render CSS3D as hidden once to keep layout
      if (this._cssRenderer && this._cssScene && this.camera) {
        this._cssRenderer.render(this._cssScene, this.camera);
      }
      return;
    }

    if (this._tileUpdateInterval <= 0) {
      this._updateTiles();
    } else {
      this._tileUpdateTimer += dt;
      if (this._tileUpdateTimer >= this._tileUpdateInterval) {
        this._tileUpdateTimer = 0;
        this._updateTiles();
      }
    }

    this._drainBuildQueue(this._frameBudgetMs);
    this._processMergeQueue();
    const dirtyBefore = this._resnapDirtyQueue.length;
    this._drainDirtyResnapQueue(this._resnapHotBudgetMs);
    if (dirtyBefore) this._resnapTimer = 0;

    this._resnapTimer += dt;
    if (this._resnapTimer > this._resnapInterval) {
      this._resnapTimer = 0;
      this._queueResnapSweep();
    }
    this._drainResnapQueue(this._resnapFrameBudgetMs);

    const nowMs = this._nowMs();
    if (nowMs >= this._resnapVerifyNextMs) {
      this._verifyFloatingBuildings();
      this._resnapVerifyNextMs = nowMs + this._resnapVerifyIntervalMs;
    }
    this._drainPendingFetchQueue(nowMs);

    // Keep the old label oriented (if you ever turn it back on)
    if (this._hoverGroup.visible) this._orientLabel(this.camera);

// CSS3D panel: render only when visible, and throttle (big perf win)
    if (this._cssEnabled && this._cssRenderer && this._cssScene) {
      const anyVisible = (this._cssPanelVisible === true) || this._hoverGroup?.visible === true;
      const nowMs = this._nowMs();
      if (anyVisible) {
        this._nextCssRenderMs = this._nextCssRenderMs || 0;
        if (nowMs >= this._nextCssRenderMs) {
          this._updateCSS3DPanelFacing?.();
          this._cssRenderer.render(this._cssScene, this.camera);
          this._nextCssRenderMs = nowMs + 90; // ~11 Hz
        }
      }
    }
  }

  dispose() {
    this.scene?.remove(this.group);
    this.clearHover();
    this._hideAddressToast(true);
    if (this._heightListenerDispose) {
      try { this._heightListenerDispose(); } catch { }
      this._heightListenerDispose = null;
    }
    this._clearAllTiles();
    this._edgeMaterial.dispose();
    this._highlightEdgeMaterial.dispose();
    this._stemMaterial.dispose();
    this._pickMaterial.dispose();
    this._buildingMaterial.dispose();

    // CSS3D teardown
    if (this._cssRenderer) {
      try {
        if (this._cssRootEl?.parentNode) this._cssRootEl.parentNode.removeChild(this._cssRootEl);
      } catch { }
      this._cssRenderer = null;
      this._cssScene = null;
      this._cssPanelObj = null;
    }
    if (this._onCssResize) window.removeEventListener('resize', this._onCssResize);
  }

  /* ---------------- hover & CSS3D panel ---------------- */

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

    this._cancelDuckHide?.();
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
      this._hoverStem.visible = false;
    }
    // position and show the canvas label
    if (this._hoverLabel) {
      this._hoverLabel.visible = false;
    }
    if (this._hoverGroup) this._hoverGroup.visible = false;
    this._hoverInfo = null;

    // Hide CSS3D panel
    this._hideDuckDuckGoPanel();
    this._hideAddressToast();
  }

  _showHover(info, point, camera) {
    this._ensureHoverArtifacts();

    // Update highlight edges once per target
    if (this._hoverInfo !== info) {
      const highlightGeom = this._buildHighlightGeometry(info);
      this._hoverEdges.geometry.dispose();
      this._hoverEdges.geometry = highlightGeom;
      this._hoverEdges.position.set(0, this.extraDepth, 0);

      // we keep the text label infra but keep it hidden (replaced by CSS3D)
      const labelText = info.address || 'Unknown';
      this._updateLabelText(labelText);
      this._hoverInfo = info;
      // console.log(`[Buildings] hover ${info.id}: ${labelText}`);
    }
    //this._setDuckQuery(info);

    this._hoverGroup.visible = true;
    this._hoverEdges.visible = true;

    const anchorTop = this._chooseAnchorTop(info, point);
    const camPos = camera.getWorldPosition(this._tmpVec2);

    const dir = camPos.clone().sub(anchorTop);
    dir.y = 0;
    if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0);
    dir.normalize();
    const stemLength = 2;
    const offset = dir.multiplyScalar(stemLength);
    const labelPos = anchorTop.clone().add(offset);
    labelPos.y += stemLength;

    // stem
    const stemGeom = new THREE.BufferGeometry().setFromPoints([anchorTop, labelPos]);
    this._hoverStem.geometry.dispose();
    this._hoverStem.geometry = stemGeom;
    this._hoverStem.visible = true;

    // (hide the old canvas label)
    if (this._hoverLabel) {
      this._hoverLabel.position.copy(labelPos);
      this._hoverLabel.visible = true;
    }

    this._showAddressToast(info);
  }
  _bindPressListeners() {
    if (!this._inputEl || typeof window === 'undefined') return;
    const CLICK_MAX_MS = 350;
    const onDown = (e) => {
      if ((e.button ?? 0) !== 0) return; // left button only
      if (!this._hoverInfo) return;
      this._pressActive = true;
      this._pressInfo = this._hoverInfo;
      this._pressDownPos = { x: e.clientX ?? 0, y: e.clientY ?? 0 };
      this._pressDownTs = performance.now();
    };

    const cancel = () => {
      this._pressActive = false;
      this._pressInfo = null;
    };

    const onUp = (e) => {
      if (!this._pressActive) return cancel();
      if ((e.button ?? 0) !== 0) return cancel();
      const dx = (e.clientX ?? 0) - (this._pressDownPos?.x ?? 0);
      const dy = (e.clientY ?? 0) - (this._pressDownPos?.y ?? 0);
      const moved2 = dx * dx + dy * dy;
      const dt = performance.now() - (this._pressDownTs ?? 0);
      const withinSlop = moved2 <= (this._pressMoveSlop * this._pressMoveSlop);
      const sameTarget = this._hoverInfo && (this._hoverInfo === this._pressInfo);
      if (withinSlop && sameTarget && dt <= CLICK_MAX_MS) {
        this._openInfoLink(this._hoverInfo);
      }
      cancel();
    };
    const onLeave = cancel;
    const onCancel = cancel;

    const onMove = (e) => {
      if (!this._pressActive || !this._pressDownPos) return;
      const dx = (e.clientX ?? 0) - this._pressDownPos.x;
      const dy = (e.clientY ?? 0) - this._pressDownPos.y;
      if ((dx * dx + dy * dy) > (this._pressMoveSlop * this._pressMoveSlop)) cancel();
    };

    this._inputEl.addEventListener('pointerdown', onDown);
    this._inputEl.addEventListener('pointerup', onUp);
    this._inputEl.addEventListener('pointerleave', onLeave);
    this._inputEl.addEventListener('pointercancel', onCancel);
    this._inputEl.addEventListener('pointermove', onMove);

    // Clean up on page hide/blur so timers don't leak
    const onBlur = () => cancel();
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); });
  }

  _openInfoLink(info) {
    try {
      const query = this._buildSearchQuery(info);                // uses your existing builder
      const url = this._duckDuckGoUrlForQuery(query);            // uses your existing URL helper
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      // no-op if popups are blocked; you could log if desired
    }
  }

  _computeVisualRingRadius() {
    const tm = this.tileManager;
    if (!tm) return null;
    const tileRadius = Number.isFinite(tm?.tileRadius) ? tm.tileRadius : null;
    const visualRing = Number.isFinite(tm?.VISUAL_RING) ? tm.VISUAL_RING : null;
    if (!Number.isFinite(tileRadius) || tileRadius <= 0 || !Number.isFinite(visualRing)) return null;
    const padding = 2;
    return tileRadius * Math.max(0, visualRing + padding);
  }

  _ensureAddressToast() {
    if (this._addressToast || typeof document === 'undefined') return this._addressToast;
    const el = document.getElementById('buildingHoverToast');
    if (!el) return null;
    this._addressToast = el;
    this._addressToastNameEl = el.querySelector('[data-role="toast-name"]') || null;
    this._addressToastAddrEl = el.querySelector('[data-role="toast-address"]') || null;
    return this._addressToast;
  }

  _formatBuildingName(info) {
    if (!info?.tags) return '';
    return info.tags.name
      || info.tags['addr:housename']
      || info.tags.amenity
      || info.tags.shop
      || (info.tags.building && info.tags.building !== 'yes' ? info.tags.building : '');
  }

  _showAddressToast(info) {
    const toast = this._ensureAddressToast();
    if (!toast) return;
    if (this._addressToastHideTimer) {
      clearTimeout(this._addressToastHideTimer);
      this._addressToastHideTimer = null;
    }
    const name = this._formatBuildingName(info);
    if (this._addressToastNameEl) {
      if (name) {
        this._addressToastNameEl.textContent = name;
        this._addressToastNameEl.hidden = false;
      } else {
        this._addressToastNameEl.textContent = '';
        this._addressToastNameEl.hidden = true;
      }
    }
    if (this._addressToastAddrEl) {
      this._addressToastAddrEl.textContent = info?.address || 'Unknown address';
    }
    toast.removeAttribute('hidden');
    void toast.offsetWidth;
    toast.classList.add('show');
  }

  _hideAddressToast(immediate = false) {
    const toast = this._ensureAddressToast();
    if (!toast) return;
    if (this._addressToastHideTimer) {
      clearTimeout(this._addressToastHideTimer);
      this._addressToastHideTimer = null;
    }
    const finalize = () => {
      toast.setAttribute('hidden', '');
    };
    toast.classList.remove('show');
    if (immediate) {
      finalize();
      return;
    }
    this._addressToastHideTimer = setTimeout(() => {
      finalize();
      this._addressToastHideTimer = null;
    }, 180);
  }

  /* ---------- CSS3D integration ---------- */

  _ensureCSS3DLayer() {
    if (!this._cssEnabled) return;
    if (typeof document === 'undefined') return;
    if (this._cssRenderer) return;

    this._cssScene = new THREE.Scene();

    const renderer = new CSS3DRenderer();
    renderer.setSize(window.innerWidth, window.innerHeight);

    // Style the overlay: fixed, on top, non-interactive so it doesn't steal clicks/drags
    const el = renderer.domElement;
    el.style.position = 'fixed';
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = '100%';
    el.style.height = '100%';
    el.style.pointerEvents = 'none';     // make entire layer mouse-transparent
    el.style.zIndex = '9999';            // above your WebGL canvas

    // Root container
    const root = document.createElement('div');
    root.id = 'bm-css3d-root';
    root.style.position = 'fixed';
    root.style.left = '0';
    root.style.top = '0';
    root.style.width = '100%';
    root.style.height = '100%';
    root.style.pointerEvents = 'none';
    root.style.zIndex = '9999';
    root.appendChild(el);
    document.body.appendChild(root);

    this._cssRenderer = renderer;
    this._cssRootEl = root;

    // Resize handler
    this._onCssResize = () => {
      if (!this._cssRenderer) return;
      this._cssRenderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', this._onCssResize);
  }

  // call in constructor:
  // this._duckPersistMs = 2000; this._duckHideTimer = null;

  _scheduleDuckHide() {
    if (!this._duckPersistMs) this._duckPersistMs = 2000;
    clearTimeout(this._duckHideTimer);
    this._duckHideTimer = setTimeout(() => {
      this._hideDuckDuckGoPanel?.();
      this.clearHover?.();
      this._duckHideTimer = null;
    }, this._duckPersistMs);
  }

  _cancelDuckHide() {
    if (this._duckHideTimer) {
      clearTimeout(this._duckHideTimer);
      this._duckHideTimer = null;
    }
  }

  _toDuckUrl(q) {
    const encoded = encodeURIComponent(String(q || '').trim()).replace(/%20/g, '+');
    return `https://duckduckgo.com/?q=${encoded}&ia=web`;
  }

  _setDuckQuery(target) {
    // target can be a BuildingInfo object or a raw string
    const query = (typeof target === 'string') ? target : this._buildSearchQuery(target);
    const href = this._toDuckUrl(query);
    const root = this._duck?.el || this._duck?.element || this._duck?.dom; // be flexible with your stored ref
    if (!root) return;
    const link = root.querySelector('a[data-role="ddg-link"]');
    if (link) {
      link.href = href;
      link.title = `Open “${query}” on DuckDuckGo`;
    }
  }


  _makeDuckDuckGoElement(urlOrQuery) {
    const ddgEncode = (s) => encodeURIComponent(String(s || '').trim()).replace(/%20/g, '+');
    const toMainDdgUrl = (q) => `https://duckduckgo.com/?q=${ddgEncode(q)}&ia=web`;

    const query = String(urlOrQuery || '').trim();
    const href = toMainDdgUrl(query);

    const wrap = document.createElement('div');
    wrap.style.display = 'inline-block';
    wrap.style.pointerEvents = 'auto';
    wrap.style.userSelect = 'none';

    const link = document.createElement('a');
    link.setAttribute('data-role', 'ddg-link');            // <— important
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'expand';
    link.title = `Open “${query}” on DuckDuckGo`;
    link.style.cssText = `
    cursor: pointer;
    display: inline-block;
    background: #000;
    color: #fff;
    font: 700 12px/1 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    padding: 4px 8px;
    border-radius: 6px;
    text-decoration: none;
    letter-spacing: .3px;
  `;

    const stop = (e) => { e.stopPropagation(); };
    ['pointerdown', 'click', 'wheel', 'touchstart'].forEach(t =>
      link.addEventListener(t, stop, { capture: true })
    );

    const cancelHide = () => this._cancelDuckHide?.();
    const scheduleHide = () => this._scheduleDuckHide?.();
    link.addEventListener('pointerenter', cancelHide, { capture: true });
    link.addEventListener('pointerleave', scheduleHide, { capture: true });
    wrap.addEventListener('pointerenter', cancelHide, { capture: true });
    wrap.addEventListener('pointerleave', scheduleHide, { capture: true });

    wrap.appendChild(link);
    return wrap;
  }




  _buildSearchQuery(info) {
    const t = info?.tags || {};
    const parts = [];

    // Prefer a proper name first
    if (t.name) parts.push(String(t.name));

    // Construct address
    const streetNum = t['addr:housenumber'];
    const street = t['addr:street'] || t['addr:place'];
    const addrLine = [streetNum, street].filter(Boolean).join(' ');
    if (addrLine) parts.push(addrLine);

    const city = t['addr:city']; const state = t['addr:state']; const pc = t['addr:postcode'];
    const locality = [city, state, pc].filter(Boolean).join(' ');
    if (locality) parts.push(locality);

    // Fallback: our formatted address
    if (!parts.length && info.address) parts.push(info.address);

    // Last resort: coordinates
    if (!parts.length) {
      const { lat, lon } = this._worldToLatLon(info.centroid.x, info.centroid.z);
      parts.push(`${lat.toFixed(6)}, ${lon.toFixed(6)}`);
    }

    // A little hint for intent (optional)
    parts.push('building info');
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  _duckDuckGoUrlForQuery(q) {
    // Use the "html" endpoint which is simple and typically frameable
    return `https://duckduckgo.com/?q=${encodeURIComponent(q)}&ia=web`;
  }

  _showDuckDuckGoPanel(info, worldPos, camera) {
    if (!this._cssRenderer || !this._cssScene || !this._cssEnabled) return;

    const query = this._buildSearchQuery(info);
    const queryKey = query;
    const url = this._duckDuckGoUrlForQuery(query);

    if (!this._cssPanelObj) {
      const el = this._makeDuckDuckGoElement(query);
      const obj = new CSS3DObject(el);
      this._cssScene.add(obj);
      this._cssPanelObj = obj;
      this._cssPanelQueryKey = queryKey;

      // store a direct ref to the anchor for fast updates
      this._cssPanelLink = el.querySelector('a[data-role="ddg-link"]') || null;
    } else if (this._cssPanelQueryKey !== queryKey) {
      // UPDATE THE ANCHOR (not an iframe)
      if (this._cssPanelLink) {
        this._cssPanelLink.href = url;
        this._cssPanelLink.title = `Open “${query}” on DuckDuckGo`;
      } else {
        // fallback: re-query the element in case ref got lost
        const link = this._cssPanelObj.element?.querySelector?.('a[data-role="ddg-link"]');
        if (link) {
          link.href = url;
          link.title = `Open “${query}” on DuckDuckGo`;
          this._cssPanelLink = link;
        }
      }
      this._cssPanelQueryKey = queryKey;
    }

    // position/orient/scale
    this._cssPanelObj.position.copy(worldPos);
    this._faceObjectAtCamera(this._cssPanelObj, camera);
    const camPos = camera.getWorldPosition(this._tmpVec3);
    const d = camPos.distanceTo(worldPos);
    const s = THREE.MathUtils.clamp(d * 0.0022, 0.6, 2.2);
    this._cssPanelObj.scale.set(s, s, s);

    this._cssPanelObj.visible = true;
    this._cssPanelVisible = true;
  }


  _hideDuckDuckGoPanel() {
    if (this._cssPanelObj) {
      this._cssPanelObj.visible = false;
    }
    this._cssPanelVisible = false;
  }

  _faceObjectAtCamera(obj, camera) {
    if (!obj || !camera) return;
    const camPos = camera.getWorldPosition(this._tmpVec3);
    obj.lookAt(camPos);
  }

  _updateCSS3DPanelFacing() {
    if (this._cssPanelObj && this._cssPanelVisible) {
      this._faceObjectAtCamera(this._cssPanelObj, this.camera);
    }
  }

  /* ---------------- radius & visibility ---------------- */

  _refreshRadiusVisibility() {
    for (const state of this._tileStates.values()) {
      if (!state) continue;

      let anyBuildingVisible = false;
      if (state.buildings?.length) {
        for (const building of state.buildings) {
          const info = building?.info;
          if (!info) continue;
          const centre = info.centroid;
          const inside = centre ? this._isInsideRadius(centre) : true;
          info.insideRadius = inside;
          this._refreshBuildingVisibility(building);
          if ((building.solid && building.solid.visible) || (building.render && building.render.visible)) {
            anyBuildingVisible = true;
          }
        }
      }

      if (state.mergedGroup) state.mergedGroup.visible = anyBuildingVisible;

      if (state.extras?.length) {
        for (const extra of state.extras) {
          const centre = extra?.userData?.center;
          const inside = centre ? this._isInsideRadius(centre) : true;
          if (extra?.userData) extra.userData.insideRadius = inside;
          if (extra?.userData?.type === 'road') {
            this._refreshRoadVisibility(extra);
          } else {
            extra.visible = inside;
          }
        }
      }
    }

    if (this._hoverInfo) {
      const centre = this._hoverInfo?.centroid;
      if (centre && !this._isInsideRadius(centre)) this.clearHover();
    }
  }

  /* ---------------- origin, tiles, fetching ---------------- */

  _updateTiles(force = false) {
    const anchor = this._resolveTrackingNode();
    anchor.getWorldPosition(this._tmpVec);
    const key = this._tileKeyForWorld(this._tmpVec.x, this._tmpVec.z);
    const hasPendingWait = (this._pendingTerrainTiles?.size ?? 0) > 0;
    if (!force && key === this._currentCenter && !hasPendingWait) return;
    this._currentCenter = key;

    const [tx, tz] = key.split(',').map(Number);
    const span = this._tileSpanForRadius();
    const tileDiag = this._tileDiagHalf || (this.tileSize * Math.SQRT2 * 0.5);
    const radius = Math.max(this.radius || 0, this.tileSize * 0.5);
    const maxDistSq = (radius + tileDiag) * (radius + tileDiag);

    const tiles = [];
    for (let dx = -span; dx <= span; dx++) {
      for (let dz = -span; dz <= span; dz++) {
        const dxMeters = dx * this.tileSize;
        const dzMeters = dz * this.tileSize;
        const distSq = dxMeters * dxMeters + dzMeters * dzMeters;
        if (distSq > maxDistSq) continue;
        const tileKey = `${tx + dx},${tz + dz}`;
        const state = this._tileStates.get(tileKey);
        if (!state && !this._terrainTileReady(tileKey)) {
          this._pendingTerrainTiles?.add(tileKey);
          continue;
        }
        if (this._pendingTerrainTiles) this._pendingTerrainTiles.delete(tileKey);
        tiles.push({ key: tileKey, distSq });
      }
    }

    if (!tiles.length) {
      const state = this._tileStates.get(key);
      if (state || this._terrainTileReady(key)) tiles.push({ key, distSq: 0 });
    }

    tiles.sort((a, b) => a.distSq - b.distSq);

    const needed = new Set(tiles.map((t) => t.key));
    this._neededTiles = needed;

    const missing = [];
    for (const { key: tileKey } of tiles) {
      let state = this._tileStates.get(tileKey);
      if (!state) {
        state = this._createTileState(tileKey);
        this._tileStates.set(tileKey, state);
      }

      if (state.status !== 'pending' && state.status !== 'error') continue;

      state.status = 'pending';
      missing.push(tileKey);
    }

    for (const tileKey of Array.from(this._tileStates.keys())) {
      if (!needed.has(tileKey)) this._unloadTile(tileKey);
    }

    if (this._pendingTerrainTiles && this._pendingTerrainTiles.size) {
      for (const pendingKey of Array.from(this._pendingTerrainTiles)) {
        if (!needed.has(pendingKey)) {
          this._pendingTerrainTiles.delete(pendingKey);
          continue;
        }
        if (this._terrainTileReady(pendingKey)) {
          this._pendingTerrainTiles.delete(pendingKey);
        }
      }
    }

    const cached = [];
    const uncached = [];
    for (const key of missing) {
      const payload = this._loadTileFromCache(key);
      if (payload) {
        cached.push({ key, data: payload });
      } else {
        uncached.push(key);
      }
    }

    if (cached.length) {
      for (const entry of cached) {
        const state = this._tileStates.get(entry.key) || this._createTileState(entry.key);
        this._tileStates.set(entry.key, state);
        this._applyTileData(entry.key, entry.data, true);
        state.status = 'ready';
        state.pendingSnapshot = entry.data;
      }
    }

    if (uncached.length) {
      const fetchNow = uncached.slice(0, Math.max(1, this._fetchBatchSize | 0));
      const deferred = uncached.slice(fetchNow.length);
      for (const key of deferred) this._pendingFetchTiles.add(key);

      const nowMs = this._nowMs();
      const canFetch = !this._patchInflight && fetchNow.length && (nowMs - this._lastFetchMs) >= this._fetchCooldownMs;
      if (canFetch) {
        const orderedFetch = tiles.map((t) => t.key).filter((key) => fetchNow.includes(key));
        this._fetchPatch(orderedFetch.length ? orderedFetch : fetchNow, fetchNow);
        this._lastFetchMs = nowMs;
      } else {
        for (const key of fetchNow) this._pendingFetchTiles.add(key);
      }
    }
  }

  _resolveTrackingNode() {
    if (this._trackingNode?.isObject3D) return this._trackingNode;
    if (this.camera?.parent?.isObject3D) {
      this._trackingNode = this.camera.parent;
      return this._trackingNode;
    }
    if (this.scene?.getObjectByName) {
      const dolly = this.scene.getObjectByName('player-dolly');
      if (dolly) {
        this._trackingNode = dolly;
        return dolly;
      }
    }
    return this.camera;
  }

  _createTileState(tileKey) {
    return {
      status: 'pending',
      buildings: [],
      extras: [],
      mergedGroup: null,
      raw: null,
      tileKey,
      resnapFrozen: false,
    };
  }

  _terrainTileReady(tileKey) {
    const tm = this.tileManager;
    if (!tm || !tm.tiles || typeof tm._worldToAxialFloat !== 'function' || typeof tm._axialRound !== 'function') {
      return false;
    }

    const parts = tileKey.split(',');
    if (parts.length !== 2) return false;
    const tx = Number(parts[0]);
    const tz = Number(parts[1]);
    if (!Number.isFinite(tx) || !Number.isFinite(tz)) return false;

    const size = this.tileSize;
    const centerX = (tx + 0.5) * size;
    const centerZ = (tz + 0.5) * size;

    const axialFloat = tm._worldToAxialFloat.call(tm, centerX, centerZ);
    const axial = axialFloat ? tm._axialRound.call(tm, axialFloat.q, axialFloat.r) : null;
    if (!axial || !Number.isFinite(axial.q) || !Number.isFinite(axial.r)) return false;

    if (typeof tm.hasInteractiveTerrainAt === 'function') {
      if (tm.hasInteractiveTerrainAt(centerX, centerZ)) return true;
    }

    const centerKey = `${axial.q},${axial.r}`;
    const centerTile = tm.tiles.get(centerKey);
    if (this._isTerrainTileReady(centerTile, true)) return true;
    if (this._isTerrainTileReady(centerTile, false)) return true;

    // Fallback: check immediate neighbors for a ready interactive/visual tile
    const offsets = [
      [1, 0], [1, -1], [0, -1],
      [-1, 0], [-1, 1], [0, 1]
    ];
    for (const [dq, dr] of offsets) {
      const neighbor = tm.tiles.get(`${axial.q + dq},${axial.r + dr}`);
      if (this._isTerrainTileReady(neighbor, true)) return true;
      if (this._isTerrainTileReady(neighbor, false)) return true;
    }
    return false;
  }

  _isTerrainTileReady(tile, requireInteractive) {
    if (!tile) return false;
    if (requireInteractive && tile.type !== 'interactive') return false;
    if (tile.type === 'interactive') {
      if (!tile._phase?.seedDone) return false;
      if (Number.isFinite(tile.unreadyCount)) {
        const total = Number.isFinite(tile.pos?.count) ? tile.pos.count : Infinity;
        if (tile.unreadyCount >= total) return false;
      }
    } else if (!tile._phase?.fullDone) {
      return false;
    }
    return true;
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
    this._pendingFetchTiles?.delete(tileKey);

    this._cancelMerge(tileKey);
    this._cancelBuildJob(tileKey);
    this._removeTileObjects(tileKey);
    state.resnapFrozen = false;

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

  /* ---------------- build & merge ---------------- */

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
      this._drainBuildQueue(this._idleBudgetMs, deadline);
      if (this._activeBuildJob || this._buildQueue.length) this._scheduleBuildTick();
    };
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 32 });
    } else {
      setTimeout(() => run(), 0);
    }
  }

  _drainBuildQueue(budgetMs, deadline) {
    if (!this._activeBuildJob && !this._buildQueue.length) return;

    const frameBudget = Number.isFinite(budgetMs) && budgetMs > 0 ? budgetMs : this._frameBudgetMs;
    if (frameBudget <= 0) return;

    const now = () => this._nowMs();
    const start = now();
    const hasDeadline = deadline && typeof deadline.timeRemaining === 'function';
    const timeRemaining = () => {
      const budgetLeft = frameBudget - (now() - start);
      const idleLeft = hasDeadline ? deadline.timeRemaining() : Infinity;
      return Math.min(budgetLeft, idleLeft);
    };

    let iterations = 0;
    let featuresProcessed = 0;

    while (timeRemaining() > 0) {
      if (!this._activeBuildJob) this._activeBuildJob = this._nextBuildJob();
      const job = this._activeBuildJob;
      if (!job) break;

      if (job.cancelled || !this._tileStates.has(job.tileKey)) {
        this._finishBuildJob(job, true);
        this._activeBuildJob = null;
        continue;
      }

      const before = job.featureIndex;
      const progressed = this._advanceBuildJob(job, timeRemaining);
      const after = job.featureIndex;
      if (after > before) featuresProcessed += (after - before);
      iterations++;
      if (!progressed) break;

      if (job.done || job.featureIndex >= job.features.length) {
        job.done = true;
        this._finishBuildJob(job, false);
        this._activeBuildJob = null;
      }

      if (timeRemaining() <= 0) break;
    }

    if (this._debugEnabled) {
      const duration = now() - start;
      const nowMs = now();
      const shouldLog = duration > frameBudget * 0.6 || nowMs >= this._nextBuildLogMs;
      if (shouldLog) {
        const active = this._activeBuildJob;
        this._debugLog('drainBuildQueue', {
          durationMs: duration,
          frameBudgetMs: frameBudget,
          queueLength: this._buildQueue.length,
          activeTile: active?.tileKey || null,
          remainingFeatures: active ? (active.features.length - active.featureIndex) : 0,
          iterations,
          featuresProcessed,
        });
        this._nextBuildLogMs = nowMs + this._debugLogIntervalMs;
      }
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
        const { render, solid, pick, info } = building;
        info.tile = tileKey;
        info.insideRadius = this._isInsideRadius(info.centroid);
        this.group.add(render);
        if (solid) this.group.add(solid);
        this._pickerRoot.add(pick);
        render.updateMatrixWorld(true);
        pick.updateMatrixWorld(true);
        if (solid) solid.updateMatrixWorld(true);
        this._resnapBuilding(building);
        this._refreshBuildingVisibility(building);
        if (solid && this.physics) this.physics.registerStaticMesh(solid, { forceUpdate: true });
        state.buildings.push(building);
        this._enqueueDirtyResnap(tileKey);
        break;
      }
      case 'road': {
        const road = this._buildRoad(feature.flat, feature.tags, feature.id);
        if (!road) return;
        road.userData.tile = tileKey;
        this.group.add(road);
        state.extras.push(road);
        this._refreshRoadVisibility(road);
        this._enqueueDirtyResnap(tileKey);
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

    const start = this._nowMs();
    let updated = 0;
    while (job.index < job.sources.length) {
      const b = job.sources[job.index++];
      if (!b.render) continue;
      b.render.updateMatrixWorld(true);
      updated++;
      const elapsed = this._nowMs() - start;
      if (elapsed > this._mergeBudgetMs) break;
      if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() < 1) break;
    }

    const duration = this._nowMs() - start;
    if (this._debugEnabled && (duration > this._mergeBudgetMs * 0.8 || this._nowMs() >= this._nextMergeLogMs)) {
      this._debugLog('merge.tick', {
        durationMs: duration,
        updated,
        remaining: job.sources.length - job.index,
        tileKey: job.tileKey,
      });
      this._nextMergeLogMs = this._nowMs() + this._debugLogIntervalMs;
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
    const start = this._nowMs();

    for (const building of sources) {
      if (!building.render) continue;
      this.group.remove(building.render);
      building.render.geometry.dispose();
      building.render = null;
    }

    const segCount = this._rebuildMergedTile(tileKey, state);
    const duration = this._nowMs() - start;
    if (this._debugEnabled) {
      this._debugLog('merge.finalize', {
        durationMs: duration,
        tileKey,
        buildings: state.buildings.length,
        segments: segCount,
      });
    }
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
      state.mergedGroup.position.y = this.extraDepth;
    } else {
      const merged = new THREE.LineSegments(mergedGeom, this._edgeMaterial);
      merged.position.y = this.extraDepth;
      merged.name = `merged-${tileKey}`;
      merged.userData = { type: 'buildingMerged', tile: tileKey };
      this.group.add(merged);
      state.mergedGroup = merged;
    }

    return mergedGeom.getAttribute('position').count / 2;
  }

  /* ---------------- building/road/water creation ---------------- */

  _buildBuilding(flat, tags, id) {
    const rawFootprint = flat.slice();
    if (rawFootprint.length < 6) return null;

    const h = this._chooseBuildingHeight(tags);
    const buryBoost = Math.max(0, -this.extraDepth);          // compensate bury
    const extrusion = h + this.extensionHeight + buryBoost;    // canonical top

    const groundBase = this._lowestGround(rawFootprint);       // no offset
    const baseline = groundBase + this.extraDepth;             // where solids live


    // Wireframe (canonical reference)
    const wireGeom = this._makeWireGeometry(rawFootprint, groundBase, extrusion);
    const edges = new THREE.LineSegments(wireGeom, this._edgeMaterial);
    edges.position.y = this.extraDepth;
    edges.castShadow = false;
    edges.receiveShadow = false;
    edges.visible = false;

    // Solid + picker: generated directly from same footprint
    const solidGeo = this._makeSolidGeometry(rawFootprint, extrusion);

    const pickMesh = new THREE.Mesh(solidGeo.clone(), this._pickMaterial);
    pickMesh.position.set(0, baseline, 0);
    pickMesh.visible = false;

    const solidMesh = new THREE.Mesh(solidGeo.clone(), this._buildingMaterial);
    solidMesh.position.set(0, baseline, 0);
    solidMesh.renderOrder = 1;
    solidMesh.castShadow = true;
    solidMesh.receiveShadow = true;
    solidMesh.visible = false;

    const centroid = averagePoint(rawFootprint);
    const address = formatAddress(tags);
    const info = {
      id,
      address,
      rawFootprint,
      height: extrusion,
      baseHeight: groundBase,
      centroid,
      tags: { ...tags },
      tile: null,
      resnapStableFrames: 0,
      resnapFrozen: false,
      insideRadius: true,
      isVisualEdge: this._isNearVisualEdge(centroid.x, centroid.z)
    };

    edges.userData.buildingInfo = info;
    pickMesh.userData.buildingInfo = info;
    solidMesh.userData.buildingInfo = info;

    const building = { render: edges, solid: solidMesh, pick: pickMesh, info };
    const fillColor = this._elevationColor(groundBase + extrusion * 0.5);
    this._applyGeometryColor(building.solid.geometry, fillColor);
    return building;
  }

  _makeSolidGeometry(footprint, height) {
    const shape = new THREE.Shape();
    for (let i = 0; i < footprint.length; i += 2) {
      const x = footprint[i];
      const z = footprint[i + 1];
      if (i === 0) shape.moveTo(x, z); else shape.lineTo(x, z);
    }
    shape.autoClose = true;

    const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2).scale(1, 1, -1);
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }

  /* ---------------- resnap & hover visuals ---------------- */

  _ensureHoverArtifacts() {
    if (this._hoverEdges) return;

    this._hoverEdges = new THREE.LineSegments(new THREE.BufferGeometry(), this._highlightEdgeMaterial);
    this._hoverStem = new THREE.Line(new THREE.BufferGeometry(), this._stemMaterial);
    this._hoverEdges.visible = false;
    this._hoverStem.visible = false;

    // Canvas label infra remains (kept hidden when CSS3D panel is used)
    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 400;
    const ctx = canvas.getContext('2d');
    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;

    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, depthTest: false });
    const geometry = new THREE.PlaneGeometry(2.7, 1);
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

  _roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w * 0.5, h * 0.5);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  _wrapText(ctx, text, maxWidth) {
    const words = String(text || '').split(/\s+/);
    const lines = [];
    let cur = '';

    for (let i = 0; i < words.length; i++) {
      const test = cur ? cur + ' ' + words[i] : words[i];
      if (ctx.measureText(test).width <= maxWidth) {
        cur = test;
      } else {
        if (cur) lines.push(cur);
        // If single word is too long, hard-break it
        let w = words[i];
        if (ctx.measureText(w).width > maxWidth) {
          let piece = '';
          for (let j = 0; j < w.length; j++) {
            const test2 = piece + w[j];
            if (ctx.measureText(test2).width <= maxWidth) piece = test2;
            else { lines.push(piece); piece = w[j]; }
          }
          cur = piece;
        } else {
          cur = w;
        }
      }
    }
    if (cur) lines.push(cur);
    return lines;
  }

  _ellipsize(ctx, text, maxWidth) {
    const E = '…';
    if (ctx.measureText(text).width <= maxWidth) return text;
    while (text.length > 0 && ctx.measureText(text + E).width > maxWidth) {
      text = text.slice(0, -1);
    }
    return text ? text + E : E;
  }

  _updateLabelText(text) {
    if (!this._hoverLabelCtx || !this._hoverLabelTexture) return;

    const ctx = this._hoverLabelCtx;
    const canvas = this._hoverLabelCanvas;

    const DPR = (typeof window !== 'undefined') ? Math.min(window.devicePixelRatio || 1, 2) : 1;

    const PAD = 28 * DPR;
    const MAX_LINES = 3;
    const BASE_FONT = 64 * DPR;
    const MIN_FONT = 32 * DPR;
    const LINE_GAP = 1.15;
    const RADIUS = 18 * DPR;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(18,18,18,0.82)';
    this._roundRect(ctx, PAD * 0.5, PAD * 0.5, canvas.width - PAD, canvas.height - PAD, RADIUS);
    ctx.fill();

    const maxTextWidth = canvas.width - PAD * 2;
    let fontSize = BASE_FONT;
    let lines = [];

    while (fontSize >= MIN_FONT) {
      ctx.font = `700 ${fontSize}px "Inter", system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      lines = this._wrapText(ctx, String(text || ''), maxTextWidth);
      if (lines.length <= MAX_LINES) break;
      fontSize -= 2 * DPR;
    }

    if (lines.length > MAX_LINES) {
      lines = lines.slice(0, MAX_LINES);
      lines[MAX_LINES - 1] = this._ellipsize(ctx, lines[MAX_LINES - 1], maxTextWidth);
    }

    const lineHeight = fontSize * LINE_GAP;
    const totalHeight = lines.length * lineHeight;
    let y = (canvas.height - totalHeight) * 0.5 + lineHeight * 0.5;

    ctx.fillStyle = '#ffffff';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], canvas.width * 0.5, y);
      y += lineHeight;
    }

    this._hoverLabelTexture.needsUpdate = true;

    const aspect = canvas.width / canvas.height;

    const baseW = 1.6, baseH = 0.6;
    const worldH = 0.55 + 0.12 * (lines.length - 1);
    const worldW = worldH * aspect;

    this._hoverLabel.scale.set(worldW / baseW, worldH / baseH, 1);
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
      const world = this._tmpVec.set(vx, info.baseHeight + this.extraDepth, vz);
      const dist = point ? point.distanceToSquared(world) : world.distanceToSquared(this.camera.position);
      if (dist < bestDist) {
        bestDist = dist;
        best = world.clone();
      }
    }
    if (!best) best = new THREE.Vector3(info.centroid.x, info.baseHeight + this.extraDepth, info.centroid.z);
    best.y += info.height;
    return best;
  }

  _orientLabel(camera) {
    if (!this._hoverLabel || !this._hoverLabel.visible) return;
    this._hoverLabel.lookAt(camera.getWorldPosition(this._tmpVec3));
  }

  _handleTerrainHeightChange(evt) {
    if (!evt || !this._hasOrigin) return;
    const world = evt.world;
    if (!world) return;
    const enqueue = (x, z) => {
      const key = this._tileKeyForWorld(x, z);
      this._enqueueDirtyResnap(key);
    };
    enqueue(world.x, world.z);
    if (Array.isArray(this._resnapOffsets)) {
      for (let i = 1; i < this._resnapOffsets.length; i++) {
        const [dx, dz] = this._resnapOffsets[i];
        enqueue(world.x + dx, world.z + dz);
      }
    }
  }

  _enqueueDirtyResnap(tileKey) {
    if (!tileKey) return;
    if (this._resnapDirtyTiles.has(tileKey)) return;
    this._resnapDirtyTiles.add(tileKey);
    this._resnapDirtyQueue.push(tileKey);
    const state = this._tileStates.get(tileKey);
    if (state && Array.isArray(state.buildings)) {
      for (const building of state.buildings) {
        if (!building?.info) continue;
        building.info.resnapFrozen = false;
        building.info.resnapStableFrames = 0;
      }
    }
  }

  _drainDirtyResnapQueue(budgetMs = this._resnapHotBudgetMs) {
    if (!this._resnapDirtyQueue.length) return;
    const budget = Number.isFinite(budgetMs) ? Math.max(0, budgetMs) : 0;
    const start = this._nowMs();
    let processed = 0;
    while (this._resnapDirtyIndex < this._resnapDirtyQueue.length) {
      if (this._resnapDirtyMaxPerFrame > 0 && processed >= this._resnapDirtyMaxPerFrame) break;
      if (budget > 0 && (this._nowMs() - start) > budget) break;
      const tileKey = this._resnapDirtyQueue[this._resnapDirtyIndex++];
      this._resnapDirtyTiles.delete(tileKey);
      const state = this._tileStates.get(tileKey);
      if (!state) continue;
      this._resnapTile(tileKey, state);
      processed++;
    }
    if (this._resnapDirtyIndex >= this._resnapDirtyQueue.length) {
      this._resnapDirtyQueue.length = 0;
      this._resnapDirtyIndex = 0;
    }
  }

  /* ---------------- resnap sweep ---------------- */

  _queueResnapSweep() {
    if (!this._tileStates.size) return;
    if (this._resnapQueue && this._resnapIndex < this._resnapQueue.length) return;
    this._resnapQueue = Array.from(this._tileStates.values())
      .filter((state) => state && (!state.resnapFrozen || (state.extras && state.extras.length)))
      .map((state) => state.tileKey);
    this._resnapIndex = 0;
  }

  _drainResnapQueue(budgetMs) {
    if (!this._resnapQueue || this._resnapIndex >= this._resnapQueue.length) return;

    const effectiveBudget = Number.isFinite(budgetMs) && budgetMs > 0
      ? budgetMs
      : this._resnapFrameBudgetMs;
    if (effectiveBudget <= 0) return;

    const now = () => this._nowMs();
    const start = now();
    let processed = 0;

    while (this._resnapIndex < this._resnapQueue.length) {
      const elapsed = now() - start;
      if (elapsed > effectiveBudget) break;

      const tileKey = this._resnapQueue[this._resnapIndex++];
      const state = this._tileStates.get(tileKey);
      if (!state || (state.resnapFrozen && (!state.extras || !state.extras.length))) continue;
      this._resnapTile(tileKey, state);
      processed++;
    }

    if (this._resnapIndex >= this._resnapQueue.length) {
      this._resnapQueue = [];
      this._resnapIndex = 0;
    }

    if (this._debugEnabled) {
      const duration = now() - start;
      const nowMs = now();
      if (duration > effectiveBudget * 0.8 || nowMs >= this._nextResnapLogMs) {
        this._debugLog('resnap', {
          durationMs: duration,
          processed,
          remaining: this._resnapQueue.length - this._resnapIndex,
        });
        this._nextResnapLogMs = nowMs + this._debugLogIntervalMs;
      }
    }
  }

  _resnapTile(tileKey, state) {
    const buildings = state.buildings || [];
    const extras = state.extras || [];

    if (buildings.length && buildings.every((b) => b?.info?.resnapFrozen)) {
      if (!extras.length) {
        state.resnapFrozen = true;
        return;
      }
    } else {
      state.resnapFrozen = false;
    }

    let dirty = false;
    for (const building of buildings) {
      if (this._resnapBuilding(building)) dirty = true;
    }
    if (dirty) {
      state.resnapFrozen = false;
      this._rebuildMergedTile(tileKey, state);
    } else if (buildings.length && buildings.every((b) => b?.info?.resnapFrozen) && !extras.length) {
      state.resnapFrozen = true;
    }

    for (const extra of extras) {
      const type = extra.userData?.type;
      if (type === 'road') this._resnapRoad(extra);
      else if (type === 'water') this._resnapWater(extra);
      else if (type === 'area') this._resnapArea(extra);
    }
  }

  _resnapBuilding(building) {
    if (!building || !building.info) return false;
    const info = building.info;
    info.isVisualEdge = this._isNearVisualEdge(info.centroid.x, info.centroid.z);
    if (info.resnapFrozen) return false;
    let baseline = this._lowestGround(info.rawFootprint);
    let groundBase = baseline;
    if (info.isVisualEdge && this.tileManager?.getHeightAt) {
      const sample = this.tileManager.getHeightAt(info.centroid.x, info.centroid.z);
      if (Number.isFinite(sample)) {
        baseline = sample + this.extraDepth;
        groundBase = baseline - this.extraDepth;
      }
    } else {
      baseline += this.extraDepth;
      groundBase = baseline - this.extraDepth;
    }
    const prev = info.baseHeight;
    const changed = !Number.isFinite(prev) || Math.abs(prev - groundBase) > 0.02;
    info.baseHeight = groundBase;

    if (!changed) {
      info.resnapStableFrames = (info.resnapStableFrames || 0) + 1;
      if (info.resnapStableFrames >= 2) info.resnapFrozen = true;
      this._refreshBuildingVisibility(building);
      return false;
    }

    info.resnapStableFrames = 0;

    if (building.render) {
      const newGeom = this._makeWireGeometry(info.rawFootprint, info.baseHeight, info.height);
      building.render.geometry.dispose();
      building.render.geometry = newGeom;
      building.render.position.set(0, this.extraDepth, 0);
      building.render.updateMatrixWorld(true);
    }
    if (building.solid) {
      building.solid.position.y = baseline;
      building.solid.updateMatrixWorld(true);
      const color = this._elevationColor(groundBase + info.height * 0.5);
      this._applyGeometryColor(building.solid.geometry, color);
      this.physics?.registerStaticMesh(building.solid, { forceUpdate: true });
    }
    if (building.pick) {
      building.pick.position.y = baseline;
      building.pick.updateMatrixWorld(true);
    }
    if (this._hoverInfo === info) {
      if (this._hoverEdges) {
        const g = this._buildHighlightGeometry(info);
        this._hoverEdges.geometry.dispose();
        this._hoverEdges.geometry = g;
        this._hoverEdges.position.y = this.extraDepth;
      }
      const anchorTop = this._chooseAnchorTop(info);
      const camPos = this.camera.getWorldPosition(this._tmpVec2);
      const dir = camPos.clone().sub(anchorTop); dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(1, 0, 0); dir.normalize();
      const stemLength = 2;
      const labelPos = anchorTop.clone().addScaledVector(dir, stemLength); labelPos.y += stemLength;
      const stemGeom = new THREE.BufferGeometry().setFromPoints([anchorTop, labelPos]);
      if (this._hoverStem) {
        this._hoverStem.geometry.dispose();
        this._hoverStem.geometry = stemGeom;
        this._hoverStem.visible = true;
      }
      if (this._hoverLabel) {
        this._hoverLabel.position.copy(labelPos);
        this._hoverLabel.visible = true;
      }
      this._hoverGroup.visible = true;
    }
    this._refreshBuildingVisibility(building);
    return changed;
  }

  _refreshBuildingVisibility(building) {
    if (!building || !building.info) return;
    const info = building.info;
    const inside = info.insideRadius !== false;
    const snapped = !!info.resnapFrozen;
    const shouldShow = inside && snapped;
    const wireMode = !!this._wireframeMode;

    if (building.render) building.render.visible = shouldShow && wireMode;
    if (building.solid) building.solid.visible = shouldShow && !wireMode;
    if (building.pick) building.pick.visible = shouldShow;
    this._updateMergedGroupVisibility(info.tile);
  }

  _refreshRoadVisibility(road) {
    if (!road) return;
    const data = road.userData || {};
    const inside = data.insideRadius !== false;
    const snapped = !!data.resnapFrozen;
    const shouldShow = inside && snapped;
    const wireMode = !!this._wireframeMode;

    road.visible = shouldShow && !wireMode;
    if (data.wireframeLines) data.wireframeLines.visible = shouldShow && wireMode;
  }

  _updateMergedGroupVisibility(tileKey) {
    if (!tileKey) return;
    const state = this._tileStates.get(tileKey);
    if (!state?.mergedGroup) return;
    let visible = false;
    if (state.buildings?.length) {
      for (const building of state.buildings) {
        if ((building?.solid && building.solid.visible) || (building?.render && building.render.visible)) {
          visible = true;
          break;
        }
      }
    }
    state.mergedGroup.visible = visible;
  }

  _applyGeometryColor(geometry, color) {
    if (!geometry?.getAttribute) return;
    const pos = geometry.getAttribute('position');
    const count = pos?.count;
    if (!Number.isFinite(count) || count <= 0) return;
    let attr = geometry.getAttribute('color');
    if (!attr || attr.count !== count) {
      const array = new Float32Array(count * 3);
      attr = new THREE.BufferAttribute(array, 3);
      geometry.setAttribute('color', attr);
    }
    const r = color.r, g = color.g, b = color.b;
    for (let i = 0; i < attr.count; i++) attr.setXYZ(i, r, g, b);
    attr.needsUpdate = true;
  }

  _drainPendingFetchQueue(nowMs = this._nowMs()) {
    if (!this._pendingFetchTiles || !this._pendingFetchTiles.size) return;
    if (this._patchInflight) return;
    if ((nowMs - this._lastFetchMs) < this._fetchCooldownMs) return;

    const batch = [];
    for (const key of this._pendingFetchTiles) {
      batch.push(key);
      this._pendingFetchTiles.delete(key);
      if (batch.length >= this._fetchBatchSize) break;
    }
    if (!batch.length) return;

    this._fetchPatch(batch, batch);
    this._lastFetchMs = nowMs;
  }

  _isNearVisualEdge(x, z) {
    const mgr = this.tileManager;
    if (!mgr?.spacing) return false;
    const dist = Math.hypot(x, z);
    const visualRadius = Number.isFinite(mgr?.VISUAL_RING) ? mgr.VISUAL_RING * mgr.spacing : null;
    if (!Number.isFinite(visualRadius)) return false;
    return dist >= visualRadius - mgr.spacing * 0.5;
  }

  setEnvironment(envTexture) {
    const texture = envTexture || null;
    if (this._buildingMaterial && this._buildingMaterial.envMap !== texture) {
      this._buildingMaterial.envMap = texture;
      this._buildingMaterial.needsUpdate = true;
    }
    if (this._roadMaterial && this._roadMaterial.envMap !== texture) {
      this._roadMaterial.envMap = texture;
      this._roadMaterial.needsUpdate = true;
    }
    if (this._waterMaterialShared && this._waterMaterialShared.envMap !== texture) {
      this._waterMaterialShared.envMap = texture;
      this._waterMaterialShared.needsUpdate = true;
    }
    if (this._areaMaterial && this._areaMaterial.envMap !== texture) {
      this._areaMaterial.envMap = texture;
      this._areaMaterial.needsUpdate = true;
    }
  }

  setWireframe(enabled) {
    const next = !!enabled;
    if (this._wireframeMode === next) return;
    this._wireframeMode = next;
    if (this._roadMaterial) { this._roadMaterial.wireframe = next; this._roadMaterial.needsUpdate = true; }
    if (this._waterMaterialShared) { this._waterMaterialShared.wireframe = next; this._waterMaterialShared.needsUpdate = true; }
    if (this._areaMaterial) { this._areaMaterial.wireframe = next; this._areaMaterial.needsUpdate = true; }
    if (this._buildingMaterial) this._buildingMaterial.wireframe = false;

    for (const state of this._tileStates.values()) {
      if (!state) continue;
      for (const building of state.buildings) this._refreshBuildingVisibility(building);
      for (const extra of state.extras) {
        if (extra?.userData?.type === 'road') {
          this._refreshRoadVisibility(extra);
        }
        if (extra?.material) {
          extra.material.wireframe = next;
          extra.material.needsUpdate = true;
        }
      }
    }
  }

  _verifyFloatingBuildings() {
    if (!this._tileStates || !this._tileStates.size) return;
    const tiles = Array.from(this._tileStates.values());
    if (!tiles.length) return;

    let cursor = this._resnapVerifyCursor % tiles.length;
    let processed = 0;

    while (processed < this._resnapVerifyBatch && processed < tiles.length) {
      const state = tiles[cursor];
      cursor = (cursor + 1) % tiles.length;
      if (!state || !Array.isArray(state.buildings) || !state.buildings.length) {
        processed++;
        continue;
      }

      let needsResnap = false;
      for (const building of state.buildings) {
        if (!building?.info) continue;
        const info = building.info;
        if (!info.resnapFrozen) continue;
        let baseSample = this._lowestGround(info.rawFootprint);
        if (info.isVisualEdge && this.tileManager?.getHeightAt) {
          const sample = this.tileManager.getHeightAt(info.centroid.x, info.centroid.z);
          if (Number.isFinite(sample)) baseSample = sample;
        }
        const baseline = baseSample + this.extraDepth;
        const current = info.baseHeight + this.extraDepth;
        const diff = Math.abs(baseline - current);
        if (diff > this._resnapVerifyTolerance) {
          info.resnapFrozen = false;
          info.resnapStableFrames = 0;
          this._refreshBuildingVisibility(building);
          needsResnap = true;
        }
      }

      if (needsResnap && state.buildings.length) {
        const tileKey = state.buildings[0]?.info?.tile || state.tileKey;
        if (tileKey) this._enqueueDirtyResnap(tileKey);
      }

      processed++;
    }

    this._resnapVerifyCursor = cursor;
  }

  _resnapRoad(mesh) {
    const attr = mesh.geometry.getAttribute('position');
    const base = mesh.userData.basePos;
    if (!attr || !base) return;
    const arr = attr.array;
    const data = mesh.userData || (mesh.userData = {});
    let sumY = 0;
    let count = 0;
    let changed = false;
    const tolerance = 0.03;
    for (let i = 0; i < arr.length; i += 3) {
      const x = base[i];
      const z = base[i + 2];
      const h = this._groundHeight(x, z);
      const newY = h + this.roadOffset + this.roadHeightOffset;
      const prevY = arr[i + 1];
      if (!Number.isFinite(prevY) || Math.abs(prevY - newY) > tolerance) changed = true;
      arr[i] = x;
      arr[i + 1] = newY;
      arr[i + 2] = z;
      sumY += newY;
      count++;
    }
    attr.needsUpdate = true;
    if (this.roadLit) mesh.geometry.computeVertexNormals();

    if (count > 0) {
      const avg = sumY / count;
      mesh.material?.color?.copy?.(this._elevationColor(avg));
    }

    if (changed) {
      data.resnapStableFrames = 0;
      data.resnapFrozen = false;
    } else {
      data.resnapStableFrames = (data.resnapStableFrames || 0) + 1;
      if (data.resnapStableFrames >= 2) data.resnapFrozen = true;
    }

    this._refreshRoadVisibility(mesh);
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

  /* ---------------- roads/water/areas ---------------- */

  _buildRoad(flat, tags, id) {
    const geomData = this._makeRoadGeometry(flat);
    if (!geomData) return null;
    const { geo, basePos, center, avgHeight } = geomData;

    const color = Number.isFinite(avgHeight)
      ? this._elevationColor(avgHeight)
      : new THREE.Color(this.roadColor || 0x424a57);

    const mesh = new THREE.Mesh(geo, this._roadMaterial);
    this._applyGeometryColor(mesh.geometry, color);
    mesh.castShadow = !!this.roadShadows;
    mesh.receiveShadow = true;

    mesh.userData.type = 'road';
    mesh.userData.osmId = id;
    mesh.userData.basePos = basePos;
    mesh.userData.center = center;
    mesh.userData.resnapStableFrames = 0;
    mesh.userData.resnapFrozen = false;
    mesh.userData.insideRadius = this._isInsideRadius(center);
    mesh.visible = false;

    if (this._debugEnabled && this._nowMs() >= this._nextRoadLogMs) {
      this._debugLog('road.mesh', {
        osmId: id,
        vertices: geo.attributes.position?.count || 0,
        material: this.roadLit ? 'standard' : 'basic',
      }, true);
      this._nextRoadLogMs = this._nowMs() + this._debugLogIntervalMs;
    }
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
    const mesh = new THREE.Mesh(geo, this._waterMaterialShared);
    mesh.userData.type = 'water';
    mesh.userData.osmId = id;
    mesh.userData.basePts = flat.slice();

    const base = this._lowestGround(flat) - 0.2;
    mesh.position.set(0, base, 0);

    const centre = averagePoint(flat);
    mesh.userData.center = centre;
    mesh.visible = this._isInsideRadius(centre);
    const color = this._elevationColor(base + 0.5);
    this._applyGeometryColor(mesh.geometry, color);
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
    const mesh = new THREE.Mesh(geo, this._areaMaterial);
    mesh.userData.type = 'area';
    mesh.userData.osmId = id;
    mesh.userData.basePts = flat.slice();

    const base = this._lowestGround(flat) + 0.02;
    mesh.position.set(0, base, 0);

    const centre = averagePoint(flat);
    mesh.userData.center = centre;
    mesh.visible = this._isInsideRadius(centre);
    const color = this._elevationColor(base + 0.2);
    this._applyGeometryColor(mesh.geometry, color);
    mesh.material.wireframe = this._wireframeMode;
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

    const start = this._nowMs();

    // 1) Adaptive / fixed resampling
    let line = this.roadAdaptive
      ? this._densifyLineAdaptive(flat, this.roadMinStep, this.roadMaxStep, this.roadAngleThresh)
      : this._densifyLine(flat, this.roadStep);

    // 2) Hard cap on segments
    if ((line.length / 2) > this.roadMaxSegments) {
      const stride = Math.ceil((line.length / 2) / this.roadMaxSegments);
      const filtered = [];
      for (let i = 0; i < line.length; i += 2 * stride) {
        filtered.push(line[i], line[i + 1]);
      }
      const L = line.length;
      if (filtered[filtered.length - 2] !== line[L - 2] || filtered[filtered.length - 1] !== line[L - 1]) {
        filtered.push(line[L - 2], line[L - 1]);
      }
      line = filtered;
    }

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
      const cx = line[j], cz = line[j + 1], cy = smH[i];
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
    if (this.roadLit) geo.computeVertexNormals();
    geo.getAttribute('position').setUsage(THREE.DynamicDrawUsage);

    const basePos = new Float32Array(pos);
    const centre = centres[Math.floor(centres.length / 2)] ?? { x: 0, z: 0 };
    const avgY = centres.reduce((acc, v) => acc + v.y, 0) / Math.max(1, centres.length);

    if (this._debugEnabled) {
      const duration = this._nowMs() - start;
      const vertexCount = pos.length / 3;
      if (duration > 2 || this._nowMs() >= this._nextRoadLogMs) {
        this._debugLog('road.build', {
          durationMs: duration,
          points: segments,
          vertices: vertexCount,
          adaptive: this.roadAdaptive,
          capped: segments >= this.roadMaxSegments,
        });
        this._nextRoadLogMs = this._nowMs() + this._debugLogIntervalMs;
      }
    }

    return { geo, basePos, center: centre, avgHeight: avgY };
  }

  /* ---------------- ground & coords ---------------- */

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

  _worldToLatLon(x, z) {
    const { dLat, dLon } = metresPerDegree(this.lat0);
    return {
      lat: this.lat0 - z / dLat,
      lon: this.lon0 + x / dLon,
    };
  }

  /* ---------------- densify/smooth helpers ---------------- */

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

  _densifyLineAdaptive(base, minStep = 6, maxStep = 16, angleThresh = 0.35) {
    const out = [];
    const n = base.length / 2;
    if (n < 2) return base.slice();

    const v = (i) => ({ x: base[i * 2], z: base[i * 2 + 1] });
    for (let i = 0; i < n - 1; i++) {
      const p0 = i > 0 ? v(i - 1) : v(i);
      const p1 = v(i);
      const p2 = v(i + 1);

      let ax = p1.x - p0.x, az = p1.z - p0.z;
      let bx = p2.x - p1.x, bz = p2.z - p1.z;
      const al = Math.hypot(ax, az) || 1;
      const bl = Math.hypot(bx, bz) || 1;
      ax /= al; az /= al; bx /= bl; bz /= bl;

      const dot = Math.max(-1, Math.min(1, ax * bx + az * bz));
      const theta = Math.acos(dot);

      const t = Math.min(1, theta / angleThresh);
      const step = maxStep - (maxStep - minStep) * t;

      const dx = p2.x - p1.x, dz = p2.z - p1.z;
      const len = Math.hypot(dx, dz);
      const seg = Math.max(1, Math.ceil(len / step));
      for (let s = 0; s < seg; s++) {
        const u = s / seg;
        out.push(p1.x + dx * u, p1.z + dz * u);
      }
    }

    out.push(base[base.length - 2], base[base.length - 1]);
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

  /* ---------------- tiles & cache utils ---------------- */

  _tileKeyForWorld(x, z) {
    const tx = Math.floor(x / this.tileSize);
    const tz = Math.floor(z / this.tileSize);
    return `${tx},${tz}`;
  }

  _tileSpanForRadius() {
    const radius = Math.max(this.radius || 0, this.tileSize * 0.5);
    const diag = this._tileDiagHalf || (this.tileSize * Math.SQRT2 * 0.5);
    const rawSpan = Math.ceil((radius + diag) / this.tileSize);
    const cap = Number.isFinite(this._tileSpanCap) ? this._tileSpanCap : rawSpan;
    return Math.max(1, Math.min(rawSpan, cap));
  }

  _bboxForTile(tileKey) {
    const [tx, tz] = tileKey.split(',').map(Number);
    const minX = tx * this.tileSize;
    const maxX = (tx + 1) * this.tileSize;
    const minZ = tz * this.tileSize;
    const maxZ = (tz + 1) * this.tileSize;
    const { dLat, dLon } = metresPerDegree(this.lat0);
    const lonA = this.lon0 + minX / dLon;
    const lonB = this.lon0 + maxX / dLon;
    const latA = this.lat0 - minZ / dLat;
    const latB = this.lat0 - maxZ / dLat;
    const minLat = Math.min(latA, latB);
    const maxLat = Math.max(latA, latB);
    const minLon = Math.min(lonA, lonB);
    const maxLon = Math.max(lonA, lonB);
    return [minLat, minLon, maxLat, maxLon];
  }

  _latLonToWorld(lat, lon) {
    const { dLat, dLon } = metresPerDegree(this.lat0);
    return {
      x: (lon - this.lon0) * dLon,
      z: (this.lat0 - lat) * dLat,
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

    if (this._resnapDirtyTiles.has(tileKey)) this._resnapDirtyTiles.delete(tileKey);
    if (this._resnapDirtyQueue.length) {
      this._resnapDirtyQueue = this._resnapDirtyQueue.filter((key) => key !== tileKey);
      this._resnapDirtyIndex = Math.min(this._resnapDirtyIndex, this._resnapDirtyQueue.length);
    }

    for (const building of state.buildings) {
      if (building.render) {
        this.group.remove(building.render);
        building.render.geometry?.dispose?.();
        building.render = null;
      }
      if (building.solid) {
        this.physics?.unregisterStaticMesh(building.solid);
        this.group.remove(building.solid);
        building.solid.geometry?.dispose?.();
        building.solid = null;
      }
      if (building.pick) {
        this._pickerRoot.remove(building.pick);
        building.pick.geometry?.dispose?.();
        building.pick = null;
      }
    }
    state.buildings = [];

    for (const extra of state.extras) {
      this.group.remove(extra);
      if (extra.geometry) extra.geometry.dispose();
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
    if (this._pendingTerrainTiles) this._pendingTerrainTiles.delete(tileKey);
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
    this._resnapDirtyQueue.length = 0;
    this._resnapDirtyIndex = 0;
    this._resnapDirtyTiles.clear();
    this._pendingTerrainTiles?.clear?.();
    for (const tileKey of Array.from(this._tileStates.keys())) this._removeTileObjects(tileKey);
    this._tileStates.clear();
  }

  _disposeObject(obj) {
    obj.traverse?.((child) => {
      if (child.isMesh) {
        child.geometry?.dispose?.();
        if (Array.isArray(child.material)) child.material.forEach((m) => m?.dispose?.());
        else child.material?.dispose?.();
      }
    });
  }

  _waterMaterial() {
    return this._waterMaterialShared;
  }
}
