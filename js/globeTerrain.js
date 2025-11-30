// globeTerrain.js - Integration layer: Hex tile subdivision on Earth sphere
import * as THREE from 'three';
import { Globe } from './globe.js';
import { metresPerDegree } from './geolocate.js';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';
import { TerrainRelay } from './terrainRelay.js';

// Earth constants
const EARTH_RADIUS = 6371000; // meters

// Hexagonal tile system parameters (from tiles.js)
const HEX_DIRS = [
  [1, 0], [1, -1], [0, -1],
  [-1, 0], [-1, 1], [0, 1]
];

export class GlobeTerrain {
  constructor(scene, opts = {}) {
    this.scene = scene;

    // Globe instance
    this.globe = new Globe(scene, {
      subdivisionLevels: opts.subdivisionLevels || 6,
      localDetailRadius: opts.localDetailRadius || 100000, // 100km
      terrainRelay: null // We'll manage fetching ourselves
    });

    // Terrain relay
    this.terrainRelay = new TerrainRelay({
      defaultRelay: opts.relayAddress || '',
      dataset: opts.dataset || 'mapzen',
      mode: 'geohash',
      onStatus: opts.onStatus || null
    });

    this.globe.terrainRelay = this.terrainRelay;

    // Hexagonal tile parameters (from tiles.js)
    this.spacing = opts.spacing || 20; // meters between points
    this.tileRadius = opts.tileRadius || 100; // meters radius of each hex tile

    // Tile rings (exposed as public properties for app.js compatibility)
    this.INTERACTIVE_RING = 2;  // 2 rings of interactive tiles
    this.VISUAL_RING = 4;       // 4 rings of visual tiles
    this.FARFIELD_RING = 8;     // 8 rings of farfield tiles

    // Fog settings (compatibility with app.js)
    this.FOG_NEAR_PCT = 0.12;
    this.FOG_FAR_PCT = 0.98;

    // Hex tile tracking
    this.hexTiles = new Map(); // Map<"q,r", HexTile>
    this.origin = null; // { lat, lon }
    this._localFrame = null; // Local tangent frame for origin placement

    // Subdivision state
    this.subdividedVertices = new Map(); // Map<vertexIndex, { lat, lon, elevation }>

    // Fetch queue
    this.fetchQueue = [];
    this.fetching = false;

    // Update throttling
    this._lastUpdatePosition = new THREE.Vector3();
    this._updateThreshold = 10; // meters
    this._isUpdating = false; // Prevent recursive updates

    console.log(`[GlobeTerrain] Initialized (spacing: ${this.spacing}m, tileRadius: ${this.tileRadius}m)`);
  }

  // Set origin and create hex tiles
  async setOrigin(lat, lon) {
    this.origin = { lat, lon };
    this.globe.setOrigin(lat, lon);
    this._updateLocalFrame();

    console.log(`[GlobeTerrain] Origin set to ${lat.toFixed(6)}, ${lon.toFixed(6)}`);

    // DISABLED: Old hex tile system - now using surface patch on globe
    // Clear existing tiles
    // this.hexTiles.clear();

    // Create hex tiles around origin
    // this._createHexTiles();

    // Start fetching elevation data
    // await this._fetchAllTiles();
  }

