import { clampLat, worldToLatLon, wrapLon } from './geolocate.js';

const DEFAULT_CENTER = { lat: 37.7749, lon: -122.4194, zoom: 13 };

function clampLon(lon) {
  return wrapLon(Number.isFinite(lon) ? lon : 0);
}

function toLeafletLatLng({ lat, lon, lng }) {
  const latitude = clampLat(Number.isFinite(lat) ? lat : 0);
  const longitude = clampLon(Number.isFinite(lon) ? lon : lng);
  return [latitude, longitude];
}

export class MiniMap {
  constructor({
    mapContainer,
    statusEl,
    recenterBtn,
    setBtn,
    moveBtn,
    snapBtn,
    tileManager,
    getWorldPosition,
    getHeadingDeg,
    getCompassHeadingRad,
    isSnapActive,
    getPeers,
    onCommitLocation,
    onRequestAuto,
    onRequestTeleport,
    onRequestSnap,
  } = {}) {
    this.mapContainer = mapContainer || null;
    this.statusEl = statusEl || null;
    this.recenterBtn = recenterBtn || null;
    this.setBtn = setBtn || null;
    this.moveBtn = moveBtn || null;
    this.snapBtn = snapBtn || null;
    this.tileManager = tileManager || null;
    this.getWorldPosition = typeof getWorldPosition === 'function' ? getWorldPosition : null;
    this.getHeadingDeg = typeof getHeadingDeg === 'function' ? getHeadingDeg : () => 0;
    this.getCompassHeadingRad = typeof getCompassHeadingRad === 'function' ? getCompassHeadingRad : null;
    this.isSnapActive = typeof isSnapActive === 'function' ? isSnapActive : null;
    this.getPeers = typeof getPeers === 'function' ? getPeers : null;
    this.onCommitLocation = typeof onCommitLocation === 'function' ? onCommitLocation : null;
    this.onRequestAuto = typeof onRequestAuto === 'function' ? onRequestAuto : null;
    this.onRequestTeleport = typeof onRequestTeleport === 'function' ? onRequestTeleport : null;
    this.onRequestSnap = typeof onRequestSnap === 'function' ? onRequestSnap : null;

    this.followEnabled = true;
    this.userHasPanned = false;
    this.activeSource = 'unknown';
    this.currentLatLon = null;
    this.viewCenter = null;
    this.peerMarkers = new Map();
    this._lastFollowLatLon = null;
    this._autoFollowThreshold = 0.0001; // ≈10–12 m on Earth
    this._followRecenterThreshold = 0.00005;
    this._followRecenterThresholdSq = this._followRecenterThreshold * this._followRecenterThreshold;
    this._presentationModes = ['heading', 'north', 'free'];
    this._presentationIndex = this._presentationModes.indexOf('north');
    this._presentationMode = this._presentationModes[Math.max(0, this._presentationIndex)];
    this._presentationBtn = null;
    this._rotatablePaneNames = [
      'mapPane',
      'tilePane',
      'shadowPane',
      'overlayPane',
      'markerPane',
      'tooltipPane',
      'popupPane',
    ];
    this._mapRotationDeg = 0;
    this._lastHeadingDeg = 0;
    this._pendingHeadingDeg = null;
    this._headingCssCurrent = null;
    this._pendingTeleport = null;
    this._moveArmed = false;
    this._longPressTimer = null;
    this._longPressOrigin = null;
    this._longPressMs = 550;
    this._longPressTolerancePx = 14;
    this._snapEngaged = false;
    this._autoFollowSuspendedUntil = 0;
    this._manualOverrideActive = false;

    this.map = null;
    this.playerMarker = null;
    this.peerLayer = null;

    this._initMap();

    this.recenterBtn?.addEventListener('click', () => {
      this._setFollow(true, { triggerAuto: true, resetManual: true });
    });

    this.setBtn?.addEventListener('click', () => {
      if (!this.viewCenter || !this.onCommitLocation) return;
      this.onCommitLocation({ lat: this.viewCenter.lat, lon: this.viewCenter.lon });
    });

    this.moveBtn?.addEventListener('click', () => this._handleMoveRequest());
    this.snapBtn?.addEventListener('click', () => this._handleSnapRequest());

    this._updateFollowButton();
    this._updateMoveButton();
    this._updateSnapButton();
  }

