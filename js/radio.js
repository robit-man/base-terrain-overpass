import * as THREE from 'three';

const RADIO_API_HOSTS = [
  'https://de1.api.radio-browser.info',
  'https://nl1.api.radio-browser.info',
  'https://us1.api.radio-browser.info'
];

const DEFAULT_STATIONS = [
  { name: 'Lofi Beats', url: 'https://stream.nightride.fm/lofi.ogg', country: 'Global' },
  { name: 'SomaFM Groove Salad', url: 'https://ice2.somafm.com/groovesalad-128-mp3', country: 'US' },
  { name: 'FIP', url: 'https://icecast.radiofrance.fr/fip-midfi.mp3', country: 'FR' },
  { name: 'Cafe del Mar', url: 'https://streams.cafedelmarradio.com:8443/cafedelmarradio', country: 'ES' },
  { name: 'ABC Lounge', url: 'https://ais-sa2.cdnstream1.com/1987_128.mp3', country: 'FR' }
];

const clamp = THREE.MathUtils.clamp;

export class RadioManager {
  constructor({ ui, getLocation }) {
    this.ui = ui;
    this.getLocation = getLocation;
    this.active = false;
    this.stations = [];
    this.currentIndex = -1;
    this._dialValue = 0;
    this._fetchAbort = null;

    this._audioCtx = null;
    this._noiseSource = null;
    this._noiseGain = null;
    this._noiseStopTimer = null;
    this._streamAudio = null;
    this._streamFadeTimer = null;

    this._bindUI();
    this._updatePanelVisibility();
  }

  _bindUI() {
    this.ui.hudRadioToggle?.addEventListener('click', () => this.toggle());
    this.ui.hudRadioDial?.addEventListener('input', (e) => {
      const value = Number(e.target.value) || 0;
      this._dialValue = value;
      this._handleDialValue(value);
    });
    this.ui.hudRadioList?.addEventListener('click', (e) => {
      const item = e.target.closest('[data-index]');
      if (!item) return;
      const idx = Number(item.dataset.index);
      if (!Number.isFinite(idx)) return;
      const snapped = this._valueForIndex(idx);
      this._setDial(snapped);
      this._handleDialValue(snapped, { forceStation: idx });
    });
  }

  toggle(force) {
    const next = force == null ? !this.active : !!force;
    if (next === this.active) return;
    if (next) this.enable();
    else this.disable();
  }

  async enable() {
    if (this.active) return;
    this.active = true;
    this._updateButton();
    this._updatePanelVisibility();
    await this._ensureAudio();
    this._setStatus('Tuning regional stations…');
    this._startStaticFade(0.4, 0.6);
    if (!this.stations.length) {
      await this._loadStations();
    }
    if (!this.stations.length) {
      this._setStatus('No stations available');
    } else {
      this._populateList();
      this._setDial(this._valueForIndex(0));
      this._handleDialValue(this._dialValue, { forceStation: 0, immediate: true });
    }
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this._stopStream(true);
    this._startStaticFade(0, 0.35);
    this._updateButton();
    this._updatePanelVisibility();
  }

  async refreshRegion() {
    if (!this.active) return;
    await this._loadStations();
    this._populateList();
  }

  _updatePanelVisibility() {
    const panel = this.ui.hudRadioPanel;
    if (!panel) return;
    if (this.active) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  }

  _updateButton() {
    const btn = this.ui.hudRadioToggle;
    if (!btn) return;
    btn.classList.toggle('on', this.active);
    btn.setAttribute('aria-pressed', this.active ? 'true' : 'false');
    btn.textContent = this.active ? 'Radio (On)' : 'Radio';
  }

