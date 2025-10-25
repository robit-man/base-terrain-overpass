// app.js — drop-in replacement with non-breaking optimizations
import * as THREE from 'three';
import { SceneManager } from './scene.js';
import { Sensors, GeoButton } from './sensors.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { TileManager } from './tiles.js';
import { ipLocate, latLonToWorld, worldToLatLon, metresPerDegree } from './geolocate.js';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';
import { Locomotion } from './locomotion.js';
import { Remotes } from './remotes.js';
import { Mesh } from './mesh.js';
import { ui, applyHudStatusDot, pushToast } from './ui.js';
import { deg, rad, fmtAgo, shortHex } from './utils.js';
import { AvatarFactory } from './avatars.js';
import { ChaseCam } from './chasecam.js';
import { BuildingManager } from './buildings.js';
import { PhysicsEngine } from './physics.js';
import { MiniMap } from './minimap.js';
import { AdaptiveQualityManager } from './adaptiveQuality.js';
import { HybridHub } from './hybrid.js';
import { WeatherManager } from './weather.js';
import { RadioManager } from './radio.js';
import { SmartObjectManager } from './smartObjects.js';
import { SpatialAudioManager } from './spatialAudio.js';
import { SmartObjectModal } from './smartModal.js';

const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = rad(23.4397);

class PerfLogger {
  constructor({ slowFrameMs = 33, reportIntervalMs = 2000, labelLimit = 6 } = {}) {
    this.slowFrameMs = slowFrameMs;
    this.reportIntervalMs = reportIntervalMs;
    this.labelLimit = Math.max(1, labelLimit | 0);
    this._now = (typeof performance !== 'undefined' && performance.now)
      ? () => performance.now()
      : () => Date.now();
    this._nextReportAt = 0;
    this._active = new Map();
    this._records = [];
    this._frameStart = 0;
    this._maxByLabel = new Map();
    this.historyLimit = 3600;
    this._historyByLabel = new Map();
    this._statsByLabel = new Map();
    this._frameCounter = 0;
  }

  frameStart() {
    this._frameStart = this._now();
    this._records.length = 0;
    this._active.clear();
  }

  begin(label) {
    if (!label) return;
    this._active.set(label, this._now());
  }

  end(label) {
    if (!label) return 0;
    const start = this._active.get(label);
    if (start == null) return 0;
    const duration = this._now() - start;
    this._active.delete(label);
    this._records.push([label, duration]);
    const prev = this._maxByLabel.get(label) || 0;
    if (duration > prev) this._maxByLabel.set(label, duration);
    let stat = this._statsByLabel.get(label);
    if (!stat) {
      stat = { total: 0, count: 0, max: 0, min: Infinity, last: 0 };
      this._statsByLabel.set(label, stat);
    }
    stat.total += duration;
    stat.count += 1;
    stat.last = duration;
    if (duration > stat.max) stat.max = duration;
    if (duration < stat.min) stat.min = duration;
    let history = this._historyByLabel.get(label);
    if (!history) {
      history = [];
      this._historyByLabel.set(label, history);
    }
    history.push(duration);
    if (history.length > this.historyLimit) history.splice(0, history.length - this.historyLimit);
    return duration;
  }

  measure(label, fn) {
    this.begin(label);
    try {
      return fn();
    } finally {
      this.end(label);
    }
  }

  frameEnd() {
    const end = this._now();
    const frameDuration = end - this._frameStart;
    const shouldLog = frameDuration > this.slowFrameMs || end >= this._nextReportAt;
    if (shouldLog) {
      const merged = [...this._records];
      merged.sort((a, b) => b[1] - a[1]);
      const top = merged
        .slice(0, this.labelLimit)
        .map(([label, dur]) => `${label}:${dur.toFixed(2)}ms`)
        .join(' | ') || 'no sections';
      let peaks = '';
      if (this._maxByLabel.size) {
        const peakList = [...this._maxByLabel.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, this.labelLimit)
          .map(([label, dur]) => `${label}≤${dur.toFixed(1)}ms`)
          .join(' | ');
        if (peakList) peaks = ` | peaks ${peakList}`;
      }
      console.log(`[perf] frame ${frameDuration.toFixed(2)}ms | top ${top}${peaks}`);
      this._nextReportAt = end + this.reportIntervalMs;
    }
    this._frameCounter += 1;
    return frameDuration;
  }

  getProcessStats() {
    const out = [];
    for (const [label, stat] of this._statsByLabel.entries()) {
      const history = this._historyByLabel.get(label) || [];
      const avg = stat.count ? stat.total / stat.count : 0;
      const min = stat.min === Infinity ? 0 : stat.min;
      out.push({
        label,
        avg,
        max: stat.max || 0,
        min,
        last: stat.last || 0,
        samples: stat.count || 0,
        history: history.slice(-this.historyLimit),
      });
    }
    out.sort((a, b) => (b.avg || 0) - (a.avg || 0));
    return out;
  }

  resetStats() {
    this._historyByLabel.clear();
    this._statsByLabel.clear();
    this._maxByLabel.clear();
  }
}

const isMobile = /Mobi|Android/i.test(navigator.userAgent);
const hasGeolocation = typeof navigator !== 'undefined' && 'geolocation' in navigator;
const RAD = THREE.MathUtils.degToRad;
const MANUAL_LOCATION_KEY = 'xr.manualLocation.v1';
const GPS_LOCK_KEY = 'xr.gpsLockEnabled.v1';
const COMPASS_YAW_KEY = 'xr.useCompassYaw.v1';
const PLAYER_POSE_KEY = 'xr.playerPose.v1';
const DEBUG_STATE_KEY = 'xr.debugMode.v1';
const PROCESS_METRICS_KEY = 'xr.processMetrics.v2';
const DEFAULT_TERRAIN_DATASET = 'mapzen';

