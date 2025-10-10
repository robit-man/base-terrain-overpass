import * as THREE from 'three';

export class AudioEngine {
  constructor(sceneMgr) {
    this.scene = sceneMgr.scene;
    this.listener = new THREE.AudioListener();
    sceneMgr.camera.add(this.listener);
    this.ctx = this.listener.context;
    this._enabled = false;

    // Tuning
    this.volume = 0.16;
    this.refDistance = 18;
    this.rolloff = 2.0;

    // Blip (formerly "scratch")
    this.duration = 0.2;                 // 200 ms target
    this.blipFreq = 12000;               // 12 kHz carrier
    this.MAX_VOICES = 64;
    this._voices = 0;

    // Impact
    this.impactDuration = 0.22;
    this.impactVolume = 0.22;
    this._impactBufferCache = new Map();

    // Ambient low hum
    this.humVolume = 0.08;
    this.humFreq = 60;                    // base hum frequency (Hz)
    this.humDetune = 1.01;                // slight beating
    this.humFade = 0.35;                  // seconds (ease in/out)
    this._humNodes = null;                // created on demand

    // Prebuild a few blip buffers
    this._blipBuffers = this._makeBlipBuffers(3);

    const resume = () => {
      try { this.ctx.resume?.(); } catch { }
      this._enabled = true;
      window.removeEventListener('pointerdown', resume);
      window.removeEventListener('touchstart', resume);
      window.removeEventListener('keydown', resume);
    };
    window.addEventListener('pointerdown', resume, { once:true });
    window.addEventListener('touchstart', resume, { once:true });
    window.addEventListener('keydown', resume, { once:true });
  }

  /** ---------- Ambient Low Hum (non-positional) ---------- */
  startHum(volume = this.humVolume, freq = this.humFreq) {
    if (!this._enabled) return;
    if (this._humNodes) return; // already running
    const ctx = this.ctx;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';
    osc1.frequency.value = freq;
    osc2.frequency.value = freq * this.humDetune;

    // Gentle highcut (remove harshness) and tiny saturation feel
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240; // keep it low/rumbling

    gain.gain.value = 0.0; // fade in
    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(lp);
    lp.connect(this.listener.getInput());

    const now = ctx.currentTime;
    const target = Math.max(0, volume);
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(0.0, now);
    gain.gain.linearRampToValueAtTime(target, now + this.humFade);

    osc1.start();
    osc2.start();

    this._humNodes = { osc1, osc2, gain, lp };
  }

  stopHum() {
    const n = this._humNodes;
    if (!n) return;
    const now = this.ctx.currentTime;
    n.gain.gain.cancelScheduledValues(now);
    n.gain.gain.setValueAtTime(n.gain.gain.value, now);
    n.gain.gain.linearRampToValueAtTime(0.0, now + this.humFade);
    // stop and disconnect after fade
    setTimeout(() => {
      try { n.osc1.stop(); n.osc2.stop(); } catch {}
      [n.osc1, n.osc2, n.gain, n.lp].forEach(node => {
        try { node.disconnect(); } catch {}
      });
      this._humNodes = null;
    }, (this.humFade * 1000) + 30);
  }

