// chasecam.js
import * as THREE from 'three';

/**
 * Third-person chase cam that scroll-zooms into first-person.
 * - Camera is a CHILD of the dolly (player rig).
 * - We move the camera only in dolly LOCAL space; yaw comes from the dolly,
 *   and (on mobile) pitch comes from device orientation — no binding/pointerlock.
 */
export class ChaseCam {
  /**
   * @param {SceneManager} sceneMgr
   * @param {() => number} getEyeHeightFn  returns current eye height (e.g., crouch/jump)
   * @param {{a:number,b:number,g:number,ready:boolean}=} orientationRef  optional mobile sensors.orient
   */
  constructor(sceneMgr, getEyeHeightFn, orientationRef = null, heightSampler = null) {
    this.sceneMgr = sceneMgr;
    this.getEyeHeight = getEyeHeightFn || (() => 1.6);
    this.orient = orientationRef;
    this.heightAt = typeof heightSampler === 'function' ? heightSampler : null;

    this.targetBoom = 3.5;    // meters behind the head (local +Z)
    this.boom = 3.5;
    this.minBoom = 0.0;
    this.maxBoom = 2500.0;
    this.pivotLift = 0.35;     // mild shoulder-height bias around the head pivot
    this.surfaceClearance = 0.3; // keep camera above ground when clamped
    this.FIRST_THRESHOLD = 0.12; // <= this → first person
    this.smooth = 24.0;

    // Mobile-device pitch handling
    this.isMobile = /Mobi|Android/i.test(navigator.userAgent);
    this.pitchZero = null;      // beta at calibration
    this.pitchFiltered = 0;     // radians
    this.pitchHz = 60;          // smoothing rate
    this.pitchClamp = THREE.MathUtils.degToRad(85); // avoid flipping

    this._ensureParentedToDolly();
    this._orbitPivot = new THREE.Vector3();
    this._orbitOffset = new THREE.Vector3();
    this._orbitTarget = new THREE.Vector3();
    this._worldTarget = new THREE.Vector3();
    this._clampedLocal = new THREE.Vector3();

    // Wheel to zoom (scroll in ⇒ closer to FPV)
    window.addEventListener('wheel', (e) => {
      this.targetBoom = THREE.MathUtils.clamp(
        this.targetBoom + e.deltaY * 0.1,
        this.minBoom,
        this.maxBoom
      );
    }, { passive: true });
  }

  _ensureParentedToDolly() {
    const { camera, dolly } = this.sceneMgr;
    if (camera.parent !== dolly) {
      try { camera.parent?.remove(camera); } catch {}
      dolly.add(camera);
    }
    camera.position.set(0, 0, 0);
  }

  isFirstPerson() { return this.targetBoom <= this.FIRST_THRESHOLD; }

  _updateMobilePitch(dt) {
    if (!this.isMobile || !this.orient || !this.orient.ready) return;

    // Calibrate once when sensors first become ready — treat current beta as "level"
    if (this.pitchZero == null) this.pitchZero = this.orient.b || 0;

    // Map device beta (front/back tilt) → camera pitch.
    // Use negative so tilting phone up looks up.
    const rawDeg = -(this.orient.b - this.pitchZero);
    const rawRad = THREE.MathUtils.degToRad(rawDeg);
    const clamped = THREE.MathUtils.clamp(rawRad, -this.pitchClamp, this.pitchClamp);

    // Exponential smoothing to keep motion stable
    const a = 1 - Math.exp(-this.pitchHz * Math.max(0, dt));
    this.pitchFiltered += (clamped - this.pitchFiltered) * a;
  }

  update(dt, xrPresenting) {
    const cam = this.sceneMgr.camera;

    // Smooth boom distance
    this.boom += (this.targetBoom - this.boom) * Math.min(1, this.smooth * dt);

    if (xrPresenting) {
      // XR = pure FPV (HMD drives cam pose)
      cam.position.set(0, 0, 0);
      return;
    }

    // Refresh mobile pitch if available
    this._updateMobilePitch(dt);

    if (this.boom <= this.FIRST_THRESHOLD) {
      // First-person at eyes
      cam.position.set(0, 0, 0);
    } else {
      // Third-person: orbit around the head (local origin) with mild lift bias
      const useMobilePitch = this.isMobile && this.orient?.ready;
      const pitch = useMobilePitch ? this.pitchFiltered : cam.rotation.x;
      const orbitAngle = useMobilePitch ? -pitch : pitch;
      const pivot = this._orbitPivot.set(0, this.pivotLift, 0);
      const offset = this._orbitOffset.set(0, 0, this.boom)
        .applyAxisAngle(ChaseCam._X_AXIS, orbitAngle);
      this._orbitTarget.copy(pivot).add(offset);

      if (this.heightAt) {
        const parent = cam.parent || this.sceneMgr.dolly;
        parent.updateMatrixWorld?.(true);
        const worldTarget = this._worldTarget.copy(this._orbitTarget);
        parent.localToWorld(worldTarget);
        const groundY = this.heightAt(worldTarget.x, worldTarget.z);
        if (Number.isFinite(groundY)) {
          const minY = groundY + this.surfaceClearance;
          if (worldTarget.y < minY) {
            worldTarget.y = minY;
            this._clampedLocal.copy(worldTarget);
            parent.worldToLocal(this._clampedLocal);
            this._orbitTarget.copy(this._clampedLocal);
          }
        }
      }

      cam.position.lerp(this._orbitTarget, Math.min(1, this.smooth * dt));
    }

    // Apply pitch from sensors ONLY on mobile (no yaw here; avatar stays upright).
    if (this.isMobile && this.orient?.ready) {
      cam.rotation.x = this.pitchFiltered; // local pitch
      // don't touch cam.rotation.y/z — yaw is driven by the dolly heading
    }
  }
}

ChaseCam._X_AXIS = new THREE.Vector3(1, 0, 0);
