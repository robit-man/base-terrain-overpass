import { ui, pushToast } from './ui.js';

const NETWORKS = {
  NOCLIP: 'noclip',
  HYDRA: 'hydra'
};

const DEFAULT_SERVERS = ['wss://demo.nats.io:8443'];
const DEFAULT_HEARTBEAT_SEC = 12;

const makeScopedKey = (network, pub) => `${network}:${pub}`;

class EventHub {
  constructor() {
    this.handlers = new Map();
  }

  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
  }

  emit(evt, data) {
    const list = this.handlers.get(evt);
    if (!list) return;
    list.forEach((fn) => {
      try {
        fn(data);
      } catch (err) {
        // ignore handler errors
      }
    });
  }
}

export class HybridHub {
  constructor({ mesh }) {
    this.mesh = mesh;
    this.state = {
      network: NETWORKS.NOCLIP,
      selectedKey: null,
      hydra: {
        discovery: null,
        peers: new Map(),
        connecting: false
      },
      noclip: {
        peers: new Map()
      },
      chat: new Map()
    };
    this._disposers = [];
    this._uiBound = false;
  }

  init() {
    if (this._uiBound) return;
    this._uiBound = true;
    ui.hybridNetworkButtons?.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const next = btn.dataset?.hybridNetwork === 'hydra' ? NETWORKS.HYDRA : NETWORKS.NOCLIP;
        this.setNetwork(next);
      });
    });
    if (ui.hybridChatSend) {
      ui.hybridChatSend.addEventListener('click', (e) => {
        e.preventDefault();
        this.sendChat();
      });
    }
    if (ui.hybridChatInput) {
      ui.hybridChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.sendChat();
        }
      });
    }
    if (ui.hybridPeerList) {
      ui.hybridPeerList.addEventListener('click', (event) => {
        const target = event.target.closest('[data-peer-key]');
        if (!target) return;
        const key = target.dataset.peerKey;
        this.setActivePeer(key);
      });
    }

    if (this.mesh?.on) {
      this._disposers.push(this.mesh.on('noclip-peer', (data) => this._handleNoclipPeer(data?.peer)));
      this._disposers.push(this.mesh.on('noclip-chat', (data) => this._handleNoclipChat(data)));
    }

    // seed with current peers
    this._primeNoclipPeers();
    this.setNetwork(this.state.network);
  }

  destroy() {
    this._disposers.forEach((dispose) => {
      try {
        dispose?.();
      } catch (_) {
        // ignore
      }
    });
    this._disposers = [];
    if (this.state.hydra.discovery) {
      this.state.hydra.discovery.close().catch(() => {});
      this.state.hydra.discovery = null;
    }
  }

  _primeNoclipPeers() {
    if (!this.mesh?.peers) return;
    const entries = Array.from(this.mesh.peers.entries());
    entries.forEach(([pub, info]) => {
      this.state.noclip.peers.set(pub, {
        nknPub: pub,
        addr: info?.addr || pub,
        last: info?.lastTs || 0,
        online: this.mesh._online?.(pub) ?? false,
        meta: info?.meta || {}
      });
    });
    this.renderPeers();
  }

  async ensureHydraDiscovery() {
    if (this.state.hydra.discovery || this.state.hydra.connecting) return this.state.hydra.discovery;
    this.state.hydra.connecting = true;
    try {
      const room = sanitizeRoom();
      const discovery = new HydraDiscoveryShim({
        room,
        me: {
          nknPub: this.mesh?.selfPub || this.mesh?.selfAddr || '',
          addr: this.mesh?.selfAddr || ''
        }
      });
      await discovery.init();
      discovery.on('peer', (peer) => {
        if (!peer?.nknPub) return;
        this.state.hydra.peers.set(peer.nknPub, peer);
        if (this.state.network === NETWORKS.HYDRA) this.renderPeers();
      });
      discovery.on('dm', ({ from, msg }) => this._handleHydraChat(from, msg));
      discovery.on('status', (status) => {
        this.state.hydra.status = status;
        if (this.state.network === NETWORKS.HYDRA) this.renderPeers();
      });
      this.state.hydra.discovery = discovery;
      await discovery.start(metaIdentity(this.mesh));
      return discovery;
    } catch (err) {
      pushToast(`Hydra discovery failed: ${err?.message || err}`);
      return null;
    } finally {
      this.state.hydra.connecting = false;
    }
  }

  setNetwork(network) {
    const next = network === NETWORKS.HYDRA ? NETWORKS.HYDRA : NETWORKS.NOCLIP;
    if (this.state.network === next) {
      this.renderPeers();
      this.renderChat();
      return;
    }
    this.state.network = next;
    ui.hybridNetworkButtons?.forEach((btn) => {
      const isActive = btn.dataset?.hybridNetwork === (next === NETWORKS.HYDRA ? 'hydra' : 'noclip');
      btn.classList.toggle('is-active', isActive);
    });
    if (next === NETWORKS.HYDRA) {
      this.ensureHydraDiscovery().catch(() => {});
    }
    this.state.selectedKey = null;
    this.renderPeers();
    this.renderChat();
  }

  setActivePeer(scopedKey) {
    if (!scopedKey) return;
    this.state.selectedKey = scopedKey;
    this.renderPeers();
    this.renderChat();
  }

  _handleNoclipPeer(peer) {
    if (!peer?.pub) return;
    const pub = peer.pub.toLowerCase();
    this.state.noclip.peers.set(pub, {
      nknPub: pub,
      addr: peer.addr || pub,
      last: peer.lastTs || nowSecondsFallback(),
      online: true,
      meta: peer.meta || {}
    });
    if (this.state.network === NETWORKS.NOCLIP) this.renderPeers();
  }

  _handleNoclipChat({ from, payload }) {
    const pub = from ? from.toLowerCase() : '';
    if (!pub) return;
    const key = makeScopedKey(NETWORKS.NOCLIP, pub);
    this._appendChat(key, {
      dir: 'in',
      text: payload?.text || '',
      ts: payload?.ts || nowSecondsFallback()
    });
    if (this.state.selectedKey === key) {
      this.renderChat();
    } else {
      pushToast(`Message from ${shortPub(pub)}`);
    }
  }

  _handleHydraChat(from, msg) {
    const pub = from ? from.toLowerCase() : '';
    if (!pub) return;
    const key = makeScopedKey(NETWORKS.HYDRA, pub);
    if (msg.type === 'chat-message') {
      this._appendChat(key, {
        dir: 'in',
        text: msg.text || '',
        ts: msg.ts || nowSecondsFallback()
      });
      if (this.state.selectedKey === key) {
        this.renderChat();
      } else {
        pushToast(`Hydra message from ${shortPub(pub)}`);
      }
    }
  }

  _appendChat(scopedKey, entry) {
    if (!scopedKey) return;
    const list = this.state.chat.get(scopedKey) || [];
    list.push({
      dir: entry.dir || 'in',
      text: entry.text || '',
      ts: entry.ts || nowSecondsFallback(),
      id: entry.id || generateBridgeId()
    });
    this.state.chat.set(scopedKey, list.slice(-200));
  }

  sendChat() {
    const selected = this.state.selectedKey;
    if (!selected) {
      pushToast('Select a peer first');
      return;
    }
    const text = (ui.hybridChatInput?.value || '').trim();
    if (!text) return;
    const [network, pub] = selected.split(':');
    const ts = nowSecondsFallback();
    const id = generateBridgeId();
    if (network === NETWORKS.NOCLIP) {
      const target = pub;
      try {
        this.mesh?.discovery?.dm(target, { type: 'chat-message', text, ts, id });
        this._appendChat(selected, { dir: 'out', text, ts, id });
        this.renderChat();
      } catch (err) {
        pushToast(`Send failed: ${err?.message || err}`);
      }
    } else if (network === NETWORKS.HYDRA) {
      const discovery = this.state.hydra.discovery;
      if (!discovery) {
        pushToast('Hydra discovery offline');
        return;
      }
      discovery.dm(pub, { type: 'chat-message', text, ts, id }).catch((err) => {
        pushToast(`Hydra send failed: ${err?.message || err}`);
      });
      this._appendChat(selected, { dir: 'out', text, ts, id });
      this.renderChat();
    }
    if (ui.hybridChatInput) ui.hybridChatInput.value = '';
  }

  renderPeers() {
    if (!ui.hybridPeerList) return;
    const network = this.state.network;
    const peers = network === NETWORKS.HYDRA
      ? Array.from(this.state.hydra.peers.values())
      : Array.from(this.state.noclip.peers.values());
    peers.sort((a, b) => (b.last || 0) - (a.last || 0));
    ui.hybridPeerList.innerHTML = '';
    if (!peers.length) {
      const node = document.createElement('div');
      node.className = 'hybrid-empty';
      node.textContent = network === NETWORKS.HYDRA ? 'No Hydra peers yet.' : 'No NoClip peers online.';
      ui.hybridPeerList.appendChild(node);
      if (ui.hybridPeerSummary) ui.hybridPeerSummary.textContent = network === NETWORKS.HYDRA ? 'Hydra network idle' : 'NoClip network idle';
      return;
    }
    const frag = document.createDocumentFragment();
    peers.forEach((peer) => {
      const key = makeScopedKey(network, peer.nknPub);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'hybrid-peer';
      row.dataset.peerKey = key;
      row.classList.toggle('active', this.state.selectedKey === key);
      const label = document.createElement('div');
      label.className = 'hybrid-peer-name';
      label.textContent = displayName(peer);
      const meta = document.createElement('div');
      meta.className = 'hybrid-peer-meta';
      meta.textContent = `${peer.online ? 'Online' : 'Offline'} • ${formatLast(peer.last)}`;
      row.appendChild(label);
      row.appendChild(meta);
      frag.appendChild(row);
    });
    ui.hybridPeerList.appendChild(frag);
    if (ui.hybridPeerSummary) ui.hybridPeerSummary.textContent = `${peers.length} peer${peers.length === 1 ? '' : 's'} • ${network === NETWORKS.HYDRA ? 'Hydra' : 'NoClip'}`;
  }

  renderChat() {
    if (!ui.hybridChatPeer || !ui.hybridChatLog || !ui.hybridChatStatus) return;
    const key = this.state.selectedKey;
    if (!key) {
      ui.hybridChatPeer.textContent = 'Select a peer…';
      ui.hybridChatStatus.textContent = this.state.network === NETWORKS.HYDRA ? 'Hydra bridge idle' : 'Ready';
      ui.hybridChatLog.innerHTML = '';
      if (ui.hybridChatInput) ui.hybridChatInput.disabled = true;
      if (ui.hybridChatSend) ui.hybridChatSend.disabled = true;
      return;
    }
    const [network, pub] = key.split(':');
    const peer = network === NETWORKS.HYDRA
      ? this.state.hydra.peers.get(pub)
      : this.state.noclip.peers.get(pub);
    ui.hybridChatPeer.textContent = peer ? displayName(peer) : shortPub(pub);
    ui.hybridChatStatus.textContent = network === NETWORKS.HYDRA ? 'Hydra bridge' : 'NoClip link';
    const history = this.state.chat.get(key) || [];
    ui.hybridChatLog.innerHTML = '';
    const frag = document.createDocumentFragment();
    history.forEach((entry) => {
      const row = document.createElement('div');
      row.className = `hybrid-chat-row ${entry.dir === 'out' ? 'out' : 'in'}`;
      const text = document.createElement('div');
      text.className = 'hybrid-chat-text';
      text.textContent = entry.text;
      const time = document.createElement('div');
      time.className = 'hybrid-chat-time';
      time.textContent = new Date(entry.ts * 1000).toLocaleTimeString();
      row.appendChild(text);
      row.appendChild(time);
      frag.appendChild(row);
    });
    ui.hybridChatLog.appendChild(frag);
    ui.hybridChatLog.scrollTop = ui.hybridChatLog.scrollHeight;
    if (ui.hybridChatInput) ui.hybridChatInput.disabled = false;
    if (ui.hybridChatSend) ui.hybridChatSend.disabled = false;
  }
}

