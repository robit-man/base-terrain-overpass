import { PerformanceTuner } from './performance.js';

export class AdaptiveQualityManager {
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
    this._tuner = new PerformanceTuner({
      targetFps,
      minQuality,
      maxQuality,
      hudInterval,
      smoothing,
      kp,
      ki,
      kd,
      gain,
      deadband,
    });
    this._subsystems = new Map(); // name -> { apply, auto, last }
    this._lastState = this._snapshot({});
  }

  registerSubsystem(name, { apply, auto = true } = {}) {
    if (!name || typeof apply !== 'function') {
      throw new Error('[AdaptiveQuality] Subsystems require a name and an apply(profile) function');
    }
    this._subsystems.set(name, {
      apply,
      auto: auto !== false,
      last: null,
    });
  }

  setSubsystemAuto(name, enabled) {
    const entry = this._subsystems.get(name);
    if (!entry) return;
    entry.auto = !!enabled;
  }

  applySubsystem(name, { force = false, profile = null } = {}) {
    const entry = this._subsystems.get(name);
    if (!entry) return null;
    if (!entry.auto && !force) return entry.last;
    const snapshot = profile || this._tuner.profile();
    try {
      entry.last = entry.apply(snapshot) ?? null;
    } catch (err) {
      console.warn(`[AdaptiveQuality] subsystem ${name} apply failed`, err);
    }
    return entry.last;
  }

  applyAll({ force = false, profile = null } = {}) {
    const snapshot = profile || this._tuner.profile();
    const results = {};
    for (const [name, entry] of this._subsystems.entries()) {
      if (!entry.auto && !force) continue;
      try {
        entry.last = entry.apply(snapshot) ?? null;
      } catch (err) {
        console.warn(`[AdaptiveQuality] subsystem ${name} apply failed`, err);
      }
      results[name] = entry.last;
    }
    this._lastState = this._snapshot(results, snapshot);
    return this._lastState;
  }

  sample({ dt = 0, fps } = {}) {
    const profile = this._tuner.sample({ dt, fps });
    const results = {};
    for (const [name, entry] of this._subsystems.entries()) {
      if (!entry.auto) {
        results[name] = entry.last ?? null;
        continue;
      }
      try {
        entry.last = entry.apply(profile) ?? null;
      } catch (err) {
        console.warn(`[AdaptiveQuality] subsystem ${name} apply failed`, err);
      }
      results[name] = entry.last;
    }
    this._lastState = this._snapshot(results, profile);
    return this._lastState;
  }

  profile() {
    return this._snapshot(
      Object.fromEntries([...this._subsystems.entries()].map(([name, entry]) => [name, entry.last ?? null])),
      this._tuner.profile()
    );
  }

  latestSubsystem(name) {
    return this._subsystems.get(name)?.last ?? null;
  }

  setTargetFps(fps) {
    this._tuner.setTargetFps(fps);
  }

  setPidTuning(params) {
    this._tuner.setPidTuning(params);
  }

  resetPidState() {
    this._tuner.resetPidState();
  }

  _snapshot(results, profile = null) {
    const source = profile ? profile : this._tuner.profile();
    const base = { ...source };
    if (source?.pid) base.pid = { ...source.pid };
    return { ...base, subsystems: { ...results } };
  }
}
