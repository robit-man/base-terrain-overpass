// app.js — drop-in replacement
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
import { ui } from './ui.js';
import { deg } from './utils.js';
import { AvatarFactory } from './avatars.js';
import { ChaseCam } from './chasecam.js';
import { BuildingManager } from './buildings.js';
import { PhysicsEngine } from './physics.js';
import { MiniMap } from './minimap.js';

const isMobile = /Mobi|Android/i.test(navigator.userAgent);
const RAD = THREE.MathUtils.degToRad;
const MANUAL_LOCATION_KEY = 'xr.manualLocation.v1';
const GPS_LOCK_KEY = 'xr.gpsLockEnabled.v1';
const COMPASS_YAW_KEY = 'xr.useCompassYaw.v1';

class App {
  constructor() {
    // Force HTTPS for sensors & XR
    if (location.protocol !== 'https:') {
      location.href = 'https:' + window.location.href.substring(location.protocol.length);
      return;
    }

    // Core systems
    this.sceneMgr = new SceneManager();
    this.sensors = new Sensors();
    this.input = new Input(this.sceneMgr);
    this._physicsPrimed = false;

    // Terrain + audio
    this.audio = new AudioEngine(this.sceneMgr);
    this.hexGridMgr = new TileManager(this.sceneMgr.scene, 5, 50, this.audio);

    this.buildings = new BuildingManager({
      scene: this.sceneMgr.scene,
      camera: this.sceneMgr.camera,
      tileManager: this.hexGridMgr,
    });

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

    document.addEventListener('gps-updated', (ev) => this._handleGpsUpdate(ev.detail));

    const storedManual = this._loadStoredManualLocation();
    if (storedManual) {
      this._handleGpsUpdate({ ...storedManual, source: 'manual', persisted: true });
    }

    ipLocate();

    // Motion / physics shim (jump, crouch, mobile drag, eye height)
    this.move = new Locomotion(this.sceneMgr, this.input, this.sensors.orient);
    this.clock = new THREE.Clock();
    this._perf = { targetFps: 60, smoothedFps: 60, accum: 0 };
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

    // Avatars for both the local player and remote peers share the same factory promise.
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

    // Local third-person avatar shell (hidden when true FPV or XR)
    this.localAvatar = null;
    this.avatarFactoryPromise
      .then(factory => {
        if (!factory) return;
        this.localAvatar = factory.create();
        this.localAvatar.group.name = 'local-avatar';
        this.sceneMgr.remoteLayer.add(this.localAvatar.group);
      })
      .catch(() => {});

    // Third-person chase cam (we'll bypass it in mobile FPV)
    this.chase = new ChaseCam(this.sceneMgr, () => this.move.eyeHeight());

    // Desktop pitch accumulator (mouse look). Camera carries pitch on desktop only.
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
      canvas: document.getElementById('miniMapCanvas'),
      statusEl: document.getElementById('miniMapStatus'),
      recenterBtn: document.getElementById('miniMapRecenter'),
      setBtn: document.getElementById('miniMapSet'),
      tileManager: this.hexGridMgr,
      getWorldPosition: () => this.sceneMgr?.dolly?.position,
      getHeadingDeg: () => {
        const dolly = this.sceneMgr?.dolly;
        if (!dolly) return 0;
        const forward = this._headingWorld.copy(this._headingBasis).applyQuaternion(dolly.quaternion);
        const deg = (Math.atan2(forward.x, forward.z) * 180) / Math.PI;
        return (deg + 360) % 360;
      },
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

    if (!shouldLock && source !== 'manual') {
      this._locationSource = source;
      this._locationState = { lat, lon };
      this._lastAutoLocation = { lat, lon, source };
      this.miniMap?.notifyLocationChange?.({ lat, lon, source, detail });
      this.miniMap?.forceRedraw?.();
      return;
    }

    this._applyLocation({ lat, lon, source, detail });

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

    this.hexGridMgr?.setOrigin(lat, lon);
    this.buildings?.setOrigin(lat, lon);

    const allowRecenter = detail.recenter !== false && (this._gpsLockEnabled || source === 'manual');
    if (allowRecenter) {
      this._resetPlayerPosition();
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

  _resetPlayerPosition() {
    const dolly = this.sceneMgr?.dolly;
    if (!dolly) return;
    const eyeHeight = this.move?.eyeHeight?.() ?? 1.6;
    const groundY = this.hexGridMgr?.getHeightAt?.(0, 0) ?? 0;
    dolly.position.set(0, groundY + eyeHeight, 0);
    this.physics?.setCharacterPosition?.(dolly.position, eyeHeight);
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
    if (yawInfo?.ready) {
      this._tmpEuler.setFromQuaternion(dolly.quaternion, 'YXZ');
      this._tmpEuler.y = this._wrapAngle(yawInfo.yaw + this._getCompassYawOffset());
      dolly.quaternion.setFromEuler(this._tmpEuler);
    } else if (Number.isFinite(nav.headingRad)) {
      this._tmpEuler.setFromQuaternion(dolly.quaternion, 'YXZ');
      this._tmpEuler.y = this._wrapAngle(nav.headingRad + this._getCompassYawOffset());
      dolly.quaternion.setFromEuler(this._tmpEuler);
    }

    if (this.hexGridMgr?.origin) {
      const fused = worldToLatLon(dolly.position.x, dolly.position.z, this.hexGridMgr.origin.lat, this.hexGridMgr.origin.lon);
      if (fused) nav.fusedLatLon = fused;
    }
  }

  /* ---------- Helpers ---------- */

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

    // Ensure a Perspective camera mounted at the dolly origin (first-person)
    const oldCam = this.sceneMgr.camera;
    if (!(oldCam instanceof THREE.PerspectiveCamera)) {
      const cam = new THREE.PerspectiveCamera(75, oldCam.aspect || innerWidth / innerHeight, 0.05, 1000);
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

    // Lock chase boom to 0 (true first-person), and we’ll skip ChaseCam.update while FPV
    this.chase.targetBoom = 0.0;
    this.chase.boom = 0.0;
    this.chase.minBoom = 0.0;
    this.chase.maxBoom = 0.0;

    this._mobileFPVOn = true;
  }

  /* ---------- UI ---------- */
  _updateLocalPoseUI() {
    const { dolly } = this.sceneMgr;

    // Yaw/pitch read from dolly orientation (camera inherits dolly rotation in mobile FPV)
    const e = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
    const p = dolly.position;

    ui.lpPos.textContent = `${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}`;
    ui.lpEul.textContent = `${deg(e.y).toFixed(1)}/${deg(e.x).toFixed(1)}/0.0`;
    ui.lpSpd.textContent = `${this.move.speed().toFixed(2)} m/s`;
  }

  /* ---------- Main loop ---------- */
  _tick() {
    const dt = this.clock.getDelta();
    const fpsSample = dt > 0.5 ? this._perf.targetFps : (dt > 1e-4 ? 1 / dt : this._perf.targetFps);
    const alpha = 0.1;
    this._perf.smoothedFps = this._perf.smoothedFps * (1 - alpha) + fpsSample * alpha;
    this._perf.accum += dt;
    if (this._perf.accum >= 0.3) {
      if (ui.hudFps) ui.hudFps.textContent = Math.round(this._perf.smoothedFps);
      this.buildings?.updateQoS?.({ fps: this._perf.smoothedFps, target: this._perf.targetFps });
      this._perf.accum = 0;
    }

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

    // One-time switch to FPV when mobile sensors are authorized & present
    if (this._mobileFPVArmed && this.sensors?.orient?.ready && !xrOn) {
      this._enterMobileFPV();
      this._mobileFPVArmed = false;
    }

    // === ORIENTATION / LOOK ===
    if (!xrOn) {
      if (this._mobileFPVOn && this.sensors?.orient?.ready) {
        // MOBILE FPV: direct 1:1 mapping from device → dolly. Camera inherits (no extra pitch writes).
        const q = this._deviceQuatForFPV(this.sensors.orient);
        const yawOffset = this._getCompassYawOffset();
        if (yawOffset) {
          this._tmpEuler.setFromQuaternion(q, 'YXZ');
          this._tmpEuler.y = this._wrapAngle(this._tmpEuler.y + yawOffset);
          q.setFromEuler(this._tmpEuler);
        }
        dolly.quaternion.copy(q);
        // Enforce camera local zero so it precisely inherits dolly rotation
        camera.rotation.set(0, 0, 0);
        camera.up.set(0, 1, 0);
      } else {
        // DESKTOP: yaw on dolly, pitch on camera (PointerLock injected into dolly.quaternion)
        const e = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
        const yawAbs = e.y;
        const pitchDelta = e.x; // pointer-lock delivered pitch delta through dolly.x

        this._pitch = THREE.MathUtils.clamp(this._pitch + pitchDelta, this._pitchMin, this._pitchMax);

        // Keep body upright; camera carries pitch
        dolly.rotation.set(0, yawAbs, 0);
        camera.rotation.set(this._pitch, 0, 0);
        camera.up.set(0, 1, 0);
      }
    }

    const prevPos = this._tmpVec.copy(dolly.position);
    const baseGroundY = this.hexGridMgr.getHeightAt(prevPos.x, prevPos.z);

    // Locomotion (eye height, jump, drag-move on mobile)
    this.move.update(dt, baseGroundY, xrOn);

    const eyeHeight = this.move.eyeHeight();
    const desiredMove = this._tmpVec2.copy(dolly.position).sub(prevPos);
    desiredMove.y = 0;

    let allowedMove = desiredMove;
    if (this.physics?.isCharacterReady?.()) {
      allowedMove = this.physics.resolveCharacterMovement(prevPos, eyeHeight, desiredMove);
    }
    if (allowedMove) allowedMove.y = 0;
    if (!allowedMove) {
      desiredMove.set(0, 0, 0);
      allowedMove = desiredMove;
    }

    const desiredLen = desiredMove.length();
    const allowedLen = allowedMove.length();
    const impactLoss = Math.max(0, desiredLen - allowedLen);
    if (impactLoss > 0.02 && desiredLen > 0.05 && this.physics?.notifyCharacterImpact) {
      const impactPos = this._tmpVec4.copy(prevPos).addScaledVector(allowedMove, 0.5);
      const intensity = THREE.MathUtils.clamp(impactLoss * 8, 0.12, 2.5);
      this.physics.notifyCharacterImpact(impactPos, intensity);
    }

    const finalPos = this._tmpVec3.copy(prevPos).add(allowedMove);
    let groundY = this.hexGridMgr.getHeightAt(finalPos.x, finalPos.z);
    finalPos.y = groundY + eyeHeight;

    dolly.position.copy(finalPos);

    if (this._mobileNav?.active) {
      this._updateMobileAutopilot(dt);
    }

    this._updateCompassDial();

    this.hexGridMgr.update(dolly.position);
    this.buildings?.update(dt);
    this._updateBuildingHover(xrOn);

    const pos = dolly.position;
    groundY = this.hexGridMgr.getHeightAt(pos.x, pos.z);
    dolly.position.y = groundY + eyeHeight;
    this.physics?.setCharacterPosition?.(dolly.position, eyeHeight);

    // Local avatar drive & visibility
    if (this.localAvatar) {
      const yawOnly = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ').y;
      const qYaw = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yawOnly, 0, 'YXZ'));
      this.localAvatar.setPosition(pos.x, groundY, pos.z);
      this.localAvatar.setQuaternion(qYaw);
      this.localAvatar.setSpeed(this.move.speed());
      this.localAvatar.update(dt);

      const isFP = this._mobileFPVOn || this.chase.isFirstPerson?.();
      this.localAvatar.group.visible = !(xrOn || isFP);
    }

    // Remote anims (jump arcs, stick resize)
    this.remotes.tick(dt);

    // Camera boom/positioning:
    //   - In mobile FPV, we skip ChaseCam.update entirely to avoid any rotation meddling.
    //   - In XR or desktop (3rd-person), let it run normally.
    if (!this._mobileFPVOn || xrOn) {
      this.chase.update(dt, xrOn);
    }

    // Pose broadcast (yaw-only quaternion so remotes stay upright)
    const actualY = groundY + eyeHeight;
    const eSend = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
    const qSend = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, eSend.y, 0, 'YXZ'));
    const jumpEvt = this.move.popJumpStarted();
    this.mesh.sendPoseIfChanged(dolly.position, qSend, actualY, jumpEvt);

    this.physics?.update(dt);

    this.miniMap?.update();

    // Render
    renderer.render(this.sceneMgr.scene, camera);
  }

  _onPointerMove(e, dom) {
    const rect = dom.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    this._pointerNdc.x = x * 2 - 1;
    this._pointerNdc.y = -(y * 2 - 1);
    this._pointerNdc.has = true;
  }

  _updateBuildingHover(xrOn) {
    if (!this.buildings) return;
    if (xrOn) {
      this.buildings.clearHover();
      return;
    }
    if (!this._pointerNdc.has) {
      this.buildings.clearHover();
      return;
    }
    this._raycaster.setFromCamera(this._pointerNdc, this.sceneMgr.camera);
    this.buildings.updateHover(this._raycaster, this.sceneMgr.camera);
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
