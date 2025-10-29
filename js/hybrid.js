import * as THREE from 'three';
import { ui, pushToast } from './ui.js';
import { latLonToWorld } from './geolocate.js';

const NETWORKS = {
  NOCLIP: 'noclip',
  HYDRA: 'hydra'
};

const DEFAULT_SERVERS = ['wss://demo.nats.io:8443'];
const DEFAULT_HEARTBEAT_SEC = 12;
const SESSION_STORAGE_KEY = 'noclip.hydra.sessions.v1';

const makeScopedKey = (network, pub) => `${network}:${pub}`;

const normalizeHex64 = (value) => {
  if (!value) return '';
  const text = typeof value === 'string' ? value : String(value);
  const match = text.match(/([0-9a-f]{64})$/i);
  return match ? match[1].toLowerCase() : '';
};

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
    this.app = mesh?.app || null;
    this.state = {
      network: NETWORKS.NOCLIP,
      selectedKey: null,
      rawMessageView: false,
      rawMessages: [],
      rawFilter: '',
      hydra: {
        discovery: null,
        peers: new Map(),
        connecting: false
      },
      noclip: {
      peers: new Map()
    },
    chat: new Map(),
    sessions: new Map()
  };
  this._disposers = [];
  this._uiBound = false;
  this.resources = new Map();
  this.resourceLayer = null;
  this._stateTimer = null;
  this._sessionIndexByObject = new Map();
  this._pendingSessionBindings = new Set();
  this._sessionBindTimer = null;
  this._loadSessions();
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

    // View toggle buttons
    const viewButtons = document.querySelectorAll('[data-hybrid-view]');
    viewButtons.forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        const view = btn.dataset.hybridView;
        this.setMessageView(view);
      });
    });

    // Raw message filter
    const rawFilter = document.getElementById('hybridRawFilter');
    if (rawFilter) {
      rawFilter.addEventListener('change', (e) => {
        this.state.rawFilter = e.target.value;
        this.renderRawMessages();
      });
    }

    // Clear raw messages
    const rawClear = document.getElementById('hybridRawClear');
    if (rawClear) {
      rawClear.addEventListener('click', (e) => {
        e.preventDefault();
        this.state.rawMessages = [];
        this.renderRawMessages();
      });
    }

    if (this.mesh?.on) {
      this._disposers.push(this.mesh.on('noclip-peer', (data) => this._handleNoclipPeer(data?.peer)));
      this._disposers.push(this.mesh.on('noclip-chat', (data) => this._handleNoclipChat(data)));
      this._disposers.push(this.mesh.on('noclip-bridge', (data) => this._handleBridgeEvent(data)));
      this._disposers.push(this.mesh.on('hybrid-peer', (data) => this._handleHydraPeer(data?.peer)));
    }

    // seed with current peers
    this._primeNoclipPeers();
    this._ensureResourceLayer();
    this.setNetwork(this.state.network);

    // Check for ?peer= parameter and auto-connect
    this._connectToPeerFromUrl();
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
    if (this._stateTimer) {
      clearTimeout(this._stateTimer);
      this._stateTimer = null;
    }
    this._clearResources();
    if (this.state.hydra.discovery) {
      this.state.hydra.discovery.close().catch(() => {});
      this.state.hydra.discovery = null;
    }
  }

  _primeNoclipPeers() {
    if (!this.mesh?.peers) return;
    const selfPub = (this.mesh?.selfPub || this.mesh?.selfAddr || '').toLowerCase();
    const entries = Array.from(this.mesh.peers.entries());
    entries.forEach(([pub, info]) => {
      // Filter out self
      if (pub.toLowerCase() === selfPub) return;

      const loc = info?.meta?.loc;
      const geo = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
        ? { lat: Number(loc.lat), lon: Number(loc.lon), gh: loc.gh, radius: loc.radius }
        : null;

      // Add network prefix to identify as NoClip peer
      const addrWithPrefix = `noclip.${pub}`;

      this.state.noclip.peers.set(pub, {
        nknPub: pub,
        addr: addrWithPrefix,
        last: info?.lastTs || 0,
        online: this.mesh._online?.(pub) ?? false,
        meta: { ...info?.meta, network: 'noclip' } || { network: 'noclip' },
        geo
      });
    });
    this.renderPeers();
    this._markStateDirty();
  }

  _consumePeerParam() {
    try {
      const url = new URL(window.location.href);

      // Check for ?noclip= param (new format: noclip.<hex>)
      let noclipValue = url.searchParams.get('noclip');
      if (noclipValue) {
        const parts = noclipValue.split('.');
        const hex = parts.length === 2 && parts[0] === 'noclip' ? parts[1] : noclipValue;
        const hexLower = hex.toLowerCase();

        if (/^[0-9a-f]{64}$/i.test(hexLower)) {
          url.searchParams.delete('noclip');
          const newUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;
          try {
            window.history.replaceState({}, document.title, newUrl);
          } catch (err) {
            console.warn('[hybrid] Failed to update URL:', err);
          }

          return {
            type: 'noclip',
            prefix: 'noclip',
            pub: hexLower,
            addr: `noclip.${hexLower}`
          };
        }
      }

      // Check for ?hydra= param (new format: hydra.<hex>)
      let hydraValue = url.searchParams.get('hydra');
      if (hydraValue) {
        const parts = hydraValue.split('.');
        const hex = parts.length === 2 && parts[0] === 'hydra' ? parts[1] : hydraValue;
        const hexLower = hex.toLowerCase();

        if (/^[0-9a-f]{64}$/i.test(hexLower)) {
          url.searchParams.delete('hydra');
          const newUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;
          try {
            window.history.replaceState({}, document.title, newUrl);
          } catch (err) {
            console.warn('[hybrid] Failed to update URL:', err);
          }

          return {
            type: 'hydra',
            prefix: 'hydra',
            pub: hexLower,
            addr: `hydra.${hexLower}`,
            requiresConfirmation: true // Hydra connections need user approval
          };
        }
      }

      // Fallback: Legacy ?peer= param for backwards compatibility
      const peerParam = url.searchParams.get('peer');
      if (!peerParam) return null;

      // Format: <prefix>.<hex64> or just <hex64>
      const parts = peerParam.split('.');
      let prefix = '';
      let hex = '';

      if (parts.length === 2) {
        // Format: prefix.hex
        prefix = parts[0];
        hex = parts[1];
      } else if (parts.length === 1) {
        // Format: hex (no prefix)
        hex = parts[0];
      } else {
        console.warn('[hybrid] Invalid peer parameter format:', peerParam);
        return null;
      }

      // Validate hex (must be 64 hex characters)
      const hexLower = hex.toLowerCase();
      if (!/^[0-9a-f]{64}$/i.test(hexLower)) {
        console.warn('[hybrid] Invalid peer hex:', hex);
        return null;
      }

      // Sanitize prefix (alphanumeric, dash, underscore only)
      const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, '').slice(0, 32);

      // Remove peer parameter from URL
      url.searchParams.delete('peer');
      const newUrl = url.pathname + (url.searchParams.toString() ? `?${url.searchParams.toString()}` : '') + url.hash;

      try {
        window.history.replaceState({}, document.title, newUrl);
      } catch (err) {
        console.warn('[hybrid] Failed to update URL:', err);
      }

      return {
        type: 'legacy',
        prefix: safePrefix || 'peer',
        pub: hexLower,
        addr: safePrefix ? `${safePrefix}.${hexLower}` : hexLower
      };

    } catch (err) {
      console.warn('[hybrid] Error parsing peer parameter:', err);
      return null;
    }
  }

  async _confirmHydraConnection(peer) {
    return new Promise((resolve) => {
      // Create a simple confirmation using browser's built-in confirm for now
      // TODO: Replace with a proper modal UI similar to Hydra's workspace sync modal
      const message = `A Hydra graph instance wants to connect:\n\n` +
        `Address: ${peer.addr}\n` +
        `Pub Key: ${peer.pub.slice(0, 16)}...\n\n` +
        `This will allow the Hydra instance to:\n` +
        `• Receive your position and scene state\n` +
        `• Send resources and commands to your scene\n` +
        `• Exchange data bi-directionally\n\n` +
        `Accept this connection?`;

      const confirmed = confirm(message);
      resolve(confirmed);
    });
  }

  async _connectToPeerFromUrl() {
    const peer = this._consumePeerParam();
    if (!peer) return;

    console.log('[hybrid] Connecting to peer from URL:', peer.type, peer.prefix);

    try {
      if (peer.type === 'hydra') {
        // Hydra peer detected - show confirmation modal
        const confirmed = await this._confirmHydraConnection(peer);
        if (!confirmed) {
          pushToast('Connection cancelled');
          return;
        }

        // Add to hydra peers
        this.state.hydra.peers.set(peer.pub, {
          nknPub: peer.pub,
          addr: peer.addr,
          meta: { username: peer.prefix, network: 'hydra' },
          last: nowSecondsFallback(),
          online: false,
          fromUrl: true,
          hasBridge: true,
          bridgeStatus: 'detected',
          trusted: true // Mark as trusted after user confirmation
        });

        // Switch to Hydra network
        this.setNetwork(NETWORKS.HYDRA);

        // Ensure discovery is running
        await this.ensureHydraDiscovery();

        // Auto-select the peer (this will trigger handshake)
        const key = makeScopedKey(NETWORKS.HYDRA, peer.pub);
        await this.setActivePeer(key);

        pushToast(`Connecting to Hydra peer ${peer.pub.slice(0, 8)}...`);

      } else if (peer.type === 'noclip') {
        // NoClip peer - direct connection to another NoClip instance
        // (Current behavior - auto-connect)
        pushToast(`NoClip peer detected: ${peer.pub.slice(0, 8)}...`);
        // NoClip-to-NoClip connections handled by mesh peer discovery

      } else {
        // Legacy peer param - treat as Hydra for backwards compatibility
        this.state.hydra.peers.set(peer.pub, {
          nknPub: peer.pub,
          addr: peer.addr,
          meta: { username: peer.prefix },
          last: nowSecondsFallback(),
          online: false,
          fromUrl: true,
          hasBridge: true,
          bridgeStatus: 'detected'
        });

        this.setNetwork(NETWORKS.HYDRA);
        await this.ensureHydraDiscovery();

        const key = makeScopedKey(NETWORKS.HYDRA, peer.pub);
        await this.setActivePeer(key);

        pushToast(`Connecting to ${peer.prefix}...`);
      }

    } catch (err) {
      console.error('[hybrid] Failed to connect to peer from URL:', err);
      pushToast(`Failed to connect: ${err?.message || err}`);
    }
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
        const rawPub = peer?.nknPub || '';
        const normalizedPub = normalizeHex64(rawPub) || rawPub.toLowerCase();
        if (!normalizedPub) return;

        // Filter out self
        const selfPub = normalizeHex64(this.mesh?.selfPub || this.mesh?.selfAddr || '');
        if (normalizedPub && selfPub && normalizedPub === selfPub) return;

        // Filter out NoClip peers (they should be in noclip.peers, not hydra.peers)
        if (peer.meta?.network === 'noclip') return;

        const loc = peer.meta?.loc;
        const geo = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
          ? { lat: Number(loc.lat), lon: Number(loc.lon), gh: loc.gh, radius: loc.radius }
          : null;

        // Detect bridge capability
        const hasBridge = this._detectBridgeCapability(peer.meta);

        // Add network prefix to identify as Hydra peer
        const addrWithPrefix = peer.addr || `hydra.${normalizedPub}`;

        this.state.hydra.peers.set(normalizedPub, {
          ...peer,
          nknPub: normalizedPub,
          addr: addrWithPrefix,
          geo,
          last: peer.last || nowSecondsFallback(),
          online: true,
          meta: { ...peer.meta, network: 'hydra' },
          hasBridge,
          bridgeStatus: hasBridge ? 'detected' : null
        });
        if (this.state.network === NETWORKS.HYDRA) this.renderPeers();
        this._flushState();
      });
      discovery.on('dm', ({ from, msg }) => this._handleHydraChat(from, msg));
      discovery.on('status', (status) => {
        this.state.hydra.status = status;
        if (this.state.network === NETWORKS.HYDRA) this.renderPeers();
      });
      this.state.hydra.discovery = discovery;
      await discovery.start(metaIdentity(this.mesh));
      await this._flushState();
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

  async setActivePeer(scopedKey) {
    if (!scopedKey) return;
    this.state.selectedKey = scopedKey;

    // Auto-initiate handshake for Hydra peers with bridge
    const [network, pub] = scopedKey.split(':');
    if (network === NETWORKS.HYDRA) {
      const peer = this.state.hydra.peers.get(pub);
      if (peer?.hasBridge && peer.bridgeStatus === 'detected') {
        await this._initiateHandshake(pub);
      }
    }

    this.renderPeers();
    this.renderChat();
  }

  _detectBridgeCapability(meta) {
    if (!meta || typeof meta !== 'object') return false;

    // Check for Hydra graph with bridge node indicators
    const ids = meta.ids;
    if (Array.isArray(ids)) {
      // Look for 'bridge' or 'noclip-bridge' in ids array
      if (ids.includes('bridge') || ids.includes('noclip-bridge')) {
        return true;
      }
      // Hydra peers with 'graph' capability might have bridge nodes
      if (ids.includes('hydra') && ids.includes('graph')) {
        return true; // Assume graph peers may have bridge capability
      }
    }

    // Check for explicit bridge flag
    if (meta.hasBridge === true || meta.bridge === true) {
      return true;
    }

    // Check kind field
    if (meta.kind === 'hydra' || meta.kind === 'bridge') {
      return true;
    }

    return false;
  }

  async _initiateHandshake(pub) {
    const peer = this.state.hydra.peers.get(pub);
    if (!peer) return;

    const discovery = this.state.hydra.discovery;
    if (!discovery) {
      pushToast('Hydra discovery not ready');
      return;
    }

    try {
      // Update status to connecting
      peer.bridgeStatus = 'handshaking';
      this.renderPeers();
      this._updateSessionsForHydra(pub, { status: 'handshaking' });

      // Send handshake request
      await discovery.dm(pub, {
        type: 'hybrid-bridge-handshake',
        clientType: 'noclip',
        capabilities: ['pose', 'geo', 'resources', 'scene-updates'],
        graphId: this.mesh?.selfPub || '',
        ts: nowSecondsFallback()
      });

      pushToast(`Handshake sent to ${shortPub(pub)}`);

      // Set timeout for handshake response
      setTimeout(() => {
        const currentPeer = this.state.hydra.peers.get(pub);
        if (currentPeer && currentPeer.bridgeStatus === 'handshaking') {
          currentPeer.bridgeStatus = 'timeout';
          this._updateSessionsForHydra(pub, { status: 'timeout' });
          this.renderPeers();
        }
      }, 10000); // 10 second timeout

    } catch (err) {
      peer.bridgeStatus = 'error';
      pushToast(`Handshake failed: ${err?.message || err}`);
      this.renderPeers();
      this._updateSessionsForHydra(pub, { status: 'error', errorMessage: err?.message || String(err) });
    }
  }

  _handleHandshakeResponse(pub, msg) {
    const peer = this.state.hydra.peers.get(pub);
    if (!peer) return;

    const isAck = msg.type === 'hybrid-bridge-handshake-ack';

    // Update peer capabilities
    if (msg.capabilities && Array.isArray(msg.capabilities)) {
      peer.capabilities = msg.capabilities;
    }

    if (msg.graphId) {
      peer.graphId = msg.graphId;
    }

    // Update bridge status
    peer.bridgeStatus = isAck ? 'connected' : 'handshake-received';
    peer.last = msg.ts || nowSecondsFallback();
    this._updateSessionsForHydra(pub, {
      status: isAck ? 'connected' : 'handshake-received',
      lastHandshakeAt: msg.ts || Date.now()
    });

    // Log to chat
    const key = makeScopedKey(NETWORKS.HYDRA, pub);
    this._appendChat(key, {
      dir: 'in',
      kind: 'log',
      text: isAck
        ? `Bridge connected • Capabilities: ${(msg.capabilities || []).join(', ')}`
        : `Handshake request from ${shortPub(pub)}`,
      ts: msg.ts || nowSecondsFallback(),
      meta: { handshake: msg }
    });

    this.renderPeers();
    if (this.state.selectedKey === key) {
      this.renderChat();
    }

    if (isAck) {
      pushToast(`Bridge connected to ${shortPub(pub)}`);
    }
  }

  _handleNoclipPeer(peer) {
    if (!peer?.pub) return;
    const pub = peer.pub.toLowerCase();

    // Filter out self from NoClip peers
    const selfPub = (this.mesh?.selfPub || this.mesh?.selfAddr || '').toLowerCase();
    if (pub === selfPub) return;

    const loc = peer.meta?.loc;
    const geo = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
      ? { lat: Number(loc.lat), lon: Number(loc.lon), gh: loc.gh, radius: loc.radius }
      : null;

    // Add network prefix to identify as NoClip peer
    const addrWithPrefix = `noclip.${pub}`;

    this.state.noclip.peers.set(pub, {
      nknPub: pub,
      addr: addrWithPrefix,
      last: peer.lastTs || nowSecondsFallback(),
      online: true,
      meta: { ...peer.meta, network: 'noclip' },
      geo
    });
    if (this.state.network === NETWORKS.NOCLIP) this.renderPeers();
    this._markStateDirty();
  }

  _handleHydraPeer(peer) {
    if (!peer?.pub) return;
    const pub = peer.pub.toLowerCase();

    // Filter out self
    const selfPub = (this.mesh?.selfPub || this.mesh?.selfAddr || '').toLowerCase();
    if (pub === selfPub) return;

    const loc = peer.meta?.loc;
    const geo = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
      ? { lat: Number(loc.lat), lon: Number(loc.lon), gh: loc.gh, radius: loc.radius }
      : null;

    // Add network prefix to identify as Hydra peer
    const addrWithPrefix = peer.addr || `hydra.${pub}`;

    this.state.hydra.peers.set(pub, {
      nknPub: pub,
      addr: addrWithPrefix,
      last: peer.last || nowSecondsFallback(),
      online: peer.online !== false,
      meta: { ...peer.meta, network: 'hydra' },
      geo,
      type: 'hydra'
    });

    if (this.state.network === NETWORKS.HYDRA) this.renderPeers();
    this._markStateDirty();

    console.log('[HybridHub] Hydra peer discovered via NATS:', pub, addrWithPrefix);
  }

  _logRawMessage(from, msg, network) {
    if (!msg || typeof msg !== 'object') return;

    const entry = {
      id: generateBridgeId(),
      from: from ? from.toLowerCase() : 'unknown',
      network: network || NETWORKS.HYDRA,
      type: msg.type || 'unknown',
      timestamp: Date.now(),
      payload: msg,
      size: JSON.stringify(msg).length
    };

    this.state.rawMessages.push(entry);

    // Keep only last 100 messages
    if (this.state.rawMessages.length > 100) {
      this.state.rawMessages = this.state.rawMessages.slice(-100);
    }

    if (this.state.rawMessageView) {
      this.renderRawMessages();
    }
  }

  _ensureHydraPeerRecord(pub, session = null) {
    const normalized = normalizeHex64(pub);
    if (!normalized) return null;
    let peer = this.state.hydra.peers.get(normalized);
    if (!peer) {
      peer = {
        nknPub: normalized,
        addr: session?.hydraAddr || `hydra.${normalized}`,
        last: nowSecondsFallback(),
        online: true,
        meta: { network: 'hydra', ids: ['hydra', 'bridge'] },
        hasBridge: true,
        bridgeStatus: 'detected'
      };
      this.state.hydra.peers.set(normalized, peer);
    } else {
      peer.hasBridge = true;
      if (!peer.addr) peer.addr = session?.hydraAddr || peer.addr || `hydra.${normalized}`;
      if (!peer.meta) peer.meta = { network: 'hydra', ids: ['hydra', 'bridge'] };
    }
    return peer;
  }

  _normalizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
    const objectUuid = typeof raw.objectUuid === 'string' ? raw.objectUuid.trim() : '';
    const noclipPub = normalizeHex64(raw.noclipPub || raw.noclipAddr || raw.from);
    if (!sessionId || !objectUuid || !noclipPub) return null;
    const now = Date.now();
    const latVal = Number(raw.lat);
    const lonVal = Number(raw.lon ?? raw.lng);
    const position = raw.position && typeof raw.position === 'object' ? { ...raw.position } : null;
    const geo = raw.geo && typeof raw.geo === 'object' ? { ...raw.geo } : null;
    const record = {
      sessionId,
      objectUuid,
      objectLabel: typeof raw.objectLabel === 'string' ? raw.objectLabel : '',
      noclipPub,
      noclipAddr: typeof raw.noclipAddr === 'string' ? raw.noclipAddr : `noclip.${noclipPub}`,
      hydraBridgeNodeId: typeof raw.hydraBridgeNodeId === 'string' ? raw.hydraBridgeNodeId : '',
      hydraGraphId: typeof raw.hydraGraphId === 'string' ? raw.hydraGraphId : '',
      hydraPub: normalizeHex64(raw.hydraPub),
      hydraAddr: typeof raw.hydraAddr === 'string' ? raw.hydraAddr : '',
      bridgeNodeId: typeof raw.bridgeNodeId === 'string' ? raw.bridgeNodeId : '',
      status: typeof raw.status === 'string' ? raw.status : 'pending-handshake',
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : now,
      updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now
    };
    if (typeof raw.rejectionReason === 'string') record.rejectionReason = raw.rejectionReason;
    if (Number.isFinite(latVal)) record.lat = latVal;
    if (Number.isFinite(lonVal)) record.lon = lonVal;
    if (position) record.position = position;
    if (geo) record.geo = geo;
    return record;
  }

  _saveSessions() {
    if (typeof localStorage === 'undefined') return;
    try {
      const list = Array.from(this.state.sessions.values());
      localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(list));
    } catch (err) {
      console.warn('[HybridHub] Failed to save sessions:', err);
    }
  }

  _loadSessions() {
    if (!this.state.sessions) this.state.sessions = new Map();
    else this.state.sessions.clear();
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(SESSION_STORAGE_KEY);
        if (raw) {
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            arr.forEach((entry) => {
              const normalized = this._normalizeSession(entry);
              if (normalized) this.state.sessions.set(normalized.sessionId, normalized);
            });
          }
        }
      } catch (err) {
        console.warn('[HybridHub] Failed to load sessions:', err);
      }
    }
    this._rebuildSessionIndex();
    this._scheduleSessionRebind(0);
  }

  _rebuildSessionIndex() {
    this._sessionIndexByObject.clear();
    this.state.sessions.forEach((session) => {
      if (!session?.objectUuid) return;
      const list = this._sessionIndexByObject.get(session.objectUuid) || new Set();
      list.add(session.sessionId);
      this._sessionIndexByObject.set(session.objectUuid, list);
    });
  }

  _scheduleSessionRebind(delay = 400) {
    if (this._sessionBindTimer) return;
    this._sessionBindTimer = setTimeout(() => {
      this._sessionBindTimer = null;
      this._rebindSessionsToObjects();
    }, Math.max(0, delay));
  }

  _rebindSessionsToObjects() {
    if (!this.sceneMgr?.smartObjects) {
      if (this.state.sessions.size) this._scheduleSessionRebind(800);
      return;
    }
    this.state.sessions.forEach((session) => {
      this._bindSessionToObject(session);
    });
  }

  _bindSessionToObject(session) {
    if (!session || !session.objectUuid) return false;
    if (!this.sceneMgr?.smartObjects) {
      this._pendingSessionBindings.add(session.sessionId);
      this._scheduleSessionRebind(800);
      return false;
    }
    const attached = this.sceneMgr.smartObjects.attachSession(session.objectUuid, session);
    if (!attached) {
      this._pendingSessionBindings.add(session.sessionId);
      this._scheduleSessionRebind(800);
      return false;
    }
    this._pendingSessionBindings.delete(session.sessionId);
    return true;
  }

  _sessionsForObject(uuid) {
    if (!uuid) return [];
    const index = this._sessionIndexByObject.get(uuid);
    if (!index || !index.size) return [];
    return Array.from(index).map((sessionId) => this.state.sessions.get(sessionId)).filter(Boolean);
  }

  _sessionsForHydra(pub) {
    const normalized = normalizeHex64(pub);
    if (!normalized) return [];
    return Array.from(this.state.sessions.values()).filter((session) => session.hydraPub === normalized);
  }

  _upsertSession(raw) {
    const normalized = this._normalizeSession(raw);
    if (!normalized) return null;
    const existing = this.state.sessions.get(normalized.sessionId) || {};
    const merged = {
      ...existing,
      ...normalized,
      updatedAt: Date.now()
    };
    this.state.sessions.set(merged.sessionId, merged);
    this._rebuildSessionIndex();
    this._saveSessions();
    this._bindSessionToObject(merged);
    this._markStateDirty();
    return merged;
  }

  _updateSessionsForHydra(pub, updates = {}) {
    const sessions = this._sessionsForHydra(pub);
    sessions.forEach((session) => {
      this._upsertSession({
        ...session,
        ...updates,
        sessionId: session.sessionId
      });
    });
    return sessions.length;
  }

  _sendBridgeAck(pub, messageId, status = 'ok', detail = '', extras = {}) {
    if (!messageId) return;
    const discovery = this.state.hydra.discovery;
    if (!discovery) return;
    const packet = {
      type: 'hybrid-bridge-ack',
      inReplyTo: messageId,
      status,
      ...(detail ? { detail } : {}),
      ...extras,
      ts: nowSecondsFallback()
    };
    discovery.dm(pub, packet).catch((err) => {
      console.error('[Hybrid] Failed to send bridge ack:', err);
    });
  }

  _handleSmartObjectStateMessage(from, payload) {
    const sessionId = payload.sessionId || payload.session?.sessionId || null;
    const objectUuid = payload.objectUuid || payload.objectId;
    if (!objectUuid) {
      return { status: 'error', detail: 'objectUuid missing', sessionId };
    }
    const manager = this.sceneMgr?.smartObjects;
    if (!manager) {
      return { status: 'error', detail: 'SmartObjectManager unavailable', sessionId, objectUuid };
    }
    const updates = {};
    if (payload.position) updates.position = payload.position;
    if (payload.state?.position && !updates.position) updates.position = payload.state.position;
    if (payload.state?.mesh || payload.mesh) updates.mesh = payload.state?.mesh || payload.mesh;
    if (payload.state?.sources) updates.sources = payload.state.sources;
    if (payload.state?.audioInput) updates.audioInput = payload.state.audioInput;
    if (payload.state?.visibility) updates.visibility = payload.state.visibility;

    const ok = manager.updateSmartObject(objectUuid, updates);
    if (!ok) {
      return { status: 'error', detail: `Smart object ${objectUuid} not found`, sessionId, objectUuid };
    }

    const sessionPatch = {
      ...(payload.session || {}),
      sessionId,
      status: payload.status || payload.session?.status || 'updated',
      position: payload.position || updates.position || undefined,
      capabilities: payload.capabilities || undefined,
      metadata: payload.metadata || undefined
    };
    if (sessionPatch.sessionId) {
      manager.attachSession(objectUuid, sessionPatch);
    }

    return { status: 'ok', detail: 'Smart object state applied', sessionId, objectUuid };
  }

  _handleDecisionResultMessage(from, payload) {
    const sessionId = payload.sessionId || payload.session?.sessionId || null;
    const objectUuid = payload.objectUuid || payload.objectId;
    if (!objectUuid) {
      return { status: 'error', detail: 'objectUuid missing', sessionId };
    }
    const manager = this.sceneMgr?.smartObjects;
    if (!manager) {
      return { status: 'error', detail: 'SmartObjectManager unavailable', sessionId, objectUuid };
    }
    const sessionPatch = {
      ...(payload.session || {}),
      sessionId,
      status: payload.status || payload.session?.status || 'decision',
      decision: payload.decision || payload.result || payload
    };
    if (sessionPatch.sessionId) {
      manager.attachSession(objectUuid, sessionPatch);
    }
    const key = makeScopedKey(NETWORKS.HYDRA, from);
    this._appendChat(key, {
      dir: 'in',
      kind: 'log',
      text: `Decision result for ${objectUuid}`,
      meta: { decision: payload },
      ts: payload.ts || nowSecondsFallback()
    });
    return { status: 'ok', detail: 'Decision result recorded', sessionId, objectUuid };
  }

  _handleGraphQueryMessage(from, payload) {
    const queryId = payload.queryId || payload.messageId || '';
    const sessionId = payload.sessionId || null;
    const key = makeScopedKey(NETWORKS.HYDRA, from);
    this._appendChat(key, {
      dir: 'in',
      kind: 'log',
      text: `Graph query received (${queryId || 'n/a'})`,
      meta: { query: payload },
      ts: payload.ts || nowSecondsFallback()
    });
    return { status: 'error', detail: 'graph-query handling not implemented', sessionId, queryId };
  }

  _handleGraphResponseMessage(from, payload) {
    const queryId = payload.queryId || payload.messageId || '';
    const sessionId = payload.sessionId || null;
    const key = makeScopedKey(NETWORKS.HYDRA, from);
    this._appendChat(key, {
      dir: 'in',
      kind: 'log',
      text: `Graph response received (${queryId || 'n/a'})`,
      meta: { response: payload },
      ts: payload.ts || nowSecondsFallback()
    });
    return { status: 'ok', detail: 'Graph response logged', sessionId, queryId };
  }

  onSmartObjectCreated(smartObject) {
    if (!smartObject) return;
    const uuid = smartObject.uuid || smartObject.config?.uuid;
    if (!uuid) return;
    const sessions = this._sessionsForObject(uuid);
    if (!sessions.length) return;
    sessions.forEach((session) => this._bindSessionToObject(session));
  }

  onSmartObjectSessionUpdate(smartObject) {
    if (!smartObject) return;
    if (this.sceneMgr?.smartModal?.updateSessionStatus) {
      this.sceneMgr.smartModal.updateSessionStatus(smartObject);
    }
  }

  _handleNoclipChat({ from, payload }) {
    const pub = from ? from.toLowerCase() : '';
    if (!pub) return;

    // Log raw message
    this._logRawMessage(from, payload, NETWORKS.NOCLIP);

    const key = makeScopedKey(NETWORKS.NOCLIP, pub);
    this._appendChat(key, {
      dir: 'in',
      text: payload?.text || '',
      ts: payload?.ts || nowSecondsFallback(),
      kind: 'chat'
    });
    if (this.state.selectedKey === key) {
      this.renderChat();
    } else {
      pushToast(`Message from ${shortPub(pub)}`);
    }
  }

  _handleHydraChat(from, msg) {
    const pub = from ? from.toLowerCase() : '';
    if (!pub || !msg || typeof msg !== 'object') return;

    // Log raw message
    this._logRawMessage(from, msg, NETWORKS.HYDRA);

    // Handle handshake responses
    if (msg.type === 'hybrid-bridge-handshake' || msg.type === 'hybrid-bridge-handshake-ack') {
      this._handleHandshakeResponse(pub, msg);
      return;
    }

    if (typeof msg.type === 'string' && msg.type.startsWith('hybrid-')) return;
    const key = makeScopedKey(NETWORKS.HYDRA, pub);
    if (msg.type === 'chat-message') {
      const peerRecord = this.state.hydra.peers.get(pub);
      if (peerRecord) peerRecord.last = msg.ts || nowSecondsFallback();
      this._appendChat(key, {
        dir: 'in',
        text: msg.text || '',
        ts: msg.ts || nowSecondsFallback(),
        kind: 'chat'
      });
      if (this.state.selectedKey === key) {
        this.renderChat();
      } else {
        pushToast(`Hydra message from ${shortPub(pub)}`);
      }
      if (this.state.network === NETWORKS.HYDRA) this.renderPeers();
    }
  }

  _appendChat(scopedKey, entry) {
    if (!scopedKey) return;
    const list = this.state.chat.get(scopedKey) || [];
    list.push({
      dir: entry.dir || 'in',
      text: entry.text || '',
      ts: entry.ts || nowSecondsFallback(),
      id: entry.id || generateBridgeId(),
      kind: entry.kind || 'chat',
      meta: entry.meta || null
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
        this._appendChat(selected, { dir: 'out', text, ts, id, kind: 'chat' });
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
      this._appendChat(selected, { dir: 'out', text, ts, id, kind: 'chat' });
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

      // Add bridge indicator for Hydra peers
      if (network === NETWORKS.HYDRA && peer.hasBridge) {
        const badge = document.createElement('span');
        badge.className = 'hybrid-peer-badge';
        badge.dataset.bridgeStatus = peer.bridgeStatus || 'detected';
        badge.textContent = getBridgeStatusIcon(peer.bridgeStatus);
        badge.title = getBridgeStatusText(peer.bridgeStatus);
        row.appendChild(badge);
      }

      const label = document.createElement('div');
      label.className = 'hybrid-peer-name';
      label.textContent = displayName(peer);
      const meta = document.createElement('div');
      meta.className = 'hybrid-peer-meta';
      const parts = [peer.online ? 'Online' : 'Offline', `Last ${formatLast(peer.last)}`];

      // Show bridge status
      if (network === NETWORKS.HYDRA && peer.hasBridge && peer.bridgeStatus) {
        parts.push(`Bridge: ${peer.bridgeStatus}`);
      }

      if (peer.geo && Number.isFinite(peer.geo.lat) && Number.isFinite(peer.geo.lon)) {
        if (typeof peer.geo.gh === 'string') parts.push(`gh ${peer.geo.gh.slice(0, 8)}`);
        else parts.push(`${peer.geo.lat.toFixed(4)}, ${peer.geo.lon.toFixed(4)}`);
      }
      meta.textContent = parts.join(' • ');
      row.appendChild(label);
      row.appendChild(meta);
      if (network === NETWORKS.HYDRA) {
        const sessions = this._sessionsForHydra(peer.nknPub);
        if (sessions.length) {
          const sessionMeta = document.createElement('div');
          sessionMeta.className = 'hybrid-peer-meta';
          sessionMeta.textContent = sessions
            .map((session) => {
              const labelText = session.objectLabel || session.objectUuid || session.sessionId;
              const statusText = (session.status || 'pending').replace(/[_-]/g, ' ');
              return `${labelText}: ${statusText}`;
            })
            .join(' • ');
          row.appendChild(sessionMeta);
        }
      }
      frag.appendChild(row);
    });
    ui.hybridPeerList.appendChild(frag);
    if (ui.hybridPeerSummary) ui.hybridPeerSummary.textContent = `${peers.length} peer${peers.length === 1 ? '' : 's'} • ${network === NETWORKS.HYDRA ? 'Hydra' : 'NoClip'}`;
  }

  _handleBridgeEvent(evt) {
    const from = evt?.from ? evt.from.toLowerCase() : '';
    const payload = evt?.payload;
    if (!from || !payload || typeof payload !== 'object') return;

    // Log raw message
    this._logRawMessage(from, payload, NETWORKS.HYDRA);

    const type = payload.type || '';
    const peerRecord = this.state.hydra.peers.get(from);
    if (peerRecord) peerRecord.last = payload.ts || nowSecondsFallback();
    if (this.state.network === NETWORKS.HYDRA) this.renderPeers();
    if (type === 'smart-object-state') {
      const result = this._handleSmartObjectStateMessage(from, payload);
      if (payload.messageId) {
        const extras = {};
        const sessionRef = result.sessionId || payload.sessionId || payload.session?.sessionId;
        if (sessionRef) extras.sessionId = sessionRef;
        const objectRef = result.objectUuid || payload.objectUuid || payload.objectId;
        if (objectRef) extras.objectUuid = objectRef;
        this._sendBridgeAck(from, payload.messageId, result.status, result.detail, extras);
      }
      return;
    }
    if (type === 'decision-result') {
      const result = this._handleDecisionResultMessage(from, payload);
      if (payload.messageId) {
        const extras = {};
        const sessionRef = result.sessionId || payload.sessionId || payload.session?.sessionId;
        if (sessionRef) extras.sessionId = sessionRef;
        const objectRef = result.objectUuid || payload.objectUuid || payload.objectId;
        if (objectRef) extras.objectUuid = objectRef;
        this._sendBridgeAck(from, payload.messageId, result.status, result.detail, extras);
      }
      return;
    }
    if (type === 'graph-query') {
      const result = this._handleGraphQueryMessage(from, payload);
      if (payload.messageId) {
        const extras = {};
        const sessionRef = result.sessionId || payload.sessionId || payload.session?.sessionId;
        if (sessionRef) extras.sessionId = sessionRef;
        const queryRef = result.queryId || payload.queryId;
        if (queryRef) extras.queryId = queryRef;
        this._sendBridgeAck(from, payload.messageId, result.status, result.detail, extras);
      }
      return;
    }
    if (type === 'graph-response') {
      const result = this._handleGraphResponseMessage(from, payload);
      if (payload.messageId) {
        const extras = {};
        const sessionRef = result.sessionId || payload.sessionId || payload.session?.sessionId;
        if (sessionRef) extras.sessionId = sessionRef;
        const queryRef = result.queryId || payload.queryId;
        if (queryRef) extras.queryId = queryRef;
        this._sendBridgeAck(from, payload.messageId, result.status, result.detail, extras);
      }
      return;
    }
    if (type === 'hybrid-bridge-resource') {
      this._handleResource(from, payload);
      return;
    }
    if (type === 'hybrid-bridge-command') {
      const key = makeScopedKey(NETWORKS.HYDRA, from);
      this._appendChat(key, {
        dir: 'in',
        kind: 'command',
        text: payload.command?.label || 'Command received',
        meta: { command: payload.command },
        ts: payload.ts || nowSecondsFallback()
      });
      if (this.state.selectedKey === key) this.renderChat();
      return;
    }
    if (type === 'hybrid-bridge-log') {
      const key = makeScopedKey(NETWORKS.HYDRA, from);
      this._appendChat(key, {
        dir: 'in',
        kind: 'log',
        text: payload.message || 'Bridge log entry',
        meta: { details: payload.details || '' },
        ts: payload.ts || nowSecondsFallback()
      });
      if (this.state.selectedKey === key) this.renderChat();
      return;
    }
    if (type === 'smart-object-audio-output') {
      // Audio from Hydra TTS to NoClip Smart Object
      this._handleSmartObjectAudio(from, payload);
      return;
    }
    if (type === 'smart-object-text-update') {
      // Text update from Hydra LLM to NoClip Smart Object
      this._handleSmartObjectText(from, payload);
      return;
    }
    if (type === 'noclip-bridge-sync-accepted') {
      // Hydra approved our sync request and created a bridge
      this._handleSyncAccepted(from, payload);
      return;
    }
    if (type === 'noclip-bridge-sync-rejected') {
      // Hydra rejected our sync request
      this._handleSyncRejected(from, payload);
      return;
    }
    if (type === 'ping') {
      // Ping from Hydra - send pong response
      this._handlePing(from, payload);
      return;
    }
  }

  /**
   * Handle incoming audio packet from Hydra for Smart Objects
   */
  _handleSmartObjectAudio(from, payload) {
    // Check if scene manager has smart objects initialized
    if (!this.sceneMgr || !this.sceneMgr.smartObjects) return;

    const audioPacket = payload.audioPacket;
    const objectId = payload.objectId || payload.nodeId;

    if (!audioPacket || !objectId) {
      console.warn('[Hybrid] Invalid smart object audio packet');
      return;
    }

    // Route to Smart Object
    this.sceneMgr.smartObjects.handleAudioPacket(objectId, audioPacket);
  }

  /**
   * Handle incoming text update from Hydra for Smart Objects
   */
  _handleSmartObjectText(from, payload) {
    // Check if scene manager has smart objects initialized
    if (!this.sceneMgr || !this.sceneMgr.smartObjects) return;

    const textData = payload.textData;
    const objectId = payload.objectId || payload.nodeId;

    if (!textData || !objectId) {
      console.warn('[Hybrid] Invalid smart object text update');
      return;
    }

    // Route to Smart Object
    this.sceneMgr.smartObjects.handleTextUpdate(objectId, textData);
  }

  _handleResource(from, payload) {
    const key = makeScopedKey(NETWORKS.HYDRA, from);
    const resource = payload.resource || {};
    const issuer = payload.issuer?.graphId || payload.issuer?.nodeId || shortPub(from);
    const id = resource.id || payload.id || generateBridgeId();
    if (resource.remove) {
      this._removeResource(id, issuer);
      this._appendChat(key, {
        dir: 'in',
        kind: 'log',
        text: `Resource ${id} removed by ${issuer}`,
        ts: payload.ts || nowSecondsFallback(),
        meta: { details: '' }
      });
      if (this.state.selectedKey === key) this.renderChat();
      return;
    }
    const applied = this._applyResource(id, resource, issuer);
    this._appendChat(key, {
      dir: 'in',
      kind: 'resource',
      text: `${resource.label || issuer} deployed ${resource.kind || 'resource'}`,
      ts: payload.ts || nowSecondsFallback(),
      meta: { resource, issuer }
    });
    if (!this.state.selectedKey && this.state.network === NETWORKS.HYDRA) {
      this.setActivePeer(key);
    } else if (this.state.selectedKey === key) {
      this.renderChat();
    } else if (applied) {
      pushToast(`Resource from ${issuer}`);
    }
  }

  _ensureResourceLayer() {
    if (this.resourceLayer || !this.app?.sceneMgr?.scene) return;
    const layer = new THREE.Group();
    layer.name = 'hybrid-resource-layer';
    this.app.sceneMgr.scene.add(layer);
    this.resourceLayer = layer;
  }

  _clearResources() {
    this.resources.forEach((entry) => {
      if (entry?.group && entry.group.parent) entry.group.parent.remove(entry.group);
      this._disposeResourceEntry(entry);
    });
    this.resources.clear();
    if (this.resourceLayer && this.resourceLayer.parent) {
      this.resourceLayer.parent.remove(this.resourceLayer);
    }
    this.resourceLayer = null;
  }

  _disposeResourceEntry(entry) {
    if (!entry) return;
    const disposeObject = (obj) => {
      if (!obj) return;
      if (obj.geometry) {
        try { obj.geometry.dispose(); } catch (_) {}
      }
      if (obj.material) {
        const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
        materials.forEach((mat) => {
          if (mat && typeof mat.dispose === 'function') {
            try { mat.dispose(); } catch (_) {}
          }
        });
      }
    };
    try {
      entry.group?.traverse((child) => disposeObject(child));
    } catch (_) {
      disposeObject(entry.group);
    }
  }

  _applyResource(id, resource, issuer) {
    this._ensureResourceLayer();
    if (!this.resourceLayer) return false;
    const world = this._resolveWorldPosition(resource);
    if (!world) return false;

    let entry = this.resources.get(id);
    if (!entry) {
      entry = { group: new THREE.Group(), mesh: null, label: null };
      entry.group.name = `hybrid-resource-${id}`;
      this.resources.set(id, entry);
      this.resourceLayer.add(entry.group);
    }

    entry.group.position.set(world.x, world.y, world.z);
    let heading = Number(resource.heading);
    if (!Number.isFinite(heading) && Number.isFinite(resource.headingDeg)) {
      heading = (Number(resource.headingDeg) * Math.PI) / 180;
    }
    entry.group.rotation.set(0, Number.isFinite(heading) ? heading : 0, 0);

    this._applyResourceMesh(entry, resource);
    this._ensureResourceLabel(entry, resource.label || issuer);
    entry.resource = resource;
    entry.issuer = issuer;
    return true;
  }

  _removeResource(id, issuer) {
    const entry = this.resources.get(id);
    if (!entry) return;
    if (entry.group?.parent) entry.group.parent.remove(entry.group);
    this._disposeResourceEntry(entry);
    this.resources.delete(id);
    if (issuer) pushToast(`Resource ${id} removed by ${issuer}`);
  }

  _applyResourceMesh(entry, resource) {
    if (!entry) return;
    if (entry.mesh) {
      entry.group.remove(entry.mesh);
      this._disposeResourceEntry({ group: entry.mesh });
      entry.mesh = null;
    }
    const scale = Number(resource.scale) > 0 ? Number(resource.scale) : 1;
    let mesh = null;
    const color = resource.color || '#8fd2ff';
    if ((resource.kind || '').toLowerCase() === 'obelisk') {
      mesh = this._createObeliskMesh(scale, color);
    } else {
      mesh = this._createMarkerMesh(scale, color);
    }
    entry.mesh = mesh;
    entry.group.add(mesh);
  }

  _ensureResourceLabel(entry, text) {
    if (!entry) return;
    if (entry.label) {
      entry.label.material.map.dispose?.();
      entry.label.material.dispose?.();
      entry.group.remove(entry.label);
      entry.label = null;
    }
    const sprite = this._createLabelSprite(text || 'bridge');
    sprite.position.set(0, 6, 0);
    entry.group.add(sprite);
    entry.label = sprite;
  }

  _resolveWorldPosition(resource = {}) {
    let x = Number(resource.x);
    let y = Number(resource.y);
    let z = Number(resource.z);

    if (Array.isArray(resource.world) && resource.world.length >= 3) {
      x = Number(resource.world[0]);
      y = Number(resource.world[1]);
      z = Number(resource.world[2]);
    } else if (resource.world && typeof resource.world === 'object') {
      if (Number.isFinite(resource.world.x)) x = Number(resource.world.x);
      if (Number.isFinite(resource.world.y)) y = Number(resource.world.y);
      if (Number.isFinite(resource.world.z)) z = Number(resource.world.z);
    } else if (Array.isArray(resource.position) && resource.position.length >= 3) {
      x = Number(resource.position[0]);
      y = Number(resource.position[1]);
      z = Number(resource.position[2]);
    }

    const origin = this.mesh?._originLatLon?.();
    if ((!Number.isFinite(x) || !Number.isFinite(z)) && origin) {
      let lat = Number(resource.lat);
      let lon = Number(resource.lon);
      const geo = resource.geo;
      if (geo && typeof geo === 'object') {
        if (Number.isFinite(geo.lat)) lat = Number(geo.lat);
        if (Number.isFinite(geo.lon)) lon = Number(geo.lon);
      }
      if ((!Number.isFinite(lat) || !Number.isFinite(lon)) && typeof resource.geohash === 'string') {
        const decoded = decodeGeohash(resource.geohash);
        if (decoded) {
          lat = decoded.lat;
          lon = decoded.lon;
        }
      }
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        const world = latLonToWorld(lat, lon, origin.lat, origin.lon);
        if (world) {
          x = world.x;
          z = world.z;
        }
      }
    }

    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;

    let ground = Number.isFinite(resource.ground) ? Number(resource.ground) : null;
    const geoGround = resource.geo && Number.isFinite(resource.geo.ground) ? Number(resource.geo.ground) : null;
    if (!Number.isFinite(ground) && Number.isFinite(geoGround)) ground = geoGround;
    if (!Number.isFinite(ground) && this.app?.hexGridMgr?.getHeightAt) {
      const sample = this.app.hexGridMgr.getHeightAt(x, z);
      if (Number.isFinite(sample)) ground = sample;
    }
    if (!Number.isFinite(ground)) ground = 0;

    if (!Number.isFinite(y)) {
      const alt = Number(resource.altitude);
      if (Number.isFinite(alt)) y = ground + alt;
      else if (resource.geo && Number.isFinite(resource.geo.eye)) y = ground + Number(resource.geo.eye);
      else y = ground;
    }

    return { x, y, z };
  }

  _createObeliskMesh(scale, color) {
    const group = new THREE.Group();
    const height = 5 * scale;
    const bodyGeo = new THREE.CylinderGeometry(0.45 * scale, 0.9 * scale, height, 6, 1, false);
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), emissive: 0x112233, metalness: 0.2, roughness: 0.4 });
    const body = new THREE.Mesh(bodyGeo, material);
    body.castShadow = true;
    body.receiveShadow = true;
    body.position.y = height / 2;
    group.add(body);

    const tipGeo = new THREE.ConeGeometry(0.75 * scale, 1.2 * scale, 6, 1);
    const tipMat = material.clone();
    tipMat.emissiveIntensity = 0.4;
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.castShadow = true;
    tip.position.y = height + 0.6 * scale;
    group.add(tip);
    return group;
  }

  _createMarkerMesh(scale, color) {
    const height = 3 * scale;
    const geo = new THREE.CylinderGeometry(0.6 * scale, 0.6 * scale, height, 12);
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(color), roughness: 0.35, metalness: 0.1 });
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.y = height / 2;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  _createLabelSprite(text) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(10, 16, 28, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(120, 180, 255, 0.4)';
    ctx.lineWidth = 2;
    ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
    ctx.fillStyle = '#e8f6ff';
    ctx.font = '28px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(text || '').slice(0, 24), canvas.width / 2, canvas.height / 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;
    const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(8, 2.2, 1);
    sprite.center.set(0.5, 0);
    return sprite;
  }

  _markStateDirty() {
    if (this._stateTimer) return;
    this._stateTimer = setTimeout(() => this._flushState(), 600);
  }

  async _flushState() {
    if (this._stateTimer) {
      clearTimeout(this._stateTimer);
      this._stateTimer = null;
    }
    const discovery = this.state.hydra.discovery;
    if (!discovery) return;
    const hydraPeers = Array.from(this.state.hydra.peers.keys());
    if (!hydraPeers.length) return;
    const snapshot = Array.from(this.state.noclip.peers.values()).map((peer) => ({
      nknPub: peer.nknPub,
      addr: peer.addr,
      meta: peer.meta || {},
      geo: peer.geo || null,
      last: peer.last || nowSecondsFallback()
    }));
    if (!snapshot.length) return;
    const payload = {
      type: 'hybrid-bridge-state',
      peers: snapshot,
      ts: nowSecondsFallback()
    };
    await Promise.all(
      hydraPeers.map((pub) => discovery.dm(pub, payload).catch(() => {}))
    );
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
      const kind = entry.kind || 'chat';
      const row = document.createElement('div');
      row.className = `hybrid-chat-row ${kind} ${entry.dir === 'out' ? 'out' : 'in'}`;
      const text = document.createElement('div');
      text.className = 'hybrid-chat-text';
      const prefix = kind === 'resource' ? '[Resource]' : kind === 'log' ? '[Log]' : kind === 'command' ? '[Command]' : null;
      text.textContent = prefix ? `${prefix} ${entry.text}` : entry.text;
      row.appendChild(text);
      if (kind === 'resource' && entry.meta?.resource) {
        const detail = document.createElement('div');
        detail.className = 'hybrid-chat-detail';
        detail.textContent = describeResource(entry.meta.resource);
        row.appendChild(detail);
      }
      if (kind === 'log' && entry.meta?.details) {
        const detail = document.createElement('div');
        detail.className = 'hybrid-chat-detail';
        detail.textContent = entry.meta.details;
        row.appendChild(detail);
      }
      const time = document.createElement('div');
      time.className = 'hybrid-chat-time';
      time.textContent = new Date((entry.ts || nowSecondsFallback()) * 1000).toLocaleTimeString();
      row.appendChild(time);
      frag.appendChild(row);
    });
    ui.hybridChatLog.appendChild(frag);
    ui.hybridChatLog.scrollTop = ui.hybridChatLog.scrollHeight;
    if (ui.hybridChatInput) ui.hybridChatInput.disabled = false;
    if (ui.hybridChatSend) ui.hybridChatSend.disabled = false;
  }

  setMessageView(view) {
    this.state.rawMessageView = view === 'raw';

    // Update button states
    document.querySelectorAll('[data-hybrid-view]').forEach((btn) => {
      btn.classList.toggle('is-active', btn.dataset.hybridView === view);
    });

    // Toggle visibility
    const chatShell = document.getElementById('hybridChatShell');
    const rawShell = document.getElementById('hybridRawShell');

    if (chatShell) chatShell.hidden = view === 'raw';
    if (rawShell) rawShell.hidden = view !== 'raw';

    if (view === 'raw') {
      this.renderRawMessages();
    } else {
      this.renderChat();
    }
  }

  renderRawMessages() {
    const container = document.getElementById('hybridRawLog');
    if (!container) return;

    const filter = this.state.rawFilter;
    const messages = filter
      ? this.state.rawMessages.filter((m) => m.type === filter)
      : this.state.rawMessages;

    container.innerHTML = '';

    if (!messages.length) {
      const empty = document.createElement('div');
      empty.className = 'hybrid-empty';
      empty.textContent = filter ? `No messages of type "${filter}"` : 'No raw messages yet';
      container.appendChild(empty);
      return;
    }

    const frag = document.createDocumentFragment();

    // Show newest first
    messages.slice().reverse().forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'hybrid-raw-entry';

      const meta = document.createElement('div');
      meta.className = 'hybrid-raw-meta';
      meta.innerHTML = `
        <span><strong>From:</strong> ${shortPub(entry.from)}</span>
        <span><strong>Type:</strong> ${entry.type}</span>
        <span><strong>Size:</strong> ${entry.size}B</span>
        <span><strong>Time:</strong> ${new Date(entry.timestamp).toLocaleTimeString()}</span>
        <span><strong>Network:</strong> ${entry.network}</span>
      `;

      const payload = document.createElement('div');
      payload.className = 'hybrid-raw-payload';
      payload.innerHTML = this._highlightJson(entry.payload);

      row.appendChild(meta);
      row.appendChild(payload);
      frag.appendChild(row);
    });

    container.appendChild(frag);
    container.scrollTop = 0; // Scroll to top (newest)
  }

  _highlightJson(obj) {
    const json = JSON.stringify(obj, null, 2);
    return json
      .replace(/"([^"]+)":/g, '<span class="json-key">"$1"</span>:')
      .replace(/:\s*"([^"]*)"/g, ': <span class="json-string">"$1"</span>')
      .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-number">$1</span>')
      .replace(/:\s*(true|false)/g, ': <span class="json-boolean">$1</span>')
      .replace(/:\s*null/g, ': <span class="json-null">null</span>');
  }

  generatePeerLink(pub, options = {}) {
    if (!pub) return null;

    try {
      // Determine if this is self (for sharing own NoClip address)
      const selfPub = (this.mesh?.selfPub || this.mesh?.selfAddr || '').toLowerCase();
      const isSelf = pub.toLowerCase() === selfPub;

      // Get peer info
      const peer = this.state.hydra.peers.get(pub) || this.state.noclip.peers.get(pub);

      // Determine network type
      let network = options.network || peer?.meta?.network || (isSelf ? 'noclip' : null);

      // If no network determined, try to infer from which map has the peer
      if (!network) {
        if (this.state.noclip.peers.has(pub)) network = 'noclip';
        else if (this.state.hydra.peers.has(pub)) network = 'hydra';
        else network = 'noclip'; // Default to noclip for unknown peers
      }

      // Build URL with appropriate parameter
      const url = new URL(window.location.href);

      if (network === 'noclip' || isSelf) {
        // Use ?noclip=noclip.<hex> format
        url.searchParams.set('noclip', `noclip.${pub}`);
      } else if (network === 'hydra') {
        // Use ?hydra=hydra.<hex> format
        url.searchParams.set('hydra', `hydra.${pub}`);
      } else {
        // Fallback to noclip
        url.searchParams.set('noclip', `noclip.${pub}`);
      }

      return url.toString();

    } catch (err) {
      console.warn('[hybrid] Failed to generate peer link:', err);
      return null;
    }
  }

  copyPeerLink(pub) {
    const link = this.generatePeerLink(pub);
    if (!link) {
      pushToast('Failed to generate peer link');
      return;
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(link).then(() => {
          pushToast('Peer link copied to clipboard');
        }).catch(() => {
          pushToast('Failed to copy link');
        });
      } else {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = link;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
          document.execCommand('copy');
          pushToast('Peer link copied to clipboard');
        } catch {
          pushToast('Failed to copy link');
        }
        document.body.removeChild(textarea);
      }
    } catch (err) {
      console.warn('[hybrid] Failed to copy peer link:', err);
      pushToast('Failed to copy link');
    }
  }

  /**
   * Handle sync accepted response from Hydra
   */
  _handleSyncAccepted(from, payload) {
    console.log('[Hybrid] Sync accepted by Hydra:', from, payload);

    const bridgeNodeId = payload.bridgeNodeId || '';
    const hydraPub = normalizeHex64(from);
    const sessionPayload = payload.session;
    let storedSession = null;

    if (sessionPayload) {
      storedSession = this._upsertSession({
        ...sessionPayload,
        hydraPub: sessionPayload.hydraPub || hydraPub,
        status: 'handshaking'
      });
    }

    if (!storedSession && payload.objectId) {
      const selfPub = normalizeHex64(this.mesh?.selfPub || this.mesh?.selfAddr);
      if (selfPub && hydraPub) {
        storedSession = this._upsertSession({
          sessionId: `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          objectUuid: payload.objectId,
          objectLabel: payload.objectLabel || '',
          noclipPub: selfPub,
          noclipAddr: `noclip.${selfPub}`,
          hydraBridgeNodeId: bridgeNodeId || '',
          hydraPub,
          hydraAddr: payload.hydraAddr || '',
          status: 'handshaking'
        });
      }
    }

    if (hydraPub) {
      this._updateSessionsForHydra(hydraPub, { status: 'handshaking' });
      const peer = this._ensureHydraPeerRecord(hydraPub, storedSession);
      if (peer) {
        peer.hasBridge = true;
        if (!peer.bridgeStatus || peer.bridgeStatus === 'detected' || peer.bridgeStatus === 'timeout') {
          peer.bridgeStatus = 'handshaking';
        }
      }
      this.renderPeers();
      const kickHandshake = () => {
        const currentPeer = this.state.hydra.peers.get(hydraPub);
        if (!currentPeer) return;
        if (currentPeer.bridgeStatus === 'connected') return;
        this._initiateHandshake(hydraPub);
      };
      const discoPromise = this.ensureHydraDiscovery();
      if (discoPromise && typeof discoPromise.then === 'function') {
        discoPromise.then(kickHandshake).catch(() => kickHandshake());
      } else {
        kickHandshake();
      }
    }

    // Notify user via UI
    if (typeof pushToast === 'function') {
      const toastLabel = bridgeNodeId ? `✓ Bridge approved by Hydra (${bridgeNodeId})` : '✓ Bridge approved by Hydra';
      pushToast(toastLabel, { duration: 4000 });
    }

    // Log to Smart Object modal if open
    if (this.sceneMgr?.smartModal) {
      this.sceneMgr.smartModal._log(`✓ Sync accepted! Bridge node: ${bridgeNodeId}`, 'success');
    }

    // Send acknowledgment back
    const discovery = this.state.hydra?.discovery;
    if (discovery) {
      const ackPayload = {
        type: 'noclip-bridge-sync-accepted',
        bridgeNodeId,
        timestamp: Date.now()
      };
      if (storedSession) {
        ackPayload.session = storedSession;
      }
      discovery.dm(from, ackPayload).catch(err => {
        console.error('[Hybrid] Failed to send sync acknowledgment:', err);
      });
    }
  }

  /**
   * Handle sync rejected response from Hydra
   */
  _handleSyncRejected(from, payload) {
    console.log('[Hybrid] Sync rejected by Hydra:', from, payload);

    const reason = payload.reason || 'Unknown reason';
    const targetSessions = [];
    if (payload?.session?.sessionId) {
      const stored = this._upsertSession({
        ...payload.session,
        hydraPub: payload.session.hydraPub || normalizeHex64(from),
        status: 'rejected',
        rejectionReason: reason
      });
      if (stored) targetSessions.push(stored);
    } else if (payload?.objectId) {
      const sessions = this._sessionsForObject(payload.objectId);
      sessions.forEach((session) => {
        const merged = this._upsertSession({
          ...session,
          status: 'rejected',
          rejectionReason: reason
        });
        if (merged) targetSessions.push(merged);
      });
    }

    const hydraPub = normalizeHex64(from);
    if (hydraPub) {
      this._updateSessionsForHydra(hydraPub, { status: 'rejected', rejectionReason: reason });
    }

    const smartManager = this.sceneMgr?.smartObjects;
    if (smartManager?.markSyncRejected) {
      const seen = new Set();
      const attemptMark = (objectUuid, pub) => {
        if (!objectUuid) return;
        const normalizedPub = pub || hydraPub || from;
        const key = `${objectUuid}:${normalizedPub || ''}`;
        if (seen.has(key)) return;
        seen.add(key);
        smartManager.markSyncRejected(objectUuid, normalizedPub, reason);
      };
      if (targetSessions.length) {
        targetSessions.forEach((session) => attemptMark(session.objectUuid, session.hydraPub));
      } else if (payload?.objectId) {
        attemptMark(payload.objectId, hydraPub);
      }
    }

    // Notify user via UI
    if (typeof pushToast === 'function') {
      pushToast(`✗ Sync rejected: ${reason}`, { duration: 4000 });
    }

    // Log to Smart Object modal if open
    if (this.sceneMgr?.smartModal) {
      this.sceneMgr.smartModal._log(`✗ Sync rejected: ${reason}`, 'error');
    }
  }

  /**
   * Handle ping request from Hydra
   */
  _handlePing(from, payload) {
    console.log('[Hybrid] Ping received from:', from);

    // Send pong response
    const discovery = this.state.hydra?.discovery;
    if (discovery) {
      discovery.dm(from, {
        type: 'pong',
        timestamp: Date.now(),
        originalTimestamp: payload.timestamp
      }).catch(err => {
        console.error('[Hybrid] Failed to send pong:', err);
      });
    }

    // Log to Smart Object modal if open
    if (this.sceneMgr?.smartModal) {
      this.sceneMgr.smartModal._log(`✓ Ping received from ${from.slice(0, 8)}...`, 'info');
    }
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

function describeResource(resource = {}) {
  const parts = [];
  if (resource.label) parts.push(resource.label);
  if (resource.kind) parts.push(resource.kind);
  if (resource.id) parts.push(`#${resource.id}`);
  if (resource.geo && Number.isFinite(resource.geo.lat) && Number.isFinite(resource.geo.lon)) {
    parts.push(`${resource.geo.lat.toFixed(4)}, ${resource.geo.lon.toFixed(4)}`);
  }
  if (Array.isArray(resource.world) && resource.world.length >= 3) {
    parts.push(`world (${Number(resource.world[0]).toFixed(2)}, ${Number(resource.world[1]).toFixed(2)}, ${Number(resource.world[2]).toFixed(2)})`);
  }
  return parts.join(' • ');
}

const GH32 = '0123456789bcdefghjkmnpqrstuvwxyz';

function decodeGeohash(hash) {
  if (typeof hash !== 'string' || !hash) return null;
  let even = true;
  let latRange = [-90, 90];
  let lonRange = [-180, 180];
  for (const char of hash.toLowerCase()) {
    const idx = GH32.indexOf(char);
    if (idx === -1) return null;
    for (let mask = 16; mask >= 1; mask >>= 1) {
      if (even) {
        const mid = (lonRange[0] + lonRange[1]) / 2;
        if (idx & mask) lonRange[0] = mid;
        else lonRange[1] = mid;
      } else {
        const mid = (latRange[0] + latRange[1]) / 2;
        if (idx & mask) latRange[0] = mid;
        else latRange[1] = mid;
      }
      even = !even;
    }
  }
  return {
    lat: (latRange[0] + latRange[1]) / 2,
    lon: (lonRange[0] + lonRange[1]) / 2
  };
}

function sanitizeRoom() {
  // Use 'nexus' as the shared discovery room for both Hydra and NoClip
  // This enables cross-application peer discovery across hydra.nexus and noclip.nexus
  return 'nexus';
}

function formatLast(last) {
  if (!last) return 'unknown';
  const delta = nowSecondsFallback() - last;
  if (delta < 15) return 'just now';
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

function getBridgeStatusIcon(status) {
  switch (status) {
    case 'connected': return '🔗';
    case 'handshaking': return '⏳';
    case 'detected': return '🌉';
    case 'timeout': return '⏱️';
    case 'error': return '❌';
    case 'handshake-received': return '🤝';
    default: return '❓';
  }
}

function getBridgeStatusText(status) {
  switch (status) {
    case 'connected': return 'Bridge Connected';
    case 'handshaking': return 'Handshaking...';
    case 'detected': return 'Bridge Detected (Click to connect)';
    case 'timeout': return 'Handshake Timeout';
    case 'error': return 'Connection Error';
    case 'handshake-received': return 'Handshake Received';
    default: return 'Unknown Status';
  }
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
    // Use the same subject pattern as Hydra's nats.js for cross-discovery
    this.presenceSubject = `discovery.${this.room}.presence`;
    this.dmSubject = (pub) => `discovery.dm.${pub}`;
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
