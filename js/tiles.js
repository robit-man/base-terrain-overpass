// tiles.js
import * as THREE from 'three';
import { UniformHexGrid, HexCenterPoint } from './grid.js';
import { now } from './utils.js';
import { worldToLatLon } from './geolocate.js';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';
import { TerrainRelay } from './terrainRelay.js';

const DEFAULT_TERRAIN_RELAY = 'forwarder.4658c990865d63ad367a3f9e26203df9ad544f9d58ef27668db4f3ebc570eb5f';
const DEFAULT_TERRAIN_DATASET = 'mapzen';
const DM_BUDGET_BYTES = 2800;
const MAX_LOCATIONS_PER_BATCH = 800;
const PIN_SIDE_INNER_RATIO = 0.501; // 0.94 ≈ outer 6% of the tile; try 0.92 for thicker band

// phased acquisition for interactive tiles
const PHASE_SEED = 0; // center + 6 tips
const PHASE_EDGE = 1; // midpoints on 6 sides
const PHASE_FULL = 2; // remaining unknowns / full pass

// axial neighbors for hex tiles (pointy-top)
const HEX_DIRS = [
  [1, 0], [1, -1], [0, -1],
  [-1, 0], [-1, 1], [0, 1],
];

export class TileManager {
  constructor(scene, spacing = 10, tileRadius = 30, audio = null) {
    this.scene = scene; this.spacing = spacing; this.tileRadius = tileRadius;
    this.audio = audio;   // spatial audio engine
    this.tiles = new Map(); this.origin = null;
    this._perfLogNext = 0;
    this._perfUpdateNext = 0;
    this._nextFarfieldLog = 0;

    // ---- LOD configuration ----
    this.INTERACTIVE_RING = 2;
    this.VISUAL_RING = 10;
    this.FARFIELD_EXTRA = 10;
    this.FARFIELD_RING = this.VISUAL_RING + this.FARFIELD_EXTRA;
    // turbo: do not throttle per-frame visual tile creation
    this.VISUAL_CREATE_BUDGET = 4;
    this.FARFIELD_CREATE_BUDGET = 60;
    this.FARFIELD_BATCH_SIZE = 48;

    // ---- interactive (high-res) relaxation ----
    this.RELAX_ITERS_PER_FRAME = 0;
    this.RELAX_ALPHA = 0.2;
    this.NORMALS_EVERY = 10;
    // keep relax cheap so fetching dominates
    this.RELAX_FRAME_BUDGET_MS = 0;

    // ---- GLOBAL grayscale controls (altitude => luminance) ----
    this.LUM_MIN = 0.05;
    this.LUM_MAX = 0.90;
    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._globalDirty = false;
    this._lastRecolorAt = 0;

    // ---- wireframe colors ----
    this.VISUAL_WIREFRAME_COLOR = 0xffffff;
    this.INTERACTIVE_WIREFRAME_COLOR = 0xffffff;

    // ---- caching config ----
    this.CACHE_VER = 'v1';
    this._originCacheKey = 'na';
    this._fetchPhase = 'interactive';

    this.ray = new THREE.Raycaster();
    this.DOWN = new THREE.Vector3(0, -1, 0);
    this._lastHeight = 0;

    this._relaxKeys = [];
    this._relaxCursor = 0;
    this._relaxKeysDirty = true;

    if (!scene.userData._tmLightsAdded) {
      scene.add(new THREE.AmbientLight(0xffffff, .055));
      const sun = new THREE.DirectionalLight(0xffffff, .065);
      sun.position.set(50, 100, 50); sun.castShadow = false; scene.add(sun);
      scene.userData._tmLightsAdded = true;
    }

    this._baseLod = {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      visualCreateBudget: this.VISUAL_CREATE_BUDGET,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      relaxIters: this.RELAX_ITERS_PER_FRAME,
      relaxBudget: this.RELAX_FRAME_BUDGET_MS,
    };
    this._lodQuality = 1;

    // ---- Relay wiring ----
    this.relayMode = 'geohash';
    this.relayAddress = DEFAULT_TERRAIN_RELAY;
    this.relayDataset = DEFAULT_TERRAIN_DATASET;
    this.relayTimeoutMs = 45000;
    this._relayStatus = { text: 'idle', level: 'info' };
    this._relayWasConnected = false;

    this.terrainRelay = new TerrainRelay({
      defaultRelay: this.relayAddress,
      dataset: this.relayDataset,
      mode: this.relayMode,
      onStatus: (text, level) => this._onRelayStatus(text, level),
    });

    // ---- populate plumbing (PHASED) ----
    this._populateQueue = [];          // entries: { tile, phase, priority }
    this._populateInflight = 0;
    this._populateBusy = false;        // legacy flag
    this.MAX_CONCURRENT_POPULATES = 12; // try 16–24 if the relay tolerates it
    this._encoder = new TextEncoder();

    // ---- network governor (token bucket) ----
    this.RATE_QPS = 12;               // max terrainRelay calls per second
    this.RATE_BPS = 256 * 1024;       // max payload bytes per second
    this._rateTokensQ = this.RATE_QPS;
    this._rateTokensB = this.RATE_BPS;
    this._rateBucketResetAt = (performance?.now?.() ?? Date.now());
    this._rateTicker = setInterval(() => {
      this._rateTokensQ = this.RATE_QPS;
      this._rateTokensB = this.RATE_BPS;
      this._drainPopulateQueue();
    }, 1000);

    // Backfill scheduler (faster cadence)
    this._backfillTimer = null;
    this._backfillIntervalMs = 1200; // was 2500
    this._periodicBackfill = setInterval(
      () => this._backfillMissing({ onlyIfRelayReady: true }),
      this._backfillIntervalMs
    );
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

  _interactiveWireFade(dist) {
    if (!Number.isFinite(this.INTERACTIVE_RING) || this.INTERACTIVE_RING <= 0) return 0;
    const t = THREE.MathUtils.clamp(dist / Math.max(1, this.INTERACTIVE_RING), 0, 1);
    const smooth = THREE.MathUtils.smoothstep(0, 1, t);
    return THREE.MathUtils.clamp(smooth * 0.55, 0, 0.55);
  }

  _visualWireFade(dist) {
    const span = Math.max(1, this.VISUAL_RING - this.INTERACTIVE_RING);
    const t = THREE.MathUtils.clamp((dist - this.INTERACTIVE_RING) / span, 0, 1);
    const smooth = THREE.MathUtils.smoothstep(0, 1, t);
    return THREE.MathUtils.clamp(0.20 + smooth * 0.75, 0, 0.95);
  }

  _makeDisintegratingWireMaterial(color, fade = 0.5) {
    const mat = new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.82,
      depthWrite: false
    });

    mat.userData.uFade = THREE.MathUtils.clamp(fade, 0.0, 0.99);
    mat.userData.uTileRadius = this.tileRadius;

    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uFade = { value: mat.userData.uFade };
      shader.uniforms.uTileRadius = { value: mat.userData.uTileRadius };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n varying vec3 vWorldPos;\n varying vec3 vLocalPos;\n')
        .replace('#include <project_vertex>', '#include <project_vertex>\n vLocalPos = position;\n vWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;\n');

      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n varying vec3 vWorldPos;\n varying vec3 vLocalPos;\n uniform float uFade;\n uniform float uTileRadius;\n float hash13(vec3 p) {\n   p = fract(p * 0.3183099 + vec3(0.1,0.3,0.7));\n   p += dot(p, p.yzx + 19.19);\n   return fract((p.x + p.y) * p.z);\n }\n')
        .replace('#include <output_fragment>', 'float radial = clamp(length(vLocalPos.xz) / max(uTileRadius, 1e-3), 0.0, 1.0);\n vec3 hashInput = vec3(floor(vWorldPos.x * 0.35), floor(vWorldPos.z * 0.35), 0.0);\n float noise = hash13(hashInput);\n float radialBoost = mix(0.05, 0.55, radial);\n float fragFade = clamp(uFade + radialBoost * uFade + radial * 0.15, 0.0, 0.975);\n if (noise < fragFade) discard;\n #include <output_fragment>');

