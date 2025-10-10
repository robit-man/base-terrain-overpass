// mesh.js
import * as THREE from 'three';
import { ui, setNkn, setSig, setSigMeta, pushToast } from './ui.js';
import { createDiscovery } from './nats.js';
import { latLonToWorld, worldToLatLon } from './geolocate.js';
import { now, fmtAgo, isHex64, shortHex, rad, deg } from './utils.js';

/**
 * Persistent address book (localStorage key: NKN_ADDR_BOOK_V1)
 * {
 *   v: 1,
 *   updatedAt: ISO,
 *   peers: [{
 *     pub: "hex64",
 *     lastTs: Number,
 *     ids: ["peer","web","phone","client", ...],
 *     addrs: [{ addr, lastAck, lastProbe, rttMs }]
 *   }]
 * }
 */
const BOOK_KEY = 'NKN_ADDR_BOOK_V1';
const BOOK_VER = 1;

const TELEPORT_PENDING_TIMEOUT = 45_000;
const TELEPORT_STALE_MS = 60_000;

// Health thresholds
const SIG_HEALTH_MS = 18_000; // if no ACK from signaller in this window → unhealthy
const BOOK_PROBE_MS = 5_000;  // how often to re-probe address book when unhealthy

function safeJSON(str, fallback) { try { return JSON.parse(str); } catch { return fallback; } }
function addrFrom(id, pub) { return `${id}.${pub}`; }
function isAddr(s) { return typeof s === 'string' && /\.[0-9a-f]{64}$/i.test(s); }