  async _ensureAudio() {
    if (this._noiseStopTimer) {
      clearTimeout(this._noiseStopTimer);
      this._noiseStopTimer = null;
    }
    if (!this._audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this._audioCtx = new AudioContext();
    }
    if (this._audioCtx.state === 'suspended') {
      try { await this._audioCtx.resume(); } catch { }
    }
    if (!this._noiseSource) {
      const buffer = this._audioCtx.createBuffer(1, this._audioCtx.sampleRate * 2, this._audioCtx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this._noiseGain = this._audioCtx.createGain();
      this._noiseGain.gain.value = 0;
      this._noiseSource = this._audioCtx.createBufferSource();
      this._noiseSource.buffer = buffer;
      this._noiseSource.loop = true;
      this._noiseSource.connect(this._noiseGain).connect(this._audioCtx.destination);
      this._noiseSource.start();
    }
    if (!this._streamAudio) {
      this._streamAudio = new Audio();
      this._streamAudio.crossOrigin = 'anonymous';
      this._streamAudio.preload = 'none';
      this._streamAudio.volume = 0;
      this._streamAudio.addEventListener('error', () => {
        this._setStatus('Stream error');
        this._startStaticFade(0.5, 0.4);
      });
    }
  }

  async _loadStations() {
    this._abortFetch();
    const controller = new AbortController();
    this._fetchAbort = controller;
    try {
      const { lat, lon } = this.getLocation() || {};
      const targetLat = Number.isFinite(lat) ? lat : 40.7;
      const targetLon = Number.isFinite(lon) ? lon : -74;
      let result = null;
      for (const host of RADIO_API_HOSTS) {
        const url = `${host}/json/stations/bygeo?lat=${encodeURIComponent(targetLat)}&lon=${encodeURIComponent(targetLon)}&limit=30&hidebroken=true`;
        try {
          const resp = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'noclip-radio/1.0' } });
          if (!resp.ok) continue;
          const data = await resp.json();
          if (Array.isArray(data) && data.length) {
            result = data;
            break;
          }
        } catch (err) {
          if (controller.signal.aborted) return;
        }
      }
      if (!result) {
        this.stations = DEFAULT_STATIONS;
      } else {
        this.stations = result
          .filter((station) => station && station.urlResolved)
          .map((station) => ({
            id: station.stationuuid || station.id || station.urlResolved,
            name: station.name || station.urlResolved,
            country: station.country || station.countrycode || 'Unknown',
            url: station.urlResolved || station.url
          }));
        if (!this.stations.length) this.stations = DEFAULT_STATIONS;
      }
      this.currentIndex = -1;
      this._setStatus(`Loaded ${this.stations.length} stations`);
    } catch (err) {
      if (controller.signal.aborted) return;
      this._setStatus('Failed to load stations');
      this.stations = DEFAULT_STATIONS;
    } finally {
      this._fetchAbort = null;
    }
  }

  _abortFetch() {
    if (this._fetchAbort) {
      this._fetchAbort.abort();
      this._fetchAbort = null;
    }
  }

  _populateList() {
    const list = this.ui.hudRadioList;
    if (!list) return;
    list.innerHTML = '';
    this.stations.forEach((station, idx) => {
      const li = document.createElement('li');
      li.className = `hud-radio-item${idx === this.currentIndex ? ' active' : ''}`;
      li.dataset.index = idx;
      li.innerHTML = `<strong>${station.name}</strong><br><span>${station.country || ''}</span>`;
      list.appendChild(li);
    });
  }

  _handleDialValue(value, { forceStation = null, immediate = false } = {}) {
    if (!this.stations.length) return;
    const slot = this.stations.length > 1 ? 100 / (this.stations.length - 1) : 100;
    const approxIndex = slot > 0 ? value / slot : 0;
    let targetIndex = forceStation != null ? forceStation : Math.round(approxIndex);
    targetIndex = clamp(targetIndex, 0, this.stations.length - 1);
    const distance = Math.abs(approxIndex - targetIndex);
    const withinStation = distance <= 0.3;
    if (withinStation) {
      this._tuneToStation(targetIndex, immediate);
    } else {
      this._setStatus('Static');
      this._startStaticFade(0.5, 0.3);
      this._stopStream();
    }
  }

  _tuneToStation(index, immediate = false) {
    if (index < 0 || index >= this.stations.length) return;
    if (this.currentIndex === index && !immediate) return;
    this.currentIndex = index;
    const station = this.stations[index];
    this._setStatus(`Tuning ${station.name}`);
    this._highlightActive();
    this._startStaticFade(0.35, immediate ? 0.05 : 0.25);
    this._playStream(station.url, () => {
      this._setStatus(`${station.name} · ${station.country || ''}`);
      this._startStaticFade(0.05, 0.6);
    });
  }

  _highlightActive() {
    if (!this.ui.hudRadioList) return;
    this.ui.hudRadioList.querySelectorAll('.hud-radio-item').forEach((item) => {
      const idx = Number(item.dataset.index);
      item.classList.toggle('active', idx === this.currentIndex);
    });
  }

  _playStream(url, onStart) {
    if (!url) {
      this._setStatus('Invalid stream');
      return;
    }
    this._ensureAudio();
    if (!this._streamAudio) return;
    if (this._streamFadeTimer) {
      cancelAnimationFrame(this._streamFadeTimer);
      this._streamFadeTimer = null;
    }
    const audio = this._streamAudio;
    audio.src = url;
    audio.volume = 0;
    audio.play().then(() => {
      this._fadeAudioVolume(1, 800);
      if (typeof onStart === 'function') onStart();
    }).catch(() => {
      this._setStatus('Unable to play stream');
      this._startStaticFade(0.5, 0.4);
    });
  }

  _stopStream(immediate = false) {
    if (!this._streamAudio) return;
    if (immediate) {
      try { this._streamAudio.pause(); } catch { }
      this._streamAudio.currentTime = 0;
      this._streamAudio.src = '';
      this._streamAudio.volume = 0;
      return;
    }
    this._fadeAudioVolume(0, 500, () => {
      try { this._streamAudio.pause(); } catch { }
      this._streamAudio.src = '';
    });
  }

  _fadeAudioVolume(target, duration, cb) {
    if (!this._streamAudio) return;
    const start = this._streamAudio.volume;
    const delta = target - start;
    const startTime = performance.now();
    const step = () => {
      const now = performance.now();
      const t = clamp((now - startTime) / Math.max(duration, 1), 0, 1);
      this._streamAudio.volume = clamp(start + delta * t, 0, 1);
      if (t < 1) {
        this._streamFadeTimer = requestAnimationFrame(step);
      } else {
        this._streamFadeTimer = null;
        if (cb) cb();
      }
    };
    this._streamFadeTimer = requestAnimationFrame(step);
  }

  _startStaticFade(target, duration, stopAfter = false) {
    if (!this._noiseGain || !this._audioCtx) return;
    const now = this._audioCtx.currentTime;
    this._noiseGain.gain.cancelScheduledValues(now);
    this._noiseGain.gain.setTargetAtTime(target, now, Math.max(0.01, duration));
    if (this._noiseStopTimer) {
      clearTimeout(this._noiseStopTimer);
      this._noiseStopTimer = null;
    }
    if (stopAfter) {
      const timeout = Math.max(50, duration * 1000 * 2);
      this._noiseStopTimer = setTimeout(() => {
        this._noiseStopTimer = null;
        this._stopStatic();
      }, timeout);
    }
  }

  _stopStatic() {
    if (this._noiseSource) {
      try { this._noiseSource.stop(); } catch { }
      this._noiseSource.disconnect?.();
      this._noiseSource = null;
    }
    if (this._noiseGain) {
      this._noiseGain.disconnect?.();
      this._noiseGain = null;
    }
  }

  _setDial(value) {
    this._dialValue = clamp(value, 0, 100);
    if (this.ui.hudRadioDial) this.ui.hudRadioDial.value = String(this._dialValue);
  }

  _valueForIndex(index) {
    if (this.stations.length <= 1) return 0;
    const slot = 100 / (this.stations.length - 1);
    return clamp(index * slot, 0, 100);
  }

  _setStatus(text) {
    if (this.ui.hudRadioStatus) this.ui.hudRadioStatus.textContent = text;
  }
}
