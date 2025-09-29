// app.js — drop-in replacement
import * as THREE from 'three';
import { SceneManager } from './scene.js';
import { Sensors, GeoButton } from './sensors.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { TileManager } from './tiles.js';
import { ipLocate } from './geolocate.js';
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

    document.addEventListener('gps-updated', (ev) => this._handleGpsUpdate(ev.detail));

    const storedManual = this._loadStoredManualLocation();
    if (storedManual) {
      this._handleGpsUpdate({ ...storedManual, source: 'manual', persisted: true });
    }

    ipLocate();

    // Motion / physics shim (jump, crouch, mobile drag, eye height)
    this.move = new Locomotion(this.sceneMgr, this.input, this.sensors.orient);
    this.clock = new THREE.Clock();

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
    this._headingBasis = new THREE.Vector3(0, 0, -1);
    this._headingWorld = new THREE.Vector3();

    const manualLatInput = document.getElementById('miniMapLat');
    const manualLonInput = document.getElementById('miniMapLon');
    const manualApplyBtn = document.getElementById('miniMapApply');

    this._manualLatInput = manualLatInput;
    this._manualLonInput = manualLonInput;

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
    const rank = this._locationRank?.[source] ?? this._locationRank.unknown;
    const currentRank = this._locationRank?.[this._locationSource] ?? this._locationRank.unknown;
    const force = detail.force === true;

    if (!force && rank < currentRank) return;

    if (!force && rank === currentRank && this._locationState) {
      const deltaLat = Math.abs(lat - this._locationState.lat);
      const deltaLon = Math.abs(lon - this._locationState.lon);
      const sameCoords = deltaLat < 1e-7 && deltaLon < 1e-7;
      if (sameCoords && source !== 'manual') return;
    }

    this._applyLocation({ lat, lon, source, detail });
  }

  _applyLocation({ lat, lon, source, detail = {} }) {
    this._locationSource = source;
    this._locationState = { lat, lon };

    if (this._manualLatInput) this._manualLatInput.value = lat.toFixed(6);
    if (this._manualLonInput) this._manualLonInput.value = lon.toFixed(6);

    this.hexGridMgr?.setOrigin(lat, lon);
    this.buildings?.setOrigin(lat, lon);

    if (detail.recenter !== false) {
      this._resetPlayerPosition();
    }

    if (source === 'manual') {
      if (!detail.persisted) this._storeManualLocation(lat, lon);
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

  /* ---------- Helpers ---------- */

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
