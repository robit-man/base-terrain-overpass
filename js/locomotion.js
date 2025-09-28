import * as THREE from 'three';
import { rad, isMobile } from './utils.js';

export class Locomotion {
  constructor(sceneMgr, input, orientationRef) {
    this.sceneMgr = sceneMgr; this.input = input; this.orientationRef = orientationRef || { ready: false };
    this.baseSpeed = 2; this.runMul = 2.5; this._spd = 0;
    this.GRAV = 20; 
    this.baseEye = 1.6; this.crouchEye = 0.9; this.jumpPeak = 2.4;
    this.eyeY = this.baseEye; this.vertVel = 0; this.jumpState = 'idle';
    this.CROUCH_EASE = 6; this._jumpJustStarted = false;
  }

  update(dt, groundY, xrPresenting) {
    const dol = this.sceneMgr.dolly;

    // Jump / crouch state
    if (this.input.consumeJump() && this.jumpState === 'idle') {
      const h = this.jumpPeak - this.baseEye;
      this.vertVel = Math.sqrt(2 * this.GRAV * h);
      this.jumpState = 'jumping';
      this._jumpJustStarted = true;
    }
    if (this.jumpState === 'jumping') {
      this.vertVel -= this.GRAV * dt;
      this.eyeY += this.vertVel * dt;
      if (this.eyeY <= this.baseEye) {
        this.eyeY = this.baseEye; this.vertVel = 0; this.jumpState = 'idle';
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

    // Mobile finger drag relative to view
    if (isMobile && !xrPresenting) {
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
    // Desktop / XR fallback
    else if (this.input.controls.isLocked || !isMobile) {
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

  speed(){ return this._spd; }
  eyeHeight(){ return this.eyeY; }
  popJumpStarted(){ const j = this._jumpJustStarted; this._jumpJustStarted = false; return j; }
}
