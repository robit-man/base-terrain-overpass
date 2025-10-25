import * as THREE from 'three';
import { ui, pushToast } from './ui.js';
import { latLonToWorld } from './geolocate.js';

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
      chat: new Map()
    };
    this._disposers = [];
    this._uiBound = false;
    this.resources = new Map();
    this.resourceLayer = null;
    this._stateTimer = null;
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
    }

    // seed with current peers
    this._primeNoclipPeers();
    this._ensureResourceLayer();
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
    const entries = Array.from(this.mesh.peers.entries());
    entries.forEach(([pub, info]) => {
      const loc = info?.meta?.loc;
      const geo = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
        ? { lat: Number(loc.lat), lon: Number(loc.lon), gh: loc.gh, radius: loc.radius }
        : null;
      this.state.noclip.peers.set(pub, {
        nknPub: pub,
        addr: info?.addr || pub,
        last: info?.lastTs || 0,
        online: this.mesh._online?.(pub) ?? false,
        meta: info?.meta || {},
        geo
      });
    });
    this.renderPeers();
    this._markStateDirty();
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
        const pub = peer?.nknPub ? peer.nknPub.toLowerCase() : '';
        if (!pub) return;
        const loc = peer.meta?.loc;
        const geo = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
          ? { lat: Number(loc.lat), lon: Number(loc.lon), gh: loc.gh, radius: loc.radius }
          : null;
        this.state.hydra.peers.set(pub, {
          ...peer,
          nknPub: pub,
          addr: peer.addr || pub,
          geo,
          last: peer.last || nowSecondsFallback(),
          online: true
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

  setActivePeer(scopedKey) {
    if (!scopedKey) return;
    this.state.selectedKey = scopedKey;
    this.renderPeers();
    this.renderChat();
  }

  _handleNoclipPeer(peer) {
    if (!peer?.pub) return;
    const pub = peer.pub.toLowerCase();
    const loc = peer.meta?.loc;
    const geo = loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lon)
      ? { lat: Number(loc.lat), lon: Number(loc.lon), gh: loc.gh, radius: loc.radius }
      : null;
    this.state.noclip.peers.set(pub, {
      nknPub: pub,
      addr: peer.addr || pub,
      last: peer.lastTs || nowSecondsFallback(),
      online: true,
      meta: peer.meta || {},
      geo
    });
    if (this.state.network === NETWORKS.NOCLIP) this.renderPeers();
    this._markStateDirty();
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
      const label = document.createElement('div');
      label.className = 'hybrid-peer-name';
      label.textContent = displayName(peer);
      const meta = document.createElement('div');
      meta.className = 'hybrid-peer-meta';
      const parts = [peer.online ? 'Online' : 'Offline', `Last ${formatLast(peer.last)}`];
      if (peer.geo && Number.isFinite(peer.geo.lat) && Number.isFinite(peer.geo.lon)) {
        if (typeof peer.geo.gh === 'string') parts.push(`gh ${peer.geo.gh.slice(0, 8)}`);
        else parts.push(`${peer.geo.lat.toFixed(4)}, ${peer.geo.lon.toFixed(4)}`);
      }
      meta.textContent = parts.join(' • ');
      row.appendChild(label);
      row.appendChild(meta);
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
