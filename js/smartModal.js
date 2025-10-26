/**
 * SmartObjectModal
 * Modal UI for configuring Smart Objects
 */

class SmartObjectModal {
  constructor({ smartObjects, onClose, mesh }) {
    this.smartObjects = smartObjects;
    this.onClose = onClose;
    this.mesh = mesh;
    this.currentObject = null;
    this.modal = null;

    // QR Scanner state
    this.scannerStream = null;
    this.scannerAnimationFrame = null;

    this._createModal();
  }

  /**
   * Create modal HTML structure
   */
  _createModal() {
    const modal = document.createElement('div');
    modal.id = 'smart-object-modal';
    modal.className = 'smart-modal-overlay';
    modal.style.display = 'none';

    modal.innerHTML = `
      <div class="smart-modal-content">
        <div class="smart-modal-header">
          <h2>Smart Object Configuration</h2>
          <button class="smart-modal-close">&times;</button>
        </div>

        <div class="smart-modal-body">
          <!-- Basic Info -->
          <section class="smart-modal-section">
            <h3>Basic Information</h3>
            <div class="smart-form-group">
              <label>Object UUID:</label>
              <input type="text" id="smart-uuid" readonly>
            </div>
            <div class="smart-form-group">
              <label>Label Text:</label>
              <input type="text" id="smart-label-text" placeholder="Enter label text">
            </div>
            <div class="smart-form-group">
              <label>Color:</label>
              <input type="color" id="smart-color" value="#5ee3a6">
            </div>
          </section>

          <!-- Audio Source -->
          <section class="smart-modal-section">
            <h3>Audio Source (TTS from Hydra)</h3>
            <div class="smart-form-group">
              <label>
                <input type="checkbox" id="smart-audio-enabled">
                Enable Audio Playback
              </label>
            </div>
            <div class="smart-form-group">
              <label>Hydra Node ID:</label>
              <input type="text" id="smart-audio-node-id" placeholder="hydra-node-id">
            </div>
            <div class="smart-form-group">
              <label>Volume:</label>
              <input type="range" id="smart-audio-volume" min="0" max="1" step="0.1" value="1">
              <span id="smart-audio-volume-value">1.0</span>
            </div>
            <div class="smart-form-group">
              <label>Max Distance:</label>
              <input type="number" id="smart-audio-max-distance" value="50" min="1" max="200">
            </div>
          </section>

          <!-- Text Source -->
          <section class="smart-modal-section">
            <h3>Text Source (LLM from Hydra)</h3>
            <div class="smart-form-group">
              <label>
                <input type="checkbox" id="smart-text-enabled">
                Enable Text Display
              </label>
            </div>
            <div class="smart-form-group">
              <label>Hydra Node ID:</label>
              <input type="text" id="smart-text-node-id" placeholder="hydra-node-id">
            </div>
            <div class="smart-form-group">
              <label>Update Mode:</label>
              <select id="smart-text-mode">
                <option value="delta">Delta (Streaming)</option>
                <option value="final">Final (Replace)</option>
              </select>
            </div>
          </section>

          <!-- Audio Input -->
          <section class="smart-modal-section">
            <h3>Audio Input (Microphone to ASR)</h3>
            <div class="smart-form-group">
              <label>
                <input type="checkbox" id="smart-mic-enabled">
                Enable Microphone Capture
              </label>
            </div>
            <div class="smart-form-group">
              <label>Target Hydra Node ID:</label>
              <input type="text" id="smart-mic-target-id" placeholder="hydra-asr-node-id">
            </div>
            <div class="smart-form-group">
              <label>Trigger Distance:</label>
              <input type="number" id="smart-mic-distance" value="5" min="1" max="50">
            </div>
            <div class="smart-form-group">
              <label>Activation Mode:</label>
              <select id="smart-mic-mode">
                <option value="proximity">Proximity (Auto)</option>
                <option value="manual">Manual (Click)</option>
              </select>
            </div>
          </section>

          <!-- Privacy -->
          <section class="smart-modal-section">
            <h3>Privacy & Visibility</h3>
            <div class="smart-form-group">
              <label>Visibility:</label>
              <select id="smart-visibility">
                <option value="public">Public (Everyone)</option>
                <option value="friends">Friends Only</option>
                <option value="private">Private (Only Me)</option>
              </select>
            </div>
          </section>

          <!-- Connection & Invite -->
          <section class="smart-modal-section">
            <h3>Hydra Connection</h3>

            <!-- Generate Invite QR -->
            <div class="smart-form-group">
              <label>Invite Hydra Nodes:</label>
              <div class="smart-invite-controls">
                <select id="smart-invite-network">
                  <option value="noclip">NoClip Link (noclip.nexus)</option>
                  <option value="hydra">Hydra Link (hydras.nexus)</option>
                </select>
                <button type="button" class="smart-btn smart-btn-invite" id="smart-generate-invite">
                  Generate Invite QR
                </button>
              </div>
              <div id="smart-invite-qr" class="smart-qr-display" style="display: none;">
                <canvas id="smart-qr-canvas"></canvas>
                <p class="smart-qr-url"></p>
                <p class="smart-qr-hint">Scan with Hydra to connect node to this object</p>
              </div>
            </div>

            <!-- Scan QR to Connect -->
            <div class="smart-form-group">
              <label>Scan Hydra Node QR:</label>
              <button type="button" class="smart-btn smart-btn-scan" id="smart-scan-qr">
                <span class="scan-icon">📷</span> Scan QR Code
              </button>
              <div id="smart-scanner-container" class="smart-scanner" style="display: none;">
                <video id="smart-scanner-video" autoplay playsinline></video>
                <div class="smart-scanner-overlay">
                  <div class="smart-scanner-frame"></div>
                  <p>Position QR code within frame</p>
                </div>
                <button type="button" class="smart-btn smart-btn-cancel-scan" id="smart-cancel-scan">
                  Cancel
                </button>
              </div>
              <div id="smart-scan-result" class="smart-scan-result" style="display: none;">
                <p class="result-success">✓ Connected to: <span id="smart-connected-node"></span></p>
              </div>
            </div>

            <!-- Discovered Hydra Peers -->
            <div class="smart-form-group">
              <label>Discovered Hydra Peers:</label>
              <div id="smart-hydra-peer-list" class="smart-peer-list">
                <p class="smart-peer-empty">No Hydra peers discovered yet...</p>
              </div>
            </div>
          </section>

          <!-- Connection Log -->
          <section class="smart-modal-section">
            <h3>Connection Log</h3>
            <div class="smart-form-group">
              <div id="smart-connection-log" class="smart-connection-log">
                <p class="log-empty">No connection activity yet...</p>
              </div>
            </div>
          </section>
        </div>

        <div class="smart-modal-footer">
          <button class="smart-btn smart-btn-delete">Delete Object</button>
          <div class="smart-btn-group">
            <button class="smart-btn smart-btn-cancel">Cancel</button>
            <button class="smart-btn smart-btn-save">Save Changes</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    this.modal = modal;

    this._bindEvents();
  }

  /**
   * Bind event handlers
   */
  _bindEvents() {
    // Close button
    const closeBtn = this.modal.querySelector('.smart-modal-close');
    closeBtn.addEventListener('click', () => this.hide());

    // Cancel button
    const cancelBtn = this.modal.querySelector('.smart-btn-cancel');
    cancelBtn.addEventListener('click', () => this.hide());

    // Save button
    const saveBtn = this.modal.querySelector('.smart-btn-save');
    saveBtn.addEventListener('click', () => this._save());

    // Delete button
    const deleteBtn = this.modal.querySelector('.smart-btn-delete');
    deleteBtn.addEventListener('click', () => this._delete());

    // Volume slider
    const volumeSlider = this.modal.querySelector('#smart-audio-volume');
    const volumeValue = this.modal.querySelector('#smart-audio-volume-value');
    volumeSlider.addEventListener('input', (e) => {
      volumeValue.textContent = parseFloat(e.target.value).toFixed(1);
    });

    // Click outside to close
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) {
        this.hide();
      }
    });

    // ESC key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.modal.style.display === 'flex') {
        this.hide();
      }
    });

    // Generate Invite QR button
    const generateInviteBtn = this.modal.querySelector('#smart-generate-invite');
    generateInviteBtn.addEventListener('click', () => this._generateInviteQR());

    // Scan QR button
    const scanBtn = this.modal.querySelector('#smart-scan-qr');
    scanBtn.addEventListener('click', () => this._startQRScanner());

    // Cancel scan button
    const cancelScanBtn = this.modal.querySelector('#smart-cancel-scan');
    cancelScanBtn.addEventListener('click', () => this._stopQRScanner());
  }

  /**
   * Show modal for a Smart Object
   */
  show(smartObject) {
    if (!smartObject) return;

    this.currentObject = smartObject;
    this._populateForm(smartObject);
    this._refreshHydraPeerList();
    this.modal.style.display = 'flex';
  }

  /**
   * Refresh the list of discovered Hydra peers
   */
  _refreshHydraPeerList() {
    const peerListContainer = this.modal.querySelector('#smart-hydra-peer-list');
    if (!peerListContainer) return;

    // Get Hydra peers from hybrid hub via app
    const app = this.mesh?.app;
    const hybridState = app?.hybrid?.state?.hydra;

    if (!hybridState || !hybridState.discovery) {
      peerListContainer.innerHTML = '<p class="smart-peer-empty">Hydra discovery not available. Enable Hydra network in main UI.</p>';
      return;
    }

    // Get peers from the hydra.peers Map
    const peersMap = hybridState.peers || new Map();
    const peers = Array.from(peersMap.values()).filter(p => p && p.nknPub);

    if (peers.length === 0) {
      peerListContainer.innerHTML = '<p class="smart-peer-empty">No Hydra peers discovered yet...</p>';
      return;
    }

    // Build peer list
    peerListContainer.innerHTML = '';
    peers.forEach(peer => {
      const peerItem = document.createElement('div');
      peerItem.className = 'smart-peer-item';

      const peerInfo = document.createElement('div');
      peerInfo.className = 'smart-peer-info';

      const peerName = document.createElement('div');
      peerName.className = 'smart-peer-name';
      peerName.textContent = peer.meta?.name || `Hydra ${peer.nknPub.slice(0, 8)}...`;

      const peerAddr = document.createElement('div');
      peerAddr.className = 'smart-peer-addr';
      peerAddr.textContent = `hydra.${peer.nknPub}`;

      peerInfo.appendChild(peerName);
      peerInfo.appendChild(peerAddr);

      const peerActions = document.createElement('div');
      peerActions.className = 'smart-peer-actions';

      const pingBtn = document.createElement('button');
      pingBtn.className = 'smart-btn smart-btn-small';
      pingBtn.textContent = 'Ping';
      pingBtn.addEventListener('click', () => this._pingHydraPeer(peer));

      const syncBtn = document.createElement('button');
      syncBtn.className = 'smart-btn smart-btn-small smart-btn-primary';
      syncBtn.textContent = 'Sync';
      syncBtn.addEventListener('click', () => this._syncWithHydraPeer(peer));

      peerActions.appendChild(pingBtn);
      peerActions.appendChild(syncBtn);

      peerItem.appendChild(peerInfo);
      peerItem.appendChild(peerActions);

      peerListContainer.appendChild(peerItem);
    });
  }

  /**
   * Ping a Hydra peer to check connectivity
   */
  async _pingHydraPeer(peer) {
    this._log(`Pinging ${peer.nknPub.slice(0, 8)}...`);

    try {
      const app = this.mesh?.app;
      const hybridState = app?.hybrid?.state?.hydra;

      if (!hybridState || !hybridState.discovery) {
        this._log('Error: Hydra discovery not available', 'error');
        return;
      }

      // Send ping via NATS discovery
      await hybridState.discovery.dm(peer.nknPub, {
        type: 'ping',
        from: this.mesh?.selfPub || 'unknown',
        timestamp: Date.now()
      });

      this._log(`✓ Ping sent to ${peer.nknPub.slice(0, 8)}`, 'success');
    } catch (err) {
      this._log(`✗ Ping failed: ${err.message}`, 'error');
      console.error('[SmartModal] Ping error:', err);
    }
  }

  /**
   * Request sync/handshake with a Hydra peer
   */
  async _syncWithHydraPeer(peer) {
    this._log(`Requesting sync with ${peer.nknPub.slice(0, 8)}...`);

    try {
      const app = this.mesh?.app;
      const hybridState = app?.hybrid?.state?.hydra;

      if (!hybridState || !hybridState.discovery || !this.currentObject) {
        this._log('Error: Discovery or Smart Object not available', 'error');
        return;
      }

      const noclipPub = this.mesh?.selfPub || this.mesh?.selfAddr || '';
      if (!noclipPub) {
        this._log('Error: NoClip address not available', 'error');
        return;
      }

      // Send sync request
      const syncRequest = {
        type: 'noclip-bridge-sync-request',
        from: noclipPub,
        noclipAddr: `noclip.${noclipPub}`,
        objectId: this.currentObject.uuid,
        objectConfig: {
          position: this.currentObject.config.position,
          label: this.currentObject.config.mesh?.label?.text || 'Smart Object'
        },
        timestamp: Date.now()
      };

      await hybridState.discovery.dm(peer.nknPub, syncRequest);

      this._log(`✓ Sync request sent to ${peer.nknPub.slice(0, 8)}`, 'success');
      this._log(`Waiting for approval from Hydra user...`, 'info');

      // Store pending sync
      if (!this.currentObject.config._pendingSyncs) {
        this.currentObject.config._pendingSyncs = [];
      }
      this.currentObject.config._pendingSyncs.push({
        hydraPub: peer.nknPub,
        requestedAt: Date.now(),
        status: 'pending'
      });

    } catch (err) {
      this._log(`✗ Sync request failed: ${err.message}`, 'error');
      console.error('[SmartModal] Sync error:', err);
    }
  }

  /**
   * Add a log message to the connection log
   */
  _log(message, type = 'info') {
    const logContainer = this.modal.querySelector('#smart-connection-log');
    if (!logContainer) return;

    // Remove empty placeholder if present
    const emptyMsg = logContainer.querySelector('.log-empty');
    if (emptyMsg) {
      emptyMsg.remove();
    }

    const logEntry = document.createElement('div');
    logEntry.className = `log-entry log-${type}`;

    const timestamp = document.createElement('span');
    timestamp.className = 'log-timestamp';
    const now = new Date();
    timestamp.textContent = `[${now.toLocaleTimeString()}]`;

    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = message;

    logEntry.appendChild(timestamp);
    logEntry.appendChild(text);

    logContainer.appendChild(logEntry);

    // Auto-scroll to bottom
    logContainer.scrollTop = logContainer.scrollHeight;

    // Limit log entries to 50
    const entries = logContainer.querySelectorAll('.log-entry');
    if (entries.length > 50) {
      entries[0].remove();
    }
  }

  /**
   * Hide modal
   */
  hide() {
    this.modal.style.display = 'none';
    this.currentObject = null;

    if (this.onClose) {
      this.onClose();
    }
  }

  /**
   * Populate form with object data
   */
  _populateForm(obj) {
    const config = obj.config;

    // Basic info
    this.modal.querySelector('#smart-uuid').value = config.uuid || '';
    this.modal.querySelector('#smart-label-text').value = config.mesh?.label?.text || '';
    this.modal.querySelector('#smart-color').value = config.mesh?.color || '#5ee3a6';

    // Audio source
    this.modal.querySelector('#smart-audio-enabled').checked = config.sources?.audio?.enabled || false;
    this.modal.querySelector('#smart-audio-node-id').value = config.sources?.audio?.nodeId || '';
    this.modal.querySelector('#smart-audio-volume').value = config.sources?.audio?.volume || 1.0;
    this.modal.querySelector('#smart-audio-volume-value').textContent = (config.sources?.audio?.volume || 1.0).toFixed(1);
    this.modal.querySelector('#smart-audio-max-distance').value = config.sources?.audio?.maxDistance || 50;

    // Text source
    this.modal.querySelector('#smart-text-enabled').checked = config.sources?.text?.enabled || false;
    this.modal.querySelector('#smart-text-node-id').value = config.sources?.text?.nodeId || '';
    this.modal.querySelector('#smart-text-mode').value = config.sources?.text?.updateMode || 'delta';

    // Audio input
    this.modal.querySelector('#smart-mic-enabled').checked = config.audioInput?.enabled || false;
    this.modal.querySelector('#smart-mic-target-id').value = config.audioInput?.targetNodeId || '';
    this.modal.querySelector('#smart-mic-distance').value = config.audioInput?.triggerDistance || 5;
    this.modal.querySelector('#smart-mic-mode').value = config.audioInput?.activationMode || 'proximity';

    // Privacy
    this.modal.querySelector('#smart-visibility').value = config.visibility || 'public';
  }

  /**
   * Save changes
   */
  _save() {
    if (!this.currentObject) return;

    const updates = {
      mesh: {
        ...this.currentObject.config.mesh,
        label: {
          ...this.currentObject.config.mesh?.label,
          text: this.modal.querySelector('#smart-label-text').value
        },
        color: this.modal.querySelector('#smart-color').value
      },
      sources: {
        audio: {
          enabled: this.modal.querySelector('#smart-audio-enabled').checked,
          nodeId: this.modal.querySelector('#smart-audio-node-id').value,
          volume: parseFloat(this.modal.querySelector('#smart-audio-volume').value),
          maxDistance: parseInt(this.modal.querySelector('#smart-audio-max-distance').value),
          spatialBlend: 1.0,
          rolloffFactor: 1
        },
        text: {
          enabled: this.modal.querySelector('#smart-text-enabled').checked,
          nodeId: this.modal.querySelector('#smart-text-node-id').value,
          updateMode: this.modal.querySelector('#smart-text-mode').value
        }
      },
      audioInput: {
        enabled: this.modal.querySelector('#smart-mic-enabled').checked,
        targetNodeId: this.modal.querySelector('#smart-mic-target-id').value,
        triggerDistance: parseInt(this.modal.querySelector('#smart-mic-distance').value),
        activationMode: this.modal.querySelector('#smart-mic-mode').value
      },
      visibility: this.modal.querySelector('#smart-visibility').value
    };

    // Update object
    this.smartObjects.updateSmartObject(this.currentObject.uuid, updates);

    // Update visual appearance
    if (updates.mesh.color !== this.currentObject.config.mesh?.color) {
      this.currentObject.mesh.material.color.set(updates.mesh.color);
      this.currentObject.mesh.material.emissive.set(updates.mesh.color);
    }

    console.log('[SmartModal] Saved changes for', this.currentObject.uuid);

    this.hide();
  }

  /**
   * Delete object
   */
  _delete() {
    if (!this.currentObject) return;

    const confirmed = confirm('Are you sure you want to delete this Smart Object?');
    if (!confirmed) return;

    this.smartObjects.deleteSmartObject(this.currentObject.uuid);

    console.log('[SmartModal] Deleted object', this.currentObject.uuid);

    this.hide();
  }

  /**
   * Generate invite QR code for this Smart Object
   */
  async _generateInviteQR() {
    if (!this.currentObject || !this.mesh) return;

    try {
      const networkSelect = this.modal.querySelector('#smart-invite-network');
      const network = networkSelect.value; // 'noclip' or 'hydra'
      const objectUUID = this.currentObject.uuid;
      const noclipPub = this.mesh.selfPub || this.mesh.selfAddr || '';

      if (!noclipPub) {
        alert('Error: NoClip address not available');
        return;
      }

      // Generate URL with object UUID as parameter
      let baseUrl = network === 'hydra'
        ? 'https://hydras.nexus/'
        : 'https://noclip.nexus/';

      const url = `${baseUrl}?noclip=noclip.${noclipPub}&object=${objectUUID}`;

      // Generate QR code using qrcode library (need to load via CDN)
      const canvas = this.modal.querySelector('#smart-qr-canvas');
      const qrDisplay = this.modal.querySelector('#smart-invite-qr');
      const qrUrl = this.modal.querySelector('.smart-qr-url');

      // Check if QRCode library is available
      if (typeof QRCode === 'undefined') {
        // Fallback: show URL
        qrUrl.textContent = url;
        qrDisplay.style.display = 'block';
        console.warn('[SmartModal] QRCode library not loaded, showing URL only');
        return;
      }

      // Generate QR code
      QRCode.toCanvas(canvas, url, {
        width: 256,
        margin: 2,
        color: {
          dark: '#5ee3a6',
          light: '#0f1118'
        }
      }, (error) => {
        if (error) {
          console.error('[SmartModal] QR generation error:', error);
          qrUrl.textContent = url;
        } else {
          qrUrl.textContent = url;
          qrDisplay.style.display = 'block';
        }
      });

    } catch (err) {
      console.error('[SmartModal] Failed to generate invite QR:', err);
      alert('Failed to generate QR code');
    }
  }

  /**
   * Start QR code scanner
   */
  async _startQRScanner() {
    try {
      const scannerContainer = this.modal.querySelector('#smart-scanner-container');
      const video = this.modal.querySelector('#smart-scanner-video');

      // Request camera access
      this.scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' }
      });

      video.srcObject = this.scannerStream;
      scannerContainer.style.display = 'block';

      // Start scanning loop
      this._scanQRCode(video);

    } catch (err) {
      console.error('[SmartModal] Camera access error:', err);
      alert('Camera access denied or not available');
    }
  }

  /**
   * Scan QR code from video stream
   */
  _scanQRCode(video) {
    // Check if jsQR library is available
    if (typeof jsQR === 'undefined') {
      console.error('[SmartModal] jsQR library not loaded');
      alert('QR scanner library not available');
      this._stopQRScanner();
      return;
    }

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');

    const scan = () => {
      if (!this.scannerStream) return; // Stopped

      if (video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height, {
          inversionAttempts: 'dontInvert'
        });

        if (code) {
          // QR code detected!
          this._handleScannedQR(code.data);
          this._stopQRScanner();
          return;
        }
      }

      this.scannerAnimationFrame = requestAnimationFrame(scan);
    };

    scan();
  }

  /**
   * Stop QR scanner
   */
  _stopQRScanner() {
    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach(track => track.stop());
      this.scannerStream = null;
    }

    if (this.scannerAnimationFrame) {
      cancelAnimationFrame(this.scannerAnimationFrame);
      this.scannerAnimationFrame = null;
    }

    const scannerContainer = this.modal.querySelector('#smart-scanner-container');
    if (scannerContainer) {
      scannerContainer.style.display = 'none';
    }
  }

  /**
   * Handle scanned QR code data
   */
  _handleScannedQR(qrData) {
    try {
      console.log('[SmartModal] Scanned QR:', qrData);

      // Parse URL
      const url = new URL(qrData);

      // Check for hydra parameter (from Hydra graph)
      const hydraParam = url.searchParams.get('hydra');
      const nodeParam = url.searchParams.get('node');

      if (hydraParam) {
        // Format: hydra.<hex> or just hex
        const parts = hydraParam.split('.');
        const hydraPub = parts.length === 2 ? parts[1] : hydraParam;

        // Extract node ID if provided
        const nodeId = nodeParam || `hydra-node-${hydraPub.slice(0, 8)}`;

        // Update form with scanned data
        this._bindHydraNode(hydraPub, nodeId);

        // Show success message
        const scanResult = this.modal.querySelector('#smart-scan-result');
        const connectedNode = this.modal.querySelector('#smart-connected-node');
        connectedNode.textContent = nodeId;
        scanResult.style.display = 'block';

        // Hide after 3 seconds
        setTimeout(() => {
          scanResult.style.display = 'none';
        }, 3000);

      } else {
        throw new Error('Invalid QR code: missing hydra parameter');
      }

    } catch (err) {
      console.error('[SmartModal] Failed to parse QR code:', err);
      alert('Invalid QR code format');
    }
  }

  /**
   * Bind Hydra node to current Smart Object
   */
  _bindHydraNode(hydraPub, nodeId) {
    if (!this.currentObject) return;

    // Auto-fill the audio source node ID
    const audioNodeInput = this.modal.querySelector('#smart-audio-node-id');
    if (audioNodeInput) {
      audioNodeInput.value = nodeId;
    }

    // Auto-enable audio if not already enabled
    const audioEnabled = this.modal.querySelector('#smart-audio-enabled');
    if (audioEnabled && !audioEnabled.checked) {
      audioEnabled.checked = true;
    }

    // Store Hydra peer info
    if (!this.currentObject.config.connectedNodes) {
      this.currentObject.config.connectedNodes = [];
    }

    this.currentObject.config.connectedNodes.push({
      hydraPub,
      nodeId,
      connectedAt: Date.now()
    });

    console.log(`[SmartModal] Bound Hydra node ${nodeId} to object ${this.currentObject.uuid}`);
  }

  /**
   * Cleanup
   */
  dispose() {
    // Stop scanner if running
    this._stopQRScanner();

    if (this.modal && this.modal.parentNode) {
      this.modal.parentNode.removeChild(this.modal);
    }
  }
}

export { SmartObjectModal };
