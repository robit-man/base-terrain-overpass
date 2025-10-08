import * as THREE from 'three';
import { XRControllerModelFactory } from 'XRControllerModelFactory';
import { rad, isMobile } from './utils.js';

const UP = new THREE.Vector3(0, 1, 0);

export class Locomotion {
  constructor(sceneMgr, input, orientationRef) {
    this.sceneMgr = sceneMgr; this.input = input; this.orientationRef = orientationRef || { ready: false };
    this.baseSpeed = 2; this.runMul = 3.5; this._spd = 0;
    this.GRAV = 20;
    this.baseEye = 1.6; this.crouchEye = 0.9; this.jumpPeak = 2.4;
    this.eyeY = this.baseEye; this.vertVel = 0; this.jumpState = 'idle';
    this.CROUCH_EASE = 6; this._jumpJustStarted = false;
    this._pendingHangTime = 0;

    this._vrAxisDeadzone = 0.2;
    this._vrTurnSpeed = THREE.MathUtils.degToRad(110);
    this._vrFollowStart = THREE.MathUtils.degToRad(20);
    this._vrFollowSnap = THREE.MathUtils.degToRad(65);
    this._vrFollowMaxRate = THREE.MathUtils.degToRad(220);
    this._vrMoveVec = new THREE.Vector3();
    this._vrForward = new THREE.Vector3();
    this._vrRight = new THREE.Vector3();
    this._tmpHeadFlat = new THREE.Vector3();
    this._vrRunScalar = 1;
    this._vrControllersReady = false;
    this._controllerFactory = null;
    this._controller1 = null; this._controller2 = null;
    this._controllerGrip1 = null; this._controllerGrip2 = null;
    this._lastHeadRelativeYaw = 0;
    this._bodyYaw = 0;
    this._worldYaw = 0;
    this._vrJumpRequested = false;
    this._vrCrouchActive = false;
    this._headHeight = this.baseEye;
    this._headPitch = 0;
    this._headRoll = 0;
    this._xrHeadPoseReady = false;

    this._tmpHeadQuat = new THREE.Quaternion();
    this._tmpBodyQuat = new THREE.Quaternion();
    this._tmpHeadEuler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._headQuatBody = new THREE.Quaternion();

    this._onXRSessionStart = () => {
      this._lastHeadRelativeYaw = 0;
      this._bodyYaw = 0;
      this._worldYaw = 0;
      this._headHeight = this.baseEye;
      this._headPitch = 0;
      this._headRoll = 0;
      this._xrHeadPoseReady = false;
      this._headQuatBody.identity();
      if (this.sceneMgr?.dolly) {
        this.sceneMgr.dolly.rotation.y = 0;
        this.sceneMgr.dolly.quaternion.setFromEuler(new THREE.Euler(0, 0, 0, 'YXZ'));
        this.sceneMgr.dolly.updateMatrixWorld?.(true);
      }
      this._setupVRControllers();
    };
    this._onXRSessionEnd = () => {
      this._teardownVRControllers();
      this._lastHeadRelativeYaw = 0;
      this._bodyYaw = 0;
      this._worldYaw = 0;
      this._vrJumpRequested = false;
      this._vrCrouchActive = false;
      this._headHeight = this.baseEye;
      this._headPitch = 0;
      this._headRoll = 0;
      this._xrHeadPoseReady = false;
      this._headQuatBody.identity();
    };
    const xr = this.sceneMgr.renderer?.xr;
    if (xr?.addEventListener) {
      xr.addEventListener('sessionstart', this._onXRSessionStart);
      xr.addEventListener('sessionend', this._onXRSessionEnd);
    }

    // --- Mobile swipe steering state ---
    this._touchYawOffset = 0;
    this._lastAppliedTouchYaw = 0;
    this._touchYawRate = THREE.MathUtils.degToRad(180); // rad/s when swipe fully deflected
    this._snapYawTarget = null;
    this._snapYawActive = false;
    this._snapYawEpsilon = THREE.MathUtils.degToRad(1.5);
    this._tmpForward = new THREE.Vector3();
  }