  _createHexTiles() {
    // Create hexagonal tiles in rings around player
    // This determines which areas of the sphere to subdivide

    // Interactive tiles (closest)
    for (let q = -this.INTERACTIVE_RING; q <= this.INTERACTIVE_RING; q++) {
      for (let r = -this.INTERACTIVE_RING; r <= this.INTERACTIVE_RING; r++) {
        if (Math.abs(q + r) <= this.INTERACTIVE_RING) {
          this._createHexTile(q, r, 'interactive');
        }
      }
    }

    // Visual tiles (medium distance)
    for (let q = -this.VISUAL_RING; q <= this.VISUAL_RING; q++) {
      for (let r = -this.VISUAL_RING; r <= this.VISUAL_RING; r++) {
        if (Math.abs(q + r) <= this.VISUAL_RING) {
          const key = `${q},${r}`;
          if (!this.hexTiles.has(key)) {
            this._createHexTile(q, r, 'visual');
          }
        }
      }
    }

    // Farfield tiles (distant)
    for (let q = -this.FARFIELD_RING; q <= this.FARFIELD_RING; q++) {
      for (let r = -this.FARFIELD_RING; r <= this.FARFIELD_RING; r++) {
        if (Math.abs(q + r) <= this.FARFIELD_RING) {
          const key = `${q},${r}`;
          if (!this.hexTiles.has(key)) {
            this._createHexTile(q, r, 'farfield');
          }
        }
      }
    }

    console.log(`[GlobeTerrain] Created ${this.hexTiles.size} hex tiles`);
  }

  _updateLocalFrame() {
    if (!this.origin) {
      this._localFrame = null;
      this.globe.applyLocalFrame(null);
      return;
    }

    const { lat, lon } = this.origin;
    const originVec = this.globe.latLonToSphere(lat, lon, EARTH_RADIUS);
    const up = originVec.clone().normalize();

    const { dLat, dLon } = metresPerDegree(lat);
    const deltaLatDeg = dLat > 0 ? (1 / dLat) : 0;
    const deltaLonDeg = Math.abs(dLon) > 1e-6 ? (1 / dLon) : 0;

    const northSample = this.globe.latLonToSphere(lat + deltaLatDeg, lon, EARTH_RADIUS);
    const northDirSample = northSample.clone().sub(originVec).normalize();

    let eastDir;
    if (deltaLonDeg > 0) {
      const eastSample = this.globe.latLonToSphere(lat, lon + deltaLonDeg, EARTH_RADIUS);
      eastDir = eastSample.clone().sub(originVec).normalize();
    }

    if (!eastDir || eastDir.lengthSq() < 1e-6) {
      eastDir = new THREE.Vector3(0, 1, 0).cross(up);
      if (eastDir.lengthSq() < 1e-6) {
        eastDir = new THREE.Vector3(1, 0, 0).cross(up);
      }
      eastDir.normalize();
    } else {
      eastDir.sub(up.clone().multiplyScalar(eastDir.dot(up))).normalize();
    }

    let northDir = up.clone().cross(eastDir).normalize();
    if (northDir.dot(northDirSample) < 0) northDir.negate();

    this._localFrame = {
      origin: originVec,
      up,
      north: northDir,
      east: eastDir,
      radius: originVec.length()
    };

    this.globe.applyLocalFrame(this._localFrame);
  }

  latLonToLocal(lat, lon, altitude = 0) {
    if (!this._localFrame) return null;
    const radius = EARTH_RADIUS + (Number.isFinite(altitude) ? altitude : 0);
    const spherePos = this.globe.latLonToSphere(lat, lon, radius);
    return this.sphereToLocal(spherePos);
  }

  localToLatLon(x, z, altitude = 0) {
    const spherePos = this.localToSphere(x, z, altitude);
    if (!spherePos) return null;
    return this.globe.sphereToLatLon(spherePos);
  }

  localToSphere(x, z, altitude = 0) {
    if (!this._localFrame) return null;
    const { origin, east, north, up } = this._localFrame;
    const surfaceApprox = origin.clone()
      .addScaledVector(east, Number.isFinite(x) ? x : 0)
      .addScaledVector(north, Number.isFinite(z) ? -z : 0);

    const radius = EARTH_RADIUS + (Number.isFinite(altitude) ? altitude : 0);
    const surfaceDir = surfaceApprox.normalize();
    return surfaceDir.multiplyScalar(radius);
  }

  sphereToLocal(position) {
    if (!this._localFrame || !position) return null;
    const { origin, east, north, up } = this._localFrame;
    const delta = position.clone().sub(origin);
    const x = delta.dot(east);
    const z = -delta.dot(north);
    const y = delta.dot(up);
    return { x, y, z };
  }

