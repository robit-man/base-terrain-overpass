// sensors.js
import * as THREE from 'three';

export class Sensors {
  constructor() {
    // UI button
    this.btn = document.getElementById('request');

    // Legacy orientation surface (back-compat)
    this.orient = { a: 0, b: 0, g: 0, ready: false };

    // Enabled/ready flags
    this.enabled = false;
    this.ready = false;

    // Latest measured yaw/pitch (rad), before calibration
    this._measYaw = 0;
    this._measPitch = 0;

    // Final calibrated yaw/pitch exposed to consumers
    this.yaw = 0;
    this.pitch = 0;

    // Calibration offsets (rad)
    this._yawOff = 0;
    this._pitchOff = 0;

    // One-time compass alignment flag (align yaw to heading once we have both)
    this._compassAligned = false;

    // Screen orientation (rad)
    this._screenOri = 0;

    // Math helpers
    this._zee = new THREE.Vector3(0, 0, 1);
    this._q0 = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X
    this._eulerIn = new THREE.Euler();   // for beta/alpha/gamma → quaternion
    this._eulerOut = new THREE.Euler();  // to read pitch if desired (YXZ)
    this._orientationQuat = new THREE.Quaternion();

    // Vectors used for heading/yaw extraction
    this._headingBasis = new THREE.Vector3(0, 0, -1);
    this._headingWorld = new THREE.Vector3();
    this._fwdTmp = new THREE.Vector3();

    // Motion/accel
    this._accelRaw = new THREE.Vector3();
    this._accelWorld = new THREE.Vector3();
    this.motion = { ax: 0, ay: 0, az: 0, ready: false, timestamp: 0 };
    this._motionListening = false;

    // Magnetometer
    this._magSensor = null;
    this._magStartAttempted = false;
    this._magVec = new THREE.Vector3();
    this._magTemp = new THREE.Vector3();
    this._magWorld = new THREE.Vector3();
    this._magReady = false;

    // Web-reported heading (e.g., webkitCompassHeading)
    this._webHeadingDeg = null;
    this._webHeadingReady = false;

    // Gravity (for tilt compensation fallback)
    this._gravityVec = new THREE.Vector3();
    this._gravityTemp = new THREE.Vector3();
    this._gravityReady = false;

    // Enabling flow
    this._enabling = false;
    this._autoGestureAttached = false;
    this._autoGestureHandler = null;

    // Public heading fields
    this.headingDeg = null;
    this.headingRad = null;       // 0..2π, 0 = North(-Z), positive clockwise
    this.headingSource = 'unknown';
    this.headingConfidence = 0;

    // Bind handlers
    this._onDO = this._onDO.bind(this);
    this._onDM = this._onDM.bind(this);

    // Button wiring
    if (this.btn) this.btn.addEventListener('click', () => this.enable(), { once: true });

    // Keep screen orientation updated
    const updateSO = () => {
      const ang =
        (screen.orientation && typeof screen.orientation.angle === 'number')
          ? screen.orientation.angle
          : (window.orientation || 0);
      this._screenOri = THREE.MathUtils.degToRad(ang || 0);
    };
    updateSO();
    window.addEventListener('orientationchange', updateSO, false);

    this._setupAutoEnable();
  }

