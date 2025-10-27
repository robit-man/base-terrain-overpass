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
  constructor({ defaultRelay = '', dataset = 'mapzen', mode = 'geohash', onStatus = null, clientProvider = null, wsEndpoint = 'https://noclip-elevation.loca.lt' } = {}) {
    this.relayAddress = defaultRelay.trim();
    this.dataset = dataset.trim() || 'mapzen';
    this.mode = mode === 'latlng' ? 'latlng' : 'geohash';
    this._onStatus = typeof onStatus === 'function' ? onStatus : null;

    // WebSocket fallback
    this.wsEndpoint = wsEndpoint.trim();
    this._wsSocket = null;
    this._wsConnected = false;
    this._wsPending = new Map();
    this._wsRetryTimer = null;
    this._wsRetryDelay = 1000;
    this._useWsFallback = false; // Enable WebSocket fallback by default

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

    // Start WebSocket connection immediately if enabled
    if (this._useWsFallback && this.wsEndpoint) {
      // Defer to next tick to allow constructor to complete
      setTimeout(() => this._connectWs(), 0);
    }
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

  setWsEndpoint(endpoint) {
    const newEndpoint = (endpoint || '').trim();
    if (this.wsEndpoint !== newEndpoint) {
      this.wsEndpoint = newEndpoint;
      // Reconnect with new endpoint
      if (this._wsSocket) {
        this._disconnectWs();
        if (this._useWsFallback) {
          this._connectWs();
        }
      }
    }
  }

  setWsFallbackEnabled(enabled) {
    this._useWsFallback = !!enabled;
    if (enabled && !this._wsConnected && this.wsEndpoint) {
      this._connectWs();
    } else if (!enabled && this._wsSocket) {
      this._disconnectWs();
    }
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
    const run = () => this._performHeartbeat().catch(() => { });
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

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket Fallback Methods
  // ─────────────────────────────────────────────────────────────────────────

  _connectWs() {
    if (!this.wsEndpoint || this._wsSocket) return;

    try {
      const io = globalThis.io;
      if (!io) {
        console.warn('[TerrainRelay] socket.io-client not loaded, WebSocket fallback disabled');
        return;
      }

      this._emitStatus('connecting to ws fallback…', 'info');
      this._wsSocket = io(this.wsEndpoint, {
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: this._wsRetryDelay,
        reconnectionDelayMax: 10000,
      });

      this._wsSocket.on('connect', () => {
        this._wsConnected = true;
        this._wsRetryDelay = 1000;
        console.log('[TerrainRelay] WebSocket fallback connected:', this.wsEndpoint);
        this._emitStatus(`ws fallback ready (${this.wsEndpoint})`, 'ok');
      });

      this._wsSocket.on('disconnect', () => {
        this._wsConnected = false;
        console.log('[TerrainRelay] WebSocket fallback disconnected');
        this._emitStatus('ws fallback disconnected', 'warn');
      });

      this._wsSocket.on('elevation-response', (data) => {
        this._handleWsResponse(data);
      });

      this._wsSocket.on('connect_error', (err) => {
        console.warn('[TerrainRelay] WebSocket connection error:', err.message);
        this._wsRetryDelay = Math.min(this._wsRetryDelay * 1.5, 10000);
      });

    } catch (err) {
      console.error('[TerrainRelay] Failed to create WebSocket connection:', err);
    }
  }

  _disconnectWs() {
    if (this._wsSocket) {
      this._wsSocket.disconnect();
      this._wsSocket = null;
      this._wsConnected = false;
    }
    if (this._wsRetryTimer) {
      clearTimeout(this._wsRetryTimer);
      this._wsRetryTimer = null;
    }
    // Reject all pending WS requests
    for (const [id, pending] of this._wsPending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('WebSocket disconnected'));
    }
    this._wsPending.clear();
  }

  _handleWsResponse(data) {
    if (!data || typeof data !== 'object') return;

    // Try to find matching request by matching geohashes or request ID
    for (const [id, pending] of this._wsPending.entries()) {
      // Check if this response matches the request
      const matches = pending.checkMatch?.(data) ?? true;
      if (matches) {
        this._wsPending.delete(id);
        clearTimeout(pending.timeout);
        pending.resolve(data);
        return;
      }
    }
  }

  async _queryViaWebSocket(geohashes, timeoutMs = 15000) {
    if (!this._wsConnected || !this._wsSocket) {
      throw new Error('WebSocket not connected');
    }

    const id = globalThis.crypto?.randomUUID?.() || Math.random().toString(16).slice(2);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this._wsPending.has(id)) {
          this._wsPending.delete(id);
          reject(new Error('WebSocket elevation request timeout'));
        }
      }, timeoutMs);

      // Store with a matcher function to identify the response
      const checkMatch = (data) => {
        // If error, don't match
        if (data.error) return false;

        // For geohash mode, check if response contains our geohashes
        if (data.mode === 'geohash' && data.results && Array.isArray(data.results)) {
          const responseHashes = new Set(data.results.map(r => r.geohash));
          const requestHashes = new Set(geohashes);
          // Check if there's significant overlap
          let matches = 0;
          for (const hash of requestHashes) {
            if (responseHashes.has(hash)) matches++;
          }
          return matches >= Math.min(requestHashes.size, responseHashes.size) * 0.8;
        }

        return true; // Default to accepting if we can't determine
      };

      this._wsPending.set(id, { resolve, reject, timeout, checkMatch });

      // Send request
      const payload = {
        dataset: this.dataset,
        geohashes: geohashes,
        dest: this.relayAddress || undefined, // <-- add this

      };

      this._wsSocket.emit('elevation-request', payload);
    });
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

    const IS_MOBILE =
      /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
      (globalThis.matchMedia?.('(pointer: coarse)').matches ?? false);

    const mc = new window.nkn.MultiClient({
      seed,
      identifier: 'terrain',
      numSubClients: IS_MOBILE ? 1 : 2,   // was 4
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

  // terrainRelay.js
  _handleIncoming(_src, payload) {
    let text = payload;
    if (payload instanceof Uint8Array) {
      try { text = new TextDecoder().decode(payload); } catch { text = null; }
    }
    if (typeof text !== 'string') return;

    const doParse = () => {
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
    };

    // Defer parse so a flood of replies doesn’t block a frame
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(doParse, { timeout: 50 });
    } else {
      setTimeout(doParse, 0);
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
    // Try WebSocket fallback first if available and we're in geohash mode
    if (this._useWsFallback && this._wsConnected && this.mode === 'geohash' && payload.geohashes) {
      try {
        const wsStart = this._nowMs();
        const wsResult = await this._queryViaWebSocket(payload.geohashes, 10000);
        const wsDuration = this._nowMs() - wsStart;

        if (wsResult && !wsResult.error && wsResult.results) {
          this._recordSuccess(wsDuration, { kind: 'query', status: 200 });
          console.log(`[TerrainRelay] WebSocket query succeeded in ${wsDuration.toFixed(0)}ms`);
          return wsResult;
        }
      } catch (wsErr) {
        console.warn('[TerrainRelay] WebSocket query failed, falling back to NKN:', wsErr.message);
        // Continue to NKN fallback
      }
    }

    // NKN relay path (original implementation)
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
      clientAddr: this.selfAddr || null,
      status: { text: this._statusText, level: this._statusLevel },
      metrics,
      heartbeat: this._healthLast,
      websocket: {
        enabled: this._useWsFallback,
        endpoint: this.wsEndpoint || null,
        connected: this._wsConnected,
        pendingRequests: this._wsPending.size,
      },
    };
  }

  _handleClose() {
    this.connected = false;
    this._stopHeartbeat();
    this._emitStatus('disconnected', 'warn');
  }

  dispose() {
    this._stopHeartbeat();
    this._disconnectWs();
    if (this._internalClient) {
      try {
        this._internalClient.close?.();
      } catch {
        // ignore
      }
      this._internalClient = null;
    }
    this.connected = false;
    this.client = null;
  }
}
