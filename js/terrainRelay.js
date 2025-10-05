const LS_SEED_KEY = 'terrain.nkn.seed.v1';

function makeSeed() {
  const buf = new Uint8Array(32);
  (globalThis.crypto || window.crypto).getRandomValues(buf);
  return Array.from(buf).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ensureJson(obj) {
  if (!obj) return {};
  if (typeof obj === 'string') {
    try { return JSON.parse(obj); } catch { return {}; }
  }
  return obj;
}

export class TerrainRelay {
  constructor({ defaultRelay = '', dataset = 'mapzen', mode = 'geohash', onStatus = null, clientProvider = null } = {}) {
    this.relayAddress = defaultRelay.trim();
    this.dataset = dataset.trim() || 'mapzen';
    this.mode = mode === 'latlng' ? 'latlng' : 'geohash';
    this._onStatus = typeof onStatus === 'function' ? onStatus : null;

    this._clientProvider = typeof clientProvider === 'function' ? clientProvider : null;
    this._internalClient = null;
    this.connected = false;
    this.selfAddr = null;
    this.selfPub = null;
    this._pending = new Map();
    this._statusText = 'idle';
    this._waiters = new Set();
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
  }

  setDataset(dataset) {
    this.dataset = (dataset || '').trim() || 'mapzen';
  }

  setMode(mode) {
    this.mode = mode === 'latlng' ? 'latlng' : 'geohash';
  }

  _emitStatus(text, level = 'info') {
    this._statusText = text;
    if (this._onStatus) this._onStatus(text, level);
  }

  async ensureClient() {
    if (this._clientProvider) {
      this._emitStatus('linking mesh relay…', 'warn');
      const client = await this._clientProvider();
      if (!client) throw new Error('Terrain relay client unavailable');
      await this._waitForReady(client, 20000);
      this.client = client;
      this.connected = true;
      this.selfAddr = client.addr || null;
      try { this.selfPub = client.getPublicKey?.() || null; } catch { this.selfPub = null; }
      this._emitStatus('connected', 'ok');
      return client;
    }

    if (this._internalClient) {
      await this._waitForReady(this._internalClient, 20000);
      return this._internalClient;
    }

    if (!globalThis.window?.nkn?.MultiClient) {
      throw new Error('NKN SDK not loaded');
    }

    let seed = null;
    try { seed = localStorage.getItem(LS_SEED_KEY); } catch { seed = null; }
    if (!seed || seed.length !== 64) {
      seed = makeSeed();
      try { localStorage.setItem(LS_SEED_KEY, seed); } catch { /* ignore */ }
    }

    const mc = new window.nkn.MultiClient({
      seed,
      identifier: 'terrain',
      numSubClients: 4,
      originalClient: false,
    });

    this._emitStatus('connecting…', 'warn');

    mc.onConnect(() => {
      this.connected = true;
      this.selfAddr = mc.addr || null;
      try { this.selfPub = mc.getPublicKey?.() || null; } catch { this.selfPub = null; }
      this._emitStatus('connected', 'ok');
      this._flushWaiters(mc);
    });

    mc.onMessage(({ src, payload }) => this._handleIncoming(src, payload));

    mc.onClose?.(() => {
      this.connected = false;
      this._emitStatus('disconnected', 'warn');
    });

    this._internalClient = mc;
    this.client = mc;
    await this._waitForReady(mc, 20000);
    return mc;
  }

  _handleIncoming(_src, payload) {
    let text = payload;
    if (payload instanceof Uint8Array) {
      try { text = new TextDecoder().decode(payload); } catch { text = null; }
    }
    if (typeof text !== 'string') return;

    let msg = null;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    const id = msg.id;
    if (id && this._pending.has(id)) {
      const pending = this._pending.get(id);
      this._pending.delete(id);
      clearTimeout(pending.timeout);
      pending.resolve(msg);
      return;
    }
  }

  _sendWithReply(dest, payload, timeoutMs = 25000, clientOverride = null) {
    if (!dest) return Promise.reject(new Error('No relay address configured'));
    const mc = clientOverride || this.client;
    if (!mc) return Promise.reject(new Error('NKN client not ready'));

    const id = payload.id || globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2);
    payload.id = id;

    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error('Terrain relay timeout'));
        }
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timeout });
    });

    const attemptSend = (tries = 0) => {
      mc.send(dest, JSON.stringify(payload)).catch((err) => {
        const entry = this._pending.get(id);
        const message = err?.message || String(err || 'error');
        const notReady = /not ready/i.test(message);
        if (notReady && tries < 5) {
          const delay = 120 + tries * 80;
          setTimeout(() => attemptSend(tries + 1), delay);
          return;
        }

        if (entry) {
          clearTimeout(entry.timeout);
          this._pending.delete(id);
          entry.reject?.(err instanceof Error ? err : new Error(message));
        }
      });
    };

    attemptSend();

    return promise.then((msg) => ensureJson(msg));
  }

  async queryBatch(dest, payload, timeoutMs = 45000) {
    const mc = await this.ensureClient();
    const reply = await this._sendWithReply(dest, payload, timeoutMs, mc);
    if (reply && reply.type === 'http.response') {
      if (reply.body_b64) {
        try { return JSON.parse(atob(reply.body_b64)); } catch { return null; }
      }
      if (reply.body && typeof reply.body === 'string') {
        try { return JSON.parse(reply.body); } catch { return null; }
      }
      if (reply.body && typeof reply.body === 'object') return reply.body;
    }
    return reply;
  }

  async _waitForReady(client, timeoutMs = 20000) {
    if (!client) throw new Error('client not available');
    if (client.addr) return client;

    return new Promise((resolve, reject) => {
      const isInternal = client === this._internalClient;
      const cleanup = () => {
        clearTimeout(timer);
        if (isInternal) this._waiters.delete(resolve);
      };
      const done = () => {
        cleanup();
        resolve(client);
      };
      const timer = setTimeout(() => {
        if (isInternal) this._waiters.delete(resolve);
        reject(new Error('Terrain relay client not ready'));
      }, timeoutMs);

      if (isInternal) this._waiters.add(resolve);
      if (typeof client.onConnect === 'function') {
        client.onConnect(() => {
          cleanup();
          resolve(client);
        });
      }

      if (client.addr) {
        cleanup();
        resolve(client);
      }
    });
  }

  _flushWaiters(client) {
    for (const waiter of this._waiters) {
      try { waiter(client); } catch { /* noop */ }
    }
    this._waiters.clear();
  }
}
