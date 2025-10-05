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
    centerBtn,
    tileManager,
    getWorldPosition,
    getHeadingDeg,
    getPeers,
    onCommitLocation,
    onRequestAuto,
    onRequestTeleport,
  } = {}) {
    this.mapContainer = mapContainer || null;
    this.statusEl = statusEl || null;
    this.recenterBtn = recenterBtn || null;
    this.setBtn = setBtn || null;
    this.moveBtn = moveBtn || null;
    this.centerBtn = centerBtn || null;
    this.tileManager = tileManager || null;
    this.getWorldPosition = typeof getWorldPosition === 'function' ? getWorldPosition : null;
    this.getHeadingDeg = typeof getHeadingDeg === 'function' ? getHeadingDeg : () => 0;
    this.getPeers = typeof getPeers === 'function' ? getPeers : null;
    this.onCommitLocation = typeof onCommitLocation === 'function' ? onCommitLocation : null;
    this.onRequestAuto = typeof onRequestAuto === 'function' ? onRequestAuto : null;
    this.onRequestTeleport = typeof onRequestTeleport === 'function' ? onRequestTeleport : null;

    this.followEnabled = true;
    this.userHasPanned = false;
    this.activeSource = 'unknown';
    this.currentLatLon = null;
    this.viewCenter = null;
    this.peerMarkers = new Map();

    this.map = null;
    this.playerMarker = null;
    this.peerLayer = null;

    this._initMap();

    this.recenterBtn?.addEventListener('click', () => {
      this._setFollow(!this.followEnabled);
      if (this.followEnabled) this._centerOnPlayer(true);
    });

    this.centerBtn?.addEventListener('click', () => {
      this._setFollow(true);
      this._centerOnPlayer(true);
    });

    this.setBtn?.addEventListener('click', () => {
      if (!this.viewCenter || !this.onCommitLocation) return;
      this.onCommitLocation({ lat: this.viewCenter.lat, lon: this.viewCenter.lon });
    });

    this.moveBtn?.addEventListener('click', () => this._handleMoveRequest());

    this._updateFollowButton();
    this._updateMoveButton();
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
    this.playerMarker = window.L.marker([DEFAULT_CENTER.lat, DEFAULT_CENTER.lon]).addTo(this.map);

    this.map.on('movestart', () => {
      if (this.followEnabled) this._setFollow(false);
      this.userHasPanned = true;
    });

    this.map.on('moveend', () => {
      const center = this.map.getCenter();
      this.viewCenter = { lat: clampLat(center.lat), lon: clampLon(center.lng) };
      this._updateMoveButton();
    });

    this.map.on('zoomend', () => this._updateMoveButton());
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
      if (this.playerMarker) this.playerMarker.setLatLng(toLeafletLatLng(latLon));

      if (this.followEnabled && this.map) {
        const zoom = this.map.getZoom() || DEFAULT_CENTER.zoom;
        this.map.setView([latLon.lat, latLon.lon], zoom, { animate: false });
        this.viewCenter = { ...latLon };
      }
    }

    this._updatePeers();
    this._updateMoveButton();
  }

  notifyLocationChange({ lat, lon, source, detail } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const entry = { lat: clampLat(lat), lon: clampLon(lon) };
    this.currentLatLon = entry;
    this.activeSource = source || this.activeSource;

    if (this.playerMarker) this.playerMarker.setLatLng(toLeafletLatLng(entry));

    const teleported = detail?.teleport === true;
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
    this._updateMoveButton();
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

  _setFollow(enabled) {
    if (this.followEnabled === enabled) return;
    this.followEnabled = !!enabled;
    if (this.followEnabled) {
      this.userHasPanned = false;
      if (typeof this.onRequestAuto === 'function') this.onRequestAuto();
      if (this.currentLatLon) this.viewCenter = { ...this.currentLatLon };
      this._centerOnPlayer(true);
    }
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
    if (!this.viewCenter || typeof this.onRequestTeleport !== 'function') return;
    if (!Number.isFinite(this.viewCenter.lat) || !Number.isFinite(this.viewCenter.lon)) return;
    if (this.moveBtn?.disabled) return;
    this.onRequestTeleport({ lat: this.viewCenter.lat, lon: this.viewCenter.lon });
    this.userHasPanned = false;
    this.moveBtn?.blur?.();
    this._updateMoveButton();
  }

  _updateMoveButton() {
    if (!this.moveBtn) return;
    const hasTarget = Boolean(
      this.viewCenter &&
      Number.isFinite(this.viewCenter.lat) &&
      Number.isFinite(this.viewCenter.lon) &&
      this.userHasPanned
    );
    this.moveBtn.disabled = !hasTarget;
    this.moveBtn.setAttribute('aria-disabled', hasTarget ? 'false' : 'true');
    if (hasTarget) {
      this.moveBtn.title = `Teleport to ${this.viewCenter.lat.toFixed(5)}, ${this.viewCenter.lon.toFixed(5)}`;
    } else {
      this.moveBtn.title = 'Pan the mini-map to choose a destination';
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
}
