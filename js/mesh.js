// mesh.js
import * as THREE from 'three';
import { ui, setNkn, setSig, setSigMeta } from './ui.js';
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

    this.peers = new Map();      // pub -> { addr?: string, lastTs: number }
    this.addrPool = new Map();   // addr -> { lastAck?, rttMs?, lastProbe?, lastMsg? }
    this.latestPose = new Map(); // pub -> { p, q, ts, j }
    this.knownIds  = new Map();  // pub -> Set(ids)

    // Sessions (ncp-js)
    this.sessions = new Map();   // pub -> session

    // stats
    this.hzCount = 0; this.sent = 0; this.dropped = 0;
    this.byteWindow = [];

    // 60 fps pose send target
    this.TARGET_HZ = 30;
    this.MIN_INTERVAL_MS = Math.floor(1000 / this.TARGET_HZ); // ~16ms
    this._lastSendAt = 0;

    // thresholds (tight)
    this.POS_EPS = 0.0015;    // ~1.5 mm
    this.ANG_EPS = rad(0.35); // ~0.35°

    // ----- Address book -----
    this.book = { v: BOOK_VER, updatedAt: new Date().toISOString(), peers: [] };
    this._saveTimer = null;

    this._loadBook();
    this._bootstrapFromBook(); // populate peers/addrPool/knownIds up-front

    setInterval(() => {
      if (ui.poseHzEl)   ui.poseHzEl.textContent   = String(this.hzCount);
      if (ui.poseSentEl) ui.poseSentEl.textContent = String(this.sent);
      if (ui.poseDropEl) ui.poseDropEl.textContent = String(this.dropped);
      this.hzCount = 0; this._updateRate();
    }, 1000);
    setInterval(() => this._renderPeers(), 1500);

    this._applySig(localStorage.getItem('NKN_SIG_HEX') || '');
    this._connect();

    if (ui.hexSig) {
      ui.hexSig.value = localStorage.getItem('NKN_SIG_HEX') || '';
      ui.hexSig.addEventListener('input', () => this._applySig(ui.hexSig.value));
    }
    if (ui.nukeBtn) ui.nukeBtn.addEventListener('click', () => this._nuke());

    // Re-probe book periodically when signaller seems unhealthy
    this._bookProbeTimer = setInterval(() => this._probeBookIfNeeded(), BOOK_PROBE_MS);
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
          const old  = (prev?.addrs || []).find(x => x.addr === a) || {};
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
        if (a.lastAck)   m.lastAck   = a.lastAck;
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

      const hello = JSON.stringify({ type: 'hello', from: this.selfPub, ts: t });
      const ask   = JSON.stringify({ type: 'peers_req', from: this.selfPub, ts: t });

      for (const to of targets) {
        const m = this.addrPool.get(to) || {}; m.lastProbe = t; this.addrPool.set(to, m);
        this._sendRaw(to, hello).catch(() => {});
        this._sendRaw(to, ask).catch(() => {});
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

  /* ───────── Signaller config ───────── */

  _applySig(raw) {
    const v = (raw || '').trim().toLowerCase();
    this.signallerHex = isHex64(v) ? v : this.DEFAULT_SIG;
    if (isHex64(v)) localStorage.setItem('NKN_SIG_HEX', v);
    setSig(`Mesh: targeting ${shortHex(this.signallerHex, 8, 8)}`, 'warn');
    setSigMeta('probing…');
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
        if (ui.myPub)  ui.myPub.textContent  = this.selfPub || '—';
        setNkn('NKN: connected', 'ok');

        // Announce & request peers to *all known targets* (includes bootstrapped addrs)
        this._blast({ type: 'hello', from: this.selfPub, ts: now() });
        this._blast({ type: 'peers_req', from: this.selfPub, ts: now() });

        // Also proactively probe book once
        this._probeBookIfNeeded();
      });

      this.client.onMessage(({ src, payload }) => {
        // Learn id + mark lastMsg on the address we heard from
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

        // Decode text payloads
        let text = payload;
        if (payload instanceof Uint8Array) { try { text = new TextDecoder().decode(payload); } catch { } }
        if (typeof text !== 'string' || !text.trim().startsWith('{')) return;
        let msg = null; try { msg = JSON.parse(text); } catch { return; }
        const t = now();

        if (msg.type === 'hello' && msg.from) {
          const pub = msg.from.toLowerCase();
          this._touchPeer(pub, t);
          this.app.remotes.ensure(pub);
          this._saveBookSoon();

          // ★ Auto-snapshot back to greeter
          this._sendPoseSnapshotTo(pub).catch(() => {});
          return;
        }

        if (msg.type === 'hb') {
          // Reply to any sender; store peer activity
          this._sendRaw(src, JSON.stringify({ type: 'hb_ack', from: this.selfPub, t_client: msg.t_client }));
          if (msg.from) this._touchPeer(msg.from.toLowerCase(), t);
          return;
        }

        if (msg.type === 'hb_ack' && typeof msg.t_client === 'number') {
          const rtt = Math.max(0, now() - msg.t_client);
          const m = this.addrPool.get(src) || {};
          m.lastAck = now(); m.rttMs = rtt;
          this.addrPool.set(src, m);

          // If the signaller, update UI
          const sigAddr = isHex64(this.signallerHex) ? `signal.${this.signallerHex}` : '';
          if (src === sigAddr) setSigMeta(`latency: ${Math.round(rtt)} ms`);

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

            // Ensure candidate addrs exist in pool
            for (const id of this._idSet(pub)) {
              const a = addrFrom(id, pub);
              if (!this.addrPool.has(a)) this.addrPool.set(a, {});
            }

            this.app.remotes.ensure(pub);

            // ★ Auto-snapshot to each discovered peer
            this._sendPoseSnapshotTo(pub).catch(() => {});
          }
          this._renderPeers();
          this._saveBookSoon();
          return;
        }

        if (msg.type === 'peers_req') {
          // Send roster to requester
          this._sendRoster(src);

          // ★ If requester identity known, send snapshot back
          if (msg.from && /^[0-9a-f]{64}$/i.test(msg.from)) {
            const pub = msg.from.toLowerCase();
            this._touchPeer(pub, t);
            this._sendPoseSnapshotTo(pub).catch(() => {});
          }
          return;
        }

        if (msg.type === 'pose' && msg.from && Array.isArray(msg.pose?.p) && Array.isArray(msg.pose?.q)) {
          const pub = msg.from.toLowerCase();
          this._touchPeer(pub, t);
          const info = { rtt: this.addrPool.get(src)?.rttMs ?? null, age: fmtAgo(now() - msg.ts) };
          const pose = msg.pose;
          this.latestPose.set(pub, { p: pose.p, q: pose.q, ts: msg.ts, j: pose.j ? 1 : 0 });
          this.app.remotes.update(pub, { p: pose.p, q: pose.q, j: pose.j ? 1 : 0 }, info);
          this._renderPeers();
          return;
        }
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
    const rows = [...this.peers.entries()].sort((a, b) => (b[1].lastTs || 0) - (a[1].lastTs || 0));
    if (ui.peerList) ui.peerList.innerHTML = '';
    for (const [pub, ent] of rows) {
      const row = document.createElement('div'); row.className = 'peer';
      const dot = document.createElement('span'); const online = this._online(pub);
      dot.className = 'dot ' + (online ? 'ok' : 'warn');
      const left = document.createElement('div');
      const name = document.createElement('div'); name.className = 'name'; name.textContent = shortHex(pub, 8, 6);
      const meta = document.createElement('div'); meta.className = 'meta';
      const ago = ent.lastTs ? fmtAgo(t - (ent.lastTs || t)) + ' ago' : '—';
      meta.textContent = online ? (`online • ${ago}`) : (`last ${ago}`);
      const poseDiv = document.createElement('div'); poseDiv.className = 'pose';
      const lp = this.latestPose.get(pub);
      if (lp) {
        const eul = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(lp.q[0], lp.q[1], lp.q[2], lp.q[3]), 'YXZ');
        poseDiv.textContent = `addr: ${ent.addr || '—'} | pose: ${lp.p.map(v => v.toFixed(2)).join(', ')} | yaw ${deg(eul.y).toFixed(1)}°${lp.j ? ' • jumped' : ''}`;
      } else {
        poseDiv.textContent = `addr: ${ent.addr || '—'} | pose: —`;
      }
      left.appendChild(name); left.appendChild(meta); left.appendChild(poseDiv);
      row.appendChild(dot); row.appendChild(left);
      if (ui.peerList) ui.peerList.appendChild(row);
    }
    let online = 0; for (const pub of this.peers.keys()) if (this._online(pub)) online++;
    if (ui.peerSummary) ui.peerSummary.textContent = `${this.peers.size} peers • ${online}/${this.addrPool.size} addrs online`;
  }

  _online(pub) {
    const addrs = this._bestAddrs(pub);
    const t = now();
    return addrs.some(a => (this.addrPool.get(a)?.lastAck || 0) > t - 12000);
  }

  _sendRoster(to) {
    const items = [];
    for (const [pub, ent] of this.peers.entries()) {
      items.push({ pub, ids: [...this._idSet(pub)], addr: ent.addr || null, last: ent.lastTs || 0 });
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
    return [...set].filter(a => a !== this.selfAddr);
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
  async sendPoseIfChanged(p, q, yOverride, jumpEvent = false) {
    const t = now();

    // 60 fps gate
    if (!jumpEvent && (t - (this._lastSendAt || 0)) < this.MIN_INTERVAL_MS) return;

    if (!this._posePrev) this._posePrev = { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], t: 0 };
    const prev = this._posePrev;

    const posDelta = Math.hypot(p.x - prev.p[0], p.y - prev.p[1], p.z - prev.p[2]);
    const dot = prev.q[0] * q.x + prev.q[1] * q.y + prev.q[2] * q.z + prev.q[3] * q.w;
    const ang = 2 * Math.acos(Math.min(1, Math.abs(dot)));

    const changed = posDelta > this.POS_EPS || ang > this.ANG_EPS || jumpEvent;
    if (!changed) return;

    this._posePrev = { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], t };

    const y = Number.isFinite(yOverride) ? yOverride : p.y;
    const pkt = JSON.stringify({
      type: 'pose', from: this.selfPub, ts: t,
      pose: {
        p: [+p.x.toFixed(3), +y.toFixed(3), +p.z.toFixed(3)],
        q: [+q.x.toFixed(4), +q.y.toFixed(4), +q.z.toFixed(4), +q.w.toFixed(4)],
        j: jumpEvent ? 1 : 0
      }
    });
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

    const pkt = JSON.stringify({
      type: 'pose',
      from: this.selfPub,
      ts: now(),
      pose: {
        p: [+dol.position.x.toFixed(2), +actualY.toFixed(2), +dol.position.z.toFixed(2)],
        q: [+qSend.x.toFixed(3), +qSend.y.toFixed(3), +qSend.z.toFixed(3), +qSend.w.toFixed(3)],
        j: 0
      }
    });

    const addrs = this._bestAddrs(pub);
    let sent = false;
    for (const to of addrs) {
      try { await this._sendRaw(to, pkt); sent = true; break; } catch {}
    }
    if (!sent) {
      try { await this._sendRaw(`signal.${this.signallerHex}`, pkt); sent = true; } catch {}
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
