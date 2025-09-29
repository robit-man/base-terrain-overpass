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
    this.duration = 0.08;
    this.impactDuration = 0.22;
    this.impactVolume = 0.22;
    this.MAX_VOICES = 64;
    this._voices = 0;

    // Prebuild a few short brown-noise scratch buffers
    this._scratchBuffers = this._makeScratchBuffers(3);
    this._impactBufferCache = new Map();

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

  _makeScratchBuffers(n) {
    const out = [];
    for (let k = 0; k < n; k++) {
      const sr = this.ctx.sampleRate;
      const len = Math.max(1, Math.floor(sr * this.duration));
      const buf = this.ctx.createBuffer(1, len, sr);
      const data = buf.getChannelData(0);

      let last = Math.random() * 2 - 1;
      const wobbleHz = 12000 + Math.random() * 125;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        const white = Math.random() * 2 - 1;
        last = (last * 0.997 + white * 0.003);
        const env = Math.min(1, t * 40) * Math.pow(1 - t, 2);
        const am = 0.7 + 0.3 * Math.sin(2 * Math.PI * wobbleHz * (i / this.ctx.sampleRate));
        data[i] = last * env * am;
      }
      out.push(buf);
    }
    return out;
  }

  triggerScratch(x, y, z, gainMul = 1) {
    if (!this._enabled || !this.listener || this._voices >= this.MAX_VOICES) return;

    const holder = new THREE.Object3D();
    holder.position.set(x, y, z);
    this.scene.add(holder);

    const snd = new THREE.PositionalAudio(this.listener);
    const buf = this._scratchBuffers[(Math.random() * this._scratchBuffers.length) | 0];
    snd.setBuffer(buf);
    snd.setRefDistance(this.refDistance);
    snd.setRolloffFactor(this.rolloff);
    snd.setVolume(this.volume * gainMul);

    const rate = 0.9 + Math.random() * 0.25;
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

  _getImpactBuffer(frequency = 340, roughness = 0.3, duration = this.impactDuration) {
    const key = `${Math.round(frequency)}:${Math.round(roughness * 100)}:${duration.toFixed(2)}`;
    if (this._impactBufferCache.has(key)) return this._impactBufferCache.get(key);

    const sr = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * duration));
    const buffer = this.ctx.createBuffer(1, len, sr);
    const data = buffer.getChannelData(0);

    const omega = (2 * Math.PI * frequency) / sr;
    let phase = 0;
    const rough = THREE.MathUtils.clamp(roughness, 0, 1);

    for (let i = 0; i < len; i++) {
      const t = i / len;
      const attack = Math.min(1, t * 32);
      const decay = Math.pow(1 - t, 3);
      phase += omega;
      let sample = Math.sin(phase);
      if (rough > 0) sample = sample * (1 - rough) + (Math.random() * 2 - 1) * rough;
      data[i] = sample * attack * decay;
    }

    this._impactBufferCache.set(key, buffer);
    return buffer;
  }

  triggerImpact(x, y, z, { intensity = 1, frequency = 360, roughness = 0.35, decay = this.impactDuration } = {}) {
    if (!this._enabled || !this.listener || this._voices >= this.MAX_VOICES) return;

    const holder = new THREE.Object3D();
    holder.position.set(x, y, z);
    this.scene.add(holder);

    const snd = new THREE.PositionalAudio(this.listener);
    const buf = this._getImpactBuffer(frequency, roughness, decay);
    snd.setBuffer(buf);
    snd.setRefDistance(this.refDistance * 0.85);
    snd.setRolloffFactor(this.rolloff * 0.9);
    snd.setVolume(this.impactVolume * THREE.MathUtils.clamp(intensity, 0.05, 4));

    holder.add(snd);
    this._voices++;
    try { snd.play(); } catch { }

    const ms = decay * 1000 + 80;
    setTimeout(() => {
      try { snd.stop(); } catch { }
      holder.remove(snd);
      this.scene.remove(holder);
      this._voices = Math.max(0, this._voices - 1);
    }, ms);
  }
}
