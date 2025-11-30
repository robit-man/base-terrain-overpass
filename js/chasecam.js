// chasecam.js
import * as THREE from 'three';

const EARTH_RADIUS_METERS = 6371000;
const EARTH_DIAMETER_METERS = EARTH_RADIUS_METERS * 2;
const DEFAULT_MAX_BOOM = EARTH_DIAMETER_METERS * 0.6;

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
    this.maxBoom = DEFAULT_MAX_BOOM;
    this.pivotLift = 0.35;     // mild shoulder-height bias around the head pivot
    this.surfaceClearance = 0.3; // keep camera above ground when clamped
    this.FIRST_THRESHOLD = 0.12; // <= this → first person
    this.smooth = 24.0;
    this.defaultMinBoom = this.minBoom;
    this.defaultMaxBoom = this.maxBoom;

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

    this._pinch = {
      active: false,
      startDist: 0,
      startBoom: this.targetBoom,
      scale: 0.02
    };
    this._pinchTouches = new Map();
    this._setupPinchGestures();

    // Wheel to zoom (scroll in ⇒ closer to FPV)
    window.addEventListener('wheel', (e) => {
      if (!this._shouldHandleWheel(e)) return;
      const zoomRate = Math.max(0.1, Math.abs(this.targetBoom) * 0.0002);
      this.targetBoom = THREE.MathUtils.clamp(
        this.targetBoom + e.deltaY * zoomRate,
        this.minBoom,
        this.maxBoom
      );
    }, { passive: true });
  }

  _ensureParentedToDolly() {
    const { camera, dolly } = this.sceneMgr;
    if (camera.parent !== dolly) {
      try { camera.parent?.remove(camera); } catch { }
      dolly.add(camera);
    }
    camera.position.set(0, 0, 0);
  }

  _setupPinchGestures() {
    const canvas = this.sceneMgr?.renderer?.domElement;
    if (!canvas || typeof canvas.addEventListener !== 'function') return;

    const updatePinch = () => {
      if (!this._pinch.active) return;
      if (this._pinchTouches.size < 2) return;
      const touches = [...this._pinchTouches.values()];
      const dx = touches[0].x - touches[1].x;
      const dy = touches[0].y - touches[1].y;
      const dist = Math.hypot(dx, dy);
      if (!isFinite(dist) || dist <= 0) return;
      const delta = dist - this._pinch.startDist;
      const scale = Math.max(0.02, Math.abs(this._pinch.startBoom) * 0.00002);
      const target = this._pinch.startBoom + delta * scale;
      this.targetBoom = THREE.MathUtils.clamp(target, this.minBoom, this.maxBoom);
    };

    const endPinch = () => {
      if (!this._pinch.active) return;
      this._pinch.active = false;
      this._pinch.startDist = 0;
      this._pinch.startBoom = this.targetBoom;
    };

    const pointerDown = (e) => {
      if (e.pointerType !== 'touch') return;
      this._pinchTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this._pinchTouches.size === 2) {
        const touches = [...this._pinchTouches.values()];
        const dx = touches[0].x - touches[1].x;
        const dy = touches[0].y - touches[1].y;
        this._pinch.startDist = Math.max(1, Math.hypot(dx, dy));
        this._pinch.startBoom = this.targetBoom;
        this._pinch.active = true;
      }
    };

    const pointerMove = (e) => {
      if (e.pointerType !== 'touch') return;
      const touch = this._pinchTouches.get(e.pointerId);
      if (!touch) return;
      touch.x = e.clientX;
      touch.y = e.clientY;
      if (this._pinch.active) {
        e.preventDefault();
        updatePinch();
      }
    };

    const pointerUp = (e) => {
      if (e.pointerType !== 'touch') return;
      this._pinchTouches.delete(e.pointerId);
      if (this._pinch.active && this._pinchTouches.size < 2) {
        endPinch();
      }
    };

    const pointerCancel = (e) => {
      if (e.pointerType !== 'touch') return;
      this._pinchTouches.delete(e.pointerId);
      if (this._pinch.active && this._pinchTouches.size < 2) {
        endPinch();
      }
    };

    canvas.addEventListener('pointerdown', pointerDown, { passive: true });
    canvas.addEventListener('pointermove', pointerMove, { passive: false });
    canvas.addEventListener('pointerup', pointerUp, { passive: true });
    canvas.addEventListener('pointercancel', pointerCancel, { passive: true });
    canvas.addEventListener('pointerout', pointerCancel, { passive: true });
  }

  isFirstPerson() { return this.targetBoom <= this.FIRST_THRESHOLD; }

  _shouldHandleWheel(event) {
    const canvas = this.sceneMgr?.renderer?.domElement;
    if (!canvas) return false;
    if (event.target === canvas) return true;
    if (canvas.contains?.(event.target)) return true;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : null;
    if (Array.isArray(path) && path.includes(canvas)) return true;
    return false;
  }

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