  _initMap() {
    if (!this.mapContainer || typeof window === 'undefined' || !window.L) return;

    this.map = window.L.map(this.mapContainer, {
      center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lon],
      zoom: DEFAULT_CENTER.zoom,
      zoomControl: true,
      attributionControl: false,
    });

    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
    }).addTo(this.map);

    this.peerLayer = window.L.layerGroup().addTo(this.map);
    const icon = window.L.divIcon({
      className: 'leaflet-div-icon minimap-player-icon',
      html: '<div class="minimap-player-marker"></div>',
      iconSize: [28, 28],
      iconAnchor: [14, 14],
    });
    this.playerMarker = window.L.marker([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon], {
      icon,
      interactive: false,
      keyboard: false,
      bubblingMouseEvents: false,
    }).addTo(this.map);
    this.playerMarker.on('add', () => {
      const pending = Number.isFinite(this._pendingHeadingDeg)
        ? this._pendingHeadingDeg
        : (typeof this.getHeadingDeg === 'function' ? this.getHeadingDeg() : null);
      if (Number.isFinite(pending)) {
        this._pendingHeadingDeg = null;
        this._applyPlayerHeading(pending);
      }
    });

    const mouseToLatLng = (src) => {
      if (!src) return null;
      try { return this.map.mouseEventToLatLng(src); } catch { return null; }
    };

    const getContainerPoint = (ev) => {
      if (ev?.containerPoint) return ev.containerPoint;
      const orig = ev?.originalEvent;
      if (!orig) return null;
      const pick = (src) => {
        if (!src) return null;
        const rect = this.map.getContainer().getBoundingClientRect();
        const x = src.clientX - rect.left;
        const y = src.clientY - rect.top;
        return window.L.point(x, y);
      };

      if (orig.touches && orig.touches.length) return pick(orig.touches[0]);
      if (orig.changedTouches && orig.changedTouches.length) return pick(orig.changedTouches[0]);
      if (typeof orig.clientX === 'number' && typeof orig.clientY === 'number') return pick(orig);
      return null;
    };

    const getLatLng = (ev) => {
      if (ev?.latlng) return ev.latlng;
      const orig = ev?.originalEvent;
      if (orig) {
        const touchSrc = orig.touches?.length ? orig.touches[0]
          : (orig.changedTouches?.length ? orig.changedTouches[0] : orig);
        const viaMouse = mouseToLatLng(touchSrc);
        if (viaMouse) return viaMouse;
      }
      const pt = getContainerPoint(ev);
      if (!pt) return null;
      try {
        return this.map.containerPointToLatLng(pt);
      } catch {
        return null;
      }
    };

    const cancelLongPress = () => {
      if (this._longPressTimer) {
        clearTimeout(this._longPressTimer);
        this._longPressTimer = null;
      }
      this._longPressOrigin = null;
    };

    const armFromEvent = (ev) => {
      const latlng = getLatLng(ev);
      if (!latlng) return;
      cancelLongPress();
      this._armMoveTarget(latlng);
    };

    const scheduleLongPress = (ev) => {
      if (!this.map) return;
      cancelLongPress();
      const latlng = getLatLng(ev);
      if (!latlng) return;
      const pt = getContainerPoint(ev);
      this._longPressOrigin = { latlng, point: pt };
      this._longPressTimer = setTimeout(() => {
        this._longPressTimer = null;
        this._longPressOrigin = null;
        this._armMoveTarget(latlng);
      }, this._longPressMs);
    };

    const handleMoveDuringPress = (ev) => {
      if (!this._longPressTimer || !this._longPressOrigin) return;
      const pt = getContainerPoint(ev);
      if (!pt || !this._longPressOrigin.point) return;
      const dx = pt.x - this._longPressOrigin.point.x;
      const dy = pt.y - this._longPressOrigin.point.y;
      if ((dx * dx + dy * dy) > (this._longPressTolerancePx * this._longPressTolerancePx)) {
        cancelLongPress();
      }
    };

    this.map.on('movestart', () => {
      if (this._presentationMode !== 'free') {
        this._setPresentationMode('free', { enforceFollow: false });
        if (this.followEnabled) this._setFollow(false);
      } else if (this.followEnabled) {
        this._setFollow(false);
      }
      this.userHasPanned = true;
      cancelLongPress();
    });

    this.map.on('moveend', () => {
      const center = this.map.getCenter();
      this.viewCenter = { lat: clampLat(center.lat), lon: clampLon(center.lng) };
      this._updateMoveButton();
    });

    this.map.on('zoomend', () => this._updateMoveButton());

    this.map.on('mousedown', scheduleLongPress);
    this.map.on('touchstart', scheduleLongPress);
    this.map.on('pointerdown', scheduleLongPress);
    this.map.on('mouseup', cancelLongPress);
    this.map.on('touchend', cancelLongPress);
    this.map.on('touchcancel', cancelLongPress);
    this.map.on('pointerup', cancelLongPress);
    this.map.on('pointercancel', cancelLongPress);
    this.map.on('mouseout', cancelLongPress);
    this.map.on('dragstart', cancelLongPress);
    this.map.on('mousemove', handleMoveDuringPress);
    this.map.on('touchmove', handleMoveDuringPress);
    this.map.on('pointermove', handleMoveDuringPress);
    this.map.on('click', (ev) => armFromEvent(ev));
    this.map.on('contextmenu', (ev) => {
      ev?.originalEvent?.preventDefault?.();
      cancelLongPress();
      armFromEvent(ev);
    });

    this._setupPaneRotationHooks();
    this._installPresentationButton();
    this._syncPresentationState();
  }

  update() {
    if (!this.tileManager?.origin) return;

    let latLon = null;
    const worldPos = this.getWorldPosition?.();
    if (worldPos) {
      latLon = this._worldToLatLon(worldPos.x, worldPos.z);
    }

    if (latLon) {
      this.currentLatLon = latLon;
      this._maybeAutoFollow(latLon);
      if (this.playerMarker) this.playerMarker.setLatLng(toLeafletLatLng(latLon));

      if (this.followEnabled && this.map) {
        this._maybeRecenterMap(latLon, { animate: false });
      }
    }

    const heading = this.getHeadingDeg ? this.getHeadingDeg() : 0;
    this._applyPlayerHeading(heading);

    this._updatePeers();
    this._updateMoveButton();
    this._updateSnapButton();
  }

  notifyLocationChange({ lat, lon, source, detail } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const entry = { lat: clampLat(lat), lon: clampLon(lon) };
    this.currentLatLon = entry;
    this.activeSource = source || this.activeSource;
    const teleported = detail?.teleport === true;
    if (source === 'manual' || detail?.manual === true || teleported) {
      this._manualOverrideActive = true;
      this._suspendAutoFollow(teleported ? 25000 : 15000);
      this._lastFollowLatLon = { ...entry };
    } else if (source && source !== 'manual') {
      this._manualOverrideActive = false;
    }

    if (this.playerMarker) this.playerMarker.setLatLng(toLeafletLatLng(entry));
    if (this.map && (this.followEnabled || teleported)) {
      this._maybeRecenterMap(entry, { animate: !teleported, force: teleported });
    }

    if (!this.followEnabled && !this.viewCenter) {
      this.viewCenter = { ...entry };
    }

    this._setStatus(this.activeSource, entry.lat, entry.lon);
    const heading = this.getHeadingDeg ? this.getHeadingDeg() : null;
    if (Number.isFinite(heading)) this._applyPlayerHeading(heading);
    this._updateMoveButton();
    this._updateSnapButton();
    if (teleported) this._disarmMoveTarget(true);
  }

  forceRedraw() {
    this.map?.invalidateSize?.();
  }

  _worldToLatLon(x, z) {
    const origin = this.tileManager?.origin;
    if (!origin) return null;
    const ll = worldToLatLon(x, z, origin.lat, origin.lon);
    if (!ll) return null;
    return { lat: clampLat(ll.lat), lon: clampLon(ll.lon) };
  }

  _setFollow(enabled, { triggerAuto = true, resetManual = false, skipModeUpdate = false } = {}) {
    if (this.followEnabled === enabled) return;
    this.followEnabled = !!enabled;
    if (!skipModeUpdate) {
      if (!this.followEnabled && this._presentationMode !== 'free') {
        this._presentationMode = 'free';
        this._presentationIndex = this._presentationModes.indexOf('free');
      } else if (this.followEnabled && this._presentationMode === 'free') {
        this._presentationIndex = this._presentationModes.indexOf('north');
        this._presentationMode = this._presentationModes[Math.max(0, this._presentationIndex)];
      }
    }
    if (this.followEnabled) {
      this.userHasPanned = false;
      if (this.currentLatLon) this.viewCenter = { ...this.currentLatLon };
      this._centerOnPlayer(true);
      if (triggerAuto && typeof this.onRequestAuto === 'function') {
        this._manualOverrideActive = false;
        this.onRequestAuto();
      } else if (resetManual) {
        this._manualOverrideActive = false;
      }
      this._suspendAutoFollow(1000);
    } else {
      this._suspendAutoFollow(2000);
    }
    this._lastFollowLatLon = this.currentLatLon ? { ...this.currentLatLon } : null;
    this._updateFollowButton();
    this._updateMoveButton();
    if (!skipModeUpdate) this._syncPresentationState({ enforceFollow: false });
  }

  _centerOnPlayer(force = false) {
    if (!this.map || !this.currentLatLon) return;
    this._maybeRecenterMap(this.currentLatLon, { animate: !force, force: true });
    this.userHasPanned = false;
    this._updateMoveButton();
  }

  _handleMoveRequest() {
    if (!this.moveBtn || this.moveBtn.disabled) return;
    if (!this._pendingTeleport || typeof this.onRequestTeleport !== 'function') return;
    const { lat, lon } = this._pendingTeleport;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this._manualOverrideActive = true;
    this._suspendAutoFollow(20000);
    this.onRequestTeleport({ lat, lon });
    this.moveBtn?.blur?.();
    this._disarmMoveTarget(true);
  }

  _handleSnapRequest() {
    if (!this.snapBtn || this.snapBtn.disabled) return;
    if (typeof this.onRequestSnap !== 'function') return;
    const headingRad = this.getCompassHeadingRad?.();
    if (!Number.isFinite(headingRad)) return;
    const res = this.onRequestSnap({ headingRad });
    if (res && typeof res.then === 'function') {
      this._snapEngaged = true;
      res.finally(() => this._updateSnapButton());
    } else if (res) {
      this._snapEngaged = true;
    } else {
      this._snapEngaged = false;
    }
    this.snapBtn?.blur?.();
    this._updateSnapButton();
  }

  _updateMoveButton() {
    if (!this.moveBtn) return;
    const armed = !!(this._moveArmed && this._pendingTeleport);
    this.moveBtn.disabled = !armed;
    this.moveBtn.setAttribute('aria-disabled', armed ? 'false' : 'true');
    this.moveBtn.classList.toggle('armed', armed);
    if (armed) {
      const { lat, lon } = this._pendingTeleport;
      if (this.moveBtn) {
        this.moveBtn.dataset.lat = lat.toFixed(5);
        this.moveBtn.dataset.lon = lon.toFixed(5);
      }
      this.moveBtn.title = `Teleport to ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    } else {
      if (this.moveBtn) {
        delete this.moveBtn.dataset.lat;
        delete this.moveBtn.dataset.lon;
      }
      this.moveBtn.title = 'Tap and hold on the mini-map to choose a destination';
    }
  }

  _updateSnapButton() {
    if (!this.snapBtn) return;
    const heading = this.getCompassHeadingRad?.();
    const headingReady = Number.isFinite(heading);
    const snapActive = Boolean(this.isSnapActive?.());
    if (snapActive) this._snapEngaged = true;
    if (!snapActive && this._snapEngaged) this._snapEngaged = false;
    const engaged = snapActive || this._snapEngaged;
    this.snapBtn.classList.toggle('busy', engaged);
    const disabled = !headingReady || engaged;
    this.snapBtn.disabled = disabled;
    this.snapBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    if (headingReady) {
      this.snapBtn.title = engaged ? 'Snapping to compass heading…' : 'Align view with compass heading';
    } else {
      this.snapBtn.title = 'Compass heading unavailable';
    }
  }

  _updateFollowButton() {
    if (!this.recenterBtn) return;
    this.recenterBtn.textContent = this.followEnabled ? 'Follow: On' : 'Follow: Off';
    this.recenterBtn.setAttribute('aria-pressed', this.followEnabled ? 'true' : 'false');
  }

  _updatePeers() {
    if (!this.peerLayer || !this.getPeers) return;
    const peers = this.getPeers() || [];
    const keep = new Set();

    for (let i = 0; i < peers.length; i++) {
      const peer = peers[i];
      if (!Number.isFinite(peer.lat) || !Number.isFinite(peer.lon)) continue;
      const key = `${peer.lat.toFixed(5)},${peer.lon.toFixed(5)}:${peer.label || i}`;
      keep.add(key);
      let marker = this.peerMarkers.get(key);
      if (!marker) {
        marker = window.L.circleMarker([peer.lat, peer.lon], {
          radius: 4,
          color: '#5ec8ff',
          weight: 1,
          fillColor: '#5ec8ff',
          fillOpacity: 0.8,
        });
        if (peer.label) marker.bindTooltip(peer.label, { direction: 'top', offset: [0, -6] });
        marker.addTo(this.peerLayer);
        this.peerMarkers.set(key, marker);
      } else {
        marker.setLatLng([peer.lat, peer.lon]);
      }
    }

    for (const [key, marker] of this.peerMarkers.entries()) {
      if (keep.has(key)) continue;
      this.peerLayer.removeLayer(marker);
      this.peerMarkers.delete(key);
    }
  }

  _suspendAutoFollow(ms = 10000) {
    const now = Date.now();
    const extend = Math.max(0, ms);
    const target = now + extend;
    if (target > this._autoFollowSuspendedUntil) this._autoFollowSuspendedUntil = target;
  }

  _setStatus(source, lat, lon) {
    if (!this.statusEl) return;
    let label = 'Location pending';
    switch (source) {
      case 'manual': label = 'Manual override active'; break;
      case 'device': label = 'Live GPS lock'; break;
      case 'ip': label = 'Approximate location (IP geolocate)'; break;
      case 'autopilot': label = 'Autopilot following route'; break;
      default: label = 'Location pending';
    }
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      label += ` · ${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }
    this.statusEl.textContent = label;
  }

  _armMoveTarget(latlng) {
    if (!latlng) return;
    const entry = { lat: clampLat(latlng.lat), lon: clampLon(latlng.lng ?? latlng.lon) };
    if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lon)) return;
    this._pendingTeleport = entry;
    this._moveArmed = true;
    this._suspendAutoFollow(12000);
    this._setFollow(false);
    try {
      this.map?.setView?.([entry.lat, entry.lon], this.map?.getZoom?.() ?? DEFAULT_CENTER.zoom, { animate: true });
    } catch {}
    this.viewCenter = { ...entry };
    this.userHasPanned = false;
    this._updateMoveButton();
  }

  _disarmMoveTarget(silent = false) {
    this._pendingTeleport = null;
    this._moveArmed = false;
    if (!silent) this.moveBtn?.blur?.();
    this._updateMoveButton();
  }

  _maybeAutoFollow(latLon) {
    if (this.followEnabled) return;
    if (!latLon) return;
    const now = Date.now();
    if (this._manualOverrideActive) return;
    if (now < this._autoFollowSuspendedUntil) return;
    if (!this._lastFollowLatLon) {
      this._lastFollowLatLon = { ...latLon };
      return;
    }
    const dLat = latLon.lat - this._lastFollowLatLon.lat;
    const dLon = latLon.lon - this._lastFollowLatLon.lon;
    const dist = Math.sqrt(dLat * dLat + dLon * dLon);
    if (dist >= this._autoFollowThreshold) {
      const triggerAuto = this.activeSource !== 'manual';
      this._setFollow(true, { triggerAuto });
    }
  }

  _cyclePresentationMode() {
    const next = (this._presentationIndex + 1) % this._presentationModes.length;
    this._setPresentationMode(this._presentationModes[next]);
  }

  _setPresentationMode(mode, { enforceFollow = true } = {}) {
    if (!this._presentationModes.includes(mode)) mode = 'north';
    if (this._presentationMode === mode) {
      if (enforceFollow) this._syncPresentationState();
      return;
    }
    this._presentationMode = mode;
    this._presentationIndex = this._presentationModes.indexOf(mode);
    this._syncPresentationState({ enforceFollow });
  }

  _installPresentationButton() {
    if (!this.map) return;
    const container = this.map.getContainer();
    if (!container) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'minimap-mode-btn';
    btn.textContent = '';
    btn.style.position = 'absolute';
    btn.style.top = '8px';
    btn.style.right = '8px';
    btn.style.zIndex = '410';
    btn.style.padding = '6px 10px';
    btn.style.border = '1px solid rgba(255,255,255,0.45)';
    btn.style.background = 'rgba(20,20,20,0.65)';
    btn.style.color = '#f5f5f5';
    btn.style.font = '600 12px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    btn.style.borderRadius = '6px';
    btn.style.cursor = 'pointer';
    btn.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    btn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this._cyclePresentationMode();
    });
    container.appendChild(btn);
    this._presentationBtn = btn;
    this._updatePresentationUi();
  }

  _updatePresentationUi() {
    if (!this._presentationBtn) return;
    const label = (() => {
      switch (this._presentationMode) {
        case 'heading': return 'Follow · Heading';
        case 'free': return 'Explore · Free';
        default: return 'Follow · North';
      }
    })();
    this._presentationBtn.textContent = label;
  }

  _setupPaneRotationHooks() {
    if (!this.map) return;
    const record = () => {
      this._recordPaneBaseTransforms();
      this._applyMapRotation(this._mapRotationDeg);
    };
    this.map.whenReady(record);
    this.map.on('move', record);
    this.map.on('zoom', record);
    this.map.on('zoomend', record);
  }

  _recordPaneBaseTransforms() {
    if (!this.map) return;
    const stripRotate = (value) => (value || '').replace(/rotate\([^)]*\)/g, '').trim();
    for (const name of this._rotatablePaneNames) {
      const pane = this.map.getPane(name);
      if (!pane) continue;
      const base = stripRotate(pane.style.transform || '');
      pane.dataset.minimapBaseTransform = base;
      if (pane.style.transform !== base) pane.style.transform = base;
      pane.style.transformOrigin = '50% 50%';
    }
  }

  _setMapRotation(deg) {
    const value = Number.isFinite(deg) ? deg : 0;
    if (Math.abs(value - this._mapRotationDeg) < 0.01) {
      this._mapRotationDeg = value;
      this._applyMapRotation(this._mapRotationDeg);
      return;
    }
    this._mapRotationDeg = value;
    this._applyMapRotation(this._mapRotationDeg);
  }

  _applyMapRotation(deg) {
    if (!this.map) return;
    const rotation = Number.isFinite(deg) ? deg : 0;
    for (const name of this._rotatablePaneNames) {
      const pane = this.map.getPane(name);
      if (!pane) continue;
      const base = pane.dataset.minimapBaseTransform || '';
      const transform = Math.abs(rotation) < 0.01 ? base : `${base} rotate(${rotation}deg)`.trim();
      if (pane.style.transform !== transform) pane.style.transform = transform;
      pane.style.transformOrigin = '50% 50%';
    }
  }

  _syncPresentationState({ enforceFollow = true } = {}) {
    const mode = this._presentationMode;
    if (mode === 'heading') {
      if (enforceFollow && !this.followEnabled) {
        this._setFollow(true, { triggerAuto: false, resetManual: true, skipModeUpdate: true });
      }
      this._setMapRotation(this._lastHeadingDeg);
    } else if (mode === 'north') {
      if (enforceFollow && !this.followEnabled) {
        this._setFollow(true, { triggerAuto: false, resetManual: true, skipModeUpdate: true });
      }
      this._setMapRotation(0);
    } else {
      if (enforceFollow && this.followEnabled) {
        this._setFollow(false, { triggerAuto: false, resetManual: false, skipModeUpdate: true });
      }
      this._setMapRotation(0);
    }
    this._updatePresentationUi();
  }

  _needsFollowRecentre(latLon, { force = false } = {}) {
    if (force) return true;
    if (!latLon) return false;
    const center = this.viewCenter;
    if (!center || !Number.isFinite(center.lat) || !Number.isFinite(center.lon)) return true;
    const dLat = latLon.lat - center.lat;
    const dLon = latLon.lon - center.lon;
    const distSq = (dLat * dLat) + (dLon * dLon);
    const thresholdSq = this._followRecenterThresholdSq ?? (this._followRecenterThreshold * this._followRecenterThreshold) ?? 0;
    if (thresholdSq <= 0) return distSq > 0;
    return distSq >= thresholdSq;
  }

  _maybeRecenterMap(latLon, { animate = false, force = false } = {}) {
    if (!this.map || !latLon) return;
    const lat = clampLat(Number.isFinite(latLon.lat) ? latLon.lat : 0);
    const lonValue = Number.isFinite(latLon.lon) ? latLon.lon
      : (Number.isFinite(latLon.lng) ? latLon.lng : 0);
    const lon = clampLon(lonValue);
    const target = { lat, lon };
    if (!this._needsFollowRecentre(target, { force })) return;
    const zoom = this.map.getZoom?.() || DEFAULT_CENTER.zoom;
    this.map.setView([target.lat, target.lon], zoom, { animate });
    this.viewCenter = { ...target };
  }

  _applyPlayerHeading(deg) {
    if (!Number.isFinite(deg)) return;
    const markerEl = this.playerMarker?.getElement?.();
    if (!markerEl) {
      this._pendingHeadingDeg = deg;
      return;
    }

    const marker = markerEl.querySelector('.minimap-player-marker');
    if (!marker) return;

    const normalized = ((deg % 360) + 360) % 360;
    let signed = normalized;
    if (signed > 180) signed -= 360;
    const target = -signed;

    this._lastHeadingDeg = target;

    if (this._presentationMode === 'heading') {
      this._setMapRotation(this._lastHeadingDeg);
      marker.style.transform = `rotate(${(-this._lastHeadingDeg)}deg)`;
      this._headingCssCurrent = -this._lastHeadingDeg;
      return;
    }

    if (Math.abs(this._mapRotationDeg) > 0.01) {
      this._setMapRotation(0);
    }

    if (!Number.isFinite(this._headingCssCurrent)) {
      this._headingCssCurrent = target;
    } else {
      let delta = target - this._headingCssCurrent;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;
      this._headingCssCurrent += delta;
    }

    marker.style.transform = `rotate(${this._headingCssCurrent}deg)`;
    if (this._headingCssCurrent > 720 || this._headingCssCurrent < -720) {
      const wrapped = ((this._headingCssCurrent % 360) + 360) % 360;
      this._headingCssCurrent = wrapped > 180 ? wrapped - 360 : wrapped;
    }
    this._pendingHeadingDeg = null;
  }
}
