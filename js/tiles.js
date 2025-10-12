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
const MAX_LOCATIONS_PER_BATCH = 1000;
const PIN_SIDE_INNER_RATIO = 0.501; // 0.94 ≈ outer 6% of the tile; try 0.92 for thicker band
const FARFIELD_ADAPTER_INNER_RATIO = 0.985;

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
  constructor(scene, spacing = 20, tileRadius = 100, audio = null) {
    this.scene = scene; this.spacing = spacing; this.tileRadius = tileRadius;
    this.audio = audio;   // spatial audio engine
    this.tiles = new Map(); this.origin = null;
    this._perfLogNext = 0;
    this._perfUpdateNext = 0;
    this._nextFarfieldLog = 0;
    this._deferredInteractive = new Set();
    this._interactiveSecondPass = false;

    // ---- LOD configuration ----
    this.INTERACTIVE_RING = 2;
    this.VISUAL_RING = 4;
    this.FARFIELD_EXTRA = 20;
    this.FARFIELD_RING = this.VISUAL_RING + this.FARFIELD_EXTRA;
    // turbo: do not throttle per-frame visual tile creation
    this.VISUAL_CREATE_BUDGET = 60;
    this.FARFIELD_CREATE_BUDGET = 60;
    this.FARFIELD_BATCH_SIZE = 60;
    this.FARFIELD_NEAR_PAD = 6;

    // ---- interactive (high-res) relaxation ----
    this.RELAX_ITERS_PER_FRAME = 20;
    this.RELAX_ALPHA = 0.2;
    this.NORMALS_EVERY = 10;
    // keep relax cheap so fetching dominates
    this.RELAX_FRAME_BUDGET_MS = 1;

    // ---- GLOBAL grayscale controls (altitude => luminance) ----
    this.LUM_MIN = 0.05;
    this.LUM_MAX = 0.90;
    this.GLOBAL_MIN_Y = +Infinity;
    this.GLOBAL_MAX_Y = -Infinity;
    this._globalDirty = false;
    this._lastRecolorAt = 0;

    // ---- wireframe colors ----
    this.VISUAL_WIREFRAME_COLOR = 0x222222;
    this.INTERACTIVE_WIREFRAME_COLOR = 0x222222;

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
    this._defaultTerrainSettings = {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      tileRadius: this.tileRadius,
      spacing: this.spacing,
    };
    this._lodQuality = 1;

    // ---- Relay wiring ----
    this.relayMode = 'geohash';
    this.relayAddress = DEFAULT_TERRAIN_RELAY;
    this.relayDataset = DEFAULT_TERRAIN_DATASET;
    this.relayTimeoutMs = 45000;
    this._relayStatus = {
      text: 'idle',
      level: 'info',
      connected: false,
      metrics: null,
      heartbeat: null,
      address: this.relayAddress,
    };
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

    this._heightCache = new Map();
    this._heightCacheTTL = 250;
    this._heightCacheScale = 2;
    this._heightMeshesFallback = [];
    this._heightListeners = new Set();
    this._farfieldAdapterDirty = new Set();
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
      opacity: 0,
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
// Smoothly force interactive edges to match straight visual edges,
// with a short radial blend band so there are no gaps or hard kinks.
_stitchInteractiveToVisualEdges(tile, {
  bandRatio = 0.07,              // ~7% of radius inward is blended
  sideArc   = Math.PI / 10       // angular width considered "this side"
} = {}) {
  if (!tile || tile.type !== 'interactive') return;

  const pos   = tile.pos;
  const aR    = this.tileRadius;
  const base  = tile.grid.group.position;
  const tips  = this._selectCornerTipIndices(tile);
  if (!tips || tips.length < 6) return;

  // angular centers for the 6 sides (halfway between corners)
  const sideAng = Array.from({ length: 6 }, (_, i) => (i + 0.5) * (Math.PI / 3));
  const RIM_STRICT   = aR * 0.985;                // true outer rim, matches _isRimVertex/_pinEdgesFromCorners
  const BAND_INNER   = aR * (1 - Math.max(0.02, Math.min(0.2, bandRatio))); // inner edge of blend band

  // utility
  const rayToMesh = (mesh, x, z) => {
    if (!mesh) return null;
    this.ray.set(new THREE.Vector3(x, 1e6, z), this.DOWN);
    const hit = this.ray.intersectObject(mesh, true);
    return (hit && hit.length) ? hit[0].point.y : null;
  };

  const newLocks = new Set();
  let visualNeighborFound = false;

  // For each of the 6 sides, if neighbor is visual/farfield, collate a side band and blend to a straight line.
  for (let s = 0; s < 6; s++) {
    // neighbor across side s
    const nq = tile.q + HEX_DIRS[s][0];
    const nr = tile.r + HEX_DIRS[s][1];
    const nTile = this._getTile(nq, nr);
    if (!nTile || (nTile.type === 'interactive')) continue; // only stitch to visual/farfield
    visualNeighborFound = true;

    const nMesh = this._getMeshForTile(nTile);

    // the two corner tips that bound side s
    const iA = tips[s];
    const iB = tips[(s + 1) % 6];
    if (iA == null || iB == null) continue;

    // world positions of those corner tips
    const Ax = base.x + pos.getX(iA), Az = base.z + pos.getZ(iA);
    const Bx = base.x + pos.getX(iB), Bz = base.z + pos.getZ(iB);

    // heights from the neighbor *visual* (authoritative for the shared edge).
    // fallback to our own if sampling fails
    let Ay = rayToMesh(nMesh, Ax, Az);
    let By = rayToMesh(nMesh, Bx, Bz);
    if (!Number.isFinite(Ay)) Ay = pos.getY(iA);
    if (!Number.isFinite(By)) By = pos.getY(iB);

    // AB for projecting t along the edge segment
    const ABx = (Bx - Ax), ABz = (Bz - Az);
    const denom = ABx * ABx + ABz * ABz;
    if (denom < 1e-8) continue;

    // pass 1: compute and apply to the *rim* (exact line), and collect band vertices to feather
    const bandIdx = [];
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r = Math.hypot(x, z);
      if (r < BAND_INNER) continue; // only edge band
      // Is this vertex aligned with side s by angle?
      const a = this._angleOf(x, z);
      const d = this._angDiff(a, sideAng[s]);
      if (d > sideArc) continue;

      const wx = base.x + x, wz = base.z + z;
      // param t along AB (0 at A, 1 at B)
      let t = ((wx - Ax) * ABx + (wz - Az) * ABz) / denom;
      if (!Number.isFinite(t)) t = 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;

      // straight-line height at this edge point
      const yLine = Ay + t * (By - Ay);

      if (r >= RIM_STRICT) {
        // true rim: snap exactly to straight line and keep it pinned
        pos.setY(i, yLine);
        if (tile.locked) tile.locked[i] = 1; // prevent relax from curving it later
        newLocks.add(i);
      } else {
        // inside the rim: we'll feather in pass 2
        bandIdx.push({ i, r, yLine });
      }
    }

    // pass 2: feather the inner band (smoothly blend original -> line as we approach the rim)
    if (bandIdx.length) {
      const span = Math.max(1e-4, aR - BAND_INNER);
      for (const { i, r, yLine } of bandIdx) {
        const y0 = pos.getY(i);
        // radial weight: 0 at BAND_INNER, 1 at rim; smoothstep to avoid flat spots
        let w = (r - BAND_INNER) / span;
        if (w < 0) w = 0; else if (w > 1) w = 1;
        w = w * w * (3 - 2 * w); // smoothstep
        const y = y0 + (yLine - y0) * w;
        pos.setY(i, y);
        if (tile.locked) tile.locked[i] = 1;
        newLocks.add(i);
      }
    }
  }

  pos.needsUpdate = true;
  try {
    tile.grid.geometry.computeVertexNormals();
  } catch {}
  // keep CPU buffers in sync for relax/coloring:
  this._pullGeometryToBuffers(tile);
  this._applyAllColorsGlobal(tile);

  if (!tile._visualEdgeLocks) tile._visualEdgeLocks = new Set();
  if (!visualNeighborFound) {
    for (const idx of tile._visualEdgeLocks) {
      if (tile.locked) tile.locked[idx] = 0;
    }
    tile._visualEdgeLocks.clear();
    return;
  }

  for (const idx of tile._visualEdgeLocks) {
    if (!newLocks.has(idx) && tile.locked) tile.locked[idx] = 0;
  }
  tile._visualEdgeLocks = newLocks;
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
  _getTerrainMaterial() {
    if (!this._terrainMat) {
      this._terrainMat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.BackSide,
        metalness: 0.05,
        roughness: 0.75,
      });
    }
    return this._terrainMat;
  }
  addHeightListener(fn) {
    if (typeof fn !== 'function') return () => {};
    this._heightListeners.add(fn);
    return () => this._heightListeners.delete(fn);
  }
  removeHeightListener(fn) {
    if (!fn) return;
    this._heightListeners.delete(fn);
  }
  _notifyHeightListeners(tile, idx, wx, wy, wz) {
    if (!this._heightListeners || !this._heightListeners.size) return;
    const payload = {
      tile,
      index: idx,
      world: { x: wx, y: wy, z: wz },
      type: tile?.type || null,
    };
    for (const listener of this._heightListeners) {
      try { listener(payload); } catch { /* ignore listener error */ }
    }
  }
  _getFarfieldMaterial() {
    if (!this._farfieldMat) {
      this._farfieldMat = this._getTerrainMaterial().clone();
      this._farfieldMat.polygonOffset = true;
      this._farfieldMat.polygonOffsetFactor = 1;
      this._farfieldMat.polygonOffsetUnits = 2;
      this._farfieldMat.name = 'TileFarfieldMaterial';
    }
    return this._farfieldMat;
  }
  _applyTerrainMaterial(mesh) {
    if (!mesh) return;
    const mat = this._getTerrainMaterial();
    try { mesh.material?.dispose?.(); } catch { }
    mesh.material = mat;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
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

  _farfieldTierForDist(dist) {
    const nearPad = Math.max(2, Number.isFinite(this.FARFIELD_NEAR_PAD) ? this.FARFIELD_NEAR_PAD : 6);
    if (dist <= this.VISUAL_RING + nearPad) return { stride: 1, scale: 1, samples: 'all', minPrec: 6 };
    if (dist <= this.VISUAL_RING + 24) return { stride: 2, scale: 2, samples: 'tips', minPrec: 5 };
    if (dist <= this.VISUAL_RING + 128) return { stride: 6, scale: 4, samples: 'tips', minPrec: 4 };
    if (dist <= this.VISUAL_RING + 384) return { stride: 12, scale: 8, samples: 'tips', minPrec: 3 };
    return { stride: 24, scale: 12, samples: 'center', minPrec: 3 }; // keep corners so seams match
  }
  _sealFarfieldCornersAgainstNeighbors(tile) {
    if (!tile || tile.type !== 'farfield') return;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const neighborMeshes = this._gatherNeighborMeshes(tile.q, tile.r); // includes visual/interactive nearby

    if (!neighborMeshes.length) return;

    // corners are indices 1..6
    for (let i = 1; i <= 6; i++) {
      const wx = base.x + pos.getX(i);
      const wz = base.z + pos.getZ(i);
      this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
      const hits = this.ray.intersectObjects(neighborMeshes, true);
      if (hits && hits.length) {
        // take the first (nearest) for determinism
        const y = hits[0].point.y;
        if (Number.isFinite(y)) pos.setY(i, y);
      }
    }

    pos.needsUpdate = true;
    this._markFarfieldAdapterDirty(tile);
    try { tile.grid.geometry.computeVertexNormals(); } catch { }
  }

  // JS % is weird for negatives; normalize
  _divisible(n, k) { n = Math.round(n); k = Math.max(1, Math.round(k)); return ((n % k) + k) % k === 0; }
  _barycentric2D(p, a, b, c) {
    const v0x = b.x - a.x;
    const v0z = b.z - a.z;
    const v1x = c.x - a.x;
    const v1z = c.z - a.z;
    const v2x = p.x - a.x;
    const v2z = p.z - a.z;
    const denom = v0x * v1z - v1x * v0z;
    if (Math.abs(denom) < 1e-6) return null;
    const inv = 1 / denom;
    const v = (v2x * v1z - v1x * v2z) * inv;
    const w = (v0x * v2z - v2x * v0z) * inv;
    const u = 1 - v - w;
    return { u, v, w };
  }
  _approxTileHeight(tile, x, z) {
    if (!tile || !tile.pos) return 0;
    const pos = tile.pos;
    const center = { x: pos.getX(0), y: pos.getY(0), z: pos.getZ(0) };
    const target = { x, z };
    for (let i = 1; i <= 6; i++) {
      const j = (i === 6) ? 1 : i + 1;
      const b = { x: pos.getX(i), y: pos.getY(i), z: pos.getZ(i) };
      const c = { x: pos.getX(j), y: pos.getY(j), z: pos.getZ(j) };
      const bary = this._barycentric2D(target, center, b, c);
      if (!bary) continue;
      const { u, v, w } = bary;
      if (u >= -1e-4 && v >= -1e-4 && w >= -1e-4) {
        return u * center.y + v * b.y + w * c.y;
      }
    }
    return Number.isFinite(center.y) ? center.y : 0;
  }
  _farfieldAdapterKey(tile) {
    if (!tile) return null;
    return `${tile.q},${tile.r}`;
  }
  _markFarfieldAdapterDirty(tile) {
    if (!tile || tile.type !== 'farfield') return;
    tile._adapterDirty = true;
    const key = this._farfieldAdapterKey(tile);
    if (key) this._farfieldAdapterDirty.add(key);
  }
  _resetFarfieldTileState(tile) {
    if (!tile || tile.type !== 'farfield') return;
    if (tile.ready) tile.ready.fill(0);
    tile.unreadyCount = tile.pos?.count ?? 0;
    if (tile.fetched) tile.fetched.clear();
    tile.populating = false;
  }
  _fallbackFarfieldTile(tile) {
    if (!tile || tile.type !== 'farfield') return false;
    const currentMode = tile._farSampleMode || 'all';
    if (currentMode !== 'all') {
      tile._farSampleMode = 'all';
      this._resetFarfieldTileState(tile);
      this._queuePopulatePhase(tile, PHASE_FULL, true);
      return true;
    }
    const scale = Math.max(1, Math.round(tile.scale || 1));
    if (scale > 1) {
      const id = `${tile.q},${tile.r}`;
      const minPrec = Math.max(5, tile._farMinPrec || 5);
      this._discardTile(id);
      const t = this._addFarfieldTile(tile.q, tile.r, 1, 'all');
      t._farMinPrec = minPrec;
      this._queuePopulateIfNeeded(t, true);
      return true;
    }
    return false;
  }
  _ensureFarfieldAdapter(tile) {
    if (!tile || tile.type !== 'farfield') return;
    if (!tile._adapter) {
      const geom = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(new Float32Array(12 * 3), 3).setUsage(THREE.DynamicDrawUsage);
      const colAttr = new THREE.BufferAttribute(new Float32Array(12 * 3), 3).setUsage(THREE.DynamicDrawUsage);
      geom.setAttribute('position', posAttr);
      geom.setAttribute('color', colAttr);
      const idx = [];
      for (let i = 0; i < 6; i++) {
        const next = (i + 1) % 6;
        idx.push(i, next, 6 + next);
        idx.push(i, 6 + next, 6 + i);
      }
      geom.setIndex(idx);
      const mesh = new THREE.Mesh(geom, this._getFarfieldMaterial());
      mesh.frustumCulled = false;
      mesh.renderOrder = tile.grid.mesh ? tile.grid.mesh.renderOrder - 1 : -5;
      mesh.receiveShadow = false;
      mesh.castShadow = false;
      tile.grid.group.add(mesh);
      const arr = colAttr.array;
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] = arr[i + 1] = arr[i + 2] = 0.2;
      }
      colAttr.needsUpdate = true;
      tile._adapter = { mesh, geometry: geom, posAttr, colAttr };
      this._markFarfieldAdapterDirty(tile);
    }
    if (!tile._adapterDirty) return;
    this._updateFarfieldAdapter(tile);
    tile._adapterDirty = false;
    const key = this._farfieldAdapterKey(tile);
    if (key) this._farfieldAdapterDirty.delete(key);
  }
  _updateFarfieldAdapter(tile) {
    const adapter = tile?._adapter;
    if (!adapter) return;
    const posAttr = adapter.posAttr;
    const pos = tile.pos;
    const base = tile.grid.group.position;
    const innerRadius = this.tileRadius * FARFIELD_ADAPTER_INNER_RATIO;
    const neighbors = this._gatherNeighborMeshes(tile.q, tile.r);

    for (let i = 0; i < 6; i++) {
      const angle = (Math.PI / 3) * i;
      const ix = innerRadius * Math.cos(angle);
      const iz = innerRadius * Math.sin(angle);
      const wx = base.x + ix;
      const wz = base.z + iz;
      let iy = null;
      if (neighbors.length) {
        this.ray.set(new THREE.Vector3(wx, 1e6, wz), this.DOWN);
        const hits = this.ray.intersectObjects(neighbors, true);
        if (hits && hits.length) {
          const hit = hits[0];
          if (Number.isFinite(hit.point.y)) iy = hit.point.y;
        }
      }
      if (!Number.isFinite(iy)) {
        iy = this._approxTileHeight(tile, ix, iz);
      }
      posAttr.setXYZ(i, ix, iy, iz);
    }
    for (let i = 0; i < 6; i++) {
      const idx = 6 + i;
      posAttr.setXYZ(idx, pos.getX(i + 1), pos.getY(i + 1), pos.getZ(i + 1));
    }
    posAttr.needsUpdate = true;
    try { adapter.geometry.computeVertexNormals(); } catch { }
  }
  _refreshFarfieldAdapters(q0, r0) {
    if (!this._farfieldAdapterDirty.size) return;
    const seamMax = this.VISUAL_RING + 4;
    const budget = Math.max(1, Math.floor(this.FARFIELD_CREATE_BUDGET * 0.1) || 3);
    let processed = 0;
    for (const key of Array.from(this._farfieldAdapterDirty)) {
      if (processed >= budget) break;
      const tile = this.tiles.get(key);
      if (!tile || tile.type !== 'farfield') {
        this._farfieldAdapterDirty.delete(key);
        continue;
      }
      const dist = this._hexDist(tile.q, tile.r, q0, r0);
      if (dist < this.VISUAL_RING || dist > seamMax) {
        tile._adapterDirty = false;
        this._farfieldAdapterDirty.delete(key);
        continue;
      }
      if (!tile._adapter) this._ensureFarfieldAdapter(tile);
      else {
        this._updateFarfieldAdapter(tile);
        tile._adapterDirty = false;
        this._farfieldAdapterDirty.delete(key);
      }
      processed++;
    }
  }
  _forEachAxialRing(q0, r0, radius, step, cb) {
    step = Math.max(1, Math.floor(step));
    if (radius <= 0) { cb(q0, r0); return; }
    let q = q0 + HEX_DIRS[4][0] * radius;
    let r = r0 + HEX_DIRS[4][1] * radius;
    for (let side = 0; side < 6; side++) {
      const dir = HEX_DIRS[side];
      let remaining = radius;
      while (remaining > 0) {
        cb(q, r);
        const hop = Math.min(step, remaining);
        q += dir[0] * hop;
        r += dir[1] * hop;
        remaining -= hop;
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
      const o = 3 * i;
      arr[o] = arr[o + 1] = arr[o + 2] = 0.1;
    }
    col.needsUpdate = true;
  }
  _initFarfieldColors(tile) {
    const col = this._ensureColorAttr(tile);
    const arr = col.array;
    for (let i = 0; i < tile.pos.count; i++) {
      const o = 3 * i;
      arr[o] = arr[o + 1] = arr[o + 2] = 0.2;
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
  _colorFromNormalized(t) {
    const low = { r: 0.18, g: 0.2, b: 0.24 };
    const high = { r: 0.82, g: 0.86, b: 0.9 };
    return {
      r: low.r + (high.r - low.r) * t,
      g: low.g + (high.g - low.g) * t,
      b: low.b + (high.b - low.b) * t,
    };
  }
  _normalizedHeight(y) {
    const minY = this.GLOBAL_MIN_Y;
    const maxY = this.GLOBAL_MAX_Y;
    if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY - minY < 1e-6) return 0;
    return THREE.MathUtils.clamp((y - minY) / (maxY - minY), 0, 1);
  }
  _applyAllColorsGlobal(tile) {
    this._ensureColorAttr(tile);
    const arr = tile.col.array;
    const pos = tile.pos;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      const t = this._normalizedHeight(y);
      const color = this._colorFromNormalized(t);
      const o = 3 * i;
      arr[o] = color.r;
      arr[o + 1] = color.g;
      arr[o + 2] = color.b;
    }
    tile.col.needsUpdate = true;
    if (tile.grid?.mesh?.material) tile.grid.mesh.material.needsUpdate = true;
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
    const color = this._colorFromNormalized(this._normalizedHeight(height));
    tile.col.array[o] = color.r;
    tile.col.array[o + 1] = color.g;
    tile.col.array[o + 2] = color.b;
    tile.col.needsUpdate = true;
    if (tile.grid?.mesh?.material) tile.grid.mesh.material.needsUpdate = true;

    const wx = tile.grid.group.position.x + tile.pos.getX(idx);
    const wy = height;
    const wz = tile.grid.group.position.z + tile.pos.getZ(idx);
    if (this.audio) {
      this.audio.triggerScratch(wx, wy, wz, 0.9);
    }
    if (this._heightListeners?.size) {
      this._notifyHeightListeners(tile, idx, wx, wy, wz);
    }
    if (tile.type === 'farfield') this._markFarfieldAdapterDirty(tile);
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
    const effRadius = (tile && tile._radiusOverride) ? tile._radiusOverride : this.tileRadius;
    const sampleMode = (tile && tile._farSampleMode) ? tile._farSampleMode : 'all';
    return `tile:${this.CACHE_VER}:${originKey}:${tile.type}:${this.spacing}:${effRadius}:${datasetKey}:${this.relayMode}:${sampleMode}:${tile.q},${tile.r}`;
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
      if (tile._retryCounts) {
        if ('seed' in tile._retryCounts) tile._retryCounts.seed = 0;
        if ('edge' in tile._retryCounts) tile._retryCounts.edge = 0;
        if ('full' in tile._retryCounts) tile._retryCounts.full = 0;
      }

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
      if (tile.type === 'interactive') {
        try { localStorage.removeItem(this._seedCacheKey(tile)); } catch { /* ignore */ }
      }
    } catch { /* ignore quota */ }
  }

  _seedCacheKey(tile) {
    const originKey = this._originCacheKey || 'na';
    const datasetKey = (this.relayDataset || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40);
    return `tileSeed:${this.CACHE_VER}:${originKey}:${this.spacing}:${this.tileRadius}:${datasetKey}:${this.relayMode}:${tile.q},${tile.r}`;
  }

  _saveInteractiveSeed(tile) {
    if (!tile || tile.type !== 'interactive') return;
    if (!tile._phase?.seedDone || tile._phase?.edgeDone) return;
    if (!tile.fetched || tile.fetched.size === 0) return;
    try {
      const pos = tile.pos;
      const y = new Array(pos.count);
      for (let i = 0; i < pos.count; i++) y[i] = +pos.getY(i).toFixed(2);
      const samples = Array.from(tile.fetched).map((idx) => ({
        i: idx,
        y: +pos.getY(idx).toFixed(2),
      }));
      if (!samples.length) return;
      const payload = {
        v: this.CACHE_VER,
        phase: 'seed',
        type: 'interactive',
        spacing: this.spacing,
        tileRadius: this.tileRadius,
        q: tile.q,
        r: tile.r,
        y,
        samples,
      };
      localStorage.setItem(this._seedCacheKey(tile), JSON.stringify(payload));
    } catch { /* ignore */ }
  }

  _tryLoadInteractiveSeed(tile) {
    if (!tile || tile.type !== 'interactive') return false;
    try {
      const raw = localStorage.getItem(this._seedCacheKey(tile));
      if (!raw) return false;

      const data = JSON.parse(raw);
      if (!data || data.phase !== 'seed') return false;
      if (data.spacing !== this.spacing || data.tileRadius !== this.tileRadius) return false;
      if (!Array.isArray(data.y) || data.y.length !== tile.pos.count) return false;

      const pos = tile.pos;
      for (let i = 0; i < data.y.length; i++) pos.setY(i, data.y[i]);
      pos.needsUpdate = true;
      tile.grid.geometry.computeVertexNormals?.();

      const ready = tile.ready;
      if (ready && ready.length === pos.count) ready.fill(0);
      else tile.ready = new Uint8Array(pos.count);

      tile.fetched?.clear?.();
      if (!tile.fetched) tile.fetched = new Set();

      let readyCount = 0;
      if (Array.isArray(data.samples)) {
        for (const sample of data.samples) {
          const idx = Number(sample?.i);
          const val = Number(sample?.y);
          if (!Number.isInteger(idx) || idx < 0 || idx >= pos.count) continue;
          if (!Number.isFinite(val)) continue;
          tile.ready[idx] = 1;
          tile.fetched.add(idx);
          readyCount += 1;
        }
      }
      if (readyCount === 0) return false;

      tile.unreadyCount = Math.max(0, pos.count - readyCount);
      tile.populating = false;
      if (!tile._phase) tile._phase = {};
      tile._phase.seedDone = true;
      tile._phase.edgeDone = false;
      tile._phase.fullDone = false;
      tile.relaxEnabled = false;
      if (tile._retryCounts) {
        tile._retryCounts.seed = 0;
        if ('edge' in tile._retryCounts) tile._retryCounts.edge = 0;
        if ('full' in tile._retryCounts) tile._retryCounts.full = 0;
      }

      this._ensureTileBuffers(tile);
      this._pullGeometryToBuffers(tile);
      this._updateGlobalFromArray(data.y);
      this._applyAllColorsGlobal(tile);

      return true;
    } catch {
      return false;
    }
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
    //grid.group.add(wire);
    //grid.wire = wire;

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
      _visualEdgeLocks: new Set(),
      relaxEnabled: false,
      _retryCounts: { seed: 0, edge: 0, full: 0 },
      wire
    };
    this._ensureTileBuffers(tile);
    this.tiles.set(id, tile);

    this._initColorsNearBlack(tile);
    this._markRelaxListDirty();
    this._invalidateHeightCache();

    if (!this._tryLoadTileFromCache(tile)) {
      if (this._tryLoadInteractiveSeed(tile)) {
        this._deferredInteractive.add(tile);
        this._markRelaxListDirty();
        this._scheduleBackfill(0);
        this._tryAdvanceFetchPhase(tile);
      } else {
        this._queuePopulate(tile, true);
      }
    }
    return tile;
  }

  /* ---------------- creation: visual tile (7 verts) ---------------- */
  _makeLowResHexMeshForRadius(a) {
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

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    const mesh = new THREE.Mesh(geom, this._getTerrainMaterial());
    mesh.frustumCulled = false; mesh.receiveShadow = false; mesh.castShadow = false;

    const group = new THREE.Group(); group.add(mesh);
    return { group, mesh, geometry: geom, mat };
  }

  // pick stride/scale/sample strategy by distance
  _farfieldTierForDist(dist) {
    // tune these bands freely; goal is to cap #tiles & #queries
    if (dist <= this.VISUAL_RING + 24) return { stride: 3, scale: 3, samples: 'all', minPrec: 5 };
    if (dist <= this.VISUAL_RING + 128) return { stride: 6, scale: 6, samples: 'tips', minPrec: 4 };
    if (dist <= this.VISUAL_RING + 384) return { stride: 12, scale: 12, samples: 'tips', minPrec: 3 };
    return { stride: 24, scale: 24, samples: 'center', minPrec: 3 }; // absurd horizon: 1 sample/tile
  }

  // normalize modulo for negatives
  _divisible(n, k) { n = Math.round(n); k = Math.max(1, Math.round(k)); return ((n % k) + k) % k === 0; }

  // which indices to fetch for a farfield tile (geometry is [center, corner1..6])
  _farfieldSampleIndices(tile) {
    const mode = tile._farSampleMode || 'all';
    if (mode === 'tips') return [1, 2, 3, 4, 5, 6];
    // default: fetch everything (center + tips)
    return [0, 1, 2, 3, 4, 5, 6];
  }

  // after sparse fetch, fill the rest locally to avoid extra network
  _completeFarfieldFromSparse(tile) {
    const pos = tile.pos;
    const ready = tile.ready;
    const mode = tile._farSampleMode || 'all';

    if (mode === 'tips') {
      // set center to average of tips (gives large-scale slope continuity)
      let sum = 0, cnt = 0;
      for (let i = 1; i <= 6; i++) { const y = pos.getY(i); if (Number.isFinite(y)) { sum += y; cnt++; } }
      const cy = cnt ? (sum / cnt) : 0;
      pos.setY(0, cy);
    }
    for (let i = 0; i < pos.count; i++) ready[i] = 1;
    tile.unreadyCount = 0;
    pos.needsUpdate = true;
    try { tile.grid.geometry.computeVertexNormals(); } catch { }
    this._applyAllColorsGlobal(tile);
  }

  // effective spacing for a tile (used to choose coarse geohash precision)
  _effectiveSpacingForTile(tile) {
    const s = this.spacing;
    const sc = Number.isFinite(tile?.scale) ? tile.scale : 1;
    return s * Math.max(1, sc);
  }

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

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      metalness: 0.05,
      roughness: 0.75,
    });
    const mesh = new THREE.Mesh(geom, this._getTerrainMaterial());
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;

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
    //low.group.add(wire);
    //low.wire = wire;

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
      _retryCounts: { full: 0 },
      wire
    };
    this.tiles.set(id, tile);
    for (const [dq, dr] of HEX_DIRS) {
      const n = this._getTile(q + dq, r + dr);
      if (n && n.type === 'farfield') this._markFarfieldAdapterDirty(n);
    }

    if (!this._tryLoadTileFromCache(tile)) {
      this._queuePopulate(tile, false);
    }
    return tile;
  }
  _addFarfieldTile(q, r, scale = 1, sampleMode = 'all') {
    const id = `${q},${r}`;
    const existing = this.tiles.get(id);
    if (existing) {
      if (existing.type === 'farfield' && ((existing.scale || 1) !== scale || (existing._farSampleMode || 'all') !== sampleMode)) {
        this._discardTile(id);
      } else {
        return existing;
      }
    }

    const radius = this.tileRadius * Math.max(1, Math.round(scale));
    const low = this._makeLowResHexMeshForRadius(radius);
    low.group.name = `tile-far-${id}`;
    const farfieldMat = this._getFarfieldMaterial();
    if (low.mesh) {
      low.mesh.material = farfieldMat;
      low.mesh.renderOrder = -10;
    }
    const wp = this._axialWorld(q, r);
    low.group.position.set(wp.x, 0, wp.z);
    this.scene.add(low.group);

    // keep farfield out of height raycasts so near queries stay fast
    if (low.mesh) low.mesh.raycast = function () { };

    const pos = low.geometry.attributes.position;
    const ready = new Uint8Array(pos.count);
    const neighbors = this._buildAdjacency(low.geometry.getIndex(), pos.count);
    const colAttr = low.geometry.attributes.color;
    if (colAttr) colAttr.setUsage(THREE.DynamicDrawUsage);

    const tile = {
      type: 'farfield',
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
      _retryCounts: { full: 0 },
      scale,
      _radiusOverride: radius,
      _farSampleMode: sampleMode,
      _adapter: null,
      _adapterDirty: true
    };
    this.tiles.set(id, tile);

    this._initColorsNearBlack(tile);
    this._invalidateHeightCache();
    this._ensureFarfieldAdapter(tile);
    for (const [dq, dr] of HEX_DIRS) {
      const neighbor = this._getTile(q + dq, r + dr);
      if (neighbor && neighbor.type === 'farfield') this._markFarfieldAdapterDirty(neighbor);
    }

    if (!this._nextFarfieldLog || this._nowMs() >= this._nextFarfieldLog) {
      console.log('[tiles.farfield] add', { id, verts: tile.pos.count, scale, sampleMode });
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
    this._invalidateHeightCache();
    this._markRelaxListDirty();
    try {
      this.scene.remove(v.grid.group);
      v.grid.geometry?.dispose?.();
      v.grid.mat?.dispose?.();
      v.wire?.material?.dispose?.();
    } catch { }

    // Seal edges with corner-safe snapping and relax inner corner band
    this._sealEdgesCornerSafe(t);
    this._stitchInteractiveToVisualEdges(t);
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
      if (!tile._phase?.seedDone) return true;
      if (this._interactiveSecondPass && this._tileNeedsFetch(tile)) return true;
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

  _farfieldTilesPending(exclude = null) {
    for (const tile of this.tiles.values()) {
      if (tile === exclude) continue;
      if (tile.type !== 'farfield') continue;
      if (this._tileNeedsFetch(tile) || tile.populating) return true;
    }
    return false;
  }

  _activateInteractiveSecondPass() {
    if (this._interactiveSecondPass) return;
    this._interactiveSecondPass = true;
    this._fetchPhase = 'interactive-final';
    console.log('[tiles] interactive second pass activated');
    this._primePhaseWork('interactive-final');
  }

  _releaseDeferredInteractivePhases() {
    if (!this._deferredInteractive.size) return;
    for (const tile of this._deferredInteractive) {
      if (!tile || tile.type !== 'interactive') continue;
      if (!tile._phase?.seedDone) continue;
      if (!tile._phase.edgeDone && !this._isPhaseQueued(tile, PHASE_EDGE)) {
        this._queuePopulatePhase(tile, PHASE_EDGE);
        continue;
      }
      if (tile._phase.edgeDone && !tile._phase.fullDone && !this._isPhaseQueued(tile, PHASE_FULL)) {
        this._queuePopulatePhase(tile, PHASE_FULL);
      }
    }
    this._deferredInteractive.clear();
  }

  _tryAdvanceFetchPhase(exclude = null) {
    if (this._fetchPhase === 'interactive') {
      if (this._interactiveTilesPending(exclude)) return;
      this._fetchPhase = 'visual';
      this._primePhaseWork('visual');
      this._markRelaxListDirty();
      this._scheduleBackfill(0);
      return;
    }
    if (this._fetchPhase === 'visual') {
      if (this._visualTilesPending(exclude)) return;
      this._fetchPhase = 'farfield';
      this._primePhaseWork('farfield');
      this._scheduleBackfill(0);
      return;
    }
    if (this._fetchPhase === 'farfield') {
      if (this._farfieldTilesPending(exclude)) return;
      this._activateInteractiveSecondPass();
      return;
    }
  }

  _primePhaseWork(phase) {
    const wantVisual = phase === 'visual' || phase === 'farfield' || phase === 'interactive-final';
    const wantFarfield = phase === 'farfield' || phase === 'interactive-final';

    if (phase === 'interactive') {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'interactive') continue;
        if (tile._phase?.seedDone) continue;
        this._queuePopulatePhase(tile, PHASE_SEED, true);
      }
      return;
    }

    if (wantVisual) {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'visual') continue;
        if (!this._tileNeedsFetch(tile)) continue;
        this._queuePopulatePhase(tile, PHASE_FULL, true);
      }
    }

    if (wantFarfield) {
      for (const tile of this.tiles.values()) {
        if (tile.type !== 'farfield') continue;
        if (!this._tileNeedsFetch(tile)) continue;
        this._queuePopulatePhase(tile, PHASE_FULL, true);
      }
    }

    if (phase === 'interactive-final') {
      this._releaseDeferredInteractivePhases();
    }
  }

  _collectPipelineStats() {
    const stats = {
      phase: this._fetchPhase,
      queue: this._populateQueue.length,
      inflight: this._populateInflight,
      totals: { interactive: 0, visual: 0, farfield: 0 },
      pending: { interactive: 0, visual: 0, farfield: 0 },
      queued: { interactive: 0, visual: 0, farfield: 0 },
      deferredInteractive: this._deferredInteractive.size,
      interactiveSecondPass: this._interactiveSecondPass,
    };

    for (const tile of this.tiles.values()) {
      const type = tile.type;
      if (!(type in stats.totals)) stats.totals[type] = 0;
      if (!(type in stats.pending)) stats.pending[type] = 0;
      if (!(type in stats.queued)) stats.queued[type] = 0;

      stats.totals[type] += 1;
      if (this._tileNeedsFetch(tile)) stats.pending[type] += 1;
      if (tile._queuedPhases?.size) stats.queued[type] += tile._queuedPhases.size;
    }

    return stats;
  }

  _phaseKey(phase) {
    return phase === PHASE_SEED ? 'seed' : (phase === PHASE_EDGE ? 'edge' : 'full');
  }

  _phaseName(phase) {
    return phase === PHASE_SEED ? 'seed' : (phase === PHASE_EDGE ? 'edge' : 'full');
  }

  _registerPhaseRetry(tile, phase) {
    if (!tile) return false;
    if (!tile._retryCounts) tile._retryCounts = { seed: 0, edge: 0, full: 0 };
    const key = this._phaseName(phase);
    const cap = key === 'seed' ? 4 : 3;
    tile._retryCounts[key] = (tile._retryCounts[key] || 0) + 1;
    return tile._retryCounts[key] <= cap;
  }

  _resetPhaseRetry(tile, phase) {
    if (!tile || !tile._retryCounts) return;
    const key = this._phaseName(phase);
    tile._retryCounts[key] = 0;
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
    if (!tile._phase.seedDone) {
      this._queuePopulatePhase(tile, PHASE_SEED, priority);
    } else if (!this._interactiveSecondPass) {
      this._deferredInteractive.add(tile);
    } else if (!tile._phase.edgeDone) {
      this._queuePopulatePhase(tile, PHASE_EDGE, priority);
    } else if (!tile._phase.fullDone) {
      this._queuePopulatePhase(tile, PHASE_FULL, priority);
    }
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

  _handleInteractivePhaseCompletion(tile, phase) {
    if (!tile || tile.type !== 'interactive') return;
    if (phase === PHASE_SEED) {
      tile._phase.seedDone = true;
      if (this._interactiveSecondPass) this._queuePopulatePhase(tile, PHASE_EDGE);
      else this._deferredInteractive.add(tile);
      this._saveInteractiveSeed(tile);
      if (this._fetchPhase === 'interactive') this._tryAdvanceFetchPhase(tile);
    } else if (phase === PHASE_EDGE) {
      tile._phase.edgeDone = true;
      if (this._interactiveSecondPass) this._queuePopulatePhase(tile, PHASE_FULL);
      else this._deferredInteractive.add(tile);
    } else {
      tile._phase.fullDone = true;
      this._deferredInteractive.delete(tile);
      if (tile.locked) tile.locked.fill(0);
      this._saveTileToCache(tile);
    }
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
        this._handleInteractivePhaseCompletion(tile, phase);
      } else {
        tile._phase.fullDone = true;
        this._saveTileToCache(tile);
      }
      if (!this._tileNeedsFetch(tile)) this._tryAdvanceFetchPhase(tile);
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

    const missing = Array.isArray(indices)
      ? indices.filter((idx) => tile.ready[idx] !== 1)
      : [];
    if (missing.length) {
      if (tile.type === 'farfield' && this._fallbackFarfieldTile(tile)) {
        if (tile && typeof tile === 'object') tile.populating = false;
        return;
      }
      const allowRetry = this._registerPhaseRetry(tile, phase);
      if (allowRetry) {
        const key = this._phaseKey(phase);
        tile._queuedPhases?.delete(key);
        console.warn(`[tiles] retry ${this._phaseName(phase)} tile ${tile.q},${tile.r} · missing ${missing.length}`);
        this._queuePopulatePhase(tile, phase, true);
        return;
      }
      console.warn(`[tiles] exhausted retries for ${this._phaseName(phase)} tile ${tile.q},${tile.r} · unresolved ${missing.length}`);
    } else {
      this._resetPhaseRetry(tile, phase);
    }

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


   // Finally, if any side borders a visual/farfield tile, feather to a straight edge line
   // derived from the neighbor’s tip heights. This guarantees no cracks at the LOD boundary.
   if (tile.type === 'interactive') {
     this._stitchInteractiveToVisualEdges(tile, { bandRatio: 0.07, sideArc: Math.PI / 10 });
   }

    // ---- mark phase complete & chain next ----
    if (tile.type === 'interactive') {
      this._handleInteractivePhaseCompletion(tile, phase);
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

    // Build a single, coarse precision for the whole batch based on the "worst" (biggest) tiles.
    const effSpacings = tiles.map(t => this._effectiveSpacingForTile(t));
    const maxEffSpacing = effSpacings.length ? Math.max(...effSpacings) : this.spacing;
    let precision = pickGeohashPrecision(maxEffSpacing);
    // obey per-tile minimum precision hints (coarser == smaller number of chars)
    let forcedMin = 99;
    for (const t of tiles) if (Number.isFinite(t._farMinPrec)) forcedMin = Math.min(forcedMin, t._farMinPrec);
    if (Number.isFinite(forcedMin)) precision = Math.max(forcedMin, precision);

    const mode = this.relayMode;

    // Gather only the indices we truly want for each far tile (center / tips / all).
    const latLonAll = [];
    const refs = [];
    for (const tile of tiles) {
      const pos = tile.pos;
      const ready = tile.ready;
      const idxs = this._farfieldSampleIndices(tile);
      const latLon = this._collectTileLatLon(tile);
      for (const i of idxs) {
        if (ready && ready[i]) continue;
        latLonAll.push(latLon[i]);
        refs.push({ tile, index: i });
      }
    }

    if (!latLonAll.length) {
      for (const tile of tiles) {
        tile.populating = false;
        // derive missing verts locally (e.g., set corners from center)
        this._completeFarfieldFromSparse(tile);
        tile._phase.fullDone = true;
        this._saveTileToCache(tile);
        this._tryAdvanceFetchPhase(tile);
      }
      return;
    }

    const indices = latLonAll.map((_, i) => i);
    const geohashes = mode === 'geohash'
      ? latLonAll.map(({ lat, lng }) => geohashEncode(lat, lng, precision))
      : null;

    const batches = (mode === 'geohash')
      ? this._indicesToBatchesGeohash(indices, geohashes, precision)
      : this._indicesToBatchesLatLng(indices, latLonAll);

    // Dedup maps so multiple refs share the same response (huge savings with coarse precision).
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
          .catch(() => { /* ignore; backfill will retry */ })
      );
    });

    await Promise.allSettled(requests);

    // finalize tiles (derive missing verts if we used sparse sampling)
    for (const tile of tiles) {
      tile.populating = false;

      // If we fetched sparse samples, complete locally now.
      if ((tile._farSampleMode === 'center' || tile._farSampleMode === 'tips') && tile.unreadyCount > 0) {
        // Only complete if at least one sample landed; otherwise let retry logic handle.
        if (tile.fetched && tile.fetched.size > 0) {
          this._completeFarfieldFromSparse(tile);
        }
      }
      this._sealFarfieldCornersAgainstNeighbors(tile);

      if (tile.unreadyCount > 0) {
        const allowRetry = this._registerPhaseRetry(tile, PHASE_FULL);
        if (allowRetry) {
          tile._queuedPhases?.delete('full');
          console.warn(`[tiles] retry farfield tile ${tile.q},${tile.r} · pending ${tile.unreadyCount}`);
          this._queuePopulatePhase(tile, PHASE_FULL, true);
          continue;
        }
        console.warn(`[tiles] exhausted farfield retries tile ${tile.q},${tile.r} · remaining ${tile.unreadyCount}`);
      } else {
        this._resetPhaseRetry(tile, PHASE_FULL);
      }

      const done = tile.unreadyCount === 0;
      tile._phase.fullDone = done;
      if (done) this._saveTileToCache(tile);
      else this._queuePopulate(tile, false);

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
    for (let d = this.VISUAL_RING + 1; d <= this.FARFIELD_RING; d++) {
      const tier = this._farfieldTierForDist(d);
      const { stride, scale, samples, minPrec } = tier;
      this._forEachAxialRing(q0, r0, d, stride, (q, r) => {
        const id = `${q},${r}`;
        if (!this.tiles.has(id)) {
          const t = this._addFarfieldTile(q, r, scale, samples);
          t._farMinPrec = minPrec;
        }
      });
    }
    this._scheduleBackfill(0);
  }


  /* ---------------- per-frame: ensure LOD, relax, prune ---------------- */
