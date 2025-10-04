import * as THREE from 'three';
import { UniformHexGrid } from './grid.js';
import { now } from './utils.js';
import { worldToLatLon } from './geolocate.js';

export class TileManager {
  constructor(scene, spacing = 10, tileRadius = 15, audio = null) {
    this.scene = scene; this.spacing = spacing; this.tileRadius = tileRadius;
    this.audio = audio;   // spatial audio engine
    this.tiles = new Map(); this.origin = null;

    // ---- LOD configuration ----
    this.INTERACTIVE_RING = 2;          // near player ⇒ high-res
    this.VISUAL_RING = 10;              // far field ⇒ 7-vertex tiles
    this.VISUAL_CREATE_BUDGET = 50;     // cap new visuals per frame

    // ---- interactive (high-res) relaxation ----
    this.RELAX_ITERS_PER_FRAME = 4;
    this.RELAX_ALPHA = 1.0;
    this.NORMALS_EVERY = 6;
    this.RELAX_FRAME_BUDGET_MS = 3.0;

    // ---- global queue for low-res fetches ----
    this._visFetchQ = [];
    this._visFetchActive = 0;
    this.MAX_GLOBAL_CON_VIS = 16;

    // ---- GLOBAL grayscale controls (altitude => luminance) ----
    this.LUM_MIN = 0.05;  // almost black
    this.LUM_MAX = 0.80;  // bright cap
    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._globalDirty = false;
    this._lastRecolorAt = 0;

    // ---- caching config ----
    this.CACHE_VER = 'v1';
    this._originCacheKey = 'na';

    this.ray = new THREE.Raycaster();
    this.DOWN = new THREE.Vector3(0, -1, 0);
    this._lastHeight = 0;

    this._relaxKeys = [];
    this._relaxCursor = 0;
    this._relaxKeysDirty = true;

    if (!scene.userData._tmLightsAdded) {
      scene.add(new THREE.AmbientLight(0xffffff, .55));
      const sun = new THREE.DirectionalLight(0xffffff, .65);
      sun.position.set(50, 100, 50); sun.castShadow = true; scene.add(sun);
      scene.userData._tmLightsAdded = true;
    }

    this._baseLod = {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      visualCreateBudget: this.VISUAL_CREATE_BUDGET,
      relaxIters: this.RELAX_ITERS_PER_FRAME,
      relaxBudget: this.RELAX_FRAME_BUDGET_MS,
      maxGlobalConVis: this.MAX_GLOBAL_CON_VIS,
    };
    this._lodQuality = 1;

  }

  /* ---------------- small helpers ---------------- */

  _axialWorld(q, r) {
    const a = this.tileRadius;
    return { x: 1.5 * a * q, z: a * ((Math.sqrt(3) / 2) * q + Math.sqrt(3) * r) };
  }
  _hexCorners(a) {
    const out = []; for (let i = 0; i < 6; i++) {
      const ang = (Math.PI / 3) * i; out.push({ x: a * Math.cos(ang), z: a * Math.sin(ang) });
    } return out;
  }
  _hexDist(q1, r1, q2, r2) {
    const dq = q1 - q2, dr = r1 - r2, ds = (-q1 - r1) - (-q2 - r2);
    return (Math.abs(dq) + Math.abs(dr) + Math.abs(ds)) / 2;
  }

  /* ---------- adjacency & buffers (interactive) ---------- */

