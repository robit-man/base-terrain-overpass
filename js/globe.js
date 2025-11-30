// globe.js - Earth-sized sphere with geographically-accurate terrain
import * as THREE from 'three';
import { geohashEncode } from './geohash.js';
import { TerrainRelay } from './terrainRelay.js';
import { SurfacePatch } from './surfacePatch.js';

// Earth constants (WGS84)
const EARTH_RADIUS_METERS = 6371000; // Mean radius in meters
const EARTH_EQUATORIAL_RADIUS = 6378137; // Equatorial radius
const EARTH_POLAR_RADIUS = 6356752; // Polar radius

// 1 Three.js unit = 1 meter
const GLOBE_RADIUS = EARTH_RADIUS_METERS;

export class Globe {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.origin = null; // { lat, lon } - player position
    this.playerPosition = new THREE.Vector3(0, 0, 0); // Player's world position

    // Configuration
    this.subdivisionLevels = opts.subdivisionLevels || 5; // Icosahedron subdivisions
    this.localDetailRadius = opts.localDetailRadius || 50000; // 50km radius for high detail
    this.terrainRelay = opts.terrainRelay || null;

    // Globe mesh
    this.globeGroup = new THREE.Group();
    this.globeGroup.matrixAutoUpdate = false;
    this.globeGroup.matrix.identity();
    this.globeGroup.updateMatrixWorld(true);
    this.scene.add(this.globeGroup);
    this.currentFrame = null;

    // Terrain patches (subdivided surface areas)
    this.patches = new Map(); // Map<patchId, PatchData>
    this.patchQueue = []; // Patches pending elevation fetch

    // Elevation cache
    this.elevationCache = new Map(); // Map<geohash, elevation>

    // Surface patch system for local terrain detail
    // Uses raycast-based approach to sample globe surface
    this.surfacePatch = new SurfacePatch(this, {
      patchRadius: opts.patchRadius || 1000,  // 1km radius patch (conservative for stability)
      pointSpacing: opts.pointSpacing || 20,  // 20m spacing (reduces point count)
      updateThreshold: opts.updateThreshold || 100 // 100m movement before update
    });

    // Create base icosahedron sphere
    this._createBaseSphere();