update(playerPos) {
  if (!this.origin) return;

  // ⚙️ Safety floor: never allow 0 interactive ring
  this.INTERACTIVE_RING = Math.max(1, (this.INTERACTIVE_RING | 0));

  const startMs = performance?.now ? performance.now() : Date.now();
  const nowMs = () => (performance?.now ? performance.now() : Date.now());
  const HARD_BUDGET_MS = (this.UPDATE_BUDGET_MS ?? 4.5);

  const a  = this.tileRadius;
  const qf = (2 / 3 * playerPos.x) / a;
  const rf = ((-1 / 3 * playerPos.x) + (Math.sqrt(3) / 3 * playerPos.z)) / a;
  const q0 = Math.round(qf), r0 = Math.round(rf);
  const key = `${q0},${r0}`;

  const tileChanged = !this._lastQR || this._lastQR.q !== q0 || this._lastQR.r !== r0;
  if (tileChanged) {
    this._lastQR = { q: q0, r: r0 };
    this._pendingHeavySweep = true; // 🔁 ensure we continue filling ring next frames
  }

  const maintenance = () => {
    this._ensureRelaxList?.();
    this._drainRelaxQueue?.();
    if (this._globalDirty) {
      const t = (typeof now === 'function' ? now() : Date.now());
      if (!this._lastRecolorAt || (t - this._lastRecolorAt > 100)) {
        for (const tile of this.tiles.values()) this._applyAllColorsGlobal(tile);
        this._globalDirty = false;
        this._lastRecolorAt = t;
      }
    }
  };

  // Decide whether to do heavy work this frame
  const doHeavy = tileChanged || this._pendingHeavySweep === true;

  // Always do cheap maintenance each frame
  maintenance();

  if (!doHeavy) {
    // Light populate ping near the edge to keep things lively without cost
    let created = 0;
    const MAX_PINGS = Math.max(1, Math.floor((this.VISUAL_CREATE_BUDGET || 4) * 0.25));
    const R = Math.min(this.VISUAL_RING || 0, (this.INTERACTIVE_RING + 1));
    outerPing:
    for (let dq = -R; dq <= R; dq++) {
      const rMin = Math.max(-R, -dq - R);
      const rMax = Math.min(R, -dq + R);
      for (let dr = rMin; dr <= rMax; dr++) {
        if (nowMs() - startMs > HARD_BUDGET_MS) break outerPing;
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.INTERACTIVE_RING) continue;
        const existing = this.tiles.get(`${q},${r}`);
        if (!existing) {
          this._addVisualTile(q, r);
          if (++created >= MAX_PINGS) break outerPing;
        } else {
          this._queuePopulateIfNeeded?.(existing, false);
        }
      }
    }
    return;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // HEAVY SWEEP (runs on tile change AND keeps resuming while pending)
  // ────────────────────────────────────────────────────────────────────────────
  let budgetHit = false;
  let workDone  = 0;

  // 1) interactive ring
  for (let dq = -this.INTERACTIVE_RING; dq <= this.INTERACTIVE_RING; dq++) {
    if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
    const rMin = Math.max(-this.INTERACTIVE_RING, -dq - this.INTERACTIVE_RING);
    const rMax = Math.min(this.INTERACTIVE_RING, -dq + this.INTERACTIVE_RING);
    for (let dr = rMin; dr <= rMax; dr++) {
      if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
      const q = q0 + dq, r = r0 + dr;
      const id = `${q},${r}`;
      const cur = this.tiles.get(id);
      if (!cur) {
        this._addInteractiveTile(q, r); workDone++;
      } else if (cur.type === 'visual') {
        this._promoteVisualToInteractive(q, r); workDone++;
      } else if (cur.type === 'farfield') {
        this._discardTile(id); this._addInteractiveTile(q, r); workDone++;
      }
    }
  }

  // 2) visual ring (respect budget)
  if (!budgetHit) {
    let created = 0;
    outerVisual:
    for (let dq = -this.VISUAL_RING; dq <= this.VISUAL_RING; dq++) {
      if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
      const rMin = Math.max(-this.VISUAL_RING, -dq - this.VISUAL_RING);
      const rMax = Math.min(this.VISUAL_RING, -dq + this.VISUAL_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break outerVisual; }
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.INTERACTIVE_RING) continue;
        const id = `${q},${r}`;
        const existing = this.tiles.get(id);
        if (!existing) {
          this._addVisualTile(q, r); workDone++;
          if (++created >= (this.VISUAL_CREATE_BUDGET || 6)) break outerVisual;
        } else {
          if (existing.type === 'farfield') {
            this._discardTile(id); this._addVisualTile(q, r); workDone++;
          } else {
            this._queuePopulateIfNeeded?.(existing, false);
          }
        }
      }
    }
  }

  // 3) farfield (strided + sparse) (respect budget)
  if (!budgetHit) {
    let farCreated = 0;
    farOuter:
    for (let dq = -this.FARFIELD_RING; dq <= this.FARFIELD_RING; dq++) {
      if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
      const rMin = Math.max(-this.FARFIELD_RING, -dq - this.FARFIELD_RING);
      const rMax = Math.min(this.FARFIELD_RING, -dq + this.FARFIELD_RING);
      for (let dr = rMin; dr <= rMax; dr++) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break farOuter; }
        const q = q0 + dq, r = r0 + dr;
        const dist = this._hexDist(q, r, q0, r0);
        if (dist <= this.VISUAL_RING) continue;

        const tier = this._farfieldTierForDist?.(dist) || { stride: 3, scale: 2, samples: 'sparse', minPrec: 6 };
        const { stride, scale, samples, minPrec } = tier;
        if (!this._divisible?.(q - q0, stride) || !this._divisible?.(r - r0, stride)) continue;

        const id = `${q},${r}`;
        const existing = this.tiles.get(id);

        if (!existing) {
          const t = this._addFarfieldTile(q, r, scale, samples);
          t._farMinPrec = minPrec; workDone++;
          if (++farCreated >= (this.FARFIELD_CREATE_BUDGET || 16)) break farOuter;
        } else if (existing.type !== 'farfield' ||
                   (existing.scale || 1) !== scale ||
                   (existing._farSampleMode || 'all') !== samples) {
          this._discardTile(id);
          const t = this._addFarfieldTile(q, r, scale, samples);
          t._farMinPrec = minPrec; workDone++;
          if (++farCreated >= (this.FARFIELD_CREATE_BUDGET || 16)) break farOuter;
        } else {
          existing._farMinPrec = minPrec;
          this._queuePopulateIfNeeded?.(existing, false);
        }
      }
    }
  }

  // 4) prune/downgrade (respect budget)
  if (!budgetHit) {
    const toRemove = [];
    const toFarfield = [];
    for (const [id, t] of this.tiles) {
      if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
      const dist = this._hexDist(t.q, t.r, q0, r0);
      if (dist > this.FARFIELD_RING) { toRemove.push(id); continue; }
      if (dist > this.VISUAL_RING) { if (t.type !== 'farfield') toFarfield.push({ q: t.q, r: t.r }); }
    }
    for (const id of toRemove) {
      if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
      this._discardTile(id); workDone++;
    }
    if (!budgetHit) {
      for (const { q, r } of toFarfield) {
        if (nowMs() - startMs > HARD_BUDGET_MS) { budgetHit = true; break; }
        const id = `${q},${r}`;
        this._discardTile(id);
        this._addFarfieldTile(q, r); workDone++;
      }
    }
    this._refreshFarfieldAdapters?.(q0, r0);
  }

  // Keep sweeping next frame if we hit the budget or we still did meaningful work
  this._pendingHeavySweep = budgetHit || (workDone > 0);

  // (Optional) one-time faster fill: bump budget for first few frames after spawn
  // if (this._spawnBoostUntil && nowMs() < this._spawnBoostUntil) this._pendingHeavySweep = true;
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
    const health = typeof this.terrainRelay?.getHealth === 'function' ? this.terrainRelay.getHealth() : null;
    const metrics = health?.metrics || null;
    const isConnected = !!(health?.connected || text === 'connected' || level === 'ok');

    this._relayStatus = {
      text,
      level,
      connected: !!health?.connected,
      address: health?.address || this.relayAddress || null,
      metrics,
      heartbeat: health?.heartbeat || null,
    };

    const consecutive = metrics?.consecutiveFailures ?? 0;
    const heartbeatFail = metrics?.heartbeatFail ?? 0;

    if (!isConnected) {
      this.MAX_CONCURRENT_POPULATES = 4;
      this.RATE_QPS = 4; this.RATE_BPS = 96 * 1024;
    } else if (consecutive >= 6 || heartbeatFail > 2) {
      this.MAX_CONCURRENT_POPULATES = 4;
      this.RATE_QPS = 4; this.RATE_BPS = 96 * 1024;
    } else if (consecutive > 0 || heartbeatFail > 0) {
      this.MAX_CONCURRENT_POPULATES = 6;
      this.RATE_QPS = 6; this.RATE_BPS = 128 * 1024;
    } else {
      this.MAX_CONCURRENT_POPULATES = 12;
      this.RATE_QPS = 12; this.RATE_BPS = 256 * 1024;
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
    const qualityClamp = THREE.MathUtils.clamp(qualityRaw, 0.3, 1.2);
    this._lodQuality = qualityClamp;

    const qMin = 0.3;
    const qMax = 1.05;
    const norm = THREE.MathUtils.clamp((qualityClamp - qMin) / (qMax - qMin), 0, 1);

    const baseInteractive = this._baseLod.interactiveRing;
    const baseVisual = this._baseLod.visualRing;
    const baseFarfieldExtra = Number.isFinite(this._baseLod.farfieldExtra)
      ? this._baseLod.farfieldExtra
      : Math.max(1, this._baseLod.farfieldRing - this._baseLod.visualRing);
    const baseVisualBudget = this._baseLod.visualCreateBudget || 4;
    const baseFarfieldBudget = this._baseLod.farfieldCreateBudget || 60;
    const baseFarfieldBatch = this._baseLod.farfieldBatchSize || this.FARFIELD_BATCH_SIZE;
    const baseRelaxIters = this._baseLod.relaxIters || this.RELAX_ITERS_PER_FRAME;
    const baseRelaxBudget = this._baseLod.relaxBudget || this.RELAX_FRAME_BUDGET_MS;

    const interactiveMin = Math.max(1, Math.round(baseInteractive * 0.5));
    const interactiveMax = Math.max(interactiveMin + 1, Math.round(baseInteractive * 1.35));
    const interactiveRing = Math.max(1, Math.round(THREE.MathUtils.lerp(interactiveMin, interactiveMax, norm)));

    const visualMin = Math.max(interactiveRing + 1, Math.round(baseVisual * 0.55));
    const visualMax = Math.max(visualMin + 1, Math.round(baseVisual * 1.25));
    const visualRing = Math.max(interactiveRing + 1, Math.round(THREE.MathUtils.lerp(visualMin, visualMax, norm)));

    const farfieldExtraMin = Math.max(4, Math.round(baseFarfieldExtra * 0.4));
    const farfieldExtraMax = Math.max(farfieldExtraMin, Math.round(baseFarfieldExtra * 1.3));
    const farfieldExtra = Math.max(1, Math.round(THREE.MathUtils.lerp(farfieldExtraMin, farfieldExtraMax, norm)));

    let ringChanged = false;
    if (this.INTERACTIVE_RING !== interactiveRing) { this.INTERACTIVE_RING = interactiveRing; ringChanged = true; }
    if (this.VISUAL_RING !== visualRing) { this.VISUAL_RING = visualRing; ringChanged = true; }
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

    const visualBudget = Math.max(1, Math.round(THREE.MathUtils.lerp(baseVisualBudget * 0.25, baseVisualBudget, norm)));
    this.VISUAL_CREATE_BUDGET = visualBudget;
    this.FARFIELD_CREATE_BUDGET = Math.max(4, Math.round(THREE.MathUtils.lerp(baseFarfieldBudget * 0.35, baseFarfieldBudget * 1.15, norm)));
    this.FARFIELD_BATCH_SIZE = Math.max(4, Math.round(THREE.MathUtils.lerp(Math.max(8, baseFarfieldBatch * 0.5), baseFarfieldBatch * 1.1, norm)));

    this.RELAX_ITERS_PER_FRAME = Math.max(1, Math.round(THREE.MathUtils.lerp(Math.max(4, baseRelaxIters * 0.45), baseRelaxIters * 1.25, norm)));
    this.RELAX_FRAME_BUDGET_MS = +(THREE.MathUtils.lerp(Math.max(0.6, baseRelaxBudget * 0.6), baseRelaxBudget * 1.45, norm).toFixed(2));

    for (const tile of this.tiles.values()) {
      if (!tile?.wire?.material?.userData) continue;
      const dist = this._hexDist(tile.q, tile.r, 0, 0);
      let fade = tile.wire.material.userData.uFade;
      if (tile.type === 'interactive') fade = this._interactiveWireFade(dist);
      else if (tile.type === 'visual') fade = this._visualWireFade(dist);
      tile.wire.material.userData.uFade = fade;
    }

    return {
      quality: this._lodQuality,
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldRing: this.FARFIELD_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      visualCreateBudget: this.VISUAL_CREATE_BUDGET,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      relaxIters: this.RELAX_ITERS_PER_FRAME,
      relaxBudget: Number(this.RELAX_FRAME_BUDGET_MS.toFixed(2)),
    };
  }

  getTerrainSettings() {
    return {
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
      farfieldNearPad: this.FARFIELD_NEAR_PAD,
      tileRadius: this.tileRadius,
      spacing: this.spacing,
    };
  }

  getDefaultTerrainSettings() {
    return { ...this._defaultTerrainSettings };
  }

  updateTerrainSettings({
    interactiveRing,
    visualRing,
    farfieldExtra,
    farfieldCreateBudget,
    farfieldBatchSize,
    farfieldNearPad,
    tileRadius,
    spacing,
  } = {}) {
    let needReset = false;
    if (Number.isFinite(tileRadius) && tileRadius > 10 && tileRadius !== this.tileRadius) {
      this.tileRadius = tileRadius;
      needReset = true;
    }
    if (Number.isFinite(spacing) && spacing > 0 && spacing !== this.spacing) {
      this.spacing = spacing;
      needReset = true;
    }

    if (Number.isFinite(interactiveRing)) {
      this.INTERACTIVE_RING = Math.max(1, Math.round(interactiveRing));
    }
    if (Number.isFinite(visualRing)) {
      this.VISUAL_RING = Math.max(this.INTERACTIVE_RING + 1, Math.round(visualRing));
    }
    if (Number.isFinite(farfieldExtra)) {
      this.FARFIELD_EXTRA = Math.max(1, Math.round(farfieldExtra));
    }
    this.FARFIELD_RING = this.VISUAL_RING + this.FARFIELD_EXTRA;

    if (Number.isFinite(farfieldCreateBudget)) {
      this.FARFIELD_CREATE_BUDGET = Math.max(1, Math.round(farfieldCreateBudget));
    }
    if (Number.isFinite(farfieldBatchSize)) {
      this.FARFIELD_BATCH_SIZE = Math.max(1, Math.round(farfieldBatchSize));
    }
    if (Number.isFinite(farfieldNearPad)) {
      this.FARFIELD_NEAR_PAD = Math.max(0, Math.round(farfieldNearPad));
    }

    this._baseLod = {
      ...this._baseLod,
      interactiveRing: this.INTERACTIVE_RING,
      visualRing: this.VISUAL_RING,
      farfieldExtra: this.FARFIELD_EXTRA,
      farfieldRing: this.FARFIELD_RING,
      farfieldCreateBudget: this.FARFIELD_CREATE_BUDGET,
      farfieldBatchSize: this.FARFIELD_BATCH_SIZE,
    };

    if (needReset) {
      this._resetAllTiles();
      if (this.origin) {
        this._ensureType(0, 0, 'interactive');
        this._prewarmVisualRing(0, 0);
        this._prewarmFarfieldRing(0, 0);
      }
    } else {
      this._markRelaxListDirty();
      if (this.origin) {
        this._prewarmVisualRing(0, 0);
        this._prewarmFarfieldRing(0, 0);
      }
    }
    this._scheduleBackfill(0);
  }

  resetTerrainSettings() {
    this.updateTerrainSettings(this.getDefaultTerrainSettings());
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && typeof performance.now === 'function')
      ? performance.now()
      : Date.now();
  }

  /* ---------------- Queries & controls ---------------- */

  _worldToAxialFloat(x, z) {
    const a = this.tileRadius;
    const q = (2 / 3) * (x / a);
    const r = ((-1 / 3) * (x / a)) + ((Math.sqrt(3) / 3) * (z / a));
    return { q, r };
  }

  _axialRound(q, r) {
    let x = q;
    let y = r;
    let z = -x - y;
    let rx = Math.round(x);
    let ry = Math.round(y);
    let rz = Math.round(z);

    const xDiff = Math.abs(rx - x);
    const yDiff = Math.abs(ry - y);
    const zDiff = Math.abs(rz - z);

    if (xDiff > yDiff && xDiff > zDiff) {
      rx = -ry - rz;
    } else if (yDiff > zDiff) {
      ry = -rx - rz;
    } else {
      rz = -rx - ry;
    }
    return { q: rx, r: ry };
  }

  _axialNeighbors(q, r) {
    return [
      { q: q + 1, r },
      { q: q + 1, r: r - 1 },
      { q, r: r - 1 },
      { q: q - 1, r },
      { q: q - 1, r: r + 1 },
      { q, r: r + 1 },
    ];
  }

  _collectHeightMeshesNear(x, z) {
    const centerFloat = this._worldToAxialFloat(x, z);
    const center = this._axialRound(centerFloat.q, centerFloat.r);
    const coords = [center, ...this._axialNeighbors(center.q, center.r)];
    const meshes = [];
    for (const { q, r } of coords) {
      const tile = this.tiles.get(`${q},${r}`);
      if (tile?.type === 'interactive' && tile.grid?.mesh) meshes.push(tile.grid.mesh);
    }
    if (meshes.length) return meshes;
    if (!this._heightMeshesFallback.length) {
      for (const t of this.tiles.values()) {
        if (t.type === 'interactive' && t.grid?.mesh) this._heightMeshesFallback.push(t.grid.mesh);
      }
    }
    return this._heightMeshesFallback;
  }

  _heightCacheKey(x, z) {
    const scale = this._heightCacheScale;
    const qx = Math.round(x * scale);
    const qz = Math.round(z * scale);
    return `${qx}:${qz}`;
  }

  _invalidateHeightCache() {
    this._heightCache.clear();
    this._heightMeshesFallback.length = 0;
  }

  getHeightAt(x, z) {
    const perfNow = performance?.now ? performance.now.bind(performance) : null;
    const start = perfNow ? perfNow() : Date.now();
    const now = perfNow ? perfNow() : Date.now();
    const key = this._heightCacheKey(x, z);
    const cached = this._heightCache.get(key);
    if (cached && (now - cached.t) < this._heightCacheTTL) {
      return cached.h;
    }

    const tmp = new THREE.Vector3(x, 10000, z);
    const meshes = this._collectHeightMeshesNear(x, z);
    if (!meshes || meshes.length === 0) return this._lastHeight;
    this.ray.set(tmp, this.DOWN);
    const hit = this.ray.intersectObjects(meshes, true);
    let result = this._lastHeight;
    if (hit.length) {
      result = hit[0].point.y;
      this._lastHeight = result;
    }
    this._heightCache.set(key, { h: result, t: now });
    if (this._heightCache.size > 4096) this._heightCache.clear();

    const duration = (perfNow ? perfNow() : Date.now()) - start;
    const logNow = perfNow ? perfNow() : Date.now();
    if ((!this._perfLogNext || logNow >= this._perfLogNext) && duration > 2) {
      console.log(`[tiles.getHeightAt] meshes=${meshes.length} hit=${hit.length > 0} duration=${duration.toFixed(2)}ms`);
      this._perfLogNext = logNow + 2000;
    }
    return result;
  }

  hasInteractiveTerrainAt(x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
    const axialFloat = this._worldToAxialFloat(x, z);
    if (!axialFloat) return false;
    const axial = this._axialRound(axialFloat.q, axialFloat.r);
    const tile = this.tiles.get(`${axial.q},${axial.r}`);
    if (!tile || tile.type !== 'interactive') return false;
    const seedDone = tile._phase?.seedDone;
    if (!seedDone) return false;
    if (!Number.isFinite(tile.unreadyCount)) return true;
    const total = Number.isFinite(tile.pos?.count) ? tile.pos.count : Infinity;
    return tile.unreadyCount < total;
  }

  setRelayAddress(addr) {
    this.relayAddress = (addr || '').trim();
    this.terrainRelay?.setRelayAddress(this.relayAddress);
    if (this._relayStatus) this._relayStatus.address = this.relayAddress || null;
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

  getRelayStatus() {
    const pipeline = this._collectPipelineStats();
    return { ...this._relayStatus, pipeline };
  }

  refreshTiles() {
    this._invalidateHeightCache();
    for (const tile of this.tiles.values()) {
      tile.ready.fill(0);
      tile.fetched.clear();
      tile.unreadyCount = tile.pos.count;
      this._initColorsNearBlack(tile);
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

  invalidateHeightCache() {
    this._invalidateHeightCache();
  }

  /* ---------------- Cleanup ---------------- */

  _discardTile(id) {
    const t = this.tiles.get(id);
    if (!t) return;
    if (t.type === 'farfield') {
      const key = this._farfieldAdapterKey(t);
      if (key) this._farfieldAdapterDirty.delete(key);
    }
    this.scene.remove(t.grid.group);
    try {
      if (t._adapter?.mesh) {
        t._adapter.mesh.geometry?.dispose?.();
      }
      t.grid.geometry?.dispose?.();
      t.grid.mat?.dispose?.();
      t.wire?.material?.dispose?.();
    } catch { }
    t._adapter = null;
    t._adapterDirty = false;
    this._deferredInteractive.delete(t);
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
    this._deferredInteractive.clear();
    this._interactiveSecondPass = false;
    this._farfieldAdapterDirty.clear();
  }

  dispose() {
    if (this._backfillTimer) { clearTimeout(this._backfillTimer); this._backfillTimer = null; }
    if (this._periodicBackfill) { clearInterval(this._periodicBackfill); this._periodicBackfill = null; }
    if (this._rateTicker) { clearInterval(this._rateTicker); this._rateTicker = null; }
    this._resetAllTiles();
    this.tiles.clear();
    if (this._farfieldMat) {
      this._farfieldMat.dispose();
      this._farfieldMat = null;
    }
    this._heightListeners?.clear?.();
  }
}