  /** ---------- 12 kHz Blips (replaces old scratch) ---------- */
  _makeBlipBuffers(n) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const sr = this.ctx.sampleRate;
      const len = Math.max(1, Math.floor(sr * this.duration)); // ~0.2s
      const buf = this.ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);

      // Slight random detune and AM to avoid total sameness
      const f0 = this.blipFreq * (0.995 + Math.random() * 0.01);
      const amHz = 12 + Math.random() * 20;
      const twoPI = 2 * Math.PI;

      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const x = i / (len - 1);
        // Hann window for smooth fade in/out
        const env = Math.sin(Math.PI * x) ** 1.0; // 0→1→0
        const am = 0.85 + 0.15 * Math.sin(twoPI * amHz * t);
        data[i] = Math.sin(twoPI * f0 * t) * env * am;
      }
      out.push(buf);
    }
    return out;
  }

  triggerScratch(x, y, z, gainMul = 0.2) {
    // Plays a short, band-limited 12kHz blip with ease-in/out
    if (!this._enabled || !this.listener || this._voices >= this.MAX_VOICES) return;

    const holder = new THREE.Object3D();
    holder.position.set(x, y, z);
    this.scene.add(holder);

    const snd = new THREE.PositionalAudio(this.listener);
    const buf = this._blipBuffers[(Math.random() * this._blipBuffers.length) | 0];
    snd.setBuffer(buf);
    snd.setRefDistance(this.refDistance);
    snd.setRolloffFactor(this.rolloff);
    snd.setVolume(this.volume * gainMul);

    // Tiny playback variation
    const rate = 0.985 + Math.random() * 0.03;
    if (typeof snd.setPlaybackRate === 'function') snd.setPlaybackRate(rate);
    else snd.playbackRate = rate;

    holder.add(snd);
    this._voices++;
    try { snd.play(); } catch { }

    const ms = (this.duration / rate) * 1000 + 60;
    setTimeout(() => {
      try { snd.stop(); } catch { }
      holder.remove(snd);
      this.scene.remove(holder);
      this._voices = Math.max(0, this._voices - 1);
    }, ms);
  }

  /** ---------- Impacts: modal “bump” synthesis ---------- */
  _getPhysicalImpactBuffer({ mass = 1.0, hardness = 0.5, velocity = 1.0, duration = this.impactDuration, roughness = 0.15 } = {}) {
    // Cache key
    const key = `phys:${mass.toFixed(2)}:${hardness.toFixed(2)}:${velocity.toFixed(2)}:${duration.toFixed(2)}:${roughness.toFixed(2)}`;
    if (this._impactBufferCache.has(key)) return this._impactBufferCache.get(key);

    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * duration));
    const buffer = this.ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);

    // Base frequency from "stiffness/mass" intuition
    // (not literal physics, but maps well perceptually)
    const stiffness = THREE.MathUtils.clamp(hardness, 0, 1);  // 0=soft/low, 1=hard/bright
    const baseF = 90 + 310 * stiffness;                       // ~90-400 Hz
    const velBoost = 1 + 0.25 * THREE.MathUtils.clamp(velocity, 0, 4);
    const f1 = baseF * velBoost;

    // Heavier objects ring a bit longer, soft ones damp faster
    const baseTau = 0.06 + 0.24 * (mass / (mass + 1)) * (0.25 + 0.75 * (1 - stiffness));
    const tau1 = baseTau;             // primary mode
    const tau2 = baseTau * 0.7;       // overtones damp faster
    const tau3 = baseTau * 0.45;

    // Three modal partials typical for “thud”
    const modes = [
      { f: f1,       a: 1.00, tau: tau1 },
      { f: f1 * 1.5, a: 0.55, tau: tau2 },
      { f: f1 * 2.2, a: 0.35, tau: tau3 }
    ];

    // Short noise burst for contact (stick-slip / material texture)
    const contactLen = Math.min(len, Math.floor(0.008 * sr)); // ~8ms
    const twoPI = 2 * Math.PI;

    // Build signal
    let phases = modes.map(() => Math.random() * twoPI); // slight randomness
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const x = i / (len - 1);

      // Very fast attack (ease-in), slow ease-out to zero
      const attack = Math.min(1, x * 60);                 // ~16ms to full
      const release = (1 - x) ** 2.6;
      let sum = 0.0;

      for (let m = 0; m < modes.length; m++) {
        const { f, a, tau } = modes[m];
        phases[m] += twoPI * f / sr;
        const env = Math.exp(-t / tau);
        sum += Math.sin(phases[m]) * a * env;
      }

      // Contact burst (very short, mostly high freq)
      let contact = 0;
      if (i < contactLen) {
        const w = Math.sin(Math.PI * (i / (contactLen - 1))); // Hann
        const white = (Math.random() * 2 - 1);
        contact = white * w * (0.25 + 0.75 * stiffness);
      }

      // Roughness blends some noise into the ring
      const micro = (Math.random() * 2 - 1) * THREE.MathUtils.clamp(roughness, 0, 1) * 0.15;

      data[i] = (sum + contact + micro) * attack * release;
    }

    // Normalize a touch to avoid clipping at high velocity
    let max = 0;
    for (let i = 0; i < len; i++) max = Math.max(max, Math.abs(data[i]));
    const norm = max > 0 ? 1 / (max * 1.05) : 1;
    if (norm !== 1) for (let i = 0; i < len; i++) data[i] *= norm;

    this._impactBufferCache.set(key, buffer);
    return buffer;
  }

  // Back-compat wrapper to map legacy params to physical model
  _getImpactBuffer(frequency = 120, roughness = 0.2, duration = this.impactDuration) {
    // Map: higher frequency ≈ harder object; roughness passes through.
    const hardness = THREE.MathUtils.clamp((frequency - 90) / 310, 0, 1);
    return this._getPhysicalImpactBuffer({ mass: 1.0, hardness, velocity: 1.0, duration, roughness });
  }

  triggerImpact(
    x, y, z,
    // New physical params (preferred): mass [kg], hardness [0..1], velocity [m/s]
    // Legacy still supported: intensity/frequency/roughness/decay
    opts = {}
  ) {
    if (!this._enabled || !this.listener || this._voices >= this.MAX_VOICES) return;

    const {
      mass,
      hardness,
      velocity,
      decay,                  // legacy name for duration
      intensity,              // legacy gain scalar
      frequency,              // legacy freq mapping to hardness
      roughness = 0.15
    } = opts;

    const duration = decay ?? this.impactDuration;

    // Choose buffer path
    const buf = (mass !== undefined || hardness !== undefined || velocity !== undefined)
      ? this._getPhysicalImpactBuffer({
          mass: mass ?? 1.0,
          hardness: hardness ?? 0.5,
          velocity: velocity ?? 1.0,
          duration,
          roughness
        })
      : this._getImpactBuffer(frequency ?? 120, roughness, duration);

    const holder = new THREE.Object3D();
    holder.position.set(x, y, z);
    this.scene.add(holder);

    const snd = new THREE.PositionalAudio(this.listener);
    snd.setBuffer(buf);
    snd.setRefDistance(this.refDistance * 0.85);
    snd.setRolloffFactor(this.rolloff * 0.9);

    // Gain: map intensity/velocity to loudness
    const gainMul = intensity !== undefined
      ? THREE.MathUtils.clamp(intensity, 0.05, 4)
      : THREE.MathUtils.clamp((velocity ?? 1.0) * 0.9 + 0.2, 0.05, 4);

    snd.setVolume(this.impactVolume * gainMul);

    holder.add(snd);
    this._voices++;
    try { snd.play(); } catch { }

    const ms = duration * 1000 + 80;
    setTimeout(() => {
      try { snd.stop(); } catch { }
      holder.remove(snd);
      this.scene.remove(holder);
      this._voices = Math.max(0, this._voices - 1);
    }, ms);
  }
}
