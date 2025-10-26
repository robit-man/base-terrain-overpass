// radio.js — Radio Garden (unofficial) integration (WEB-ONLY)
// Fetches places near a given lat/lon (within a configurable radius in miles),
// loads their channels from Radio Garden, and populates a front-end list ordered
// nearest → farthest. No local proxy required — this file fetches over the open web.
//
// Endpoints used (from the spec you shared):
//   GET /ara/content/places
//   GET /ara/content/page/{placeId}/channels
//   GET /ara/content/listen/{channelId}/channel.mp3   (302 → real stream)
//
// IMPORTANT
// - Browsers sometimes block RG JSON with CORS. To avoid requiring your own proxy,
//   this module will try DIRECT fetch first, then automatically fall back to a
//   public, read-only CORS relay (r.jina.ai). No local hosting needed.
// - The <audio> element points at Radio Garden directly and follows the 302.

// =============================
// Config
// =============================
const RG_DIRECT_BASE = 'https://radio.garden/api';
// make relay first to avoid the direct CORS error line in console
const RG_CORS_RELAY_BASES = [
  'https://r.jina.ai/https://radio.garden/api',
  'https://r.jina.ai/http://radio.garden/api'
];
const TRY_BASES = [...RG_CORS_RELAY_BASES, 'https://radio.garden/api'];

const JSON_HEADERS = { Accept: 'application/json' };
const MI_TO_KM = 1.609344; // exact

// Auto-tune limits when moving
const AUTOTUNE_DEFAULTS = {
  enabled: true,
  minMoveKm: 5,                 // only rebuild if moved ≥ 5 km
  minSecondsBetweenRebuild: 10,  // and at most once every N seconds
  selectStrategy: 'first',       // or 'random'
  maxPlacesToScan: 10            // cap nearby places to avoid hammering the API
};

// =============================
// Utils
// =============================
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toRad = (deg) => deg * Math.PI / 180;
function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371; // km
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLon / 2);
  const c = s1 * s1 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * s2 * s2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(c)));
}
function fmtMiles(km) { return (km / MI_TO_KM).toFixed(1) + ' mi'; }
function parseChannelIdFromHref(href) {
  const m = /\/listen\/[^/]+\/([A-Za-z0-9_-]+)$/.exec(href || '');
  return m ? m[1] : null;
}