  getLocalFrame() {
    if (!this._localFrame) return null;
    const { origin, east, north, up } = this._localFrame;
    return {
      origin: origin.clone(),
      east: east.clone(),
      north: north.clone(),
      up: up.clone()
    };
  }

  _createHexTile(q, r, type) {
    const key = `${q},${r}`;

    // Calculate tile center in world space (flat approximation first)
    const tileSpacing = this.tileRadius * 1.5;
    const x = tileSpacing * (3/2 * q);
    const z = tileSpacing * (Math.sqrt(3) * (r + q/2));

    // Convert to lat/lon offset from origin
    const { lat: centerLat, lon: centerLon } = this._xyToLatLon(x, z);

    // Generate hexagonal points for this tile
    const points = this._generateHexPoints(centerLat, centerLon, type);

    const tile = {
      q, r, type, key,
      centerLat, centerLon,
      points, // Array of { lat, lon, vertexIndex }
      fetched: false,
      elevations: new Map() // Map<pointIndex, elevation>
    };

    this.hexTiles.set(key, tile);
    return tile;
  }

  _generateHexPoints(centerLat, centerLon, type) {
    // Generate hexagonal grid of points for this tile
    // Point density depends on tile type

    const pointsPerSide = type === 'interactive' ? 20 : (type === 'visual' ? 10 : 5);
    const points = [];

    // Hexagonal grid centered on centerLat, centerLon
    const radius = this.tileRadius;
    const spacing = this.spacing;

    // Simple grid for now - can be optimized to true hex pattern
    const gridSize = Math.ceil(radius / spacing);

    for (let dx = -gridSize; dx <= gridSize; dx++) {
      for (let dz = -gridSize; dz <= gridSize; dz++) {
        const x = dx * spacing;
        const z = dz * spacing;

        // Check if point is within hex radius
        if (Math.sqrt(x * x + z * z) <= radius) {
          const { lat, lon } = this._xyOffsetLatLon(centerLat, centerLon, x, z);
          points.push({ lat, lon, vertexIndex: null }); // vertexIndex set later
        }
      }
    }

    return points;
  }

  _xyToLatLon(x, z) {
    const precise = this.localToLatLon(x, z);
    if (precise) return precise;

    if (!this.origin) return { lat: 0, lon: 0 };
    const latOffset = (z / EARTH_RADIUS) * (180 / Math.PI);
    const lonOffsetDenom = Math.cos(this.origin.lat * Math.PI / 180) * EARTH_RADIUS;
    const lonOffset = lonOffsetDenom !== 0 ? (x / lonOffsetDenom) * (180 / Math.PI) : 0;
    return {
      lat: this.origin.lat + latOffset,
      lon: this.origin.lon + lonOffset
    };
  }

  _xyOffsetLatLon(centerLat, centerLon, x, z) {
    const baseLocal = this.latLonToLocal(centerLat, centerLon);
    if (baseLocal) {
      const targetLatLon = this.localToLatLon(baseLocal.x + x, baseLocal.z + z);
      if (targetLatLon) return targetLatLon;
    }

    const latOffset = (z / EARTH_RADIUS) * (180 / Math.PI);
    const lonOffsetDenom = Math.cos(centerLat * Math.PI / 180) * EARTH_RADIUS;
    const lonOffset = lonOffsetDenom !== 0 ? (x / lonOffsetDenom) * (180 / Math.PI) : 0;
    return {
      lat: centerLat + latOffset,
      lon: centerLon + lonOffset
    };
  }

  async _fetchAllTiles() {
    // Collect all points from all tiles
    const allPoints = [];

    for (const tile of this.hexTiles.values()) {
      tile.points.forEach((point, idx) => {
        allPoints.push({ tile, pointIdx: idx, lat: point.lat, lon: point.lon });
      });
    }

    console.log(`[GlobeTerrain] Fetching elevation for ${allPoints.length} points`);

    // Fetch in batches
    await this._fetchElevationBatch(allPoints);

    // Apply elevations to sphere
    this._applyElevationsToSphere();
  }

