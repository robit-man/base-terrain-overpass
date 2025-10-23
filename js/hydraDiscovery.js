const DEFAULT_SERVERS = ['wss://demo.nats.io:8443'];
const DEFAULT_HEARTBEAT_SEC = 12;

const nowSeconds = () => Math.floor(Date.now() / 1000);

class EventHub {
  constructor() {
    this.handlers = new Map();
  }

  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
    return () => this.off(evt, fn);
  }

  off(evt, fn) {
    this.handlers.get(evt)?.delete(fn);
  }

  emit(evt, data) {
    const list = this.handlers.get(evt);
    if (!list || !list.size) return;
    list.forEach((fn) => {
      try {
        fn(data);
      } catch (err) {
        // ignore handler errors
      }
    });
  }
}

async function loadNats() {
  const mod = await import('nats.ws');
  return mod;
}

function sanitizeRoomName(value) {
  const raw = String(value || 'default');
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

const normalizePubKey = (value) => {
  if (!value) return '';
  const text = String(value).trim().toLowerCase();
  return /^[0-9a-f]{64}$/.test(text) ? text : '';
};

export class HydraDiscovery extends EventHub {
  constructor({ room, me, servers, heartbeatSec } = {}) {
    super();
    this.room = sanitizeRoomName(room);
    this.me = { ...(me || {}) };
    this.servers = Array.isArray(servers) && servers.length ? servers : DEFAULT_SERVERS;
    this.heartbeatSec = typeof heartbeatSec === 'number' ? heartbeatSec : DEFAULT_HEARTBEAT_SEC;
    this.nc = null;
    this.sc = null;
    this._hb = null;
    this.store = new Map();
    this.presenceSubject = `hydra.${this.room}.presence`;
    this.dmSubject = (pub) => `hydra.${this.room}.dm.${pub}`;
  }

  get peers() {
    return Array.from(this.store.values())
      .filter((peer) => peer.nknPub && peer.nknPub !== this.me.nknPub)
      .sort((a, b) => (b.last || 0) - (a.last || 0));
  }

  async connect() {
    if (this.nc) return this;
    const { connect, StringCodec, Events } = await loadNats();
    const nameSuffix = (this.me?.nknPub || '').slice(-6) || Math.random().toString(36).slice(-4);
    const nc = await connect({
      servers: this.servers,
      name: `hydra-client-${nameSuffix}`
    });
    this.nc = nc;
    this.sc = StringCodec();

    const presenceSub = await nc.subscribe(this.presenceSubject);
    (async () => {
      for await (const msg of presenceSub) {
        const payload = this._decode(msg);
        if (!payload || payload.type !== 'presence') continue;
        if (payload.pub === this.me.nknPub) continue;
        const peer = this._upsertPeer({
          nknPub: payload.pub,
          addr: payload.addr || payload.pub,
          meta: payload.meta || {},
          last: payload.ts || nowSeconds()
        });
        this.emit('peer', peer);
      }
    })();

    const dmSub = await nc.subscribe(this.dmSubject(this.me.nknPub));
    (async () => {
      for await (const msg of dmSub) {
        const payload = this._decode(msg);
        if (!payload || !payload.type) continue;
        if (payload.pub === this.me.nknPub) continue;
        this.emit('dm', { from: payload.pub, msg: payload });
      }
    })();

    (async () => {
      for await (const status of nc.status()) {
        this.emit('status', status);
      }
    })();

    return this;
  }

  _upsertPeer(peer) {
    if (!peer?.nknPub) return null;
    const key = normalizePubKey(peer.nknPub);
    if (!key) return null;
    const existing = this.store.get(key) || {};
    const merged = {
      ...existing,
      ...peer,
      nknPub: key,
      addr: peer.addr || existing.addr || key,
      meta: { ...(existing.meta || {}), ...(peer.meta || {}) },
      last: peer.last || nowSeconds()
    };
    this.store.set(key, merged);
    return merged;
  }

  async presence(meta = {}) {
    if (!this.nc) throw new Error('not connected');
    const payload = {
      type: 'presence',
      pub: this.me.nknPub,
      addr: this.me.addr || this.me.nknPub,
      meta,
      ts: nowSeconds()
    };
    this.nc.publish(this.presenceSubject, this._encode(payload));
  }

  async startHeartbeat(meta = {}) {
    await this.presence(meta);
    if (this._hb) clearInterval(this._hb);
    this._hb = setInterval(() => {
      this.presence(meta).catch(() => {});
    }, Math.max(3, this.heartbeatSec) * 1000);
  }

  async dm(pub, payload) {
    if (!this.nc) throw new Error('not connected');
    const target = normalizePubKey(pub);
    if (!target) throw new Error('invalid pub');
    const msg = {
      ...(payload || {}),
      pub: this.me.nknPub,
      addr: this.me.addr || this.me.nknPub,
      ts: nowSeconds()
    };
    this.nc.publish(this.dmSubject(target), this._encode(msg));
  }

  _encode(obj) {
    try {
      return this.sc.encode(JSON.stringify(obj));
    } catch (err) {
      return this.sc.encode('{}');
    }
  }

  _decode(msg) {
    try {
      return JSON.parse(this.sc.decode(msg.data));
    } catch (err) {
      return null;
    }
  }

  async close() {
    if (this._hb) {
      clearInterval(this._hb);
      this._hb = null;
    }
    if (!this.nc) return;
    const done = this.nc.closed();
    try {
      await this.nc.drain();
    } catch (_) {
      try {
        await this.nc.close();
      } catch (_) {
        // ignore close failures
      }
    }
    await done.catch(() => {});
    this.nc = null;
  }
}