  update(dt, groundY, xrPresenting) {
    const dol = this.sceneMgr.dolly;

    const isMobileDevice = isMobile;
    let mobileDx = 0;
    let mobileDy = 0;
    let baseYaw = this._currentYaw();
    if (isMobileDevice) {
      mobileDx = THREE.MathUtils.clamp(this.input.touch.dxNorm, -1, 1);
      mobileDy = THREE.MathUtils.clamp(this.input.touch.dyNorm, -1, 1);
      const yawDelta = mobileDx * this._touchYawRate * dt;
      if (Math.abs(yawDelta) > 1e-5) {
        this._touchYawOffset = THREE.MathUtils.euclideanModulo(this._touchYawOffset + yawDelta + Math.PI, Math.PI * 2) - Math.PI;
      }
    }

    const jumpRequested = this.input.consumeJump() || this._consumeVrJump();
    const crouchInput = this.input.m.crouch || this._vrCrouchActive;

    // Jump / crouch state
    if (jumpRequested && this.jumpState === 'idle') {
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
      const target = crouchInput ? this.crouchEye : this.baseEye;
      this.eyeY += (target - this.eyeY) * Math.min(1, this.CROUCH_EASE * dt);
    }

    // Device orientation (mobile, non-XR)
    if (isMobileDevice && this.orientationRef.ready && !xrPresenting) {
      const { a, b, g } = this.orientationRef;
      const euler = new THREE.Euler(rad(b || 0), rad(a || 0), rad(-(g || 0)), 'YXZ');
      const q = new THREE.Quaternion().setFromEuler(euler)
        .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
      dol.quaternion.copy(q);
      this._lastAppliedTouchYaw = 0;
      baseYaw = this._currentYaw();
    }

    if (isMobileDevice && !xrPresenting && this._snapYawTarget != null) {
      baseYaw = this._currentYaw();
      const desiredOffset = this._normalizeAngle(this._snapYawTarget - baseYaw);
      const deltaOffset = desiredOffset - this._touchYawOffset;
      const maxStep = this._touchYawRate * dt;
      if (Math.abs(deltaOffset) <= this._snapYawEpsilon) {
        this._touchYawOffset = desiredOffset;
        this._snapYawTarget = null;
        this._snapYawActive = false;
      } else {
        this._touchYawOffset += THREE.MathUtils.clamp(deltaOffset, -maxStep, maxStep);
        this._touchYawOffset = this._normalizeAngle(this._touchYawOffset);
        this._snapYawActive = true;
      }
    } else if (!this._snapYawTarget) {
      this._snapYawActive = false;
    }

    if (isMobileDevice && !xrPresenting) {
      const yawDelta = this._touchYawOffset - this._lastAppliedTouchYaw;
      if (Math.abs(yawDelta) > 1e-5) {
        dol.rotateOnWorldAxis(UP, yawDelta);
        this._lastAppliedTouchYaw = this._touchYawOffset;
      }
    }

    // VR gamepads take over when XR is active
    if (xrPresenting) {
      this._updateXRGamepads(dt);
    }
    // Mobile finger drag: forward thrust with yaw steering
    else if (isMobileDevice) {
      const forwardInput = -mobileDy;
      if (Math.abs(forwardInput) > 1e-3) {
        const forward = new THREE.Vector3();
        this.sceneMgr.camera.getWorldDirection(forward);
        forward.y = 0;
        if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
        forward.normalize();

        const scalar = this.baseSpeed * this.runMul * forwardInput;
        dol.position.addScaledVector(forward, scalar * dt);
        this._spd = Math.abs(forwardInput) * this.baseSpeed * this.runMul;
      } else {
        this._spd = 0;
      }
    }
    // Desktop fallback
    else {
      const fwd = new THREE.Vector3(); this.sceneMgr.camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
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

  _rotateRigAroundHead(yawDelta) {
    const renderer = this.sceneMgr?.renderer;
    if (!renderer?.xr) return;
    const xrCamera = renderer.xr.getCamera(this.sceneMgr.camera);
    const viewCam = xrCamera?.cameras?.[0] || xrCamera;
    if (!viewCam?.getWorldPosition) return;

    const before = new THREE.Vector3();
    const after = new THREE.Vector3();

    viewCam.getWorldPosition(before);
    this.sceneMgr.dolly.rotateOnWorldAxis(UP, yawDelta);
    this.sceneMgr.dolly.updateMatrixWorld?.(true);
    viewCam.getWorldPosition(after);

    before.sub(after);
    before.y = 0;
    this.sceneMgr.dolly.position.add(before);
    this.sceneMgr.dolly.updateMatrixWorld?.(true);
  }

  _currentYaw() {
    if (!this.sceneMgr?.dolly) return 0;
    const forward = this._tmpForward.set(0, 0, -1).applyQuaternion(this.sceneMgr.dolly.quaternion);
    return Math.atan2(forward.x, -forward.z) || 0;
  }

  _normalizeAngle(radVal) {
    return THREE.MathUtils.euclideanModulo(radVal + Math.PI, Math.PI * 2) - Math.PI;
  }

  snapToHeading(targetRad) {
    if (!isMobile || !Number.isFinite(targetRad)) return false;
    this._snapYawTarget = THREE.MathUtils.euclideanModulo(targetRad, Math.PI * 2);
    return true;
  }

  isSnapActive() {
    return this._snapYawTarget != null || this._snapYawActive;
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
    if (!session) {
      this._spd = 0;
      this._xrHeadPoseReady = false;
      this._headQuatBody.identity();
      this._lastHeadRelativeYaw = 0;
      this._headPitch = 0;
      this._headRoll = 0;
      return;
    }
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
        if (!leftPad) {
          leftPad = gamepad;
          leftAxes.horizontal = horizontal;
          leftAxes.vertical = vertical;
        } else {
          rightPad = gamepad;
          rightAxes.horizontal = horizontal;
          rightAxes.vertical = vertical;
        }
      }

      const runBtn = buttons[1];
      if (runBtn && (runBtn.pressed || runBtn.value > 0.5)) wantsRun = true;
      if (this._isStickPressed(gamepad, handedness)) wantsRun = true;
    }

    const yawDelta = rightAxes.horizontal ? -rightAxes.horizontal * this._vrTurnSpeed * dtClamped : 0;
    if (yawDelta) {
      this._rotateRigAroundHead(yawDelta);
    }

    const xrCamera = renderer.xr.getCamera(this.sceneMgr.camera);
    const viewCam = xrCamera?.cameras?.[0] || xrCamera;
    const headQuat = this._tmpHeadQuat;
    const headEuler = this._tmpHeadEuler;
    let headQuatValid = false;
    if (viewCam?.getWorldQuaternion) {
      viewCam.getWorldQuaternion(headQuat);
      headQuatValid = true;
    } else if (this.sceneMgr?.camera?.getWorldQuaternion) {
      this.sceneMgr.camera.getWorldQuaternion(headQuat);
      headQuatValid = true;
    }

    const headForward = this._tmpHeadFlat;
    const headForwardValid = this._extractFlatForward(viewCam, headForward) ||
      this._extractFlatForward(this.sceneMgr.camera, headForward);

    const dolly = this.sceneMgr?.dolly;
    const bodyQuat = dolly?.quaternion || null;
    const bodyForward = this._tmpForward.set(0, 0, -1);
    if (bodyQuat) bodyForward.applyQuaternion(bodyQuat);
    bodyForward.y = 0;
    if (bodyForward.lengthSq() < 1e-6) bodyForward.set(0, 0, -1);
    bodyForward.normalize();

    let bodyYaw = Math.atan2(bodyForward.x, -bodyForward.z);
    let headPoseReady = headQuatValid && !!bodyQuat;
    let headYawLocal = 0;
    let headPitchLocal = 0;
    let headRollLocal = 0;
    let payloadYaw = 0;
    let payloadPitch = 0;
    let payloadRoll = 0;

    if (headPoseReady) {
      const bodyInv = this._tmpBodyQuat.copy(bodyQuat).invert();
      this._headQuatBody.copy(bodyInv).multiply(headQuat);
      headEuler.setFromQuaternion(this._headQuatBody, 'YXZ');
      headYawLocal = this._normalizeAngle(headEuler.y);
      headPitchLocal = headEuler.x;
      headRollLocal = headEuler.z;

      const rotated = this._applyVrBodyFollow({
        delta: headYawLocal,
        bodyYaw,
        headYawWorld: this._normalizeAngle(bodyYaw + headYawLocal),
        dt: dtClamped
      });

      if (rotated) {
        bodyForward.set(0, 0, -1).applyQuaternion(bodyQuat);
        bodyForward.y = 0;
        if (bodyForward.lengthSq() < 1e-6) bodyForward.set(0, 0, -1);
        bodyForward.normalize();
        bodyYaw = Math.atan2(bodyForward.x, -bodyForward.z);

        const updatedBodyInv = this._tmpBodyQuat.copy(bodyQuat).invert();
        this._headQuatBody.copy(updatedBodyInv).multiply(headQuat);
        headEuler.setFromQuaternion(this._headQuatBody, 'YXZ');
        headYawLocal = this._normalizeAngle(headEuler.y);
        headPitchLocal = headEuler.x;
        headRollLocal = headEuler.z;
      }
    } else {
      this._headQuatBody.identity();
      headYawLocal = 0;
      headPitchLocal = 0;
      headRollLocal = 0;
    }

    payloadYaw = this._normalizeAngle(-headYawLocal);
    payloadPitch = -headPitchLocal;
    payloadRoll = -headRollLocal;

    const pitchLimit = THREE.MathUtils.degToRad(80);
    const rollLimit = THREE.MathUtils.degToRad(55);
    this._headPitch = headPoseReady ? THREE.MathUtils.clamp(payloadPitch, -pitchLimit, pitchLimit) : 0;
    this._headRoll = headPoseReady ? THREE.MathUtils.clamp(payloadRoll, -rollLimit, rollLimit) : 0;

    this._bodyYaw = this._normalizeAngle(bodyYaw);
    this._worldYaw = this._bodyYaw;
    this._lastHeadRelativeYaw = headPoseReady ? payloadYaw : 0;
    this._xrHeadPoseReady = headPoseReady;

    if (!headForwardValid) {
      this._headHeight = this.baseEye;
    }
    if (this._vrCrouchActive) this._headHeight = this.crouchEye;

    this._vrForward.copy(bodyForward);
    if (this._vrForward.lengthSq() < 1e-6) this._vrForward.set(0, 0, -1);
    else this._vrForward.normalize();

    this._vrRight.crossVectors(this._vrForward, UP);
    if (this._vrRight.lengthSq() < 1e-6) this._vrRight.set(1, 0, 0);
    else this._vrRight.normalize();

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

    const verticalLook = rightAxes.vertical;
    if (Math.abs(verticalLook) > this._vrAxisDeadzone) {
      if (verticalLook > 0) this._queueVrJump();
      if (verticalLook < 0) this._setVrCrouch(true);
    } else {
      this._setVrCrouch(false);
    }

    if (moved) {
      this.sceneMgr.dolly.position.addScaledVector(moveVec, dt);
      this._spd = moveVec.length();
    } else {
      this._spd = 0;
    }
  }

