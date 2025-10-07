// app.js — drop-in replacement with non-breaking optimizations
import * as THREE from 'three';
import { SceneManager } from './scene.js';
import { Sensors, GeoButton } from './sensors.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { TileManager } from './tiles.js';
import { ipLocate, latLonToWorld, worldToLatLon } from './geolocate.js';
import { Locomotion } from './locomotion.js';
import { Remotes } from './remotes.js';
import { Mesh } from './mesh.js';
import { ui, applyHudStatusDot } from './ui.js';
import { deg } from './utils.js';
import { AvatarFactory } from './avatars.js';
import { ChaseCam } from './chasecam.js';
import { BuildingManager } from './buildings.js';
import { PhysicsEngine } from './physics.js';
import { MiniMap } from './minimap.js';
import { PerformanceTuner } from './performance.js';

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
    return frameDuration;
  }
}

const isMobile = /Mobi|Android/i.test(navigator.userAgent);
const RAD = THREE.MathUtils.degToRad;
const MANUAL_LOCATION_KEY = 'xr.manualLocation.v1';
const GPS_LOCK_KEY = 'xr.gpsLockEnabled.v1';
const COMPASS_YAW_KEY = 'xr.useCompassYaw.v1';
const PLAYER_POSE_KEY = 'xr.playerPose.v1';
const DEFAULT_TERRAIN_DATASET = 'mapzen';

