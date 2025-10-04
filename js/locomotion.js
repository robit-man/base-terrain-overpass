import * as THREE from 'three';
import { XRControllerModelFactory } from 'XRControllerModelFactory';
import { rad, isMobile } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Locomotion {
  constructor(sceneMgr, input, orientationRef) {
    this.sceneMgr = sceneMgr; this.input = input; this.orientationRef = orientationRef || { ready: false };
    this.baseSpeed = 2; this.runMul = 2.5; this._spd = 0;
    this.GRAV = 20;
    this.baseEye = 1.6; this.crouchEye = 0.9; this.jumpPeak = 2.4;
    this.eyeY = this.baseEye; this.vertVel = 0; this.jumpState = 'idle';
    this.CROUCH_EASE = 6; this._jumpJustStarted = false;
    this._pendingHangTime = 0;

    this._vrAxisDeadzone = 0.2;
    this._vrTurnSpeed = THREE.MathUtils.degToRad(110);
    this._vrMoveVec = new THREE.Vector3();
    this._vrForward = new THREE.Vector3();
    this._vrRight = new THREE.Vector3();
    this._vrHeadQuat = new THREE.Quaternion();
    this._vrRunScalar = 1;
    this._vrControllersReady = false;
    this._controllerFactory = null;
    this._controller1 = null; this._controller2 = null;
    this._controllerGrip1 = null; this._controllerGrip2 = null;

    this._onXRSessionStart = () => this._setupVRControllers();
    this._onXRSessionEnd = () => this._teardownVRControllers();
    const xr = this.sceneMgr.renderer?.xr;
    if (xr?.addEventListener) {
      xr.addEventListener('sessionstart', this._onXRSessionStart);
      xr.addEventListener('sessionend', this._onXRSessionEnd);
    }
  }

  update(dt, groundY, xrPresenting) {
    const dol = this.sceneMgr.dolly;

    // Jump / crouch state
    if (this.input.consumeJump() && this.jumpState === 'idle') {
      const h = this.jumpPeak - this.baseEye;
      this.vertVel = Math.sqrt(2 * this.GRAV * h);
      this._pendingHangTime = (2 * this.vertVel) / this.GRAV;
      this.jumpState = 'jumping';
      this._jumpJustStarted = true;
    }
    if (this.jumpState === 'jumping') {
      this.vertVel -= this.GRAV * dt;
      this.eyeY += this.vertVel * dt;
      if (this.eyeY <= this.baseEye) {
        this.eyeY = this.baseEye;
        this.vertVel = 0;
        this.jumpState = 'idle';
        this._pendingHangTime = 0;
      }
    } else {
      const target = this.input.m.crouch ? this.crouchEye : this.baseEye;
      this.eyeY += (target - this.eyeY) * Math.min(1, this.CROUCH_EASE * dt);
    }

    // Device orientation (mobile, non-XR)
    if (isMobile && this.orientationRef.ready && !xrPresenting) {
      const { a, b, g } = this.orientationRef;
      const euler = new THREE.Euler(rad(b || 0), rad(a || 0), rad(-(g || 0)), 'YXZ');
      const q = new THREE.Quaternion().setFromEuler(euler)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      dol.quaternion.copy(q);
    }

    // VR gamepads take over when XR is active
    if (xrPresenting) {
      this._updateXRGamepads(dt);
    }
    // Mobile finger drag relative to view
    else if (isMobile) {
      const dx = THREE.MathUtils.clamp(this.input.touch.dxNorm, -1, 1);
      const dy = THREE.MathUtils.clamp(this.input.touch.dyNorm, -1, 1);
      if (dx || dy) {
        const forward = new THREE.Vector3();
        this.sceneMgr.camera.getWorldDirection(forward);
        forward.y = 0; if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        forward.normalize();
        const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0,1,0)).normalize();

        const moveVec = new THREE.Vector3()
          .addScaledVector(right, dx)
          .addScaledVector(forward, -dy)
          .multiplyScalar(this.baseSpeed * this.runMul);

        dol.position.addScaledVector(moveVec, dt);
        this._spd = moveVec.length();
      } else { this._spd = 0; }
    }
    // Desktop fallback
    else {
      const fwd = new THREE.Vector3(); this.sceneMgr.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0,1,0));
      let mx = 0, mz = 0; const m = this.input.m;
      if (m.f) mz++; if (m.b) mz--; if (m.l) mx--; if (m.r) mx++;
      if (mx || mz) {
        const dir = new THREE.Vector3().addScaledVector(right, mx).addScaledVector(fwd, mz).normalize();
        const s = this.baseSpeed * (m.run ? this.runMul : 1);
        dol.position.addScaledVector(dir, s * dt);
        this._spd = s;
      } else { this._spd = 0; }
    }

    // Snap to terrain + eye offset
    dol.position.y = (groundY ?? 0) + this.eyeY;
  }

  _setupVRControllers() {
    if (this._vrControllersReady) return;
    const renderer = this.sceneMgr.renderer;
    const scene = this.sceneMgr.scene;
    if (!renderer?.xr) return;

    if (!this._controllerFactory) {
      this._controllerFactory = new XRControllerModelFactory();
    }

    const rayGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    const baseRay = new THREE.Line(rayGeometry, new THREE.LineBasicMaterial({ color: 0xffffff }));
    baseRay.name = 'line';
    baseRay.scale.z = 2;

    this._controller1 = renderer.xr.getController(0);
    if (this._controller1) {
      this._controller1.name = 'left-controller';
      this._controller1.userData.handedness = 'left';
      this._controller1.add(baseRay.clone());
      scene.add(this._controller1);
    }

    this._controller2 = renderer.xr.getController(1);
    if (this._controller2) {
      this._controller2.name = 'right-controller';
      this._controller2.userData.handedness = 'right';
      this._controller2.add(baseRay.clone());
      scene.add(this._controller2);
    }

    this._controllerGrip1 = renderer.xr.getControllerGrip(0);
    if (this._controllerGrip1) {
      this._controllerGrip1.add(this._controllerFactory.createControllerModel(this._controllerGrip1));
      scene.add(this._controllerGrip1);
    }

    this._controllerGrip2 = renderer.xr.getControllerGrip(1);
    if (this._controllerGrip2) {
      this._controllerGrip2.add(this._controllerFactory.createControllerModel(this._controllerGrip2));
      scene.add(this._controllerGrip2);
    }

    this._vrControllersReady = true;
  }

  _teardownVRControllers() {
    if (!this._vrControllersReady) return;
    const scene = this.sceneMgr.scene;
    const controllers = [this._controller1, this._controller2, this._controllerGrip1, this._controllerGrip2];
    controllers.forEach((ctrl) => {
      if (!ctrl) return;
      if (ctrl.parent === scene) scene.remove(ctrl);
      if (ctrl.children) {
        for (let i = ctrl.children.length - 1; i >= 0; i--) {
          ctrl.remove(ctrl.children[i]);
        }
      }
    });

    this._controller1 = this._controller2 = null;
    this._controllerGrip1 = this._controllerGrip2 = null;
    this._vrControllersReady = false;
    this._vrRunScalar = 1;
  }

  _updateXRGamepads(dt) {
    this._setupVRControllers();
    const renderer = this.sceneMgr.renderer;
    const session = renderer?.xr?.getSession?.();
    if (!session) { this._spd = 0; return; }
    const dtClamped = Math.min(dt, 0.1);
    const moveVec = this._vrMoveVec.set(0, 0, 0);
    let moved = false;
    let wantsRun = false;

    const leftAxes = { horizontal: 0, vertical: 0 };
    const rightAxes = { horizontal: 0, vertical: 0 };
    let leftPad = null;
    let rightPad = null;

    for (const source of session.inputSources) {
      const gamepad = source?.gamepad;
      if (!gamepad) continue;
      const handedness = source.handedness || 'unknown';
      const axes = gamepad.axes || [];
      const buttons = gamepad.buttons || [];

      const axisX = axes[2] !== undefined ? axes[2] : (axes[0] ?? 0);
      const axisYRaw = axes[3] !== undefined ? axes[3] : (axes[1] ?? 0);
      const horizontal = Math.abs(axisX) > this._vrAxisDeadzone ? axisX : 0;
      const vertical = Math.abs(axisYRaw) > this._vrAxisDeadzone ? -axisYRaw : 0;

      if (handedness === 'right') {
        rightAxes.horizontal = horizontal;
        rightAxes.vertical = vertical;
        rightPad = gamepad;
      } else if (handedness === 'left') {
        leftAxes.horizontal = horizontal;
        leftAxes.vertical = vertical;
        leftPad = gamepad;
      } else {
        if (!leftPad) leftPad = gamepad;
        leftAxes.horizontal = horizontal;
        leftAxes.vertical = vertical;
      }

      const runBtn = buttons[1];
      if (runBtn && (runBtn.pressed || runBtn.value > 0.5)) wantsRun = true;
      if (this._isStickPressed(gamepad, handedness)) wantsRun = true;
    }

    const yawDelta = rightAxes.horizontal ? -rightAxes.horizontal * this._vrTurnSpeed * dtClamped : 0;
    if (yawDelta) {
      this.sceneMgr.dolly.rotation.y += yawDelta;
      this.sceneMgr.dolly.updateMatrixWorld?.(true);
    }

    const xrCamera = renderer.xr.getCamera(this.sceneMgr.camera);
    const viewCam = xrCamera?.cameras?.[0] || xrCamera;
    if (viewCam?.getWorldQuaternion) {
      viewCam.getWorldQuaternion(this._vrHeadQuat);
    } else {
      this._vrHeadQuat.copy(this.sceneMgr.camera.quaternion);
    }

    this._vrForward.set(0, 0, -1).applyQuaternion(this._vrHeadQuat);
    this._vrForward.y = 0;
    if (this._vrForward.lengthSq() < 1e-6) {
      this._vrForward.set(0, 0, -1).applyQuaternion(this.sceneMgr.dolly.quaternion);
      this._vrForward.y = 0;
    }
    this._vrForward.normalize();

    this._vrRight.set(1, 0, 0).applyQuaternion(this._vrHeadQuat);
    this._vrRight.y = 0;
    if (this._vrRight.lengthSq() < 1e-6) {
      this._vrRight.set(1, 0, 0).applyQuaternion(this.sceneMgr.dolly.quaternion);
      this._vrRight.y = 0;
    }
    this._vrRight.normalize();

    const accel = Math.min(1, 6 * dtClamped);
    const targetRun = wantsRun ? this.runMul : 1;
    this._vrRunScalar += (targetRun - this._vrRunScalar) * accel;
    this._vrRunScalar = THREE.MathUtils.clamp(this._vrRunScalar, 1, this.runMul);
    const runScale = this._vrRunScalar;

    if (leftAxes.horizontal) {
      moveVec.addScaledVector(this._vrRight, leftAxes.horizontal * this.baseSpeed);
      moved = true;
    }
    if (leftAxes.vertical) {
      moveVec.addScaledVector(this._vrForward, leftAxes.vertical * this.baseSpeed * runScale);
      moved = true;
      this._pulseHaptics(leftPad, Math.abs(leftAxes.vertical) * runScale);
    }

    if (rightAxes.vertical) {
      moveVec.addScaledVector(this._vrForward, rightAxes.vertical * this.baseSpeed * runScale);
      moved = true;
      this._pulseHaptics(rightPad, Math.abs(rightAxes.vertical) * runScale);
    }

    if (moved) {
      this.sceneMgr.dolly.position.addScaledVector(moveVec, dt);
      this._spd = moveVec.length();
    } else {
      this._spd = 0;
    }
  }

  _pulseHaptics(gamepad, intensity, duration = 50) {
    if (!gamepad) return;
    const actuators = gamepad.hapticActuators;
    const actuator = (actuators && actuators[0]) || gamepad.vibrationActuator;
    if (!actuator || typeof actuator.pulse !== 'function') return;
    const level = THREE.MathUtils.clamp(intensity, 0, 1);
    try { actuator.pulse(level, duration); } catch (_) {}
  }

  _isStickPressed(gamepad, handedness) {
    if (!gamepad?.buttons?.length) return false;
    const candidates = new Set();
    if (handedness === 'left') {
      candidates.add(3);
    } else if (handedness === 'right') {
      candidates.add(3);
      candidates.add(4);
    } else {
      candidates.add(gamepad.buttons.length - 1);
    }
    candidates.add(gamepad.buttons.length - 1);
    for (const idx of candidates) {
      if (idx < 0 || idx >= gamepad.buttons.length) continue;
      const btn = gamepad.buttons[idx];
      if (!btn) continue;
      if (btn.pressed || btn.value > 0.5) return true;
    }
    return false;
  }

  speed(){ return this._spd; }
  eyeHeight(){ return this.eyeY; }
  popJumpStarted(){ const j = this._jumpJustStarted; this._jumpJustStarted = false; return j; }
  jumpHangTime(){ return this._pendingHangTime || 0; }
}
