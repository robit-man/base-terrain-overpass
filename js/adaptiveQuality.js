// adaptiveQuality.js
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

    // --- NEW: anti-thrash controls (tune as needed) ---
    qualityEps = 0.08,        // min quality delta to react
    qualityQuantum = 0.02,     // round quality to nearest step before comparing
    applyMinMsDown = 600,      // degrade quickly (lower quality)
    applyMinMsUp = 2000,       // recover slowly (raise quality)
    applyMinMsNeutral = 1500,  // fallback used when direction is unclear
    allowPeriodicResyncMs = 6000, // ensure we re-apply occasionally even if tiny drift
    debug = false,
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

    // Global anti-thrash config
    this._aq = {
      eps: qualityEps,
      qStep: qualityQuantum,
      minDown: applyMinMsDown,
      minUp: applyMinMsUp,
      minNeutral: applyMinMsNeutral,
      periodic: allowPeriodicResyncMs,
      debug: !!debug,
    };

    // name -> { apply, auto, last, lastQuality, lastQualityRounded, lastAppliedAt }
    this._subsystems = new Map();

    // last profile snapshot we exposed
    this._lastState = this._snapshot({});
  }

  /* ---------------- Public API ---------------- */

  registerSubsystem(name, { apply, auto = true } = {}) {
    if (!name || typeof apply !== 'function') {
      throw new Error('[AdaptiveQuality] Subsystems require a name and an apply(profile) function');
    }
    this._subsystems.set(name, {
      apply,
      auto: auto !== false,
      last: null,
      lastQuality: null,
      lastQualityRounded: null,
      lastAppliedAt: 0,
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

    const baseProfile = profile || this._tuner.profile();
    const { shouldApply, appliedProfile } = this._shouldApply(name, baseProfile, force);

    if (!shouldApply) return entry.last;

    try {
      entry.last = entry.apply(appliedProfile) ?? null;
      this._afterApply(name, appliedProfile);
    } catch (err) {
      console.warn(`[AdaptiveQuality] subsystem ${name} apply failed`, err);
    }
    return entry.last;
  }

  applyAll({ force = false, profile = null } = {}) {
    const baseProfile = profile || this._tuner.profile();
    const results = {};

    for (const [name, entry] of this._subsystems.entries()) {
      if (!entry.auto && !force) continue;

      const { shouldApply, appliedProfile } = this._shouldApply(name, baseProfile, force);
      if (shouldApply) {
        try {
          entry.last = entry.apply(appliedProfile) ?? null;
          this._afterApply(name, appliedProfile);
        } catch (err) {
          console.warn(`[AdaptiveQuality] subsystem ${name} apply failed`, err);
        }
      }
      results[name] = entry.last ?? null;
    }

    this._lastState = this._snapshot(results, baseProfile);
    return this._lastState;
  }

  sample({ dt = 0, fps } = {}) {
    // Pull a new adaptive profile from the PID/tuner
    const baseProfile = this._tuner.sample({ dt, fps });
    const results = {};

    for (const [name, entry] of this._subsystems.entries()) {
      if (!entry.auto) {
        results[name] = entry.last ?? null;
        continue;
      }

      const { shouldApply, appliedProfile } = this._shouldApply(name, baseProfile, /*force=*/false);
      if (shouldApply) {
        try {
          entry.last = entry.apply(appliedProfile) ?? null;
          this._afterApply(name, appliedProfile);
        } catch (err) {
          console.warn(`[AdaptiveQuality] subsystem ${name} apply failed`, err);
        }
      }
      results[name] = entry.last ?? null;
    }

    this._lastState = this._snapshot(results, baseProfile);
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

  /* ---------------- Internals ---------------- */

  _snapshot(results, profile = null) {
    const source = profile ? profile : this._tuner.profile();
    const base = { ...source };
    if (source?.pid) base.pid = { ...source.pid };
    return {
      ...base,
      subsystems: { ...results }
    };
  }

  _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  _quantizeQuality(q) {
    const step = this._aq.qStep;
    if (!Number.isFinite(step) || step <= 0) return q;
    return Math.round(q / step) * step;
  }

  _applyExtrasForSubsystem(name, baseProfile, meta) {
    // Don’t mutate the original profile object subsystems may already expect.
    // Instead, extend a shallow clone with advisory fields.
    const p = { ...baseProfile };
    p.aqm = {
      subsystem: name,
      applyReason: meta.reason,           // 'force' | 'delta' | 'interval' | 'periodic'
      quality: meta.q,                    // the candidate quality
      qualityRounded: meta.qRounded,      // rounded quality used for gating
      lastQuality: meta.lastQ,
      lastQualityRounded: meta.lastQRounded,
      delta: meta.delta,                  // signed delta (qRounded - lastQRounded)
      degrade: meta.degrade,              // true if quality decreased
      upgrade: meta.upgrade,              // true if quality increased
      timeSinceLastMs: meta.timeSince,
      // budget ramp hint: 0 at first frame after apply, rises to 1 over the min-interval
      rampHint: Math.max(0, Math.min(1, meta.timeSince / meta.minInterval)),
    };
    // Also surface a convenience boolean some subsystems may read literally.
    p.qualityApplied = p.aqm.qualityRounded;
    return p;
  }

  _shouldApply(name, baseProfile, force) {
    const entry = this._subsystems.get(name);
    if (!entry) return { shouldApply: false, appliedProfile: baseProfile };

    const now = this._now();
    const qRaw = Number(baseProfile?.quality);
    if (!Number.isFinite(qRaw)) {
      // If tuner didn’t provide quality, just apply (once) or when forced.
      if (force || entry.lastAppliedAt === 0) {
        const p = this._applyExtrasForSubsystem(name, baseProfile, {
          reason: force ? 'force' : 'interval',
          q: qRaw, qRounded: qRaw, lastQ: entry.lastQuality, lastQRounded: entry.lastQualityRounded,
          delta: 0, degrade: false, upgrade: false, timeSince: now - entry.lastAppliedAt, minInterval: this._aq.minNeutral,
        });
        return { shouldApply: true, appliedProfile: p };
      }
      return { shouldApply: false, appliedProfile: baseProfile };
    }

    const qRounded = this._quantizeQuality(qRaw);
    const lastQRounded = entry.lastQualityRounded;
    const lastQ = entry.lastQuality;
    const timeSince = now - (entry.lastAppliedAt || 0);

    if (force || entry.lastAppliedAt === 0 || lastQRounded == null) {
      const p = this._applyExtrasForSubsystem(name, baseProfile, {
        reason: force ? 'force' : 'interval',
        q: qRaw, qRounded, lastQ, lastQRounded, delta: 0,
        degrade: false, upgrade: false, timeSince, minInterval: this._aq.minNeutral,
      });
      return { shouldApply: true, appliedProfile: p };
    }

    const delta = qRounded - lastQRounded;
    const absDelta = Math.abs(delta);
    const degrade = delta < -this._aq.eps;  // quality down
    const upgrade = delta >  this._aq.eps;  // quality up

    // pick direction-sensitive min interval
    const minInterval = degrade ? this._aq.minDown : (upgrade ? this._aq.minUp : this._aq.minNeutral);

    // 1) strong delta & interval satisfied
    if ((degrade || upgrade) && timeSince > minInterval) {
      const p = this._applyExtrasForSubsystem(name, baseProfile, {
        reason: 'delta',
        q: qRaw, qRounded, lastQ, lastQRounded,
        delta, degrade, upgrade, timeSince, minInterval,
      });
      return { shouldApply: true, appliedProfile: p };
    }

    // 2) periodic resync (prevents “stuck” mismatches if a subsystem internally quantizes)
    if (this._aq.periodic > 0 && timeSince > this._aq.periodic) {
      const p = this._applyExtrasForSubsystem(name, baseProfile, {
        reason: 'periodic',
        q: qRaw, qRounded, lastQ, lastQRounded,
        delta, degrade, upgrade, timeSince, minInterval,
      });
      return { shouldApply: true, appliedProfile: p };
    }

    // 3) small delta: wait until it grows, or interval expires
    if (this._aq.debug) {
      // Light debug trace to verify gating (can be removed)
      // console.log(`[AQM] gate ${name} | Δq=${absDelta.toFixed(3)} time=${Math.round(timeSince)}ms`);
    }
    return { shouldApply: false, appliedProfile: baseProfile };
  }

  _afterApply(name, appliedProfile) {
    const entry = this._subsystems.get(name);
    if (!entry) return;
    const now = this._now();

    const q = Number(appliedProfile?.quality);
    const qRounded = Number(appliedProfile?.aqm?.qualityRounded ?? this._quantizeQuality(q));

    entry.lastAppliedAt = now;
    if (Number.isFinite(q)) entry.lastQuality = q;
    if (Number.isFinite(qRounded)) entry.lastQualityRounded = qRounded;
  }
}
