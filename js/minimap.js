// Mini-map component for sidebar location control and visualization
import { clampLat, worldToLatLon, wrapLon } from './geolocate.js';

export class MiniMap {
  constructor({
    canvas,
    statusEl,
    recenterBtn,
    setBtn,
    tileManager,
    getWorldPosition,
    getHeadingDeg,
    onCommitLocation,
    onRequestAuto,
  } = {}) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext('2d') || null;
    this.statusEl = statusEl || null;
    this.recenterBtn = recenterBtn || null;
    this.setBtn = setBtn || null;
    this.tileManager = tileManager || null;
    this.getWorldPosition = getWorldPosition || null;
    this.getHeadingDeg = getHeadingDeg || (() => 0);
    this.onCommitLocation = onCommitLocation || null;
    this.onRequestAuto = onRequestAuto || null;

    this.mapZoom = 16;
    this.tileSize = 256;
    this.tileCache = new Map();
    this.currentLatLon = null;
    this.currentHeading = 0;
    this.viewCenter = null;
    this.userHasPanned = false;
    this.dragging = false;
    this.dragState = null;
    this._lastRenderAt = 0;
    this._lastHeading = null;
    this.path = [];
    this.redrawIntervalMs = 120;
    this.activeSource = 'unknown';
    this.needsRedraw = true;
    this._tileErrorNotified = false;
    this.followEnabled = true;

    if (this.canvas) {
      this.canvas.style.cursor = 'grab';
      this.canvas.addEventListener('pointerdown', (e) => this._onPointerDown(e));
      this.canvas.addEventListener('pointermove', (e) => this._onPointerMove(e));
      this.canvas.addEventListener('pointerup', (e) => this._onPointerUp(e));
      this.canvas.addEventListener('pointercancel', (e) => this._onPointerUp(e));
      this.canvas.addEventListener('wheel', (e) => this._onWheel(e), { passive: false });
    }

    this.recenterBtn?.addEventListener('click', () => {
      const next = !this.followEnabled;
      this._setFollow(next);
      if (this.followEnabled && this.currentLatLon) {
        this.viewCenter = { ...this.currentLatLon };
        this.needsRedraw = true;
        this._drawMiniMap(true);
      } else if (!this.followEnabled) {
        this.userHasPanned = true;
      }
    });

    this.setBtn?.addEventListener('click', () => {
      if (!this.viewCenter || typeof this.onCommitLocation !== 'function') return;
      this.onCommitLocation({ ...this.viewCenter });
    });

