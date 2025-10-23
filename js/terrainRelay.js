const LS_SEED_KEY = 'terrain.nkn.seed.v1';
const DEFAULT_DATASET = 'mapzen';

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
  constructor({ defaultRelay = '', dataset = DEFAULT_DATASET, mode = 'geohash', onStatus = null, clientProvider = null } = {}) {
    this.relayAddress = defaultRelay.trim();
    this.dataset = dataset.trim() || DEFAULT_DATASET;
    this.mode = mode === 'latlng' ? 'latlng' : 'geohash';
    this._onStatus = typeof onStatus === 'function' ? onStatus : null;

    this._clientProvider = typeof clientProvider === 'function' ? clientProvider : null;
    this._internalClient = null;
    this.connected = false;
    this.selfAddr = null;
    this.selfPub = null;
    this._pending = new Map();
    this._statusText = 'idle';
    this._statusLevel = 'info';
    this._waiters = new Set();
    this._metrics = {
      success: 0,
      failure: 0,
      totalRequests: 0,
      consecutiveFailures: 0,
      lastDurationMs: null,
      avgDurationMs: null,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastError: null,
      lastErrorAt: null,
      lastStatus: null,
      retries: 0,
      timeouts: 0,
      inflight: 0,
      maxInflight: 0,
      heartbeatOk: 0,
      heartbeatFail: 0,
      lastHeartbeatMs: null,
      lastHeartbeatAt: null,
      lastHeartbeatError: null,
      lastHeartbeatErrorAt: null,
    };
    this._heartbeatTimer = null;
    this._healthLast = null;
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
  }

  setDataset(dataset) {
    this.dataset = (dataset || '').trim() || DEFAULT_DATASET;
  }

  setMode(mode) {
    this.mode = mode === 'latlng' ? 'latlng' : 'geohash';
  }

  _emitStatus(text, level = 'info') {
    if (this._statusText === text && this._statusLevel === level) return;
    this._statusText = text;
    this._statusLevel = level;
    if (this._onStatus) this._onStatus(text, level);
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  }

  _recordSuccess(durationMs, { kind = 'query', status = null, info = null } = {}) {
    const m = this._metrics;
    if (kind === 'query') {
      m.success += 1;
      m.totalRequests += 1;
      if (Number.isFinite(durationMs)) {
        m.lastDurationMs = durationMs;
        m.avgDurationMs = m.avgDurationMs == null ? durationMs : (m.avgDurationMs * 0.85) + (durationMs * 0.15);
      }
      if (status != null) m.lastStatus = status;
      m.lastSuccessAt = Date.now();
      m.lastError = null;
      m.lastErrorAt = null;
      m.consecutiveFailures = 0;
      this._updateStatus();
    } else if (kind === 'heartbeat') {
      if (Number.isFinite(durationMs)) m.lastHeartbeatMs = durationMs;
      const now = Date.now();
      m.lastHeartbeatAt = now;
      m.heartbeatOk += 1;
      m.lastHeartbeatError = null;
      m.lastHeartbeatErrorAt = null;
      this._healthLast = { at: now, info: info || null };
      this._updateStatus();
    }
  }

  _recordFailure(err, { kind = 'query' } = {}) {
    const m = this._metrics;
    const message = err?.message ? String(err.message) : (typeof err === 'string' ? err : 'terrain relay error');
    if (kind === 'heartbeat') {
      const now = Date.now();
      m.heartbeatFail += 1;
      m.lastHeartbeatError = message;
      m.lastHeartbeatErrorAt = now;
      this._emitStatus(`terrain relay heartbeat degraded (${message})`, 'warn');
      return;
    }

    m.failure += 1;
    m.totalRequests += 1;
    m.consecutiveFailures += 1;
    const now = Date.now();
    m.lastFailureAt = now;
    m.lastError = message;
    m.lastErrorAt = now;
    if (/timeout/i.test(message)) m.timeouts += 1;
    const level = m.consecutiveFailures > 3 ? 'error' : 'warn';
    this._emitStatus(`terrain relay degraded · fail ${m.consecutiveFailures} (${message})`, level);
  }

  _updateStatus() {
    if (!this.connected) return;
    const m = this._metrics;
    const total = m.totalRequests || (m.success + m.failure);
    const parts = [
      'connected',
      `ok ${m.success}/${total || 0}`,
      `fail ${m.failure}`,
    ];
    if (Number.isFinite(m.lastDurationMs)) parts.push(`last ${m.lastDurationMs.toFixed(0)}ms`);
    if (Number.isFinite(m.avgDurationMs)) parts.push(`avg ${m.avgDurationMs.toFixed(0)}ms`);
    if (m.inflight > 0) parts.push(`inflight ${m.inflight}`);
    if (m.heartbeatFail > 0 && (!m.heartbeatOk || m.heartbeatOk < m.heartbeatFail)) {
      parts.push(`hb fail ${m.heartbeatFail}`);
    }
    const summary = parts.join(' · ');
    const level = m.consecutiveFailures > 0 ? (m.consecutiveFailures > 3 ? 'error' : 'warn') : 'ok';
    this._emitStatus(summary, level);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    const run = () => this._performHeartbeat().catch(() => {});
    this._heartbeatTimer = setInterval(run, 20000);
    run();
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  async _performHeartbeat() {
    if (!this.relayAddress || !this.connected) return;
    const payload = { type: 'health', ts: Date.now() };
    const start = this._nowMs();
    try {
      const reply = await this._sendWithReply(this.relayAddress, payload, 6000, this.client);
      const dur = this._nowMs() - start;
      if (reply && (reply.type === 'health.response' || reply.status === 'ok')) {
        this._recordSuccess(dur, { kind: 'heartbeat', info: reply });
      } else {
        throw new Error('invalid heartbeat reply');
      }
    } catch (err) {
      this._recordFailure(err, { kind: 'heartbeat' });
    }
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
      if (typeof client.onClose === 'function') {
        client.onClose(() => this._handleClose());
      }
      this._emitStatus('connected', 'ok');
      this._startHeartbeat();
      this._updateStatus();
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
      this._startHeartbeat();
      this._updateStatus();
      this._flushWaiters(mc);
    });

    mc.onMessage(({ src, payload }) => this._handleIncoming(src, payload));

    mc.onClose?.(() => {
      this.connected = false;
      this._emitStatus('disconnected', 'warn');
      this._stopHeartbeat();
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
    const m = this._metrics;
    m.inflight += 1;
    if (m.inflight > m.maxInflight) m.maxInflight = m.inflight;

    const maxAttempts = 3;
    let attempt = 0;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const attemptStart = this._nowMs();
        let reply;
        try {
          reply = await this._sendWithReply(dest, payload, timeoutMs, mc);
        } catch (err) {
          const message = err?.message ? String(err.message) : String(err || 'error');
          if (/timeout/i.test(message)) m.timeouts += 1;
          if (attempt < maxAttempts - 1) {
            m.retries += 1;
            await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
            attempt += 1;
            continue;
          }
          this._recordFailure(err);
          throw err;
        }

        const duration = this._nowMs() - attemptStart;
        const status = (reply && typeof reply.status === 'number') ? reply.status : null;
        if (status != null) m.lastStatus = status;

        if (reply && reply.type === 'http.response' && typeof status === 'number' && status >= 400) {
          this._recordFailure(new Error(`status ${status}`));
        } else {
          this._recordSuccess(duration, { kind: 'query', status });
        }

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
    } finally {
      m.inflight = Math.max(0, m.inflight - 1);
    }
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

  getHealth() {
    const metrics = { ...this._metrics };
    return {
      connected: this.connected,
      address: this.relayAddress || null,
      dataset: this.dataset,
      mode: this.mode,
      clientAddr: this.selfAddr || null,
      status: { text: this._statusText, level: this._statusLevel },
      metrics,
      heartbeat: this._healthLast,
    };
  }

  _handleClose() {
    this.connected = false;
    this._stopHeartbeat();
    this._emitStatus('disconnected', 'warn');
  }
}