    // Metrics
    this.stats = {
      patches: 0,
      vertices: 0,
      elevationsFetched: 0,
      cacheHits: 0
    };
  }

  _createBaseSphere() {
    // Create icosahedron geometry at Earth scale
    const geometry = new THREE.IcosahedronGeometry(GLOBE_RADIUS, this.subdivisionLevels);

    // Add equirectangular UVs for texture mapping
    this._addEquirectUVs(geometry);

    // Create material (basic for now, can add textures later)
    const material = new THREE.MeshStandardMaterial({
      color: 0x365f9d,
      roughness: 0.85,
      metalness: 0.04,
      emissive: new THREE.Color(0x0a1d33),
      emissiveIntensity: 0.35,
      wireframe: false
    });

    this.baseMesh = new THREE.Mesh(geometry, material);
    this.baseMesh.frustumCulled = false;
    this.baseMesh.receiveShadow = true;
    this.globeGroup.add(this.baseMesh);

    const vertexCount = geometry.attributes.position?.count ?? 0;
    const faceCount = geometry.index ? geometry.index.count / 3 : vertexCount / 3;
    console.log(`[Globe] Base sphere created: ${vertexCount} vertices, ${faceCount} faces`);
  }

  _addEquirectUVs(geometry) {
    // Add UV coordinates based on spherical position
    // This allows texture mapping to work correctly
    const pos = geometry.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    const p = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      p.fromBufferAttribute(pos, i).normalize();

      // Convert to UV coordinates (equirectangular projection)
      let u = (Math.atan2(p.z, -p.x) + Math.PI) / (2 * Math.PI);
      const v = 1.0 - (Math.acos(THREE.MathUtils.clamp(p.y, -1, 1)) / Math.PI);

      uv[i * 2 + 0] = u;
      uv[i * 2 + 1] = v;
    }

    geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }

  // Convert lat/lon to 3D position on sphere surface
  latLonToSphere(lat, lon, radius = GLOBE_RADIUS) {
    const phi = THREE.MathUtils.degToRad(90 - lat);
    const theta = THREE.MathUtils.degToRad(lon + 180);

    const x = -radius * Math.sin(phi) * Math.cos(theta);
    const z = radius * Math.sin(phi) * Math.sin(theta);
    const y = radius * Math.cos(phi);

    return new THREE.Vector3(x, y, z);
  }

  /**
   * Convert lat/lon to 3D position on globe surface WITH elevation
   * This looks up elevation data and positions object on the actual terrain
   * @param {number} lat - Latitude in degrees
   * @param {number} lon - Longitude in degrees
   * @param {number} heightAboveGround - Height above terrain (default 0)
   * @returns {THREE.Vector3} - Position on globe surface + elevation + height
   */
  latLonToSurfaceWithElevation(lat, lon, heightAboveGround = 0) {
    // Get base sphere position
    const basePos = this.latLonToSphere(lat, lon);

    // Try to get elevation from surface patch cache
    let elevation = 0;

    if (this.surfacePatch && this.surfacePatch.patchPoints.size > 0) {
      let minDist = Infinity;

      // Find closest patch point to get elevation
      this.surfacePatch.patchPoints.forEach((point) => {
        const dist = basePos.distanceTo(point.surfacePos);
        if (dist < minDist && point.elevation !== null) {
          minDist = dist;
          elevation = point.elevation;
        }
      });
    }

    // Apply elevation + height radially from Earth center
    const direction = basePos.clone().normalize();
    const finalRadius = GLOBE_RADIUS + elevation + heightAboveGround;
    return direction.multiplyScalar(finalRadius);
  }

  // Convert 3D position to lat/lon
  sphereToLatLon(position) {
    const normalized = position.clone().normalize();

    const phi = Math.acos(THREE.MathUtils.clamp(normalized.y, -1, 1));
    const lat = 90 - THREE.MathUtils.radToDeg(phi);

    const theta = Math.atan2(normalized.z, -normalized.x);
    let lon = THREE.MathUtils.radToDeg(theta) - 180;
    lon = ((lon + 540) % 360) - 180;

    return { lat, lon };
  }

  // Set player origin (where they are on Earth)
  setOrigin(lat, lon) {
    this.origin = { lat, lon };

    // Calculate player's position on sphere surface
    this.playerPosition = this.latLonToSphere(lat, lon);

    // Initialize surface patch with terrain relay
    if (this.surfacePatch && this.terrainRelay) {
      this.surfacePatch.setTerrainRelay(this.terrainRelay);
    }

    // Update surface patch based on player position
    if (this.surfacePatch) {
      this.surfacePatch.updateFromPlayerPosition(this.playerPosition);
    }

    // DISABLED: Legacy subdivision system - now using surface patch
    // this._subdivideLocalArea();

    console.log(`[Globe] Origin set to ${lat.toFixed(6)}, ${lon.toFixed(6)}`);
  }

  _subdivideLocalArea() {
    // Find all vertices within localDetailRadius of player
    // These will be subdivided and have elevation fetched

    const geometry = this.baseMesh.geometry;
    const positions = geometry.attributes.position;
    const localVertices = [];

    for (let i = 0; i < positions.count; i++) {
      const vertex = new THREE.Vector3().fromBufferAttribute(positions, i);
      const distance = vertex.distanceTo(this.playerPosition);

      if (distance <= this.localDetailRadius) {
        const { lat, lon } = this.sphereToLatLon(vertex);
        localVertices.push({ index: i, lat, lon, vertex: vertex.clone() });
      }
    }

    console.log(`[Globe] Found ${localVertices.length} vertices within ${this.localDetailRadius}m of player`);

    // Fetch elevation for local vertices
    this._fetchElevationBatch(localVertices);
  }

  applyLocalFrame(frame) {
    // Always keep the globe centered at world origin - only store frame metadata
    this.currentFrame = frame ? {
      origin: frame.origin.clone(),
      east: frame.east.clone(),
      north: frame.north.clone(),
      up: frame.up.clone()
    } : null;

    this.globeGroup.position.set(0, 0, 0);
    this.globeGroup.quaternion.identity();
    this.globeGroup.scale.set(1, 1, 1);
    this.globeGroup.matrix.identity();
    this.globeGroup.matrixAutoUpdate = false;
    this.globeGroup.updateMatrixWorld(true);
  }

  async _fetchElevationBatch(vertices) {
    if (!this.terrainRelay) {
      console.warn('[Globe] No terrain relay configured');
      return;
    }

    // Group vertices into batches
    const batchSize = 100;
    const batches = [];

    for (let i = 0; i < vertices.length; i += batchSize) {
      batches.push(vertices.slice(i, i + batchSize));
    }

    console.log(`[Globe] Fetching elevation for ${vertices.length} vertices in ${batches.length} batches`);

    // Process batches
    for (const batch of batches) {
      await this._processBatch(batch);
    }
  }

  async _processBatch(vertices) {
    // Build query payload
    const locations = vertices.map(v => ({ lat: v.lat, lng: v.lon }));

    const payload = {
      type: 'elev.query',
      dataset: 'mapzen',
      locations: locations,
      enc: 'latlng'
    };

    try {
      const result = await this.terrainRelay.queryBatch(
        this.terrainRelay.relayAddress,
        payload,
        15000
      );

      if (result && result.results) {
        this._applyElevationResults(vertices, result.results);
      }
    } catch (err) {
      console.error('[Globe] Elevation fetch failed:', err);
    }
  }

  _applyElevationResults(vertices, results) {
    const geometry = this.baseMesh.geometry;
    const positions = geometry.attributes.position;
    let updated = 0;

    for (let i = 0; i < vertices.length && i < results.length; i++) {
      const vertex = vertices[i];
      const result = results[i];

      if (result && typeof result.elevation === 'number') {
        const elevation = result.elevation; // meters

        // Cache elevation
        const geohash = geohashEncode(vertex.lat, vertex.lon, 9);
        this.elevationCache.set(geohash, elevation);

        // Apply elevation: move vertex radially outward from Earth center
        // New radius = base radius + elevation
        const direction = vertex.vertex.clone().normalize();
        const newPosition = direction.multiplyScalar(GLOBE_RADIUS + elevation);

        positions.setXYZ(vertex.index, newPosition.x, newPosition.y, newPosition.z);
        updated++;
      }
    }

    if (updated > 0) {
      // Mark geometry for update
      positions.needsUpdate = true;

      // Recompute normals for proper lighting
      geometry.computeVertexNormals();

      this.stats.elevationsFetched += updated;
      console.log(`[Globe] Applied ${updated} elevations (total: ${this.stats.elevationsFetched})`);
    }
  }

  // Update player position and subdivide as needed
  updatePlayerPosition(worldPosition) {
    // Convert world position to lat/lon
    const { lat, lon } = this.sphereToLatLon(worldPosition);

    // Update surface patch (handles frequent updates efficiently via throttling)
    if (this.surfacePatch) {
      this.surfacePatch.updateFromPlayerPosition(worldPosition);
    }

    // Check if we need to re-subdivide (player moved significantly)
    if (this.origin) {
      const distance = this._haversineDistance(
        this.origin.lat, this.origin.lon,
        lat, lon
      );

      // Re-subdivide if player moved > 10km
      if (distance > 10000) {
        this.setOrigin(lat, lon);
      }
    } else {
      this.setOrigin(lat, lon);
    }
  }

  _haversineDistance(lat1, lon1, lat2, lon2) {
    // Calculate great circle distance between two points
    const R = EARTH_RADIUS_METERS;
    const φ1 = THREE.MathUtils.degToRad(lat1);
    const φ2 = THREE.MathUtils.degToRad(lat2);
    const Δφ = THREE.MathUtils.degToRad(lat2 - lat1);
    const Δλ = THREE.MathUtils.degToRad(lon2 - lon1);

    const a = Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
  }

  // Get elevation at a specific lat/lon (from cache or estimate)
  getElevationAt(lat, lon) {
    const geohash = geohashEncode(lat, lon, 9);

    if (this.elevationCache.has(geohash)) {
      this.stats.cacheHits++;
      return this.elevationCache.get(geohash);
    }

    // No cached elevation - return 0 (sea level)
    return 0;
  }

  // Position camera to look at player on sphere
  positionCamera(camera) {
    if (!this.origin) return;

    const playerOnSphere = this.latLonToSphere(this.origin.lat, this.origin.lon);

    // Position camera at player position + offset
    const offset = playerOnSphere.clone().normalize().multiplyScalar(100); // 100m above surface
    camera.position.copy(playerOnSphere).add(offset);

    // Look at a point slightly ahead on the surface
    const forward = playerOnSphere.clone().normalize();
    const lookAt = playerOnSphere.clone().add(forward.multiplyScalar(50));
    camera.lookAt(lookAt);
  }

  /**
   * Get the globe surface position directly under a world position
   * Uses raycast to find intersection with globe, then adds elevation offset
   * @param {THREE.Vector3} worldPosition - Player's current world position
   * @param {number} eyeHeight - Player's eye height above ground (default: 1.6m)
   * @returns {THREE.Vector3|null} - Position on globe surface + elevation + eyeHeight, or null if no intersection
   */
  getSurfacePositionUnderPlayer(worldPosition, eyeHeight = 1.6) {
    if (!this.baseMesh || !this.surfacePatch) return null;

    // Use surface patch's raycast to find surface point
    const surfacePoint = this.surfacePatch._findSurfacePoint(worldPosition);

    if (!surfacePoint) {
      return null;
    }

    // Try to get elevation from surface patch cache
    let elevation = 0;
    let minDist = Infinity;

    // Find closest patch point to get elevation
    this.surfacePatch.patchPoints.forEach((point) => {
      const dist = surfacePoint.distanceTo(point.surfacePos);
      if (dist < minDist && point.elevation !== null) {
        minDist = dist;
        elevation = point.elevation;
      }
    });

    // Calculate position on surface with elevation + eye height
    const direction = surfacePoint.clone().normalize();
    const finalPosition = direction.multiplyScalar(GLOBE_RADIUS + elevation + eyeHeight);

    return finalPosition;
  }

  // Get stats
  getStats() {
    const patchStats = this.surfacePatch ? this.surfacePatch.getStats() : null;
    return {
      ...this.stats,
      patches: this.patches.size,
      cacheSize: this.elevationCache.size,
      surfacePatch: patchStats
    };
  }

  // Dispose
  dispose() {
    if (this.baseMesh) {
      this.baseMesh.geometry.dispose();
      this.baseMesh.material.dispose();
      this.globeGroup.remove(this.baseMesh);
    }

    if (this.surfacePatch) {
      this.surfacePatch.dispose();
    }
    this.patches.clear();
    this.elevationCache.clear();
  }
}