  async _fetchElevationBatch(points) {
    const batchSize = 100;
    const batches = [];

    for (let i = 0; i < points.length; i += batchSize) {
      batches.push(points.slice(i, i + batchSize));
    }

    console.log(`[GlobeTerrain] Processing ${batches.length} batches`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      await this._processBatch(batch);

      // Progress logging
      if ((i + 1) % 10 === 0) {
        console.log(`[GlobeTerrain] Processed ${i + 1}/${batches.length} batches`);
      }
    }

    console.log(`[GlobeTerrain] ✓ All batches complete`);
  }

  async _processBatch(points) {
    // Build query payload (use geohash mode)
    const geohashes = points.map(p =>
      geohashEncode(p.lat, p.lon, pickGeohashPrecision(this.spacing))
    );

    const payload = {
      type: 'elev.query',
      dataset: 'mapzen',
      geohashes: geohashes,
      enc: 'geohash',
      prec: pickGeohashPrecision(this.spacing)
    };

    try {
      const result = await this.terrainRelay.queryBatch(
        this.terrainRelay.relayAddress,
        payload,
        15000
      );

      if (result && result.results) {
        // Store elevations in tiles
        for (let i = 0; i < points.length && i < result.results.length; i++) {
          const point = points[i];
          const elevation = result.results[i]?.elevation || 0;

          // Store in tile
          point.tile.elevations.set(point.pointIdx, elevation);
        }
      }
    } catch (err) {
      console.error('[GlobeTerrain] Batch fetch failed:', err);
      // Set elevations to 0 for failed points
      points.forEach(p => p.tile.elevations.set(p.pointIdx, 0));
    }
  }

  _applyElevationsToSphere() {
    // Find nearest sphere vertices for each hex point and apply elevation
    const geometry = this.globe.baseMesh.geometry;
    const positions = geometry.attributes.position;

    let applied = 0;

    for (const tile of this.hexTiles.values()) {
      for (let i = 0; i < tile.points.length; i++) {
        const point = tile.points[i];
        const elevation = tile.elevations.get(i) || 0;

        // Get sphere position for this lat/lon
        const spherePos = this.globe.latLonToSphere(point.lat, point.lon);

        // Find nearest vertex in sphere geometry
        const vertexIndex = this._findNearestVertex(spherePos, positions);

        if (vertexIndex !== -1) {
          // Apply elevation (move vertex radially)
          const elevated = spherePos.clone().normalize()
            .multiplyScalar(EARTH_RADIUS + elevation);

          positions.setXYZ(vertexIndex, elevated.x, elevated.y, elevated.z);
          point.vertexIndex = vertexIndex;
          applied++;
        }
      }
      tile.fetched = true;
    }

    // Update geometry
    positions.needsUpdate = true;
    geometry.computeVertexNormals();

    console.log(`[GlobeTerrain] ✓ Applied ${applied} elevations to sphere vertices`);
  }

  _findNearestVertex(targetPos, positions) {
    // Find the nearest vertex in the sphere geometry to the target position
    let minDist = Infinity;
    let nearestIdx = -1;

    const vertex = new THREE.Vector3();

    for (let i = 0; i < positions.count; i++) {
      vertex.fromBufferAttribute(positions, i);
      const dist = vertex.distanceToSquared(targetPos);

      if (dist < minDist) {
        minDist = dist;
        nearestIdx = i;
      }
    }

    return nearestIdx;
  }