class App {
  constructor() {
    if (location.protocol !== 'https:') {
      location.href = 'https:' + window.location.href.substring(location.protocol.length);
      return;
    }

    // Core systems
    this.sceneMgr = new SceneManager();

    // === NEW: cap pixel ratio to avoid overdraw on HiDPI ===
    try {
      const pr = Math.min(window.devicePixelRatio || 1, 1.5);
      this.sceneMgr.renderer.setPixelRatio(pr);
    } catch {}

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

    this._perf = new PerformanceTuner({ targetFps: 60, minQuality: 0.35, maxQuality: 1.05 });
    this._perfSnapshots = { tiles: null, buildings: null };
    this._hudHeadingState = { deg: null, source: null };
    this._hudMetaCached = null;
    this._hudGeoCached = { lat: null, lon: null };

    // === NEW: throttling state (non-breaking) ===
    this._hoverNextAllowedMs = 0;
    this._pointerLastMoveMs = 0;
    this._miniMapNextMs = 0;
    this._lastHexUpdatePos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._nextHexUpdateMs = 0;
    this._nextBuildingsUpdateMs = 0;
    this._hudGeoNextMs = 0;
    this._hudGeoLastPos = new THREE.Vector3(Infinity, Infinity, Infinity);
    this._perfLogger = new PerfLogger({ slowFrameMs: 33, reportIntervalMs: 2000, labelLimit: 6 });
    this._sunUpdateNextMs = 0;
    this._sunOrigin = null;

    // Terrain + audio
    this.audio = new AudioEngine(this.sceneMgr);
    this._meshClientPromise = null;
    const terrainClientProvider = () => this._getMeshClient();
    this.hexGridMgr = new TileManager(this.sceneMgr.scene, 10, 100, this.audio, {
      terrainRelayClient: terrainClientProvider,
    });

    this.buildings = new BuildingManager({
      scene: this.sceneMgr.scene,
      camera: this.sceneMgr.camera,
      tileManager: this.hexGridMgr,
    });

    const initialProfile = this._perf.profile();
    const initialTiles = this.hexGridMgr.applyPerfProfile?.(initialProfile) || null;
    const initialBuildings = this.buildings.applyPerfProfile?.(initialProfile) || null;
    if (initialTiles) this._perfSnapshots.tiles = initialTiles;
    if (initialBuildings) this._perfSnapshots.buildings = initialBuildings;
    this._updateHudMeta(initialProfile);
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
    this._gpsLockEnabled = true;
    const storedGpsLock = this._loadGpsLockPref();
    if (storedGpsLock != null) this._gpsLockEnabled = storedGpsLock;
    const storedCompass = this._loadCompassPref();
    if (storedCompass != null) this._compassEnabled = storedCompass;

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

    // Motion / physics shim (jump, crouch, mobile drag, eye height)
    this.move = new Locomotion(this.sceneMgr, this.input, this.sensors.orient);
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

    if (isMobile && 'geolocation' in navigator) {
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

    // Local avatar shell
    this.localAvatar = null;
    this.avatarFactoryPromise
      .then(factory => {
        if (!factory) return;
        this.localAvatar = factory.create();
        this.localAvatar.group.name = 'local-avatar';
        this.sceneMgr.remoteLayer.add(this.localAvatar.group);
      })
      .catch(() => {});

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
    const dom = this.sceneMgr.renderer.domElement;
    window.addEventListener('pointermove', (e) => this._onPointerMove(e, dom), { passive: true });
    window.addEventListener('pointerleave', () => {
      this._pointerNdc.has = false;
      this.buildings?.clearHover();
    });
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement) {
        this._pointerNdc.x = 0;
        this._pointerNdc.y = 0;
        this._pointerNdc.has = true;
      } else {
        this._pointerNdc.has = false;
      }
    });
    this._raycaster = new THREE.Raycaster();
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();
    this._tmpVec3 = new THREE.Vector3();
    this._tmpVec4 = new THREE.Vector3();
    this._tmpVec5 = new THREE.Vector3();
    this._tmpVec6 = new THREE.Vector3();
    this._tmpQuat = new THREE.Quaternion();
    this._tmpQuat2 = new THREE.Quaternion();
    this._tmpEuler = new THREE.Euler();
    this._headingBasis = new THREE.Vector3(0, 0, -1);
    this._headingWorld = new THREE.Vector3();

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
      gpsToggle.disabled = !('geolocation' in navigator);
      gpsToggle.addEventListener('change', () => {
        this._gpsLockEnabled = !!gpsToggle.checked;
        this._storeGpsLockPref(this._gpsLockEnabled);
        if (!this._gpsLockEnabled && this._mobileNav) {
          this._mobileNav.active = false;
          this._mobileNav.initialized = false;
          this._mobileNav.velocity?.set?.(0, 0, 0);
          this._compassYawOffset = 0;
          this._compassYawConfidence = 0;
          this._compassLastUpdate = 0;
        }
        if (this._gpsLockEnabled && this._lastAutoLocation) {
          this._handleGpsUpdate({ ...this._lastAutoLocation, force: true });
        }
      });
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

    this._terrainStatusEl = ui.terrainRelayStatus || null;
    this._hudTerrainDot = ui.hudStatusTerrainDot || null;
    this._hudTerrainLabel = ui.hudStatusTerrainLabel || null;

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

    if (this._locationState) {
      this.miniMap.notifyLocationChange({
        lat: this._locationState.lat,
        lon: this._locationState.lon,
        source: this._locationSource,
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

    const rank = this._locationRank?.[source] ?? this._locationRank.unknown;
    const currentRank = this._locationRank?.[this._locationSource] ?? this._locationRank.unknown;
    const force = detail.force === true;

    if (!force && rank < currentRank) {
      if (source !== 'manual') {
        this._lastAutoLocation = { lat, lon, source };
        this._locationState = { lat, lon };
      }
      return;
    }

    if (!force && rank === currentRank && this._locationState) {
      const deltaLat = Math.abs(lat - this._locationState.lat);
      const deltaLon = Math.abs(lon - this._locationState.lon);
      const sameCoords = deltaLat < 1e-7 && deltaLon < 1e-7;
      if (sameCoords && source !== 'manual') return;
    }

    const shouldLock = this._gpsLockEnabled || source === 'manual';
    const detailForApply = { ...detail };
    if (!shouldLock && source !== 'manual' && detailForApply.recenter == null) {
      detailForApply.recenter = false;
    }

    this._applyLocation({ lat, lon, source, detail: detailForApply });

    if (isMobile && this._mobileNav && source !== 'manual') {
      if (this._gpsLockEnabled) {
        this._updateMobileNavFromGps({ ...detail, lat, lon, incremental: false });
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

    this.hexGridMgr?.setOrigin(lat, lon, { immediate: isManualRequest });
    this.buildings?.setOrigin(lat, lon, { forceRefresh: isManualRequest });
    if (isManualRequest) {
      this.physics?.resetTerrain?.();
      this._poseStoredState = null;
      this._poseLatestState = null;
      this._poseDirty = true;
      this._poseSaveTimer = 0;
      this._poseRestored = false;
      this._pendingPoseRestore = null;
    }

    const allowRecenter = detail.recenter !== false && (this._gpsLockEnabled || source === 'manual');
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

    this.miniMap?.notifyLocationChange?.({ lat, lon, source, detail });
    this.miniMap?.forceRedraw?.();
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

  _snapToCompassHeading(explicitHeadingRad = null) {
    const heading = Number.isFinite(explicitHeadingRad) ? explicitHeadingRad : this.sensors?.headingRad;
    if (!Number.isFinite(heading)) return false;
    if (!this.move?.snapToHeading) return false;
    return this.move.snapToHeading(heading);
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
    if (!('geolocation' in navigator)) return;
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

    this._updateCompassCorrection({
      headingRad: headingRadFromDetail,
      deltaWorld,
      speed: Number.isFinite(nav.speed) ? nav.speed : null,
    });

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

    const yawInfo = this.sensors.getYawPitch?.();
    const manualOffset = Number.isFinite(this._manualYawOffset) ? this._manualYawOffset : 0;
    const compassOffset = this._getCompassYawOffset() || 0;
    const totalOffset = this._wrapAngle(compassOffset + manualOffset);

    if (yawInfo?.ready && Number.isFinite(yawInfo.yaw)) {
      this._tmpEuler.setFromQuaternion(dolly.quaternion, 'YXZ');
      this._tmpEuler.y = this._wrapAngle(yawInfo.yaw + totalOffset);
      dolly.quaternion.setFromEuler(this._tmpEuler);
    } else if (Number.isFinite(nav.headingRad)) {
      this._tmpEuler.setFromQuaternion(dolly.quaternion, 'YXZ');
      this._tmpEuler.y = this._wrapAngle(nav.headingRad + totalOffset);
      dolly.quaternion.setFromEuler(this._tmpEuler);
    }

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
    const majorMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: lineOpacity, depthTest: false, depthWrite: false });
    const mediumMat = new THREE.MeshBasicMaterial({ color: 0xb8c4ff, transparent: true, opacity: lineOpacity, depthTest: false, depthWrite: false });
    const minorMat = new THREE.MeshBasicMaterial({ color: 0x6f758c, transparent: true, opacity: lineOpacity, depthTest: false, depthWrite: false });

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

    const readout = this._makeCompassLabel('000°', { color: '#ffe082', size: 0.05, fontSize: 50, weight: '600' });
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

    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false });
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

  _updateCompassCorrection({ headingRad = null, deltaWorld = null, speed = null }) {
    if (!this._gpsLockEnabled || !this._compassEnabled) return;
    const yawInfo = this.sensors.getYawPitch?.();
    if (!yawInfo?.ready) return;
    const sensorYaw = yawInfo.yaw;
    if (!Number.isFinite(sensorYaw)) return;

    let targetYaw = Number.isFinite(headingRad) ? headingRad : null;

    if (!Number.isFinite(targetYaw) && deltaWorld) {
      const { dx = 0, dz = 0 } = deltaWorld;
      const distSq = dx * dx + dz * dz;
      if (distSq > 0.09) {
        targetYaw = Math.atan2(dx, -dz);
      }
    }

    if (!Number.isFinite(targetYaw)) return;

    const diff = this._wrapAngle(targetYaw - sensorYaw);
    if (this._compassYawConfidence <= 0) {
      this._compassYawOffset = diff;
    } else {
      const delta = this._wrapAngle(diff - this._compassYawOffset);
      const weight = Number.isFinite(speed)
        ? THREE.MathUtils.clamp(Math.abs(speed) / 5, 0.08, 0.3)
        : 0.12;
      this._compassYawOffset = this._wrapAngle(this._compassYawOffset + delta * weight);
    }

    this._compassYawConfidence = Math.min(1, this._compassYawConfidence + 0.2);
    const now = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
    this._compassLastUpdate = now;
  }

  _updateCompassDial() {
    if (!this._compassDial) return;
    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return;

    const forward = this._headingWorld.copy(this._headingBasis).applyQuaternion(dolly.quaternion);
    const headingRad = Math.atan2(forward.x, -forward.z);
    this._compassDial.rotation.set(0, headingRad, 0);

    if (this._compassReadoutSprite?.userData?.updateText) {
      const headingDeg = (THREE.MathUtils.radToDeg(headingRad) + 360) % 360;
      const rounded = Math.round(headingDeg);
      if (this._compassReadoutValue == null || Math.abs(this._compassReadoutValue - rounded) >= 1) {
        this._compassReadoutValue = rounded;
        const padded = `${rounded.toString().padStart(3, '0')}°`;
        this._compassReadoutSprite.userData.updateText(padded);
      }
    }
  }

  // Old, proven mapping: (beta, alpha, -gamma) YXZ then align device frame by Rx(-90°).
  _deviceQuatForFPV(orient) {
    const a = orient?.a || 0; // alpha (Z)
    const b = orient?.b || 0; // beta  (X)
    const g = orient?.g || 0; // gamma (Y)
    const euler = new THREE.Euler(RAD(b), RAD(a), RAD(-g), 'YXZ');
    const q = new THREE.Quaternion().setFromEuler(euler);
    const rxMinus90 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    q.multiply(rxMinus90);
    return q;
  }

  _enterMobileFPV() {
    if (this._mobileFPVOn) return;

    const oldCam = this.sceneMgr.camera;
    if (!(oldCam instanceof THREE.PerspectiveCamera)) {
      const cam = new THREE.PerspectiveCamera(75, oldCam.aspect || innerWidth / innerHeight, 0.05, 100000);
      cam.position.set(0, 0, 0);
      cam.rotation.set(0, 0, 0);
      try { this.sceneMgr.dolly.remove(oldCam); } catch {}
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
    this.chase.minBoom = 0.0;
    this.chase.maxBoom = 0.0;

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

  _formatPerfLabel(perfState) {
    const pct = Math.round(THREE.MathUtils.clamp(perfState?.quality ?? 1, 0, 1.05) * 100);
    const level = perfState?.level ? perfState.level.charAt(0).toUpperCase() + perfState.level.slice(1) : 'Adaptive';
    return `LOD ${pct}% · ${level}`;
  }

  _formatPerfDetail(perfState, snapshots = {}) {
    const tileSnap = snapshots.tiles || {};
    const buildingSnap = snapshots.buildings || {};
    const tileNear = Number.isFinite(tileSnap.interactiveRing) ? tileSnap.interactiveRing : null;
    const tileFar = Number.isFinite(tileSnap.visualRing) ? tileSnap.visualRing : null;
    const buildBudget = Number.isFinite(buildingSnap.frameBudget) ? buildingSnap.frameBudget : null;
    const mergeBudget = Number.isFinite(buildingSnap.mergeBudget) ? buildingSnap.mergeBudget : null;
    const radiusMeters = Number.isFinite(buildingSnap.radius) ? Math.round(buildingSnap.radius) : null;

    const formatMs = (value) => (Number.isFinite(value) ? value.toFixed(2) : '--');

    return {
      tiles: `${tileNear != null ? tileNear : '--'} / ${tileFar != null ? tileFar : '--'}`,
      build: `${formatMs(buildBudget)} / ${formatMs(mergeBudget)} ms`,
      radius: radiusMeters != null ? `${radiusMeters} m` : '--',
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

  _updateHudGeo({ lat, lon } = {}) {
    if (!ui.hudLat || !ui.hudLon) return;

    const latLabel = Number.isFinite(lat) ? lat.toFixed(5) : '--';
    const lonLabel = Number.isFinite(lon) ? lon.toFixed(5) : '--';
    const latTitle = Number.isFinite(lat) ? `Latitude ${lat.toFixed(7)}` : 'Latitude unavailable';
    const lonTitle = Number.isFinite(lon) ? `Longitude ${lon.toFixed(7)}` : 'Longitude unavailable';

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
  }

  _updateLocalPoseUI() {
    const { dolly } = this.sceneMgr;

    const e = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
    const p = dolly.position;

    ui.lpPos.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    ui.lpEul.textContent = `${deg(e.y).toFixed(1)}/${deg(e.x).toFixed(1)}/0.0`;
    ui.lpSpd.textContent = `${this.move.speed().toFixed(2)} m/s`;
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
        } catch {}
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
      camera.rotation.set(clamped, 0, 0);
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
    const begin = logger ? (label) => logger.begin(label) : () => {};
    const end = logger ? (label) => logger.end(label) : () => 0;

    const dt = this.clock.getDelta();
    const currentTargetFps = this._perf.profile().targetFps;
    const fpsSample = dt > 0.5 ? currentTargetFps : (dt > 1e-4 ? 1 / dt : currentTargetFps);
    const perfState = measure('perf.sample', () => this._perf.sample({ dt, fps: fpsSample }));

    if (perfState.qualityChanged || perfState.hudReady) {
      const tileSummary = measure('tiles.applyProfile', () => this.hexGridMgr?.applyPerfProfile?.(perfState) || null);
      const buildingSummary = measure('buildings.applyProfile', () => this.buildings?.applyPerfProfile?.(perfState) || null);
      if (tileSummary) this._perfSnapshots.tiles = tileSummary;
      if (buildingSummary) this._perfSnapshots.buildings = buildingSummary;
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
          const q = this._deviceQuatForFPV(this.sensors.orient);
          const compassOffset = this._getCompassYawOffset() || 0;
          const manualOffset = Number.isFinite(this._manualYawOffset) ? this._manualYawOffset : 0;
          const totalOffset = this._wrapAngle(compassOffset + manualOffset);
          if (Math.abs(totalOffset) > 1e-4) {
            const yawQuat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), totalOffset);
            q.multiply(yawQuat);
          }
          dolly.quaternion.copy(q);
          camera.rotation.set(0, 0, 0);
          camera.up.set(0, 1, 0);
        } else {
          const e = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
          const yawAbs = e.y;
          const pitchDelta = e.x;
          this._pitch = THREE.MathUtils.clamp(this._pitch + pitchDelta, this._pitchMin, this._pitchMax);
          dolly.rotation.set(0, yawAbs, 0);
          camera.rotation.set(this._pitch, 0, 0);
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

    if (this.localAvatar) {
      measure('avatar.local', () => {
        const yawOnly = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ').y;
        const qYaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yawOnly, 0, 'YXZ'));
        const baseEyeHeight = this.move.baseEyeHeight?.() ?? eyeHeight;
        const jumpLift = Math.max(0, eyeHeight - baseEyeHeight);
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
      const actualY = groundY + eyeHeight;
      const eSend = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
      const qSend = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, eSend.y, 0, 'YXZ'));
      const jumpEvt = this.move.popJumpStarted();
      if (jumpEvt && this.physics?.suspendCharacterSnap) {
        const hangTime = this.move?.jumpHangTime?.() ?? 0;
        const resumeDelay = Number.isFinite(hangTime) && hangTime > 0
          ? THREE.MathUtils.clamp(hangTime * 0.55, 0.2, 0.8)
          : 0.35;
        this.physics.suspendCharacterSnap(resumeDelay);
      }
      const crouchActive = this.move.isCrouching?.() ?? false;
      this.mesh.sendPoseIfChanged(dolly.position, qSend, actualY, jumpEvt, crouchActive);
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
        if (hudLatLon) this._updateHudGeo(hudLatLon);
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

    logger?.frameEnd?.();
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
    }).catch(() => {});

    this.physics.collidersReady.then(() => {
      this._physicsPrimed = true;
      const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
      if (this.physics?.configureCharacter) {
        this.physics
          .configureCharacter({ position: this.sceneMgr.dolly.position.clone(), eyeHeight })
          .catch(() => {});
      }
      this._spawnPhysicsProbe();
    }).catch(() => {});
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