class App {
  constructor() {
    if (location.protocol !== 'https:') {
      location.href = 'https:' + window.location.href.substring(location.protocol.length);
      return;
    }

    // Core systems
    this.sceneMgr = new SceneManager();
    this.sceneMgr.app = this;

    // === NEW: cap pixel ratio to avoid overdraw on HiDPI ===
    const devicePixelRatioSafe = window.devicePixelRatio || 1;
    this._pixelRatioBounds = {
      min: Math.min(0.55, devicePixelRatioSafe),
      max: Math.min(devicePixelRatioSafe, 1.5),
    };
    this._pixelRatioState = 'high';
    this._pixelRatioTarget = this._pixelRatioBounds.max;
    this._pixelRatioApplied = null;
    try {
      const pr = Math.max(this._pixelRatioBounds.min, this._pixelRatioBounds.max);
      this.sceneMgr.renderer.setPixelRatio(pr);
      this._pixelRatioTarget = pr;
      this._pixelRatioApplied = pr;
    } catch { }

    this._poseStoredState = null;
    this._poseLatestState = null;
    this._poseSaveTimer = 0;
    this._poseDirty = false;
    this._posePersistenceReady = false;
    this._pendingPoseRestore = this._loadStoredPose();
    this._poseRestored = !!this._pendingPoseRestore;
    if (this._pendingPoseRestore) {
      const initialPose = this._clonePoseSnapshot(this._pendingPoseRestore);
      this._poseStoredState = initialPose;
      this._poseLatestState = initialPose ? this._clonePoseSnapshot(initialPose) : null;
    }
    this.sensors = new Sensors();
    this.input = new Input(this.sceneMgr);
    this._physicsPrimed = false;
    this._xrPoseActive = false;

    this._perfSnapshots = { tiles: null, buildings: null, render: null };
    this._hudHeadingState = { deg: null, source: null };
    this._hudMetaCached = null;
    this._hudGeoCached = { lat: null, lon: null, hash: null };
    this.weather = new WeatherManager();
    this._weatherActive = false;
    this._weatherHasData = false;
    this._weatherPending = false;
    this._weatherMinDeltaDeg = 0.01;
    this._weatherLastCoords = null;
    this._weatherUiCache = null;
    this._initWeatherUi();
    this._teleportClickEnabled = false;
    this._teleportTween = null;
    this._teleportPointerHandler = null;
    this._teleportMeditating = false;
    this._teleportRayTargets = [];
    this._teleportHintAt = 0;
    this.radio = new RadioManager({
      ui,
      getLocation: () => this._locationState
    });
    this._pointerLockArmed = false;
    this._pointerLockActive = false;
    this._pointerLockHoldTimer = null;
    this._pointerLockHoldPointerId = null;
    this._pointerLockHoldActive = false;
    this._pointerLockButtonState = 'idle';
    this._orbitDragActive = false;
    this._orbitDragPointerId = null;
    this._orbitDragLastX = 0;
    this._orbitDragLastY = 0;
    this._orbitDragSensitivity = 0.0022;

    this._perfCadenceMs = 220;        // ~4–5 Hz regular cadence
    this._perfNextMs = 0;
    this._perfUrge
    // === NEW: throttling state (non-breaking) ===
    this._hoverNextAllowedMs = 0;
    this._pointerLastMoveMs = 0;
    this._hoverDirty = true;
    this._hoverLastRayCamPos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._hoverCamPos = new THREE.Vector3();
    this._miniMapNextMs = 0;
    this._lastHexUpdatePos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._nextHexUpdateMs = 0;
    this._nextBuildingsUpdateMs = 0;
    this._hudGeoNextMs = 0;
    this._hudGeoLastPos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._perfLogger = new PerfLogger({ slowFrameMs: 33, reportIntervalMs: 2000, labelLimit: 6 });
    this._processMetricsStore = this._loadProcessMetrics();
    this._processUi = {
      nextUpdate: 0,
      nextPersist: 0,
      redrawInterval: 750,
      persistInterval: 4000,
    };
    this._uiTheme = null;
    this._sunUpdateNextMs = 0;
    this._sunOrigin = null;
    this._hudClockNextMs = 0;
    this._timeOffsetMs = 0;
    this._timeZoneName = null;
    this._timeFetchPending = false;
    this._timeFetchFailedUntil = 0;
    this._fetchRemoteTime();

    // Terrain + audio
    this.audio = new AudioEngine(this.sceneMgr);
    this._meshClientPromise = null;
    const terrainClientProvider = () => this._getMeshClient();
    this.hexGridMgr = new TileManager(this.sceneMgr.scene, 10, 100, this.audio, {
      terrainRelayClient: terrainClientProvider,
    });
    this.sceneMgr.setTileRadiusSource(() => {
      const tm = this.hexGridMgr;
      if (!tm) return 4000;
      const ring = Math.max(1, tm.FARFIELD_RING ?? tm.VISUAL_RING ?? 1);
      return Math.max(200, tm.tileRadius * ring);
    });
    this.sceneMgr.setTerrainTargetProvider(() => this._collectTerrainRaycastTargets());

    const visualRing = Math.max(0, this.hexGridMgr?.VISUAL_RING ?? 0);
    const tileRadius = Math.max(1, this.hexGridMgr?.tileRadius ?? 120);
    const buildingRadius = Math.max(tileRadius * (visualRing + 3), tileRadius * 4);

    this.buildings = new BuildingManager({
      radius: buildingRadius,
      scene: this.sceneMgr.scene,
      camera: this.sceneMgr.camera,
      tileManager: this.hexGridMgr,
    });
    this.buildings.setEnvironment(this.sceneMgr.scene.environment || null);
    this._wireframeMode = false;
    if (ui.hudWireframeToggle) {
      ui.hudWireframeToggle.addEventListener('click', () => this._toggleWireframe());
      this._syncWireframeUI();
    }
    this.buildings.setWireframe(this._wireframeMode);

    this._friends = new Set(this._loadFriendList());
    this._teleportToasts = new Map();
    this._hudUserListVisible = false;
    this._lastHudUsers = [];
    this._terrainAuto = true;
    this._buildingAuto = true;
    this._terrainUpdateTimer = null;
    this._buildingUpdateTimer = null;

    const perfConfig = {
      targetFps: 60,
      minQuality: 0.35,
      maxQuality: 1.05,

      // calmer anti-thrash
      qualityEps: 0.10,          // was 0.08
      qualityQuantum: 0.05,      // was 0.02
      applyMinMsDown: 1200,      // was 600 — degrade less often
      applyMinMsUp: 4000,        // was 2000 — recover slower
      allowPeriodicResyncMs: 8000
    };
    this._perfQualityRange = {
      min: perfConfig.minQuality,
      max: perfConfig.maxQuality,
    };
    this._perf = new AdaptiveQualityManager(perfConfig);
    const measuredApply = (label, fn) => (profile) => {
      if (!this._perfLogger) return fn(profile);
      return this._perfLogger.measure(label, () => fn(profile));
    };
    this._perf.registerSubsystem('terrain', {
      apply: (profile) => {
        const now = performance.now();
        if (this._terrainCooldownUntil && now < this._terrainCooldownUntil) return null;
        const out = this.hexGridMgr?.applyPerfProfile?.(profile) || null;
        this._terrainCooldownUntil = now + 500; // 0.5s cooldown
        return out;
      }
    });
    this._perf.registerSubsystem('buildings', {
      apply: measuredApply('buildings.applyProfile', (profile) => this.buildings?.applyPerfProfile?.(profile) || null),
    });
    this._perf.registerSubsystem('render', {
      apply: measuredApply('render.applyProfile', (profile) => this._applyRenderPerfProfile(profile)),
    });

    const initialState = this._perf.applyAll({ force: true });
    const initialTerrain = initialState.subsystems?.terrain || null;
    const initialBuildings = initialState.subsystems?.buildings || null;
    const initialRender = initialState.subsystems?.render || null;
    if (initialTerrain) this._perfSnapshots.tiles = initialTerrain;
    if (initialBuildings) this._perfSnapshots.buildings = initialBuildings;
    if (initialRender) this._perfSnapshots.render = initialRender;
    this._updateHudMeta(initialState);
    this._updatePidDiagnostics(initialState, { forceInputs: true });
    this._updateHudCompass();

    this._setupPhysics();

    this._locationRank = { unknown: 0, ip: 1, device: 2, manual: 3 };
    this._locationSource = 'unknown';
    this._locationState = null;
    this._lastAutoLocation = null;
    this._compassYawOffset = 0;
    this._compassYawConfidence = 0;
    this._compassLastUpdate = 0;
    this._compassEnabled = true;
    this._gpsLockEnabled = isMobile;
    const storedGpsLock = this._loadGpsLockPref();
    if (storedGpsLock != null) this._gpsLockEnabled = storedGpsLock;
    const storedCompass = this._loadCompassPref();
    if (storedCompass != null) this._compassEnabled = storedCompass;
    this._debugMode = this._loadDebugPref();

    this._gpsFilter = {
      samples: [],
      maxSamples: 8,
      avgLat: null,
      avgLon: null,
      lastWorld: null,
    };
    this._gpsRecenterMeters = 800;
    this._gpsOutlierMeters = 80;
    this._tmpGpsWorld = new THREE.Vector3();
    this._gpsLastWorld = new THREE.Vector3();
    this._gpsLastWorldValid = false;
    this._lastGpsHeading = null;
    this._gpsHeadingMinMeters = 0.25;
    this._gpsHeadingVelocityMin = 0.12;

    // Compass-first alignment (like orient.html)
    this._compassAligned = false;
    this._compassYawOffset = 0;

    if (ui.yawOffsetRange) {
      ui.yawOffsetRange.addEventListener('input', () => {
        this._manualYawOffset = THREE.MathUtils.degToRad(Number(ui.yawOffsetRange.value) || 0);
        ui.yawOffsetValue.textContent = `${ui.yawOffsetRange.value}°`;
      });
      this._manualYawOffset = THREE.MathUtils.degToRad(Number(ui.yawOffsetRange.value) || 0);
      if (ui.yawOffsetValue) ui.yawOffsetValue.textContent = `${ui.yawOffsetRange.value}°`;
    } else {
      this._manualYawOffset = 0;
    }

    document.addEventListener('gps-updated', (ev) => this._handleGpsUpdate(ev.detail));

    const storedManual = this._loadStoredManualLocation();
    if (storedManual) {
      this._handleGpsUpdate({ ...storedManual, source: 'manual', persisted: true });
    }

    ipLocate();

    if (typeof window !== 'undefined') {
      window.addEventListener('weather-updated', (ev) => this._handleWeatherUpdated(ev.detail));
    }

    // Motion / physics shim (jump, crouch, mobile drag, eye height)
    this.move = new Locomotion(this.sceneMgr, this.input, this.sensors.orient);
    this._signConfig = this._loadSignFlips();
    this.move.setSignConfig?.(this._signConfig);
    this.clock = new THREE.Clock();
    this._geoWatchId = null;
    this._mobileNav = isMobile ? {
      active: false,
      initialized: false,
      positionWorld: new THREE.Vector3(),
      predictedWorld: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      headingRad: 0,
      speed: 0,
      accuracy: Infinity,
      lastGpsTs: 0,
      lastLatLon: null
    } : null;

    if (isMobile && hasGeolocation) {
      this._initMobileTracking();
    }

    // UI poller
    this._uiTimer = setInterval(() => this._updateLocalPoseUI(), 200);

    // Avatars
    this.avatarFactoryPromise = AvatarFactory.load().catch((err) => {
      console.warn('[avatar] load failed', err);
      return null;
    });

    // Networking
    this.remotes = new Remotes(
      this.sceneMgr,
      (x, z) => this.hexGridMgr.getHeightAt(x, z),
      this.avatarFactoryPromise
    );
    this.mesh = new Mesh(this);
    this.hybrid = new HybridHub({ mesh: this.mesh });
    this.hybrid.init();

    // Initialize Smart Objects system
    this._initSmartObjects();

    // Local avatar shell
    this.localAvatar = null;
    this.avatarFactoryPromise
      .then(factory => {
        if (!factory) return;
        this.localAvatar = factory.create();
        this.localAvatar.group.name = 'local-avatar';
        this.sceneMgr.remoteLayer.add(this.localAvatar.group);
      })
      .catch(() => { });

    // Third-person chase cam
    const sampleHeight = (x, z) => {
      const mgr = this.hexGridMgr;
      if (!mgr || typeof mgr.getHeightAt !== 'function') return NaN;
      return mgr.getHeightAt(x, z);
    };
    this.chase = new ChaseCam(this.sceneMgr, () => this.move.eyeHeight(), this.sensors?.orient ?? null, sampleHeight);

    // Desktop pitch accumulator
    this._pitch = 0;
    this._pitchMin = -Math.PI / 2 + 0.01;
    this._pitchMax = Math.PI / 2 - 0.01;

    // Mobile FPV arm/switch
    this._mobileFPVArmed = isMobile;
    this._mobileFPVOn = false;

    this._pointerNdc = { x: 0, y: 0, has: false };
    this._placeBtnState = null;
    const dom = this.sceneMgr.renderer.domElement;
    window.addEventListener('pointermove', (e) => this._onPointerMove(e, dom), { passive: true });
    window.addEventListener('pointerleave', () => {
      this._pointerNdc.has = false;
      this.buildings?.clearHover();
    });
    if (dom) {
      dom.addEventListener('pointerdown', (e) => this._onCanvasPointerDown(e), { passive: true });
      dom.addEventListener('pointerup', (e) => this._onCanvasPointerUp(e), { passive: true });
      dom.addEventListener('pointerleave', (e) => this._onCanvasPointerLeave(e), { passive: true });
      dom.addEventListener('pointercancel', (e) => this._onCanvasPointerLeave(e), { passive: true });
      dom.addEventListener('pointermove', (e) => this._onCanvasPointerMove(e), { passive: false });
    }
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) {
        this._pointerNdc.x = 0;
        this._pointerNdc.y = 0;
        this._pointerNdc.has = true;
      } else {
        this._pointerNdc.has = false;
      }
      this._handlePointerLockChange(!!document.pointerLockElement);
    });
    this._raycaster = new THREE.Raycaster();
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();
    this._tmpVec4 = new THREE.Vector3();
    this._tmpVec5 = new THREE.Vector3();
    this._tmpVec6 = new THREE.Vector3();
    this._tmpVecTeleport = new THREE.Vector3();
    this._tmpScaleForward = new THREE.Vector3();
    this._tmpScaleRight = new THREE.Vector3();
    this._tmpScaleBase = new THREE.Vector3();
    this._tmpScaleOne = new THREE.Vector3();
    this._tmpScaleTen = new THREE.Vector3();
    this._tmpScaleProject = new THREE.Vector3();
    this._tmpScaleScreenA = new THREE.Vector2();
    this._tmpScaleScreenB = new THREE.Vector2();
    this._tmpScaleScreenC = new THREE.Vector2();
    this._tmpCamForward = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpQuat2 = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();
    this._tmpHeadBodyQuat = new THREE.Quaternion();
    this._tmpHeadBodyEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._headingBasis = new THREE.Vector3(0, 0, -1);
    this._headingWorld = new THREE.Vector3();
    this._upUnit = new THREE.Vector3(0, 1, 0);
    this._yAxis = new THREE.Vector3(0, 1, 0);  // for orientation offset quaternion
    this._hudScaleVisible = false;

    const compassDial = this._createCompassDial();
    this._compassDialMount = compassDial?.mount ?? null;
    this._compassDial = compassDial?.dial ?? null;
    this._compassReadoutSprite = compassDial?.readout ?? null;
    this._compassReadoutValue = null;

    const manualLatInput = document.getElementById('miniMapLat');
    const manualLonInput = document.getElementById('miniMapLon');
    const manualApplyBtn = document.getElementById('miniMapApply');

    this._manualLatInput = manualLatInput;
    this._manualLonInput = manualLonInput;

    if (ui.gpsLockToggle) {
      const gpsToggle = ui.gpsLockToggle;
      gpsToggle.checked = this._gpsLockEnabled;
      gpsToggle.disabled = !hasGeolocation;
      gpsToggle.addEventListener('change', () => {
        this._applyGpsLock(!!gpsToggle.checked, {
          forceRecenter: gpsToggle.checked,
          source: 'settings-toggle',
        });
      });
    }

    if (ui.hudGpsReckon) {
      if (!hasGeolocation) ui.hudGpsReckon.disabled = true;
      ui.hudGpsReckon.addEventListener('click', () => {
        const enable = !this._gpsLockEnabled;
        this._applyGpsLock(enable, {
          forceRecenter: enable,
          source: 'hud-reckon',
        });
      });
    }

    if (ui.hudDebugToggle) {
      ui.hudDebugToggle.addEventListener('click', () => {
        this._debugMode = !this._debugMode;
        this._storeDebugPref(this._debugMode);
        this._syncDebugUI();
        this._applyDebugMode();
      });
    }

    if (ui.hudReset) {
      ui.hudReset.addEventListener('click', () => this._handleResetRequest());
    }

    if (ui.yawAssistToggle) {
      const yawBtn = ui.yawAssistToggle;
      const updateYawText = () => {
        yawBtn.textContent = `Yaw Corr: ${this._compassEnabled ? 'On' : 'Off'}`;
      };
      updateYawText();
      yawBtn.addEventListener('click', () => {
        this._compassEnabled = !this._compassEnabled;
        this._storeCompassPref(this._compassEnabled);
        this._compassYawOffset = 0;
        this._compassYawConfidence = 0;
        this._compassLastUpdate = 0;
        this._compassAligned = false; // Reset compass-first alignment
        updateYawText();
      });
    }

    this.miniMap = new MiniMap({
      mapContainer: document.getElementById('miniMapMap'),
      statusEl: document.getElementById('miniMapStatus'),
      recenterBtn: document.getElementById('miniMapRecenter'),
      setBtn: document.getElementById('miniMapSet'),
      moveBtn: ui.miniMapMove,
      snapBtn: ui.miniMapSnap,
      tileManager: this.hexGridMgr,
      getWorldPosition: () => this.sceneMgr?.dolly?.position,
      getHeadingDeg: () => {
        const dolly = this.sceneMgr?.dolly;
        if (!dolly) return 0;
        const forward = this._headingWorld.copy(this._headingBasis).applyQuaternion(dolly.quaternion);
        const deg = (Math.atan2(forward.x, forward.z) * 180) / Math.PI;
        return (deg + 360) % 360;
      },
      getCompassHeadingRad: () => this.sensors?.headingRad,
      isSnapActive: () => this.move?.isSnapActive?.() ?? false,
      getPeers: () => this._collectPeerLocations(),
      onCommitLocation: ({ lat, lon }) => {
        this._handleGpsUpdate({ lat, lon, source: 'manual' });
      },
      onRequestAuto: () => {
        if (this._locationSource === 'manual' && this._lastAutoLocation) {
          this._clearManualLocation();
          this._handleGpsUpdate({
            ...this._lastAutoLocation,
            force: true,
            preserveManual: false,
          });
        }
      },
      onRequestTeleport: ({ lat, lon }) => {
        this._handleMiniMapTeleport({ lat, lon });
      },
      onRequestSnap: ({ headingRad }) => this._snapToCompassHeading(headingRad),
    });

    this._syncGpsLockUI();

    this._terrainStatusEl = ui.terrainRelayStatus || null;
    this._hudTerrainDot = ui.hudStatusTerrainDot || null;
    this._hudTerrainLabel = ui.hudStatusTerrainLabel || null;

    this._syncDebugUI();
    this._applyDebugMode();
    this._updateUiThemeBySun();
    this._initProcessLeaderboard();

    const relayInput = ui.terrainRelayInput;
    const datasetInput = ui.terrainDatasetInput;
    const modeGeohash = ui.terrainModeGeohash;
    const modeLatLng = ui.terrainModeLatLng;

    if (relayInput) relayInput.value = this.hexGridMgr.relayAddress || '';
    if (datasetInput) datasetInput.value = this.hexGridMgr.relayDataset || DEFAULT_TERRAIN_DATASET;
    if (modeGeohash && modeLatLng) {
      if (this.hexGridMgr.relayMode === 'latlng') modeLatLng.checked = true;
      else modeGeohash.checked = true;
    }

    relayInput?.addEventListener('change', () => {
      const addr = relayInput.value.trim();
      this.hexGridMgr.setRelayAddress(addr);
      this.hexGridMgr.refreshTiles();
    });

    datasetInput?.addEventListener('change', () => {
      const dataset = datasetInput.value.trim() || DEFAULT_TERRAIN_DATASET;
      this.hexGridMgr.setRelayDataset(dataset);
      this.hexGridMgr.refreshTiles();
    });

    this._setupEnvironmentControls();
    this._setupDiagnosticsControls();
    this._setupCharacterControls();
    this._populateDeviceInfo();
    this._syncEnvironmentAutoButtons();

    if (ui.hudUsersToggle) {
      ui.hudUsersToggle.addEventListener('click', () => this._toggleHudUserList());
    }
    this._syncHudUserListVisibility();

    modeGeohash?.addEventListener('change', () => {
      if (!modeGeohash.checked) return;
      this.hexGridMgr.setRelayMode('geohash');
      this.hexGridMgr.refreshTiles();
    });

    modeLatLng?.addEventListener('change', () => {
      if (!modeLatLng.checked) return;
      this.hexGridMgr.setRelayMode('latlng');
      this.hexGridMgr.refreshTiles();
    });

    const applyManual = () => {
      const lat = Number.parseFloat(manualLatInput?.value ?? '');
      const lon = Number.parseFloat(manualLonInput?.value ?? '');
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        if (this.miniMap?.statusEl) {
          this.miniMap.statusEl.textContent = 'Manual override invalid · expected lat [-90,90], lon [-180,180]';
        }
        return;
      }
      this._handleGpsUpdate({ lat, lon, source: 'manual' });
    };

    manualApplyBtn?.addEventListener('click', applyManual);
    manualLatInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyManual(); });
    manualLonInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') applyManual(); });

    if (ui.hudTeleportToggle) {
      ui.hudTeleportToggle.addEventListener('click', () => this._toggleTeleportClickMode());
      this._syncTeleportButtonState();
    }
    this._setupTeleportPointerHandler();

    if (ui.hudPointerLock) {
      ui.hudPointerLock.addEventListener('click', () => this._handlePointerLockButton());
      this._syncPointerLockButton(true);
    }

    if (ui.hudPlaceToggle) {
      ui.hudPlaceToggle.addEventListener('click', () => this._toggleSmartPlacementMode());
      this._syncPlaceButtonState(true);
    }

    if (this._locationState) {
      this.miniMap.notifyLocationChange({
        lat: this._locationState.lat,
        lon: this._locationState.lon,
        source: this._locationSource,
      });
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => this._refreshRendererPixelRatio(), { passive: true });
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this._clickTeleportEnabled) {
          this._setTeleportClickEnabled(false);
        }
      });
    }

    this._initPosePersistence();
    this.sceneMgr.renderer.setAnimationLoop(() => this._tick());

    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyC') this._spawnPhysicsProbe();
    });
  }

  /* ---------- Location management ---------- */

  _handleGpsUpdate(detail = {}) {
    if (!detail) return;
    const { lat, lon } = detail;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const source = detail.source || 'unknown';
    const isManual = source === 'manual';
    const lockActive = this._gpsLockEnabled && !isManual;
    let effectiveLat = lat;
    let effectiveLon = lon;
    let sampleInfo = null;

    if (detail.incremental && isMobile && this._mobileNav) {
      if (this._gpsLockEnabled) {
        this._updateMobileNavFromGps(detail);
      } else {
        this._mobileNav.active = false;
        this._mobileNav.initialized = false;
        this._mobileNav.velocity?.set?.(0, 0, 0);
        if (source !== 'manual') {
          this._lastAutoLocation = { lat, lon, source };
          this._locationState = { lat, lon };
        }
      }
      return;
    }

    if (lockActive) {
      sampleInfo = this._ingestGpsSample(lat, lon);
      if (!sampleInfo) return;
      if (Number.isFinite(sampleInfo.lat) && Number.isFinite(sampleInfo.lon)) {
        effectiveLat = sampleInfo.lat;
        effectiveLon = sampleInfo.lon;
      }
    }

    const rank = this._locationRank?.[source] ?? this._locationRank.unknown;
    const currentRank = this._locationRank?.[this._locationSource] ?? this._locationRank.unknown;
    const force = detail.force === true;

    if (!force && rank < currentRank) {
      if (source !== 'manual') {
        this._lastAutoLocation = { lat: effectiveLat, lon: effectiveLon, source };
        this._locationState = { lat: effectiveLat, lon: effectiveLon };
      }
      return;
    }

    if (!force && rank === currentRank && this._locationState) {
      const deltaLat = Math.abs(effectiveLat - this._locationState.lat);
      const deltaLon = Math.abs(effectiveLon - this._locationState.lon);
      const sameCoords = deltaLat < 1e-7 && deltaLon < 1e-7;
      if (sameCoords && source !== 'manual') return;
    }

    const shouldLock = this._gpsLockEnabled || source === 'manual';
    const detailForApply = { ...detail };
    if (!shouldLock && source !== 'manual' && detailForApply.recenter == null) {
      detailForApply.recenter = false;
    }

    if (lockActive) {
      this._applySmoothedGps({
        lat: effectiveLat,
        lon: effectiveLon,
        source,
        rawDetail: detail,
      });
    } else {
      this._applyLocation({ lat: effectiveLat, lon: effectiveLon, source, detail: detailForApply });
    }

    if (isMobile && this._mobileNav && source !== 'manual') {
      if (this._gpsLockEnabled) {
        this._updateMobileNavFromGps({ ...detail, lat: effectiveLat, lon: effectiveLon, incremental: false });
      } else {
        this._mobileNav.active = false;
      }
    }
  }

  _applyLocation({ lat, lon, source, detail = {} }) {
    this._locationSource = source;
    this._locationState = { lat, lon };

    if (this._manualLatInput) this._manualLatInput.value = lat.toFixed(6);
    if (this._manualLonInput) this._manualLonInput.value = lon.toFixed(6);

    const isManualRequest = source === 'manual' || detail.manual === true;
    const skipOrigin = detail.skipOrigin === true;

    if (!skipOrigin && this._gpsFilter) {
      this._gpsFilter.samples.length = 0;
      this._gpsFilter.avgLat = lat;
      this._gpsFilter.avgLon = lon;
      this._gpsFilter.lastWorld = null;
      this._gpsLastWorldValid = false;
      this._gpsLastWorld?.set(0, 0, 0);
      this._lastGpsHeading = null;
    }

    if (!skipOrigin) {
      this.hexGridMgr?.setOrigin(lat, lon, { immediate: isManualRequest });
      this.buildings?.setOrigin(lat, lon, { forceRefresh: isManualRequest });
    }
    if (isManualRequest && !skipOrigin) {
      this.physics?.resetTerrain?.();
      this._poseStoredState = null;
      this._poseLatestState = null;
      this._poseDirty = true;
      this._poseSaveTimer = 0;
      this._poseRestored = false;
      this._pendingPoseRestore = null;
    }

    const allowRecenter = !skipOrigin && detail.recenter !== false && (this._gpsLockEnabled || source === 'manual');
    const skipRecenterForStoredPose = this._poseRestored && detail.force !== true && !isManualRequest;
    if (allowRecenter && !skipRecenterForStoredPose) {
      this._resetPlayerPosition();
      if (isManualRequest) {
        this.hexGridMgr?.update(this.sceneMgr?.dolly?.position || new THREE.Vector3());
      }
    }

    if (source === 'manual') {
      if (!detail.persisted) this._storeManualLocation(lat, lon);
      if (this._mobileNav) {
        this._mobileNav.active = false;
        this._mobileNav.initialized = false;
        this._mobileNav.velocity?.set?.(0, 0, 0);
      }
      this._compassYawOffset = 0;
      this._compassYawConfidence = 0;
      this._compassLastUpdate = 0;
    } else if (!detail.preserveManual) {
      this._clearManualLocation();
    }

    if (source !== 'manual') {
      this._lastAutoLocation = { lat, lon, source };
    }

    this._maybeUpdateWeatherFromScene({ lat, lon });
    if (source !== 'manual') {
      this.miniMap?.enableFollow?.();
    }
    this.radio?.refreshRegion?.();

    this.miniMap?.notifyLocationChange?.({ lat, lon, source, detail });
    this.miniMap?.forceRedraw?.();
  }

  _ingestGpsSample(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    if (!this._gpsFilter) {
      this._gpsFilter = { samples: [], maxSamples: 8, avgLat: null, avgLon: null, lastWorld: null };
    }
    const filter = this._gpsFilter;
    if (!Array.isArray(filter.samples)) filter.samples = [];

    if (Number.isFinite(filter.avgLat) && Number.isFinite(filter.avgLon)) {
      const { dLat, dLon } = metresPerDegree(filter.avgLat);
      const dLatMeters = Math.abs(lat - filter.avgLat) * dLat;
      const dLonMeters = Math.abs(lon - filter.avgLon) * dLon;
      const distMeters = Math.hypot(dLatMeters, dLonMeters);
      if (Number.isFinite(this._gpsOutlierMeters) && distMeters > this._gpsOutlierMeters) {
        filter.samples = [{ lat, lon }];
        filter.avgLat = lat;
        filter.avgLon = lon;
        return { lat, lon, count: 1, reset: true };
      }
    }

    filter.samples.push({ lat, lon });
    if (filter.samples.length > (filter.maxSamples || 8)) filter.samples.shift();

    let sumLat = 0;
    let sumLon = 0;
    for (const s of filter.samples) {
      sumLat += s.lat;
      sumLon += s.lon;
    }
    filter.avgLat = sumLat / filter.samples.length;
    filter.avgLon = sumLon / filter.samples.length;

    return { lat: filter.avgLat, lon: filter.avgLon, count: filter.samples.length };
  }

  _applySmoothedGps({ lat, lon, source = 'gps', rawDetail = {} } = {}) {
    const dolly = this.sceneMgr?.dolly;
    if (!dolly || !Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const origin = this.hexGridMgr?.origin || null;
    const detailBase = { ...rawDetail, source };

    if (!origin) {
      this._applyLocation({
        lat,
        lon,
        source,
        detail: { ...detailBase, recenter: true, skipOrigin: false, preserveManual: true }
      });
      if (this._gpsFilter) {
        this._gpsFilter.lastWorld = new THREE.Vector3(0, 0, 0);
      }
      return;
    }

    const world = latLonToWorld(lat, lon, origin.lat, origin.lon);
    if (!world) return;

    const target = this._tmpGpsWorld.set(world.x, 0, world.z);
    const radial = target.length();
    const recenterLimit = Number.isFinite(this._gpsRecenterMeters) ? this._gpsRecenterMeters : 800;

    if (radial > recenterLimit) {
      if (this._gpsFilter) {
        this._gpsFilter.samples = [];
        this._gpsFilter.avgLat = lat;
        this._gpsFilter.avgLon = lon;
        this._gpsFilter.lastWorld = null;
      }
      this._applyLocation({
        lat,
        lon,
        source,
        detail: { ...detailBase, recenter: true, skipOrigin: false, preserveManual: true }
      });
      return;
    }

    const allowHeading = this._gpsLockEnabled && source !== 'manual';
    let moveDx = 0;
    let moveDz = 0;
    if (this._gpsLastWorldValid) {
      moveDx = target.x - this._gpsLastWorld.x;
      moveDz = target.z - this._gpsLastWorld.z;
    }

    dolly.position.x = target.x;
    dolly.position.z = target.z;

    if (allowHeading && this._gpsLastWorldValid) {
      this._applyMotionHeadingFromVector(moveDx, moveDz, { minDistance: this._gpsHeadingMinMeters });
    }

    const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
    const groundY = this.hexGridMgr?.getHeightAt?.(dolly.position.x, dolly.position.z);
    if (Number.isFinite(groundY)) {
      dolly.position.y = groundY + eyeHeight;
      this.physics?.setCharacterPosition?.(dolly.position, eyeHeight);
    }

    this._gpsLastWorld.set(target.x, 0, target.z);
    this._gpsLastWorldValid = true;

    if (this._gpsFilter) {
      if (!this._gpsFilter.lastWorld) this._gpsFilter.lastWorld = new THREE.Vector3();
      this._gpsFilter.lastWorld.set(target.x, 0, target.z);
    }

    this._applyLocation({
      lat,
      lon,
      source,
      detail: { ...detailBase, skipOrigin: true, preserveManual: true, recenter: false }
    });

    this.hexGridMgr?.update?.(dolly.position);
    this._nextHexUpdateMs = 0;
  }

  _applyMotionHeadingFromVector(dx, dz, { minDistance = null } = {}) {
    if (!this._gpsLockEnabled) return;
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;

    // When compass/orientation is available, GPS should NOT control heading
    // When compass is NOT available, require 10m+ movement before orienting to GPS vector
    const hasCompass = this._mobileFPVOn && this.sensors?.orient?.ready;
    const defaultThreshold = hasCompass ? Infinity : 10.0; // 10 meters when no compass
    const threshold = Number.isFinite(minDistance) ? Math.max(0, minDistance) : defaultThreshold;

    const magnitudeSq = dx * dx + dz * dz;
    if (threshold > 0 && magnitudeSq < threshold * threshold) return;
    if (magnitudeSq < 1e-6) return;
    const heading = Math.atan2(dx, -dz);
    this._applyMotionHeading(heading);
  }

  _applyMotionHeading(headingRad) {
    if (!Number.isFinite(headingRad)) return;
    const renderer = this.sceneMgr?.renderer;
    if (renderer?.xr?.isPresenting) return;

    // PRIORITY: If we have compass/orientation controls active, don't let GPS override yaw
    if (this._mobileFPVOn && this.sensors?.orient?.ready) {
      // Compass/gyro is ground truth, GPS should not change orientation
      return;
    }

    const yaw = this._wrapAngle(headingRad + Math.PI);
    if (Number.isFinite(this._lastGpsHeading)) {
      const delta = Math.abs(this._wrapAngle(yaw - this._lastGpsHeading));
      if (delta < THREE.MathUtils.degToRad(0.35)) return;
    }

    const applied = this.move?.setExternalHeading?.(yaw);
    let headingApplied = applied === true;

    if (!headingApplied) {
      const dolly = this.sceneMgr?.dolly;
      if (!dolly) return;
      const euler = this._tmpEuler.set(0, yaw, 0, 'YXZ');
      dolly.rotation.set(0, yaw, 0);
      dolly.quaternion.setFromEuler(euler);
      dolly.updateMatrixWorld?.(true);
      headingApplied = true;
    }

    if (headingApplied) {
      this._lastGpsHeading = yaw;
    }
  }

  _handleMiniMapTeleport({ lat, lon } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this._handleGpsUpdate({
      lat,
      lon,
      source: 'manual',
      manual: true,
      teleport: true,
      force: true,
    });
  }

  /* ---------- Click teleport ---------- */

  _setupTeleportPointerHandler(retryDelayMs = 0) {
    if (this._teleportPointerHandler) return;
    const canvas = this.sceneMgr?.renderer?.domElement;
    if (!canvas) {
      if (retryDelayMs < 2000) {
        setTimeout(() => this._setupTeleportPointerHandler(retryDelayMs + 200), 200);
      }
      return;
    }
    this._teleportPointerHandler = (event) => this._maybeHandleTeleportPointer(event);
    canvas.addEventListener('pointerup', this._teleportPointerHandler, { passive: false });
  }

  _toggleTeleportClickMode(forceValue = null) {
    if (this._teleportTween) return;
    const next = forceValue == null ? !this._clickTeleportEnabled : !!forceValue;
    this._setTeleportClickEnabled(next);
  }

  _setTeleportClickEnabled(enabled) {
    const next = !!enabled && !this._teleportTween;
    if (next && this.input?.controls?.isLocked) {
      this.input.controls.unlock?.();
    }
    this._clickTeleportEnabled = next;
    this.move?.setTeleportBoostActive?.(next);
    if (next) {
      const now = performance?.now ? performance.now() : Date.now();
      if (!this._teleportHintAt || now - this._teleportHintAt > 2500) {
        pushToast('Click terrain to teleport');
        this._teleportHintAt = now;
      }
    }
    this._syncTeleportButtonState();
  }

  _syncTeleportButtonState() {
    const btn = ui.hudTeleportToggle;
    if (!btn) return;
    const active = this._clickTeleportEnabled;
    const busy = !!this._teleportTween;
    btn.classList.toggle('on', active && !busy);
    btn.classList.toggle('busy', busy);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.disabled = busy;
    btn.textContent = busy ? 'Teleporting…' : (active ? 'Teleport (On)' : 'Teleport');
    if (busy) {
      btn.title = 'Teleport in progress';
    } else if (active) {
      btn.title = 'Click on terrain to teleport';
    } else {
      btn.title = 'Toggle click-to-teleport mode';
    }
  }

  _maybeHandleTeleportPointer(event) {
    if (!this._clickTeleportEnabled || this._teleportTween) return;
    const renderer = this.sceneMgr?.renderer;
    if (renderer?.xr?.isPresenting) return;
    if (event.button != null && event.pointerType !== 'touch' && event.button !== 0) return;
    const canvas = event.currentTarget || renderer?.domElement;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    const ndc = {
      x: ((event.clientX - rect.left) / rect.width) * 2 - 1,
      y: -((event.clientY - rect.top) / rect.height) * 2 + 1,
    };
    event.preventDefault();
    event.stopPropagation();
    this._executeTeleportRaycast(ndc);
  }

  _executeTeleportRaycast(ndc) {
    const camera = this.sceneMgr?.camera;
    if (!camera || !this._raycaster) return;
    const targets = this._collectTerrainRaycastTargets();
    if (!targets.length) {
      pushToast('Terrain not ready for teleport');
      return;
    }
    this._raycaster.setFromCamera(ndc, camera);
    const hits = this._raycaster.intersectObjects(targets, true);
    if (!hits || !hits.length) {
      pushToast('No terrain under cursor');
      return;
    }
    const hit = hits[0];
    const origin = this.hexGridMgr?.origin;
    const latLon = origin ? worldToLatLon(hit.point.x, hit.point.z, origin.lat, origin.lon) : null;
    this._beginTeleportTween(hit.point, latLon);
  }

  _collectTerrainRaycastTargets() {
    const tm = this.hexGridMgr;
    if (!tm?.tiles) return [];
    const out = this._teleportRayTargets;
    out.length = 0;
    for (const tile of tm.tiles.values()) {
      const mesh = tile?.grid?.mesh;
      if (mesh) out.push(mesh);
    }
    return out;
  }

  _beginTeleportTween(hitPoint, latLon) {
    if (!hitPoint) return;
    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return;
    const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
    const start = dolly.position.clone();
    const target = hitPoint.clone();
    let ground = this.hexGridMgr?.getHeightAt?.(target.x, target.z);
    if (!Number.isFinite(ground)) ground = target.y - eyeHeight;
    if (!Number.isFinite(ground)) ground = start.y - eyeHeight;
    target.y = ground + eyeHeight;
    const distance = start.distanceTo(target);
    if (!Number.isFinite(distance) || distance < 0.25) {
      pushToast(distance < 0.25 ? 'Already at that spot' : 'Teleport failed');
      return;
    }
    const durationMs = THREE.MathUtils.clamp(distance / 2.6, 0.9, 5.0) * 1000;
    this._teleportTween = {
      start,
      end: target,
      latLon,
      startTime: performance?.now ? performance.now() : Date.now(),
      duration: durationMs,
    };
    this.move?.setTeleportBoostActive?.(false);
    this._enterTeleportMeditation(true);
    this._syncTeleportButtonState();
  }

  _updateTeleportTween(nowMs, eyeHeight) {
    const tween = this._teleportTween;
    const dolly = this.sceneMgr?.dolly;
    if (!tween || !dolly) return;
    const duration = Math.max(16, tween.duration);
    const elapsed = nowMs - tween.startTime;
    const progress = THREE.MathUtils.clamp(elapsed / duration, 0, 1);
    const eased = this._easeInOut(progress);
    const target = this._tmpVecTeleport.lerpVectors(tween.start, tween.end, eased);
    let ground = this.hexGridMgr?.getHeightAt?.(target.x, target.z);
    if (!Number.isFinite(ground)) ground = target.y - eyeHeight;
    target.y = ground + eyeHeight;
    dolly.position.copy(target);
    this.physics?.setCharacterPosition?.(dolly.position, eyeHeight);
    if (progress >= 0.999) {
      this._finishTeleportTween();
    }
  }

  _finishTeleportTween() {
    const tween = this._teleportTween;
    this._teleportTween = null;
    this._enterTeleportMeditation(false);
    if (tween?.latLon && Number.isFinite(tween.latLon.lat) && Number.isFinite(tween.latLon.lon)) {
      this.miniMap?.notifyLocationChange?.({
        lat: tween.latLon.lat,
        lon: tween.latLon.lon,
        source: 'manual',
        detail: { teleport: true }
      });
    }
    this._poseDirty = true;
    this._poseSaveTimer = 0;
    if (this._clickTeleportEnabled) {
      this.move?.setTeleportBoostActive?.(true);
    }
    this._syncTeleportButtonState();
  }

  _enterTeleportMeditation(active) {
    if (this._teleportMeditating === !!active) return;
    this._teleportMeditating = !!active;
    if (active) this.localAvatar?.setManualState?.('Meditate');
    else this.localAvatar?.clearManualState?.('Meditate');
  }

  _easeInOut(t) {
    const clamped = THREE.MathUtils.clamp(t, 0, 1);
    return clamped < 0.5
      ? 2 * clamped * clamped
      : 1 - Math.pow(-2 * clamped + 2, 2) / 2;
  }

  _snapToCompassHeading(explicitHeadingRad = null) {
    const heading = Number.isFinite(explicitHeadingRad) ? explicitHeadingRad : this.sensors?.headingRad;
    if (!Number.isFinite(heading)) return false;

    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return false;

    // Instantly rotate dolly to compass heading
    // Negate: compass and dolly use opposite rotation directions
    dolly.rotation.set(0, -heading, 0);

    // Force sensors to re-align so gyro continues from this heading
    this.sensors?.forceCompassAlign?.();

    return true;
  }

  _resetPlayerPosition() {
    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return;
    const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
    const groundY = this.hexGridMgr?.getHeightAt?.(0, 0) ?? 0;
    dolly.position.set(0, groundY + eyeHeight, 0);
    this.physics?.setCharacterPosition?.(dolly.position, eyeHeight);
  }

  buildTeleportOffer(offsetMeters = 2.5) {
    const dolly = this.sceneMgr?.dolly;
    const origin = this.hexGridMgr?.origin;
    if (!dolly || !origin) return null;

    const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(dolly.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const offset = Number.isFinite(offsetMeters) ? offsetMeters : 2.5;

    const landing = dolly.position.clone();
    const groundHere = this.hexGridMgr?.getHeightAt(dolly.position.x, dolly.position.z);
    const baseGround = Number.isFinite(groundHere) ? groundHere : (landing.y - eyeHeight);
    landing.y = baseGround;
    landing.addScaledVector(forward, offset);

    const landingGround = this.hexGridMgr?.getHeightAt(landing.x, landing.z);
    const groundVal = Number.isFinite(landingGround) ? landingGround : baseGround;

    const latLon = worldToLatLon(landing.x, landing.z, origin.lat, origin.lon);
    if (!latLon) return null;

    const yaw = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ').y;

    return {
      lat: +latLon.lat.toFixed(7),
      lon: +latLon.lon.toFixed(7),
      yaw: +yaw.toFixed(6),
      ground: +groundVal.toFixed(4),
      eye: +eyeHeight.toFixed(3),
      offset: +offset.toFixed(2),
      ts: Date.now()
    };
  }

  applyTeleportArrival(dest = {}, fromPub = null) {
    const lat = Number(dest.lat);
    const lon = Number(dest.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;

    const yaw = Number(dest.yaw);
    const eye = Number.isFinite(dest.eye) ? dest.eye : (this.move?.eyeHeight?.() ?? 1.6);
    const ground = Number(dest.ground);

    if (!this.sceneMgr?.dolly || !this.hexGridMgr) return false;

    this._handleGpsUpdate({ lat, lon, source: 'manual', force: true, manual: true });

    let completed = false;
    let attempts = 0;
    const alignOnce = () => {
      const origin = this.hexGridMgr?.origin;
      const dolly = this.sceneMgr?.dolly;
      if (!origin || !dolly) return false;
      const world = latLonToWorld(lat, lon, origin.lat, origin.lon);
      if (!world) return false;

      const groundHeight = Number.isFinite(ground)
        ? ground
        : this.hexGridMgr?.getHeightAt(world.x, world.z);
      const baseGround = Number.isFinite(groundHeight) ? groundHeight : (this.hexGridMgr?.getHeightAt?.(0, 0) ?? 0);

      dolly.position.set(world.x, baseGround + eye, world.z);
      const yawVal = Number.isFinite(yaw) ? yaw : dolly.rotation.y;
      dolly.rotation.set(0, yawVal, 0);
      dolly.quaternion.setFromEuler(new THREE.Euler(0, yawVal, 0, 'YXZ'));
      this._pitch = 0;
      this.sceneMgr.camera.quaternion.identity();
      this.sceneMgr.camera.rotation.set(0, 0, 0);
      this.sceneMgr.camera.up.set(0, 1, 0);
      this.physics?.setCharacterPosition?.(dolly.position, eye);
      this.hexGridMgr?.update(dolly.position);

      this._poseStoredState = null;
      this._poseLatestState = null;
      this._poseDirty = true;
      this._poseSaveTimer = 0;
      this._poseRestored = false;
      this._pendingPoseRestore = null;

      if (fromPub && this.mesh?.markTeleportArrivalComplete) {
        const key = typeof fromPub === 'string' ? fromPub.toLowerCase() : fromPub;
        this.mesh.markTeleportArrivalComplete(key);
      }
      return true;
    };

    const attemptAlign = () => {
      if (completed) return;
      if (alignOnce()) {
        completed = true;
        return;
      }
      attempts += 1;
      if (attempts < 10) {
        requestAnimationFrame(attemptAlign);
      } else {
        completed = true;
        if (fromPub && this.mesh?.markTeleportFailed) {
          const key = typeof fromPub === 'string' ? fromPub.toLowerCase() : fromPub;
          this.mesh.markTeleportFailed(key, 'teleport timeout');
        }
      }
    };

    requestAnimationFrame(attemptAlign);
    return true;
  }

  _applyGpsLock(enabled, { forceRecenter = false } = {}) {
    const next = !!enabled;
    const prev = this._gpsLockEnabled;
    if (next !== prev) {
      this._gpsLockEnabled = next;
      this._storeGpsLockPref(this._gpsLockEnabled);
      if (!this._gpsLockEnabled && this._mobileNav) {
        this._mobileNav.active = false;
        this._mobileNav.initialized = false;
        this._mobileNav.velocity?.set?.(0, 0, 0);
      }
      if (!this._gpsLockEnabled) {
        this._gpsLastWorldValid = false;
        this._lastGpsHeading = null;
      }
    }

    this._syncGpsLockUI();

    if (this._gpsLockEnabled && this._lastAutoLocation && (forceRecenter || (next !== prev && this._gpsLockEnabled))) {
      this._handleGpsUpdate({
        ...this._lastAutoLocation,
        force: true,
        preserveManual: false,
      });
    }
  }

  _syncGpsLockUI() {
    if (ui.gpsLockToggle) ui.gpsLockToggle.checked = this._gpsLockEnabled;
    if (ui.hudGpsReckon) {
      const btn = ui.hudGpsReckon;
      btn.disabled = !hasGeolocation;
      btn.classList.toggle('on', this._gpsLockEnabled);
      btn.setAttribute('aria-pressed', this._gpsLockEnabled ? 'true' : 'false');
      btn.dataset.state = this._gpsLockEnabled ? 'on' : 'off';
      btn.textContent = 'GPS';
      btn.title = this._gpsLockEnabled
        ? 'GPS lock active — tap to release'
        : 'Tap to lock world to GPS';
    }
  }

  _storeManualLocation(lat, lon) {
    try {
      localStorage.setItem(MANUAL_LOCATION_KEY, JSON.stringify({ lat, lon }));
    } catch { /* ignore quota */ }
  }

  _clearManualLocation() {
    try { localStorage.removeItem(MANUAL_LOCATION_KEY); } catch { /* noop */ }
  }

  _loadStoredManualLocation() {
    try {
      const raw = localStorage.getItem(MANUAL_LOCATION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (Number.isFinite(parsed?.lat) && Number.isFinite(parsed?.lon)) return parsed;
    } catch { /* ignore */ }
    return null;
  }

  _storeGpsLockPref(enabled) {
    try {
      localStorage.setItem(GPS_LOCK_KEY, enabled ? '1' : '0');
    } catch { /* ignore quota */ }
  }

  _loadGpsLockPref() {
    try {
      const raw = localStorage.getItem(GPS_LOCK_KEY);
      if (raw == null) return null;
      return raw === '1';
    } catch {
      return null;
    }
  }

  _syncDebugUI() {
    if (!ui.hudDebugToggle) return;
    const on = !!this._debugMode;
    ui.hudDebugToggle.classList.toggle('on', on);
    ui.hudDebugToggle.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.hudDebugToggle.dataset.state = on ? 'on' : 'off';
    ui.hudDebugToggle.textContent = 'Debug';
    ui.hudDebugToggle.title = on ? 'Debug visuals enabled' : 'Show debug visuals';
  }

  _toggleWireframe() {
    this._wireframeMode = !this._wireframeMode;
    this.buildings?.setWireframe?.(this._wireframeMode);
    this._syncWireframeUI();
  }

  _syncWireframeUI() {
    if (!ui.hudWireframeToggle) return;
    const btn = ui.hudWireframeToggle;
    const on = !!this._wireframeMode;
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    btn.dataset.state = on ? 'on' : 'off';
    btn.textContent = on ? 'Wire (On)' : 'Wire (Off)';
    btn.title = on ? 'Wireframe mode active — surfaces hidden' : 'Toggle wireframe rendering';
  }

  _setupEnvironmentControls() {
    const {
      envInteractiveRing,
      envInteractiveRingValue,
      envVisualRing,
      envVisualRingValue,
      envFarfieldExtra,
      envFarfieldExtraValue,
      envFarfieldNearPad,
      envFarfieldNearPadValue,
      envFarfieldBudget,
      envFarfieldBudgetValue,
      envFarfieldBatch,
      envFarfieldBatchValue,
      envTileRadius,
      envTileRadiusValue,
      envTerrainApply,
      envTerrainAuto,
      envTerrainTargetFps,
      envTerrainTargetFpsValue,
      envBuildingRadius,
      envBuildingRadiusValue,
      envBuildingApply,
      envBuildingAuto,
      envBuildingTargetFps,
      envBuildingTargetFpsValue,
    } = ui;

    if (!envInteractiveRing || !envVisualRing) {
      this._syncTerrainControls = null;
      this._syncBuildingControls = null;
      this._syncEnvironmentTargets = null;
      return;
    }

    const setText = (el, text) => { if (el) el.textContent = text; };
    const setCurrent = (el, text, suffix = '') => {
      if (!el) return;
      const value = text != null ? text : '—';
      el.textContent = `(engine: ${value}${suffix})`;
    };

    const updateTerrainCurrent = (settings) => {
      if (!settings) return;
      setCurrent(envInteractiveRingCurrent, settings.interactiveRing);
      setCurrent(envVisualRingCurrent, settings.visualRing);
      setCurrent(envFarfieldExtraCurrent, settings.farfieldExtra);
      setCurrent(envFarfieldNearPadCurrent, settings.farfieldNearPad);
      setCurrent(envFarfieldBudgetCurrent, settings.farfieldCreateBudget);
      setCurrent(envFarfieldBatchCurrent, settings.farfieldBatchSize);
      setCurrent(envTileRadiusCurrent, settings.tileRadius, ' m');
    };
    this._updateTerrainCurrentDisplay = updateTerrainCurrent;

    const syncTerrainControls = () => {
      const settings = this.hexGridMgr?.getTerrainSettings?.();
      if (!settings) return;
      const interactive = Math.round(settings.interactiveRing ?? this.hexGridMgr?.INTERACTIVE_RING ?? 4);
      envInteractiveRing.value = interactive;
      setText(envInteractiveRingValue, interactive);
      envVisualRing.min = String(interactive + 1);
      const visual = Math.max(interactive + 1, Math.round(settings.visualRing ?? interactive + 2));
      envVisualRing.value = visual;
      setText(envVisualRingValue, visual);
      const farExtra = Math.max(1, Math.round(settings.farfieldExtra ?? this.hexGridMgr?.FARFIELD_EXTRA ?? 60));
      envFarfieldExtra.value = farExtra;
      setText(envFarfieldExtraValue, farExtra);
      const nearPad = Math.max(0, Math.round(settings.farfieldNearPad ?? this.hexGridMgr?.FARFIELD_NEAR_PAD ?? 6));
      envFarfieldNearPad.value = nearPad;
      setText(envFarfieldNearPadValue, nearPad);
      const budget = Math.max(1, Math.round(settings.farfieldCreateBudget ?? this.hexGridMgr?.FARFIELD_CREATE_BUDGET ?? 60));
      envFarfieldBudget.value = budget;
      setText(envFarfieldBudgetValue, budget);
      const batch = Math.max(1, Math.round(settings.farfieldBatchSize ?? this.hexGridMgr?.FARFIELD_BATCH_SIZE ?? 48));
      envFarfieldBatch.value = batch;
      setText(envFarfieldBatchValue, batch);
      if (envTileRadius) {
        const radius = Math.round(settings.tileRadius ?? this.hexGridMgr?.tileRadius ?? 100);
        envTileRadius.value = radius;
        setText(envTileRadiusValue, `${radius} m`);
      }
      updateTerrainCurrent(settings);
    };
    this._syncTerrainControls = syncTerrainControls;

    const updateBuildingCurrent = (settings) => {
      if (!settings) return;
      setCurrent(envBuildingRadiusCurrent, settings.radius, ' m');
    };
    this._updateBuildingCurrentDisplay = updateBuildingCurrent;

    const syncBuildingControls = () => {
      const settings = this.buildings?.getBuildingSettings?.();
      if (!settings) return;
      const radius = Math.round(settings.radius ?? this.buildings?.radius ?? 3000);
      envBuildingRadius.value = radius;
      setText(envBuildingRadiusValue, `${radius} m`);
      updateBuildingCurrent(settings);
    };
    this._syncBuildingControls = syncBuildingControls;

    const syncTargets = () => {
      const fps = Math.round(this._perf?.profile?.().targetFps ?? 60);
      if (envTerrainTargetFps) envTerrainTargetFps.value = fps;
      setText(envTerrainTargetFpsValue, `${fps} fps`);
      if (envBuildingTargetFps) envBuildingTargetFps.value = fps;
      setText(envBuildingTargetFpsValue, `${fps} fps`);
    };
    this._syncEnvironmentTargets = syncTargets;

    const handleInteractiveInput = () => {
      const val = Number(envInteractiveRing.value);
      setText(envInteractiveRingValue, val);
      envVisualRing.min = String(val + 1);
      if (Number(envVisualRing.value) < val + 1) {
        envVisualRing.value = val + 1;
      }
      setText(envVisualRingValue, envVisualRing.value);
      this._disableTerrainAuto();
      this._scheduleTerrainUpdate();
    };

    envInteractiveRing.addEventListener('input', handleInteractiveInput);
    envVisualRing.addEventListener('input', () => {
      setText(envVisualRingValue, envVisualRing.value);
      this._disableTerrainAuto();
      this._scheduleTerrainUpdate();
    });
    envFarfieldExtra?.addEventListener('input', () => {
      setText(envFarfieldExtraValue, envFarfieldExtra.value);
      this._disableTerrainAuto();
      this._scheduleTerrainUpdate();
    });
    envFarfieldNearPad?.addEventListener('input', () => {
      setText(envFarfieldNearPadValue, envFarfieldNearPad.value);
      this._disableTerrainAuto();
      this._scheduleTerrainUpdate();
    });
    envFarfieldBudget?.addEventListener('input', () => {
      setText(envFarfieldBudgetValue, envFarfieldBudget.value);
      this._disableTerrainAuto();
      this._scheduleTerrainUpdate();
    });
    envFarfieldBatch?.addEventListener('input', () => {
      setText(envFarfieldBatchValue, envFarfieldBatch.value);
      this._disableTerrainAuto();
      this._scheduleTerrainUpdate();
    });
    envTileRadius?.addEventListener('input', () => {
      setText(envTileRadiusValue, `${envTileRadius.value} m`);
      this._disableTerrainAuto();
      this._scheduleTerrainUpdate();
    });
    envBuildingRadius?.addEventListener('input', () => {
      setText(envBuildingRadiusValue, `${envBuildingRadius.value} m`);
      this._disableBuildingAuto();
      this._scheduleBuildingUpdate();
    });

    envTerrainApply?.addEventListener('click', () => {
      this._disableTerrainAuto();
      this._applyTerrainSettingsFromUi();
    });
    envTerrainAuto?.addEventListener('click', () => {
      const target = Number(envTerrainTargetFps?.value ?? this._perf?.profile?.().targetFps ?? 60);
      this._enableTerrainAuto(target);
    });
    envTerrainTargetFps?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      this._handleTargetFpsChange(val);
    });

    envBuildingApply?.addEventListener('click', () => {
      this._disableBuildingAuto();
      this._applyBuildingSettingsFromUi();
    });
    envBuildingAuto?.addEventListener('click', () => {
      const target = Number(envBuildingTargetFps?.value ?? this._perf?.profile?.().targetFps ?? 60);
      this._enableBuildingAuto(target);
    });
    envBuildingTargetFps?.addEventListener('input', (e) => {
      const val = Number(e.target.value);
      this._handleTargetFpsChange(val);
    });

    // Imagery vintage controls
    const { envImageryVintage, envImageryTimeline, envImageryTimelineLabel } = ui;
    if (envImageryVintage && envImageryTimeline) {
      // Populate versions when available from tile manager
      const populateImageryVersions = () => {
        const versions = this.hexGridMgr?._overlayVersions || [];
        if (versions.length === 0) {
          setTimeout(populateImageryVersions, 1000);
          return;
        }
        envImageryVintage.innerHTML = '';
        versions.forEach((v, i) => {
          const opt = document.createElement('option');
          opt.value = v.id;
          opt.textContent = v.label;
          envImageryVintage.appendChild(opt);
        });
        envImageryTimeline.max = String(versions.length - 1);
        envImageryTimeline.value = '0';
        const currentVersion = this.hexGridMgr?._overlayVersion || versions[0]?.id;
        envImageryVintage.value = currentVersion;
        const currentIdx = versions.findIndex(v => v.id === currentVersion);
        if (currentIdx >= 0) envImageryTimeline.value = String(currentIdx);
        if (envImageryTimelineLabel) envImageryTimelineLabel.textContent = versions[currentIdx >= 0 ? currentIdx : 0]?.label || '—';
      };
      setTimeout(populateImageryVersions, 500);

      envImageryTimeline.addEventListener('input', () => {
        const versions = this.hexGridMgr?._overlayVersions || [];
        const idx = parseInt(envImageryTimeline.value, 10);
        const v = versions[idx];
        if (!v) return;
        if (envImageryTimelineLabel) envImageryTimelineLabel.textContent = v.label;
        envImageryVintage.value = v.id;
        this.hexGridMgr?._applyOverlayVersion?.(v.id);
      });

      envImageryVintage.addEventListener('change', () => {
        const version = envImageryVintage.value;
        if (!version) return;
        this.hexGridMgr?._applyOverlayVersion?.(version);
        const versions = this.hexGridMgr?._overlayVersions || [];
        const idx = versions.findIndex(v => v.id === version);
        if (idx >= 0) {
          envImageryTimeline.value = String(idx);
          if (envImageryTimelineLabel) envImageryTimelineLabel.textContent = versions[idx].label;
        }
      });
    }

    syncTerrainControls();
    syncBuildingControls();
    syncTargets();
    this._syncEnvironmentAutoButtons();
  }

  _setupDiagnosticsControls() {
    if (!ui.diagPidApply) return;
    const current = this._perf?.profile?.();
    this._syncPidInputs(current, { force: true });
    ui.diagPidApply.addEventListener('click', () => {
      const snapshot = this._perf?.profile?.();
      const pid = snapshot?.pid || {};
      const read = (input, fallback) => {
        if (!input) return fallback;
        const raw = Number.parseFloat(input.value);
        return Number.isFinite(raw) ? raw : fallback;
      };
      this._perf?.setPidTuning?.({
        kp: read(ui.diagPidKp, pid.kp),
        ki: read(ui.diagPidKi, pid.ki),
        kd: read(ui.diagPidKd, pid.kd),
        gain: read(ui.diagPidGain, pid.gain),
        deadband: read(ui.diagPidDeadband, pid.deadband),
        smoothing: read(ui.diagPidSmoothing, pid.smoothing),
      });
      const updated = this._perf?.profile?.();
      this._updatePidDiagnostics(updated, { forceInputs: true });
    });
    ui.diagPidReset?.addEventListener('click', () => {
      this._perf?.resetPidState?.();
      const updated = this._perf?.profile?.();
      this._updatePidDiagnostics(updated, { forceInputs: true });
    });
  }

  _syncPidInputs(profile, { force = false } = {}) {
    if (!ui.diagPidKp) return;
    const pid = profile?.pid || {};
    const assign = (input, value) => {
      if (!input) return;
      if (!force && document.activeElement === input) return;
      if (Number.isFinite(value)) input.value = String(value);
    };
    assign(ui.diagPidKp, pid.kp);
    assign(ui.diagPidKi, pid.ki);
    assign(ui.diagPidKd, pid.kd);
    assign(ui.diagPidGain, pid.gain);
    assign(ui.diagPidDeadband, pid.deadband);
    assign(ui.diagPidSmoothing, pid.smoothing);
  }

  _updatePidDiagnostics(perfState, { forceInputs = false } = {}) {
    if (!ui.diagPidTargetFps) return;
    const pid = perfState?.pid || {};
    const format = (value, digits = 2) => (Number.isFinite(value) ? value.toFixed(digits) : '--');
    const setText = (el, value) => { if (el) el.textContent = value; };
    const target = perfState?.targetFps;
    setText(ui.diagPidTargetFps, Number.isFinite(target) ? `${Math.round(target)}` : '--');
    setText(ui.diagPidSmoothedFps, format(perfState?.smoothedFps, 2));
    setText(ui.diagPidError, format(pid.error, 2));
    setText(ui.diagPidIntegral, format(pid.integral, 2));
    setText(ui.diagPidDerivative, format(pid.derivative, 2));
    setText(ui.diagPidQuality, format(perfState?.quality, 3));
    this._syncPidInputs(perfState, { force: forceInputs });
  }

  _summarizeTerrain() {
    const tm = this.hexGridMgr;
    if (!tm) return null;
    return {
      interactiveRing: tm.INTERACTIVE_RING,
      visualRing: tm.VISUAL_RING,
      farfieldRing: tm.FARFIELD_RING,
      farfieldCreateBudget: tm.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: tm.FARFIELD_BATCH_SIZE,
      relaxIters: tm.RELAX_ITERS_PER_FRAME,
      relaxBudget: Number.isFinite(tm.RELAX_FRAME_BUDGET_MS)
        ? Number(tm.RELAX_FRAME_BUDGET_MS.toFixed?.(2) ?? tm.RELAX_FRAME_BUDGET_MS)
        : null,
      visualCreateBudget: tm.VISUAL_CREATE_BUDGET,
    };
  }

  _summarizeBuildings() {
    const build = this.buildings;
    if (!build) return null;
    return {
      frameBudget: build._frameBudgetMs,
      idleBudget: build._idleBudgetMs,
      mergeBudget: build._mergeBudgetMs,
      resnapBudget: build._resnapFrameBudgetMs,
      resnapInterval: build._resnapInterval,
      radius: build.radius,
      quality: build._currentPerfQuality,
    };
  }

  _setupCharacterControls() {
    if (!ui.charFlipForward || !ui.charFlipStrafe || !ui.charFlipYaw) return;
    const bind = (el, axis) => {
      el.addEventListener('change', () => {
        const value = el.checked ? -1 : 1;
        const next = { ...this._signConfig, [axis]: value };
        this._setSignFlips(next, { persist: true });
      });
    };
    bind(ui.charFlipForward, 'forward');
    bind(ui.charFlipStrafe, 'strafe');
    bind(ui.charFlipYaw, 'yaw');
    this._syncSignFlipControls();
  }

  _populateDeviceInfo() {
    const nav = typeof navigator !== 'undefined' ? navigator : null;
    const uaData = nav?.userAgentData;
    const brand = uaData?.brands?.map((b) => `${b.brand} ${b.version}`).join(', ');
    const ua = nav?.userAgent || 'unknown';
    const platform = uaData?.platform || nav?.platform || 'unknown';
    const res = `${window.innerWidth}×${window.innerHeight} @${(window.devicePixelRatio || 1).toFixed(2)}x`;
    if (ui.overviewBrowser) ui.overviewBrowser.textContent = brand || ua.split(' ')[0] || 'unknown';
    if (ui.overviewPlatform) ui.overviewPlatform.textContent = platform;
    if (ui.overviewResolution) ui.overviewResolution.textContent = res;
    if (ui.overviewUserAgent) ui.overviewUserAgent.textContent = ua;
  }

  _syncEnvironmentAutoButtons() {
    if (ui.envTerrainAuto) {
      ui.envTerrainAuto.classList.toggle('on', !!this._terrainAuto);
      ui.envTerrainAuto.setAttribute('aria-pressed', this._terrainAuto ? 'true' : 'false');
      ui.envTerrainAuto.dataset.state = this._terrainAuto ? 'on' : 'off';
      ui.envTerrainAuto.textContent = this._terrainAuto ? 'Auto (On)' : 'Auto (Off)';
    }
    if (ui.envBuildingAuto) {
      ui.envBuildingAuto.classList.toggle('on', !!this._buildingAuto);
      ui.envBuildingAuto.setAttribute('aria-pressed', this._buildingAuto ? 'true' : 'false');
      ui.envBuildingAuto.dataset.state = this._buildingAuto ? 'on' : 'off';
      ui.envBuildingAuto.textContent = this._buildingAuto ? 'Auto (On)' : 'Auto (Off)';
    }
  }

  _loadSignFlips() {
    try {
      const raw = localStorage.getItem('NKN_SIGN_FLIPS_V1');
      if (!raw) return { forward: 1, strafe: 1, yaw: 1 };
      const parsed = JSON.parse(raw);
      const norm = (v) => (v === -1 ? -1 : 1);
      return {
        forward: norm(parsed.forward),
        strafe: norm(parsed.strafe),
        yaw: norm(parsed.yaw)
      };
    } catch {
      return { forward: 1, strafe: 1, yaw: 1 };
    }
  }

  _storeSignFlips() {
    try {
      localStorage.setItem('NKN_SIGN_FLIPS_V1', JSON.stringify(this._signConfig));
    } catch { /* ignore quota */ }
  }

  _setSignFlips(next, { persist = false } = {}) {
    if (!next) return;
    const norm = (v) => (v === -1 ? -1 : 1);
    this._signConfig = {
      forward: norm(next.forward ?? this._signConfig.forward ?? 1),
      strafe: norm(next.strafe ?? this._signConfig.strafe ?? 1),
      yaw: norm(next.yaw ?? this._signConfig.yaw ?? 1),
    };
    this.move?.setSignConfig?.(this._signConfig);
    if (persist) this._storeSignFlips();
    this._syncSignFlipControls();
  }

  _syncSignFlipControls() {
    if (!ui.charFlipForward || !ui.charFlipStrafe || !ui.charFlipYaw) return;
    ui.charFlipForward.checked = (this._signConfig.forward ?? 1) === -1;
    ui.charFlipStrafe.checked = (this._signConfig.strafe ?? 1) === -1;
    ui.charFlipYaw.checked = (this._signConfig.yaw ?? 1) === -1;
  }

  _collectTerrainSettingsFromUi() {
    const interactive = Number(ui.envInteractiveRing?.value ?? this.hexGridMgr?.INTERACTIVE_RING ?? 4);
    const visualRaw = Number(ui.envVisualRing?.value ?? this.hexGridMgr?.VISUAL_RING ?? interactive + 2);
    const visual = Math.max(interactive + 1, visualRaw);
    const farExtra = Math.max(1, Number(ui.envFarfieldExtra?.value ?? this.hexGridMgr?.FARFIELD_EXTRA ?? 60));
    const nearPad = Math.max(0, Number(ui.envFarfieldNearPad?.value ?? this.hexGridMgr?.FARFIELD_NEAR_PAD ?? 6));
    const budget = Math.max(1, Number(ui.envFarfieldBudget?.value ?? this.hexGridMgr?.FARFIELD_CREATE_BUDGET ?? 60));
    const batch = Math.max(1, Number(ui.envFarfieldBatch?.value ?? this.hexGridMgr?.FARFIELD_BATCH_SIZE ?? 48));
    const tileRadius = Math.max(10, Number(ui.envTileRadius?.value ?? this.hexGridMgr?.tileRadius ?? 100));
    return {
      interactiveRing: interactive,
      visualRing: visual,
      farfieldExtra: farExtra,
      farfieldNearPad: nearPad,
      farfieldCreateBudget: budget,
      farfieldBatchSize: batch,
      tileRadius,
    };
  }

  _applyTerrainSettingsFromUi({ auto = false } = {}) {
    if (!this.hexGridMgr?.updateTerrainSettings) return;
    if (this._terrainUpdateTimer) {
      clearTimeout(this._terrainUpdateTimer);
      this._terrainUpdateTimer = null;
    }
    const config = this._collectTerrainSettingsFromUi();
    this.hexGridMgr.updateTerrainSettings(config);
    if (!auto) this._terrainAuto = false;
    this._syncEnvironmentAutoButtons();
    const settings = this.hexGridMgr.getTerrainSettings?.();
    if (settings) this._updateTerrainCurrentDisplay?.(settings);
    this._syncTerrainControls?.();
    this._syncBuildingControls?.();
    const profile = this._perf?.profile?.();
    const summary = this._summarizeTerrain();
    if (summary) this._perfSnapshots.tiles = summary;
    if (profile) {
      this._updateHudMeta(profile);
      this._updatePidDiagnostics(profile);
    }
  }

  _enableTerrainAuto(targetFps) {
    if (!this.hexGridMgr?.resetTerrainSettings) return;
    this.hexGridMgr.resetTerrainSettings();
    this._perf?.setSubsystemAuto?.('terrain', true);
    const profile = this._perf?.profile?.();
    if (profile) {
      const summary = this._perf?.applySubsystem?.('terrain', { force: true, profile });
      if (summary) this._perfSnapshots.tiles = summary;
      this._updateHudMeta(profile);
      this._updatePidDiagnostics(profile);
    }
    this._terrainAuto = true;
    this._syncTerrainControls?.();
    this._updateTerrainCurrentDisplay?.(this.hexGridMgr?.getTerrainSettings?.());
    this._syncEnvironmentAutoButtons();
    this._syncEnvironmentTargets?.();
    this._handleTargetFpsChange(targetFps);
  }

  _collectBuildingSettingsFromUi() {
    const radius = Math.max(200, Number(ui.envBuildingRadius?.value ?? this.buildings?.radius ?? 3000));
    return { radius };
  }

  _applyBuildingSettingsFromUi({ auto = false } = {}) {
    if (!this.buildings?.updateBuildingSettings) return;
    if (this._buildingUpdateTimer) {
      clearTimeout(this._buildingUpdateTimer);
      this._buildingUpdateTimer = null;
    }
    const settings = this._collectBuildingSettingsFromUi();
    this.buildings.updateBuildingSettings(settings);
    if (!auto) this._buildingAuto = false;
    this._syncEnvironmentAutoButtons();
    this._updateBuildingCurrentDisplay?.(this.buildings?.getBuildingSettings?.());
    this._syncBuildingControls?.();
    const profile = this._perf?.profile?.();
    const summary = this._summarizeBuildings();
    if (summary) this._perfSnapshots.buildings = summary;
    if (profile) {
      this._updateHudMeta(profile);
      this._updatePidDiagnostics(profile);
    }
  }

  _enableBuildingAuto(targetFps) {
    if (!this.buildings?.resetBuildingSettings) return;
    this.buildings.resetBuildingSettings();
    this._perf?.setSubsystemAuto?.('buildings', true);
    const profile = this._perf?.profile?.();
    if (profile) {
      const summary = this._perf?.applySubsystem?.('buildings', { force: true, profile });
      if (summary) this._perfSnapshots.buildings = summary;
      this._updateHudMeta(profile);
      this._updatePidDiagnostics(profile);
    }
    this._buildingAuto = true;
    this._syncBuildingControls?.();
    this._updateBuildingCurrentDisplay?.(this.buildings?.getBuildingSettings?.());
    this._syncEnvironmentAutoButtons();
    this._syncEnvironmentTargets?.();
    this._handleTargetFpsChange(targetFps);
  }

  _disableTerrainAuto() {
    if (!this._terrainAuto) return;
    this._terrainAuto = false;
    this._perf?.setSubsystemAuto?.('terrain', false);
    this._syncEnvironmentAutoButtons();
  }

  _disableBuildingAuto() {
    if (!this._buildingAuto) return;
    this._buildingAuto = false;
    this._perf?.setSubsystemAuto?.('buildings', false);
    this._syncEnvironmentAutoButtons();
  }

  _scheduleTerrainUpdate() {
    if (this._terrainUpdateTimer) clearTimeout(this._terrainUpdateTimer);
    this._terrainUpdateTimer = setTimeout(() => {
      this._terrainUpdateTimer = null;
      this._applyTerrainSettingsFromUi();
    }, 150);
  }

  _scheduleBuildingUpdate() {
    if (this._buildingUpdateTimer) clearTimeout(this._buildingUpdateTimer);
    this._buildingUpdateTimer = setTimeout(() => {
      this._buildingUpdateTimer = null;
      this._applyBuildingSettingsFromUi();
    }, 150);
  }

  _handleTargetFpsChange(value) {
    const fps = Number.isFinite(value) ? Math.max(1, Math.round(value)) : 60;
    this._perf?.setTargetFps?.(fps);
    if (ui.envTerrainTargetFps) ui.envTerrainTargetFps.value = fps;
    if (ui.envTerrainTargetFpsValue) ui.envTerrainTargetFpsValue.textContent = `${fps} fps`;
    if (ui.envBuildingTargetFps) ui.envBuildingTargetFps.value = fps;
    if (ui.envBuildingTargetFpsValue) ui.envBuildingTargetFpsValue.textContent = `${fps} fps`;
    const profile = this._perf?.profile?.();
    if (profile) this._updatePidDiagnostics(profile);
  }

  _refreshEnvironmentTerrainSummary() {
    const settings = this.hexGridMgr?.getTerrainSettings?.();
    if (settings) this._updateTerrainCurrentDisplay?.(settings);
    if (this._terrainAuto) this._syncTerrainControls?.();
  }

  _refreshEnvironmentBuildingSummary() {
    const settings = this.buildings?.getBuildingSettings?.();
    if (settings) this._updateBuildingCurrentDisplay?.(settings);
    if (this._buildingAuto) this._syncBuildingControls?.();
  }

  _toggleHudUserList() {
    this._hudUserListVisible = !this._hudUserListVisible;
    this._syncHudUserListVisibility();
  }

  _syncHudUserListVisibility() {
    if (!ui.hudUserPanel || !ui.hudUsersToggle) return;
    const visible = !!this._hudUserListVisible;
    ui.hudUserPanel.hidden = !visible;
    ui.hudUsersToggle.setAttribute('aria-expanded', visible ? 'true' : 'false');
    ui.hudUsersToggle.textContent = visible ? 'Users ▾' : 'Users ▸';
  }

  _loadFriendList() {
    try {
      const raw = localStorage.getItem('NKN_FRIENDS_V1');
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter((p) => typeof p === 'string');
    } catch { /* ignore */ }
    return [];
  }

  _storeFriendList() {
    try {
      localStorage.setItem('NKN_FRIENDS_V1', JSON.stringify(Array.from(this._friends)));
    } catch { /* noop */ }
  }

  isFriend(pub) {
    if (!pub) return false;
    return this._friends.has(pub.toLowerCase());
  }

  _toggleFriend(pub) {
    if (!pub) return;
    const key = pub.toLowerCase();
    if (this._friends.has(key)) this._friends.delete(key);
    else this._friends.add(key);
    this._storeFriendList();
    this.mesh?.sendStateSnapshot?.(key, { friend: this._friends.has(key) });
    if (this._lastHudUsers) this.updateHudUserList(this._lastHudUsers);
  }

  updateHudUserList(users = []) {
    this._lastHudUsers = Array.isArray(users) ? users.slice() : [];
    if (!ui.hudUserList) return;
    ui.hudUserList.innerHTML = '';
    const nowMs = Date.now();
    const sorted = [...this._lastHudUsers].sort((a, b) => {
      const aOnline = a.online ? 1 : 0;
      const bOnline = b.online ? 1 : 0;
      if (aOnline !== bOnline) return bOnline - aOnline;
      return (b.lastTs || 0) - (a.lastTs || 0);
    });
    for (const user of sorted) {
      const row = document.createElement('div');
      row.className = 'hud-user';
      const top = document.createElement('div');
      top.className = 'hud-user-top';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.textContent = user.alias || shortHex(user.pub || '', 6, 4);
      const statusSpan = document.createElement('span');
      statusSpan.className = 'status ' + (user.online ? 'online' : 'offline');
      statusSpan.textContent = user.online ? 'ONLINE' : 'OFFLINE';
      const hexSpan = document.createElement('span');
      hexSpan.className = 'hex';
      hexSpan.textContent = shortHex(user.pub || '', 6, 4);
      top.appendChild(nameSpan);
      top.appendChild(statusSpan);
      top.appendChild(hexSpan);
      row.appendChild(top);

      const info = document.createElement('div');
      info.className = 'hud-user-info';
      const parts = [];
      const agoMs = user.lastTs ? nowMs - user.lastTs : null;
      if (user.online) parts.push('live');
      if (agoMs != null) parts.push(user.online ? `seen ${fmtAgo(agoMs)} ago` : `last ${fmtAgo(agoMs)} ago`);
      const geo = user.geo;
      if (geo && geo.gh) parts.push(`gh ${geo.gh}`);
      else if (geo && Number.isFinite(geo.lat) && Number.isFinite(geo.lon)) {
        parts.push(`${geo.lat.toFixed(5)}, ${geo.lon.toFixed(5)}`);
      }
      if (user.incomingStatus === 'pending') parts.push('teleport request awaiting response');
      info.textContent = parts.join(' • ');
      row.appendChild(info);

      const actions = document.createElement('div');
      actions.className = 'hud-user-actions';
      const friendBtn = document.createElement('button');
      const isFriend = this.isFriend(user.pub);
      if (isFriend) row.classList.add('is-friend');
      friendBtn.className = 'friend' + (isFriend ? ' active' : '');
      friendBtn.textContent = isFriend ? 'Remove Friend' : 'Add Friend';
      friendBtn.addEventListener('click', () => this._toggleFriend(user.pub));
      actions.appendChild(friendBtn);

      const teleBtn = document.createElement('button');
      teleBtn.className = 'teleport';
      const pendingOut = user.outgoingStatus === 'pending';
      teleBtn.textContent = pendingOut ? 'Requested…' : 'Teleport';
      teleBtn.disabled = pendingOut || !user.online;
      teleBtn.addEventListener('click', () => this.mesh?.requestTeleport?.(user.pub));
      actions.appendChild(teleBtn);

      row.appendChild(actions);
      ui.hudUserList.appendChild(row);
    }
    this._syncHudUserListVisibility();
  }

  notifyTeleportToast(pub, entry) {
    if (!ui.teleportToastHost) return;
    const key = (pub || '').toLowerCase();
    if (!key) return;
    const status = entry?.status || null;
    if (status !== 'pending') {
      this._removeTeleportToast(key);
      return;
    }

    let toast = this._teleportToasts.get(key);
    const alias = this.mesh?._aliasFor?.(key) || shortHex(key, 6, 4);
    const bodyText = `Incoming teleport request from ${alias}`;

    if (!toast) {
      const node = document.createElement('div');
      node.className = 'teleport-toast';
      const header = document.createElement('div');
      header.className = 'teleport-header';
      header.textContent = 'Teleport Request';
      const body = document.createElement('div');
      body.className = 'teleport-body';
      const actions = document.createElement('div');
      actions.className = 'teleport-actions';
      const acceptBtn = document.createElement('button');
      acceptBtn.className = 'accept';
      acceptBtn.textContent = 'Accept';
      acceptBtn.addEventListener('click', () => {
        this.mesh?.respondTeleport?.(key, true);
        this._removeTeleportToast(key);
      });
      const declineBtn = document.createElement('button');
      declineBtn.className = 'decline';
      declineBtn.textContent = 'Decline';
      declineBtn.addEventListener('click', () => {
        this.mesh?.respondTeleport?.(key, false);
        this._removeTeleportToast(key);
      });
      actions.appendChild(acceptBtn);
      actions.appendChild(declineBtn);
      node.appendChild(header);
      node.appendChild(body);
      node.appendChild(actions);
      ui.teleportToastHost.appendChild(node);
      requestAnimationFrame(() => node.classList.add('show'));
      toast = { node, body };
      this._teleportToasts.set(key, toast);
    }

    if (toast.body) toast.body.textContent = bodyText;
  }

  _removeTeleportToast(key) {
    const toast = this._teleportToasts.get(key);
    if (!toast) return;
    const { node } = toast;
    const cleanup = () => {
      if (node.parentElement) node.parentElement.removeChild(node);
    };
    node.classList.remove('show');
    node.addEventListener('transitionend', cleanup, { once: true });
    this._teleportToasts.delete(key);
  }

  _applyDebugMode() {
    const on = !!this._debugMode;
    document.body?.classList?.toggle('debug-mode', on);
    if (on) {
      console.info('[debug] Debug mode enabled');
    }
    this._updateProcessLeaderboardVisibility();
  }

  _updateUiThemeBySun(forceAltitude = null) {
    let altitude = Number.isFinite(forceAltitude) ? forceAltitude : null;
    if (!Number.isFinite(altitude) && Number.isFinite(this.sceneMgr?.currentSunAltitude)) {
      altitude = this.sceneMgr.currentSunAltitude;
    }
    if (!Number.isFinite(altitude)) {
      if (!this._uiTheme) {
        this._uiTheme = 'night';
        document.body.classList.toggle('theme-day', false);
        document.body.classList.toggle('theme-twilight', false);
        document.body.classList.toggle('theme-night', true);
      }
      return;
    }
    let theme = 'night';
    if (altitude > 0.1) theme = 'day';
    else if (altitude > -0.3) theme = 'twilight';

    if (this._uiTheme === theme) return;
    this._uiTheme = theme;

    document.body.classList.toggle('theme-day', theme === 'day');
    document.body.classList.toggle('theme-night', theme === 'night');
    document.body.classList.toggle('theme-twilight', theme === 'twilight');
  }

  _initProcessLeaderboard() {
    if (this._processLeaderboardInit) return;
    this._processLeaderboardInit = true;
    if (ui.processReset) {
      ui.processReset.addEventListener('click', () => {
        this._perfLogger?.resetStats?.();
        this._processMetricsStore = { version: 2, updatedAt: Date.now(), items: {} };
        this._storeProcessMetrics();
        this._renderProcessLeaderboard([]);
        this._drawProcessGraph([]);
      });
    }
    this._updateProcessLeaderboardVisibility(true);
  }

  _updateProcessLeaderboardVisibility(force = false) {
    const section = ui.processLeaderboardSection;
    if (section) {
      section.style.display = this._debugMode ? '' : 'none';
    }
    if (!this._debugMode && !force) {
      const stats = this._perfLogger?.getProcessStats?.() || [];
      if (stats.length) this._persistProcessMetrics(stats);
    }
    if (this._debugMode || force) {
      this._processUi.nextUpdate = 0;
      this._processUi.nextPersist = 0;
      const stats = this._getProcessStatsForDisplay();
      this._renderProcessLeaderboard(stats);
      this._drawProcessGraph(stats);
      if (force) this._persistProcessMetrics(stats);
    }
  }

  _getProcessStatsForDisplay() {
    const live = this._perfLogger?.getProcessStats?.() || [];
    if (live.length) return live;
    const store = this._processMetricsStore;
    if (!store?.items) return [];
    const items = [];
    for (const [label, data] of Object.entries(store.items)) {
      if (!data) continue;
      const history = Array.isArray(data.history) ? data.history.slice() : [];
      items.push({
        label,
        avg: Number.isFinite(data.avg) ? data.avg : 0,
        max: Number.isFinite(data.max) ? data.max : 0,
        min: Number.isFinite(data.min) ? data.min : 0,
        last: Number.isFinite(data.last) ? data.last : (Number.isFinite(data.avg) ? data.avg : 0),
        samples: Number.isFinite(data.samples) ? data.samples : history.length,
        history: history.slice(-this._perfLogger?.historyLimit || 120),
      });
    }
    items.sort((a, b) => (b.avg || 0) - (a.avg || 0));
    return items;
  }

  _renderProcessLeaderboard(stats) {
    const host = ui.processCards;
    const empty = ui.processEmptyState;
    if (!host) return;
    if (!stats || !stats.length) {
      host.innerHTML = '';
      if (empty) empty.style.display = '';
      return;
    }

    const fragment = document.createDocumentFragment();
    const frameBudget = 1000 / (this._perf?.targetFps || 60);
    const palette = ['#4caf50', '#ff9800', '#29b6f6', '#f06292', '#ba68c8', '#8bc34a', '#ffb74d'];

    stats.slice(0, 8).forEach((stat, index) => {
      const usage = Math.max(0, Math.min(999, (stat.avg / frameBudget) * 100));
      const last = Number.isFinite(stat.last) ? stat.last : 0;
      const max = Number.isFinite(stat.max) ? stat.max : 0;
      const avg = Number.isFinite(stat.avg) ? stat.avg : 0;
      const min = Number.isFinite(stat.min) ? stat.min : 0;
      const history = Array.isArray(stat.history) ? stat.history : [];
      const recentWindow = history.length >= 2 ? history.slice(-5) : history;
      const recentAvg = recentWindow.length
        ? recentWindow.reduce((acc, val) => acc + val, 0) / recentWindow.length
        : avg;
      const trend = last - recentAvg;
      const usageText = `${usage.toFixed(1)}%`; // resource usage
      const trendText = `${trend >= 0 ? '+' : ''}${trend.toFixed(2)} ms`;

      const card = document.createElement('div');
      card.className = 'process-card';
      card.dataset.label = stat.label;

      const header = document.createElement('div');
      header.className = 'process-card__header';
      const title = document.createElement('span');
      title.className = 'process-card__title';
      title.textContent = stat.label;
      const usageEl = document.createElement('span');
      usageEl.className = 'process-card__usage';
      usageEl.textContent = `${usageText} • Δ ${trendText}`;
      usageEl.style.color = palette[index % palette.length];
      header.appendChild(title);
      header.appendChild(usageEl);
      card.appendChild(header);

      const metricsWrap = document.createElement('div');
      metricsWrap.className = 'process-card__metrics';
      const metrics = [
        { label: 'avg', value: `${avg.toFixed(2)} ms` },
        { label: 'last', value: `${last.toFixed(2)} ms` },
        { label: 'max', value: `${max.toFixed(2)} ms` },
        { label: 'min', value: `${min.toFixed(2)} ms` },
        { label: 'usage', value: usageText },
        { label: 'samples', value: `${stat.samples ?? history.length}` },
      ];

      metrics.forEach((metric) => {
        const metricEl = document.createElement('div');
        metricEl.className = 'process-card__metric';
        const labelEl = document.createElement('span');
        labelEl.className = 'tiny';
        labelEl.textContent = metric.label;
        const valueEl = document.createElement('span');
        valueEl.className = 'mono';
        valueEl.textContent = metric.value;
        metricEl.appendChild(labelEl);
        metricEl.appendChild(valueEl);
        metricsWrap.appendChild(metricEl);
      });

      card.appendChild(metricsWrap);
      fragment.appendChild(card);
    });

    host.replaceChildren(fragment);
    if (empty) empty.style.display = 'none';
  }

  _drawProcessGraph(stats) {
    const canvas = ui.processGraph;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const styleWidth = canvas.clientWidth || canvas.width || 480;
    const styleHeight = canvas.clientHeight || canvas.height || 240;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== styleWidth * dpr || canvas.height !== styleHeight * dpr) {
      canvas.width = styleWidth * dpr;
      canvas.height = styleHeight * dpr;
    }
    const drawWidth = canvas.width / dpr;
    const drawHeight = canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, drawWidth, drawHeight);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
    ctx.fillRect(0, 0, drawWidth, drawHeight);

    const palette = ['#4caf50', '#ff9800', '#29b6f6', '#f06292', '#ba68c8', '#8bc34a', '#ffb74d'];
    const padding = 24;
    const frameBudget = 1000 / (this._perf?.targetFps || 60);

    const hasData = stats.some((stat) => Array.isArray(stat.history) && stat.history.length);
    if (!hasData) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '14px Rajdhani, sans-serif';
      ctx.fillText('Metrics will populate as debug samples arrive.', padding, drawHeight / 2);
      return;
    }

    const longestHistory = stats.reduce((max, stat) => Math.max(max, Array.isArray(stat.history) ? stat.history.length : 0), 0);
    const approxSeconds = longestHistory / (this._perf?.targetFps || 60);

    let maxValue = frameBudget;
    stats.forEach((stat) => {
      if (!Array.isArray(stat.history)) return;
      stat.history.forEach((value) => {
        if (Number.isFinite(value) && value > maxValue) maxValue = value;
      });
    });
    if (maxValue <= 0) maxValue = 10;

    // Baseline (frame budget)
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    const baselineY = drawHeight - padding - (frameBudget / maxValue) * (drawHeight - padding * 2);
    ctx.beginPath();
    ctx.moveTo(padding, baselineY);
    ctx.lineTo(drawWidth - padding, baselineY);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '12px Rajdhani, sans-serif';
    ctx.fillText('Frame budget', padding + 6, Math.max(12, baselineY - 6));

    if (approxSeconds > 0.1) {
      const horizonText = approxSeconds >= 60
        ? `~${(approxSeconds / 60).toFixed(1)} min window`
        : `~${approxSeconds.toFixed(0)} s window`;
      const metricsWidth = ctx.measureText(horizonText).width;
      ctx.fillText(horizonText, drawWidth - padding - metricsWidth, padding + 4);
    }

    stats.slice(0, 5).forEach((stat, index) => {
      const history = Array.isArray(stat.history) ? stat.history : [];
      if (!history.length) return;
      const color = palette[index % palette.length];
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      const len = history.length;
      const maxPoints = Math.max(120, Math.floor((drawWidth - padding * 2) / 2));
      const step = Math.max(1, Math.ceil(len / maxPoints));
      const sampleCount = Math.ceil(len / step);
      for (let i = 0; i < sampleCount; i += 1) {
        const start = i * step;
        const end = Math.min(start + step, len);
        let sum = 0;
        let count = 0;
        for (let j = start; j < end; j += 1) {
          const val = history[j];
          if (Number.isFinite(val)) {
            sum += val;
            count += 1;
          }
        }
        const avgVal = count ? sum / count : 0;
        const position = sampleCount > 1 ? (i / (sampleCount - 1)) : 0;
        const x = padding + position * (drawWidth - padding * 2);
        const y = drawHeight - padding - (avgVal / maxValue) * (drawHeight - padding * 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    // Legend
    let legendX = padding;
    const legendY = padding - 8;
    stats.slice(0, 5).forEach((stat, index) => {
      const color = palette[index % palette.length];
      ctx.fillStyle = color;
      ctx.fillRect(legendX, legendY, 10, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillText(stat.label, legendX + 14, legendY + 9);
      legendX += ctx.measureText(stat.label).width + 40;
    });
  }

  _persistProcessMetrics(stats) {
    if (!stats || !stats.length) return;
    if (!this._processMetricsStore || this._processMetricsStore.version !== 2) {
      this._processMetricsStore = { version: 2, updatedAt: Date.now(), items: {} };
    }
    const store = this._processMetricsStore;
    store.items = store.items || {};
    stats.forEach((stat) => {
      store.items[stat.label] = {
        avg: stat.avg ?? 0,
        max: stat.max ?? 0,
        min: stat.min ?? 0,
        last: stat.last ?? 0,
        samples: stat.samples ?? 0,
        history: Array.isArray(stat.history) ? stat.history.slice(-this._perfLogger?.historyLimit || 120) : [],
      };
    });
    store.updatedAt = Date.now();
    this._storeProcessMetrics();
  }

  _loadProcessMetrics() {
    try {
      const raw = localStorage.getItem(PROCESS_METRICS_KEY);
      if (!raw) return { version: 2, updatedAt: 0, items: {} };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return { version: 2, updatedAt: 0, items: {} };
      if (parsed.version !== 2) return { version: 2, updatedAt: 0, items: {} };
      if (typeof parsed.items !== 'object' || parsed.items == null) parsed.items = {};
      return parsed;
    } catch {
      return { version: 2, updatedAt: 0, items: {} };
    }
  }

  _storeProcessMetrics() {
    try {
      if (!this._processMetricsStore) return;
      localStorage.setItem(PROCESS_METRICS_KEY, JSON.stringify(this._processMetricsStore));
    } catch {
      // ignore quota errors
    }
  }

  _updateProcessLeaderboard() {
    if (!this._debugMode) return;
    if (!ui.processCards) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now < (this._processUi.nextUpdate || 0)) return;
    this._processUi.nextUpdate = now + (this._processUi.redrawInterval || 750);
    const stats = this._getProcessStatsForDisplay();
    this._renderProcessLeaderboard(stats);
    this._drawProcessGraph(stats);
    if (now >= (this._processUi.nextPersist || 0)) {
      this._persistProcessMetrics(stats);
      this._processUi.nextPersist = now + (this._processUi.persistInterval || 4000);
    }
  }

  _storeDebugPref(enabled) {
    try {
      localStorage.setItem(DEBUG_STATE_KEY, enabled ? '1' : '0');
    } catch { /* ignore quota */ }
  }

  _loadDebugPref() {
    try {
      const raw = localStorage.getItem(DEBUG_STATE_KEY);
      if (raw == null) return false;
      return raw === '1';
    } catch {
      return false;
    }
  }

  _handleResetRequest() {
    try {
      const keepKeys = new Set([DEBUG_STATE_KEY]);
      const purge = [];
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (key && !keepKeys.has(key)) purge.push(key);
      }
      for (const key of purge) {
        try { localStorage.removeItem(key); } catch { /* ignore */ }
      }
    } catch { /* ignore */ }

    try { sessionStorage.clear(); } catch { /* ignore */ }

    location.reload();
  }

  _storeCompassPref(enabled) {
    try {
      localStorage.setItem(COMPASS_YAW_KEY, enabled ? '1' : '0');
    } catch { /* ignore quota */ }
  }

  _loadCompassPref() {
    try {
      const raw = localStorage.getItem(COMPASS_YAW_KEY);
      if (raw == null) return null;
      return raw === '1';
    } catch {
      return null;
    }
  }

  _initMobileTracking() {
    if (!hasGeolocation) return;
    try {
      this._geoWatchId = navigator.geolocation.watchPosition(
        (pos) => this._handleGeoWatch(pos),
        (err) => console.warn('[geo] watch failed', err?.message || err),
        { enableHighAccuracy: true, maximumAge: 500, timeout: 10000 }
      );
    } catch (err) {
      console.warn('[geo] watch error', err);
    }
  }

  _handleGeoWatch(position) {
    if (!position || !position.coords) return;
    const { latitude, longitude, accuracy, speed, heading } = position.coords;
    const detail = {
      lat: latitude,
      lon: longitude,
      accuracy,
      speed: Number.isFinite(speed) ? speed : undefined,
      heading: Number.isFinite(heading) ? heading : undefined,
      timestamp: position.timestamp,
      source: 'device',
      recenter: false,
      preserveManual: true,
      incremental: !!(this._mobileNav && this._mobileNav.initialized)
    };
    this._handleGpsUpdate(detail);
  }

  _updateMobileNavFromGps(detail = {}) {
    if (!this._mobileNav || !this.hexGridMgr?.origin) return;

    if (!this._gpsLockEnabled) {
      this._mobileNav.active = false;
      this._mobileNav.initialized = false;
      this._mobileNav.velocity?.set?.(0, 0, 0);
      return;
    }

    const nav = this._mobileNav;
    const { lat, lon } = detail;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const origin = this.hexGridMgr.origin;
    const world = latLonToWorld(lat, lon, origin.lat, origin.lon);
    if (!world) return;

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const dtGps = nav.initialized ? Math.max(0.016, (now - nav.lastGpsTs) / 1000) : 0;
    nav.lastGpsTs = now;

    let deltaWorld = null;
    if (nav.initialized) {
      deltaWorld = {
        dx: world.x - nav.positionWorld.x,
        dz: world.z - nav.positionWorld.z,
      };
    }

    if (!nav.initialized) {
      nav.positionWorld.set(world.x, 0, world.z);
      nav.predictedWorld.copy(nav.positionWorld);
      nav.velocity.set(0, 0, 0);
      nav.initialized = true;
    } else {
      const { dx = 0, dz = 0 } = deltaWorld || {};
      if (dtGps > 0) {
        const blend = 0.4;
        const targetVx = dx / dtGps;
        const targetVz = dz / dtGps;
        nav.velocity.x = nav.velocity.x * (1 - blend) + targetVx * blend;
        nav.velocity.z = nav.velocity.z * (1 - blend) + targetVz * blend;
      }
      nav.positionWorld.set(world.x, 0, world.z);
      nav.predictedWorld.copy(nav.positionWorld);
    }

    nav.active = true;
    nav.lastLatLon = { lat, lon };
    nav.speed = Number.isFinite(detail.speed) ? detail.speed : (nav.speed * 0.9);
    const headingRadFromDetail = Number.isFinite(detail.heading) ? THREE.MathUtils.degToRad(detail.heading) : null;
    if (Number.isFinite(headingRadFromDetail)) nav.headingRad = headingRadFromDetail;
    if (!Number.isFinite(nav.headingRad)) {
      const yawInfo = this.sensors.getYawPitch?.();
      if (yawInfo?.ready) nav.headingRad = yawInfo.yaw;
    }
    if (Number.isFinite(nav.speed) && Number.isFinite(nav.headingRad)) {
      const vx = nav.speed * Math.sin(nav.headingRad);
      const vz = -nav.speed * Math.cos(nav.headingRad);
      nav.velocity.x = nav.velocity.x * 0.6 + vx * 0.4;
      nav.velocity.z = nav.velocity.z * 0.6 + vz * 0.4;
    }
    nav.velocity.x = THREE.MathUtils.clamp(nav.velocity.x, -30, 30);
    nav.velocity.z = THREE.MathUtils.clamp(nav.velocity.z, -30, 30);
    nav.lastPredictTs = now;
    nav.accuracy = detail.accuracy ?? nav.accuracy;

    if (deltaWorld && detail?.source !== 'manual') {
      this._applyMotionHeadingFromVector(deltaWorld.dx, deltaWorld.dz, { minDistance: this._gpsHeadingMinMeters });
    }

    this._gpsLastWorld.set(nav.positionWorld.x, 0, nav.positionWorld.z);
    this._gpsLastWorldValid = true;

    this._locationState = { lat, lon };
    if (detail.source) this._locationSource = detail.source;
    if (detail.source !== 'manual') this._lastAutoLocation = { lat, lon, source: detail.source };

    this.miniMap?.notifyLocationChange?.({ lat, lon, source: detail.source || this._locationSource });
  }

  _updateMobileAutopilot(dt) {
    if (!isMobile || !this._mobileNav || !this._mobileNav.active || !this._gpsLockEnabled) return;
    if (this._locationSource === 'manual') return;
    const nav = this._mobileNav;
    if (!nav.initialized) return;

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const elapsed = Math.max(0, (now - (nav.lastPredictTs || now)) / 1000);
    nav.lastPredictTs = now;

    const motion = this.sensors.getAcceleration?.();
    if (motion?.ready) {
      nav.velocity.x += motion.ax * elapsed;
      nav.velocity.z += motion.az * elapsed;
      nav.velocity.x *= 0.95;
      nav.velocity.z *= 0.95;
    } else {
      nav.velocity.x *= 0.98;
      nav.velocity.z *= 0.98;
    }

    if (Number.isFinite(nav.speed) && Number.isFinite(nav.headingRad)) {
      const vx = nav.speed * Math.sin(nav.headingRad);
      const vz = -nav.speed * Math.cos(nav.headingRad);
      nav.velocity.x = nav.velocity.x * 0.85 + vx * 0.15;
      nav.velocity.z = nav.velocity.z * 0.85 + vz * 0.15;
    }

    if (!Number.isFinite(nav.velocity.x) || !Number.isFinite(nav.velocity.z)) {
      nav.velocity.set(0, 0, 0);
    }

    nav.velocity.x = THREE.MathUtils.clamp(nav.velocity.x, -30, 30);
    nav.velocity.z = THREE.MathUtils.clamp(nav.velocity.z, -30, 30);

    nav.predictedWorld.x += nav.velocity.x * elapsed;
    nav.predictedWorld.z += nav.velocity.z * elapsed;
    nav.predictedWorld.x = THREE.MathUtils.damp(nav.predictedWorld.x, nav.positionWorld.x, 0.5, elapsed);
    nav.predictedWorld.z = THREE.MathUtils.damp(nav.predictedWorld.z, nav.positionWorld.z, 0.5, elapsed);

    const dolly = this.sceneMgr.dolly;
    dolly.position.x = THREE.MathUtils.damp(dolly.position.x, nav.predictedWorld.x, 6, elapsed);
    dolly.position.z = THREE.MathUtils.damp(dolly.position.z, nav.predictedWorld.z, 6, elapsed);

    if (Number.isFinite(nav.velocity.x) && Number.isFinite(nav.velocity.z)) {
      const speedSq = nav.velocity.x * nav.velocity.x + nav.velocity.z * nav.velocity.z;
      if (speedSq > 1e-6) {
        nav.headingRad = Math.atan2(nav.velocity.x, -nav.velocity.z);
      }
    }

    this._applyMotionHeadingFromVector(nav.velocity.x, nav.velocity.z, {
      minDistance: this._gpsHeadingVelocityMin,
    });

    this._gpsLastWorld.set(dolly.position.x, 0, dolly.position.z);
    this._gpsLastWorldValid = true;

    if (this.hexGridMgr?.origin) {
      const fused = worldToLatLon(dolly.position.x, dolly.position.z, this.hexGridMgr.origin.lat, this.hexGridMgr.origin.lon);
      if (fused) nav.fusedLatLon = fused;
    }
  }

  /* ---------- Helpers ---------- */

  _collectPeerLocations() {
    const origin = this.hexGridMgr?.origin;
    if (!origin || !this.remotes?.map?.size) return [];
    const peers = [];
    for (const ent of this.remotes.map.values()) {
      const pos = ent?.avatar?.group?.position || ent?.targetPos;
      if (!pos) continue;
      const latLon = worldToLatLon(pos.x, pos.z, origin.lat, origin.lon);
      if (!latLon) continue;
      const label = typeof ent.pub === 'string'
        ? ent.pub.slice(0, 4).toUpperCase()
        : undefined;
      peers.push({ lat: latLon.lat, lon: latLon.lon, label });
      if (peers.length >= 24) break;
    }
    return peers;
  }

  _getMeshClient() {
    if (this._meshClientPromise) return this._meshClientPromise;

    this._meshClientPromise = new Promise((resolve, reject) => {
      const start = performance.now();
      const timeoutMs = 20000;

      const tryResolve = () => {
        if (performance.now() - start > timeoutMs) {
          this._meshClientPromise = null;
          reject(new Error('Mesh client unavailable'));
          return;
        }

        const mesh = this.mesh;
        if (!mesh) {
          requestAnimationFrame(tryResolve);
          return;
        }

        const client = mesh.client;
        if (!client) {
          setTimeout(tryResolve, 100);
          return;
        }

        if (client.addr) {
          resolve(client);
          return;
        }

        const timer = setTimeout(() => {
          this._meshClientPromise = null;
          reject(new Error('Mesh client connect timeout'));
        }, timeoutMs);

        const handleConnect = () => {
          clearTimeout(timer);
          resolve(client);
        };

        if (typeof client.onConnect === 'function') {
          client.onConnect(handleConnect);
        } else {
          // Fallback: polling
          const poll = () => {
            if (client.addr) {
              clearTimeout(timer);
              resolve(client);
            } else if (performance.now() - start > timeoutMs) {
              clearTimeout(timer);
              this._meshClientPromise = null;
              reject(new Error('Mesh client connect timeout'));
            } else {
              setTimeout(poll, 100);
            }
          };
          poll();
        }
      };

      tryResolve();
    }).catch((err) => {
      this._meshClientPromise = null;
      throw err;
    });

    return this._meshClientPromise;
  }

  _createCompassDial() {
    if (!this.sceneMgr?.camera) return null;
    const mount = new THREE.Group();
    mount.name = 'compass-dial-mount';
    mount.position.set(0, -0.85, -0.65);
    mount.rotation.x = THREE.MathUtils.degToRad(-28);
    mount.renderOrder = 999;

    const dial = new THREE.Group();
    dial.name = 'compass-dial';
    dial.renderOrder = 999;
    mount.add(dial);

    const radius = 1.2;
    const lineOpacity = 0.15;
    const majorMat = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      thickness: 2,
      roughness: 0.65,
      //metalness: 0,
      iridescence: 0.2,
      iridescenceIOR: 2.1,
      clearcoat: 0.1,
      clearcoatRoughness: 0.05,
    });
    const mediumMat = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      thickness: 2,
      roughness: 0.65,
      //metalness: 0,
      iridescence: 1,
      iridescenceIOR: 2.2,
      clearcoat: 0.1,
      clearcoatRoughness: 0.05,
    });
    const minorMat = new THREE.MeshPhysicalMaterial({
      transmission: 1,
      thickness: 2,
      roughness: 0.65,
      //metalness: 0,
      iridescence: 0.5,
      iridescenceIOR: 1.2,
      clearcoat: 0.1,
      clearcoatRoughness: 0.05,
    });

    for (let deg = 0; deg < 360; deg += 5) {
      const rad = THREE.MathUtils.degToRad(deg);
      const isMajor = deg % 30 === 0;
      const isMedium = !isMajor && deg % 10 === 0;
      const height = isMajor ? 0.25 : (isMedium ? 0.175 : 0.11);
      const width = isMajor ? 0.02 : 0.012;
      const mat = isMajor ? majorMat : (isMedium ? mediumMat : minorMat);
      const line = new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.008), mat);
      line.position.set(Math.sin(rad) * radius, height / 2, -Math.cos(rad) * radius);
      line.lookAt(0, height / 2, 0);
      line.renderOrder = 999;
      dial.add(line);

      if (isMajor) {
        const label = this._makeCompassLabel(`${deg}`, { color: '#9dc7ff', size: 0.1, fontSize: 70, weight: '500' });
        label.position.set(Math.sin(rad) * (radius + 0.1), height + 0.04, -Math.cos(rad) * (radius + 0.1));
        label.renderOrder = 1000;
        dial.add(label);
      }
    }

    const cardinals = [
      { text: 'N', deg: 0 },
      { text: 'E', deg: 90 },
      { text: 'S', deg: 180 },
      { text: 'W', deg: 270 },
    ];
    for (const { text, deg } of cardinals) {
      const rad = THREE.MathUtils.degToRad(deg);
      const label = this._makeCompassLabel(text, { color: '#ffffff', size: 0.18, fontSize: 96, weight: '700' });
      label.position.set(Math.sin(rad) * (radius + 0.18), 0.38, -Math.cos(rad) * (radius + 0.18));
      label.renderOrder = 1000;
      dial.add(label);
    }

    const readout = this._makeCompassLabel('000°', { color: '#ffffff', size: 0.04, fontSize: 50, weight: '600' });
    readout.position.set(0, 0.45, 0);
    readout.renderOrder = 1000;
    dial.add(readout);

    this.sceneMgr.camera.add(mount);

    return { mount, dial, readout };
  }

  _makeCompassLabel(text, { color = '#fff', size = 0.08, fontSize = 32, weight = '600' } = {}) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const padding = fontSize * 0.45;
    ctx.font = `${weight} ${fontSize}px sans-serif`;
    const metrics = ctx.measureText(text);
    canvas.width = Math.ceil(metrics.width + padding * 2);
    canvas.height = Math.ceil(fontSize + padding * 2);
    ctx.font = `${weight} ${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true;

    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.5, depthTest: false, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    const aspect = canvas.width / canvas.height;
    sprite.scale.set(size * aspect, size, 1);
    sprite.userData = {
      canvas,
      ctx,
      texture,
      color,
      font: `${weight} ${fontSize}px sans-serif`,
      padding,
      size,
      baseHeight: canvas.height,
    };
    sprite.userData.updateText = (value) => {
      const { canvas, ctx, texture, color, font, padding, size, baseHeight } = sprite.userData;
      ctx.font = font;
      const metrics = ctx.measureText(value);
      const desiredWidth = Math.ceil(metrics.width + padding * 2);
      const desiredHeight = baseHeight;
      if (canvas.width !== desiredWidth || canvas.height !== desiredHeight) {
        canvas.width = desiredWidth;
        canvas.height = desiredHeight;
      }
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = color;
      ctx.fillText(value, canvas.width / 2, canvas.height / 2);
      texture.needsUpdate = true;
      const aspect = canvas.width / canvas.height;
      sprite.scale.set(size * aspect, size, 1);
    };
    return sprite;
  }

  _wrapAngle(rad) {
    if (!Number.isFinite(rad)) return 0;
    return Math.atan2(Math.sin(rad), Math.cos(rad));
  }

  _wrapPi(rad) {
    return this._wrapAngle(rad);
  }

  _getCompassYawOffset() {
    if (!this._gpsLockEnabled || !this._compassEnabled || this._compassYawConfidence <= 0) return 0;
    return this._compassYawOffset;
  }

  _updateCompassDial() {
    if (!this._compassDial) return;
    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return;

    const renderer = this.sceneMgr?.renderer;
    let worldYaw = null;

    if (renderer?.xr?.isPresenting && typeof this.move?.getXRWorldYaw === 'function') {
      const yaw = this.move.getXRWorldYaw();
      if (Number.isFinite(yaw)) worldYaw = yaw;
    }

    if (worldYaw == null) {
      const forward = this._tmpCamForward;
      this.sceneMgr.camera.getWorldDirection(forward);
      forward.y = 0;
      if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
      forward.normalize();
      worldYaw = Math.atan2(forward.x, -forward.z);
    }

    const dialYaw = worldYaw;
    this._compassDial.rotation.set(0, dialYaw, 0);

    if (this._compassReadoutSprite?.userData?.updateText) {
      const headingDeg = (THREE.MathUtils.radToDeg(worldYaw) + 360) % 360;
      const rounded = Math.round(headingDeg);
      if (this._compassReadoutValue == null || Math.abs(this._compassReadoutValue - rounded) >= 1) {
        this._compassReadoutValue = rounded;
        const padded = `${rounded.toString().padStart(3, '0')}°`;
        this._compassReadoutSprite.userData.updateText(padded);
      }
    }
  }

  // Old, proven mapping: (beta, alpha, -gamma) YXZ then align device frame by Rx(-90°).
  // Optimized: reuse temp objects to avoid GC pressure
  _deviceQuatForFPV(orient) {
    const a = orient?.a || 0; // alpha (Z)
    const b = orient?.b || 0; // beta  (X)
    const g = orient?.g || 0; // gamma (Y)

    // Reuse existing temp euler and quaternion objects
    if (!this._deviceQuatFPVTempEuler) {
      this._deviceQuatFPVTempEuler = new THREE.Euler(0, 0, 0, 'YXZ');
      this._deviceQuatFPVTempQuat = new THREE.Quaternion();
      this._deviceQuatFPVRxMinus90 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -PI/2 about X
    }

    this._deviceQuatFPVTempEuler.set(RAD(b), RAD(a), RAD(-g), 'YXZ');
    this._deviceQuatFPVTempQuat.setFromEuler(this._deviceQuatFPVTempEuler);
    this._deviceQuatFPVTempQuat.multiply(this._deviceQuatFPVRxMinus90);
    return this._deviceQuatFPVTempQuat;
  }

  _enterMobileFPV() {
    if (this._mobileFPVOn) return;

    const oldCam = this.sceneMgr.camera;
    if (!(oldCam instanceof THREE.PerspectiveCamera)) {
      const cam = new THREE.PerspectiveCamera(75, oldCam.aspect || innerWidth / innerHeight, 0.05, 100000);
      cam.position.set(0, 0, 0);
      cam.rotation.set(0, 0, 0);
      try { this.sceneMgr.dolly.remove(oldCam); } catch { }
      this.sceneMgr.dolly.add(cam);
      this.sceneMgr.camera = cam;
    } else {
      oldCam.position.set(0, 0, 0);
      oldCam.rotation.set(0, 0, 0);
      oldCam.fov = 75;
      oldCam.updateProjectionMatrix();
    }

    this.chase.targetBoom = 0.0;
    this.chase.boom = 0.0;
    if (Number.isFinite(this.chase.defaultMinBoom)) {
      this.chase.minBoom = this.chase.defaultMinBoom;
    }
    if (Number.isFinite(this.chase.defaultMaxBoom)) {
      this.chase.maxBoom = this.chase.defaultMaxBoom;
    }

    this._mobileFPVOn = true;
  }

  /* ---------- UI ---------- */
  _formatAgo(tsMs) {
    if (!Number.isFinite(tsMs)) return 'n/a';
    const delta = Math.max(0, Date.now() - tsMs);
    if (delta < 2000) return `${(delta / 1000).toFixed(1)}s ago`;
    if (delta < 60000) return `${Math.round(delta / 1000)}s ago`;
    if (delta < 3600000) return `${Math.round(delta / 60000)}m ago`;
    return `${Math.round(delta / 3600000)}h ago`;
  }

  _qualityToPixelRatio(quality) {
    const bounds = this._pixelRatioBounds || { min: 0.55, max: 1 };
    const range = this._perfQualityRange || { min: 0.35, max: 1.05 };
    const minQ = Number.isFinite(range.min) ? range.min : 0.35;
    const maxQ = Number.isFinite(range.max) ? range.max : 1.05;
    const denom = Math.max(1e-3, maxQ - minQ);
    const q = Number.isFinite(quality) ? THREE.MathUtils.clamp(quality, minQ, maxQ) : maxQ;
    const t = THREE.MathUtils.clamp((q - minQ) / denom, 0, 1);
    if (!Number.isFinite(bounds.min) || !Number.isFinite(bounds.max)) return q;
    if (Math.abs(bounds.max - bounds.min) < 1e-3) return bounds.max;
    return THREE.MathUtils.lerp(bounds.min, bounds.max, t);
  }

  _setRendererPixelRatio(next, {
    force = false,
    reason = 'auto',
    degrade = false,
    upgrade = false,
  } = {}) {
    const renderer = this.sceneMgr?.renderer;
    if (!renderer) return { changed: false, applied: null, reason };

    const bounds = this._pixelRatioBounds || { min: 0.55, max: 1 };
    let target = Number.isFinite(next) ? next : bounds.max;
    target = THREE.MathUtils.clamp(target, Math.min(bounds.min, bounds.max), Math.max(bounds.min, bounds.max));

    const current = renderer.getPixelRatio ? renderer.getPixelRatio() : (this._pixelRatioApplied ?? target);
    const ratioEps = 0.015;

    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    this._pixelRatioTarget = target;

    if (renderer.xr?.isPresenting && !force) {
      return { changed: false, applied: current, reason: `${reason}-xr` };
    }

    if (!force && Math.abs(target - current) < ratioEps) {
      return { changed: false, applied: current, reason };
    }

    let width = window.innerWidth || 1;
    let height = window.innerHeight || 1;
    const canvas = renderer.domElement;
    if (canvas) {
      width = canvas.clientWidth || width;
      height = canvas.clientHeight || height;
    }

    renderer.setPixelRatio(target);
    renderer.setSize(Math.max(1, width), Math.max(1, height), false);

    this._pixelRatioApplied = target;
    this._pixelRatioLastChangeMs = now;
    if (canvas?.style) {
      canvas.style.setProperty('--render-scale', target.toFixed(3));
    }

    if (degrade) {
      this._pixelRatioState = 'degraded';
    } else if (upgrade) {
      this._pixelRatioState = 'high';
    }

    return { changed: Math.abs(target - current) >= ratioEps, applied: target, reason };
  }

  _applyRenderPerfProfile(profile = {}) {
    const renderer = this.sceneMgr?.renderer;
    if (!renderer) return null;

    const profileSnapshot = (this._perf && typeof this._perf.profile === 'function')
      ? this._perf.profile()
      : null;
    const quality = Number.isFinite(profile?.quality) ? profile.quality : profileSnapshot?.quality;
    let targetRatio = this._qualityToPixelRatio(quality);
    const xrOn = !!renderer.xr?.isPresenting;
    if (xrOn) targetRatio = Math.max(1, targetRatio);

    const aqm = profile?.aqm || {};
    const change = this._setRendererPixelRatio(targetRatio, {
      force: aqm.applyReason === 'force' || aqm.applyReason === 'periodic',
      reason: aqm.applyReason || 'auto',
      degrade: !!aqm.degrade,
      upgrade: !!aqm.upgrade,
    });

    return {
      pixelRatio: change.applied ?? renderer.getPixelRatio?.() ?? targetRatio,
      target: targetRatio,
      changed: change.changed,
      reason: change.reason,
    };
  }

  _refreshRendererPixelRatio() {
    const target = Number.isFinite(this._pixelRatioTarget) ? this._pixelRatioTarget : this._pixelRatioBounds?.max;
    this._setRendererPixelRatio(target, { force: true, reason: 'resize' });
  }

  _formatPerfLabel(perfState) {
    const pct = Math.round(THREE.MathUtils.clamp(perfState?.quality ?? 1, 0, 1.05) * 100);
    const level = perfState?.level ? perfState.level.charAt(0).toUpperCase() + perfState.level.slice(1) : 'Adaptive';
    return `LOD ${pct}% · ${level}`;
  }

  _formatPerfDetail(perfState, snapshots = {}) {
    const tileSnap = snapshots.tiles || {};
    const buildingSnap = snapshots.buildings || {};
    const renderSnap = snapshots.render || {};
    const tileNear = Number.isFinite(tileSnap.interactiveRing) ? tileSnap.interactiveRing : null;
    const tileFar = Number.isFinite(tileSnap.visualRing) ? tileSnap.visualRing : null;
    const buildBudget = Number.isFinite(buildingSnap.frameBudget) ? buildingSnap.frameBudget : null;
    const mergeBudget = Number.isFinite(buildingSnap.mergeBudget) ? buildingSnap.mergeBudget : null;
    const radiusMeters = Number.isFinite(buildingSnap.radius) ? Math.round(buildingSnap.radius) : null;
    const pixelRatio = Number.isFinite(renderSnap.pixelRatio) ? renderSnap.pixelRatio : null;

    const formatMs = (value) => (Number.isFinite(value) ? value.toFixed(2) : '--');

    return {
      tiles: `${tileNear != null ? tileNear : '--'} / ${tileFar != null ? tileFar : '--'}`,
      build: `${formatMs(buildBudget)} / ${formatMs(mergeBudget)} ms`,
      radius: radiusMeters != null ? `${radiusMeters} m` : '--',
      renderScale: pixelRatio != null ? `${pixelRatio.toFixed(2)}×` : '--',
    };
  }

  _updateHudMeta(perfState) {
    const detail = this._formatPerfDetail(perfState, this._perfSnapshots);
    if (!detail) return;

    const cached = this._hudMetaCached || {};

    if (ui.hudDetailTiles && detail.tiles !== cached.tiles) {
      ui.hudDetailTiles.textContent = detail.tiles;
    }

    if (ui.hudDetailBuild && detail.build !== cached.build) {
      ui.hudDetailBuild.textContent = detail.build;
    }

    if (ui.hudDetailRadius && detail.radius !== cached.radius) {
      ui.hudDetailRadius.textContent = detail.radius;
    }

    if (ui.hudDetailRender && detail.renderScale !== cached.renderScale) {
      ui.hudDetailRender.textContent = detail.renderScale;
    }

    this._hudMetaCached = { ...detail };
  }

  _updateHudCompass() {
    const needle = ui.hudCompassNeedle;
    const textEl = ui.hudHeadingText;
    const headingDeg = this.sensors?.headingDeg;
    const headingSource = this.sensors?.headingSource || 'unknown';
    const hasHeading = Number.isFinite(headingDeg);
    const rounded = hasHeading ? Math.round(headingDeg) : null;

    const changed =
      this._hudHeadingState?.deg !== rounded ||
      this._hudHeadingState?.source !== headingSource;
    if (!changed) return;

    this._hudHeadingState = { deg: rounded, source: headingSource };

    if (textEl) {
      textEl.textContent = hasHeading
        ? `${rounded.toString().padStart(3, '0')}°`
        : '--°';
      textEl.dataset.source = headingSource;
      textEl.title = hasHeading ? `Heading source: ${headingSource}` : 'Heading unavailable';
    }

    if (needle) {
      const rotation = hasHeading ? headingDeg : 0;
      needle.style.transform = `translateX(-50%) rotate(${rotation.toFixed(1)}deg)`;
      needle.style.opacity = hasHeading ? '1' : '0.35';
      needle.dataset.source = headingSource;
      needle.title = hasHeading ? `Heading source: ${headingSource}` : 'Heading unavailable';
    }
  }

  _setHudScaleVisible(visible) {
    const root = ui.hudScale;
    if (!root) return;
    if (visible) {
      if (!this._hudScaleVisible) {
        root.classList.remove('is-hidden');
        root.setAttribute('aria-hidden', 'false');
        this._hudScaleVisible = true;
      }
    } else if (this._hudScaleVisible || !root.classList.contains('is-hidden')) {
      root.classList.add('is-hidden');
      root.setAttribute('aria-hidden', 'true');
      this._hudScaleVisible = false;
    }
  }

  _projectHudScalePoint(worldVec, camera, renderer, outVec) {
    if (!worldVec || !camera || !renderer || !outVec) return null;
    const canvas = renderer.domElement;
    const width = (canvas?.clientWidth || canvas?.width || window.innerWidth || 0);
    const height = (canvas?.clientHeight || canvas?.height || window.innerHeight || 0);
    if (width <= 0 || height <= 0) return null;
    const projected = this._tmpScaleProject.copy(worldVec).project(camera);
    if (!Number.isFinite(projected.z) || projected.z < -1 || projected.z > 1) return null;
    const x = (projected.x * 0.5 + 0.5) * width;
    const y = (1 - (projected.y * 0.5 + 0.5)) * height;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    outVec.set(x, y);
    return outVec;
  }

  _updateHudScale({ groundY = null } = {}) {
    const track = ui.hudScaleTrack;
    const line1 = ui.hudScaleLine1;
    const line10 = ui.hudScaleLine10;
    const marker1 = ui.hudScaleMarker1;
    const marker10 = ui.hudScaleMarker10;
    if (!track || !line1 || !line10 || !marker1 || !marker10) return;

    const renderer = this.sceneMgr?.renderer;
    const camera = this.sceneMgr?.camera;
    const dolly = this.sceneMgr?.dolly;
    if (!renderer || !camera || !dolly || renderer.xr?.isPresenting) {
      this._setHudScaleVisible(false);
      return;
    }

    const forward = this._tmpScaleForward;
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();

    const right = this._tmpScaleRight;
    right.crossVectors(forward, this._upUnit);
    if (right.lengthSq() < 1e-6) {
      this._setHudScaleVisible(false);
      return;
    }
    right.normalize();

    const base = this._tmpScaleBase.copy(dolly.position);
    let ground = groundY;
    if (!Number.isFinite(ground)) {
      ground = this.hexGridMgr?.getHeightAt?.(base.x, base.z);
    }
    if (Number.isFinite(ground)) base.y = ground;

    const sampleDist = Math.max(4, Math.min(60, this.hexGridMgr?.tileRadius ?? 26));
    base.addScaledVector(forward, sampleDist);

    const point1 = this._tmpScaleOne.copy(base).addScaledVector(right, 1);
    const point10 = this._tmpScaleTen.copy(base).addScaledVector(right, 10);

    const screenBase = this._projectHudScalePoint(base, camera, renderer, this._tmpScaleScreenA);
    const screenOne = this._projectHudScalePoint(point1, camera, renderer, this._tmpScaleScreenB);
    const screenTen = this._projectHudScalePoint(point10, camera, renderer, this._tmpScaleScreenC);

    if (!screenBase || !screenOne || !screenTen) {
      this._setHudScaleVisible(false);
      return;
    }

    let width1 = Math.abs(screenOne.x - screenBase.x);
    let width10 = Math.abs(screenTen.x - screenBase.x);

    if (!Number.isFinite(width1) || !Number.isFinite(width10) || width1 <= 0 || width10 <= 0) {
      this._setHudScaleVisible(false);
      return;
    }

    if (width10 <= width1) {
      width10 = width1 * 10;
    }

    const maxWidth = 320;
    const minWidth = 4;
    if (width10 > maxWidth) {
      const scale = maxWidth / width10;
      width10 = maxWidth;
      width1 = Math.max(minWidth, width1 * scale);
    }

    if (width10 < minWidth || width1 < 0.5) {
      this._setHudScaleVisible(false);
      return;
    }

    const width1Px = width1.toFixed(2);
    const width10Px = width10.toFixed(2);

    track.style.width = `${width10Px}px`;
    line1.style.width = `${width1Px}px`;
    line10.style.width = `${width10Px}px`;
    marker1.style.left = `${width1Px}px`;
    marker10.style.left = `${width10Px}px`;
    marker1.textContent = '1u';
    marker10.textContent = '10u';

    this._setHudScaleVisible(true);
  }

  _updateHudGeo({ lat, lon } = {}) {
    if (!ui.hudLat || !ui.hudLon) return;

    const latOk = Number.isFinite(lat);
    const lonOk = Number.isFinite(lon);
    const latLabel = latOk ? lat.toFixed(5) : '--';
    const lonLabel = lonOk ? lon.toFixed(5) : '--';
    const latTitle = latOk ? `Latitude ${lat.toFixed(7)}` : 'Latitude unavailable';
    const lonTitle = lonOk ? `Longitude ${lon.toFixed(7)}` : 'Longitude unavailable';

    let geohashValue = '--';
    if (latOk && lonOk) {
      try {
        const spacing = this.hexGridMgr?.spacing ?? 10;
        const precision = pickGeohashPrecision(spacing);
        geohashValue = geohashEncode(lat, lon, precision);
      } catch {
        geohashValue = '--';
      }
    }

    if (this._hudGeoCached.lat !== latLabel) {
      ui.hudLat.textContent = latLabel;
      ui.hudLat.title = latTitle;
      this._hudGeoCached.lat = latLabel;
    }

    if (this._hudGeoCached.lon !== lonLabel) {
      ui.hudLon.textContent = lonLabel;
      ui.hudLon.title = lonTitle;
      this._hudGeoCached.lon = lonLabel;
    }

    if (ui.hudGeohash && this._hudGeoCached.hash !== geohashValue) {
      ui.hudGeohash.textContent = geohashValue;
      ui.hudGeohash.title = geohashValue !== '--' ? `Geohash ${geohashValue}` : 'Geohash unavailable';
      this._hudGeoCached.hash = geohashValue;
    }

    this._updateHudAltitude();
    this._updateHudClock(true);
  }

  _initWeatherUi() {
    this._weatherUiCache = {
      icon: null,
      temp: null,
      desc: null,
      humidity: null,
      wind: null,
      rain: null,
    };
    if (ui.hudWeather) {
      ui.hudWeather.classList.add('is-loading');
      ui.hudWeather.setAttribute('aria-busy', 'true');
    }
    if (ui.hudWeatherForecast) ui.hudWeatherForecast.textContent = '';
  }

  _maybeUpdateWeatherFromScene(latLon) {
    if (!this.weather || !latLon) return;
    const lat = Number(latLon.lat);
    const lon = Number(latLon.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const coords = { lat, lon };

    if (!this._weatherActive) {
      this.weather.start(lat, lon);
      this._weatherActive = true;
      this._weatherLastCoords = coords;
      this._markWeatherPending();
      return;
    }

    if (!this._weatherCoordsChanged(coords, this._weatherLastCoords)) return;

    this.weather.updateLocation(lat, lon);
    this._weatherLastCoords = coords;
    this._markWeatherPending();
  }

  _weatherCoordsChanged(next, prev) {
    if (!prev || !Number.isFinite(prev.lat) || !Number.isFinite(prev.lon)) return true;
    const deltaLat = Math.abs(next.lat - prev.lat);
    const deltaLon = Math.abs(next.lon - prev.lon);
    return deltaLat > this._weatherMinDeltaDeg || deltaLon > this._weatherMinDeltaDeg;
  }

  _markWeatherPending() {
    this._weatherPending = true;
    if (!this._weatherHasData) this._setWeatherLoading(true);
  }

  _handleWeatherUpdated(detail) {
    if (!detail) return;
    this._weatherPending = false;
    this._weatherHasData = true;
    this._setWeatherLoading(false);
    this._updateWeatherHud(detail);
  }

  _setWeatherLoading(isLoading) {
    if (!ui.hudWeather) return;
    ui.hudWeather.classList.toggle('is-loading', !!isLoading);
    if (isLoading) ui.hudWeather.setAttribute('aria-busy', 'true');
    else ui.hudWeather.removeAttribute('aria-busy');
  }

  _applyWeatherText(node, key, value, title = null) {
    if (!node) return;
    if (!this._weatherUiCache) this._weatherUiCache = {};
    if (this._weatherUiCache[key] === value) {
      if (title != null) node.title = title;
      return;
    }
    node.textContent = value;
    if (title != null) node.title = title;
    this._weatherUiCache[key] = value;
  }

  _updateWeatherHud(weatherData = {}) {
    if (!weatherData || !weatherData.current) return;
    const current = weatherData.current;
    const weatherCode = Number.isFinite(current.weather_code) ? current.weather_code : null;
    const icon = weatherCode != null ? (this.weather?.getWeatherIcon?.(weatherCode) || '—') : '—';
    const desc = weatherCode != null ? (this.weather?.getWeatherDescription?.(weatherCode) || '—') : '—';
    const temp = Number.isFinite(current.temperature_2m) ? `${Math.round(current.temperature_2m)}°` : '--°';
    const humidity = Number.isFinite(current.relative_humidity_2m) ? `${Math.round(current.relative_humidity_2m)}%` : '--%';
    const windDir = this._formatWindDirection(current.wind_direction_10m);
    const windSpeedVal = Number.isFinite(current.wind_speed_10m) ? Math.round(current.wind_speed_10m) : null;
    const windSpeed = windSpeedVal != null ? `${windSpeedVal} km/h` : '-- km/h';
    const windLabel = windDir ? `${windSpeed} ${windDir}` : windSpeed;
    let precipitation = null;
    if (Number.isFinite(current.precipitation)) precipitation = current.precipitation;
    else if (Number.isFinite(current.rain)) precipitation = current.rain;
    const rainLabel = precipitation != null ? `${precipitation.toFixed(1)} mm` : '-- mm';

    this._applyWeatherText(ui.hudWeatherIcon, 'icon', icon, desc);
    this._applyWeatherText(ui.hudWeatherTemp, 'temp', temp);
    this._applyWeatherText(ui.hudWeatherDesc, 'desc', desc);
    this._applyWeatherText(ui.hudWeatherHumidity, 'humidity', humidity);
    this._applyWeatherText(ui.hudWeatherWind, 'wind', windLabel);
    this._applyWeatherText(ui.hudWeatherRain, 'rain', rainLabel);

    const forecast = this.weather?.getDailyForecast?.(5) || [];
    this._updateWeatherForecast(forecast);
  }

  _formatWindDirection(degVal) {
    const deg = Number(degVal);
    if (!Number.isFinite(deg)) return '';
    const sectors = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    const normalized = ((deg % 360) + 360) % 360;
    const index = Math.round((normalized / 360) * sectors.length) % sectors.length;
    return sectors[index];
  }

  _updateWeatherForecast(days = []) {
    if (typeof document === 'undefined') return;
    const host = ui.hudWeatherForecast;
    if (!host) return;
    host.textContent = '';
    if (!Array.isArray(days) || !days.length) {
      host.setAttribute('aria-hidden', 'true');
      return;
    }
    host.removeAttribute('aria-hidden');
    const limit = Math.min(days.length, 5);
    for (let i = 0; i < limit; i += 1) {
      const day = days[i];
      const card = document.createElement('div');
      card.className = 'hud-weather-day';

      const name = document.createElement('div');
      name.className = 'hud-weather-day-name';
      name.textContent = this._formatForecastDayLabel(day.date, i);
      card.appendChild(name);

      const icon = document.createElement('div');
      icon.className = 'hud-weather-day-icon';
      icon.textContent = Number.isFinite(day.weatherCode)
        ? (this.weather?.getWeatherIcon?.(day.weatherCode) || '—')
        : '—';
      card.appendChild(icon);

      const temps = document.createElement('div');
      temps.className = 'hud-weather-day-temp';
      const max = document.createElement('span');
      max.className = 'hud-weather-day-temp-max';
      max.textContent = Number.isFinite(day.tempMax) ? `${Math.round(day.tempMax)}°` : '--°';
      const min = document.createElement('span');
      min.className = 'hud-weather-day-temp-min';
      min.textContent = Number.isFinite(day.tempMin) ? `${Math.round(day.tempMin)}°` : '--°';
      temps.appendChild(max);
      temps.appendChild(min);
      card.appendChild(temps);

      host.appendChild(card);
    }
  }

  _formatForecastDayLabel(dateStr, index) {
    if (index === 0) return 'Today';
    if (!dateStr) return '--';
    try {
      const date = new Date(`${dateStr}T00:00:00Z`);
      return date.toLocaleDateString(undefined, { weekday: 'short' });
    } catch {
      return dateStr;
    }
  }

  _updateHudAltitude() {
    if (!ui.hudAltitude) return;
    const dolly = this.sceneMgr?.dolly;
    const mgr = this.hexGridMgr;
    let ground = null;
    if (dolly && mgr?.getHeightAt) {
      const y = mgr.getHeightAt(dolly.position.x, dolly.position.z);
      if (Number.isFinite(y)) ground = y;
    }
    const label = Number.isFinite(ground) ? `${ground.toFixed(1)} m` : '--';
    if (ui.hudAltitude.textContent !== label) ui.hudAltitude.textContent = label;
    ui.hudAltitude.title = Number.isFinite(ground)
      ? `Terrain altitude ${ground.toFixed(2)} meters`
      : 'Terrain altitude unavailable';
  }

  _updateHudClock(force = false) {
    if (!ui.hudClockLocal) return;
    const nowMs = Date.now();
    if (!force && nowMs < this._hudClockNextMs) return;
    this._hudClockNextMs = nowMs + 1000;

    const nowReal = Date.now();
    if (!this._timeFetchPending && nowReal >= this._timeFetchFailedUntil && this._timeOffsetMs === 0) {
      this._fetchRemoteTime();
    }

    const adjustedMs = nowMs + this._timeOffsetMs;
    const now = new Date(adjustedMs);

    let localStr;
    try {
      localStr = new Intl.DateTimeFormat([], {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: this._timeZoneName || Intl.DateTimeFormat().resolvedOptions().timeZone,
      }).format(now);
    } catch {
      localStr = now.toISOString().slice(11, 19);
    }

    const utcStr = new Date(adjustedMs).toISOString().slice(11, 19) + 'Z';
    if (ui.hudClockLocal.textContent !== localStr) {
      ui.hudClockLocal.textContent = localStr;
      ui.hudClockLocal.title = now.toLocaleString();
    }
    if (ui.hudClockUtc.textContent !== utcStr) {
      ui.hudClockUtc.textContent = utcStr;
      ui.hudClockUtc.title = now.toUTCString();
    }

    const lat = Number.isFinite(this._locationState?.lat)
      ? this._locationState.lat
      : Number.isFinite(this.hexGridMgr?.origin?.lat)
        ? this.hexGridMgr.origin.lat
        : null;
    const lon = Number.isFinite(this._locationState?.lon)
      ? this._locationState.lon
      : Number.isFinite(this.hexGridMgr?.origin?.lon)
        ? this.hexGridMgr.origin.lon
        : null;

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      if (ui.hudSunInfo && ui.hudSunInfo.textContent !== ' --° · --°') {
        ui.hudSunInfo.textContent = ' --° · --°';
        ui.hudSunInfo.title = ' position unavailable';
      }
      if (ui.hudMoonInfo && ui.hudMoonInfo.textContent !== ' --° · --°') {
        ui.hudMoonInfo.textContent = ' --° · --°';
        ui.hudMoonInfo.title = ' position unavailable';
      }
      return;
    }

    const sun = this._computeSunAstronomy(lat, lon, now);
    if (sun && ui.hudSunInfo) {
      const altDeg = deg(sun.altitude);
      const azDeg = this._wrapDegrees(deg(sun.azimuth));
      const text = `${this._formatSignedAngle(altDeg)} · ${azDeg.toFixed(0)}°`;
      if (ui.hudSunInfo.textContent !== text) ui.hudSunInfo.textContent = text;
      ui.hudSunInfo.title = `altitude ${altDeg.toFixed(2)}°, azimuth ${azDeg.toFixed(2)}°`;
    }

    const moon = this._computeMoonAstronomy(lat, lon, now);
    if (moon && ui.hudMoonInfo) {
      const altDeg = deg(moon.altitude);
      const azDeg = this._wrapDegrees(deg(moon.azimuth));
      const text = `${this._formatSignedAngle(altDeg)} · ${azDeg.toFixed(0)}°`;
      if (ui.hudMoonInfo.textContent !== text) ui.hudMoonInfo.textContent = text;
      ui.hudMoonInfo.title = `altitude ${altDeg.toFixed(2)}°, azimuth ${azDeg.toFixed(2)}°`;
    }
  }

  _formatSignedAngle(valueDeg) {
    if (!Number.isFinite(valueDeg)) return '--°';
    const sign = valueDeg > 0 ? '+' : '';
    return `${sign}${valueDeg.toFixed(1)}°`;
  }

  _wrapDegrees(valueDeg) {
    if (!Number.isFinite(valueDeg)) return 0;
    const wrapped = valueDeg % 360;
    return wrapped < 0 ? wrapped + 360 : wrapped;
  }

  async _fetchRemoteTime() {
    if (this._timeFetchPending || this._timeFetchFailed) return;
    this._timeFetchPending = true;
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4500);
      const res = await fetch('https://worldtimeapi.org/api/ip', { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json();
      const remoteMs = Date.parse(data?.datetime);
      if (Number.isFinite(remoteMs)) {
        this._timeOffsetMs = remoteMs - Date.now();
        this._timeZoneName = data?.timezone || this._timeZoneName;
        this._timeFetchFailedUntil = 0;
        this._updateHudClock(true);
      }
    } catch (err) {
      console.warn('[clock] remote time fetch failed', err);
      this._timeFetchFailedUntil = Date.now() + 60000;
    } finally {
      this._timeFetchPending = false;
    }
  }

  _computeSunAstronomy(lat, lon, date) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !date) return null;
    const lw = rad(-lon);
    const phi = rad(lat);
    const d = (date.getTime() / DAY_MS - 0.5 + J1970) - J2000;

    const solarMeanAnomaly = (d) => rad(357.5291 + 0.98560028 * d);
    const eclipticLongitude = (M) => {
      const C = rad(1.9148) * Math.sin(M) + rad(0.02) * Math.sin(2 * M) + rad(0.0003) * Math.sin(3 * M);
      const P = rad(102.9372);
      return M + C + P + Math.PI;
    };
    const declination = (L) => Math.asin(Math.sin(OBLIQUITY) * Math.sin(L));
    const rightAscension = (L) => Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L));
    const siderealTime = (d, lw) => rad(280.16 + 360.9856235 * d) - lw;

    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    const dec = declination(L);
    const ra = rightAscension(L);
    const H = siderealTime(d, lw) - ra;

    const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    let azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    azimuth = (azimuth + Math.PI * 2) % (Math.PI * 2);

    return { altitude, azimuth };
  }

  _computeMoonAstronomy(lat, lon, date) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !date) return null;
    const lw = rad(-lon);
    const phi = rad(lat);
    const d = (date.getTime() / DAY_MS - 0.5 + J1970) - J2000;

    const L = rad(218.316 + 13.176396 * d);
    const M = rad(134.963 + 13.064993 * d);
    const F = rad(93.272 + 13.229350 * d);

    const l = L + rad(6.289) * Math.sin(M);
    const b = rad(5.128) * Math.sin(F);
    const dt = 385001 - 20905 * Math.cos(M);

    const ra = Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
    const dec = Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));

    const siderealTime = (d, lw) => rad(280.16 + 360.9856235 * d) - lw;
    const H = siderealTime(d, lw) - ra;

    let altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    altitude -= rad(0.017) / (dt || 1); // parallax

    let azimuth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    azimuth = (azimuth + Math.PI * 2) % (Math.PI * 2);

    return { altitude, azimuth };
  }

  _updateLocalPoseUI() {
    const { dolly } = this.sceneMgr;

    const e = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
    const p = dolly.position;

    ui.lpPos.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    ui.lpEul.textContent = `${deg(e.y).toFixed(1)}/${deg(e.x).toFixed(1)}/0.0`;
    ui.lpSpd.textContent = `${this.move.speed().toFixed(2)} m/s`;

    const groundY = this.hexGridMgr?.getHeightAt?.(p.x, p.z);
    const eyeHeight = Number.isFinite(groundY) ? p.y - groundY : null;
    this._updateCharacterDiagnostics({
      position: p,
      speed: this.move.speed(),
      groundY,
      eyeHeight,
      animation: this.localAvatar?.current || null,
      crouch: this.move.isCrouching?.() ?? false,
      jumpState: this.move.jumpState,
    });

    this._updateHudAltitude();
    this._updateHudClock();
  }

  _updateCharacterDiagnostics({ position, speed, groundY, eyeHeight, animation, crouch, jumpState }) {
    if (ui.charAnimState) ui.charAnimState.textContent = animation || '—';
    if (ui.charSpeedValue) ui.charSpeedValue.textContent = `${Number.isFinite(speed) ? speed.toFixed(2) : '0.00'} m/s`;
    if (ui.charElevationValue) ui.charElevationValue.textContent = Number.isFinite(groundY)
      ? `${groundY.toFixed(2)} m`
      : '—';
    if (ui.charEyeHeightValue) ui.charEyeHeightValue.textContent = Number.isFinite(eyeHeight)
      ? `${eyeHeight.toFixed(2)} m`
      : '—';
    if (ui.charCrouchState) ui.charCrouchState.textContent = crouch ? 'CROUCH' : 'STAND';
    if (ui.charJumpState) ui.charJumpState.textContent = jumpState || 'idle';
  }

  /* ---------- Pose persistence ---------- */

  _initPosePersistence() {
    if (this._posePersistenceReady) return;
    this._posePersistenceReady = true;

    if (this._pendingPoseRestore) {
      this._applyStoredPose(this._pendingPoseRestore);
    }

    window.addEventListener('beforeunload', () => {
      this._persistPose({ snapshot: this._capturePose(), force: true });
    });
  }

  _capturePose() {
    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return null;
    const pos = dolly.position;
    const yawEuler = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
    const eyeHeight = this.move?.eyeHeight?.();
    const camera = this.sceneMgr?.camera || null;

    const toQuatArray = (quat) => {
      if (!quat) return null;
      const arr = [quat.x, quat.y, quat.z, quat.w];
      return arr.every((v) => Number.isFinite(v)) ? arr : null;
    };

    return {
      px: Number.isFinite(pos.x) ? pos.x : 0,
      py: Number.isFinite(pos.y) ? pos.y : 0,
      pz: Number.isFinite(pos.z) ? pos.z : 0,
      yaw: Number.isFinite(yawEuler.y) ? yawEuler.y : 0,
      pitch: Number.isFinite(this._pitch) ? this._pitch : 0,
      eyeHeight: Number.isFinite(eyeHeight) ? eyeHeight : null,
      dq: toQuatArray(dolly.quaternion),
      cq: toQuatArray(camera?.quaternion),
    };
  }

  _clonePoseSnapshot(pose) {
    if (!pose) return null;
    return {
      px: Number.isFinite(pose.px) ? pose.px : 0,
      py: Number.isFinite(pose.py) ? pose.py : 0,
      pz: Number.isFinite(pose.pz) ? pose.pz : 0,
      yaw: Number.isFinite(pose.yaw) ? pose.yaw : 0,
      pitch: Number.isFinite(pose.pitch) ? pose.pitch : 0,
      eyeHeight: Number.isFinite(pose.eyeHeight) ? pose.eyeHeight : null,
      dq: Array.isArray(pose.dq) ? pose.dq.map((v) => Number(v)) : null,
      cq: Array.isArray(pose.cq) ? pose.cq.map((v) => Number(v)) : null,
    };
  }

  _quaternionDeltaAngle(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 4 || b.length !== 4) {
      return null;
    }
    const lenA = Math.hypot(a[0], a[1], a[2], a[3]);
    const lenB = Math.hypot(b[0], b[1], b[2], b[3]);
    if (lenA === 0 || lenB === 0) return null;
    const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) / (lenA * lenB);
    const clamped = Math.min(1, Math.max(-1, Math.abs(dot)));
    return 2 * Math.acos(clamped);
  }

  _poseChanged(nextPose, prevPose) {
    if (!prevPose) return true;
    const dx = (nextPose.px ?? 0) - (prevPose.px ?? 0);
    const dy = (nextPose.py ?? 0) - (prevPose.py ?? 0);
    const dz = (nextPose.pz ?? 0) - (prevPose.pz ?? 0);
    const posDeltaSq = dx * dx + dy * dy + dz * dz;
    if (posDeltaSq > 1e-4) return true;

    const nextDq = Array.isArray(nextPose.dq) ? nextPose.dq : null;
    const prevDq = Array.isArray(prevPose.dq) ? prevPose.dq : null;
    if (!!nextDq !== !!prevDq) return true;
    if (nextDq && prevDq) {
      const angle = this._quaternionDeltaAngle(nextDq, prevDq);
      if (angle != null && angle > THREE.MathUtils.degToRad(0.75)) return true;
    }

    const nextCq = Array.isArray(nextPose.cq) ? nextPose.cq : null;
    const prevCq = Array.isArray(prevPose.cq) ? prevPose.cq : null;
    if (!!nextCq !== !!prevCq) return true;
    if (nextCq && prevCq) {
      const angle = this._quaternionDeltaAngle(nextCq, prevCq);
      if (angle != null && angle > THREE.MathUtils.degToRad(0.75)) return true;
    }

    const yawDelta = Math.abs(this._wrapAngle((nextPose.yaw ?? 0) - (prevPose.yaw ?? 0)));
    if (yawDelta > THREE.MathUtils.degToRad(1)) return true;

    const pitchDelta = Math.abs((nextPose.pitch ?? 0) - (prevPose.pitch ?? 0));
    if (pitchDelta > THREE.MathUtils.degToRad(1)) return true;

    return false;
  }

  _poseMaybeSave(dt) {
    const snapshot = this._capturePose();
    if (!snapshot) return;

    const snapshotClone = this._clonePoseSnapshot(snapshot);
    this._poseLatestState = snapshotClone;

    if (this._poseChanged(snapshotClone, this._poseStoredState)) {
      this._poseDirty = true;
    }

    if (!this._poseDirty) return;

    this._poseSaveTimer += dt;
    const speed = this.move?.speed?.() ?? 0;
    const shouldPersist = this._poseSaveTimer >= 2.5 || (speed < 0.05 && this._poseSaveTimer >= 0.6);
    if (!shouldPersist) return;

    this._persistPose({ snapshot: snapshotClone });
  }

  _persistPose({ snapshot = null, force = false } = {}) {
    const sourcePose = snapshot || this._capturePose();
    if (!sourcePose) return;
    const pose = this._clonePoseSnapshot(sourcePose);

    if (!force && !this._poseChanged(pose, this._poseStoredState)) {
      this._poseDirty = false;
      this._poseSaveTimer = 0;
      return;
    }

    try {
      const stored = { ...pose, ts: Date.now() };
      // === NEW: defer synchronous localStorage to idle to avoid jank ===
      const write = () => {
        try {
          localStorage.setItem(PLAYER_POSE_KEY, JSON.stringify(stored));
          this._poseStoredState = this._clonePoseSnapshot(pose);
          this._poseLatestState = this._clonePoseSnapshot(pose);
          this._poseDirty = false;
          this._poseSaveTimer = 0;
          this._poseRestored = true;
        } catch { }
      };
      if ('requestIdleCallback' in window && !force) {
        requestIdleCallback(write, { timeout: 1000 });
      } else {
        setTimeout(write, 0);
      }
    } catch {
      // ignore
    }
  }

  _loadStoredPose() {
    try {
      const raw = localStorage.getItem(PLAYER_POSE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      if (!Number.isFinite(parsed.px) || !Number.isFinite(parsed.pz)) return null;
      const toQuat = (q) => {
        if (!Array.isArray(q) || q.length !== 4) return null;
        const arr = q.map((v) => Number(v));
        return arr.every((v) => Number.isFinite(v)) ? arr : null;
      };
      return {
        px: Number(parsed.px),
        py: Number.isFinite(parsed.py) ? Number(parsed.py) : 0,
        pz: Number(parsed.pz),
        yaw: Number.isFinite(parsed.yaw) ? Number(parsed.yaw) : 0,
        pitch: Number.isFinite(parsed.pitch) ? Number(parsed.pitch) : 0,
        eyeHeight: Number.isFinite(parsed.eyeHeight) ? Number(parsed.eyeHeight) : null,
        dq: toQuat(parsed.dq),
        cq: toQuat(parsed.cq),
      };
    } catch {
      return null;
    }
  }

  _applyStoredPose(pose) {
    if (!pose) return;
    const dolly = this.sceneMgr?.dolly;
    const camera = this.sceneMgr?.camera;
    if (!dolly || !camera) {
      this._pendingPoseRestore = pose;
      return;
    }

    if (Number.isFinite(pose.px) && Number.isFinite(pose.pz)) {
      const yValue = Number.isFinite(pose.py) ? pose.py : dolly.position.y;
      dolly.position.set(pose.px, yValue, pose.pz);
    }

    if (Array.isArray(pose.dq) && pose.dq.length === 4) {
      dolly.quaternion.set(pose.dq[0], pose.dq[1], pose.dq[2], pose.dq[3]).normalize();
    } else if (Number.isFinite(pose.yaw)) {
      dolly.quaternion.setFromEuler(new THREE.Euler(0, pose.yaw, 0, 'YXZ'));
    }

    if (Array.isArray(pose.cq) && pose.cq.length === 4) {
      camera.quaternion.set(pose.cq[0], pose.cq[1], pose.cq[2], pose.cq[3]).normalize();
      const camEuler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
      this._pitch = THREE.MathUtils.clamp(camEuler.x, this._pitchMin, this._pitchMax);
    } else if (Number.isFinite(pose.pitch)) {
      const clamped = THREE.MathUtils.clamp(pose.pitch, this._pitchMin, this._pitchMax);
      this._pitch = clamped;
      camera.quaternion.setFromEuler(new THREE.Euler(clamped, 0, 0, 'YXZ'));
    }
    camera.up.set(0, 1, 0);

    const eyeHeight = Number.isFinite(pose.eyeHeight) ? pose.eyeHeight : (this.move?.eyeHeight?.() ?? 1.6);
    const groundY = this.hexGridMgr?.getHeightAt?.(dolly.position.x, dolly.position.z);
    if (Number.isFinite(groundY) && Number.isFinite(eyeHeight)) {
      dolly.position.y = groundY + eyeHeight;
    }

    this.hexGridMgr?.update?.(dolly.position);
    this.physics?.setCharacterPosition?.(dolly.position, eyeHeight);

    const refreshedPose = this._clonePoseSnapshot(this._capturePose());
    const effectivePose = refreshedPose || this._clonePoseSnapshot(pose);
    this._poseStoredState = effectivePose;
    this._poseLatestState = effectivePose ? this._clonePoseSnapshot(effectivePose) : null;
    this._poseDirty = false;
    this._poseSaveTimer = 0;
    this._pendingPoseRestore = null;
    this._poseRestored = true;
  }

  /* ---------- Main loop ---------- */
  _tick() {
    if (performance?.mark) performance.mark('tick-start');

    const logger = this._perfLogger;
    if (logger?.frameStart) logger.frameStart();
    const measure = logger ? (label, fn) => logger.measure(label, fn) : (label, fn) => fn();
    const begin = logger ? (label) => logger.begin(label) : () => { };
    const end = logger ? (label) => logger.end(label) : () => 0;

    const dt = this.clock.getDelta();
    const currentTargetFps = this._perf.profile().targetFps;
    const fpsSample = dt > 0.5 ? currentTargetFps : (dt > 1e-4 ? 1 / dt : currentTargetFps);
    const now = (performance?.now ? performance.now() : Date.now());
    const target = this._perf.profile().targetFps || 60;
    const fpsEstimate = (dt > 1e-4) ? (1 / dt) : target;
    const urgent = fpsEstimate < target * (1 - this._perfUrgentFrac);
    const doPerf = urgent || now >= this._perfNextMs;

    const perfState = doPerf
      ? this._perf.sample({ dt, fps: fpsEstimate })
      : this._perf.profile();           // read-only, no applies

    if (doPerf) this._perfNextMs = now + (urgent ? 120 : this._perfCadenceMs);

    if (this.hexGridMgr?.updateTreePerformanceSample) {
      const fpsForTrees = Number.isFinite(perfState?.smoothedFps)
        ? perfState.smoothedFps
        : fpsEstimate;
      this.hexGridMgr.updateTreePerformanceSample(fpsForTrees, dt);
    }

    if (perfState.qualityChanged || perfState.hudReady) {
      const tileSummary = perfState.subsystems?.terrain ?? null;
      const buildingSummary = perfState.subsystems?.buildings ?? null;
      const renderSummary = perfState.subsystems?.render ?? null;
      if (tileSummary && this._terrainAuto) this._perfSnapshots.tiles = tileSummary;
      if (buildingSummary && this._buildingAuto) this._perfSnapshots.buildings = buildingSummary;
      if (renderSummary) this._perfSnapshots.render = renderSummary;
      if (tileSummary) this._refreshEnvironmentTerrainSummary(tileSummary);
      if (buildingSummary) this._refreshEnvironmentBuildingSummary(buildingSummary);
      this._updatePidDiagnostics(perfState);
    }

    const originForSun = this.hexGridMgr?.origin;
    if (originForSun) this._maybeUpdateSun(originForSun);

    const relayStatus = this.hexGridMgr?.getRelayStatus?.();
    if (relayStatus) {
      let relayTooltip = relayStatus.text || 'Terrain relay idle';
      const metrics = relayStatus.metrics || null;
      const pipeline = relayStatus.pipeline || null;
      const heartbeat = relayStatus.heartbeat || null;
      if (metrics) {
        const total = metrics.totalRequests ?? (metrics.success + metrics.failure);
        const last = Number.isFinite(metrics.lastDurationMs) ? `${metrics.lastDurationMs.toFixed(0)}ms` : '—';
        const avg = Number.isFinite(metrics.avgDurationMs) ? `${metrics.avgDurationMs.toFixed(0)}ms` : '—';
        const inflight = metrics.inflight ?? 0;
        const retries = metrics.retries ?? 0;
        const timeouts = metrics.timeouts ?? 0;
        const lastSuccessAgo = metrics.lastSuccessAt ? this._formatAgo(metrics.lastSuccessAt) : 'never';
        const lastFailureAgo = metrics.lastFailureAt ? this._formatAgo(metrics.lastFailureAt) : 'never';
        const lines = [
          relayStatus.text || 'Terrain relay',
          `queries · ok ${metrics.success}/${total || 0} · fail ${metrics.failure}`,
          `duration · last ${last} · avg ${avg}`,
          `inflight ${inflight} · retries ${retries} · timeouts ${timeouts}`,
          `last success ${lastSuccessAgo} · last failure ${lastFailureAgo}`,
        ];
        if (metrics.lastError) lines.push(`last error · ${metrics.lastError}`);
        relayTooltip = lines.join('\n');
      }
      if (pipeline) {
        const pending = pipeline.pending || {};
        const queued = pipeline.queued || {};
        const phase = pipeline.phase || 'interactive';
        const inflightPipeline = Number.isFinite(pipeline.inflight) ? pipeline.inflight : 0;
        const queueDepth = Number.isFinite(pipeline.queue) ? pipeline.queue : 0;
        const deferredCount = Number.isFinite(pipeline.deferredInteractive) ? pipeline.deferredInteractive : 0;
        const secondPass = pipeline.interactiveSecondPass ? 'yes' : 'no';
        const phaseLine = `pipeline · ${phase} · inflight ${inflightPipeline} · queue ${queueDepth}`;
        const pendingLine = `pending · I ${pending.interactive ?? 0} · V ${pending.visual ?? 0} · F ${pending.farfield ?? 0}`;
        const queuedLine = `queued · I ${queued.interactive ?? 0} · V ${queued.visual ?? 0} · F ${queued.farfield ?? 0}`;
        const deferredLine = `interactive backlog · deferred ${deferredCount} · second pass ${secondPass}`;
        relayTooltip += `\n${phaseLine}\n${pendingLine}\n${queuedLine}\n${deferredLine}`;
      }
      if (heartbeat?.at) {
        const ageMs = Date.now() - heartbeat.at;
        const ageLabel = ageMs >= 0 ? `${(ageMs / 1000).toFixed(1)}s ago` : 'n/a';
        const hbDur = Number.isFinite(metrics?.lastHeartbeatMs) ? `${metrics.lastHeartbeatMs.toFixed(0)}ms` : 'n/a';
        relayTooltip += `\nheartbeat · ${ageLabel} · ${hbDur}`;
      }
      if (this._terrainStatusEl) {
        this._terrainStatusEl.textContent = relayStatus.text || 'idle';
        this._terrainStatusEl.dataset.state = relayStatus.level || 'info';
        this._terrainStatusEl.dataset.connected = relayStatus.connected ? 'true' : 'false';
        this._terrainStatusEl.title = relayTooltip;
      }
      if (this._hudTerrainDot) applyHudStatusDot(this._hudTerrainDot, relayStatus.level || '');
      if (this._hudTerrainLabel) this._hudTerrainLabel.title = relayTooltip;
    }

    if (perfState.hudReady) {
      begin('hud.update');
      if (ui.hudFps) ui.hudFps.textContent = Math.round(perfState.smoothedFps);
      if (ui.hudQos) {
        ui.hudQos.textContent = this._formatPerfLabel(perfState);
        ui.hudQos.classList.remove('flash');
        void ui.hudQos.offsetWidth;
        ui.hudQos.classList.add('flash');
      }
      this._updateHudMeta(perfState);
      end('hud.update');
    }

    measure('hud.compass', () => this._updateHudCompass());

    if (this._compassYawConfidence > 0) {
      const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const ageSec = Math.max(0, (nowMs - this._compassLastUpdate) / 1000);
      if (ageSec > 1.5) {
        this._compassYawConfidence = Math.max(0, this._compassYawConfidence - dt * 0.5);
        if (this._compassYawConfidence < 0.01) {
          this._compassYawConfidence = 0;
          this._compassYawOffset = 0;
        }
      }
    }

    const { dolly, camera, renderer } = this.sceneMgr;
    const xrOn = renderer.xr.isPresenting;

    if (this._mobileFPVArmed && this.sensors?.orient?.ready && !xrOn) {
      measure('mobile.fpvEnter', () => this._enterMobileFPV());
      this._mobileFPVArmed = false;
    }

    if (!xrOn) {
      measure('orientation', () => {
        if (this._mobileFPVOn && this.sensors?.orient?.ready) {
          // Get cameraQuat (has compass-aligned yaw via _yawOff + device pitch/roll)
          const { q: cameraQuat } = this.sensors.getCameraQuaternion?.() || { q: this._deviceQuatForFPV(this.sensors.orient) };

          // Extract yaw from cameraQuat (compass-aligned gyro)
          this._tmpVec3.set(0, 0, -1).applyQuaternion(cameraQuat);
          const yawFromCamera = Math.atan2(-this._tmpVec3.x, -this._tmpVec3.z);

          // Set dolly yaw directly (no negation)
          dolly.rotation.set(0, yawFromCamera, 0);

          // Camera (child of dolly) gets ONLY pitch/roll from cameraQuat
          // Remove yaw from cameraQuat
          this._tmpQuat.setFromAxisAngle(this._yAxis, -yawFromCamera);
          camera.quaternion.copy(cameraQuat).premultiply(this._tmpQuat);
          camera.up.set(0, 1, 0);

          // Legacy pitch tracking
          this._pitch = this._tmpEuler.setFromQuaternion(cameraQuat, 'YXZ').x;

        } else {
          const e = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
          const yawAbs = e.y;
          const pitchDelta = e.x;
          this._pitch = THREE.MathUtils.clamp(this._pitch + pitchDelta, this._pitchMin, this._pitchMax);
          const yawEuler = this._tmpEuler.set(0, yawAbs, 0, 'YXZ');
          dolly.quaternion.setFromEuler(yawEuler);
          dolly.rotation.set(0, yawAbs, 0);
          const camEuler = this._tmpEuler.set(this._pitch, 0, 0, 'YXZ');
          camera.quaternion.setFromEuler(camEuler);
          camera.up.set(0, 1, 0);
        }
      });
    }

    begin('movement');
    const prevPos = this._tmpVec.copy(dolly.position);
    const baseGroundY = measure('height.base', () => this.hexGridMgr.getHeightAt(prevPos.x, prevPos.z));

    this.move.update(dt, baseGroundY, xrOn);

    const eyeHeight = this.move.eyeHeight();
    const desiredMove = this._tmpVec2.copy(dolly.position).sub(prevPos);
    let allowedMove = desiredMove;
    if (this.physics?.isCharacterReady?.()) {
      allowedMove = measure('physics.resolveMove', () => {
        if (performance?.mark) performance.mark('phys-resolve-start');
        const resolved = this.physics.resolveCharacterMovement(prevPos, eyeHeight, desiredMove);
        if (performance?.mark) {
          performance.mark('phys-resolve-end');
          performance.measure('phys-resolve', 'phys-resolve-start', 'phys-resolve-end');
        }
        return resolved;
      });
    }
    if (!allowedMove) {
      desiredMove.set(0, 0, 0);
      allowedMove = desiredMove;
    }

    const desiredHorizLen = this._tmpVec5.copy(desiredMove).setY(0).length();
    const allowedHorizLen = this._tmpVec6.copy(allowedMove).setY(0).length();
    const impactLoss = Math.max(0, desiredHorizLen - allowedHorizLen);
    if (impactLoss > 0.02 && desiredHorizLen > 0.05 && this.physics?.notifyCharacterImpact) {
      const impactPos = this._tmpVec4.copy(prevPos).addScaledVector(allowedMove, 0.5);
      const intensity = THREE.MathUtils.clamp(impactLoss * 8, 0.12, 2.5);
      this.physics.notifyCharacterImpact(impactPos, intensity);
    }

    const finalPos = this._tmpVec3.copy(prevPos).add(allowedMove);
    let groundY = measure('height.locomotion', () => this.hexGridMgr.getHeightAt(finalPos.x, finalPos.z));
    finalPos.y = groundY + eyeHeight;
    dolly.position.copy(finalPos);

    if (this._teleportTween) {
      this._updateTeleportTween(now, eyeHeight);
    }

    if (this._mobileNav?.active) this._updateMobileAutopilot(dt);
    this._updateCompassDial();
    end('movement');

    const hexNow = performance.now ? performance.now() : Date.now();
    const movedSq = this._lastHexUpdatePos.distanceToSquared(dolly.position);
    const movedEnough = movedSq > 0.25 * 0.25;
    const timeOk = hexNow >= this._nextHexUpdateMs;
    if (movedEnough || timeOk) {
      if (performance?.mark) performance.mark('hex-update-start');
      measure('tiles.update', () => this.hexGridMgr.update(dolly.position));
      if (performance?.mark) {
        performance.mark('hex-update-end');
        performance.measure('hex-update', 'hex-update-start', 'hex-update-end');
      }
      this._lastHexUpdatePos.copy(dolly.position);
      this._nextHexUpdateMs = hexNow + 100;
    }

    const nowMs = hexNow;
    if (nowMs >= this._nextBuildingsUpdateMs) {
      if (performance?.mark) performance.mark('build-update-start');
      measure('buildings.update', () => this.buildings?.update(dt));
      if (performance?.mark) {
        performance.mark('build-update-end');
        performance.measure('build-update', 'build-update-start', 'build-update-end');
      }
      this._nextBuildingsUpdateMs = nowMs + 12;
    }

    measure('hover.update', () => this._updateBuildingHover(xrOn));

    const pos = dolly.position;
    groundY = measure('height.final', () => this.hexGridMgr.getHeightAt(pos.x, pos.z));
    dolly.position.y = groundY + eyeHeight;
    this.physics?.setCharacterPosition?.(dolly.position, eyeHeight);
    measure('hud.scale', () => this._updateHudScale({ groundY }));

    const locomotionWorldYaw = xrOn && typeof this.move?.getXRWorldYaw === 'function'
      ? this.move.getXRWorldYaw()
      : null;
    const locomotionBodyYaw = xrOn && typeof this.move?.getXRBodyYaw === 'function'
      ? this.move.getXRBodyYaw()
      : null;
    let locomotionHeadHeight = xrOn && typeof this.move?.getXRHeadHeight === 'function'
      ? this.move.getXRHeadHeight()
      : null;
    let locomotionHeadYaw = null;
    let locomotionHeadPitch = null;
    let locomotionHeadRoll = null;
    if (xrOn && typeof this.move?.getXRHeadBodyQuaternion === 'function') {
      const headQuatBody = this.move.getXRHeadBodyQuaternion(this._tmpHeadBodyQuat);
      if (headQuatBody) {
        const headEuler = this._tmpHeadBodyEuler;
        headEuler.setFromQuaternion(headQuatBody, 'YXZ');
        const rawYaw = this._wrapAngle(headEuler.y);
        const rawPitch = headEuler.x;
        const rawRoll = headEuler.z;
        const pitchLimit = THREE.MathUtils.degToRad(80);
        const rollLimit = THREE.MathUtils.degToRad(55);
        locomotionHeadYaw = this._wrapAngle(-rawYaw);
        locomotionHeadPitch = THREE.MathUtils.clamp(-rawPitch, -pitchLimit, pitchLimit);
        locomotionHeadRoll = THREE.MathUtils.clamp(-rawRoll, -rollLimit, rollLimit);
      }
    }
    if (locomotionHeadYaw == null && xrOn && typeof this.move?.getXRRelativeHeadYaw === 'function') {
      locomotionHeadYaw = this.move.getXRRelativeHeadYaw();
    }
    if (locomotionHeadPitch == null && xrOn && typeof this.move?.getXRHeadPitch === 'function') {
      locomotionHeadPitch = this.move.getXRHeadPitch();
    }
    if (locomotionHeadRoll == null && xrOn && typeof this.move?.getXRHeadRoll === 'function') {
      locomotionHeadRoll = this.move.getXRHeadRoll();
    }
    if (!xrOn) {
      const camera = this.sceneMgr?.camera;
      if (camera && dolly) {
        camera.updateMatrixWorld?.(true);
        dolly.updateMatrixWorld?.(true);
        camera.getWorldQuaternion(this._tmpQuat);
        this._tmpQuat2.copy(dolly.quaternion);
        this._tmpHeadBodyQuat.copy(this._tmpQuat2).invert().multiply(this._tmpQuat);
        const headEuler = this._tmpHeadBodyEuler.setFromQuaternion(this._tmpHeadBodyQuat, 'YXZ');
        const pitchLimit = THREE.MathUtils.degToRad(80);
        const rollLimit = THREE.MathUtils.degToRad(55);
        if (!Number.isFinite(locomotionHeadYaw)) {
          locomotionHeadYaw = this._wrapAngle(headEuler.y);
        }
        if (!Number.isFinite(locomotionHeadPitch)) {
          locomotionHeadPitch = THREE.MathUtils.clamp(-headEuler.x, -pitchLimit, pitchLimit);
        }
        if (!Number.isFinite(locomotionHeadRoll)) {
          locomotionHeadRoll = THREE.MathUtils.clamp(headEuler.z, -rollLimit, rollLimit);
        }
      }
      if (!Number.isFinite(locomotionHeadHeight)) {
        locomotionHeadHeight = eyeHeight;
      }
    }

    if (this.localAvatar) {
      measure('avatar.local', () => {
        let yawOnly = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ').y;
        if (Number.isFinite(locomotionBodyYaw)) yawOnly = locomotionBodyYaw;
        else if (Number.isFinite(locomotionWorldYaw)) yawOnly = locomotionWorldYaw;
        const qYaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yawOnly, 0, 'YXZ'));
        const effectiveEyeHeight = Number.isFinite(locomotionHeadHeight) ? locomotionHeadHeight : eyeHeight;
        const baseEyeHeight = this.move.baseEyeHeight?.() ?? effectiveEyeHeight;
        const jumpLift = Math.max(0, effectiveEyeHeight - baseEyeHeight);
        this.localAvatar.setPosition(pos.x, groundY + jumpLift, pos.z);
        this.localAvatar.setQuaternion(qYaw);
        this.localAvatar.setSpeed(this.move.speed());
        this.localAvatar.setCrouch(this.move.isCrouching?.() ?? false);
        const airborne = (this.move.isJumping?.() ?? false) || jumpLift > 0.02;
        this.localAvatar.setAirborne(airborne);
        this.localAvatar.update(dt);
        const isFP = this._mobileFPVOn || this.chase.isFirstPerson?.();
        this.localAvatar.group.visible = !(xrOn || isFP);
      });
    }

    measure('remotes.tick', () => this.remotes.tick(dt));
    if (!this._mobileFPVOn || xrOn) measure('chase.update', () => this.chase.update(dt, xrOn));

    measure('mesh.sendPose', () => {
      const eSend = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
      let sendYaw = eSend.y;
      if (Number.isFinite(locomotionBodyYaw)) sendYaw = locomotionBodyYaw;
      else if (Number.isFinite(locomotionWorldYaw)) sendYaw = locomotionWorldYaw;
      const qSend = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, sendYaw, 0, 'YXZ'));
      const jumpEvt = this.move.popJumpStarted();
      if (jumpEvt && this.physics?.suspendCharacterSnap) {
        const hangTime = this.move?.jumpHangTime?.() ?? 0;
        const resumeDelay = Number.isFinite(hangTime) && hangTime > 0
          ? THREE.MathUtils.clamp(hangTime * 0.55, 0.2, 0.8)
          : 0.35;
        this.physics.suspendCharacterSnap(resumeDelay);
      }
      const crouchActive = this.move.isCrouching?.() ?? false;
      const effectiveEyeHeight = Number.isFinite(locomotionHeadHeight) ? locomotionHeadHeight : eyeHeight;
      const actualY = groundY + effectiveEyeHeight;
      let poseExtras = null;
      const headYawValid = Number.isFinite(locomotionHeadYaw);
      const headPitchValid = Number.isFinite(locomotionHeadPitch);
      const headRollValid = Number.isFinite(locomotionHeadRoll);
      const headPayloadActive = headYawValid || headPitchValid || headRollValid;
      if (headPayloadActive || this._xrPoseActive) {
        const xrPayload = { active: headPayloadActive ? 1 : 0 };
        if (headPayloadActive) {
          xrPayload.headYaw = headYawValid ? locomotionHeadYaw : 0;
          xrPayload.headPitch = headPitchValid ? locomotionHeadPitch : 0;
          xrPayload.headRoll = headRollValid ? locomotionHeadRoll : 0;
          if (Number.isFinite(locomotionHeadHeight)) xrPayload.headHeight = locomotionHeadHeight;
        } else {
          xrPayload.headYaw = 0;
          xrPayload.headPitch = 0;
          xrPayload.headRoll = 0;
        }
        poseExtras = { xr: xrPayload };
      }
      this._xrPoseActive = headPayloadActive;
      this.mesh.sendPoseIfChanged(dolly.position, qSend, actualY, jumpEvt, crouchActive, poseExtras);
    });

    measure('physics.update', () => {
      if (performance?.mark) performance.mark('phys-update-start');
      this.physics?.update(dt);
      if (performance?.mark) {
        performance.mark('phys-update-end');
        performance.measure('phys-update', 'phys-update-start', 'phys-update-end');
      }
    });

    measure('pose.saveMaybe', () => this._poseMaybeSave(dt));

    const origin = this.hexGridMgr?.origin;
    const hudNow = nowMs;
    const movedHudSq = this._hudGeoLastPos.distanceToSquared(dolly.position);
    if ((origin && (hudNow >= this._hudGeoNextMs || movedHudSq > 0.5 * 0.5))) {
      measure('hud.geo', () => {
        const hudLatLon = worldToLatLon(dolly.position.x, dolly.position.z, origin.lat, origin.lon);
        if (hudLatLon) {
          this._updateHudGeo(hudLatLon);
          this._maybeUpdateWeatherFromScene(hudLatLon);
        }
      });
      this._hudGeoLastPos.copy(dolly.position);
      this._hudGeoNextMs = hudNow + 100;
    }

    if (nowMs >= this._miniMapNextMs) {
      measure('minimap.update', () => this.miniMap?.update());
      this._miniMapNextMs = nowMs + 100;
    }

    measure('renderer.render', () => {
      if (performance?.mark) performance.mark('render-start');
      renderer.render(this.sceneMgr.scene, camera);
      if (performance?.mark) {
        performance.mark('render-end');
        performance.measure('render', 'render-start', 'render-end');
        performance.mark('tick-end');
        performance.measure('frame', 'tick-start', 'tick-end');
      }
    });

    // Update Smart Objects
    this._updateSmartObjectPlacementPreview();
    this.sceneMgr.updateSmartObjects();
    this._syncPlaceButtonState();

    logger?.frameEnd?.();
    this._updateProcessLeaderboard();
  }

  _initSmartObjects() {
    try {
      // Create spatial audio manager
      this.sceneMgr.spatialAudio = new SpatialAudioManager({
        camera: this.sceneMgr.camera,
        listener: this.sceneMgr.camera
      });

      // Create smart objects manager
      this.sceneMgr.smartObjects = new SmartObjectManager({
        scene: this.sceneMgr.scene,
        camera: this.sceneMgr.camera,
        hybrid: this.hybrid,
        mesh: this.mesh,
        spatialAudio: this.sceneMgr.spatialAudio,
        onPlacementModeChange: (active) => this._syncPlaceButtonState(true, active)
      });

      // Create modal UI
      this.sceneMgr.smartModal = new SmartObjectModal({
        smartObjects: this.sceneMgr.smartObjects,
        mesh: this.mesh,
        onClose: () => {
          // Optional: Do something when modal closes
        }
      });

      // Link hybrid to scene manager for audio routing
      this.hybrid.sceneMgr = this.sceneMgr;

      // Handle peer sync messages for smart objects
      if (this.mesh) {
        this.mesh.on('message', (msg) => {
          if (this.sceneMgr.smartObjects) {
            this.sceneMgr.smartObjects.handlePeerSync(msg);
          }
        });

        // Broadcast all objects to new peers when they connect
        this.mesh.on('noclip-peer', (event) => {
          if (event?.peer && this.sceneMgr.smartObjects) {
            // Small delay to ensure peer is fully ready
            setTimeout(() => {
              this.sceneMgr.smartObjects.broadcastAllObjects();
            }, 500);
          }
        });
      }

      console.log('[App] Smart Objects initialized');
      this._syncPlaceButtonState(true);

      // Handle URL parameters for Hydra/NoClip invites
      this._handleInviteUrlParams();
    } catch (err) {
      console.error('[App] Failed to initialize Smart Objects:', err);
      this._syncPlaceButtonState(true, false);
    }
  }

  /**
   * Handle URL parameters for Hydra node invites
   * Supports: ?hydra=hydra.<hex>&node=<nodeId>&object=<uuid>
   * Also: ?noclip=noclip.<hex>&object=<uuid>
   */
  _handleInviteUrlParams() {
    try {
      const url = new URL(window.location.href);

      // Check for hydra parameter (from Hydra graph)
      const hydraParam = url.searchParams.get('hydra');
      const nodeParam = url.searchParams.get('node');
      const objectParam = url.searchParams.get('object');

      // Check for noclip parameter (from another NoClip instance)
      const noclipParam = url.searchParams.get('noclip');

      if (hydraParam && nodeParam) {
        // Parse Hydra address: hydra.<hex> or just <hex>
        const parts = hydraParam.split('.');
        const hydraPub = parts.length === 2 ? parts[1] : hydraParam;

        console.log('[App] Hydra invite detected:', { hydraPub, nodeParam, objectParam });

        // If object UUID provided, try to find/create that object
        if (objectParam) {
          // Check if object already exists
          const existing = this.sceneMgr.smartObjects?.smartObjects?.find(
            obj => obj.uuid === objectParam
          );

          if (existing) {
            // Object exists, bind node and open modal
            setTimeout(() => {
              this._bindHydraNodeToObject(existing, hydraPub, nodeParam);
              this.sceneMgr.smartModal?.show(existing);
            }, 1000);
          } else {
            // Object doesn't exist, show notification
            console.log('[App] Object not found, user should create it manually');
            setTimeout(() => {
              alert(`Smart Object ${objectParam} not found.\nPlease create a Smart Object to connect to Hydra node: ${nodeParam}`);
            }, 1000);
          }
        } else {
          // No object specified, just show connection info
          setTimeout(() => {
            alert(`Ready to connect to Hydra node: ${nodeParam}\nCreate or select a Smart Object to configure the connection.`);
          }, 1000);
        }

        // Clean up URL
        url.searchParams.delete('hydra');
        url.searchParams.delete('node');
        url.searchParams.delete('object');
        const newUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;
        window.history.replaceState({}, document.title, newUrl);

      } else if (noclipParam && objectParam) {
        // Handle NoClip-to-NoClip invite (peer connection)
        const parts = noclipParam.split('.');
        const noclipPub = parts.length === 2 ? parts[1] : noclipParam;

        console.log('[App] NoClip peer invite detected:', { noclipPub, objectParam });

        // Try to connect to peer via mesh
        if (this.mesh) {
          const peerAddr = `noclip.${noclipPub}`;
          console.log('[App] Attempting to connect to NoClip peer:', peerAddr);
          // Mesh will handle the connection via existing peer discovery
        }

        // Clean up URL
        url.searchParams.delete('noclip');
        url.searchParams.delete('object');
        const newUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;
        window.history.replaceState({}, document.title, newUrl);
      }

    } catch (err) {
      console.error('[App] Failed to parse invite URL parameters:', err);
    }
  }

  /**
   * Bind Hydra node to Smart Object
   */
  _bindHydraNodeToObject(smartObject, hydraPub, nodeId) {
    if (!smartObject) return;

    // Store connection info
    if (!smartObject.config.connectedNodes) {
      smartObject.config.connectedNodes = [];
    }

    const existing = smartObject.config.connectedNodes.find(
      n => n.hydraPub === hydraPub && n.nodeId === nodeId
    );

    if (!existing) {
      smartObject.config.connectedNodes.push({
        hydraPub,
        nodeId,
        connectedAt: Date.now()
      });
    }

    // Auto-configure audio source with this node
    if (!smartObject.config.sources) {
      smartObject.config.sources = {};
    }
    if (!smartObject.config.sources.audio) {
      smartObject.config.sources.audio = {};
    }

    smartObject.config.sources.audio.nodeId = nodeId;
    smartObject.config.sources.audio.enabled = true;

    console.log(`[App] Bound Hydra node ${nodeId} to Smart Object ${smartObject.uuid}`);
  }

  _updateSmartObjectPlacementPreview() {
    const smartObjects = this.sceneMgr?.smartObjects;
    if (!smartObjects || !smartObjects.placementMode) return;
    if (!this._pointerNdc?.has) {
      smartObjects.setPlacementTarget(null);
      return;
    }
    const camera = this.sceneMgr?.camera;
    if (!camera || !this._raycaster) {
      smartObjects.setPlacementTarget(null);
      return;
    }
    const targets = this._collectTerrainRaycastTargets();
    if (!targets.length) {
      smartObjects.setPlacementTarget(null);
      return;
    }
    this._raycaster.setFromCamera(this._pointerNdc, camera);
    const hits = this._raycaster.intersectObjects(targets, true);
    const point = hits && hits.length ? hits[0].point : null;
    smartObjects.setPlacementTarget(point || null);
  }

  _prepareCursorForPlacement() {
    if (this.input?.controls?.isLocked) {
      this.input.controls.unlock?.();
    } else if (typeof document !== 'undefined' && document.pointerLockElement) {
      try {
        document.exitPointerLock?.();
      } catch { }
    }
    if (!this._pointerNdc) {
      this._pointerNdc = { x: 0, y: 0, has: true };
      return;
    }
    if (!this._pointerNdc.has) {
      this._pointerNdc.x = 0;
      this._pointerNdc.y = 0;
      this._pointerNdc.has = true;
    }
  }

  _handlePointerLockButton() {
    if (this._pointerLockActive) {
      this._setPointerLockArmed(false, { silent: true });
      this.input?.unlockPointer();
      return;
    }
    if (this._pointerLockArmed) {
      this._setPointerLockArmed(false, { silent: true });
      return;
    }
    this._setPointerLockArmed(true);
  }

  _setPointerLockArmed(enabled, { silent = false } = {}) {
    const next = !!enabled;
    if (next === this._pointerLockArmed) return;
    this._pointerLockArmed = next;
    if (!next) {
      this._cancelPointerHold();
    } else if (!silent) {
      pushToast('Click and hold the scene for 1s to lock the pointer', { duration: 2800 });
    }
    this._syncPointerLockButton(true);
  }

  _onCanvasPointerDown(e) {
    const isMouse = !e.pointerType || e.pointerType === 'mouse';
    if (this._pointerLockArmed && !this._pointerLockActive && isMouse && e.button === 0) {
      if (this._pointerLockHoldActive) return;
      this._pointerLockHoldActive = true;
      this._pointerLockHoldPointerId = e.pointerId;
      this._setCanvasHoldVisual(true);
      this._clearPointerHoldTimer();
      this._pointerLockHoldTimer = setTimeout(() => this._commitPointerLock(), 1000);
      return;
    }
    if (!this._pointerLockArmed && !this._pointerLockActive && isMouse && e.button === 0) {
      this._beginOrbitDrag(e);
    }
  }

  _onCanvasPointerUp(e) {
    if (this._pointerLockHoldActive && (e.pointerId == null || e.pointerId === this._pointerLockHoldPointerId)) {
      this._cancelPointerHold();
    }
    this._endOrbitDrag(e);
  }

  _onCanvasPointerLeave(e) {
    if (this._pointerLockHoldActive && (e.pointerId == null || e.pointerId === this._pointerLockHoldPointerId)) {
      this._cancelPointerHold();
    }
    this._endOrbitDrag(e);
  }

  _onCanvasPointerMove(e) {
    if (this._orbitDragActive && e.pointerId === this._orbitDragPointerId) {
      e.preventDefault();
      this._handleOrbitDrag(e);
    }
  }

  _clearPointerHoldTimer() {
    if (this._pointerLockHoldTimer) {
      clearTimeout(this._pointerLockHoldTimer);
      this._pointerLockHoldTimer = null;
    }
  }

  _cancelPointerHold() {
    this._pointerLockHoldActive = false;
    this._pointerLockHoldPointerId = null;
    this._clearPointerHoldTimer();
    this._setCanvasHoldVisual(false);
  }

  _setCanvasHoldVisual(active) {
    const canvas = this.sceneMgr?.renderer?.domElement;
    if (!canvas) return;
    if (active) {
      canvas.classList.add('pointer-lock-arming');
    } else {
      canvas.classList.remove('pointer-lock-arming');
    }
  }

  _commitPointerLock() {
    if (!this._pointerLockArmed || this._pointerLockActive) return;
    if (!this._pointerLockHoldActive) return;
    this._pointerLockHoldActive = false;
    this._clearPointerHoldTimer();
    this._setCanvasHoldVisual(false);
    this._pointerLockHoldPointerId = null;
    this._setPointerLockArmed(false, { silent: true });
    this.input?.lockPointer();
  }

  _beginOrbitDrag(e) {
    if (this._orbitDragActive) return;
    this._orbitDragActive = true;
    this._orbitDragPointerId = e.pointerId;
    this._orbitDragLastX = e.clientX;
    this._orbitDragLastY = e.clientY;
    const canvas = this.sceneMgr?.renderer?.domElement;
    if (canvas) canvas.style.cursor = 'grabbing';
  }

  _handleOrbitDrag(e) {
    if (!this._orbitDragActive || e.pointerId !== this._orbitDragPointerId) return;
    const dx = e.clientX - this._orbitDragLastX;
    const dy = e.clientY - this._orbitDragLastY;
    if (dx === 0 && dy === 0) return;
    this._orbitDragLastX = e.clientX;
    this._orbitDragLastY = e.clientY;
    this._applyDesktopOrbitDelta(dx, dy);
  }

  _endOrbitDrag(e = null) {
    if (!this._orbitDragActive) return;
    if (e && e.pointerId != null && e.pointerId !== this._orbitDragPointerId) return;
    this._orbitDragActive = false;
    this._orbitDragPointerId = null;
    const canvas = this.sceneMgr?.renderer?.domElement;
    if (canvas) canvas.style.cursor = '';
  }

  _applyDesktopOrbitDelta(dx, dy) {
    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return;
    const sensitivity = this._orbitDragSensitivity || 0.0022;
    const yawDelta = -dx * sensitivity;
    let pitchDelta = -dy * sensitivity;
    const currentPitch = this._pitch ?? 0;
    const maxUp = this._pitchMax - currentPitch;
    const maxDown = this._pitchMin - currentPitch;
    pitchDelta = THREE.MathUtils.clamp(pitchDelta, maxDown, maxUp);
    const euler = this._tmpEuler.setFromQuaternion(dolly.quaternion, 'YXZ');
    euler.y += yawDelta;
    euler.x = pitchDelta;
    dolly.quaternion.setFromEuler(euler);
  }

  _handlePointerLockChange(isLocked) {
    this._pointerLockActive = !!isLocked;
    if (!isLocked) {
      this._pointerLockArmed = false;
    }
    this._cancelPointerHold();
    this._endOrbitDrag();
    this._togglePointerLockHint(this._pointerLockActive);
    this._syncPointerLockButton(true);
  }

  _syncPointerLockButton(force = false) {
    const btn = ui.hudPointerLock;
    if (!btn) return;
    const locked = this._pointerLockActive;
    const arming = this._pointerLockArmed && !locked;
    const state = locked ? 'locked' : (arming ? 'arming' : 'idle');
    if (!force && this._pointerLockButtonState === state) return;
    this._pointerLockButtonState = state;
    btn.classList.toggle('on', locked);
    btn.classList.toggle('arming', arming);
    btn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    if (locked) {
      btn.textContent = 'Unlock Pointer';
      btn.title = 'Pointer locked · click to release';
    } else if (arming) {
      btn.textContent = 'Lock Pointer…';
      btn.title = 'Click and hold the scene for 1s to lock';
    } else {
      btn.textContent = 'Lock Pointer';
      btn.title = 'Click to arm pointer lock';
    }
  }

  _togglePointerLockHint(show) {
    const hint = ui.pointerLockHint;
    if (!hint) return;
    if (show) {
      hint.hidden = false;
      requestAnimationFrame(() => hint.classList.add('show'));
    } else {
      hint.classList.remove('show');
      setTimeout(() => {
        if (!hint.classList.contains('show')) {
          hint.hidden = true;
        }
      }, 320);
    }
  }

  _toggleSmartPlacementMode(forceValue = null) {
    const smartObjects = this.sceneMgr?.smartObjects;
    if (!smartObjects) return;
    const next = forceValue == null ? !smartObjects.placementMode : !!forceValue;
    this._setSmartPlacementMode(next);
  }

  _setSmartPlacementMode(enabled) {
    const smartObjects = this.sceneMgr?.smartObjects;
    if (!smartObjects) return;
    const next = !!enabled;
    if (next === smartObjects.placementMode) {
      this._syncPlaceButtonState();
      return;
    }
    if (next) {
      this._prepareCursorForPlacement();
      smartObjects.enterPlacementMode();
      pushToast('Click a terrain tile to place a Smart Object', { duration: 2800 });
    } else {
      smartObjects.cancelPlacementMode();
    }
    this._syncPlaceButtonState(true);
  }

  _syncPlaceButtonState(force = false, activeOverride = null) {
    const btn = ui.hudPlaceToggle;
    if (!btn) return;
    const smartObjects = this.sceneMgr?.smartObjects;
    let active = !!(smartObjects && smartObjects.placementMode);
    if (typeof activeOverride === 'boolean') active = activeOverride;
    if (!force && this._placeBtnState === active) return;
    this._placeBtnState = active;
    btn.classList.toggle('on', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.textContent = active ? 'Place (On)' : 'Place';
    btn.title = active
      ? 'Click a terrain tile to place a Smart Object'
      : 'Toggle smart object placement mode';
  }

  _maybeUpdateSun(origin) {
    const nowMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const hasOrigin = !!this._sunOrigin;
    const latChanged = !hasOrigin || Math.abs(origin.lat - this._sunOrigin.lat) > 1e-4;
    const lonChanged = !hasOrigin || Math.abs(origin.lon - this._sunOrigin.lon) > 1e-4;
    if (latChanged || lonChanged || nowMs >= this._sunUpdateNextMs) {
      this.sceneMgr.updateSun({ lat: origin.lat, lon: origin.lon, date: new Date() });
      this._sunOrigin = { lat: origin.lat, lon: origin.lon };
      this._sunUpdateNextMs = nowMs + 60000;
      this._updateUiThemeBySun();
      this.buildings?.setEnvironment?.(this.sceneMgr.scene.environment || null);
    }
  }

  _onPointerMove(e, dom) {
    const rect = dom.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    this._pointerNdc.x = x * 2 - 1;
    this._pointerNdc.y = -(y * 2 - 1);
    this._pointerNdc.has = true;
    this._pointerLastMoveMs = (performance && performance.now) ? performance.now() : Date.now(); // NEW
    this._hoverDirty = true;
  }

  // === NEW: throttled hover raycast ===
  _updateBuildingHover(xrOn) {
    const hasBuildings = !!this.buildings;
    const hasRemotes = !!this.remotes;
    if (!hasBuildings && !hasRemotes) return;
    if (xrOn) {
      this.buildings?.clearHover();
      this.remotes?.clearHover();
      return;
    }
    if (!this._pointerNdc.has) {
      this.buildings?.clearHover();
      this.remotes?.clearHover();
      return;
    }
    const now = performance?.now ? performance.now() : Date.now();

    if (now - this._pointerLastMoveMs > 3000) {
      this.buildings?.clearHover();
      this.remotes?.clearHover();
      return;
    }
    if (now < this._hoverNextAllowedMs) return;
    this._hoverNextAllowedMs = now + 80; // ~12.5 Hz

    this._raycaster.setFromCamera(this._pointerNdc, this.sceneMgr.camera);
    this.buildings?.updateHover(this._raycaster, this.sceneMgr.camera);
    this.remotes?.updateHover(this._raycaster);
  }

  _setupPhysics() {
    this.physics = new PhysicsEngine({
      sceneManager: this.sceneMgr,
      tileManager: this.hexGridMgr,
      audio: this.audio,
    });

    this.physics.ready.then(() => {
      this.buildings?.setPhysicsEngine(this.physics);
    }).catch(() => { });

    this.physics.collidersReady.then(() => {
      this._physicsPrimed = true;
      const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
      if (this.physics?.configureCharacter) {
        this.physics
          .configureCharacter({ position: this.sceneMgr.dolly.position.clone(), eyeHeight })
          .catch(() => { });
      }
      this._spawnPhysicsProbe();
    }).catch(() => { });
  }

  _spawnPhysicsProbe() {
    if (!this.physics || !this.hexGridMgr || !this._physicsPrimed) return;

    const pos = this.sceneMgr.dolly.position.clone();
    const groundY = this.hexGridMgr.getHeightAt(pos.x, pos.z);
    const origin = new THREE.Vector3(pos.x, groundY, pos.z);
    const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
    const lift = eyeHeight + 3;

    this._testBall = this.physics.spawnTestBall({ origin, lift });
  }
}

new GeoButton();
new App();
