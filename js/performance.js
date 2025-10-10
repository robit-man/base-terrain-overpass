const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export class PerformanceTuner {
  constructor({
    targetFps = 60,
    minQuality = 0.35,
    maxQuality = 1.05,
    hudInterval = 0.35,
    smoothing = 0.1,
    kp = 0.045,
    ki = 0.02,
    kd = 0.015,
    gain = 0.3,
    deadband = 1.2,
  } = {}) {
    this.targetFps = targetFps;
    this.minQuality = minQuality;
    this.maxQuality = maxQuality;
    this.hudInterval = hudInterval;
    this.smoothing = smoothing;
    this.kp = kp;
    this.ki = ki;
    this.kd = kd;
    this.gain = gain;
    this.deadband = deadband;

    this._quality = clamp(1, minQuality, maxQuality);
    this._smoothedFps = targetFps;
    this._integral = 0;
    this._lastError = 0;
    this._integralLimit = 240; // prevents wind-up under steady low FPS
    this._hudTimer = 0;
    this._lastDerivative = 0;
    this._lastDelta = 0;
    this._qualityNotify = this._quality;
    this._qualityEpsilon = 0.015;
    this._profile = {
      targetFps: this.targetFps,
      smoothedFps: this._smoothedFps,
      quality: this._quality,
      level: 'high',
      pid: {
        error: 0,
        integral: 0,
        derivative: 0,
        delta: 0,
        kp: this.kp,
        ki: this.ki,
        kd: this.kd,
        gain: this.gain,
        deadband: this.deadband,
        smoothing: this.smoothing,
      },
    };
  }

  sample({ dt, fps }) {
    const safeDt = Math.max(1e-3, dt || 0);
    const sampleFps = Number.isFinite(fps) ? fps : this.targetFps;
    const alpha = clamp(this.smoothing, 0.01, 1);
    this._smoothedFps = this._smoothedFps * (1 - alpha) + sampleFps * alpha;

    let error = this.targetFps - this._smoothedFps;
    if (Math.abs(error) < this.deadband) error = 0;

    this._integral = clamp(this._integral + error * safeDt, -this._integralLimit, this._integralLimit);
    const derivative = (error - this._lastError) / safeDt;
    this._lastDerivative = derivative;
    const control = this.kp * error + this.ki * this._integral + this.kd * derivative;
    this._lastError = error;

    const delta = control * this.gain * safeDt;
    this._lastDelta = delta;
    if (Math.abs(delta) > 1e-6) {
      this._quality = clamp(this._quality - delta, this.minQuality, this.maxQuality);
    }

    this._hudTimer += safeDt;
    const hudReady = this._hudTimer >= this.hudInterval;
    if (hudReady) this._hudTimer = 0;

    const level = this._levelForQuality(this._quality);
    const qualityChanged = Math.abs(this._quality - this._qualityNotify) > this._qualityEpsilon;
    if (qualityChanged) this._qualityNotify = this._quality;

    this._profile = {
      targetFps: this.targetFps,
      smoothedFps: this._smoothedFps,
      quality: this._quality,
      level,
      hudReady,
      qualityChanged,
      pid: {
        error,
        integral: this._integral,
        derivative: this._lastDerivative,
        delta: this._lastDelta,
        kp: this.kp,
        ki: this.ki,
        kd: this.kd,
        gain: this.gain,
        deadband: this.deadband,
        smoothing: this.smoothing,
      },
    };

    return this._profile;
  }

  profile() {
    return { ...this._profile };
  }

  setTargetFps(fps) {
    if (!Number.isFinite(fps) || fps <= 0) return;
    this.targetFps = fps;
    this._profile.targetFps = fps;
  }

  setPidTuning({
    kp,
    ki,
    kd,
    gain,
    deadband,
    smoothing,
  } = {}) {
    if (Number.isFinite(kp)) this.kp = kp;
    if (Number.isFinite(ki)) this.ki = ki;
    if (Number.isFinite(kd)) this.kd = kd;
    if (Number.isFinite(gain)) this.gain = gain;
    if (Number.isFinite(deadband) && deadband >= 0) this.deadband = deadband;
    if (Number.isFinite(smoothing) && smoothing > 0) this.smoothing = smoothing;
    if (this._profile?.pid) {
      this._profile.pid = {
        ...this._profile.pid,
        kp: this.kp,
        ki: this.ki,
        kd: this.kd,
        gain: this.gain,
        deadband: this.deadband,
        smoothing: this.smoothing,
      };
    }
  }

  resetPidState() {
    this._integral = 0;
    this._lastError = 0;
    this._lastDerivative = 0;
    this._lastDelta = 0;
    if (this._profile?.pid) {
      this._profile.pid = {
        ...this._profile.pid,
        error: 0,
        integral: 0,
        derivative: 0,
        delta: 0,
      };
    }
  }

  _levelForQuality(q) {
    if (q >= 0.82) return 'high';
    if (q >= 0.6) return 'medium';
    return 'low';
  }
}
