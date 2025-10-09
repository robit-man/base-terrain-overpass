import { clampLat, worldToLatLon, wrapLon, metresPerDegree } from './geolocate.js';

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
    selectBtn,
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
    onRegionSelected,
  } = {}) {
    this.mapContainer = mapContainer || null;
    this.statusEl = statusEl || null;
    this.recenterBtn = recenterBtn || null;
    this.setBtn = setBtn || null;
    this.moveBtn = moveBtn || null;
    this.snapBtn = snapBtn || null;
    this.selectBtn = selectBtn || null;
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
    this.onRegionSelected = typeof onRegionSelected === 'function' ? onRegionSelected : null;

    this.followEnabled = true;
    this.userHasPanned = false;
    this.activeSource = 'unknown';
    this.currentLatLon = null;
    this.viewCenter = null;
    this.peerMarkers = new Map();
    this._lastFollowLatLon = null;
    this._autoFollowThreshold = 0.0001; // ≈10–12 m on Earth
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
    this._drawHex = null;
    this._regionLayer = null;
    this._selectedRegion = null;
    this._drawToolsReady = false;

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
    this.selectBtn?.addEventListener('click', () => this._startHexDraw());

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

    this._initDrawTools();

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
      if (this.followEnabled) this._setFollow(false);
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
  }

  _initDrawTools() {
    if (this._drawToolsReady) return;
    if (!this.map || typeof window === 'undefined') return;
    const L = window.L;
    if (!L || !L.Draw) return;

    if (!L.Draw.Hexagon) {
      const SimpleShape = L.Draw.SimpleShape || L.Draw.Rectangle?.prototype;
      L.Draw.Hexagon = SimpleShape.extend({
        statics: { TYPE: 'hexagon' },
        options: { shapeOptions: { color: '#6ee7ff', weight: 2, fillOpacity: 0.08, fillColor: '#6ee7ff' } },
        initialize(map, options) {
          this.type = L.Draw.Hexagon.TYPE;
          L.Draw.SimpleShape.prototype.initialize.call(this, map, options);
        },
        _drawShape(latlng) {
          const center = this._startLatLng;
          if (!center || !latlng) return;
          const { dLat, dLon } = metresPerDegree(center.lat);
          const dx = (latlng.lng - center.lng) * dLon;
          const dy = (latlng.lat - center.lat) * dLat;
          const apothem = Math.max(5, Math.hypot(dx, dy));
          this._lastApothemM = apothem;
          const radius = (2 * apothem) / Math.sqrt(3);
          const verts = [];
          for (let k = 0; k < 6; k++) {
            const theta = (Math.PI / 3) * k;
            const vx = radius * Math.cos(theta);
            const vy = radius * Math.sin(theta);
            const lat = center.lat + vy / dLat;
            const lon = center.lng + vx / dLon;
            verts.push([lat, lon]);
          }
          if (!this._shape) {
            this._shape = L.polygon(verts, this.options.shapeOptions);
            this._map.addLayer(this._shape);
          } else {
            this._shape.setLatLngs(verts);
          }
        },
        _fireCreatedEvent() {
          if (!this._shape) return;
          const layer = L.polygon(this._shape.getLatLngs(), this.options.shapeOptions);
          layer._hexCenter = this._startLatLng;
          layer._apothemM = this._lastApothemM || 0;
          L.Draw.Feature.prototype._fireCreatedEvent.call(this, layer);
        }
      });
    }

    this.map.on(L.Draw.Event.CREATED, (e) => {
      if (!e || !e.layer) return;
      const layer = e.layer;
      if (this._drawHex) {
        try { this._drawHex.disable(); } catch {}
      }
      this._handleHexCreated(layer);
    });

    this._drawHex = new L.Draw.Hexagon(this.map, { shapeOptions: { color: '#6ee7ff', weight: 2, fillOpacity: 0.08 } });
    this._drawToolsReady = true;
  }

  _startHexDraw() {
    if (!this.map) return;
    if (!this._drawToolsReady) this._initDrawTools();
    if (!this._drawHex) return;
    try {
      this._drawHex.enable();
      this.selectBtn?.classList?.add('is-active');
      this._suspendAutoFollow(12000);
    } catch {}
  }

  _handleHexCreated(layer) {
    if (!layer || !this.map) return;
    this.selectBtn?.classList?.remove('is-active');
    if (this._regionLayer) {
      try { this.map.removeLayer(this._regionLayer); } catch {}
    }
    this._regionLayer = layer.addTo(this.map);
    if (typeof layer.setStyle === 'function') {
      layer.setStyle({ color: '#6ee7ff', weight: 2, fillOpacity: 0.08, fillColor: '#6ee7ff' });
    }
    const center = layer._hexCenter || layer.getBounds()?.getCenter() || { lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lon };
    const apothemM = layer._apothemM || this._estimateApothem(layer);
    this._selectedRegion = {
      lat: clampLat(center.lat),
      lon: clampLon(center.lng ?? center.lon),
      apothemM: Number.isFinite(apothemM) ? apothemM : this.tileManager?.tileRadius || 0
    };
    const bounds = layer.getBounds?.();
    if (bounds) {
      try { this.map.fitBounds(bounds, { padding: [20, 20] }); } catch {}
    }
    this._setFollow(false);
    this.viewCenter = { lat: this._selectedRegion.lat, lon: this._selectedRegion.lon };
    this.userHasPanned = true;
    this._updateMoveButton();
    this._setStatus('manual', this._selectedRegion.lat, this._selectedRegion.lon);
    if (typeof this.onRegionSelected === 'function') {
      this.onRegionSelected({ lat: this._selectedRegion.lat, lon: this._selectedRegion.lon, apothemM: this._selectedRegion.apothemM });
    }
  }

  _estimateApothem(layer) {
    try {
      const center = layer?._hexCenter || layer?.getBounds?.()?.getCenter?.();
      const latlngs = layer?.getLatLngs?.();
      const points = Array.isArray(latlngs) ? (Array.isArray(latlngs[0]) ? latlngs[0] : latlngs) : [];
      if (!center || !points.length) return this.tileManager?.tileRadius || 0;
      const vertex = points[0];
      const meters = metresPerDegree(center.lat);
      const dx = (vertex.lng - center.lng) * meters.dLon;
      const dy = (vertex.lat - center.lat) * meters.dLat;
      const radius = Math.hypot(dx, dy);
      return Math.max(1, radius * Math.sqrt(3) / 2);
    } catch {
      return this.tileManager?.tileRadius || 0;
    }
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
        const zoom = this.map.getZoom() || DEFAULT_CENTER.zoom;
        this.map.setView([latLon.lat, latLon.lon], zoom, { animate: false });
        this.viewCenter = { ...latLon };
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
    if (this.map) {
      if (this.followEnabled || teleported) {
        const zoom = this.map.getZoom() || DEFAULT_CENTER.zoom;
        this.map.setView([entry.lat, entry.lon], zoom, { animate: !teleported });
        this.viewCenter = { ...entry };
      }
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

  _setFollow(enabled, { triggerAuto = true, resetManual = false } = {}) {
    if (this.followEnabled === enabled) return;
    this.followEnabled = !!enabled;
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
  }

  _centerOnPlayer(force = false) {
    if (!this.map || !this.currentLatLon) return;
    const zoom = this.map.getZoom() || DEFAULT_CENTER.zoom;
    this.map.setView([this.currentLatLon.lat, this.currentLatLon.lon], zoom, { animate: !force });
    this.viewCenter = { ...this.currentLatLon };
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
    let target = normalized;
    if (target > 180) target -= 360;
    target = -target;

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