// Robust JSON fetch that tries DIRECT first, then a public CORS relay.
async function getJSONWithFallback(path, { signal } = {}) {
  // Try direct first (will CORS-fail in the browser), then fall back to permissive relays
  const bases = [RG_DIRECT_BASE, ...RG_CORS_RELAY_BASES];
  let lastErr;
  for (const base of bases) {
    const url = `${base}${path}`;
    try {
      const res = await fetch(url, { signal, headers: JSON_HEADERS, credentials: 'omit', mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Some relays return text/plain; parse text manually if needed
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) {
        return await res.json();
      } else {
        const text = await res.text();
        return JSON.parse(text);
      }
    } catch (e) {
      lastErr = e;
      continue; // try next base
    }
  }
  throw lastErr || new Error('Failed to fetch Radio Garden JSON');
}

// =============================
// RadioManager
// =============================
export class RadioManager {
  /**
   * @param {Object} opts
   * @param {{ hudRadioToggle?:HTMLElement, hudRadioDial?:HTMLInputElement, hudRadioList?:HTMLElement, hudRadioPanel?:HTMLElement, hudRadioStatus?:HTMLElement }} opts.ui
   * @param {() => {lat:number, lon:number}} opts.getLocation  Function returning current lat/lon
   * @param {Object} [opts.autotune]
   * @param {number} [opts.radiusMiles=30]                     Search radius in miles
   */
  constructor({ ui, getLocation, autotune = {}, radiusMiles = 30 } = {}) {
    this.ui = ui || {};
    this.getLocation = getLocation || (() => ({ lat: 0, lon: 0 }));

    // state
    this.active = false;
    this.stations = [];
    this.currentIndex = -1;
    this._dialValue = 0;

    // audio
    this._audio = null;
    this._audioFadeRAF = null;
    this._ac = null;
    this._noise = null;
    this._noiseGain = null;

    // data caches
    this._places = null;                 // Array<{id,title,country,lat,lon}>
    this._placesBuf = null;              // Float32Array [lat, lon, lat, lon, ...]
    this._channelsByPlace = new Map();   // placeId -> Array<{title, channelId}>

    // movement/autotune
    this._autotune = { ...AUTOTUNE_DEFAULTS, ...(autotune || {}) };
    this._lastCenter = null;             // { lat, lon }
    this._lastRebuildAt = 0;             // seconds
    this._pipelineAbort = null;          // AbortController

    // params
    this._radiusMiles = radiusMiles;
    this._radiusKm = radiusMiles * MI_TO_KM;

    // listen endpoint is always direct RG (audio can cross-origin and follow 302)
    this._listenBase = RG_DIRECT_BASE;

    this._bindUI();
    this._updatePanelVisibility();
  }

  // -------- public API --------
  setRadiusMiles(miles) {
    if (!Number.isFinite(miles) || miles <= 0) return;
    this._radiusMiles = miles;
    this._radiusKm = miles * MI_TO_KM;
  }

  toggle(force) {
    const next = force == null ? !this.active : !!force;
    if (next === this.active) return;
    return next ? this.enable() : this.disable();
  }

  async enable() {
    if (this.active) return;
    this.active = true;
    this._updateButton();
    this._updatePanelVisibility();
    await this._ensureAudio();

    try {
      if (!this._places) await this._loadAllPlaces();
      await this.refreshRegion(true);
    } catch (err) {
      console.warn('[radio] enable failed', err);
      this._clearStationsUI('Radio unavailable');
    }
  }

  disable() {
    if (!this.active) return;
    this.active = false;
    this._stopStream(true);
    this._updateButton();
    this._updatePanelVisibility();
  }

  async refreshRegion(immediate = false) {
    if (!this.active) return;
    const { lat, lon } = this.getLocation();
    await this._pipelineFetchNearby(lat, lon, immediate);
  }

  async updateFromLatLon(lat, lon) {
    if (!this.active || !this._autotune.enabled) return;
    try {
      if (!this._places) await this._loadAllPlaces();
      const nowSec = performance.now() / 1000;
      const movedKm = this._lastCenter ? haversineKm(lat, lon, this._lastCenter.lat, this._lastCenter.lon) : Infinity;
      const cooled = (nowSec - this._lastRebuildAt) >= this._autotune.minSecondsBetweenRebuild;
      if (movedKm >= this._autotune.minMoveKm && cooled) {
        await this._pipelineFetchNearby(lat, lon, false);
      }
    } catch (e) {
      console.warn('[radio] updateFromLatLon error', e);
    }
  }

  // -------- UI --------
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
      const snap = this._valueForIndex(idx);
      this._setDial(snap);
      this._handleDialValue(snap, { forceStation: idx, immediate: true });
    });
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

  _populateList() {
    const list = this.ui.hudRadioList;
    if (!list) return;
    list.innerHTML = '';
    this.stations.forEach((s, idx) => {
      const li = document.createElement('li');
      li.className = `hud-radio-item${idx === this.currentIndex ? ' active' : ''}`;
      li.dataset.index = idx;
      const dist = s.distanceKm != null ? ` · ${fmtMiles(s.distanceKm)}` : '';
      const sub = s.placeTitle ? `${s.placeTitle}, ${s.country}` : (s.country || '');
      li.innerHTML = `<strong>${s.name}</strong><br><span>${sub}${dist}</span>`;
      list.appendChild(li);
    });
  }

  _highlightActive() {
    this.ui.hudRadioList?.querySelectorAll('.hud-radio-item').forEach((el) => {
      el.classList.toggle('active', Number(el.dataset.index) === this.currentIndex);
    });
  }

  _handleDialValue(value, { forceStation = null, immediate = false } = {}) {
    if (!this.stations.length) return;
    const slot = this.stations.length > 1 ? 100 / (this.stations.length - 1) : 100;
    const approxIndex = slot > 0 ? value / slot : 0;
    let targetIndex = forceStation != null ? forceStation : Math.round(approxIndex);
    targetIndex = clamp(targetIndex, 0, this.stations.length - 1);
    this._tuneToStation(targetIndex, immediate);
  }

  _tuneToStation(index, immediate = false) {
    if (index < 0 || index >= this.stations.length) return;
    if (this.currentIndex === index && !immediate) return;
    this.currentIndex = index;
    const s = this.stations[index];
    this._setStatus(`Tuning ${s.name}`);
    this._highlightActive();
    this._playStream(s.url, () => this._setStatus(`${s.name} · ${s.placeTitle || s.country || ''}`));
  }

  _setDial(v) {
    this._dialValue = clamp(v, 0, 100);
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

  _clearStationsUI(status='') {
    this.stations = [];
    this._populateList();
    this._stopStream(true);
    this.currentIndex = -1;
    if (status) this._setStatus(status);
  }

  // -------- Audio --------
  async _ensureAudio() {
    if (!this._audio) {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.preload = 'none';
      audio.volume = 0;
      audio.addEventListener('error', () => this._setStatus('Stream error'));
      this._audio = audio;
    }
    if (!this._noise) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this._ac = new Ctx();
      const buf = this._ac.createBuffer(1, this._ac.sampleRate * 2, this._ac.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      const src = this._ac.createBufferSource();
      src.buffer = buf; src.loop = true;
      const gain = this._ac.createGain();
      gain.gain.value = 0.08; // subtle tuning hiss
      src.connect(gain).connect(this._ac.destination);
      src.start();
      this._noise = src; this._noiseGain = gain;
    }
  }

  _fadeAudioVolume(target, durationMs, cb) {
    if (!this._audio) return;
    if (this._audioFadeRAF) cancelAnimationFrame(this._audioFadeRAF);
    const start = this._audio.volume;
    const delta = target - start;
    const t0 = performance.now();
    const step = () => {
      const t = clamp((performance.now() - t0) / Math.max(1, durationMs), 0, 1);
      this._audio.volume = clamp(start + delta * t, 0, 1);
      if (t < 1) this._audioFadeRAF = requestAnimationFrame(step);
      else { this._audioFadeRAF = null; cb && cb(); }
    };
    this._audioFadeRAF = requestAnimationFrame(step);
  }

  _playStream(endpointUrl, onStart) {
    const a = this._audio; if (!a) return;
    a.src = endpointUrl; // browser follows 302 to final stream
    a.volume = 0;
    a.play().then(() => this._fadeAudioVolume(1, 800, onStart)).catch(() => this._setStatus('Unable to play'));
  }

  _stopStream(immediate = false) {
    const a = this._audio; if (!a) return;
    if (immediate) {
      try { a.pause(); } catch {}
      a.removeAttribute('src');
      a.load();
      a.volume = 0;
      return;
    }
    this._fadeAudioVolume(0, 400, () => { try { a.pause(); } catch {}; a.removeAttribute('src'); a.load(); });
  }

  // -------- Radio Garden JSON --------
  async _loadAllPlaces() {
    const json = await getJSONWithFallback('/ara/content/places');
    const list = json?.data?.list || [];
    this._places = list.map(p => ({
      id: p.id,
      title: p.title,
      country: p.country,
      lat: Array.isArray(p.geo) ? Number(p.geo[1]) : null, // [lon, lat] → lat
      lon: Array.isArray(p.geo) ? Number(p.geo[0]) : null  // → lon
    })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon));

    const n = this._places.length;
    const buf = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { buf[i*2] = this._places[i].lat; buf[i*2+1] = this._places[i].lon; }
    this._placesBuf = buf;
  }

  async _loadChannelsForPlace(placeId) {
    const json = await getJSONWithFallback(`/ara/content/page/${encodeURIComponent(placeId)}/channels`);
    const blocks = json?.data?.content || [];
    const out = [];
    for (const b of blocks) {
      const items = b?.items || [];
      for (const it of items) {
        if (it?.type === 'more') continue; // skip "View all" entries
        const id = parseChannelIdFromHref(it?.href);
        if (!id) continue;
        out.push({ title: it.title, channelId: id });
      }
    }
    return out;
  }

  // -------- Nearby pipeline (abortable + concurrent) --------
  _cancelPipeline() {
    if (this._pipelineAbort) {
      try { this._pipelineAbort.abort(); } catch {}
      this._pipelineAbort = null;
    }
  }

  async _pipelineFetchNearby(lat, lon, immediate) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!this._places) await this._loadAllPlaces();

    this._cancelPipeline();
    const ctrl = new AbortController();
    this._pipelineAbort = ctrl;
    const { signal } = ctrl;

    // compute distances to all places, filter by radius, sort by distance
    const annotated = this._places.map((p, i) => ({
      p,
      dKm: haversineKm(lat, lon, this._placesBuf[i*2], this._placesBuf[i*2+1])
    }))
    .filter(x => x.dKm <= this._radiusKm)
    .sort((a, b) => a.dKm - b.dKm);

    if (!annotated.length) {
      this._clearStationsUI(`No Radio Garden cities within ${this._radiusMiles} miles`);
      this._lastCenter = { lat, lon };
      this._lastRebuildAt = performance.now() / 1000;
      this._pipelineAbort = null;
      return;
    }

    const limited = annotated.slice(0, this._autotune.maxPlacesToScan);

    // per-place tasks
    const tasks = limited.map(({ p, dKm }) => async () => {
      if (signal.aborted) return [];
      let channels = this._channelsByPlace.get(p.id);
      if (!channels) {
        channels = await this._loadChannelsForPlace(p.id);
        this._channelsByPlace.set(p.id, channels);
      }
      return channels.map(c => ({
        id: c.channelId,
        name: c.title,
        placeTitle: p.title,
        country: p.country,
        distanceKm: dKm,
        url: `${this._listenBase}/ara/content/listen/${c.channelId}/channel.mp3`
      }));
    });

    // run with a small pool
    const results = await this._runPool(tasks, 4, ({ done, total }) => {
      this._setStatus(`Loading stations… ${done}/${total}`);
    });
    if (signal.aborted) return;

    // flatten + dedupe by channelId
    const seen = new Set();
    const stations = [];
    for (const arr of results) {
      if (!arr) continue;
      for (const s of arr) {
        if (!s || seen.has(s.id)) continue;
        seen.add(s.id);
        stations.push(s);
      }
    }
    stations.sort((a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9));

    this.stations = stations;
    this._populateList();

    let targetIndex = 0;
    if (this._autotune.selectStrategy === 'random' && this.stations.length) {
      targetIndex = Math.floor(Math.random() * this.stations.length);
    }

    if (this.stations.length) {
      this._setDial(this._valueForIndex(targetIndex));
      this._handleDialValue(this._dialValue, { forceStation: targetIndex, immediate });
    } else {
      this._stopStream(true);
      this.currentIndex = -1;
    }

    this._lastCenter = { lat, lon };
    this._lastRebuildAt = performance.now() / 1000;
    this._pipelineAbort = null;
  }

  async _runPool(tasks, concurrency = 4, onProgress) {
    const total = tasks.length;
    let done = 0;
    const results = new Array(total);
    let i = 0;
    const worker = async () => {
      while (true) {
        const idx = i++;
        if (idx >= total) break;
        try {
          results[idx] = await tasks[idx]();
        } catch (e) {
          console.warn('[radio] task failed', e);
          results[idx] = null;
        } finally {
          done++;
          onProgress && onProgress({ done, total });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
    return results;
  }
}
