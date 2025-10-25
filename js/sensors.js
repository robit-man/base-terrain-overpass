// sensors.js — drop-in replacement
// Fixes:
//  • Correct device quaternion mapping (YXZ → -PI/2 around X → -screen orientation around Z)
//  • Pitch extracted in a yaw-free frame (kills the 2× pitch artifact)
//  • Roll extracted after removing yaw & pitch (prevents coupling → “2× roll”)
//  • Consistent yaw sign (0 = North/-Z, positive clockwise to East/+X)
//  • One-time compass alignment sets yaw offset correctly
//  • Exposes cameraQuat = yawOff ∘ device ∘ pitchOffLocal  (single source of truth)
import * as THREE from 'three';

export class Sensors {
  constructor() {
    // Optional UI button
    this.btn = document.getElementById('request');

    // Legacy surface (degrees) for back-compat
    this.orient = { a: 0, b: 0, g: 0, ready: false };

    // Enabled/ready flags
    this.enabled = false;
    this.ready = false;

    // Measured (pre-calibration) yaw/pitch/roll (rad)
    this._measYaw = 0;
    this._measPitch = 0;
    this._measRoll = 0;

    // Public calibrated angles (Euler path)
    this.yaw = 0;
    this.pitch = 0;
    this.roll = 0; // exposed for debugging/UI; not typically applied in scene

    // Calibration offsets (rad)
    this._yawOff = 0;    // world-Y
    this._pitchOff = 0;  // local-X (optional; keep 0 if you don’t want pitch bias)

    // One-time yaw align to compass heading
    this._compassAligned = false;

    // Screen orientation (radians)
    this._screenOri = 0;

    // Math helpers
    this._zee = new THREE.Vector3(0, 0, 1);
    this._yAxis = new THREE.Vector3(0, 1, 0);
    this._xAxis = new THREE.Vector3(1, 0, 0);

    // -PI/2 around X (to convert device frame to camera-forward frame)
    this._qTilt = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);

    // Input Euler for deviceorientation -> quaternion
    this._eulerIn = new THREE.Euler(); // (beta, alpha, -gamma) in 'YXZ'

    // Device quaternion (screen-compensated, no offsets)
    this._orientationQuat = new THREE.Quaternion();

    // Offset quaternions
    this._qYawOff = new THREE.Quaternion();        // world-Y, pre-multiply
    this._qPitchOffLocal = new THREE.Quaternion(); // local-X, post-multiply

    // Final, camera-ready quaternion (recommended to drive camera directly)
    this.cameraQuat = new THREE.Quaternion();

    // Temps
    this._fwd = new THREE.Vector3(0, 0, -1);
    this._up = new THREE.Vector3(0, 1, 0);
    this._right = new THREE.Vector3(1, 0, 0);
    this._tmpV = new THREE.Vector3();
    this._qYawInv = new THREE.Quaternion();
    this._qTmp = new THREE.Quaternion();
    this._q0 = new THREE.Quaternion();      // for pitch inverse
    this._qTmp2 = new THREE.Quaternion();   // additional temp to avoid aliasing

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

    // Platform-reported heading (iOS)
    this._webHeadingDeg = null;

    // Gravity for tilt-comp fallback
    this._gravityVec = new THREE.Vector3();
    this._gravityTemp = new THREE.Vector3();
    this._gravityReady = false;

    // Enable flow
    this._enabling = false;
    this._autoGestureAttached = false;
    this._autoGestureHandler = null;

    // Public heading state
    this.headingDeg = null; // 0..360
    this.headingRad = null; // 0..2π, 0 = North(-Z), clockwise +
    this.headingSource = 'unknown';
    this.headingConfidence = 0;

    // Bind handlers
    this._onDO = this._onDO.bind(this);
    this._onDM = this._onDM.bind(this);

    // UI wiring
    if (this.btn) this.btn.addEventListener('click', () => this.enable(), { once: true });

    // Track screen orientation
    const updateSO = () => {
      const ang = (screen.orientation && typeof screen.orientation.angle === 'number')
        ? screen.orientation.angle
        : (window.orientation || 0);
      this._screenOri = THREE.MathUtils.degToRad(ang || 0);
    };
    updateSO();
    window.addEventListener('orientationchange', updateSO, false);