  // Update system (called each frame)
  update(playerWorldPosition) {
    // Prevent recursive updates - CRITICAL!
    if (this._isUpdating) {
      return;
    }

    // Early exit if player hasn't moved enough - CRITICAL for performance!
    const distanceMoved = playerWorldPosition.distanceTo(this._lastUpdatePosition);
    if (distanceMoved < this._updateThreshold) {
      return; // Don't do expensive operations every frame
    }

    this._isUpdating = true;
    this._lastUpdatePosition.copy(playerWorldPosition);

    try {
      // DISABLED: Globe surface positioning causing infinite feedback loop
      // The player position changes cause re-subdivision which changes position again
      // For now, just update the surface patch without repositioning
      if (this.globe.surfacePatch) {
        this.globe.surfacePatch.updateFromPlayerPosition(playerWorldPosition);
      }
    } finally {
      this._isUpdating = false;
    }
  }

  /**
   * Get the position where the player should be attached to the globe surface
   * This accounts for globe geometry + elevation data
   * @param {THREE.Vector3} currentPlayerPos - Current player world position
   * @param {number} eyeHeight - Player's eye height (default 1.6m)
   * @returns {THREE.Vector3|null} - Position on globe surface, or null if can't determine
   */
  getSurfacePositionForPlayer(currentPlayerPos, eyeHeight = 1.6) {
    return this.globe.getSurfacePositionUnderPlayer(currentPlayerPos, eyeHeight);
  }

  /**
   * Get surface normal at player position for orientation
   * @param {THREE.Vector3} playerPos - Player world position
   * @returns {THREE.Vector3|null} - Surface normal (up direction), or null
   */
  getSurfaceNormal(playerPos) {
    if (!this.globe.surfacePatch) return null;

    const surfacePoint = this.globe.surfacePatch._findSurfacePoint(playerPos);
    if (!surfacePoint) return null;

    // Surface normal points from Earth center to surface
    return surfacePoint.clone().normalize();
  }

  // Get stats
  getStats() {
    const globeStats = this.globe.getStats();
    return {
      ...globeStats,
      hexTiles: this.hexTiles.size,
      origin: this.origin
    };
  }

  // Compatibility method for app.js - returns terrain settings
  getTerrainSettings() {
    return {
      spacing: this.spacing,
      tileRadius: this.tileRadius,
      horizonOuterRadius: EARTH_RADIUS,
      farfieldRing: this.FARFIELD_RING,
      fogNearPct: this.FOG_NEAR_PCT,
      fogFarPct: this.FOG_FAR_PCT
    };
  }

  // Compatibility method for app.js - get height at world XZ coordinates
  getHeightAt(x, z) {
    // In globe system, x/z are local coordinates relative to origin
    // We need to convert them to lat/lon, then get elevation
    if (!this.origin) return 0;

    const { lat, lon } = this._xyToLatLon(x, z);
    return this.globe.getElevationAt(lat, lon);
  }

  // Compatibility method for app.js - set relay address
  setRelayAddress(address) {
    if (this.terrainRelay) {
      this.terrainRelay.relayAddress = address;
    }
  }

  // Compatibility method for app.js - set dataset
  setRelayDataset(dataset) {
    if (this.terrainRelay) {
      this.terrainRelay.dataset = dataset;
    }
  }

  // Compatibility method for app.js - refresh tiles (re-fetch elevations)
  async refreshTiles() {
    if (this.origin) {
      await this.setOrigin(this.origin.lat, this.origin.lon);
    }
  }

  // Compatibility method for app.js - get relay address
  get relayAddress() {
    return this.terrainRelay?.relayAddress || '';
  }

  // Compatibility method for app.js - get relay dataset
  get relayDataset() {
    return this.terrainRelay?.dataset || 'mapzen';
  }

  // Compatibility method for app.js - get relay mode
  get relayMode() {
    return this.terrainRelay?.mode || 'geohash';
  }

  // Compatibility method for app.js - set relay mode
  setRelayMode(mode) {
    if (this.terrainRelay) {
      this.terrainRelay.mode = mode;
    }
  }

  // Dispose
  dispose() {
    this.hexTiles.clear();
    this.globe.dispose();
  }
}