  async enable() {
    if (this.enabled) {
      this._startMagnetometer();
      return { success: true };
    }
    if (this._enabling) return { success: false, reason: 'pending' };

    this._enabling = true;
    let reason = null;

    try {
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        let status;
        try {
          status = await DeviceOrientationEvent.requestPermission();
        } catch (err) {
          const msg = `${err?.message || ''}`.toLowerCase();
          if (msg.includes('gesture')) reason = 'gesture';
          else reason = 'error';
        }
        if (!reason && status && status !== 'granted') {
          reason = status === 'denied' ? 'denied' : 'error';
        }
      }

      if (reason) return { success: false, reason };

      if (typeof DeviceMotionEvent?.requestPermission === 'function') {
        try {
          await DeviceMotionEvent.requestPermission();
        } catch { /* motion permission optional; ignore */ }
      }

      window.addEventListener('deviceorientation', this._onDO, true);
      if (!this._motionListening) {
        window.addEventListener('devicemotion', this._onDM, true);
        this._motionListening = true;
      }
      this.enabled = true;

      // Tell listeners (e.g., ChaseCam) to calibrate to current camera orbit
      window.dispatchEvent(new CustomEvent('sensors-enabled'));

      if (this.btn) this.btn.disabled = true;
      this._clearGestureEnableHandlers();
      this._startMagnetometer();
      return { success: true };
    } finally {
      const gestureNeeded = reason === 'gesture';
      this._enabling = false;
      if (gestureNeeded) this._installGestureEnable();
    }
  }

  /**
   * Calibrate phone yaw/pitch to the current camera azimuth/polar so there is no jump.
   * @param {number} targetYaw   current camera azimuth (rad)
   * @param {number} targetPitch current camera polar (rad)
   */
  calibrate(targetYaw, targetPitch) {
    // Use the latest measured phone yaw/pitch as the base for offsets
    this._yawOff = (targetYaw || 0) - this._measYaw;
    this._pitchOff = (targetPitch || 0) - this._measPitch;
    this.ready = true;
    // Expose legacy flag too
    this.orient.ready = true;
  }

  /** Returns { yaw, pitch, ready } — angles are radians. */
  getYawPitch() {
    return { yaw: this.yaw, pitch: this.pitch, ready: (this.ready && this.enabled) };
  }

  // --- Helpers ----------------------------------------------------

  /** Vector-based yaw from a quaternion: 0 = North(-Z), +90° = East(+X), positive clockwise. */
  _yawFromQuat(q) {
    // Forward vector in world space
    this._fwdTmp.set(0, 0, -1).applyQuaternion(q);
    // IMPORTANT: use -x, -z so result is θ (not -θ), matching compass (CW positive)
    return Math.atan2(-this._fwdTmp.x, -this._fwdTmp.z);
  }

  _normalizeAngle(rad) {
    const twoPi = Math.PI * 2;
    let out = rad % twoPi;
    if (out < 0) out += twoPi;
    return out;
  }

  _wrapPi(rad) {
    if (!Number.isFinite(rad)) return 0;
    return Math.atan2(Math.sin(rad), Math.cos(rad));
  }

  /** Heading from current orientation quaternion (no magnetometer), normalized to 0..2π */
  _orientationHeading() {
    if (!this._orientationQuat) return null;
    const yaw = this._yawFromQuat(this._orientationQuat);
    return Number.isFinite(yaw) ? this._normalizeAngle(yaw) : null;
  }

  // --- Event handlers --------------------------------------------

  // DeviceOrientation handler
  _onDO(e) {
    const a = e.alpha, b = e.beta, g = e.gamma;
    if (a == null && b == null && g == null) return;

    // Update legacy surface (degrees)
    this.orient.a = a || 0;
    this.orient.b = b || 0;
    this.orient.g = g || 0;
    this.orient.ready = true;

    // Convert to radians
    const alpha = THREE.MathUtils.degToRad(this.orient.a);
    const beta  = THREE.MathUtils.degToRad(this.orient.b);
    const gamma = THREE.MathUtils.degToRad(this.orient.g);

    // Build quaternion similar to three/examples DeviceOrientationControls
    // Intrinsic Tait–Bryan YXZ: set(beta, alpha, -gamma)
    this._eulerIn.set(beta, alpha, -gamma, 'YXZ');

    const q = new THREE.Quaternion()
      .setFromEuler(this._eulerIn)
      .multiply(this._q1) // -PI/2 X
      .multiply(this._q0.setFromAxisAngle(this._zee, -this._screenOri)); // compensate screen orientation

    // Extract pitch from Euler if you like, but get yaw from vector-based method (no sign bug)
    this._eulerOut.setFromQuaternion(q, 'YXZ');
    this._measPitch = this._eulerOut.x;
    this._measYaw   = this._yawFromQuat(q); // << FIXED: use vector-based yaw

    // Apply calibration offsets to produce final camera-facing angles
    this.yaw   = this._measYaw   + this._yawOff;
    this.pitch = this._measPitch + this._pitchOff;
    this._orientationQuat.copy(q);

    // Prefer platform heading if provided (iOS)
    if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
      this._webHeadingDeg = (e.webkitCompassHeading % 360 + 360) % 360;
      this._webHeadingReady = true;
      this._setHeading(THREE.MathUtils.degToRad(this._webHeadingDeg), 'webkit');
      this._tryInitialCompassAlign();
      return;
    }

    // Try magnetometer (tilt-compensated)
    if (this._updateTiltCompensatedHeading()) {
      this._tryInitialCompassAlign();
      return;
    }

    // Fallback: derive heading from orientation only (gyro-fused)
    const orientationHeading = this._orientationHeading();
    if (Number.isFinite(orientationHeading)) {
      this._setHeading(orientationHeading, 'orientation');
      this._tryInitialCompassAlign();
    } else if (!Number.isFinite(this.headingRad)) {
      this.headingDeg = null;
      this.headingRad = null;
      this.headingSource = 'unknown';
      this.headingConfidence = 0;
    }
  }

  getAcceleration() {
    return this.motion;
  }

  _onDM(e) {
    const incl = e.accelerationIncludingGravity;
    if (incl) {
      this._gravityTemp.set(incl.x ?? 0, incl.y ?? 0, incl.z ?? 0);
      if (!this._gravityReady) {
        this._gravityVec.copy(this._gravityTemp);
        this._gravityReady = true;
      } else {
        this._gravityVec.lerp(this._gravityTemp, 0.18);
      }
      if (this._updateTiltCompensatedHeading()) {
        this._tryInitialCompassAlign();
      }
    }

    let ax = 0;
    let ay = 0;
    let az = 0;

    if (e.acceleration) {
      ax = e.acceleration.x ?? 0;
      ay = e.acceleration.y ?? 0;
      az = e.acceleration.z ?? 0;
    } else if (incl) {
      ax = (incl.x ?? 0) - this._gravityVec.x;
      ay = (incl.y ?? 0) - this._gravityVec.y;
      az = (incl.z ?? 0) - this._gravityVec.z;
    }

    this._accelRaw.set(ax, ay, az);

    const worldVec = this._accelWorld.copy(this._accelRaw);
    worldVec.applyQuaternion(this._orientationQuat);

    this.motion.ax = worldVec.x;
    this.motion.ay = worldVec.y;
    this.motion.az = worldVec.z;
    this.motion.ready = true;
    this.motion.timestamp = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // --- Magnetometer / Heading ------------------------------------

  _startMagnetometer() {
    if (this._magStartAttempted) return;
    this._magStartAttempted = true;
    const SensorCtor = typeof window !== 'undefined' ? window.Magnetometer : null;
    if (typeof SensorCtor !== 'function') return;

    try {
      const sensor = new SensorCtor({ frequency: 30 });
      sensor.addEventListener('reading', () => {
        if (!Number.isFinite(sensor.x) || !Number.isFinite(sensor.y) || !Number.isFinite(sensor.z)) return;
        this._magTemp.set(sensor.x, sensor.y, sensor.z);
        if (!this._magReady) {
          this._magVec.copy(this._magTemp);
        } else {
          this._magVec.lerp(this._magTemp, 0.25);
        }
        this._magReady = true;
        if (this._updateTiltCompensatedHeading()) {
          this._tryInitialCompassAlign();
        }
      });
      sensor.addEventListener('error', () => {
        try { sensor.stop(); } catch { /* noop */ }
        this._magSensor = null;
        this._magReady = false;
      });
      sensor.start();
      this._magSensor = sensor;
    } catch {
      this._magSensor = null;
      this._magReady = false;
      // Magnetometer not available or permission denied; ignore silently.
    }
  }

  /**
   * Use magnetometer + orientation to compute a tilt-compensated heading.
   * Returns true if heading was updated.
   */
  _updateTiltCompensatedHeading() {
    if (!this._magReady) return false;

    const magNorm = this._magVec.length();
    if (magNorm < 1e-6) return false;

    // If we have a reliable orientation quaternion, rotate mag to world and read yaw
    if (this.orient?.ready) {
      const world = this._magWorld.copy(this._magVec).applyQuaternion(this._orientationQuat);
      // FIXED SIGN: use -x, -z to match yaw convention (0=N, CW+)
      const headingRaw = this._normalizeAngle(Math.atan2(-world.x, -world.z));

      // Compare against orientation-only heading to resolve possible 180° ambiguity
      const orientHeading = this._orientationHeading();
      let finalHeading = headingRaw;
      if (Number.isFinite(orientHeading)) {
        const diff = this._wrapPi(headingRaw - orientHeading);
        if (Math.abs(diff) > Math.PI / 2) finalHeading = this._normalizeAngle(headingRaw + Math.PI);
      }

      return this._setHeading(finalHeading, 'magnetometer');
    }

    // Fallback: use gravity vector to build a tilt frame and compensate mag manually
    if (!this._gravityReady) return false;

    const ax = -this._gravityVec.x;
    const ay = -this._gravityVec.y;
    const az = -this._gravityVec.z;
    const aNorm = Math.hypot(ax, ay, az);
    if (aNorm < 1e-6) return false;
    const axn = ax / aNorm;
    const ayn = ay / aNorm;
    const azn = az / aNorm;

    const mx = this._magVec.x / magNorm;
    const my = this._magVec.y / magNorm;
    const mz = this._magVec.z / magNorm;

    const roll = Math.atan2(ayn, azn);
    const horiz = Math.sqrt(ayn * ayn + azn * azn);
    if (horiz < 1e-6) return false;
    const pitch = Math.atan2(-axn, horiz);

    const sinRoll = Math.sin(roll);
    const cosRoll = Math.cos(roll);
    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);

    const mxComp = mx * cosPitch + mz * sinPitch;
    const myComp = mx * sinRoll * sinPitch + my * cosRoll - mz * sinRoll * cosPitch;

    // This formula already matches 0=N, CW+: keep as-is
    let headingRad = Math.atan2(-myComp, mxComp);
    if (!Number.isFinite(headingRad)) return false;

    headingRad = this._normalizeAngle(headingRad);
    return this._setHeading(headingRad, 'magnetometer');
  }

  _setHeading(headingRad, source = 'unknown') {
    if (!Number.isFinite(headingRad)) return false;
    let target = this._normalizeAngle(headingRad);

    // Smoothly approach target to reduce jitter
    if (Number.isFinite(this.headingRad)) {
      const delta = this._wrapPi(target - this.headingRad);
      target = this.headingRad + delta * 0.22; // EMA-ish
      target = this._normalizeAngle(target);
    }

    this.headingRad = target;
    const deg = THREE.MathUtils.radToDeg(target);
    this.headingDeg = (deg % 360 + 360) % 360;
    this.headingSource = source || this.headingSource || 'unknown';
    this.headingConfidence = source === 'magnetometer'
      ? Math.min(1, this.headingConfidence * 0.6 + 0.45)
      : Math.max(0.2, this.headingConfidence * 0.85);
    return true;
  }

  // One-time alignment: when we have a compass heading and an orientation, align yaw to heading.
  _tryInitialCompassAlign() {
    if (this._compassAligned) return;
    if (!Number.isFinite(this.headingRad)) return;
    if (!this.orient?.ready) return;

    const gyYaw = this._yawFromQuat(this._orientationQuat);
    const err = this._wrapPi(this.headingRad - gyYaw);
    this._yawOff += err;        // apply as calibration offset (do not touch pitch)
    this._compassAligned = true;
  }

  // --- Misc / UI --------------------------------------------------

  _setupAutoEnable() {
    this.enable()
      .then((res) => {
        if (!res?.success && res?.reason === 'gesture') this._installGestureEnable();
      })
      .catch(() => {
        this._installGestureEnable();
      });
  }

  _installGestureEnable() {
    if (this._autoGestureAttached) return;
    const handler = () => {
      this._clearGestureEnableHandlers();
      this.enable().catch(() => {});
    };
    this._autoGestureAttached = true;
    this._autoGestureHandler = handler;
    window.addEventListener('pointerdown', handler, { passive: true });
    window.addEventListener('touchstart', handler, { passive: true });
    window.addEventListener('keydown', handler, false);
    window.addEventListener('click', handler, false);
  }

  _clearGestureEnableHandlers() {
    if (!this._autoGestureAttached || !this._autoGestureHandler) return;
    const handler = this._autoGestureHandler;
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('touchstart', handler);
    window.removeEventListener('keydown', handler, false);
    window.removeEventListener('click', handler, false);
    this._autoGestureAttached = false;
    this._autoGestureHandler = null;
  }
}

export class GeoButton {
  constructor() {
    this.btn = document.getElementById('geo');
    if (!this.btn || !('geolocation' in navigator)) {
      if (this.btn) this.btn.style.display = 'none';
      return;
    }
    this.btn.addEventListener('click', () => this.ask(), { once: true });
  }
  ask() {
    navigator.geolocation.getCurrentPosition(p => {
      document.dispatchEvent(new CustomEvent('gps-updated', {
        detail: {
          lat: p.coords.latitude,
          lon: p.coords.longitude,
          accuracy: p.coords.accuracy,
          source: 'device'
        }
      }));
    }, () => { /* ignore */ }, { enableHighAccuracy: true });
  }
}