// --- helpers ---

function nowSecondsFallback() {
  return Math.floor(Date.now() / 1000);
}

function displayName(peer) {
  const name = peer?.meta?.username;
  if (name && typeof name === 'string') return name;
  return shortPub(peer?.nknPub || peer?.addr || 'unknown');
}

function shortPub(pub) {
  if (!pub) return 'unknown';
  const text = String(pub);
  if (text.length <= 12) return text;
  return `${text.slice(0, 6)}…${text.slice(-4)}`;
}

function sanitizeRoom() {
  return 'hybrid-bridge';
}

function formatLast(last) {
  if (!last) return 'unknown';
  const delta = nowSecondsFallback() - last;
  if (delta < 15) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

function metaIdentity(mesh) {
  return {
    username: mesh?.displayName || '',
    network: 'noclip'
  };
}

function generateBridgeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class HydraDiscoveryShim {
  constructor({ room, me }) {
    this.room = room;
    this.me = me || {};
    this.discovery = null;
    this.handlers = new Map();
  }

  async init() {
    const discovery = new HydraDiscovery({
      room: this.room,
      me: this.me
    });
    await discovery.connect();
    this.discovery = discovery;
    discovery.on('peer', (peer) => this.emit('peer', peer));
    discovery.on('dm', (evt) => this.emit('dm', evt));
    discovery.on('status', (status) => this.emit('status', status));
  }

  async start(meta) {
    if (!this.discovery) throw new Error('not connected');
    await this.discovery.startHeartbeat(meta);
  }

  dm(pub, payload) {
    return this.discovery?.dm(pub, payload);
  }

  on(evt, fn) {
    if (!this.handlers.has(evt)) this.handlers.set(evt, new Set());
    this.handlers.get(evt).add(fn);
  }

  emit(evt, data) {
    const list = this.handlers.get(evt);
    if (!list) return;
    list.forEach((fn) => {
      try {
        fn(data);
      } catch (_) {
        // ignore
      }
    });
  }

  close() {
    return this.discovery?.close?.();
  }
}

class HydraDiscovery extends EventHub {
  constructor({ room, me } = {}) {
    super();
    this.room = sanitizeRoomName(room);
    this.me = { ...(me || {}) };
    if (!this.me.nknPub) {
      this.me.nknPub = `hydra-${Math.random().toString(36).slice(2, 10)}`;
    }
    this.servers = DEFAULT_SERVERS;
    this.heartbeatSec = DEFAULT_HEARTBEAT_SEC;
    this.nc = null;
    this.sc = null;
    this._hb = null;
    this.presenceSubject = `hydra.${this.room}.presence`;
    this.dmSubject = (pub) => `hydra.${this.room}.dm.${pub}`;
  }

  async connect() {
    if (this.nc) return this;
    const { connect, StringCodec } = await loadNats();
    this.nc = await connect({ servers: this.servers });
    this.sc = StringCodec();

    const presenceSub = await this.nc.subscribe(this.presenceSubject);
    (async () => {
      for await (const msg of presenceSub) {
        const payload = this._decode(msg);
        if (!payload || payload.type !== 'presence') continue;
        if (payload.pub === this.me.nknPub) continue;
        this.emit('peer', {
          nknPub: payload.pub,
          addr: payload.addr || payload.pub,
          meta: payload.meta || {},
          last: payload.ts || nowSecondsFallback()
        });
      }
    })();

    const dmSub = await this.nc.subscribe(this.dmSubject(this.me.nknPub || ''));
    (async () => {
      for await (const msg of dmSub) {
        const payload = this._decode(msg);
        if (!payload || !payload.type) continue;
        if (payload.pub === this.me.nknPub) continue;
        this.emit('dm', { from: payload.pub, msg: payload });
      }
    })();

    return this;
  }

  async startHeartbeat(meta = {}) {
    await this.presence(meta);
    if (this._hb) clearInterval(this._hb);
    this._hb = setInterval(() => {
      this.presence(meta).catch(() => {});
    }, this.heartbeatSec * 1000);
  }

  presence(meta = {}) {
    if (!this.nc) return Promise.reject(new Error('not connected'));
    const payload = {
      type: 'presence',
      pub: this.me.nknPub,
      addr: this.me.addr || this.me.nknPub,
      meta,
      ts: nowSecondsFallback()
    };
    this.nc.publish(this.presenceSubject, this._encode(payload));
    return Promise.resolve();
  }

  dm(pub, payload) {
    if (!this.nc) return Promise.reject(new Error('not connected'));
    const msg = {
      ...(payload || {}),
      pub: this.me.nknPub,
      addr: this.me.addr || this.me.nknPub,
      ts: nowSecondsFallback()
    };
    this.nc.publish(this.dmSubject(pub), this._encode(msg));
    return Promise.resolve();
  }

  _encode(obj) {
    try {
      return this.sc.encode(JSON.stringify(obj));
    } catch (_) {
      return this.sc.encode('{}');
    }
  }

  _decode(msg) {
    try {
      return JSON.parse(this.sc.decode(msg.data));
    } catch (_) {
      return null;
    }
  }

  async close() {
    if (this._hb) clearInterval(this._hb);
    if (!this.nc) return;
    const done = this.nc.closed();
    try {
      await this.nc.drain();
    } catch (_) {
      await this.nc.close().catch(() => {});
    }
    await done.catch(() => {});
    this.nc = null;
  }
}

function sanitizeRoomName(value) {
  const raw = String(value || 'default');
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '_');
}

async function loadNats() {
  return import('nats.ws');
}