export class Mesh {
  constructor(app) {
    this.app = app;
    this.client = null; this.selfPub = null; this.selfAddr = null;
    this.signallerHex = ''; this.DEFAULT_SIG = '8ad525942fc13bdf468a640a18716cbd91ba75d3bcb0ca198f73e9cd0cf34a88';

    // Discovery (NATS)
    this.discovery = null;
    this.discoveryRoom = this._deriveDiscoveryRoom();
    this.discoveryStatus = { state: 'idle', detail: '' };
    this.discoveryInitInFlight = false;
    this._discoveryHello = new Set();
    this._signallerLatencyMs = null;

    this.peers = new Map();      // pub -> { addr?: string, lastTs: number }
    this.addrPool = new Map();   // addr -> { lastAck?, rttMs?, lastProbe?, lastMsg? }
    this.latestPose = new Map(); // pub -> { p, q, ts, j, geo? }
    this.knownIds = new Map();  // pub -> Set(ids)
    this.teleportInbox = new Map();  // pub -> { ts, status, respondedAt?, reason? }
    this.teleportOutbox = new Map(); // pub -> { ts, status, respondedAt?, reason?, dest? }

    this.aliases = new Map();
    this._joinAnnouncements = new Set();
    this.displayName = this._sanitizeAlias(localStorage.getItem('NKN_NAME_PREFIX') || '');

    // Sessions (ncp-js)
    this.sessions = new Map();   // pub -> session

    // stats
    this.hzCount = 0; this.sent = 0; this.dropped = 0;
    this.byteWindow = [];
    this._pendingMessages = [];
    this._pendingMessagesLimit = 128;

    // 60 fps pose send target
    this.TARGET_HZ = 30;
    this.MIN_INTERVAL_MS = Math.floor(1000 / this.TARGET_HZ); // ~16ms
    this._lastSendAt = 0;

    // thresholds (tight)
    this.POS_EPS = 0.0015;    // ~1.5 mm
    this.ANG_EPS = rad(0.35); // ~0.35°
    this.XR_HEAD_EPS = rad(0.8);
    this.XR_HEIGHT_EPS = 0.025;

    // ----- Address book -----
    this.book = { v: BOOK_VER, updatedAt: new Date().toISOString(), peers: [] };
    this._saveTimer = null;

    this._loadBook();
    this._bootstrapFromBook(); // populate peers/addrPool/knownIds up-front
    if (ui.displayNameInput) ui.displayNameInput.value = this.displayName;
    if (ui.displayNameSave) ui.displayNameSave.addEventListener('click', () => this.setDisplayName(ui.displayNameInput.value));
    if (ui.displayNameInput) {
      ui.displayNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.setDisplayName(ui.displayNameInput.value);
        }
      });
    }

    setInterval(() => {
      if (ui.poseHzEl) ui.poseHzEl.textContent = String(this.hzCount);
      if (ui.poseSentEl) ui.poseSentEl.textContent = String(this.sent);
      if (ui.poseDropEl) ui.poseDropEl.textContent = String(this.dropped);
      this.hzCount = 0; this._updateRate();
    }, 1000);
    setInterval(() => this._renderPeers(), 1500);

    this._applySig(localStorage.getItem('NKN_SIG_HEX') || '');
    this._connect();
    this._updateDiscoveryUi();

    if (ui.hexSig) {
      ui.hexSig.value = localStorage.getItem('NKN_SIG_HEX') || '';
      ui.hexSig.addEventListener('input', () => this._applySig(ui.hexSig.value));
    }
    if (ui.nukeBtn) ui.nukeBtn.addEventListener('click', () => this._nuke());

    // Re-probe book periodically when signaller seems unhealthy
    this._bookProbeTimer = setInterval(() => this._probeBookIfNeeded(), BOOK_PROBE_MS);
  }

  _handleIncomingMessage(src, text) {
    if (typeof text !== 'string') return;
    if (!this.selfPub) {
      if (this._pendingMessages.length >= this._pendingMessagesLimit) this._pendingMessages.shift();
      this._pendingMessages.push({ src, text });
      return;
    }
    this._processMessage(src, text);
  }

  _flushPendingMessages() {
    if (!this.selfPub || !this._pendingMessages.length) return;
    const pending = this._pendingMessages.splice(0, this._pendingMessages.length);
    for (const entry of pending) {
      this._processMessage(entry.src, entry.text);
    }
  }

  _processMessage(src, text) {
    if (typeof text !== 'string' || !text.trim().startsWith('{')) return;

    if (src) {
      const m = /^([a-z0-9_-]+)\.([0-9a-f]{64})$/i.exec(src);
      if (m) {
        const id = m[1];
        const pub = m[2].toLowerCase();
        this._idSet(pub).add(id);
        const info = this.addrPool.get(src) || {};
        info.lastMsg = now();
        this.addrPool.set(src, info);
        this._saveBookSoon();
      }
    }

    let msg = null;
    try { msg = JSON.parse(text); } catch { return; }
    const t = now();

    if (msg.type === 'hello' && msg.from) {
      if (this._isSelf(msg.from)) return;
      const pub = msg.from.toLowerCase();
      this._touchPeer(pub, t);
      const alias = this._sanitizeAlias(msg.alias || '');
      this.app.remotes.ensure(pub, alias || this._aliasFor(pub));
      this._applyAlias(pub, alias);
      this._saveBookSoon();
      this._sendPoseSnapshotTo(pub).catch(() => { });
      this._announceJoin(pub);
      return;
    }

    if (msg.type === 'hb') {
      this._sendRaw(src, JSON.stringify({ type: 'hb_ack', from: this.selfPub, t_client: msg.t_client }));
      if (msg.from) this._touchPeer(msg.from.toLowerCase(), t);
      return;
    }

    if (msg.type === 'hb_ack' && typeof msg.t_client === 'number') {
      const rtt = Math.max(0, now() - msg.t_client);
      const m = this.addrPool.get(src) || {};
      m.lastAck = now(); m.rttMs = rtt;
      this.addrPool.set(src, m);

      const sigAddr = isHex64(this.signallerHex) ? `signal.${this.signallerHex}` : '';
      if (src === sigAddr) {
        this._signallerLatencyMs = rtt;
        this._updateDiscoveryUi();
      }

      this._saveBookSoon();
      return;
    }

    if (msg.type === 'peers' && Array.isArray(msg.items)) {
      for (const it of msg.items) {
        const pub = (it.pub || '').toLowerCase(); if (!pub || pub === this.selfPub) continue;
        this._touchPeer(pub, t);
        const ids = Array.isArray(it.ids) ? it.ids : [];
        ids.forEach(id => this._idSet(pub).add(id));
        if (it.addr && isAddr(it.addr)) this.peers.get(pub).addr = it.addr;

        const alias = this._sanitizeAlias(it.alias || '');
        this._applyAlias(pub, alias);

        for (const id of this._idSet(pub)) {
          const a = addrFrom(id, pub);
          if (!this.addrPool.has(a)) this.addrPool.set(a, {});
        }

        this.app.remotes.ensure(pub, this._aliasFor(pub));
        this._sendPoseSnapshotTo(pub).catch(() => { });
      }
      this._renderPeers();
      this._saveBookSoon();
      return;
    }

    if (msg.type === 'peers_req') {
      this._sendRoster(src);
      if (msg.from && /^[0-9a-f]{64}$/i.test(msg.from)) {
        const pub = msg.from.toLowerCase();
        this._touchPeer(pub, t);
        this._sendPoseSnapshotTo(pub).catch(() => { });
      }
      return;
    }

    if (msg.type === 'alias' && msg.from) {
      if (this._isSelf(msg.from)) return;
      const pub = msg.from.toLowerCase();
      this._touchPeer(pub, t);
      this._applyAlias(pub, msg.alias || '');
      return;
    }

    if (msg.type === 'teleport_req' && msg.from) {
      if (!this.selfPub) return;
      const target = (msg.to || this.selfPub).toLowerCase();
      if (target !== this.selfPub) return;
      const from = msg.from.toLowerCase();
      this._touchPeer(from, t);
      const msgTs = Number(msg.ts);
      const entry = this.teleportInbox.get(from) || {};
      entry.ts = Number.isFinite(msgTs) ? msgTs : t;
      entry.status = 'pending';
      entry.respondedAt = undefined;
      entry.reason = undefined;
      this.teleportInbox.set(from, entry);
      this._emitTeleportStatus(from, entry);
      this._renderPeers();
      return;
    }

    if (msg.type === 'teleport_rsp' && msg.from) {
      if (!this.selfPub) return;
      const target = (msg.to || this.selfPub).toLowerCase();
      if (target !== this.selfPub) return;
      const from = msg.from.toLowerCase();
      this._touchPeer(from, t);
      const msgTs = Number(msg.ts);
      const entry = this.teleportOutbox.get(from) || { ts: Number.isFinite(msgTs) ? msgTs : t };
      if (!Number.isFinite(entry.ts)) entry.ts = Number.isFinite(msgTs) ? msgTs : t;
      entry.respondedAt = t;
      entry.reason = msg.reason || null;

      if (msg.accepted) {
        if (msg.dest) {
          entry.status = 'accepted';
          entry.dest = msg.dest;
          const applied = this.app.applyTeleportArrival?.(msg.dest, from);
          if (applied === false) {
            entry.status = 'error';
            entry.reason = 'teleport failed';
          }
        } else {
          entry.status = 'unavailable';
          entry.reason = entry.reason || 'no destination provided';
        }
      } else {
        entry.status = msg.reason === 'unavailable' ? 'unavailable' : 'rejected';
      }

      this.teleportOutbox.set(from, entry);
      this._renderPeers();
      return;
    }

    if (msg.type === 'pose' && msg.from && Array.isArray(msg.pose?.p) && Array.isArray(msg.pose?.q)) {
      if (this._isSelf(msg.from)) return;
      const pub = msg.from.toLowerCase();
      this._touchPeer(pub, t);
      const info = { rtt: this.addrPool.get(src)?.rttMs ?? null, age: fmtAgo(now() - msg.ts) };
      const pose = msg.pose;

      const poseOut = {
        p: Array.isArray(pose.p) ? pose.p.map(v => Number(v)) : [0, 0, 0],
        q: Array.isArray(pose.q) ? pose.q.map(v => Number(v)) : [0, 0, 0, 1],
        j: pose.j ? 1 : 0,
        c: pose.c ? 1 : 0
      };

      if (pose.xr && typeof pose.xr === 'object') {
        const xrIn = pose.xr;
        const xrOut = {
          active: xrIn.active != null ? (Number(xrIn.active) ? 1 : 0) : 1
        };
        const yawVal = Number(xrIn.headYaw);
        if (Number.isFinite(yawVal)) xrOut.headYaw = yawVal;
        const pitchVal = Number(xrIn.headPitch);
        if (Number.isFinite(pitchVal)) xrOut.headPitch = pitchVal;
        const rollVal = Number(xrIn.headRoll);
        if (Number.isFinite(rollVal)) xrOut.headRoll = rollVal;
        const heightVal = Number(xrIn.headHeight);
        if (Number.isFinite(heightVal)) xrOut.headHeight = heightVal;
        poseOut.xr = xrOut;
      }

      let geoNorm = null;
      if (msg.geo) {
        const lat = Number(msg.geo.lat);
        const lon = Number(msg.geo.lon);
        if (Number.isFinite(lat) && Number.isFinite(lon)) {
          geoNorm = { lat, lon };
          const eyeVal = Number(msg.geo.eye);
          if (Number.isFinite(eyeVal)) geoNorm.eye = eyeVal;
          const groundVal = Number(msg.geo.ground);
          if (Number.isFinite(groundVal)) geoNorm.ground = groundVal;
        }
      }

      if (geoNorm) {
        const w = this._geoToWorld(geoNorm.lat, geoNorm.lon);
        if (w) {
          poseOut.p[0] = +w.x.toFixed(3);
          poseOut.p[2] = +w.z.toFixed(3);

          const localGround = this._localGroundAt(w.x, w.z);
          const eye = Number.isFinite(geoNorm.eye)
            ? geoNorm.eye
            : (Number.isFinite(geoNorm.ground) && Number.isFinite(poseOut.p[1]) ? (poseOut.p[1] - geoNorm.ground) : null);
          if (Number.isFinite(localGround) && Number.isFinite(eye)) {
            poseOut.p[1] = +(localGround + eye).toFixed(3);
          }
        }
      }

      this.latestPose.set(pub, { p: poseOut.p, q: poseOut.q, ts: msg.ts, j: poseOut.j, c: poseOut.c, geo: geoNorm, xr: poseOut.xr || null });
      this.app.remotes.update(pub, poseOut, info, geoNorm).catch(err => {
        console.warn('[remotes] update failed', err);
      });
      this._renderPeers();
      return;
    }
  }

  _isSelf(pub) {
    return (pub || '').toLowerCase() === (this.selfPub || '').toLowerCase();
  }
  /* ───────── Address book: load / save / bootstrap / probe ───────── */

  _loadBook() {
    const raw = localStorage.getItem(BOOK_KEY);
    const obj = safeJSON(raw, null);
    if (!obj || obj.v !== BOOK_VER || !Array.isArray(obj.peers)) {
      this.book = { v: BOOK_VER, updatedAt: new Date().toISOString(), peers: [] };
      return;
    }
    this.book = obj;
  }

  _saveBookSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this._persistBookNow(), 800);
  }

  _persistBookNow() {
    this._saveTimer = null;
    try {
      // Compose from live state
      const peers = [];
      for (const [pub, ent] of this.peers.entries()) {
        const ids = Array.from(this._idSet(pub));
        // candidate addresses from ids + ent.addr
        const addrSet = new Set(ids.map(id => addrFrom(id, pub)));
        if (ent?.addr && isAddr(ent.addr)) addrSet.add(ent.addr);

        // include any book-known addresses too
        const prev = (this.book.peers || []).find(p => p.pub === pub);
        if (prev?.addrs) for (const a of prev.addrs) if (isAddr(a.addr)) addrSet.add(a.addr);

        const addrs = [];
        for (const a of addrSet) {
          const pool = this.addrPool.get(a) || {};
          const old = (prev?.addrs || []).find(x => x.addr === a) || {};
          addrs.push({
            addr: a,
            lastAck: pool.lastAck ?? old.lastAck ?? null,
            lastProbe: pool.lastProbe ?? old.lastProbe ?? null,
            rttMs: pool.rttMs ?? old.rttMs ?? null
          });
        }

        peers.push({
          pub,
          lastTs: ent.lastTs || 0,
          ids,
          addrs
        });
      }
      this.book = { v: BOOK_VER, updatedAt: new Date().toISOString(), peers };
      localStorage.setItem(BOOK_KEY, JSON.stringify(this.book));
    } catch (e) {
      console.warn('[book] persist failed', e);
    }
  }

  _bootstrapFromBook() {
    const t = now();
    for (const p of this.book.peers) {
      const pub = (p.pub || '').toLowerCase();
      if (!isHex64(pub)) continue;

      // Seed peer (seen in past)
      this.peers.set(pub, { addr: null, lastTs: p.lastTs || 0 });

      // Seed ids
      const ids = Array.isArray(p.ids) ? p.ids : [];
      ids.forEach(id => this._idSet(pub).add(id));

      // Seed addresses/metrics
      const addrs = Array.isArray(p.addrs) ? p.addrs : [];
      for (const a of addrs) {
        if (!isAddr(a.addr)) continue;
        const m = this.addrPool.get(a.addr) || {};
        if (a.lastAck) m.lastAck = a.lastAck;
        if (a.lastProbe) m.lastProbe = a.lastProbe;
        if (a.rttMs != null) m.rttMs = a.rttMs;
        this.addrPool.set(a.addr, m);
      }
    }
    this._renderPeers();
  }

  _probeBookIfNeeded() {
    // Signaller health check: have we heard an ACK recently?
    const sigAddr = isHex64(this.signallerHex) ? `signal.${this.signallerHex}` : null;
    const healthy = sigAddr && (now() - (this.addrPool.get(sigAddr)?.lastAck || 0) < SIG_HEALTH_MS);
    if (healthy) return;

    // Signaller unhealthy → ping every known addr from the book + learned ids
    const t = now();
    for (const p of this.book.peers) {
      const pub = (p.pub || '').toLowerCase();
      if (!isHex64(pub) || pub === this.selfPub) continue;

      const ids = new Set(['peer', 'web', 'phone', 'client', ...(p.ids || [])]);
      const targets = new Set([...ids].map(id => addrFrom(id, pub)));
      (p.addrs || []).forEach(a => { if (isAddr(a.addr)) targets.add(a.addr); });

      const hello = JSON.stringify(this._helloEnvelope(t));
      const ask = JSON.stringify({ type: 'peers_req', from: this.selfPub, ts: t });

      for (const to of targets) {
        const m = this.addrPool.get(to) || {}; m.lastProbe = t; this.addrPool.set(to, m);
        this._sendRaw(to, hello).catch(() => { });
        this._sendRaw(to, ask).catch(() => { });
      }
    }
  }

  /* ───────── UI rate meter ───────── */

  _updateRate() {
    const t = now();
    this.byteWindow = this.byteWindow.filter(e => t - e.t < 5000);
    const bytes = this.byteWindow.reduce((s, e) => s + e.bytes, 0);
    if (ui.poseRateEl) ui.poseRateEl.textContent = ((bytes * 8) / 5000).toFixed(1);
  }
  _noteBytes(str) { try { const b = (new TextEncoder()).encode(str).length; this.byteWindow.push({ t: now(), bytes: b }); } catch { } }

  setDisplayName(name) {
    const sanitized = this._sanitizeAlias(name);
    const previous = this.displayName;
    this.displayName = sanitized;
    if (ui.displayNameInput && ui.displayNameInput.value !== sanitized) {
      ui.displayNameInput.value = sanitized;
    }
    if (sanitized) {
      localStorage.setItem('NKN_NAME_PREFIX', sanitized);
    } else {
      localStorage.removeItem('NKN_NAME_PREFIX');
    }
    if (this.selfPub) {
      this._applyAlias(this.selfPub, sanitized);
    }
    if (sanitized !== previous) {
      this._broadcastAlias();
    }
  }

  _sanitizeAlias(raw) {
    if (raw == null) return '';
    const cleaned = String(raw).replace(/[\n\r\t]+/g, ' ').trim();
    const stripped = cleaned.replace(/[^a-zA-Z0-9._ \-]/g, '');
    return stripped.slice(0, 24).trim();
  }

  _aliasFor(pub) {
    const key = (pub || '').toLowerCase();
    const alias = this.aliases.get(key);
    if (alias && alias.length) return alias;
    if (isHex64(key)) return shortHex(key, 8, 6);
    return shortHex(pub || key || 'peer', 8, 6);
  }

  _applyAlias(pub, alias) {
    if (!pub) return;
    const key = pub.toLowerCase();
    const norm = this._sanitizeAlias(alias);
    const prev = this.aliases.get(key) || '';
    if (norm) this.aliases.set(key, norm);
    else this.aliases.delete(key);
    if (prev === (norm || '')) return;
    this.app?.remotes?.setAlias(key, norm);
    this._renderPeers();
  }

  _emitTeleportStatus(pub, entry) {
    if (!pub) return;
    this.app?.notifyTeleportToast?.(pub, entry || null);
  }

  _broadcastAlias() {
    if (!this.client || !this.selfPub) return;
    const payload = { type: 'alias', from: this.selfPub, alias: this.displayName || '' };
    this._blast(payload);
  }

  _helloEnvelope(ts = now()) {
    if (!this.selfPub) return { type: 'hello', from: '', ts };
    const msg = { type: 'hello', from: this.selfPub, ts };
    if (this.displayName) msg.alias = this.displayName;
    return msg;
  }

  _announceJoin(pub) {
    if (!pub || this._isSelf(pub)) return;
    const key = pub.toLowerCase();
    if (this._joinAnnouncements.has(key)) return;
    this._joinAnnouncements.add(key);
    const label = this._aliasFor(pub);
    pushToast?.(`${label} joined!`);
  }

  /* ───────── Signaller config ───────── */

  _applySig(raw) {
    const v = (raw || '').trim().toLowerCase();
    this.signallerHex = isHex64(v) ? v : this.DEFAULT_SIG;
    if (isHex64(v)) localStorage.setItem('NKN_SIG_HEX', v);
    this._updateDiscoveryUi();
  }

  /* ───────── Discovery (NATS) integration ───────── */

  _deriveDiscoveryRoom() {
    if (typeof location === 'undefined') return 'mesh-default';
    const host = (location.hostname || 'local').toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const pathBits = (location.pathname || '')
      .split('/')
      .filter(Boolean)
      .slice(0, 2)
      .map(seg => seg.toLowerCase().replace(/[^a-z0-9-]/g, '-'))
      .filter(Boolean)
      .join('-');
    const slug = [host, pathBits].filter(Boolean).join('-').replace(/-+/g, '-') || 'mesh';
    return `mesh-${slug}`.replace(/-+/g, '-');
  }

  _originLatLon() {
    const origin = this.app?.hexGridMgr?.origin;
    if (origin && Number.isFinite(origin.lat) && Number.isFinite(origin.lon)) return origin;
    const state = this.app?._locationState;
    if (state && Number.isFinite(state.lat) && Number.isFinite(state.lon)) return state;
    return null;
  }

  _worldToGeo(x, z) {
    const origin = this._originLatLon();
    if (!origin) return null;
    return worldToLatLon(x, z, origin.lat, origin.lon);
  }

  _geoToWorld(lat, lon) {
    const origin = this._originLatLon();
    if (!origin) return null;
    return latLonToWorld(lat, lon, origin.lat, origin.lon);
  }

  _localGroundAt(x, z) {
    if (!this.app?.hexGridMgr?.getHeightAt) return null;
    const y = this.app.hexGridMgr.getHeightAt(x, z);
    return Number.isFinite(y) ? y : null;
  }

  _geoPayload(x, z, actualY) {
    const geo = this._worldToGeo(x, z);
    if (!geo) return null;
    const ground = this._localGroundAt(x, z);
    const eye = Number.isFinite(actualY) && Number.isFinite(ground) ? (actualY - ground) : null;
    const out = {
      lat: +geo.lat.toFixed(7),
      lon: +geo.lon.toFixed(7)
    };
    if (Number.isFinite(ground)) out.ground = +ground.toFixed(3);
    if (Number.isFinite(eye)) out.eye = +eye.toFixed(3);
    return out;
  }

  _discoveryMeta() {
    const meta = { app: 'mesh', ver: 'v1' };
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      meta.ua = navigator.userAgent.substring(0, 80);
    }
    return meta;
  }

  _updateDiscoveryUi() {
    const state = this.discoveryStatus?.state || 'idle';
    const detail = this.discoveryStatus?.detail || '';
    if (state === 'ready') {
      setSig(`Discovery: ${this.discoveryRoom}`, 'ok');
    } else if (state === 'connecting') {
      setSig('Discovery: connecting…', 'warn');
    } else if (state === 'error') {
      setSig('Discovery: offline', 'err');
    } else {
      setSig('Discovery: idle', 'warn');
    }

    const meta = [];
    if (this.discoveryRoom) meta.push(`room ${this.discoveryRoom}`);
    if (isHex64(this.signallerHex)) meta.push(`fallback ${shortHex(this.signallerHex, 6, 4)}`);
    if (Number.isFinite(this._signallerLatencyMs)) meta.push(`relay ${Math.round(this._signallerLatencyMs)} ms`);
    if (detail) meta.push(detail);
    setSigMeta(meta.join(' • ') || '—');
  }

  async _initDiscovery() {
    if (!this.selfPub || this.discoveryInitInFlight) return;

    if (this.discovery) {
      const meta = { ...(this.discovery.me?.meta || {}), ...this._discoveryMeta() };
      this.discovery.me = { ...(this.discovery.me || {}), nknPub: this.selfPub, addr: this.selfAddr || this.discovery.me?.addr || addrFrom('web', this.selfPub), meta };
      this.discoveryStatus.state = 'ready';
      this.discoveryStatus.detail = `peers ${this.discovery.peers.length}`;
      this._updateDiscoveryUi();
      this.discovery.presence({ resume: true }).catch(() => { });
      this.discovery.handshakeAll(meta, { wantAck: true }).catch(() => { });
      return;
    }

    this.discoveryInitInFlight = true;
    this.discoveryStatus = { state: 'connecting', detail: '' };
    this._updateDiscoveryUi();

    try {
      const meta = this._discoveryMeta();
      this.discovery = await createDiscovery({
        room: this.discoveryRoom,
        me: { nknPub: this.selfPub, addr: this.selfAddr || addrFrom('web', this.selfPub), meta }
      });

      this.discovery.on('peer', (peer) => this._handleDiscoveryPeer(peer, 'presence'));
      this.discovery.on('handshake', (peer) => this._handleDiscoveryPeer(peer, 'handshake'));
      this.discovery.on('handshake_ack', (peer) => this._handleDiscoveryPeer(peer, 'ack'));
      this.discovery.on('status', (ev) => this._handleDiscoveryStatus(ev));

      for (const peer of this.discovery.peers) this._handleDiscoveryPeer(peer, 'persisted');

      this.discoveryStatus.state = 'ready';
      this.discoveryStatus.detail = `peers ${this.discovery.peers.length}`;
      this._updateDiscoveryUi();

      this.discovery.handshakeAll(meta, { wantAck: true }).catch(() => { });
    } catch (err) {
      console.warn('[discovery] init failed', err);
      this.discoveryStatus = { state: 'error', detail: err?.message || 'init failed' };
      this._updateDiscoveryUi();
    } finally {
      this.discoveryInitInFlight = false;
    }
  }

  _handleDiscoveryStatus(ev) {
    if (!ev) return;
    if (ev.type === 'disconnect') {
      this.discoveryStatus.state = 'connecting';
      this.discoveryStatus.detail = 'nats reconnecting';
    } else if (ev.type === 'reconnect') {
      this.discoveryStatus.state = 'ready';
      this.discoveryStatus.detail = `peers ${this.discovery?.peers?.length ?? this.peers.size}`;
      const meta = this._discoveryMeta();
      this.discovery?.handshakeAll(meta, { wantAck: true }).catch(() => { });
    } else if (ev.type === 'update') {
      this.discoveryStatus.detail = `peers ${this.discovery?.peers?.length ?? this.peers.size}`;
    }
    this._updateDiscoveryUi();
  }

  _handleDiscoveryPeer(peer, via = 'presence') {
    if (!peer) return;
    const pub = (peer.nknPub || '').toLowerCase();
    if (!isHex64(pub) || pub === this.selfPub) return;

    const ts = now();
    this._touchPeer(pub, ts);

    let ent = this.peers.get(pub);
    if (!ent) {
      ent = { addr: null, lastTs: ts, isVestigial: false };
      this.peers.set(pub, ent);
    }
    if (peer.addr && isAddr(peer.addr) && !ent.addr) ent.addr = peer.addr;
    if (peer.addr && isAddr(peer.addr)) {
      const pool = this.addrPool.get(peer.addr) || {};
      if (!pool.lastProbe) pool.lastProbe = ts;
      this.addrPool.set(peer.addr, pool);
    }

    if (Array.isArray(peer.meta?.ids)) {
      for (const id of peer.meta.ids) this._idSet(pub).add(id);
    }

    this.discoveryStatus.detail = `peers ${this.discovery?.peers?.length ?? this.peers.size}`;
    this._updateDiscoveryUi();

    const firstSight = !this._discoveryHello.has(pub);
    if (firstSight) {
      this._discoveryHello.add(pub);
      if (via === 'presence' || via === 'persisted') {
        this.discovery?.handshake(pub, this._discoveryMeta(), { wantAck: true }).catch(() => { });
        this._fireDiscoveryHello(pub);
        this._sendPoseSnapshotTo(pub).catch(() => { });
      } else if (via === 'handshake') {
        this._fireDiscoveryHello(pub);
        this._sendPoseSnapshotTo(pub).catch(() => { });
      }
    }
  }

  _fireDiscoveryHello(pub) {
    if (!this.client || !this.selfPub) return;
    const t = now();
    const hello = JSON.stringify(this._helloEnvelope(t));
    const ask = JSON.stringify({ type: 'peers_req', from: this.selfPub, ts: t });
    const targets = this._bestAddrs(pub);
    for (const to of targets) {
      this._sendRaw(to, hello).catch(() => { });
      this._sendRaw(to, ask).catch(() => { });
    }
    if (isHex64(this.signallerHex)) {
      const relay = `signal.${this.signallerHex}`;
      this._sendRaw(relay, hello).catch(() => { });
      this._sendRaw(relay, ask).catch(() => { });
    }
  }

  /* ───────── Helpers ───────── */

  _idSet(pub) {
    let s = this.knownIds.get(pub);
    if (!s) { s = new Set(['peer', 'web', 'phone', 'client']); this.knownIds.set(pub, s); }
    return s;
  }

  _bestAddrs(pub) {
    // Combine: ids → addresses, live ent.addr, and persisted book addrs
    const ids = [...this._idSet(pub)];
    const candidates = new Set(ids.map(id => addrFrom(id, pub)));
    const ent = this.peers.get(pub); if (ent?.addr && isAddr(ent.addr)) candidates.add(ent.addr);

    const fromBook = (this.book.peers || []).find(p => p.pub === pub);
    if (fromBook?.addrs) for (const a of fromBook.addrs) if (isAddr(a.addr)) candidates.add(a.addr);

    // Sort by RTT, then by last ACK recency
    return [...candidates].sort((a, b) => {
      const A = this.addrPool.get(a) || {}, B = this.addrPool.get(b) || {};
      const ra = A.rttMs == null ? 1e12 : A.rttMs, rb = B.rttMs == null ? 1e12 : B.rttMs;
      if (ra !== rb) return ra - rb;
      return (B.lastAck || 0) - (A.lastAck || 0);
    });
  }

  /* ───────── Connect & plumbing ───────── */

  async _connect() {
    try {
      setNkn('NKN: connecting…', 'warn');
      let hex = localStorage.getItem('NKN_SEED_HEX_V1');
      const makeSeed = () => { const u = new Uint8Array(32); crypto.getRandomValues(u); return Array.from(u).map(b => b.toString(16).padStart(2, '0')).join(''); };
      if (!isHex64(hex)) { hex = makeSeed(); localStorage.setItem('NKN_SEED_HEX_V1', hex); }
      this.client = new window.nkn.MultiClient({ seed: hex, identifier: 'web', numSubClients: 8, originalClient: true });

      // Session support (ncp-js)
      try {
        if (typeof this.client.listen === 'function' && typeof this.client.onSession === 'function') {
          this.client.listen();
          this.client.onSession((session) => this._acceptSession(session));
        } else {
          console.warn('[NKN] Session API not available on this sdk build.');
        }
      } catch (e) { console.warn('[NKN] session init error', e); }

      this.client.onConnect(() => {
        this.selfAddr = this.client.addr || null;
        this.selfPub = (this.client.getPublicKey() || '').toLowerCase();
        if (ui.myAddr) ui.myAddr.textContent = this.selfAddr || '—';
        if (ui.myPub) ui.myPub.textContent = this.selfPub || '—';
        setNkn('NKN: connected', 'ok');

        this._applyAlias(this.selfPub, this.displayName);

        this._initDiscovery();

        // Announce & request peers to *all known targets* (includes bootstrapped addrs)
        this._blast(this._helloEnvelope(now()));
        this._blast({ type: 'peers_req', from: this.selfPub, ts: now() });
        this._broadcastAlias();

        // Also proactively probe book once
        this._probeBookIfNeeded();

        this._flushPendingMessages();
      });

      this.client.onMessage(({ src, payload }) => {
        let text = payload;
        if (payload instanceof Uint8Array) {
          try { text = new TextDecoder().decode(payload); } catch { return; }
        }
        if (typeof text !== 'string') return;
        this._handleIncomingMessage(src, text);
      });

      this.client.on('willreconnect', () => setNkn('NKN: reconnecting…', 'warn'));
      this.client.on('connectFailed', () => setNkn('NKN: connect failed', 'err'));
      this.client.on('close', () => setNkn('NKN: disconnected', 'err'));

      setInterval(() => this._heartbeat(), 6000);
      setInterval(() => this._blast({ type: 'peers_req', from: this.selfPub, ts: now() }), 20000);

    } catch (err) { console.warn(err); setNkn('NKN: init failed', 'err'); }
  }

  /* ───────── Session helpers (ncp-js) ───────── */

  _acceptSession(session) {
    const m = /\.([0-9a-f]{64})$/i.exec(session.remoteAddr || "");
    const pub = m ? m[1].toLowerCase() : null;
    if (!pub) return;

    const prev = this.sessions.get(pub);
    if (prev && prev !== session) { try { prev.close?.(); } catch { } }
    this.sessions.set(pub, session);

    const readLoop = async () => {
      try {
        while (true) {
          const data = await session.read(); // Uint8Array
          if (!data || data.length === 0) break;
          // (optional) process stream frames
        }
      } catch (e) {
        console.warn('[NKN][session] read error', e);
      } finally {
        this.sessions.delete(pub);
        try { session.close?.(); } catch { }
      }
    };
    readLoop();
    console.log('[NKN][session] established', session.localAddr, '⇄', session.remoteAddr);
  }

  async _getOrDialSession(pub) {
    const alive = this.sessions.get(pub);
    if (alive) return alive;

    const addrs = this._bestAddrs(pub);
    let lastErr;
    for (const to of addrs) {
      try {
        const s = await this.client.dial?.(to);
        if (!s) throw new Error('dial unsupported');
        this.sessions.set(pub, s);
        this._acceptSession(s);
        return s;
      } catch (e) { lastErr = e; }
    }
    try {
      const relay = `signal.${this.signallerHex}`;
      const s = await this.client.dial?.(relay);
      if (!s) throw new Error('dial unsupported');
      this.sessions.set(pub, s); this._acceptSession(s);
      return s;
    } catch (e) { throw lastErr || e; }
  }

  async _sessionWrite(pub, bytes) {
    const s = await this._getOrDialSession(pub);
    await s.write(bytes);
  }

  async sendStateSnapshot(pub, obj) {
    const enc = new TextEncoder().encode(JSON.stringify({ type: 'state', v: obj }));
    await this._sessionWrite(pub, enc);
  }
  async sendChunk(pub, chunkUint8) { await this._sessionWrite(pub, chunkUint8); }

  /* ───────── Peers & UI ───────── */

  _touchPeer(pub, ts) {
    if (!pub) return;
    const p = this.peers.get(pub) || { addr: null, lastTs: 0, isVestigial: false };
    p.lastTs = Math.max(p.lastTs || 0, ts || now());
    this.peers.set(pub, p);

    // Ensure synthetic addrs for known ids exist in pool
    for (const id of this._idSet(pub)) {
      const a = addrFrom(id, pub);
      if (!this.addrPool.has(a)) this.addrPool.set(a, {});
    }

    this._renderPeers();
    this._saveBookSoon();
  }

  _renderPeers() {
    const t = now();
    this._pruneTeleportState(t);
    const rows = [...this.peers.entries()].sort((a, b) => (b[1].lastTs || 0) - (a[1].lastTs || 0));
    const hudUsers = [];
    if (ui.peerList) ui.peerList.innerHTML = '';
    let pendingIncoming = 0;
    for (const [pub, ent] of rows) {
      const row = document.createElement('div'); row.className = 'peer';
      const dot = document.createElement('span'); const online = this._online(pub);
      dot.className = 'dot ' + (online ? 'ok' : 'warn');
      const left = document.createElement('div');
      const name = document.createElement('div'); name.className = 'name'; name.textContent = this._aliasFor(pub);
      const meta = document.createElement('div'); meta.className = 'meta';
      const ago = ent.lastTs ? fmtAgo(t - (ent.lastTs || t)) + ' ago' : '—';
      meta.textContent = online ? (`online • ${ago}`) : (`last ${ago}`);
      const poseDiv = document.createElement('div'); poseDiv.className = 'pose';
      const lp = this.latestPose.get(pub);
      if (lp) {
        const eul = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(lp.q[0], lp.q[1], lp.q[2], lp.q[3]), 'YXZ');
        const ll = lp.geo && Number.isFinite(lp.geo.lat) && Number.isFinite(lp.geo.lon)
          ? ` | ll ${lp.geo.lat.toFixed(5)}, ${lp.geo.lon.toFixed(5)}`
          : '';
        poseDiv.textContent = `addr: ${ent.addr || '—'} | pose: ${lp.p.map(v => v.toFixed(2)).join(', ')}${ll} | yaw ${deg(eul.y).toFixed(1)}°${lp.j ? ' • jumped' : ''}`;
      } else {
        poseDiv.textContent = `addr: ${ent.addr || '—'} | pose: —`;
      }
      left.appendChild(name); left.appendChild(meta); left.appendChild(poseDiv);
      row.appendChild(dot); row.appendChild(left);

      const incoming = this.teleportInbox.get(pub);
      const outgoing = this.teleportOutbox.get(pub);
      if (incoming?.status === 'pending') pendingIncoming++;
      const actionsNode = this._buildTeleportActions(pub, incoming, outgoing, t);
      if (actionsNode) row.appendChild(actionsNode);

      if (ui.peerList) ui.peerList.appendChild(row);

      hudUsers.push({
        pub,
        alias: this._aliasFor(pub),
        short: shortHex(pub, 6, 4),
        online,
        lastTs: ent.lastTs || 0,
        geo: lp?.geo || null,
        incomingStatus: incoming?.status || null,
        outgoingStatus: outgoing?.status || null,
      });
    }
    let online = 0; for (const pub of this.peers.keys()) if (this._online(pub)) online++;
    if (ui.hudPeerCount) ui.hudPeerCount.textContent = String(online);
    if (ui.peerSummary) {
      const parts = [`${this.peers.size} peers`, `${online}/${this.addrPool.size} addrs online`];
      if (pendingIncoming > 0) parts.push(`${pendingIncoming} teleport request${pendingIncoming > 1 ? 's' : ''}`);
      ui.peerSummary.textContent = parts.join(' • ');
    }

    this.app?.updateHudUserList?.(hudUsers);
  }

  _pruneTeleportState(nowTs = now()) {
    const expirePending = (info) => {
      if (!info) return;
      const ts = Number.isFinite(info.ts) ? info.ts : nowTs;
      if (info.status === 'pending' && nowTs - ts > TELEPORT_PENDING_TIMEOUT) {
        info.status = 'expired';
        info.respondedAt = nowTs;
      }
    };

    const removeIn = [];
    for (const [pub, info] of this.teleportInbox.entries()) {
      expirePending(info);
      if (!info) { removeIn.push(pub); continue; }
      const ref = Number.isFinite(info.respondedAt) ? info.respondedAt : (Number.isFinite(info.ts) ? info.ts : nowTs);
      if (nowTs - ref > TELEPORT_STALE_MS) removeIn.push(pub);
    }
    removeIn.forEach((pub) => {
      this.teleportInbox.delete(pub);
      this._emitTeleportStatus(pub, null);
    });

    const removeOut = [];
    for (const [pub, info] of this.teleportOutbox.entries()) {
      expirePending(info);
      if (!info) { removeOut.push(pub); continue; }
      const ref = Number.isFinite(info.respondedAt) ? info.respondedAt : (Number.isFinite(info.ts) ? info.ts : nowTs);
      if (nowTs - ref > TELEPORT_STALE_MS) removeOut.push(pub);
    }
    removeOut.forEach((pub) => this.teleportOutbox.delete(pub));
  }

  _buildTeleportActions(pub, incoming, outgoing, t) {
    const actions = document.createElement('div');
    actions.className = 'actions';
    let hasContent = false;
    const addNote = (text) => {
      if (!text) return;
      const note = document.createElement('div');
      note.className = 'note';
      note.textContent = text;
      actions.appendChild(note);
      hasContent = true;
    };

    const fmtSince = (ref) => `${fmtAgo(Math.max(0, t - ref))} ago`;

    if (incoming) {
      const ts = Number.isFinite(incoming.ts) ? incoming.ts : t;
      if (incoming.status === 'pending') {
        addNote(`Incoming teleport request • ${fmtSince(ts)}`);
        const btnRow = document.createElement('div');
        btnRow.className = 'btn-row';
        const acceptBtn = document.createElement('button');
        acceptBtn.textContent = 'Accept';
        acceptBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._respondTeleport(pub, true);
        });
        const declineBtn = document.createElement('button');
        declineBtn.textContent = 'Decline';
        declineBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this._respondTeleport(pub, false);
        });
        btnRow.appendChild(acceptBtn);
        btnRow.appendChild(declineBtn);
        actions.appendChild(btnRow);
        hasContent = true;
      } else {
        const respondedAt = Number.isFinite(incoming.respondedAt) ? incoming.respondedAt : ts;
        const since = fmtSince(respondedAt);
        let msg = 'Teleport request handled';
        if (incoming.status === 'accepted') msg = 'Accepted teleport request';
        else if (incoming.status === 'rejected') msg = 'Declined teleport request';
        else if (incoming.status === 'expired') msg = 'Teleport request expired';
        else if (incoming.status === 'error') msg = 'Teleport request failed';
        if (incoming.reason) msg += ` • ${incoming.reason}`;
        addNote(`${msg} • ${since}`);
      }
    }

    const canTeleport = pub && pub !== this.selfPub;
    if (canTeleport) {
      const teleBtn = document.createElement('button');
      const isPending = outgoing?.status === 'pending';
      teleBtn.textContent = isPending ? 'Teleport Requested…' : 'Teleport';
      teleBtn.disabled = isPending;
      teleBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._sendTeleportRequest(pub);
      });
      actions.appendChild(teleBtn);
      hasContent = true;
    }

    if (outgoing) {
      const ts = Number.isFinite(outgoing.ts) ? outgoing.ts : t;
      const respondedAt = Number.isFinite(outgoing.respondedAt) ? outgoing.respondedAt : ts;
      const since = fmtSince(outgoing.status === 'pending' ? ts : respondedAt);
      let msg = null;
      switch (outgoing.status) {
        case 'pending':
          msg = `Teleport request pending • ${since}`;
          break;
        case 'accepted':
          msg = `Teleport accepted • ${since}`;
          break;
        case 'complete':
          msg = `Teleported successfully • ${since}`;
          break;
        case 'rejected':
          msg = `Teleport request denied • ${since}`;
          break;
        case 'expired':
          msg = `Teleport request expired • ${since}`;
          break;
        case 'unavailable':
          msg = `Teleport unavailable • ${since}`;
          break;
        case 'error':
          msg = `Teleport request failed • ${since}`;
          break;
        default:
          break;
      }
      if (msg) {
        if (outgoing.reason) msg += ` • ${outgoing.reason}`;
        addNote(msg);
      }
    }

    return hasContent ? actions : null;
  }

  _sendTeleportRequest(pub) {
    if (!pub || !this.selfPub) return;
    const key = pub.toLowerCase();
    if (key === this.selfPub) return;
    const nowTs = now();
    const existing = this.teleportOutbox.get(key);
    if (existing?.status === 'pending') return;

    this.teleportOutbox.set(key, { ts: nowTs, status: 'pending' });
    this._touchPeer(key, nowTs);
    this._renderPeers();

    const payload = { type: 'teleport_req', from: this.selfPub, to: key, ts: nowTs };
    this._sendToPub(key, payload).then((sent) => {
      if (sent) return;
      const info = this.teleportOutbox.get(key);
      if (!info || info.status !== 'pending') return;
      info.status = 'error';
      info.respondedAt = now();
      info.reason = 'unreachable';
      this.teleportOutbox.set(key, info);
      this._renderPeers();
    });
  }

  _respondTeleport(pub, accept) {
    if (!pub || !this.selfPub) return;
    const key = pub.toLowerCase();
    if (key === this.selfPub) return;
    const entry = this.teleportInbox.get(key);
    if (!entry) return;

    let accepted = !!accept;
    const nowTs = now();
    const payload = { type: 'teleport_rsp', from: this.selfPub, to: key, ts: nowTs, accepted };

    if (accepted) {
      const dest = this.app.buildTeleportOffer?.();
      if (dest) {
        payload.dest = dest;
      } else {
        accepted = false;
        payload.accepted = false;
        payload.reason = 'unavailable';
      }
    }

    if (!accepted && !payload.reason) payload.reason = 'declined';

    entry.status = accepted ? 'accepted' : 'rejected';
    if (!accepted && payload.reason) entry.reason = payload.reason;
    entry.respondedAt = nowTs;
    this.teleportInbox.set(key, entry);
    this._emitTeleportStatus(key, entry);
    this._touchPeer(key, nowTs);
    this._renderPeers();

    this._sendToPub(key, payload).then((sent) => {
      if (sent) return;
      const info = this.teleportInbox.get(key);
      if (!info) return;
      info.status = 'error';
      info.respondedAt = now();
      info.reason = 'send failed';
      this.teleportInbox.set(key, info);
      this._emitTeleportStatus(key, info);
      this._renderPeers();
    });
  }

  markTeleportArrivalComplete(pub) {
    if (!pub) return;
    const key = pub.toLowerCase();
    const entry = this.teleportOutbox.get(key);
    if (!entry) return;
    entry.status = 'complete';
    entry.respondedAt = now();
    this.teleportOutbox.set(key, entry);
    this._renderPeers();
  }

  markTeleportFailed(pub, reason = 'teleport failed') {
    if (!pub) return;
    const key = pub.toLowerCase();
    const entry = this.teleportOutbox.get(key);
    if (!entry) return;
    entry.status = 'error';
    entry.reason = reason;
    entry.respondedAt = now();
    this.teleportOutbox.set(key, entry);
    this._renderPeers();
  }

  requestTeleport(pub) {
    this._sendTeleportRequest(pub);
  }

  respondTeleport(pub, accept) {
    this._respondTeleport(pub, accept);
  }

  async _sendToPub(pub, payload, { fallback = true } = {}) {
    if (!pub || !payload) return false;
    const key = pub.toLowerCase();
    if (key === this.selfPub) return false;
    const pkt = JSON.stringify(payload);
    this._noteBytes(pkt);
    const addrs = this._bestAddrs(key);
    for (const to of addrs) {
      try { await this._sendRaw(to, pkt); this.sent++; return true; } catch { }
    }
    if (fallback && isHex64(this.signallerHex)) {
      try { await this._sendRaw(`signal.${this.signallerHex}`, pkt); this.sent++; return true; } catch { }
    }
    this.dropped++;
    return false;
  }

  _online(pub) {
    const addrs = this._bestAddrs(pub);
    const t = now();
    return addrs.some(a => (this.addrPool.get(a)?.lastAck || 0) > t - 12000);
  }

  _sendRoster(to) {
    const items = [];
    for (const [pub, ent] of this.peers.entries()) {
      const alias = this.aliases.get(pub) || '';
      items.push({ pub, ids: [...this._idSet(pub)], addr: ent.addr || null, last: ent.lastTs || 0, alias: alias || undefined });
    }
    this._sendRaw(to, JSON.stringify({ type: 'peers', items, ts: now() }));
  }

  _targets() {
    const set = new Set();
    if (isHex64(this.signallerHex)) set.add(`signal.${this.signallerHex}`);
    for (const a of this.addrPool.keys()) set.add(a);
    for (const [pub] of this.peers.entries()) {
      this._idSet(pub).forEach(id => set.add(addrFrom(id, pub)));
      set.add(addrFrom('peer', pub)); set.add(addrFrom('web', pub)); set.add(addrFrom('phone', pub));
    }
    return [...set].filter(a => a !== this.selfAddr && !a.endsWith(`.${this.selfPub}`));
  }

  _blast(obj) {
    const msg = JSON.stringify(obj);
    this._noteBytes(msg);
    for (const to of this._targets()) { this._sendRaw(to, msg).catch(() => { }); }
  }

  /**
   * Send pose at up to 60 fps. Tight thresholds; jumpEvent forces immediate send.
   * Expect q to be yaw-only (we keep bodies upright), as provided by app.js.
   */
  async sendPoseIfChanged(p, q, yOverride, jumpEvent = false, crouchActive = false, extras = null) {
    const t = now();

    const normalizeXr = (src) => {
      if (!src || typeof src !== 'object') return null;
      const out = {};
      out.active = src.active != null ? (src.active ? 1 : 0) : 1;
      if (Number.isFinite(src.headYaw)) out.headYaw = src.headYaw;
      if (Number.isFinite(src.headPitch)) out.headPitch = src.headPitch;
      if (Number.isFinite(src.headRoll)) out.headRoll = src.headRoll;
      if (Number.isFinite(src.headHeight)) out.headHeight = src.headHeight;
      return out;
    };

    const anglesDiffer = (a, b, eps) => {
      const aFinite = Number.isFinite(a);
      const bFinite = Number.isFinite(b);
      if (!aFinite && !bFinite) return false;
      if (!aFinite || !bFinite) return true;
      const diff = Math.abs(THREE.MathUtils.euclideanModulo((a - b) + Math.PI, Math.PI * 2) - Math.PI);
      return diff > eps;
    };

    const scalarsDiffer = (a, b, eps) => {
      const aFinite = Number.isFinite(a);
      const bFinite = Number.isFinite(b);
      if (!aFinite && !bFinite) return false;
      if (!aFinite || !bFinite) return true;
      return Math.abs(a - b) > eps;
    };

    const xrStateChanged = (prevState, nextState) => {
      if (!prevState && !nextState) return false;
      if (!prevState || !nextState) return true;
      if ((prevState.active ?? 1) !== (nextState.active ?? 1)) return true;
      if (anglesDiffer(prevState.headYaw, nextState.headYaw, this.XR_HEAD_EPS)) return true;
      if (anglesDiffer(prevState.headPitch, nextState.headPitch, this.XR_HEAD_EPS)) return true;
      if (anglesDiffer(prevState.headRoll, nextState.headRoll, this.XR_HEAD_EPS)) return true;
      if (scalarsDiffer(prevState.headHeight, nextState.headHeight, this.XR_HEIGHT_EPS)) return true;
      return false;
    };

    const xrSnapshot = normalizeXr(extras?.xr);

    // 60 fps gate
    if (!jumpEvent && (t - (this._lastSendAt || 0)) < this.MIN_INTERVAL_MS) return;

    const crouchFlag = crouchActive ? 1 : 0;
    if (!this._posePrev) {
      this._posePrev = {
        p: [p.x, p.y, p.z],
        q: [q.x, q.y, q.z, q.w],
        c: crouchFlag,
        t: 0,
        xr: xrSnapshot ? { ...xrSnapshot } : null
      };
    }
    const prev = this._posePrev;

    const posDelta = Math.hypot(p.x - prev.p[0], p.y - prev.p[1], p.z - prev.p[2]);
    const dot = prev.q[0] * q.x + prev.q[1] * q.y + prev.q[2] * q.z + prev.q[3] * q.w;
    const ang = 2 * Math.acos(Math.min(1, Math.abs(dot)));

    const crouchChanged = (prev.c ?? 0) !== crouchFlag;
    const xrChanged = xrStateChanged(prev.xr, xrSnapshot);
    const changed = posDelta > this.POS_EPS || ang > this.ANG_EPS || jumpEvent || crouchChanged || xrChanged;
    if (!changed) return;

    this._posePrev = {
      p: [p.x, p.y, p.z],
      q: [q.x, q.y, q.z, q.w],
      c: crouchFlag,
      t,
      xr: xrSnapshot ? { ...xrSnapshot } : null
    };

    const y = Number.isFinite(yOverride) ? yOverride : p.y;
    const payload = {
      type: 'pose',
      from: this.selfPub,
      ts: t,
      pose: {
        p: [+p.x.toFixed(3), +y.toFixed(3), +p.z.toFixed(3)],
        q: [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4)],
        j: jumpEvent ? 1 : 0,
        c: crouchFlag
      }
    };

    if (xrSnapshot) {
      const xrPayload = { active: xrSnapshot.active ?? 1 };
      if (Number.isFinite(xrSnapshot.headYaw)) xrPayload.headYaw = +xrSnapshot.headYaw.toFixed(4);
      if (Number.isFinite(xrSnapshot.headPitch)) xrPayload.headPitch = +xrSnapshot.headPitch.toFixed(4);
      if (Number.isFinite(xrSnapshot.headRoll)) xrPayload.headRoll = +xrSnapshot.headRoll.toFixed(4);
      if (Number.isFinite(xrSnapshot.headHeight)) xrPayload.headHeight = +xrSnapshot.headHeight.toFixed(3);
      payload.pose.xr = xrPayload;
    }

    const geo = this._geoPayload(p.x, p.z, y);
    if (geo) payload.geo = geo;

    const pkt = JSON.stringify(payload);
    this._noteBytes(pkt);
    this.hzCount++;

    for (const [pub] of this.peers.entries()) {
      if (pub === this.selfPub) continue;
      if (!this._online(pub)) continue;
      const addrs = this._bestAddrs(pub);
      let sent = false;
      for (const to of addrs) { try { await this._sendRaw(to, pkt); sent = true; break; } catch { } }
      if (!sent) { try { await this._sendRaw(`signal.${this.signallerHex}`, pkt); sent = true; } catch { } }
      if (sent) { this.sent++; } else { this.dropped++; }
    }

    // advance the send gate even if there were no peers, to avoid tight-looping
    this._lastSendAt = t;
  }

  /* ───────── Immediate snapshot to a single peer (handshake/discovery) ───────── */

  async _sendPoseSnapshotTo(pub) {
    if (!pub || pub === this.selfPub) return;

    // Compose from current rig state (yaw-only quaternion to keep remotes upright)
    const dol = this.app.sceneMgr.dolly;
    const groundY = this.app.hexGridMgr.getHeightAt(dol.position.x, dol.position.z);
    const actualY = groundY + this.app.move.eyeHeight();

    const qSend = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, dol.rotation.y, 0, 'YXZ'));

    const payload = {
      type: 'pose',
      from: this.selfPub,
      ts: now(),
      pose: {
        p: [+dol.position.x.toFixed(2), +actualY.toFixed(2), +dol.position.z.toFixed(2)],
        q: [+qSend.x.toFixed(3), +qSend.y.toFixed(3), +qSend.z.toFixed(3), +qSend.w.toFixed(3)],
        j: 0
      }
    };
    const xrPrev = this._posePrev?.xr;
    if (xrPrev) {
      const xrPayload = { active: xrPrev.active ?? 1 };
      if (Number.isFinite(xrPrev.headYaw)) xrPayload.headYaw = +xrPrev.headYaw.toFixed(4);
      if (Number.isFinite(xrPrev.headPitch)) xrPayload.headPitch = +xrPrev.headPitch.toFixed(4);
      if (Number.isFinite(xrPrev.headRoll)) xrPayload.headRoll = +xrPrev.headRoll.toFixed(4);
      if (Number.isFinite(xrPrev.headHeight)) xrPayload.headHeight = +xrPrev.headHeight.toFixed(3);
      payload.pose.xr = xrPayload;
    }
    const geo = this._geoPayload(dol.position.x, dol.position.z, actualY);
    if (geo) payload.geo = geo;

    const pkt = JSON.stringify(payload);

    const addrs = this._bestAddrs(pub);
    let sent = false;
    for (const to of addrs) {
      try { await this._sendRaw(to, pkt); sent = true; break; } catch { }
    }
    if (!sent) {
      try { await this._sendRaw(`signal.${this.signallerHex}`, pkt); sent = true; } catch { }
    }
    if (sent) this.sent++; else this.dropped++;
  }

  _heartbeat() {
    const t = now();
    const ids = this._targets();
    for (const to of ids) {
      const m = this.addrPool.get(to) || {}; m.lastProbe = t; this.addrPool.set(to, m);
      const hb = JSON.stringify({ type: 'hb', from: this.selfPub, t_client: t });
      this._noteBytes(hb);
      this._sendRaw(to, hb).catch(() => { });
    }
    this._saveBookSoon(); // persist probe timestamps occasionally
  }

  _sendRaw(to, text) { return this.client.send(to, text, { noReply: true, maxHoldingSeconds: 1 }); }

  _nuke() {
    if (!confirm('This will wipe identity, address book and caches. Continue?')) return;
    try {
      localStorage.removeItem('NKN_SEED_HEX_V1');
      localStorage.removeItem('NKN_SIG_HEX');
      localStorage.removeItem(BOOK_KEY);
      for (const k of Object.keys(localStorage)) { if (/^tile:/.test(k) || k === 'elevCacheV1') localStorage.removeItem(k); }
    } finally { location.reload(); }
  }
}