  _applyVrBodyFollow({ delta, bodyYaw, headYawWorld, dt }) {
    if (!Number.isFinite(delta) || !Number.isFinite(bodyYaw) || !Number.isFinite(dt)) return false;
    const absDelta = Math.abs(delta);
    if (absDelta < this._vrFollowStart) return false;

    if (Number.isFinite(headYawWorld) && absDelta >= this._vrFollowSnap) {
      const snapDelta = this._normalizeAngle(headYawWorld - bodyYaw);
      if (Math.abs(snapDelta) > 1e-4) {
        this._rotateRigAroundHead(snapDelta);
        return true;
      }
      return false;
    }

    const maxStep = this._vrFollowMaxRate * dt;
    if (maxStep <= 0) return false;
    const step = THREE.MathUtils.clamp(delta, -maxStep, maxStep);
    if (Math.abs(step) <= 1e-4) return false;
    this._rotateRigAroundHead(step);
    return true;
  }

  _pulseHaptics(gamepad, intensity, duration = 50) {
    if (!gamepad) return;
    const actuators = gamepad.hapticActuators;
    const actuator = (actuators && actuators[0]) || gamepad.vibrationActuator;
    if (!actuator || typeof actuator.pulse !== 'function') return;
    const level = THREE.MathUtils.clamp(intensity, 0, 1);
    try { actuator.pulse(level, duration); } catch (_) { }
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

  getXRWorldYaw() {
    return Number.isFinite(this._worldYaw) ? this._normalizeAngle(this._worldYaw) : null;
  }

  getXRRelativeHeadYaw() {
    if (!this._xrHeadPoseReady) return null;
    return this._lastHeadRelativeYaw || 0;
  }

  getXRHeadPitch() {
    return this._xrHeadPoseReady ? this._headPitch : null;
  }

  getXRHeadRoll() {
    return this._xrHeadPoseReady ? this._headRoll : null;
  }

  getXRHeadBodyQuaternion(target = null) {
    if (!this._xrHeadPoseReady) return null;
    if (target && typeof target.copy === 'function') {
      target.copy(this._headQuatBody);
      return target;
    }
    return this._headQuatBody.clone();
  }

  getXRBodyYaw() {
    return Number.isFinite(this._bodyYaw) ? this._normalizeAngle(this._bodyYaw) : null;
  }

  isXRHeadPoseReady() {
    return !!this._xrHeadPoseReady;
  }

  speed() { return this._spd; }
  eyeHeight() {
    const xrPresent = this.sceneMgr?.renderer?.xr?.isPresenting;
    if (xrPresent) return 0;
    return this.eyeY;
  }
  isCrouching() { return !!(this.input?.m?.crouch || this._vrCrouchActive); }
  isJumping() { return this.jumpState === 'jumping'; }
  popJumpStarted() { const j = this._jumpJustStarted; this._jumpJustStarted = false; return j; }
  jumpHangTime() { return this._pendingHangTime || 0; }
  baseEyeHeight() { return this.baseEye; }

  _extractFlatForward(source, target) {
    if (!source) return false;
    source.updateMatrixWorld?.(true);
    const mat = source.matrixWorld;
    if (!mat) return false;
    const e = mat.elements;
    target.set(-e[8], -e[9], -e[10]);
    target.y = 0;
    const lenSq = target.lengthSq();
    if (lenSq < 1e-6) return false;
    target.multiplyScalar(1 / Math.sqrt(lenSq));
    const posY = e[13];
    if (Number.isFinite(posY)) {
      const dollyY = this.sceneMgr?.dolly?.position?.y ?? 0;
      const baseEye = Number.isFinite(this.eyeY) ? this.eyeY : this.baseEye;
      const groundY = dollyY - (Number.isFinite(baseEye) ? baseEye : 0);
      this._headHeight = Math.max(0, posY - groundY);
    }
    return true;
  }

  _queueVrJump() {
    if (this._vrJumpRequested) return;
    if (this.jumpState !== 'idle') return;
    this._vrJumpRequested = true;
  }

  _consumeVrJump() {
    const flagged = this._vrJumpRequested;
    this._vrJumpRequested = false;
    return flagged;
  }

  _setVrCrouch(active) {
    const state = !!active;
    if (this._vrCrouchActive === state) return;
    this._vrCrouchActive = state;
    if (this.input?.m) this.input.m.crouch = state;
  }

  getXRHeadHeight() {
    return this._headHeight;
  }
}
