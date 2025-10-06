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
const CACHE_LIMIT = 320;
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
const MERGE_BUDGET_MS = 2; // milliseconds per idle slice
const BUILD_FRAME_BUDGET_MS = 3.5; // ms budget to spend per frame on feature builds
const BUILD_IDLE_BUDGET_MS = 4.0; // ms budget when we have idle time available
const RESNAP_INTERVAL = 2.0; // seconds between ground rescan passes
const RESNAP_FRAME_BUDGET_MS = 0.8; // ms per frame allotted to resnap tiles
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
    radius = 2000,
    tileSize,
    color = 0x333333,
    roadWidth = 4,
    roadOffset = 0.05,
    roadStep = 12,
    roadAdaptive = true,
    roadMinStep = 4,
    roadMaxStep = 24,
    roadAngleThresh = 0.35,
    roadMaxSegments = 100,
    roadLit = false,
    roadShadows = false,
    roadColor = 0x333333,
    extraDepth = 0.1,
    extensionHeight = 2,
    inputEl = null,            // NEW
    holdToOpenMs = 600,        // NEW (optional override)

    maxConcurrentFetches = 1, // retained for API compatibility
  } = {}) {
    this._duckScale = 0.10; // 10% of current size
    this._duckPersistMs = 0;
    this._duckHideTimer = null;
    this.scene = scene;
    this.camera = camera;
    this.tileManager = tileManager;
    this.radius = radius;
    this._baseRadius = radius;
    this._currentPerfQuality = 1;
    this.tileSize = tileSize || (tileManager?.tileRadius ? tileManager.tileRadius * 1.75 : 160);
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

    this._waterMaterials = new Set();

    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();

    this._waterTime = 0;

    this._edgeMaterial = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5 });
    this._highlightEdgeMaterial = new THREE.LineBasicMaterial({ color: 0xffd166, linewidth: 1, transparent: true, opacity: 1 });
    this._stemMaterial = new THREE.LineBasicMaterial({ color: 0xffd166, linewidth: 1, transparent: true, opacity: 0.9 });
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
    const qualityRaw = Number.isFinite(profile?.quality) ? profile.quality : this._currentPerfQuality;
    const quality = THREE.MathUtils.clamp(qualityRaw ?? 1, 0.3, 1.1);
    this._currentPerfQuality = quality;

    const fps = Number.isFinite(profile?.smoothedFps) ? profile.smoothedFps : this._smoothedFps;
    if (Number.isFinite(fps)) this._smoothedFps = fps;

    const target = Number.isFinite(profile?.targetFps) && profile.targetFps > 0
      ? profile.targetFps
      : (this._qosTargetFps || TARGET_FPS);
    this._qosTargetFps = target;

    const lerp = (lo, hi) => lo + (hi - lo) * quality;
    this._frameBudgetMs = lerp(0.45, BUILD_FRAME_BUDGET_MS);
    this._idleBudgetMs = lerp(2.4, BUILD_IDLE_BUDGET_MS);
    this._mergeBudgetMs = lerp(1.6, MERGE_BUDGET_MS);
    this._resnapFrameBudgetMs = lerp(0.35, RESNAP_FRAME_BUDGET_MS);
    this._resnapInterval = lerp(RESNAP_INTERVAL * 3.6, RESNAP_INTERVAL);
    this._tileUpdateInterval = lerp(0.55, 0);
    this._tileUpdateTimer = Math.min(this._tileUpdateTimer, this._tileUpdateInterval);
    if (this._tileUpdateInterval <= 0) this._tileUpdateTimer = 0;

    const desiredRadius = this._baseRadius;
    if (Math.abs(desiredRadius - this.radius) > 0.5) {
      this.radius = desiredRadius;
      this._refreshRadiusVisibility();
    }

    const level = quality >= 0.82 ? 'high' : (quality >= 0.6 ? 'medium' : 'low');
    this._qosLevel = level;

    return {
      quality,
      level,
      frameBudget: this._frameBudgetMs,
      idleBudget: this._idleBudgetMs,
      mergeBudget: this._mergeBudgetMs,
      resnapBudget: this._resnapFrameBudgetMs,
      resnapInterval: this._resnapInterval,
      radius: this.radius,
    };
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

    this._resnapTimer += dt;
    if (this._resnapTimer > this._resnapInterval) {
      this._resnapTimer = 0;
      this._queueResnapSweep();
    }
    this._drainResnapQueue(this._resnapFrameBudgetMs);

    this._waterTime += dt;
    for (const mat of this._waterMaterials) mat.uniforms.uTime.value = this._waterTime;

    // Keep the old label oriented (if you ever turn it back on)
    if (this._hoverGroup.visible) this._orientLabel(this.camera);

    // CSS3D panel orientation + render overlay
    if (this._cssEnabled && this._cssRenderer && this._cssScene) {
      this._updateCSS3DPanelFacing();
      this._cssRenderer.render(this._cssScene, this.camera);
    }
  }

  dispose() {
    this.scene?.remove(this.group);
    this.clearHover();
    this._clearAllTiles();
    this._edgeMaterial.dispose();
    this._highlightEdgeMaterial.dispose();
    this._stemMaterial.dispose();
    this._pickMaterial.dispose();

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
  }

  _showHover(info, point, camera) {
    this._ensureHoverArtifacts();

    // Update highlight edges once per target
    if (this._hoverInfo !== info) {
      const highlightGeom = this._buildHighlightGeometry(info);
      this._hoverEdges.geometry.dispose();
      this._hoverEdges.geometry = highlightGeom;
      this._hoverEdges.position.set(0, 0, 0);

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

  _hideDuckDuckGoPanel() {
    // If you keep your CSS3D panel in this._duck.group or similar, hide it here.
    // Guarded so it’s safe if not created yet.
    if (this._duck?.group) this._duck.group.visible = false;
  }

  _toDuckUrl(q) {
    const encoded = encodeURIComponent(String(q || '').trim()).replace(/%20/g, '+');
    return `https://duckduckgo.com/?q=${encoded}&ia=web`;
  }

  _buildSearchQuery(info) {
    const parts = [];
    if (info?.address) parts.push(info.address);
    if (info?.tags?.name) parts.push(info.tags.name);
    if (info?.tags?.amenity) parts.push(info.tags.amenity);
    if (info?.tags?.shop) parts.push(info.tags.shop);
    return parts.filter(Boolean).join(' ');
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
          const centre = building?.info?.centroid;
          const inside = centre ? this._isInsideRadius(centre) : true;
          if (building.render) building.render.visible = inside;
          if (building.solid) building.solid.visible = inside;
          if (building.pick) building.pick.visible = inside;
          if (inside) anyBuildingVisible = true;
        }
      }

      if (state.mergedGroup) state.mergedGroup.visible = anyBuildingVisible;

      if (state.extras?.length) {
        for (const extra of state.extras) {
          const centre = extra?.userData?.center;
          const inside = centre ? this._isInsideRadius(centre) : true;
          extra.visible = inside;
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

    const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const start = now();
    const hasDeadline = deadline && typeof deadline.timeRemaining === 'function';
    const timeRemaining = () => {
      const budgetLeft = frameBudget - (now() - start);
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
        const { render, solid, pick, info } = building;
        info.tile = tileKey;
        this.group.add(render);
        if (solid) this.group.add(solid);
        this._pickerRoot.add(pick);
        render.updateMatrixWorld(true);
        pick.updateMatrixWorld(true);
        if (solid) solid.updateMatrixWorld(true);
        this._resnapBuilding(building);
        if (solid && this.physics) this.physics.registerStaticMesh(solid, { forceUpdate: true });
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
      b.render.updateMatrixWorld(true);
      const elapsed = performance.now() - start;
      if (elapsed > this._mergeBudgetMs) break;
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

  /* ---------------- building/road/water creation ---------------- */

  _buildBuilding(flat, tags, id) {
    const rawFootprint = flat.slice();
    if (rawFootprint.length < 6) return null;

    const height = this._chooseBuildingHeight(tags);
    const extrusion = height + this.extensionHeight;

    const baseline = this._lowestGround(rawFootprint) + this.extraDepth;
    const groundBase = baseline - this.extraDepth;

    // Wireframe (canonical reference)
    const wireGeom = this._makeWireGeometry(rawFootprint, groundBase, extrusion);
    const edges = new THREE.LineSegments(wireGeom, this._edgeMaterial);
    edges.castShadow = false;
    edges.receiveShadow = false;

    // Solid + picker: generated directly from same footprint
    const solidGeo = this._makeSolidGeometry(rawFootprint, extrusion);

    const pickMesh = new THREE.Mesh(solidGeo.clone(), this._pickMaterial);
    pickMesh.position.set(0, baseline, 0);

    const fillMat = this._buildingFillMaterial || (
      this._buildingFillMaterial = new THREE.MeshBasicMaterial({
        color: 0x333333,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1,
        side: THREE.DoubleSide,
      })
    );
    const solidMesh = new THREE.Mesh(solidGeo.clone(), fillMat);
    solidMesh.position.set(0, baseline, 0);
    solidMesh.renderOrder = 1;

    const centroid = averagePoint(rawFootprint);
    const address = formatAddress(tags);
    const info = { id, address, rawFootprint, height: extrusion, baseHeight: groundBase, centroid, tags: { ...tags }, tile: null };

    edges.userData.buildingInfo = info;
    pickMesh.userData.buildingInfo = info;
    solidMesh.userData.buildingInfo = info;

    return { render: edges, solid: solidMesh, pick: pickMesh, info };
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

  /* ---------------- resnap sweep ---------------- */

  _queueResnapSweep() {
    if (!this._tileStates.size) return;
    if (this._resnapQueue && this._resnapIndex < this._resnapQueue.length) return;
    this._resnapQueue = Array.from(this._tileStates.keys());
    this._resnapIndex = 0;
  }

  _drainResnapQueue(budgetMs) {
    if (!this._resnapQueue || this._resnapIndex >= this._resnapQueue.length) return;

    const effectiveBudget = Number.isFinite(budgetMs) && budgetMs > 0
      ? budgetMs
      : this._resnapFrameBudgetMs;
    if (effectiveBudget <= 0) return;

    const now = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const start = now();

    while (this._resnapIndex < this._resnapQueue.length) {
      const elapsed = now() - start;
      if (elapsed > effectiveBudget) break;

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
    if (building.solid) {
      building.solid.position.y = baseline;
      building.solid.updateMatrixWorld(true);
      this.physics?.registerStaticMesh(building.solid, { forceUpdate: true });
    }
    if (building.pick) {
      building.pick.position.y = baseline;
      building.pick.updateMatrixWorld(true);
    }
 if (changed && this._hoverInfo === info) {
   // Rebuild hover artifacts to match the new base/height
   if (this._hoverEdges) {
     const g = this._buildHighlightGeometry(info);
     this._hoverEdges.geometry.dispose();
     this._hoverEdges.geometry = g;
   }
   // Recompute stem + label position facing camera
   const anchorTop = this._chooseAnchorTop(info);
   const camPos = this.camera.getWorldPosition(this._tmpVec2);
   const dir = camPos.clone().sub(anchorTop); dir.y = 0; if (dir.lengthSq() < 1e-6) dir.set(1,0,0); dir.normalize();
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
    if (this.roadLit) mesh.geometry.computeVertexNormals();
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
    const { geo, basePos, center } = geomData;

    const mat = this.roadLit
      ? new THREE.MeshStandardMaterial({ color: this.roadColor, metalness: 0.4, roughness: 0.85, transparent: true, opacity: 0.1, blending: THREE.NormalBlending })
      : new THREE.MeshBasicMaterial({ color: this.roadColor });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = !!this.roadShadows;
    mesh.receiveShadow = !!this.roadShadows;

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
    return { geo, basePos, center: centre };
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

    for (const building of state.buildings) {
      if (building.render) {
        this.group.remove(building.render);
        building.render.geometry.dispose();
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
        uColor: { value: new THREE.Color(0x333333) },
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