    this._updateFollowButton();
  }

  update() {
    if (!this.ctx || !this.tileManager?.origin) return;

    const origin = this.tileManager.origin;
    if (!this.viewCenter && origin) {
      this.viewCenter = { lat: origin.lat, lon: origin.lon };
      this.needsRedraw = true;
    }

    let latLon = null;
    if (typeof this.getWorldPosition === 'function') {
      const worldPos = this.getWorldPosition();
      if (worldPos) latLon = this._worldToLatLon(worldPos.x, worldPos.z);
    }

    if (!latLon && origin) {
      latLon = { lat: origin.lat, lon: origin.lon };
    }

    if (latLon) {
      const prev = this.currentLatLon;
      this.currentLatLon = latLon;
      const eps = 1e-7;
      if (!prev || Math.abs(prev.lat - latLon.lat) > eps || Math.abs(prev.lon - latLon.lon) > eps) {
        this.needsRedraw = true;
      }

      const heading = this.getHeadingDeg?.();
      if (Number.isFinite(heading)) {
        if (this._lastHeading == null || Math.abs(heading - this._lastHeading) > 0.5) {
          this.needsRedraw = true;
        }
        this.currentHeading = heading;
        this._lastHeading = heading;
      }

      if (this.followEnabled) {
        const needs =
          !this.viewCenter ||
          Math.abs(this.viewCenter.lat - latLon.lat) > eps ||
          Math.abs(this.viewCenter.lon - latLon.lon) > eps;
        if (needs) this.needsRedraw = true;
        this.viewCenter = { ...latLon };
      } else if (!this.viewCenter) {
        this.viewCenter = { ...latLon };
        this.needsRedraw = true;
      }

      this._pushPathPoint(latLon);
    }

    if (this.needsRedraw) {
      this._drawMiniMap(true);
    }
  }

  notifyLocationChange({ lat, lon, source } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this.activeSource = source || 'unknown';

    if (source === 'manual') {
      if (!this.followEnabled) this.userHasPanned = true;
      if (this.followEnabled) this.viewCenter = { lat, lon };
      this.path = [];
    } else if (this.followEnabled || !this.viewCenter) {
      this.viewCenter = { lat, lon };
    }

    this.currentLatLon = { lat, lon };
    this.currentHeading = this.currentHeading || 0;
    this.needsRedraw = true;

    this._setStatus(this.activeSource, lat, lon);
    this._drawMiniMap(true);
  }

  forceRedraw() {
    this.needsRedraw = true;
    this._drawMiniMap(true);
  }

  /* ---------------- Pointer handlers ---------------- */

  _onPointerDown(e) {
    if (!this.canvas) return;
    if (e.button !== 0) return;
    if (this.followEnabled) this._setFollow(false);
    this.canvas.setPointerCapture?.(e.pointerId);
    this.dragging = true;
    this.userHasPanned = true;
    this.canvas.style.cursor = 'grabbing';
    const rect = this.canvas.getBoundingClientRect();
    this.dragState = {
      pointerId: e.pointerId,
      lastX: e.clientX,
      lastY: e.clientY,
      scaleX: this.canvas.width / rect.width,
      scaleY: this.canvas.height / rect.height,
      tileX: this.viewCenter ? this._lonToTileX(this.viewCenter.lon, this.mapZoom) : 0,
      tileY: this.viewCenter ? this._latToTileY(this.viewCenter.lat, this.mapZoom) : 0,
    };
    e.preventDefault();
  }

  _onPointerMove(e) {
    if (!this.dragging || !this.dragState) return;
    if (this.dragState.pointerId !== e.pointerId) return;

    const dx = (e.clientX - this.dragState.lastX) * this.dragState.scaleX;
    const dy = (e.clientY - this.dragState.lastY) * this.dragState.scaleY;
    this.dragState.lastX = e.clientX;
    this.dragState.lastY = e.clientY;

    const tilesX = dx / this.tileSize;
    const tilesY = dy / this.tileSize;
    this.dragState.tileX -= tilesX;
    this.dragState.tileY -= tilesY;

    const newLon = this._tileXToLon(this.dragState.tileX, this.mapZoom);
    const newLat = clampLat(this._tileYToLat(this.dragState.tileY, this.mapZoom));
    this.viewCenter = { lat: newLat, lon: wrapLon(newLon) };

    this.needsRedraw = true;
    this._drawMiniMap(true);
    e.preventDefault();
  }

  _onPointerUp(e) {
    if (!this.dragging || !this.dragState) return;
    if (this.dragState.pointerId !== e.pointerId) return;
    this.canvas.releasePointerCapture?.(e.pointerId);
    this.dragging = false;
    this.dragState = null;
    this.canvas.style.cursor = 'grab';
    e.preventDefault();
  }

  _onWheel(e) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    if (e.deltaY < 0) {
      this.mapZoom = Math.min(this.mapZoom + 1, 19);
    } else if (e.deltaY > 0) {
      this.mapZoom = Math.max(this.mapZoom - 1, 2);
    }
    if (this.viewCenter) {
      // Update drag state reference for smooth follow
      if (this.dragState) {
        this.dragState.tileX = this._lonToTileX(this.viewCenter.lon, this.mapZoom);
        this.dragState.tileY = this._latToTileY(this.viewCenter.lat, this.mapZoom);
      }
      this.needsRedraw = true;
      this._drawMiniMap(true);
    }
  }

  /* ---------------- Drawing ---------------- */

  _drawMiniMap(force = false) {
    if (!this.ctx || !this.viewCenter) return;

    const now = performance.now();
    if (!force && !this.dragging && now - this._lastRenderAt < this.redrawIntervalMs) {
      return;
    }
    this._lastRenderAt = now;
    this.needsRedraw = false;

    const { width, height } = this.canvas;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, width, height);

    const zoom = this.mapZoom;
    const ts = this.tileSize;

    const centerX = this._lonToTileX(this.viewCenter.lon, zoom);
    const centerY = this._latToTileY(this.viewCenter.lat, zoom);
    const px = centerX * ts;
    const py = centerY * ts;
    const originX = px - width / 2;
    const originY = py - height / 2;

    const xStart = Math.floor(originX / ts);
    const yStart = Math.floor(originY / ts);
    const xEnd = Math.floor((originX + width) / ts);
    const yEnd = Math.floor((originY + height) / ts);

    const overlay = () => {
      this._drawOverlay({ originX, originY, width, height });
    };

    overlay();

    for (let tx = xStart; tx <= xEnd; tx++) {
      for (let ty = yStart; ty <= yEnd; ty++) {
        const url = `https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`;
        const dx = tx * ts - originX;
        const dy = ty * ts - originY;
        this._loadTile(url)
          .then((img) => {
            ctx.drawImage(img, dx, dy, ts, ts);
            overlay();
          })
          .catch(() => {
            if (!this._tileErrorNotified) {
              this._tileErrorNotified = true;
              if (this.statusEl) {
                this.statusEl.textContent = 'Mini-map tile load failed — check network access';
              }
            }
          });
      }
    }
  }

  _drawOverlay({ originX, originY, width, height }) {
    const ctx = this.ctx;
    if (!ctx) return;

    const zoom = this.mapZoom;
    const ts = this.tileSize;

    // breadcrumb path
    if (this.path.length > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,59,48,0.35)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.path.forEach((p, idx) => {
        const tileX = this._lonToTileX(p.lon, zoom);
        const tileY = this._latToTileY(p.lat, zoom);
        const px = tileX * ts - originX;
        const py = tileY * ts - originY;
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
      ctx.restore();
    }

    // centre marker
    ctx.save();
    ctx.fillStyle = '#f0f0f0';
    ctx.beginPath();
    ctx.arc(width / 2, height / 2, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    if (!this.currentLatLon) return;

    const playerTileX = this._lonToTileX(this.currentLatLon.lon, zoom);
    const playerTileY = this._latToTileY(this.currentLatLon.lat, zoom);
    const px = playerTileX * ts - originX;
    const py = playerTileY * ts - originY;

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(((-this.currentHeading + 180) * Math.PI) / 180);
    ctx.fillStyle = '#ff3b30';
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6, 7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(px, py, 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /* ---------------- Helpers ---------------- */

  _worldToLatLon(x, z) {
    const origin = this.tileManager?.origin;
    if (!origin) return null;
    return worldToLatLon(x, z, origin.lat, origin.lon);
  }

  _pushPathPoint(latLon) {
    if (!latLon) return;
    const last = this.path[this.path.length - 1];
    if (last) {
      const dLat = Math.abs(latLon.lat - last.lat);
      const dLon = Math.abs(latLon.lon - last.lon);
      if (dLat < 5e-7 && dLon < 5e-7) return;
    }
    this.path.push({ lat: latLon.lat, lon: latLon.lon });
    if (this.path.length > 400) this.path.shift();
  }

  _lonToTileX(lon, zoom) {
    return ((lon + 180) / 360) * (1 << zoom);
  }

  _latToTileY(lat, zoom) {
    const latRad = (lat * Math.PI) / 180;
    const n = Math.log(Math.tan(Math.PI / 4 + latRad / 2));
    return ((1 - n / Math.PI) / 2) * (1 << zoom);
  }

  _tileXToLon(x, zoom) {
    return (x / (1 << zoom)) * 360 - 180;
  }

  _tileYToLat(y, zoom) {
    const n = Math.PI - (2 * Math.PI * y) / (1 << zoom);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  _loadTile(url) {
    if (this.tileCache.has(url)) {
      const cached = this.tileCache.get(url);
      return cached instanceof HTMLImageElement ? Promise.resolve(cached) : cached;
    }
    const load = (useCors) => new Promise((resolve, reject) => {
      const img = new Image();
      if (useCors) img.crossOrigin = 'anonymous';
      img.referrerPolicy = 'no-referrer';
      img.onload = () => {
        this.tileCache.set(url, img);
        if (this._tileErrorNotified) {
          this._tileErrorNotified = false;
          if (this.currentLatLon) {
            this._setStatus(this.activeSource, this.currentLatLon.lat, this.currentLatLon.lon);
          }
        }
        resolve(img);
      };
      img.onerror = () => {
        if (useCors) {
          this.tileCache.delete(url);
          const retry = load(false);
          this.tileCache.set(url, retry);
          retry.then(resolve).catch(reject);
        } else {
          this.tileCache.delete(url);
          reject();
        }
      };
      img.src = url;
    });

    const promise = load(true);
    this.tileCache.set(url, promise);
    return promise;
  }

  _setFollow(enabled) {
    if (this.followEnabled === enabled) return;
    this.followEnabled = enabled;
    if (this.followEnabled) {
      this.userHasPanned = false;
      if (typeof this.onRequestAuto === 'function') this.onRequestAuto();
      if (this.currentLatLon) {
        this.viewCenter = { ...this.currentLatLon };
        this.needsRedraw = true;
      }
    }
    this._updateFollowButton();
  }

  _updateFollowButton() {
    if (!this.recenterBtn) return;
    this.recenterBtn.textContent = this.followEnabled ? 'Follow: On' : 'Follow: Off';
    this.recenterBtn.setAttribute('aria-pressed', this.followEnabled ? 'true' : 'false');
  }

  _setStatus(source, lat, lon) {
    if (!this.statusEl) return;
    let label = 'Location pending';
    switch (source) {
      case 'manual':
        label = 'Manual location override';
        break;
      case 'device':
        label = 'Using device location';
        break;
      case 'ip':
        label = 'Using network location';
        break;
    }
    const coords = Number.isFinite(lat) && Number.isFinite(lon)
      ? `${lat.toFixed(4)}, ${lon.toFixed(4)}`
      : '—';
    this.statusEl.textContent = `${label} · ${coords}`;
  }
}