  _buildAdjacency(indexAttr, vertCount) {
    const idx = indexAttr.array;
    const adj = Array.from({ length: vertCount }, () => new Set());
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      adj[a].add(b); adj[a].add(c);
      adj[b].add(a); adj[b].add(c);
      adj[c].add(a); adj[c].add(b);
    }
    return adj;
  }
  _ensureTileBuffers(tile) {
    const n = tile.pos.count;
    if (!tile.yA || tile.yA.length !== n) {
      tile.yA = new Float32Array(n);
      tile.yB = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const y = tile.pos.getY(i);
        tile.yA[i] = y; tile.yB[i] = y;
      }
    }
  }
  _relaxOnce(tile) {
    if (tile.type !== 'interactive') return false;
    if (tile.fetched.size === 0) return false;
    if (typeof tile.unreadyCount !== 'number') tile.unreadyCount = tile.pos.count;
    if (tile.unreadyCount === 0) return false;

    const ready = tile.ready;
    const adj = tile.neighbors;
    const read = tile.flip ? tile.yB : tile.yA;
    const write = tile.flip ? tile.yA : tile.yB;
    const alpha = this.RELAX_ALPHA;

    for (let i = 0; i < tile.pos.count; i++) {
      if (ready[i]) { write[i] = read[i]; continue; }
      let sum = 0, cnt = 0;
      for (const j of adj[i]) { sum += read[j]; cnt++; }
      write[i] = (cnt > 0) ? read[i] + (sum / cnt - read[i]) * alpha : read[i];
    }
    tile.flip = !tile.flip;
    return true;
  }
  _pushBuffersToGeometry(tile) {
    if (tile.type !== 'interactive') return;
    const cur = tile.flip ? tile.yB : tile.yA;
    const pos = tile.pos;
    for (let i = 0; i < pos.count; i++) pos.setY(i, cur[i]);
    pos.needsUpdate = true;

    tile.normTick = (tile.normTick + 1) % this.NORMALS_EVERY;
    if (tile.normTick === 0) {
      tile.grid.geometry.computeVertexNormals();
      this._applyAllColorsGlobal(tile);
    }
  }
  _pullGeometryToBuffers(tile, onlyChangedIndex = -1) {
    if (tile.type !== 'interactive') return;
    const tgt = tile.flip ? tile.yB : tile.yA;
    const alt = tile.flip ? tile.yA : tile.yB;
    if (onlyChangedIndex >= 0) {
      const y = tile.pos.getY(onlyChangedIndex);
      tgt[onlyChangedIndex] = y; alt[onlyChangedIndex] = y;
    } else {
      for (let i = 0; i < tile.pos.count; i++) {
        const y = tile.pos.getY(i); tgt[i] = y; alt[i] = y;
      }
    }
  }

  /* ---------- GLOBAL grayscale helpers ---------- */

  _ensureColorAttr(tile) {
    let col = tile.grid.geometry.attributes.color;
    if (col && col.usage !== THREE.DynamicDrawUsage) col.setUsage(THREE.DynamicDrawUsage);
    if (!col) {
      const n = tile.pos.count;
      col = new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage);
      tile.grid.geometry.setAttribute('color', col);
    }
    tile.col = col;
    return col;
  }
  _initColorsNearBlack(tile) {
    const col = this._ensureColorAttr(tile);
    const arr = col.array;
    for (let i = 0; i < tile.pos.count; i++) {
      const o = 3 * i; arr[o] = arr[o + 1] = arr[o + 2] = this.LUM_MIN;
    }
    col.needsUpdate = true;
  }
  _updateGlobalFromValue(y) {
    let changed = false;
    if (y < this.GLOBAL_MIN_Y) { this.GLOBAL_MIN_Y = y; changed = true; }
    if (y > this.GLOBAL_MAX_Y) { this.GLOBAL_MAX_Y = y; changed = true; }
    if (changed) this._globalDirty = true;
  }
  _updateGlobalFromArray(arr) {
    for (let i = 0; i < arr.length; i++) this._updateGlobalFromValue(arr[i]);
  }
  _lumFromYGlobal(y) {
    const minY = this.GLOBAL_MIN_Y, maxY = this.GLOBAL_MAX_Y;
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY - minY < 1e-6) return this.LUM_MIN;
    const t = THREE.MathUtils.clamp((y - minY) / (maxY - minY), 0, 1);
    return this.LUM_MIN + t * (this.LUM_MAX - this.LUM_MIN);
  }
  _applyAllColorsGlobal(tile) {
    this._ensureColorAttr(tile);
    const arr = tile.col.array, pos = tile.pos;
    for (let i = 0; i < pos.count; i++) {
      const l = this._lumFromYGlobal(pos.getY(i));
      const o = 3 * i;
      arr[o] = arr[o + 1] = arr[o + 2] = l / 10; // slight desat vs interactive
    }
    tile.col.needsUpdate = true;
  }

  /* ---------- caching helpers ---------- */

  _originKeyForCache(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'na';
    const quant = (value) => (Math.round(value * 100000) / 100000).toFixed(5);
    return `${quant(lat)},${quant(lon)}`;
  }
  _cacheKey(tile) {
    const originKey = this._originCacheKey || 'na';
    return `tile:${this.CACHE_VER}:${originKey}:${tile.type}:${this.spacing}:${this.tileRadius}:${tile.q},${tile.r}`;
  }
  _tryLoadTileFromCache(tile) {
    try {
      const key = this._cacheKey(tile);
      const raw = localStorage.getItem(key);
      if (!raw) return false;

      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.y)) return false;
      if (data.spacing !== this.spacing || data.tileRadius !== this.tileRadius) return false;
      if (data.type !== tile.type) return false;
      if (data.y.length !== tile.pos.count) return false;

      const pos = tile.pos;
      for (let i = 0; i < data.y.length; i++) pos.setY(i, data.y[i]);
      pos.needsUpdate = true;
      tile.grid.geometry.computeVertexNormals();

      tile.ready = new Uint8Array(tile.pos.count);
      tile.ready.fill(1);
      tile.fetched = new Set();
      tile.populating = false;
      tile.unreadyCount = 0;

      this._ensureTileBuffers(tile);
      this._pullGeometryToBuffers(tile);

      this._updateGlobalFromArray(data.y);
      this._applyAllColorsGlobal(tile);

      return true;
    } catch { return false; }
  }
  _saveTileToCache(tile) {
    try {
      const pos = tile.pos;
      const y = new Array(pos.count);
      for (let i = 0; i < pos.count; i++) y[i] = +pos.getY(i).toFixed(2);
      const payload = {
        v: this.CACHE_VER, type: tile.type, spacing: this.spacing, tileRadius: this.tileRadius,
        q: tile.q, r: tile.r, y
      };
      localStorage.setItem(this._cacheKey(tile), JSON.stringify(payload));
    } catch { /* ignore quota */ }
  }

  /* ---------------- creation: interactive tile ---------------- */

  _addInteractiveTile(q, r) {
    const id = `${q},${r}`;
    if (this.tiles.has(id)) return this.tiles.get(id);

    const grid = new UniformHexGrid(this.spacing, this.tileRadius * 2);
    grid.group.name = `tile-${id}`;
    const wp = this._axialWorld(q, r);
    grid.group.position.set(wp.x, 0, wp.z);
    this.scene.add(grid.group);

    const pos = grid.geometry.attributes.position;
    const neighbors = this._buildAdjacency(grid.geometry.getIndex(), pos.count);
    const ready = new Uint8Array(pos.count); // 1=fetched

    const tile = {
      type: 'interactive',
      grid, q, r,
      pos,
      neighbors,
      ready,
      fetched: new Set(),
      populating: false,
      yA: null, yB: null, flip: false,
      normTick: 0,
      col: null,
      unreadyCount: pos.count
    };
    this._ensureTileBuffers(tile);
    this.tiles.set(id, tile);

    this._initColorsNearBlack(tile);

    this._markRelaxListDirty();

    if (!this._tryLoadTileFromCache(tile)) {
      setTimeout(() => this._populateInteractive(id), 0);
    }
    return tile;
  }

  /* ---------------- creation: visual tile (7 verts) ---------------- */

  _makeLowResHexMesh() {
    const a = this.tileRadius;
    const center = { x: 0, z: 0 };
    const corners = this._hexCorners(a);
    const verts = [center, ...corners];

    const pos = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
      pos[3*i+0] = verts[i].x;
      pos[3*i+1] = 0;
      pos[3*i+2] = verts[i].z;
    }
    const idx = [];
    for (let i = 1; i <= 6; i++) { const j = i === 6 ? 1 : i + 1; idx.push(0, i, j); }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setIndex(idx);

    const cols = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) { const o = 3*i; cols[o] = cols[o+1] = cols[o+2] = this.LUM_MIN; }
    geom.setAttribute('color', new THREE.BufferAttribute(cols, 3).setUsage(THREE.DynamicDrawUsage));
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, metalness: .15, roughness: .45 });
    const mesh = new THREE.Mesh(geom, mat); mesh.frustumCulled = false;
    const wire = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({ wireframe: true, opacity: 1, transparent: false, color: 0xa8a8a8 }));
    wire.frustumCulled = false; wire.renderOrder = 1;

    const group = new THREE.Group(); group.add(mesh, wire);
    return { group, mesh, geometry: geom, mat, wireMat: wire.material };
  }

  _addVisualTile(q, r) {
    const id = `${q},${r}`;
    if (this.tiles.has(id)) return this.tiles.get(id);

    const low = this._makeLowResHexMesh();
    low.group.name = `tile-low-${id}`;
    const wp = this._axialWorld(q, r);
    low.group.position.set(wp.x, 0, wp.z);
    this.scene.add(low.group);

    const pos = low.geometry.attributes.position;
    const ready = new Uint8Array(pos.count);

    const tile = {
      type: 'visual',
      grid: { group: low.group, mesh: low.mesh, geometry: low.geometry, mat: low.mat, wireMat: low.wireMat },
      q, r,
      pos,
      ready,
      fetched: new Set(),
      populating: false,
      pending: 0,
      col: low.geometry.attributes.color
    };
    this.tiles.set(id, tile);

    if (!this._tryLoadTileFromCache(tile)) {
      setTimeout(() => this._populateVisual(id), 0);
    }
    return tile;
  }

  /* ---------------- fetching ---------------- */

  _populateInteractive(id) {
    const tile = this.tiles.get(id); if (!tile || tile.type !== 'interactive' || !this.origin || tile.populating) return;
    tile.populating = true;

    const { grid, pos, fetched } = tile;
    const n = pos.count;

    // far → near ordering
    const q = []; for (let i = 0; i < n; i++) q.push(i);
    q.sort((a, b) => {
      const ax = pos.getX(a), az = pos.getZ(a), bx = pos.getX(b), bz = pos.getZ(b);
      return (bx*bx + bz*bz) - (ax*ax + az*az);
    });

    const MAX_CON = 6; let active = 0;

    const apply = (i, val) => {
      // 1) height
      pos.setY(i, val);
      pos.needsUpdate = true;
      if (!tile.ready[i]) {
        tile.ready[i] = 1;
        tile.unreadyCount = Math.max(0, tile.unreadyCount - 1);
      } else {
        tile.ready[i] = 1;
      }
      fetched.add(i);
      this._pullGeometryToBuffers(tile, i);

      // 2) global range + immediate color
      this._updateGlobalFromValue(val);
      if (!tile.col) this._ensureColorAttr(tile);
      const l = this._lumFromYGlobal(val);
      const o = 3 * i;
      tile.col.array[o] = tile.col.array[o + 1] = tile.col.array[o + 2] = l;
      tile.col.needsUpdate = true;

      // 3) spatial audio scratch
      if (this.audio) {
        const wx = grid.group.position.x + pos.getX(i);
        const wy = val;
        const wz = grid.group.position.z + pos.getZ(i);
        this.audio.triggerScratch(wx, wy, wz, 1.0);
      }

      // 4) normals + bookkeeping
      tile.normTick = (tile.normTick + 1) % this.NORMALS_EVERY;
      if (tile.normTick === 0 || (active === 1 && q.length === 0)) grid.geometry.computeVertexNormals();

      if (fetched.size === pos.count) {
        this._applyAllColorsGlobal(tile);
        this._saveTileToCache(tile);
      }

      active--; dequeue();
    };

    const dequeue = () => {
      while (active < MAX_CON && q.length) {
        const i = q.shift(); active++;
        const wx = grid.group.position.x + pos.getX(i);
        const wz = grid.group.position.z + pos.getZ(i);
        const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
        const lat = ll?.lat ?? this.origin.lat;
        const lon = ll?.lon ?? this.origin.lon;
        fetch(`https://epqs.nationalmap.gov/v1/json?x=${lon}&y=${lat}&wkid=4326&units=Meters`)
          .then(r => r.json()).then(d => apply(i, d?.value ?? 0))
          .catch(() => apply(i, 0));
      }
      if (active === 0 && q.length === 0) tile.populating = false;
    };

    dequeue();
  }

  _populateVisual(id) {
    const tile = this.tiles.get(id); if (!tile || tile.type !== 'visual' || !this.origin || tile.populating) return;
    tile.populating = true;

    const pos = tile.pos;
    tile.pending = 0;
    for (let i = 0; i < pos.count; i++) {
      const wx = tile.grid.group.position.x + pos.getX(i);
      const wz = tile.grid.group.position.z + pos.getZ(i);
      this._enqueueVisualFetch(tile, i, wx, wz);
    }
    this._drainVisualFetchQ();
  }

  _enqueueVisualFetch(tile, i, wx, wz) {
    const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
    const lat = ll?.lat ?? this.origin.lat;
    const lon = ll?.lon ?? this.origin.lon;

    tile.pending++;
    this._visFetchQ.push({ tileId: `${tile.q},${tile.r}`, i, lat, lon });
  }

  _drainVisualFetchQ() {
    while (this._visFetchActive < this.MAX_GLOBAL_CON_VIS && this._visFetchQ.length) {
      const job = this._visFetchQ.shift();
      const tile = this.tiles.get(job.tileId);
      if (!tile || tile.type !== 'visual') continue;
      this._visFetchActive++;

      fetch(`https://epqs.nationalmap.gov/v1/json?x=${job.lon}&y=${job.lat}&wkid=4326&units=Meters`)
        .then(r => r.json())
        .then(j => this._applyVisualSample(tile, job.i, Number.isFinite(j?.value) ? j.value : 0))
        .catch(() => this._applyVisualSample(tile, job.i, 0))
        .finally(() => {
          this._visFetchActive = Math.max(0, this._visFetchActive - 1);
          this._drainVisualFetchQ();
        });
    }
  }

  _applyVisualSample(tile, i, val) {
    if (!this.tiles.has(`${tile.q},${tile.r}`)) return;
    if (tile.type !== 'visual') return;

    const pos = tile.pos;
    pos.setY(i, val);
    pos.needsUpdate = true;
    tile.ready[i] = 1;
    tile.fetched.add(i);

    this._updateGlobalFromValue(val);
    if (!tile.col) this._ensureColorAttr(tile);
    const l = this._lumFromYGlobal(val);
    const o = 3 * i;
    tile.col.array[o] = tile.col.array[o + 1] = tile.col.array[o + 2] = l;
    tile.col.needsUpdate = true;

    if (this.audio) {
      const wx = tile.grid.group.position.x + pos.getX(i);
      const wy = val;
      const wz = tile.grid.group.position.z + pos.getZ(i);
      this.audio.triggerScratch(wx, wy, wz, 0.85);
    }

    tile.pending = Math.max(0, tile.pending - 1);
    if (tile.pending === 0) {
      tile.grid.geometry.computeVertexNormals();
      this._applyAllColorsGlobal(tile);
      this._saveTileToCache(tile);
      tile.populating = false;
    }
  }

  /* ---------------- per-frame: ensure LOD, relax, prune ---------------- */

  update(playerPos) {
    if (!this.origin) return;

    const a = this.tileRadius;
    const qf = (2 / 3 * playerPos.x) / a;
    const rf = ((-1 / 3 * playerPos.x) + (Math.sqrt(3) / 3 * playerPos.z)) / a;
    const q0 = Math.round(qf), r0 = Math.round(rf);

    // 1) interactive ring
    for (let dq = -this.INTERACTIVE_RING; dq <= this.INTERACTIVE_RING; dq++) {
      const rMin = Math.max(-this.INTERACTIVE_RING, -dq - this.INTERACTIVE_RING);
      const rMax = Math.min(this.INTERACTIVE_RING, -dq + this.INTERACTIVE_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        this._ensureType(q0 + dq, r0 + dr, 'interactive');
      }
    }

    // 2) visuals outward with budget
    let created = 0;
    outer:
    for (let dq = -this.VISUAL_RING; dq <= this.VISUAL_RING; dq++) {
      const rMin = Math.max(-this.VISUAL_RING, -dq - this.VISUAL_RING);
      const rMax = Math.min(this.VISUAL_RING, -dq + this.VISUAL_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.INTERACTIVE_RING) continue;
        const had = this.tiles.has(`${q},${r}`);
        if (!had) {
          this._addVisualTile(q, r);
          if (++created >= this.VISUAL_CREATE_BUDGET) break outer;
        } else {
          const existing = this.tiles.get(`${q},${r}`);
          if (dist <= this.INTERACTIVE_RING) {
            this._ensureType(q, r, 'interactive');
          } else if (existing && existing.type === 'interactive') {
            this._ensureType(q, r, 'visual');
          }
        }
      }
    }

    // 3) prune outside visual ring
    for (const [id, t] of this.tiles) {
      const dist = this._hexDist(t.q, t.r, q0, r0);
      if (dist > this.VISUAL_RING) this._discardTile(id);
    }

    // 4) relax
    this._ensureRelaxList();
    this._drainRelaxQueue();

    // 5) keep global fetchers busy
    this._drainVisualFetchQ();

    // 6) throttle recolor sweep when global range changes
    if (this._globalDirty) {
      const t = now();
      if (t - this._lastRecolorAt > 100) {
        for (const tile of this.tiles.values()) this._applyAllColorsGlobal(tile);
        this._globalDirty = false;
        this._lastRecolorAt = t;
      }
    }
  }

  _ensureType(q, r, want) {
    const id = `${q},${r}`;
    const cur = this.tiles.get(id);
    if (!cur) {
      return want === 'interactive' ? this._addInteractiveTile(q, r)
           : this._addVisualTile(q, r);
    }
    if (cur.type === want) return cur;
    this._discardTile(id);
    return want === 'interactive' ? this._addInteractiveTile(q, r)
         : this._addVisualTile(q, r);
  }

  setOrigin(lat, lon, { immediate = false } = {}) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    const changed =
      !this.origin ||
      Math.abs(lat - this.origin.lat) > 1e-6 ||
      Math.abs(lon - this.origin.lon) > 1e-6;

    this.origin = { lat, lon };
    this._originCacheKey = this._originKeyForCache(lat, lon);

    if (changed) {
      this._resetAllTiles();
      this._ensureType(0, 0, 'interactive');
    } else if (immediate && !this.tiles.size) {
      this._ensureType(0, 0, 'interactive');
    }

    if (immediate && this.origin) {
      if (!this._originVec) this._originVec = new THREE.Vector3();
      this._originVec.set(0, 0, 0);
      this.update(this._originVec);
    }
  }

  _discardTile(id) {
    const t = this.tiles.get(id);
    if (!t) return;
    this.scene.remove(t.grid.group);
    try {
      t.grid.geometry?.dispose?.();
      t.grid.mat?.dispose?.();
      t.grid.wireMat?.dispose?.();
    } catch { /* noop */ }
    this.tiles.delete(id);
    this._markRelaxListDirty();
  }

  _resetAllTiles() {
    for (const id of Array.from(this.tiles.keys())) this._discardTile(id);
    this.tiles.clear();
    this._visFetchQ.length = 0;
    this._visFetchActive = 0;
    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._globalDirty = true;
    this._lastRecolorAt = 0;
    this._relaxKeys = [];
    this._relaxCursor = 0;
    this._relaxKeysDirty = true;
    this._lastHeight = 0;
  }

  _markRelaxListDirty() {
    this._relaxKeysDirty = true;
  }

  _ensureRelaxList() {
    if (!this._relaxKeysDirty) return;
    this._relaxKeys = [];
    for (const [id, tile] of this.tiles.entries()) {
      if (tile.type === 'interactive') this._relaxKeys.push(id);
    }
    this._relaxCursor = this._relaxKeys.length ? this._relaxCursor % this._relaxKeys.length : 0;
    this._relaxKeysDirty = false;
  }

  _drainRelaxQueue() {
    if (!this._relaxKeys.length) return;

    const nowPerf = () => (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
    const start = nowPerf();
    const len = this._relaxKeys.length;
    let processed = 0;

    while (processed < len) {
      if (nowPerf() - start > this.RELAX_FRAME_BUDGET_MS) break;

      if (!this._relaxKeys.length) break;
      const idx = this._relaxCursor % this._relaxKeys.length;
      const tileKey = this._relaxKeys[idx];
      this._relaxCursor = (this._relaxCursor + 1) % this._relaxKeys.length;
      processed++;

      const tile = this.tiles.get(tileKey);
      if (!tile || tile.type !== 'interactive') {
        this._markRelaxListDirty();
        continue;
      }

      if (tile.unreadyCount === 0) continue;

      this._ensureTileBuffers(tile);
      let did = false;
      for (let k = 0; k < this.RELAX_ITERS_PER_FRAME; k++) {
        if (this._relaxOnce(tile)) did = true;
        if (nowPerf() - start > this.RELAX_FRAME_BUDGET_MS) break;
      }
      if (did) this._pushBuffersToGeometry(tile);
    }
  }

  applyPerfProfile(profile = {}) {
    const qualityRaw = Number.isFinite(profile?.quality) ? profile.quality : this._lodQuality;
    const quality = THREE.MathUtils.clamp(qualityRaw, 0.3, 1.05);
    this._lodQuality = quality;

    const baseInteractive = this._baseLod.interactiveRing;
    const baseVisual = this._baseLod.visualRing;
    const interactive = baseInteractive;
    const visual = baseVisual;
    const createBudget = Math.round(18 + quality * 32);
    const relaxIters = Math.max(1, Math.round(quality * this._baseLod.relaxIters));
    const relaxBudget = 1 + quality * (this._baseLod.relaxBudget - 1);
    const maxVis = Math.max(4, Math.round(5 + quality * 11));

    let ringChanged = false;
    if (this.INTERACTIVE_RING !== interactive) {
      this.INTERACTIVE_RING = interactive;
      ringChanged = true;
    }
    if (this.VISUAL_RING !== visual) {
      this.VISUAL_RING = visual;
      ringChanged = true;
    }
    if (ringChanged) this._markRelaxListDirty();

    this.VISUAL_CREATE_BUDGET = createBudget;
    this.RELAX_ITERS_PER_FRAME = relaxIters;
    this.RELAX_FRAME_BUDGET_MS = relaxBudget;
    this.MAX_GLOBAL_CON_VIS = maxVis;

    return {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      visualCreateBudget: this.VISUAL_CREATE_BUDGET,
      relaxIters: this.RELAX_ITERS_PER_FRAME,
      relaxBudget: Number(this.RELAX_FRAME_BUDGET_MS.toFixed(2)),
    };
  }

  getHeightAt(x, z) {
    // collide with interactive tiles only
    const tmp = new THREE.Vector3(x, 10000, z);
    const meshes = [];
    for (const t of this.tiles.values()) if (t.type === 'interactive') meshes.push(t.grid.mesh);
    if (meshes.length === 0) return this._lastHeight;
    this.ray.set(tmp, this.DOWN);
    const hit = this.ray.intersectObjects(meshes, true);
    if (hit.length) { this._lastHeight = hit[0].point.y; return this._lastHeight; }
    return this._lastHeight;
  }

  dispose() {
    this._resetAllTiles();
    this.tiles.clear();
  }
}