    this._setupAutoEnable();
  }

  // ───────────────────── Public API ─────────────────────

  async enable() {
    if (this.enabled) { this._startMagnetometer(); return { success: true }; }
    if (this._enabling) return { success: false, reason: 'pending' };

    this._enabling = true;
    let reason = null;
    try {
      // iOS permission prompts (orientation is the one that blocks)
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        let status;
        try { status = await DeviceOrientationEvent.requestPermission(); }
        catch (err) { reason = (`${err?.message||''}`).toLowerCase().includes('gesture') ? 'gesture' : 'error'; }
        if (!reason && status && status !== 'granted') reason = (status === 'denied') ? 'denied' : 'error';
      }
      if (reason) return { success: false, reason };

      if (typeof DeviceMotionEvent?.requestPermission === 'function') {
        try { await DeviceMotionEvent.requestPermission(); } catch {}
      }

      const type = ('ondeviceorientationabsolute' in window)
        ? 'deviceorientationabsolute' : 'deviceorientation';
      window.addEventListener(type, this._onDO, true);

      if (!this._motionListening) {
        window.addEventListener('devicemotion', this._onDM, true);
        this._motionListening = true;
      }

      this.enabled = true;
      window.dispatchEvent(new CustomEvent('sensors-enabled')); // let scene calibrate
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

  calibrate(targetYaw, targetPitch) {
    this._yawOff   = (targetYaw   || 0) - this._measYaw;
    this._pitchOff = (targetPitch || 0) - this._measPitch;
    this.ready = true;
    this.orient.ready = true;
  }

  /** Euler path (radians). Prefer getCameraQuaternion() instead. */
  getYawPitch() { return { yaw: this.yaw, pitch: this.pitch, ready: (this.ready && this.enabled) }; }

  /** Device quaternion (screen-compensated, without offsets). */
  getQuaternion() { return { q: this._orientationQuat.clone(), ready: (this.ready && this.enabled) }; }

  /** Final camera quaternion (includes yaw & optional pitch offsets). */
  getCameraQuaternion() { return { q: this.cameraQuat.clone(), ready: (this.ready && this.enabled) }; }

  /** Heading info. */
  getHeading() {
    return { rad: this.headingRad, deg: this.headingDeg, source: this.headingSource, confidence: this.headingConfidence };
  }

  getAcceleration() { return this.motion; }

  // ───────────────────── Internals ─────────────────────

  _screenAngleDeg() {
    if (screen.orientation && typeof screen.orientation.angle === 'number') return screen.orientation.angle || 0;
    return (typeof window.orientation === 'number') ? (window.orientation || 0) : 0;
  }

  /** Yaw from world Y: 0 = North(-Z), +90° = East(+X), clockwise positive. */
  _yawFromQuat(q) {
    this._tmpV.copy(this._fwd).applyQuaternion(q); // forward in world
    return Math.atan2(-this._tmpV.x, -this._tmpV.z);
  }

  /**
   * Extract yaw, then remove yaw to get pure pitch, then remove pitch to get pure roll.
   * This prevents Euler coupling (the "2×" artifacts).
   */
  _extractYawPitchRoll(q) {
    // 1) Yaw from forward vector in world
    const yaw = this._yawFromQuat(q);

    // 2) Remove yaw → qNoYaw (use _qTmp for qNoYaw)
    this._qYawInv.setFromAxisAngle(this._yAxis, -yaw);
    this._qTmp.copy(q).premultiply(this._qYawInv); // qNoYaw = yaw^-1 ∘ q

    // 3) Pitch from elevation of forward (in yaw-free frame)
    this._tmpV.copy(this._fwd).applyQuaternion(this._qTmp);
    const pitch = Math.atan2(this._tmpV.y, Math.hypot(this._tmpV.x, this._tmpV.z)); // [-π/2, +π/2]

    // 4) Remove pitch → qRollOnly (use _qTmp2 to avoid aliasing)
    this._q0.setFromAxisAngle(this._xAxis, -pitch); // Rx(-pitch)
    this._qTmp2.copy(this._qTmp).premultiply(this._q0); // roll about Z remains

    // 5) Roll from right vector in roll-only frame (about Z)
    this._tmpV.copy(this._right).applyQuaternion(this._qTmp2);
    const roll = Math.atan2(this._tmpV.y, this._tmpV.x); // [-π, +π]

    return { yaw, pitch, roll };
  }

  _normalizeAngle(rad) {
    const twoPi = Math.PI * 2;
    let out = rad % twoPi;
    if (out < 0) out += twoPi;
    return out;
  }
  _wrapPi(rad) { return Number.isFinite(rad) ? Math.atan2(Math.sin(rad), Math.cos(rad)) : 0; }

  _orientationHeading() {
    const yaw = this._yawFromQuat(this._orientationQuat);
    return Number.isFinite(yaw) ? this._normalizeAngle(yaw) : null;
  }

  _composeFinalQuat() {
    // Build offset quats
    this._qYawOff.setFromAxisAngle(this._yAxis, this._yawOff);         // world-Y (pre)
    this._qPitchOffLocal.setFromAxisAngle(this._xAxis, this._pitchOff); // local-X (post)

    // cameraQuat = yawOff ∘ device ∘ pitchOffLocal
    this.cameraQuat.copy(this._orientationQuat);
    this.cameraQuat.premultiply(this._qYawOff);
    this.cameraQuat.multiply(this._qPitchOffLocal);
  }

  // ───────────────────── Event handlers ─────────────────────

  _onDO(e) {
    const a = e.alpha, b = e.beta, g = e.gamma;
    if (a == null && b == null && g == null) return;

    // Legacy (deg)
    this.orient.a = a || 0;
    this.orient.b = b || 0;
    this.orient.g = g || 0;
    this.orient.ready = true;

    // Convert to radians
    const alpha = THREE.MathUtils.degToRad(this.orient.a);
    const beta  = THREE.MathUtils.degToRad(this.orient.b);
    const gamma = THREE.MathUtils.degToRad(this.orient.g);

    // Device quaternion: set(beta, alpha, -gamma, 'YXZ') → -PI/2 X → -screen orientation Z
    this._orientationQuat
      .setFromEuler(this._eulerIn.set(beta, alpha, -gamma, 'YXZ'))
      .multiply(this._qTilt)
      .multiply(this._q0.setFromAxisAngle(this._zee, -this._screenOri));

    // Clean extraction (yaw-free pitch, then roll)
    const { yaw, pitch, roll } = this._extractYawPitchRoll(this._orientationQuat);
    this._measYaw = yaw;
    this._measPitch = pitch;
    this._measRoll = roll;

    // Calibrated Euler outputs (if your scene uses split nodes)
    this.yaw   = this._measYaw   + this._yawOff;
    this.pitch = this._measPitch + this._pitchOff;
    this.roll  = this._measRoll; // typically 0 in device frame unless you twist the phone

    // Compose final camera quaternion (preferred)
    this._composeFinalQuat();

    // Platform heading (iOS)
    if (typeof e.webkitCompassHeading === 'number' && Number.isFinite(e.webkitCompassHeading)) {
      this._webHeadingDeg = (e.webkitCompassHeading % 360 + 360) % 360;
      this._setHeading(THREE.MathUtils.degToRad(this._webHeadingDeg), 'webkit');
      this._tryInitialCompassAlign();
      return;
    }

    // Alpha-based fallback heading (matches compass-ring math)
    if (typeof e.alpha === 'number' && Number.isFinite(e.alpha)) {
      let hdg = 360 - e.alpha;       // clockwise from North
      hdg += this._screenAngleDeg(); // correct for screen rotation
      this._setHeading(THREE.MathUtils.degToRad((hdg % 360 + 360) % 360), 'orientation');
      this._tryInitialCompassAlign();
      return;
    }

    // Last resort: derive from orientation quaternion
    const oHead = this._orientationHeading();
    if (Number.isFinite(oHead)) {
      this._setHeading(oHead, 'orientation');
      this._tryInitialCompassAlign();
    } else if (!Number.isFinite(this.headingRad)) {
      this.headingDeg = null;
      this.headingRad = null;
      this.headingSource = 'unknown';
      this.headingConfidence = 0;
    }
  }

  _onDM(e) {
    const incl = e.accelerationIncludingGravity;
    if (incl) {
      this._gravityTemp.set(incl.x ?? 0, incl.y ?? 0, incl.z ?? 0);
      if (!this._gravityReady) { this._gravityVec.copy(this._gravityTemp); this._gravityReady = true; }
      else { this._gravityVec.lerp(this._gravityTemp, 0.18); }
      if (this._updateTiltCompensatedHeading()) this._tryInitialCompassAlign();
    }

    let ax = 0, ay = 0, az = 0;
    if (e.acceleration) {
      ax = e.acceleration.x ?? 0; ay = e.acceleration.y ?? 0; az = e.acceleration.z ?? 0;
    } else if (incl) {
      ax = (incl.x ?? 0) - this._gravityVec.x;
      ay = (incl.y ?? 0) - this._gravityVec.y;
      az = (incl.z ?? 0) - this._gravityVec.z;
    }

    this._accelRaw.set(ax, ay, az);
    const worldVec = this._accelWorld.copy(this._accelRaw).applyQuaternion(this._orientationQuat);
    this.motion.ax = worldVec.x; this.motion.ay = worldVec.y; this.motion.az = worldVec.z;
    this.motion.ready = true;
    this.motion.timestamp = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  // ───────────── Magnetometer / Heading ─────────────

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
        if (!this._magReady) this._magVec.copy(this._magTemp);
        else this._magVec.lerp(this._magTemp, 0.25);
        this._magReady = true;
        if (this._updateTiltCompensatedHeading()) this._tryInitialCompassAlign();
      });
      sensor.addEventListener('error', () => {
        try { sensor.stop(); } catch {}
        this._magSensor = null; this._magReady = false;
      });
      sensor.start();
      this._magSensor = sensor;
    } catch {
      this._magSensor = null; this._magReady = false;
    }
  }

  _updateTiltCompensatedHeading() {
    if (!this._magReady) return false;

    const magNorm = this._magVec.length();
    if (magNorm < 1e-6) return false;

    // Use orientation quaternion to rotate mag → world, then read heading
    if (this.orient?.ready) {
      const world = this._magWorld.copy(this._magVec).applyQuaternion(this._orientationQuat);
      const headingRaw = this._normalizeAngle(Math.atan2(-world.x, -world.z)); // 0=N, CW+
      const oHead = this._orientationHeading();
      let finalHeading = headingRaw;
      if (Number.isFinite(oHead)) {
        const diff = this._wrapPi(headingRaw - oHead);
        if (Math.abs(diff) > Math.PI / 2) finalHeading = this._normalizeAngle(headingRaw + Math.PI);
      }
      return this._setHeading(finalHeading, 'magnetometer');
    }

    // Fallback: gravity-based tilt compensation
    if (!this._gravityReady) return false;

    const ax = -this._gravityVec.x, ay = -this._gravityVec.y, az = -this._gravityVec.z;
    const aNorm = Math.hypot(ax, ay, az); if (aNorm < 1e-6) return false;
    const axn = ax / aNorm, ayn = ay / aNorm, azn = az / aNorm;

    const mx = this._magVec.x / magNorm, my = this._magVec.y / magNorm, mz = this._magVec.z / magNorm;

    const roll = Math.atan2(ayn, azn);
    const horiz = Math.sqrt(ayn * ayn + azn * azn); if (horiz < 1e-6) return false;
    const pitch = Math.atan2(-axn, horiz);

    const sr = Math.sin(roll), cr = Math.cos(roll);
    const sp = Math.sin(pitch), cp = Math.cos(pitch);

    const mxComp = mx * cp + mz * sp;
    const myComp = mx * sr * sp + my * cr - mz * sr * cp;

    let headingRad = Math.atan2(-myComp, mxComp); // 0=N, CW+
    if (!Number.isFinite(headingRad)) return false;

    headingRad = this._normalizeAngle(headingRad);
    return this._setHeading(headingRad, 'magnetometer');
  }

  _setHeading(headingRad, source = 'unknown') {
    if (!Number.isFinite(headingRad)) return false;
    let target = this._normalizeAngle(headingRad);
    if (Number.isFinite(this.headingRad)) {
      const delta = this._wrapPi(target - this.headingRad);
      target = this._normalizeAngle(this.headingRad + delta * 0.22);
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

  _tryInitialCompassAlign() {
    if (this._compassAligned) return;
    if (!Number.isFinite(this.headingRad)) return;
    if (!this.orient?.ready) return;

    const gyYaw = this._yawFromQuat(this._orientationQuat);
    const err = this._wrapPi(this.headingRad - gyYaw);
    this._yawOff += err;           // align world-Y once
    this._composeFinalQuat();
    this._compassAligned = true;
  }

  // ───────────────────── Auto-enable helpers ─────────────────────

  _setupAutoEnable() {
    this.enable()
      .then((res) => { if (!res?.success && res?.reason === 'gesture') this._installGestureEnable(); })
      .catch(() => { this._installGestureEnable(); });
  }

  _installGestureEnable() {
    if (this._autoGestureAttached) return;
    const handler = () => { this._clearGestureEnableHandlers(); this.enable().catch(() => {}); };
    this._autoGestureAttached = true;
    this._autoGestureHandler = handler;
    window.addEventListener('pointerdown', handler, { passive: true });
    window.addEventListener('touchstart', handler, { passive: true });
    window.addEventListener('keydown', handler, false);
    window.addEventListener('click', handler, false);
  }

  _clearGestureEnableHandlers() {
    if (!this._autoGestureAttached || !this._autoGestureHandler) return;
    const h = this._autoGestureHandler;
    window.removeEventListener('pointerdown', h);
    window.removeEventListener('touchstart', h);
    window.removeEventListener('keydown', h, false);
    window.removeEventListener('click', h, false);
    this._autoGestureAttached = false;
    this._autoGestureHandler = null;
  }
}

export class GeoButton {
  constructor() {
    this.btn = document.getElementById('geo');
    if (!this.btn || !('geolocation' in navigator)) { if (this.btn) this.btn.style.display = 'none'; return; }
    this.btn.addEventListener('click', () => this.ask(), { once: true });
  }
  ask() {
    navigator.geolocation.getCurrentPosition(p => {
      document.dispatchEvent(new CustomEvent('gps-updated', {
        detail: { lat: p.coords.latitude, lon: p.coords.longitude, accuracy: p.coords.accuracy, source: 'device' }
      }));
    }, () => {}, { enableHighAccuracy: true });
  }
}