      mat.userData.shader = shader;
    };

    mat.onBeforeRender = () => {
      if (mat.userData.shader) {
        mat.userData.shader.uniforms.uFade.value = mat.userData.uFade;
        mat.userData.shader.uniforms.uTileRadius.value = mat.userData.uTileRadius;
      }
    };

    mat.customProgramCacheKey = () => `disintegrating-${color}`;
    return mat;
  }

  _getTile(q, r) { return this.tiles.get(`${q},${r}`) || null; }
  _getMeshForTile(t) { return t?.grid?.mesh || null; }
  _gatherNeighborMeshes(q, r) {
    const out = [];
    for (const [dq, dr] of HEX_DIRS) {
      const n = this._getTile(q + dq, r + dr);
      const m = this._getMeshForTile(n);
      if (m) out.push(m);
    }
    return out;
  }

  _robustSampleHeight(wx, wz, primaryMesh, neighborMeshes, nearestGeomAttr, approx = this._lastHeight) {
    this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
    if (primaryMesh) {
      const hit = this.ray.intersectObject(primaryMesh, true);
      if (hit && hit.length) return hit[0].point.y;
    }
    for (let i = 0; i < neighborMeshes.length; i++) {
      const hit = this.ray.intersectObject(neighborMeshes[i], true);
      if (hit && hit.length) return hit[0].point.y;
    }
    if (nearestGeomAttr?.isBufferAttribute) {
      let best = Infinity, bestY = approx;
      const arr = nearestGeomAttr.array;
      const px = (primaryMesh?.parent?.position.x || 0);
      const pz = (primaryMesh?.parent?.position.z || 0);
      for (let i = 0; i < arr.length; i += 3) {
        const dx = (arr[i] + px) - wx;
        const dz = (arr[i + 2] + pz) - wz;
        const d2 = dx * dx + dz * dz;
        if (d2 < best) { best = d2; bestY = arr[i + 1]; }
      }
      return bestY;
    }
    return approx;
  }

  // tighter rim: only the true outermost ring
  _isRimVertex(tile, idx) {
    const x = tile.pos.getX(idx), z = tile.pos.getZ(idx);
    const r2 = x * x + z * z;
    const a = this.tileRadius;
    const rim = a * 0.985; // tighter than before: avoid grabbing near-rim neighbors
    return r2 >= rim * rim;
  }

  _angleOf(x, z) {
    let a = Math.atan2(z, x);
    if (a < 0) a += Math.PI * 2;
    return a; // [0, 2π)
  }
  _angDiff(a, b) {
    let d = Math.abs(a - b);
    if (d > Math.PI) d = 2 * Math.PI - d;
    return d;
  }

  // classify outer ring into 6 sides and 6 corners (by angle & radius)
  _classifyRimAndCorners(tile) {
    const pos = tile.pos;
    const aR = this.tileRadius;
    const RIM_MIN = aR * 0.972;     // outer band
    const CORNER_MIN = aR * 0.985;  // the very tips
    const CORNER_ARC = Math.PI / 15; // ~12°
    const SIDE_ARC = Math.PI / 12;   // classify to nearest side direction

    // corner directions at 0,60,120...
    const cornerAng = Array.from({ length: 6 }, (_, i) => i * (Math.PI / 3));
    // side directions halfway between corners (30°, 90°, ...)
    const sideAng = Array.from({ length: 6 }, (_, i) => (i + 0.5) * (Math.PI / 3));

    const sides = Array.from({ length: 6 }, () => []);
    const corners = Array.from({ length: 6 }, () => []);
    const rim = [];

    // inner band near corners (helps prevent folding right behind the tip)
    const innerCornerBand = new Set();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < RIM_MIN) {
        // mark inner band around corners
        if (r >= aR * 0.92) {
          const a = this._angleOf(x, z);
          for (let c = 0; c < 6; c++) {
            if (this._angDiff(a, cornerAng[c]) < CORNER_ARC) {
              innerCornerBand.add(i);
              break;
            }
          }
        }
        continue;
      }
      rim.push(i);

      const a = this._angleOf(x, z);
      // corner?
      let isCorner = false;
      if (r >= CORNER_MIN) {
        for (let c = 0; c < 6; c++) {
          if (this._angDiff(a, cornerAng[c]) < CORNER_ARC) {
            corners[c].push(i);
            isCorner = true;
            break;
          }
        }
      }
      if (isCorner) continue;

      // otherwise side: pick nearest side direction
      let best = 0, bestD = Infinity;
      for (let s = 0; s < 6; s++) {
        const d = this._angDiff(a, sideAng[s]);
        if (d < bestD) { bestD = d; best = s; }
      }
      if (bestD < SIDE_ARC) sides[best].push(i);
      else {
        // fallback: still treat as side using nearest
        sides[best].push(i);
      }
    }

    return { rim, sides, corners, innerCornerBand };
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
    // ensure lock mask
    if (!tile.locked || tile.locked.length !== n) {
      tile.locked = new Uint8Array(n); // 1 => pinned (do not relax/smooth)
    }
  }
  _relaxOnce(tile) {
    if (tile.type !== 'interactive') return false;
    if (tile.relaxEnabled !== true) return false;
    if (tile.fetched.size === 0) return false;
    if (typeof tile.unreadyCount !== 'number') tile.unreadyCount = tile.pos.count;
    if (tile.unreadyCount === 0) return false;

    const ready = tile.ready;
    const locked = tile.locked || new Uint8Array(tile.pos.count);
    const adj = tile.neighbors;
    const read = tile.flip ? tile.yB : tile.yA;
    const write = tile.flip ? tile.yA : tile.yB;
    const alpha = this.RELAX_ALPHA;

    for (let i = 0; i < tile.pos.count; i++) {
      if (ready[i] || locked[i]) { write[i] = read[i]; continue; }
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
      if (tile.type !== 'farfield') tile.grid.geometry.computeVertexNormals();
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
  _initFarfieldColors(tile) {
    const col = this._ensureColorAttr(tile);
    const arr = col.array;
    for (let i = 0; i < tile.pos.count; i++) {
      const o = 3 * i;
      arr[o] = arr[o + 1] = arr[o + 2] = 1;
    }
    col.needsUpdate = true;
    if (tile.grid?.mat) tile.grid.mat.color?.set?.(0xffffff);
  }
  _updateGlobalFromValue(y) {
    let changed = false;
    if (y < this.GLOBAL_MIN_Y) { this.GLOBAL_MIN_Y = y; changed = true; }
    if (y > this.GLOBAL_MAX_Y) { this.GLOBAL_MAX_Y = y; changed = true; }
    if (changed) this._globalDirty = true;
  }
  _updateGlobalFromArray(arr) { for (let i = 0; i < arr.length; i++) this._updateGlobalFromValue(arr[i]); }
  _lumFromYGlobal(y) {
    const minY = this.GLOBAL_MIN_Y, maxY = this.GLOBAL_MAX_Y;
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY - minY < 1e-6) return this.LUM_MIN;
    const t = THREE.MathUtils.clamp((y - minY) / (maxY - minY), 0, 1);
    return this.LUM_MIN + t * (this.LUM_MAX - this.LUM_MIN);
  }
  _applyAllColorsGlobal(tile) {
    if (tile.type === 'farfield') {
      this._initFarfieldColors(tile);
      return;
    }
    this._ensureColorAttr(tile);
    const arr = tile.col.array, pos = tile.pos;
    for (let i = 0; i < pos.count; i++) {
      const l = this._lumFromYGlobal(pos.getY(i));
      const o = 3 * i;
      arr[o] = arr[o + 1] = arr[o + 2] = l / 10;
    }
    tile.col.needsUpdate = true;
  }

  _collectTileLatLon(tile) {
    const pos = tile.pos;
    const out = new Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const wx = tile.grid.group.position.x + pos.getX(i);
      const wz = tile.grid.group.position.z + pos.getZ(i);
      const ll = worldToLatLon(wx, wz, this.origin.lat, this.origin.lon);
      const lat = Number.isFinite(ll?.lat) ? ll.lat : this.origin.lat;
      const lon = Number.isFinite(ll?.lon) ? ll.lon : this.origin.lon;
      out[i] = { lat: Number(lat.toFixed(6)), lng: Number(lon.toFixed(6)) };
    }
    return out;
  }

  _indicesToBatchesLatLng(indices, latLon) {
    const batches = [];
    let cur = [];
    let curBytes = 0;
    for (const idx of indices) {
      const loc = latLon[idx];
      const candidate = { type: 'elev.query', dataset: this.relayDataset, locations: cur.concat([loc]) };
      const bytes = this._encoder.encode(JSON.stringify(candidate)).length;
      if (bytes <= DM_BUDGET_BYTES && candidate.locations.length <= MAX_LOCATIONS_PER_BATCH) {
        cur.push(loc);
        curBytes = bytes;
      } else {
        if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes });
        cur = [loc];
        curBytes = this._encoder.encode(JSON.stringify({ type: 'elev.query', dataset: this.relayDataset, locations: cur })).length;
      }
    }
    if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes });
    return batches;
  }

  _indicesToBatchesGeohash(indices, geohashes, precision) {
    const meta = { enc: 'geohash', prec: precision };
    const batches = [];
    let cur = [];
    let curBytes = 0;
    for (const idx of indices) {
      const gh = geohashes[idx];
      const candidate = { type: 'elev.query', dataset: this.relayDataset, geohashes: cur.concat([gh]), ...meta };
      const bytes = this._encoder.encode(JSON.stringify(candidate)).length;
      if (bytes <= DM_BUDGET_BYTES && candidate.geohashes.length <= MAX_LOCATIONS_PER_BATCH) {
        cur.push(gh);
        curBytes = bytes;
      } else {
        if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes, meta });
        cur = [gh];
        curBytes = this._encoder.encode(JSON.stringify({ type: 'elev.query', dataset: this.relayDataset, geohashes: cur, ...meta })).length;
      }
    }
    if (cur.length) batches.push({ items: cur.slice(), bytes: curBytes, meta });
    return batches;
  }

  _applyRelayResults(tile, results, { mode, indexByLatLon, indexByGeohash }) {
    for (const res of results) {
      let idx;
      if (mode === 'geohash') {
        const key = res.geohash || res.hash;
        idx = key ? indexByGeohash?.get(key) : undefined;
      } else if (res.location) {
        const { lat, lng } = res.location;
        const key = `${(+lat).toFixed(6)},${(+lng).toFixed(6)}`;
        idx = indexByLatLon?.get(key);
      }
      if (idx == null) continue;
      const height = Number(res.elevation);
      if (!Number.isFinite(height)) continue;
      // unlock if we had pinned this vertex previously
      if (tile.locked) tile.locked[idx] = 0;
      this._applySample(tile, idx, height);
    }
  }

  _applySample(tile, idx, height) {
    const pos = tile.pos;
    pos.setY(idx, height);
    pos.needsUpdate = true;

    if (tile.ready[idx] !== 1) tile.unreadyCount = Math.max(0, tile.unreadyCount - 1);
    tile.ready[idx] = 1;
    tile.fetched.add(idx);

    // data landed: make sure the pin is released
    if (tile.locked) tile.locked[idx] = 0;

    this._pullGeometryToBuffers(tile, idx);
    this._updateGlobalFromValue(height);

    if (!tile.col) this._ensureColorAttr(tile);
    const o = 3 * idx;
    if (tile.type === 'farfield') {
      tile.col.array[o] = tile.col.array[o + 1] = tile.col.array[o + 2] = 1;
    } else {
      const l = this._lumFromYGlobal(height);
      tile.col.array[o] = tile.col.array[o + 1] = tile.col.array[o + 2] = l;
    }
    tile.col.needsUpdate = true;

    if (this.audio) {
      const wx = tile.grid.group.position.x + tile.pos.getX(idx);
      const wy = height;
      const wz = tile.grid.group.position.z + tile.pos.getZ(idx);
      this.audio.triggerScratch(wx, wy, wz, 0.9);
    }
  }

  _nearestAnchorFill(tile) {
    const ready = tile.ready;
    const locked = tile.locked || new Uint8Array(tile.pos.count);
    const pos = tile.pos;
    const n = pos.count;
    const nearest = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    let head = 0; let tail = 0;

    for (let i = 0; i < n; i++) {
      // treat locked surface as seeds too
      if (ready[i] || locked[i]) {
        nearest[i] = i;
        queue[tail++] = i;
      }
    }
    if (tail === 0) return;

    while (head < tail) {
      const cur = queue[head++];
      for (const nbr of tile.neighbors[cur]) {
        if (nearest[nbr] !== -1) continue;
        nearest[nbr] = nearest[cur];
        queue[tail++] = nbr;
      }
    }

    for (let i = 0; i < n; i++) {
      if (ready[i] || locked[i]) continue;
      const src = nearest[i];
      if (src === -1) continue;
      const y = pos.getY(src);
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    if (tile.col) tile.col.needsUpdate = true;
  }

  _smoothUnknowns(tile, iterations = 1) {
    const pos = tile.pos;
    const ready = tile.ready;
    const locked = tile.locked || new Uint8Array(pos.count);
    const next = new Float32Array(pos.count);

    for (let iter = 0; iter < iterations; iter++) {
      let touched = false;
      for (let i = 0; i < pos.count; i++) {
        if (ready[i] || locked[i]) continue;
        let sum = 0;
        let cnt = 0;
        for (const nbr of tile.neighbors[i]) {
          const y = pos.getY(nbr);
          if (Number.isFinite(y)) { sum += y; cnt++; }
        }
        if (cnt >= 2) {
          const val = sum / cnt;
          next[i] = val;
          touched = true;
        } else {
          next[i] = pos.getY(i);
        }
      }
      if (!touched) break;
      for (let i = 0; i < pos.count; i++) {
        if (ready[i] || locked[i]) continue;
        pos.setY(i, next[i]);
      }
      pos.needsUpdate = true;
    }
  }

  /* ---------- caching helpers ---------- */

  _originKeyForCache(lat, lon) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'na';
    const quant = (value) => (Math.round(value * 100000) / 100000).toFixed(5);
    return `${quant(lat)},${quant(lon)}`;
  }
  _cacheKey(tile) {
    const originKey = this._originCacheKey || 'na';
    const datasetKey = (this.relayDataset || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40);
    return `tile:${this.CACHE_VER}:${originKey}:${tile.type}:${this.spacing}:${this.tileRadius}:${datasetKey}:${this.relayMode}:${tile.q},${tile.r}`;
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
      if (tile.type !== 'farfield') tile.grid.geometry.computeVertexNormals();

      tile.ready = new Uint8Array(tile.pos.count);
      tile.ready.fill(1);
      tile.fetched = new Set();
      tile.populating = false;
      tile.unreadyCount = 0;

      this._ensureTileBuffers(tile);
      this._pullGeometryToBuffers(tile);

      this._updateGlobalFromArray(data.y);
      this._applyAllColorsGlobal(tile);

      // consider interactive cache as full-done
      if (!tile._phase) tile._phase = {};
      if (tile.type === 'interactive') {
        tile._phase.seedDone = true;
        tile._phase.edgeDone = true;
        tile._phase.fullDone = true;
        tile.relaxEnabled = false;
      } else {
        tile._phase.fullDone = true;
      }

      if (!this._tileNeedsFetch(tile)) this._tryAdvanceFetchPhase(tile);
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

    const dist = this._hexDist(q, r, 0, 0);
    const interactiveFade = this._interactiveWireFade(dist);
    const wireMat = this._makeDisintegratingWireMaterial(this.INTERACTIVE_WIREFRAME_COLOR, interactiveFade);
    const wire = new THREE.Mesh(grid.geometry, wireMat);
    wire.frustumCulled = false; wire.renderOrder = 1;
    grid.group.add(wire);
    grid.wire = wire;

    const pos = grid.geometry.attributes.position;
    const neighbors = this._buildAdjacency(grid.geometry.getIndex(), pos.count);
    const ready = new Uint8Array(pos.count);

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
      unreadyCount: pos.count,
      _phase: { seedDone: false, edgeDone: false, fullDone: false },
      _queuedPhases: new Set(),
      locked: new Uint8Array(pos.count),
      relaxEnabled: false,
      wire
    };
    this._ensureTileBuffers(tile);
    this.tiles.set(id, tile);

    this._initColorsNearBlack(tile);
    this._markRelaxListDirty();

    if (!this._tryLoadTileFromCache(tile)) {
      this._queuePopulate(tile, true);
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
      pos[3 * i + 0] = verts[i].x;
      pos[3 * i + 1] = 0;
      pos[3 * i + 2] = verts[i].z;
    }
    const idx = [];
    for (let i = 1; i <= 6; i++) { const j = i === 6 ? 1 : i + 1; idx.push(0, i, j); }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geom.setIndex(idx);

    const cols = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) { const o = 3 * i; cols[o] = cols[o + 1] = cols[o + 2] = this.LUM_MIN; }
    geom.setAttribute('color', new THREE.BufferAttribute(cols, 3).setUsage(THREE.DynamicDrawUsage));
    geom.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.BackSide, metalness: .05, roughness: .05, transparent: true, opacity: 1, color: 0x000000 });
    const mesh = new THREE.Mesh(geom, mat); mesh.frustumCulled = false;

    const group = new THREE.Group(); group.add(mesh);
    return { group, mesh, geometry: geom, mat };
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
    const neighbors = this._buildAdjacency(low.geometry.getIndex(), pos.count);

    const dist = this._hexDist(q, r, 0, 0);
    const visualFade = this._visualWireFade(dist);
    const wireMat = this._makeDisintegratingWireMaterial(this.VISUAL_WIREFRAME_COLOR, visualFade);
    const wire = new THREE.Mesh(low.geometry, wireMat);
    wire.frustumCulled = false; wire.renderOrder = 1;
    low.group.add(wire);
    low.wire = wire;

    const tile = {
      type: 'visual',
      grid: { group: low.group, mesh: low.mesh, geometry: low.geometry, mat: low.mat },
      q, r,
      pos,
      neighbors,
      ready,
      fetched: new Set(),
      populating: false,
      unreadyCount: pos.count,
      col: low.geometry.attributes.color,
      _phase: { fullDone: false },
      _queuedPhases: new Set(),
      wire
    };
    this.tiles.set(id, tile);

    if (!this._tryLoadTileFromCache(tile)) {
      this._queuePopulate(tile, false);
    }
    return tile;
  }

  /* ---------------- creation: farfield tile (center point) ---------------- */

  _addFarfieldTile(q, r) {
    const id = `${q},${r}`;
    if (this.tiles.has(id)) return this.tiles.get(id);

    const far = new HexCenterPoint(this.tileRadius * 2);
    far.group.name = `tile-far-${id}`;
    const wp = this._axialWorld(q, r);
    far.group.position.set(wp.x, 0, wp.z);
    this.scene.add(far.group);

    const pos = far.geometry.attributes.position;
    const ready = new Uint8Array(pos.count);
    const neighbors = Array.from({ length: pos.count }, () => []);
    const colAttr = far.geometry.attributes.color;
    if (colAttr) colAttr.setUsage(THREE.DynamicDrawUsage);

    const tile = {
      type: 'farfield',
      grid: { group: far.group, points: far.points, geometry: far.geometry, mat: far.mat },
      q, r,
      pos,
      neighbors,
      ready,
      fetched: new Set(),
      populating: false,
      unreadyCount: pos.count,
      col: far.geometry.attributes.color,
      _phase: { fullDone: false },
      _queuedPhases: new Set()
    };
    this.tiles.set(id, tile);

    this._initFarfieldColors(tile);

    if (tile.grid?.points?.material) {
      const mat = tile.grid.points.material;
      mat.transparent = false;
      mat.opacity = 1;
      mat.sizeAttenuation = false;
      mat.size = Math.max(0.5, this.tileRadius * 0.03);
      if (mat.color && typeof mat.color.setHex === 'function') mat.color.setHex(0x8aa0c0);
      mat.needsUpdate = true;
    }

    if (!this._nextFarfieldLog || this._nowMs() >= this._nextFarfieldLog) {
      console.log('[tiles.farfield] add', { id, points: tile.pos.count });
      this._nextFarfieldLog = this._nowMs() + 2000;
    }

    if (!this._tryLoadTileFromCache(tile)) {
      this._queuePopulate(tile, false);
    }
    return tile;
  }

  /* ---------------- promotion: visual -> interactive (seam + corner safe) ---------------- */

  _promoteVisualToInteractive(q, r) {
    const id = `${q},${r}`;
    const v = this.tiles.get(id);
    if (!v || v.type !== 'visual') return this._addInteractiveTile(q, r);

    const grid = new UniformHexGrid(this.spacing, this.tileRadius * 2);
    grid.group.name = `tile-${id}`;
    grid.group.position.copy(v.grid.group.position);
    this.scene.add(grid.group);

    const dist = this._hexDist(q, r, 0, 0);
    const interactiveFade = this._interactiveWireFade(dist);
    const wireMat = this._makeDisintegratingWireMaterial(this.INTERACTIVE_WIREFRAME_COLOR, interactiveFade);
    const wire = new THREE.Mesh(grid.geometry, wireMat);
    wire.frustumCulled = false; wire.renderOrder = 1;
    grid.group.add(wire);
    grid.wire = wire;

    const pos = grid.geometry.attributes.position;
    const neighbors = this._buildAdjacency(grid.geometry.getIndex(), pos.count);
    const ready = new Uint8Array(pos.count);

    const t = {
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
      unreadyCount: pos.count,
      _phase: { seedDone: false, edgeDone: false, fullDone: false },
      _queuedPhases: new Set(),
      locked: new Uint8Array(pos.count),
      relaxEnabled: false,
      wire
    };

    // Seed heights from visual + neighbors, but corner-aware
    const lowMesh = v.grid.mesh;
    const lowPosAttr = v.grid.geometry?.attributes?.position || null;
    const neighborMeshes = this._gatherNeighborMeshes(q, r);
    const base = grid.group.position;

    for (let i = 0; i < pos.count; i++) {
      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);

      const y = this._robustSampleHeight(wx, wz, lowMesh, neighborMeshes, lowPosAttr, this._lastHeight);
      pos.setY(i, Number.isFinite(y) ? y : 0);
    }
    pos.needsUpdate = true;
    grid.geometry.computeVertexNormals();

    this._ensureTileBuffers(t);
    this._pullGeometryToBuffers(t);
    this._initColorsNearBlack(t);
    this._applyAllColorsGlobal(t);

    // Swap into map, dispose low-res
    this.tiles.set(id, t);
    this._markRelaxListDirty();
    try {
      this.scene.remove(v.grid.group);
      v.grid.geometry?.dispose?.();
      v.grid.mat?.dispose?.();
      v.wire?.material?.dispose?.();
    } catch { }

    // Seal edges with corner-safe snapping and relax inner corner band
    this._sealEdgesCornerSafe(t);
    this._fixStuckZeros(t, /*rimOnly=*/true);

    // Fetch phased full-res now
    this._queuePopulate(t, true);
    return t;
  }

  /* ---------------- hard edge sealing from corners (pin) ---------------- */

  _selectCenterIndex(tile) {
    let best = 0, bestR2 = Infinity;
    const pos = tile.pos;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r2 = x * x + z * z;
      if (r2 < bestR2) { bestR2 = r2; best = i; }
    }
    return best;
  }

  _selectCornerTipIndices(tile) {
    const cls = this._classifyRimAndCorners(tile);
    const tips = [];
    for (let c = 0; c < 6; c++) {
      const arr = cls.corners[c];
      if (!arr || !arr.length) continue;
      let pick = arr[0], best = -Infinity;
      for (const i of arr) {
        const x = tile.pos.getX(i), z = tile.pos.getZ(i);
        const r2 = x * x + z * z;
        if (r2 > best) { best = r2; pick = i; }
      }
      tips.push(pick);
    }
    return tips;
  }

  _selectEdgeMidpointIndices(tile) {
    const aR = this.tileRadius;
    const sideAng = Array.from({ length: 6 }, (_, i) => (i + 0.5) * (Math.PI / 3));
    const cls = this._classifyRimAndCorners(tile);
    const picks = [];
    for (let s = 0; s < 6; s++) {
      const arr = cls.sides[s];
      if (!arr || !arr.length) continue;
      let pick = arr[0], best = Infinity;
      for (const i of arr) {
        const x = tile.pos.getX(i), z = tile.pos.getZ(i);
        const r = Math.hypot(x, z);
        if (r < aR * 0.96) continue; // prefer near rim
        const a = this._angleOf(x, z);
        const d = this._angDiff(a, sideAng[s]);
        if (d < best) { best = d; pick = i; }
      }
      picks.push(pick);
    }
    return picks;
  }
  // Make the perimeter identical to the visual hex: for each of the 6 sides,
  // force the TRUE rim vertices to lie on the straight segment between its
  // adjacent corner tips. Lock them so relax/smooth cannot curve the edge.
  _pinEdgesFromCorners(tile) {
    if (!tile || tile.type !== 'interactive') return;

    const pos = tile.pos;
    const n = pos.count;
    const aR = this.tileRadius;

    // Use the classifier to find rim + per-side membership, but filter to the *true* rim.
    const cls = this._classifyRimAndCorners(tile);
    const tips = this._selectCornerTipIndices(tile);
    if (!tips || tips.length < 6) return;

    // We only want the outermost ring for each side.
    const RIM_STRICT = aR * 0.985; // match _isRimVertex threshold
    const sideRimStrict = Array.from({ length: 6 }, () => []);
    for (let s = 0; s < 6; s++) {
      const list = cls.sides[s] || [];
      for (const i of list) {
        const x = pos.getX(i), z = pos.getZ(i);
        if (x * x + z * z >= RIM_STRICT * RIM_STRICT) sideRimStrict[s].push(i);
      }
    }

    const locked = tile.locked || new Uint8Array(n);

    // For each side, project rim verts onto the side segment (tip->tip) and set y by linear interpolation
    for (let s = 0; s < 6; s++) {
      const iA = tips[s];
      const iB = tips[(s + 1) % 6];
      if (iA == null || iB == null) continue;

      const Ax = pos.getX(iA), Az = pos.getZ(iA), Ay = pos.getY(iA);
      const Bx = pos.getX(iB), Bz = pos.getZ(iB), By = pos.getY(iB);

      // if tips aren't finite yet (e.g. before SEED lands), skip this side
      if (!Number.isFinite(Ay) || !Number.isFinite(By)) continue;

      const ABx = Bx - Ax, ABz = Bz - Az;
      const denom = ABx * ABx + ABz * ABz;
      if (denom < 1e-8) continue;

      for (const i of sideRimStrict[s]) {
        if (tile.ready[i]) continue;  // don't overwrite fetched data

        // Parametric projection onto AB -> t in [0..1]
        const Px = pos.getX(i), Pz = pos.getZ(i);
        let t = ((Px - Ax) * ABx + (Pz - Az) * ABz) / denom;
        if (!Number.isFinite(t)) t = 0;
        if (t < 0) t = 0; else if (t > 1) t = 1;

        // Interpolate height along the straight edge
        const y = Ay + t * (By - Ay);
        pos.setY(i, y);
        locked[i] = 1;               // keep the rim straight; relax/smooth ignore locked
      }
    }

    tile.locked = locked;
    pos.needsUpdate = true;
  }

  _projectInteractiveSeed(tile) {
    if (!tile || tile.type !== 'interactive') return false;

    const centerIdx = this._selectCenterIndex(tile);
    const cornerIdx = this._selectCornerTipIndices(tile);
    if (!Number.isInteger(centerIdx) || !cornerIdx || cornerIdx.length < 6) return false;
    if (!tile.ready[centerIdx]) return false;

    const pos = tile.pos;
    const locked = tile.locked || new Uint8Array(pos.count);
    const centerX = pos.getX(centerIdx);
    const centerZ = pos.getZ(centerIdx);
    const centerY = pos.getY(centerIdx);

    const cornerSet = new Set(cornerIdx);
    const triangles = [];
    for (let i = 0; i < 6; i++) {
      const idxA = cornerIdx[i];
      const idxB = cornerIdx[(i + 1) % 6];
      if (!tile.ready[idxA] || !tile.ready[idxB]) continue;

      const ax = pos.getX(idxA) - centerX;
      const az = pos.getZ(idxA) - centerZ;
      const ay = pos.getY(idxA);
      const bx = pos.getX(idxB) - centerX;
      const bz = pos.getZ(idxB) - centerZ;
      const by = pos.getY(idxB);
      const denom = ax * bz - bx * az;
      if (Math.abs(denom) < 1e-6) continue;

      triangles.push({
        idxA,
        idxB,
        ax,
        az,
        ay,
        bx,
        bz,
        by,
        denom
      });
    }

    if (triangles.length === 0) return false;

    let changed = false;
    for (let i = 0; i < pos.count; i++) {
      if (i === centerIdx) continue;
      if (cornerSet.has(i)) continue;
      if (tile.ready[i]) continue;
      if (locked[i]) continue;

      const px = pos.getX(i) - centerX;
      const pz = pos.getZ(i) - centerZ;

      let height = null;
      for (const tri of triangles) {
        const u = (px * tri.bz - tri.bx * pz) / tri.denom;
        const v = (tri.ax * pz - px * tri.az) / tri.denom;
        const w = 1 - u - v;
        if (u >= -1e-5 && v >= -1e-5 && w >= -1e-5) {
          height = w * centerY + u * tri.ay + v * tri.by;
          break;
        }
      }

      if (height == null) height = centerY;
      pos.setY(i, height);
      changed = true;
    }

    if (changed) {
      pos.needsUpdate = true;
      this._pullGeometryToBuffers(tile);
    }

    return changed;
  }



  _sealEdgesCornerSafe(tile) {
    if (!tile || tile.type !== 'interactive') return;

    const cls = this._classifyRimAndCorners(tile);
    const pos = tile.pos;
    const base = tile.grid.group.position;

    const locked = tile.locked || new Uint8Array(pos.count);

    // helper: raycast to a specific neighbor first
    const rayToMesh = (mesh, x, z) => {
      if (!mesh) return null;
      this.ray.set(new THREE.Vector3(x, 1e6, z), this.DOWN);
      const hit = this.ray.intersectObject(mesh, true);
      return (hit && hit.length) ? hit[0].point.y : null;
    };

    // side snapping: prefer the opposite side neighbor
    for (let s = 0; s < 6; s++) {
      const nq = tile.q + HEX_DIRS[s][0];
      const nr = tile.r + HEX_DIRS[s][1];
      const nTile = this._getTile(nq, nr);
      const nMesh = this._getMeshForTile(nTile);

      for (const i of cls.sides[s]) {
        if (locked[i]) continue; // don't override pinned straight edge
        const wx = base.x + pos.getX(i);
        const wz = base.z + pos.getZ(i);

        let y = null;
        if (nMesh) y = rayToMesh(nMesh, wx, wz);
        if (y == null) {
          // fallback: any neighbor
          this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
          const hits = this.ray.intersectObjects(this._gatherNeighborMeshes(tile.q, tile.r), true);
          if (hits && hits.length) y = hits[0].point.y;
        }
        if (Number.isFinite(y)) pos.setY(i, y);
      }
    }

    // corner snapping: median of the two adjacent neighbors
    for (let c = 0; c < 6; c++) {
      const sa = c; // adjacent sides: c and c+1
      const sb = (c + 1) % 6;

      const nAq = tile.q + HEX_DIRS[sa][0], nAr = tile.r + HEX_DIRS[sa][1];
      const nBq = tile.q + HEX_DIRS[sb][0], nBr = tile.r + HEX_DIRS[sb][1];
      const mA = this._getMeshForTile(this._getTile(nAq, nAr));
      const mB = this._getMeshForTile(this._getTile(nBq, nBr));

      for (const i of cls.corners[c]) {
        if (locked[i]) continue; // respect pins if any
        const wx = base.x + pos.getX(i);
        const wz = base.z + pos.getZ(i);

        const a = mA ? rayToMesh(mA, wx, wz) : null;
        const b = mB ? rayToMesh(mB, wx, wz) : null;
        let y = null;

        if (Number.isFinite(a) && Number.isFinite(b)) {
          y = (a + b) * 0.5;
        } else if (Number.isFinite(a)) {
          y = a;
        } else if (Number.isFinite(b)) {
          y = b;
        } else {
          this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
          const hits = this.ray.intersectObjects(this._gatherNeighborMeshes(tile.q, tile.r), true);
          if (hits && hits.length) y = hits[0].point.y;
        }

        if (Number.isFinite(y)) pos.setY(i, y);
      }
    }

    // small, local relaxation just behind the tips with the rim held fixed
    this._relaxCornerInnerBand(tile, cls, 2);

    pos.needsUpdate = true;
    tile.grid.geometry.computeVertexNormals();
  }

  _relaxCornerInnerBand(tile, cls, iters = 1) {
    if (!cls?.innerCornerBand?.size) return;
    const pos = tile.pos;
    const fixed = new Set(cls.rim); // keep the true rim fixed

    const band = Array.from(cls.innerCornerBand);
    for (let k = 0; k < iters; k++) {
      for (const i of band) {
        if (fixed.has(i)) continue;
        // 1 Laplacian step using only band neighbors + rim
        let sum = 0, cnt = 0;
        for (const j of tile.neighbors[i]) {
          if (fixed.has(j) || cls.innerCornerBand.has(j)) {
            const y = pos.getY(j);
            if (Number.isFinite(y)) { sum += y; cnt++; }
          }
        }
        if (cnt >= 2) {
          pos.setY(i, sum / cnt);
        }
      }
    }
  }

  _fixStuckZeros(tile, rimOnly = true) {
    if (!tile) return;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const neighborMeshes = [];
    for (const t of this.tiles.values()) {
      if (t === tile) continue;
      const m = this._getMeshForTile(t);
      if (m) neighborMeshes.push(m);
    }
    if (!neighborMeshes.length) return;

    const locked = tile.locked || new Uint8Array(pos.count);

    let touched = false;
    for (let i = 0; i < pos.count; i++) {
      if (rimOnly && !this._isRimVertex(tile, i)) continue;
      if (locked[i]) continue;
      const curY = pos.getY(i);
      if (Math.abs(curY) > 1e-4) continue;

      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);
      const y = this._robustSampleHeight(wx, wz, null, neighborMeshes, null, curY);
      if (Number.isFinite(y) && Math.abs(y) > 1e-4) {
        pos.setY(i, y);
        touched = true;
      }
    }
    if (touched) {
      pos.needsUpdate = true;
      tile.grid.geometry.computeVertexNormals();
    }
  }

  /* ---------------- fetching & backfill (PHASED) ---------------- */

  _tileNeedsFetch(tile) {
    if (!tile) return false;
    if (!Number.isFinite(tile.unreadyCount)) tile.unreadyCount = tile.pos.count;

    if (tile.type === 'visual' || tile.type === 'farfield') {
      return !(tile._phase?.fullDone) || tile.unreadyCount > 0;
    }
    // interactive: any phase not done OR there are still unknowns
    return !(tile._phase?.seedDone && tile._phase?.edgeDone && tile._phase?.fullDone) || tile.unreadyCount > 0;
  }

  _interactiveTilesPending(exclude = null) {
    for (const tile of this.tiles.values()) {
      if (tile === exclude) continue;
      if (tile.type !== 'interactive') continue;
      if (this._tileNeedsFetch(tile)) return true;
    }
    return false;
  }

  _visualTilesPending(exclude = null) {
    for (const tile of this.tiles.values()) {
      if (tile === exclude) continue;
      if (tile.type !== 'visual') continue;
      if (this._tileNeedsFetch(tile)) return true;
    }
    return false;
  }

  _tryAdvanceFetchPhase(exclude = null) {
    if (this._fetchPhase === 'interactive') {
      if (this._interactiveTilesPending(exclude)) return;
      this._fetchPhase = 'visual';
      this._markRelaxListDirty();
      this._scheduleBackfill(0);
      return;
    }
    if (this._fetchPhase === 'visual') {
      if (this._visualTilesPending(exclude)) return;
      this._fetchPhase = 'farfield';
      this._scheduleBackfill(0);
      return;
    }
  }

  _phaseKey(phase) {
    return phase === PHASE_SEED ? 'seed' : (phase === PHASE_EDGE ? 'edge' : 'full');
  }

  _isPhaseQueued(tile, phase) {
    const key = this._phaseKey(phase);
    if (tile._queuedPhases?.has(key)) return true;
    for (const e of this._populateQueue) {
      if (e.tile === tile && e.phase === phase) return true;
    }
    return false;
  }

  _queuePopulateIfNeeded(tile, priority = false) {
    if (!tile) return;
    if (!this._tileNeedsFetch(tile)) return;
    if (tile.populating) return;
    if (tile.type === 'visual' && this._fetchPhase === 'interactive') return;
    if (tile.type === 'farfield' && this._fetchPhase !== 'farfield') return;

    if (tile.type === 'visual' || tile.type === 'farfield') {
      if (!tile._phase.fullDone) this._queuePopulatePhase(tile, PHASE_FULL, priority);
      return;
    }
    if (!tile._phase.seedDone) this._queuePopulatePhase(tile, PHASE_SEED, priority);
    else if (!tile._phase.edgeDone) this._queuePopulatePhase(tile, PHASE_EDGE, priority);
    else if (!tile._phase.fullDone) this._queuePopulatePhase(tile, PHASE_FULL, priority);
  }

  _queuePopulate(tile, priority = false) {
    this._queuePopulateIfNeeded(tile, priority);
  }

  _queuePopulatePhase(tile, phase, priority = false) {
    if (!tile) return;
    if (this._isPhaseQueued(tile, phase)) return;
    const key = this._phaseKey(phase);
    tile._queuedPhases?.add(key);
    const entry = { tile, phase, priority: !!priority };
    if (priority) this._populateQueue.unshift(entry);
    else this._populateQueue.push(entry);
    this._drainPopulateQueue();
  }

  async _acquireNetBudget(bytes) {
    while (true) {
      const nowT = (performance?.now?.() ?? Date.now());
      if (!this._rateBucketResetAt || nowT - this._rateBucketResetAt >= 1000) {
        this._rateBucketResetAt = nowT;
        this._rateTokensQ = this.RATE_QPS;
        this._rateTokensB = this.RATE_BPS;
      }
      if (this._rateTokensQ > 0 && this._rateTokensB >= bytes) {
        this._rateTokensQ -= 1;
        this._rateTokensB -= Math.max(0, bytes | 0);
        return;
      }
      await new Promise(r => setTimeout(r, 8));
    }
  }

  _drainPopulateQueue() {
    while (this._populateInflight < this.MAX_CONCURRENT_POPULATES && this._populateQueue.length) {
      const next = this._populateQueue.shift();
      if (!next) break;

      const { tile, phase } = next;
      if (!tile) continue;

      if (tile.type === 'visual' && this._fetchPhase === 'interactive') {
        const k = this._phaseKey(phase);
        tile._queuedPhases?.delete(k);
        tile.populating = false;
        continue;
      }
      if (tile.type === 'farfield' && this._fetchPhase !== 'farfield') {
        const k = this._phaseKey(phase);
        tile._queuedPhases?.delete(k);
        tile.populating = false;
        continue;
      }

      if (tile.populating) {
        this._populateQueue.push(next);
        break;
      }

      this._populateInflight++;
      tile.populating = true;

      this._populateTilePhase(tile, phase)
        .catch(() => { /* ignore; backfill will retry */ })
        .finally(() => {
          const k = this._phaseKey(phase);
          tile._queuedPhases?.delete(k);
          tile.populating = false;
          this._populateInflight = Math.max(0, this._populateInflight - 1);
          this._drainPopulateQueue();
        });
    }
  }

  async _populateTilePhase(tile, phase) {
    if (!tile || !this.origin) { if (tile) tile.populating = false; return; }
    if (!this.relayAddress) { tile.populating = false; return; }

    if (tile.type === 'farfield') {
      await this._populateFarfieldBatch(tile);
      return;
    }

    const pos = tile.pos;
    const count = pos.count;
    if (!Number.isFinite(count) || count === 0) { tile.populating = false; return; }

    // ---- choose indices for this phase ----
    let indices = null;
    if (tile.type === 'visual') {
      // visuals fetch the full 7 verts
      indices = Array.from({ length: count }, (_, i) => i);
    } else {
      if (phase === PHASE_SEED) {
        const center = this._selectCenterIndex(tile);
        const tips = this._selectCornerTipIndices(tile);
        indices = Array.from(new Set([center, ...tips]));
      } else if (phase === PHASE_EDGE) {
        indices = this._selectEdgeMidpointIndices(tile);
      } else {
        // PHASE_FULL: fetch remaining unknowns only
        indices = [];
        for (let i = 0; i < count; i++) if (!tile.ready[i]) indices.push(i);
        if (indices.length === 0) {
          // nothing left; mark done & finish phase chain
          if (tile.type === 'interactive') {
            tile._phase.fullDone = true;
            if (tile.locked) tile.locked.fill(0);
            this._saveTileToCache(tile);
          } else {
            tile._phase.fullDone = true;
            this._saveTileToCache(tile);
          }
          return;
        }
      }
    }

    // If truly nothing to do in this phase, mark + chain forward immediately
    if (!indices || indices.length === 0) {
      if (tile.type === 'interactive') {
        if (phase === PHASE_SEED) {
          tile._phase.seedDone = true;
          this._queuePopulatePhase(tile, PHASE_EDGE);
        } else if (phase === PHASE_EDGE) {
          tile._phase.edgeDone = true;
          this._queuePopulatePhase(tile, PHASE_FULL);
        } else {
          tile._phase.fullDone = true;
          if (tile.locked) tile.locked.fill(0);
          this._saveTileToCache(tile);
        }
      } else {
        tile._phase.fullDone = true;
        this._saveTileToCache(tile);
      }
      return;
    }

    // ---- build batches & fire queries (with net budget gating) ----
    const latLon = this._collectTileLatLon(tile);
    const mode = this.relayMode;
    const precision = pickGeohashPrecision(this.spacing);
    const geohashes = mode === 'geohash'
      ? latLon.map(({ lat, lng }) => geohashEncode(lat, lng, precision))
      : null;

    const indexByLatLon = new Map();
    if (mode === 'latlng') {
      for (let i = 0; i < latLon.length; i++) {
        const { lat, lng } = latLon[i];
        indexByLatLon.set(`${lat.toFixed(6)},${lng.toFixed(6)}`, i);
      }
    }
    const indexByGeohash = geohashes ? new Map(geohashes.map((gh, i) => [gh, i])) : null;

    const batches = (mode === 'geohash')
      ? this._indicesToBatchesGeohash(indices, geohashes, precision)
      : this._indicesToBatchesLatLng(indices, latLon);

    const queries = batches.map((batch) => {
      const payload = { type: 'elev.query', dataset: this.relayDataset };
      if (mode === 'geohash') {
        payload.geohashes = batch.items;
        payload.enc = 'geohash';
        payload.prec = precision;
      } else {
        payload.locations = batch.items;
      }

      const approxBytes = batch.bytes ?? JSON.stringify(payload).length;

      return this._acquireNetBudget(approxBytes).then(() =>
        this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs)
          .then((json) => {
            const results = json?.results || [];
            if (results.length) {
              this._applyRelayResults(tile, results, { mode, indexByLatLon, indexByGeohash });
            }
          })
          .catch(() => { /* swallow; backfill/next phases will retry */ })
      );
    });

    await Promise.allSettled(queries);

    let skipBlend = false;
    if (tile.type === 'interactive') {
      if (phase === PHASE_SEED) {
        this._pinEdgesFromCorners(tile);
        skipBlend = this._projectInteractiveSeed(tile);
      } else if (phase === PHASE_EDGE) {
        this._pinEdgesFromCorners(tile);
      }
    }

    if (skipBlend) {
      pos.needsUpdate = true;
      tile.grid.geometry.computeVertexNormals();
      this._applyAllColorsGlobal(tile);
    } else {
      // ---- blend / seal with pinned edges acting as anchors ----
      this._nearestAnchorFill(tile);
      this._smoothUnknowns(tile, 1);
      this._sealEdgesCornerSafe(tile);
      this._fixStuckZeros(tile, /*rimOnly=*/true);

      pos.needsUpdate = true;
      tile.grid.geometry.computeVertexNormals();
      this._applyAllColorsGlobal(tile);
    }

    // ---- mark phase complete & chain next ----
    if (tile.type === 'interactive') {
      if (phase === PHASE_SEED) {
        tile._phase.seedDone = true;
        this._queuePopulatePhase(tile, PHASE_EDGE);
      } else if (phase === PHASE_EDGE) {
        tile._phase.edgeDone = true;
        this._queuePopulatePhase(tile, PHASE_FULL);
      } else {
        tile._phase.fullDone = true;
        // release pins after full pass; remaining locks will be overwritten as samples land
        if (tile.locked) tile.locked.fill(0);
        this._saveTileToCache(tile);
      }
    } else {
      tile._phase.fullDone = true;
      this._saveTileToCache(tile);
    }
    if (!this._tileNeedsFetch(tile)) this._tryAdvanceFetchPhase(tile);
  }

  _gatherFarfieldBatch(primary) {
    const target = Math.max(1, Math.floor(this.FARFIELD_BATCH_SIZE) || 1);
    const batch = [];
    const include = (tile) => {
      if (!tile) return false;
      if (batch.includes(tile)) return false;
      if (!this._tileNeedsFetch(tile)) return false;
      if (tile.populating) return false;
      tile.populating = true;
      tile._queuedPhases?.delete?.('full');
      batch.push(tile);
      return true;
    };

    include(primary);

    if (batch.length < target) {
      for (const entry of this._populateQueue) {
        if (batch.length >= target) break;
        const tile = entry.tile;
        if (!tile || tile.type !== 'farfield') continue;
        include(tile);
      }
    }

    if (batch.length < target) {
      for (const tile of this.tiles.values()) {
        if (batch.length >= target) break;
        if (tile === primary) continue;
        if (tile.type !== 'farfield') continue;
        include(tile);
      }
    }

    if (batch.length > 1) {
      const set = new Set(batch);
      this._populateQueue = this._populateQueue.filter(entry => !set.has(entry.tile));
    }

    return batch;
  }

  async _populateFarfieldBatch(primary) {
    const tiles = this._gatherFarfieldBatch(primary);
    if (!tiles.length) { if (primary) primary.populating = false; return; }

    const latLonAll = [];
    const refs = [];
    for (const tile of tiles) {
      const latLon = this._collectTileLatLon(tile);
      const ready = tile.ready;
      for (let i = 0; i < latLon.length; i++) {
        if (ready && ready[i]) continue;
        latLonAll.push(latLon[i]);
        refs.push({ tile, index: i });
      }
    }

    if (!latLonAll.length) {
      for (const tile of tiles) {
        tile.populating = false;
        tile._phase.fullDone = true;
        this._saveTileToCache(tile);
        this._tryAdvanceFetchPhase(tile);
      }
      return;
    }

    const mode = this.relayMode;
    const precision = pickGeohashPrecision(this.spacing);
    const indices = latLonAll.map((_, i) => i);
    const geohashes = mode === 'geohash'
      ? latLonAll.map(({ lat, lng }) => geohashEncode(lat, lng, precision))
      : null;

    const batches = (mode === 'geohash')
      ? this._indicesToBatchesGeohash(indices, geohashes, precision)
      : this._indicesToBatchesLatLng(indices, latLonAll);

    const geohashMap = geohashes ? new Map() : null;
    if (geohashMap) {
      geohashes.forEach((gh, i) => {
        if (!geohashMap.has(gh)) geohashMap.set(gh, []);
        geohashMap.get(gh).push(i);
      });
    }
    const latLngMap = geohashes ? null : new Map();
    if (latLngMap) {
      latLonAll.forEach(({ lat, lng }, i) => {
        const key = `${lat.toFixed(6)},${lng.toFixed(6)}`;
        if (!latLngMap.has(key)) latLngMap.set(key, []);
        latLngMap.get(key).push(i);
      });
    }

    const applyIdx = (idx, height) => {
      if (idx == null) return;
      const ref = refs[idx];
      if (!ref || !Number.isFinite(height)) return;
      this._applySample(ref.tile, ref.index, height);
    };

    const requests = batches.map((batch) => {
      const payload = { type: 'elev.query', dataset: this.relayDataset };
      if (mode === 'geohash') {
        payload.geohashes = batch.items;
        payload.enc = 'geohash';
        payload.prec = precision;
      } else {
        payload.locations = batch.items;
      }

      const approxBytes = batch.bytes ?? JSON.stringify(payload).length;
      return this._acquireNetBudget(approxBytes).then(() =>
        this.terrainRelay.queryBatch(this.relayAddress, payload, this.relayTimeoutMs)
          .then((json) => {
            const results = json?.results || [];
            for (const res of results) {
              let idx = null;
              if (mode === 'geohash') {
                const key = res.geohash || res.hash;
                const list = key ? geohashMap?.get(key) : null;
                if (list && list.length) idx = list.shift();
              } else if (res.location) {
                const { lat, lng } = res.location;
                const key = `${(+lat).toFixed(6)},${(+lng).toFixed(6)}`;
                const list = latLngMap?.get(key);
                if (list && list.length) idx = list.shift();
              }
              if (idx == null) continue;
              const height = Number(res.elevation);
              if (!Number.isFinite(height)) continue;
              applyIdx(idx, height);
            }
          })
          .catch(() => { /* ignore errors; will retry via backfill */ })
      );
    });

    await Promise.allSettled(requests);

    for (const tile of tiles) {
      tile.populating = false;
      tile._phase.fullDone = true;
      if (!this._tileNeedsFetch(tile)) {
        this._saveTileToCache(tile);
      } else {
        this._queuePopulate(tile, false);
      }
      this._tryAdvanceFetchPhase(tile);
    }
  }


  /* ---------------- backfill orchestration ---------------- */

  _scheduleBackfill(delayMs = 0) {
    if (this._backfillTimer) clearTimeout(this._backfillTimer);
    this._backfillTimer = setTimeout(() => {
      this._backfillMissing({ onlyIfRelayReady: false });
    }, Math.max(0, delayMs));
  }

  _backfillMissing({ onlyIfRelayReady = false } = {}) {
    if (!this.origin) return;

    if (onlyIfRelayReady && !(this._relayStatus?.text === 'connected' || this._relayStatus?.level === 'ok')) return;

    const phase = this._fetchPhase;
    const entries = [...this.tiles.values()]
      .filter(t => this._tileNeedsFetch(t) && !t.populating && !this._isPhaseQueued(t, PHASE_SEED) && !this._isPhaseQueued(t, PHASE_EDGE) && !this._isPhaseQueued(t, PHASE_FULL))
      .map(t => {
        let priority = 2;
        if (phase === 'interactive') {
          if (t.type === 'interactive') priority = 0;
          else if (t.type === 'visual') priority = 1;
          else priority = 2;
        } else if (phase === 'visual') {
          if (t.type === 'interactive') priority = 0;
          else if (t.type === 'visual') priority = 1;
          else priority = 2;
        } else { // farfield phase
          if (t.type === 'interactive') priority = 0;
          else if (t.type === 'visual') priority = 1;
          else priority = 2;
        }
        return { t, priority, d: this._hexDist(t.q, t.r, 0, 0) };
      })
      .sort((a, b) => (a.priority - b.priority) || (a.d - b.d));

    for (const { t } of entries) {
      const p = (t.type === 'interactive') || (t.q === 0 && t.r === 0);
      this._queuePopulateIfNeeded(t, p);
    }
  }

  _prewarmVisualRing(q0 = 0, r0 = 0) {
    for (let dq = -this.VISUAL_RING; dq <= this.VISUAL_RING; dq++) {
      const rMin = Math.max(-this.VISUAL_RING, -dq - this.VISUAL_RING);
      const rMax = Math.min(this.VISUAL_RING, -dq + this.VISUAL_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.INTERACTIVE_RING) continue;
        if (!this.tiles.has(`${q},${r}`)) {
          this._addVisualTile(q, r);
        } else {
          const t = this.tiles.get(`${q},${r}`);
          this._queuePopulateIfNeeded(t, false);
        }
      }
    }
    this._scheduleBackfill(0);
  }

  _prewarmFarfieldRing(q0 = 0, r0 = 0) {
    for (let dq = -this.FARFIELD_RING; dq <= this.FARFIELD_RING; dq++) {
      const rMin = Math.max(-this.FARFIELD_RING, -dq - this.FARFIELD_RING);
      const rMax = Math.min(this.FARFIELD_RING, -dq + this.FARFIELD_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.VISUAL_RING) continue;
        const id = `${q},${r}`;
        if (!this.tiles.has(id)) {
          this._addFarfieldTile(q, r);
        } else {
          const t = this.tiles.get(id);
          this._queuePopulateIfNeeded(t, false);
        }
      }
    }
    this._scheduleBackfill(0);
  }

  /* ---------------- per-frame: ensure LOD, relax, prune ---------------- */

  update(playerPos) {
    if (!this.origin) return;
    const startMs = performance?.now ? performance.now() : Date.now();

    const a = this.tileRadius;
    const qf = (2 / 3 * playerPos.x) / a;
    const rf = ((-1 / 3 * playerPos.x) + (Math.sqrt(3) / 3 * playerPos.z)) / a;
    const q0 = Math.round(qf), r0 = Math.round(rf);

    // 1) interactive ring
    for (let dq = -this.INTERACTIVE_RING; dq <= this.INTERACTIVE_RING; dq++) {
      const rMin = Math.max(-this.INTERACTIVE_RING, -dq - this.INTERACTIVE_RING);
      const rMax = Math.min(this.INTERACTIVE_RING, -dq + this.INTERACTIVE_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        const q = q0 + dq, r = r0 + dr;
        const id = `${q},${r}`;
        const cur = this.tiles.get(id);
        if (!cur) {
          this._addInteractiveTile(q, r);
        } else if (cur.type === 'visual') {
          this._promoteVisualToInteractive(q, r);
        } else if (cur.type === 'farfield') {
          this._discardTile(id);
          this._addInteractiveTile(q, r);
        }
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
        const id = `${q},${r}`;
        const existing = this.tiles.get(id);
        if (!existing) {
          this._addVisualTile(q, r);
          if (++created >= this.VISUAL_CREATE_BUDGET) break outer;
        } else {
          if (existing.type === 'farfield') {
            this._discardTile(id);
            this._addVisualTile(q, r);
          } else if (dist <= this.INTERACTIVE_RING && existing.type === 'visual') {
            this._promoteVisualToInteractive(q, r);
          } else if (existing) {
            this._queuePopulateIfNeeded(existing, false);
          }
        }
      }
    }

    // 3) farfield outward with budget
    let farCreated = 0;
    farOuter:
    for (let dq = -this.FARFIELD_RING; dq <= this.FARFIELD_RING; dq++) {
      const rMin = Math.max(-this.FARFIELD_RING, -dq - this.FARFIELD_RING);
      const rMax = Math.min(this.FARFIELD_RING, -dq + this.FARFIELD_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.VISUAL_RING) continue;
        const id = `${q},${r}`;
        const existing = this.tiles.get(id);
        if (!existing) {
          this._addFarfieldTile(q, r);
          if (++farCreated >= this.FARFIELD_CREATE_BUDGET) break farOuter;
        } else if (existing.type !== 'farfield') {
          this._discardTile(id);
          this._addFarfieldTile(q, r);
        } else {
          this._queuePopulateIfNeeded(existing, false);
        }
      }
    }

    // 4) prune/downgrade rings
    const toRemove = [];
    const toFarfield = [];
    for (const [id, t] of this.tiles) {
      const dist = this._hexDist(t.q, t.r, q0, r0);
      if (dist > this.FARFIELD_RING) {
        toRemove.push(id);
        continue;
      }
      if (dist > this.VISUAL_RING) {
        if (t.type !== 'farfield') toFarfield.push({ q: t.q, r: t.r });
        continue;
      }
    }

    for (const id of toRemove) this._discardTile(id);
    for (const { q, r } of toFarfield) {
      const id = `${q},${r}`;
      this._discardTile(id);
      this._addFarfieldTile(q, r);
    }

    // 5) relax
    this._ensureRelaxList();
    this._drainRelaxQueue();

    // 6) recolor sweep when global range changes
    if (this._globalDirty) {
      const t = now();
      if (t - this._lastRecolorAt > 100) {
        for (const tile of this.tiles.values()) this._applyAllColorsGlobal(tile);
        this._globalDirty = false;
        this._lastRecolorAt = t;
      }
    }

    const dt = (performance?.now ? performance.now() : Date.now()) - startMs;
    const nowMs = performance?.now ? performance.now() : Date.now();
    if ((!this._perfUpdateNext || nowMs >= this._perfUpdateNext) && dt > 5) {
      console.log(`[tiles.update] tiles=${this.tiles.size} duration=${dt.toFixed(2)}ms`);
      this._perfUpdateNext = nowMs + 2000;
    }
  }

  _ensureType(q, r, want) {
    const id = `${q},${r}`;
    const cur = this.tiles.get(id);
    if (!cur) {
      if (want === 'interactive') return this._addInteractiveTile(q, r);
      if (want === 'visual') return this._addVisualTile(q, r);
      if (want === 'farfield') return this._addFarfieldTile(q, r);
      return null;
    }
    if (cur.type === want) return cur;
    if (want === 'interactive') {
      if (cur.type === 'visual') return this._promoteVisualToInteractive(q, r);
      this._discardTile(id);
      return this._addInteractiveTile(q, r);
    }
    this._discardTile(id);
    if (want === 'visual') return this._addVisualTile(q, r);
    if (want === 'farfield') return this._addFarfieldTile(q, r);
    return null;
  }

  /* ---------------- Origin & relay hooks ---------------- */

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
      this._prewarmVisualRing(0, 0);
      this._prewarmFarfieldRing(0, 0);
    } else if (immediate && !this.tiles.size) {
      this._ensureType(0, 0, 'interactive');
      this._prewarmVisualRing(0, 0);
      this._prewarmFarfieldRing(0, 0);
    }

    if (immediate && this.origin) {
      if (!this._originVec) this._originVec = new THREE.Vector3();
      this._originVec.set(0, 0, 0);
      this.update(this._originVec);
    }

    this._scheduleBackfill(50);
  }

  _onRelayStatus(text, level) {
    this._relayStatus = { text, level };
    const isConnected = (text === 'connected' || level === 'ok');
    if (isConnected) {
      this.MAX_CONCURRENT_POPULATES = 12;
      this.RATE_QPS = 12; this.RATE_BPS = 256 * 1024;
    } else {
      this.MAX_CONCURRENT_POPULATES = 6;
      this.RATE_QPS = 6; this.RATE_BPS = 128 * 1024;
    }
    if (isConnected && !this._relayWasConnected) {
      this._relayWasConnected = true;
      this._scheduleBackfill(0);
    }
  }

  /* ---------------- LOD / perf ---------------- */

  _markRelaxListDirty() { this._relaxKeysDirty = true; }

  _ensureRelaxList() {
    if (!this._relaxKeysDirty) return;
    this._relaxKeys = [];
    for (const [id, tile] of this.tiles.entries()) {
      if (tile.type === 'interactive' && tile.relaxEnabled === true) this._relaxKeys.push(id);
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
    const quality = THREE.MathUtils.clamp(qualityRaw, 0.3, 1.2);
    this._lodQuality = quality;

    const baseInteractive = this._baseLod.interactiveRing;
    const baseVisual = this._baseLod.visualRing;
    const baseFarfield = this._baseLod.farfieldRing;
    const baseFarfieldBatch = this._baseLod.farfieldBatchSize || this.FARFIELD_BATCH_SIZE;
    const farfieldExtra = Number.isFinite(this._baseLod.farfieldExtra)
      ? this._baseLod.farfieldExtra
      : Math.max(1, baseFarfield - baseVisual);

    let ringChanged = false;
    if (this.INTERACTIVE_RING !== baseInteractive) { this.INTERACTIVE_RING = baseInteractive; ringChanged = true; }
    if (this.VISUAL_RING !== baseVisual) { this.VISUAL_RING = baseVisual; ringChanged = true; }
    const targetFarfieldRing = this.VISUAL_RING + farfieldExtra;
    if (this.FARFIELD_RING !== targetFarfieldRing) {
      this.FARFIELD_RING = targetFarfieldRing;
      this.FARFIELD_EXTRA = farfieldExtra;
      ringChanged = true;
    }
    if (ringChanged) {
      this._markRelaxListDirty();
      this._prewarmVisualRing(0, 0);
      this._prewarmFarfieldRing(0, 0);
      this._scheduleBackfill(0);
    }

    this.VISUAL_CREATE_BUDGET = Number.MAX_SAFE_INTEGER;
    this.FARFIELD_CREATE_BUDGET = this._baseLod.farfieldCreateBudget;
    this.FARFIELD_BATCH_SIZE = Math.max(1, Math.round(baseFarfieldBatch));

    this.RELAX_ITERS_PER_FRAME = Math.max(1, Math.round(quality * this._baseLod.relaxIters));
    this.RELAX_FRAME_BUDGET_MS = 1.5 + quality * 1.5;

    for (const tile of this.tiles.values()) {
      if (!tile?.wire?.material?.userData) continue;
      const dist = this._hexDist(tile.q, tile.r, 0, 0);
      let fade = tile.wire.material.userData.uFade;
      if (tile.type === 'interactive') fade = this._interactiveWireFade(dist);
      else if (tile.type === 'visual') fade = this._visualWireFade(dist);
      tile.wire.material.userData.uFade = fade;
    }

    return {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      visualCreateBudget: this.VISUAL_CREATE_BUDGET,
      farfieldRing: this.FARFIELD_RING,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      relaxIters: this.RELAX_ITERS_PER_FRAME,
      relaxBudget: Number(this.RELAX_FRAME_BUDGET_MS.toFixed(2)),
    };
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  /* ---------------- Queries & controls ---------------- */

  getHeightAt(x, z) {
    const t0 = performance?.now ? performance.now() : Date.now();
    const tmp = new THREE.Vector3(x, 10000, z);
    const meshes = [];
    for (const t of this.tiles.values()) if (t.type === 'interactive') meshes.push(t.grid.mesh);
    if (meshes.length === 0) return this._lastHeight;
    this.ray.set(tmp, this.DOWN);
    const hit = this.ray.intersectObjects(meshes, true);
    let result = this._lastHeight;
    if (hit.length) {
      result = hit[0].point.y;
      this._lastHeight = result;
    }
    const dt = (performance?.now ? performance.now() : Date.now()) - t0;
    const now = performance?.now ? performance.now() : Date.now();
    if ((!this._perfLogNext || now >= this._perfLogNext) && dt > 2) {
      console.log(`[tiles.getHeightAt] meshes=${meshes.length} hit=${hit.length > 0} duration=${dt.toFixed(2)}ms`);
      this._perfLogNext = now + 2000;
    }
    return result;
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
    this.terrainRelay?.setRelayAddress(this.relayAddress);
    this._scheduleBackfill(0);
  }

  setRelayDataset(dataset) {
    this.relayDataset = (dataset || '').trim() || DEFAULT_TERRAIN_DATASET;
    this.terrainRelay?.setDataset(this.relayDataset);
    this._scheduleBackfill(0);
  }

  setRelayMode(mode) {
    this.relayMode = mode === 'latlng' ? 'latlng' : 'geohash';
    this.terrainRelay?.setMode(this.relayMode);
    this._scheduleBackfill(0);
  }

  getRelayStatus() { return this._relayStatus; }

  refreshTiles() {
    for (const tile of this.tiles.values()) {
      tile.ready.fill(0);
      tile.fetched.clear();
      tile.unreadyCount = tile.pos.count;
      if (tile.type === 'farfield') this._initFarfieldColors(tile);
      else this._initColorsNearBlack(tile);
      tile.populating = false;
      tile._queuedPhases?.clear?.();

      if (!tile._phase) tile._phase = {};
      if (tile.type === 'interactive') tile._phase = { seedDone: false, edgeDone: false, fullDone: false };
      else tile._phase = { fullDone: false };

      if (!tile.locked || tile.locked.length !== tile.pos.count) tile.locked = new Uint8Array(tile.pos.count);
      else tile.locked.fill(0);
      if (tile.type === 'interactive') tile.relaxEnabled = false;

      if (tile.wire?.material?.userData) {
        const dist = this._hexDist(tile.q, tile.r, 0, 0);
        const fade = tile.type === 'interactive'
          ? this._interactiveWireFade(dist)
          : (tile.type === 'visual' ? this._visualWireFade(dist) : tile.wire.material.userData.uFade);
        tile.wire.material.userData.uFade = fade;
      }

      this._queuePopulate(tile, tile.type === 'interactive');
    }
    this._fetchPhase = 'interactive';
    this._markRelaxListDirty();
    this._scheduleBackfill(0);
  }

  /* ---------------- Cleanup ---------------- */

  _discardTile(id) {
    const t = this.tiles.get(id);
    if (!t) return;
    this.scene.remove(t.grid.group);
    try {
      t.grid.geometry?.dispose?.();
      t.grid.mat?.dispose?.();
      t.wire?.material?.dispose?.();
    } catch { }
    this.tiles.delete(id);
    this._markRelaxListDirty();
  }

  _resetAllTiles() {
    for (const id of Array.from(this.tiles.keys())) this._discardTile(id);
    this.tiles.clear();
    this._populateQueue.length = 0;
    this._populateBusy = false;
    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._globalDirty = true;
    this._lastRecolorAt = 0;
    this._relaxKeys = [];
    this._relaxCursor = 0;
    this._relaxKeysDirty = true;
    this._lastHeight = 0;
    this._fetchPhase = 'interactive';
  }

  dispose() {
    if (this._backfillTimer) { clearTimeout(this._backfillTimer); this._backfillTimer = null; }
    if (this._periodicBackfill) { clearInterval(this._periodicBackfill); this._periodicBackfill = null; }
    if (this._rateTicker) { clearInterval(this._rateTicker); this._rateTicker = null; }
    this._resetAllTiles();
    this.tiles.clear();
  }
}
