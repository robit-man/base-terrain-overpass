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

const isMobile = /Mobi|Android/i.test(navigator.userAgent);
const RAD = THREE.MathUtils.degToRad;

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

    // Terrain + audio
    this.audio = new AudioEngine(this.sceneMgr);
    this.hexGridMgr = new TileManager(this.sceneMgr.scene, 5, 50, this.audio);

    this.buildings = new BuildingManager({
      scene: this.sceneMgr.scene,
      camera: this.sceneMgr.camera,
      tileManager: this.hexGridMgr,
    });

    document.addEventListener('gps-updated', (ev) => {
      const { lat, lon } = ev.detail;
      this.buildings?.setOrigin(lat, lon);
    });

    ipLocate();

    // Motion / physics shim (jump, crouch, mobile drag, eye height)
    this.move = new Locomotion(this.sceneMgr, this.input, this.sensors.orient);
    this.clock = new THREE.Clock();

    // UI poller
    this._uiTimer = setInterval(() => this._updateLocalPoseUI(), 200);

    // Networking
    this.remotes = new Remotes(this.sceneMgr, (x, z) => this.hexGridMgr.getHeightAt(x, z));
    this.mesh = new Mesh(this);

    // Local third-person avatar shell (hidden when true FPV or XR)
    this.localAvatar = null;
    this.avatarFactoryPromise = AvatarFactory.load()
      .then(factory => {
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

    this.sceneMgr.renderer.setAnimationLoop(() => this._tick());
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

    // Terrain sampling + tiles
    const pos = dolly.position;
    const groundY = this.hexGridMgr.getHeightAt(pos.x, pos.z);
    this.hexGridMgr.update(pos);
    this.buildings?.update(dt);
    this._updateBuildingHover(xrOn);

    // Locomotion (eye height, jump, drag-move on mobile)
    this.move.update(dt, groundY, xrOn);

    // Failsafe: keep rig above ground + current eye height
    const minY = groundY + this.move.eyeHeight();
    if (dolly.position.y < minY) dolly.position.y = minY;

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
    const actualY = groundY + this.move.eyeHeight();
    const eSend = new THREE.Euler().setFromQuaternion(dolly.quaternion, 'YXZ');
    const qSend = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, eSend.y, 0, 'YXZ'));
    const jumpEvt = this.move.popJumpStarted();
    this.mesh.sendPoseIfChanged(dolly.position, qSend, actualY, jumpEvt);

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
}

new GeoButton();
new App();
