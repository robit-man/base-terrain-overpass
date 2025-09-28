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

    // Screen orientation (rad)
    this._screenOri = 0;

    // Math helpers
    this._zee = new THREE.Vector3(0, 0, 1);
    this._q0 = new THREE.Quaternion();
    this._q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)); // -PI/2 around X
    this._eulerIn = new THREE.Euler();   // for beta/alpha/gamma → quaternion
    this._eulerOut = new THREE.Euler();  // to read yaw/pitch (YXZ)

    // Bind handler once
    this._onDO = this._onDO.bind(this);

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
  }

  async enable() {
    try {
      if (typeof DeviceOrientationEvent?.requestPermission === 'function') {
        await DeviceOrientationEvent.requestPermission();
      }
    } catch { /* ignore permission errors */ }

    window.addEventListener('deviceorientation', this._onDO, true);
    this.enabled = true;

    // Tell listeners (e.g., ChaseCam) to calibrate to current camera orbit
    window.dispatchEvent(new CustomEvent('sensors-enabled'));

    if (this.btn) this.btn.disabled = true;
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

    // Extract yaw (around Y) and pitch (around X) without rolling the camera
    this._eulerOut.setFromQuaternion(q, 'YXZ');
    this._measPitch = this._eulerOut.x;
    this._measYaw   = this._eulerOut.y;

    // Apply calibration offsets to produce final camera-facing angles
    this.yaw   = this._measYaw   + this._yawOff;
    this.pitch = this._measPitch + this._pitchOff;
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
        detail: { lat: p.coords.latitude, lon: p.coords.longitude }
      }));
    }, () => { /* ignore */ }, { enableHighAccuracy: true });
  }
}
