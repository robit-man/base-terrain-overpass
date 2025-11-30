// voronoiLOD.js - Adaptive Voronoi-based LOD system for terrain detail
import * as THREE from 'three';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';
import { DynamicGeometry } from './dynamicGeometry.js';
import { LODBlending } from './lodBlending.js';

const EARTH_RADIUS = 6371000; // meters

/**
 * VoronoiLOD: Progressive level-of-detail system using sparse Voronoi sampling
 *
 * Creates a distance-based distribution of sample points on the globe surface:
 * - Very high density near player (flush with local terrain)
 * - Progressively lower density with distance
 * - Sparse sampling at far distances
 */
export class VoronoiLOD {
  constructor(globe, opts = {}) {
    this.globe = globe;

    // LOD configuration - distance rings from player
    this.lodLevels = opts.lodLevels || [
      { maxDistance: 100, spacing: 2 },      // Ultra-high detail: 2m spacing (flush with character)
      { maxDistance: 500, spacing: 5 },      // Very high detail: 5m spacing
      { maxDistance: 2000, spacing: 20 },    // High detail: 20m spacing
      { maxDistance: 10000, spacing: 100 },  // Medium detail: 100m spacing
      { maxDistance: 50000, spacing: 500 },  // Low detail: 500m spacing
      { maxDistance: 200000, spacing: 2000 } // Very low detail: 2km spacing
    ];

    // Voronoi sampling state
    this.voronoiPoints = new Map(); // Map<pointId, VoronoiPoint>
    this.pointElevations = new Map(); // Map<pointId, elevation>
    this.playerPosition = new THREE.Vector3();
    this.playerLatLon = null;

    // Dynamic vertex management
    this.dynamicGeometry = null; // Will be initialized when globe mesh is ready
    this.addedVertices = new Map(); // Map<pointId, vertexIndex>
    this.baseVertexCount = 0; // Original sphere vertex count

    // Mode: 'nearest' uses nearest-vertex, 'dynamic' adds new vertices
    this.mode = opts.mode || 'nearest'; // 'nearest' is simpler and more stable initially

    // Update throttling
    this.lastUpdatePosition = new THREE.Vector3();
    this.updateThreshold = opts.updateThreshold || 50; // meters - minimum movement before update (increased from 10m for performance)

    // Fetch queue
    this.fetchQueue = [];
    this.fetching = false;
    this.terrainRelay = null;

    // Update guards
    this._isUpdatingGeometry = false;

    // LOD blending for smooth transitions
    this.lodBlending = new LODBlending({
      blendZoneWidth: opts.blendZoneWidth || 50, // 50m blend zones
      morphingEnabled: opts.morphingEnabled !== false
    });

    console.log('[VoronoiLOD] Initialized with', this.lodLevels.length, 'LOD levels');
  }

  /**
   * Set terrain relay for elevation fetching
   */
  setTerrainRelay(relay) {
    this.terrainRelay = relay;
  }

  /**
   * Update player position and regenerate Voronoi distribution
   */
  updatePlayerPosition(worldPosition, latLon) {
    // Quick early exit if position barely changed
    const distanceMoved = worldPosition.distanceTo(this.lastUpdatePosition);
    if (distanceMoved < this.updateThreshold && this.voronoiPoints.size > 0) {
      return; // Don't update yet - saves a lot of CPU
    }

    this.playerPosition.copy(worldPosition);
    this.playerLatLon = latLon;
    this.lastUpdatePosition.copy(this.playerPosition);

    // Regenerate Voronoi point distribution (expensive!)
    this._generateVoronoiDistribution();
  }

  /**
   * Generate sparse Voronoi point distribution around player
   * Uses Poisson disk sampling for even spacing at each LOD level
   */
  _generateVoronoiDistribution() {
    const newPoints = new Map();
    const startTime = performance.now();

    // For each LOD level, generate points in an annular ring
    for (let i = 0; i < this.lodLevels.length; i++) {
      const level = this.lodLevels[i];
      const prevMaxDistance = i > 0 ? this.lodLevels[i - 1].maxDistance : 0;

      // Generate points in this ring
      const ringPoints = this._generateRingPoints(
        prevMaxDistance,
        level.maxDistance,
        level.spacing
      );

      const nextLevel = i < this.lodLevels.length - 1 ? this.lodLevels[i + 1] : null;

      ringPoints.forEach(point => {
        const id = this._getPointId(point.lat, point.lon, level.spacing);

        // Apply LOD blending - fade out points near boundaries
        const shouldInclude = this.lodBlending.shouldIncludePoint(
          point.distance,
          level,
          nextLevel,
          id
        );

        if (shouldInclude) {
          newPoints.set(id, {
            ...point,
            lodLevel: i,
            spacing: level.spacing,
            id,
            nextLodLevel: nextLevel
          });
        }
      });
    }

    const elapsed = performance.now() - startTime;
    console.log(`[VoronoiLOD] Generated ${newPoints.size} points in ${elapsed.toFixed(1)}ms`);

    // Identify new points that need elevation data
    const pointsNeedingFetch = [];
    newPoints.forEach((point, id) => {
      if (!this.pointElevations.has(id)) {
        pointsNeedingFetch.push(point);
      }
    });

    // Update points
    this.voronoiPoints = newPoints;

    // Fetch elevations for new points
    if (pointsNeedingFetch.length > 0) {
      console.log(`[VoronoiLOD] Fetching elevation for ${pointsNeedingFetch.length} new points`);
      this._fetchElevations(pointsNeedingFetch);
    }

    // Apply current elevations to geometry
    this._updateGeometry();
  }

  /**
   * Generate points in an annular ring around player
   */
  _generateRingPoints(innerRadius, outerRadius, spacing) {
    const points = [];

    if (!this.playerLatLon) return points;

    const { lat: centerLat, lon: centerLon } = this.playerLatLon;

    // Calculate approximate number of points needed
    const ringArea = Math.PI * (outerRadius * outerRadius - innerRadius * innerRadius);
    const pointArea = spacing * spacing * 2; // Increase spacing factor for performance
    const estimatedPoints = Math.ceil(ringArea / pointArea);

    // Hard cap to prevent excessive point generation
    const maxPoints = 5000; // Cap per ring
    const actualPoints = Math.min(estimatedPoints, maxPoints);

    // Use Fibonacci spiral for even distribution
    const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~137.5 degrees

    for (let i = 0; i < actualPoints; i++) {
      // Fibonacci spiral: even distribution in annular region
      const radiusFraction = Math.sqrt((i + 0.5) / actualPoints);
      const radius = innerRadius + radiusFraction * (outerRadius - innerRadius);
      const angle = i * goldenAngle;

      // Convert polar to Cartesian offset
      const dx = radius * Math.cos(angle);
      const dz = radius * Math.sin(angle);

      // Convert offset to lat/lon
      const point = this._offsetLatLon(centerLat, centerLon, dx, dz);

      if (point) {
        points.push({
          lat: point.lat,
          lon: point.lon,
          distance: radius
        });
      }
    }

    return points;
  }

  /**
   * Convert XZ offset from center to lat/lon
   */
  _offsetLatLon(centerLat, centerLon, dx, dz) {
    // Use globe's coordinate conversion if available
    if (this.globe.latLonToSphere && this.globe.sphereToLatLon) {
      const centerPos = this.globe.latLonToSphere(centerLat, centerLon);

      // Get local tangent frame
      const up = centerPos.clone().normalize();
      const east = new THREE.Vector3(0, 1, 0).cross(up);
      if (east.lengthSq() < 1e-6) {
        east.set(1, 0, 0).cross(up);
      }
      east.normalize();
      const north = up.clone().cross(east).normalize();

      // Apply offset in local frame
      const offsetPos = centerPos.clone()
        .addScaledVector(east, dx)
        .addScaledVector(north, -dz);

      // Project back to sphere surface
      const surfacePos = offsetPos.normalize().multiplyScalar(EARTH_RADIUS);

      return this.globe.sphereToLatLon(surfacePos);
    }

    // Fallback: simple lat/lon offset
    const latOffset = (dz / EARTH_RADIUS) * (180 / Math.PI);
    const lonOffset = (dx / (EARTH_RADIUS * Math.cos(centerLat * Math.PI / 180))) * (180 / Math.PI);

    return {
      lat: centerLat + latOffset,
      lon: centerLon + lonOffset
    };
  }

  /**
   * Generate unique ID for a point based on its location and spacing
   */
  _getPointId(lat, lon, spacing) {
    // Use geohash at appropriate precision for the spacing
    const precision = Math.max(5, Math.min(12, pickGeohashPrecision(spacing)));
    return geohashEncode(lat, lon, precision);
  }

  /**
   * Fetch elevations for points
   */
  async _fetchElevations(points) {
    if (!this.terrainRelay) {
      console.warn('[VoronoiLOD] No terrain relay configured');
      return;
    }

    // Add to queue
    this.fetchQueue.push(...points);

    // Start processing if not already running
    if (!this.fetching) {
      this._processFetchQueue();
    }
  }

  /**
   * Process fetch queue in batches
   */
  async _processFetchQueue() {
    this.fetching = true;

    const batchSize = 100;

    while (this.fetchQueue.length > 0) {
      const batch = this.fetchQueue.splice(0, batchSize);

      const locations = batch.map(p => ({ lat: p.lat, lng: p.lon }));

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
          // Store elevations
          for (let i = 0; i < batch.length && i < result.results.length; i++) {
            const point = batch[i];
            const elevation = result.results[i]?.elevation || 0;
            this.pointElevations.set(point.id, elevation);
          }

          // Update geometry with new elevations
          this._updateGeometry();
        }
      } catch (err) {
        console.error('[VoronoiLOD] Elevation fetch failed:', err);

        // Set failed points to 0 elevation
        batch.forEach(p => {
          if (!this.pointElevations.has(p.id)) {
            this.pointElevations.set(p.id, 0);
          }
        });
      }

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.fetching = false;
  }

  /**
   * Update globe geometry with Voronoi point elevations
   * Uses dynamic vertex insertion and Delaunay triangulation
   */
  _updateGeometry() {
    if (!this.globe.baseMesh) return;

    // Prevent recursive/concurrent geometry updates
    if (this._isUpdatingGeometry) return;

    this._isUpdatingGeometry = true;

    try {
      const geometry = this.globe.baseMesh.geometry;

      // Store original vertex count on first call
      if (this.baseVertexCount === 0) {
        this.baseVertexCount = geometry.attributes.position.count;
      }

      // Initialize dynamic geometry if in dynamic mode
      if (this.mode === 'dynamic' && !this.dynamicGeometry) {
        this.dynamicGeometry = new DynamicGeometry(geometry);
      }

      // Choose update method based on mode
      if (this.mode === 'dynamic' && this.dynamicGeometry) {
        this._applyElevationsWithDynamicVertices();
      } else {
        // Default: modify existing vertices (simpler, more stable)
        this._applyElevationsToNearestVertices();
      }
    } finally {
      this._isUpdatingGeometry = false;
    }
  }

  /**
   * Apply Voronoi point elevations to nearest sphere vertices
   */
  _applyElevationsToNearestVertices() {
    const geometry = this.globe.baseMesh.geometry;
    const positions = geometry.attributes.position;

    // Build a map of which vertices should be updated
    const vertexUpdates = new Map(); // Map<vertexIndex, elevation>

    // Limit how many points we process per update for performance
    const maxPointsToProcess = 1000;
    let processedCount = 0;

    for (const [id, point] of this.voronoiPoints.entries()) {
      if (processedCount >= maxPointsToProcess) break;

      const elevation = this.pointElevations.get(id);
      if (typeof elevation !== 'number') continue;

      // Get sphere position for this point
      const spherePos = this.globe.latLonToSphere(point.lat, point.lon);

      // Find nearest vertex (expensive!)
      const vertexIndex = this._findNearestVertex(spherePos, positions);

      if (vertexIndex !== -1) {
        // Use the highest resolution elevation for each vertex
        const existing = vertexUpdates.get(vertexIndex);
        if (!existing || point.lodLevel < existing.lodLevel) {
          vertexUpdates.set(vertexIndex, { elevation, lodLevel: point.lodLevel, position: spherePos });
        }
      }

      processedCount++;
    }

    // Apply updates
    let updated = 0;
    vertexUpdates.forEach(({ elevation, position }, vertexIndex) => {
      const elevated = position.clone().normalize()
        .multiplyScalar(EARTH_RADIUS + elevation);

      positions.setXYZ(vertexIndex, elevated.x, elevated.y, elevated.z);
      updated++;
    });

    if (updated > 0) {
      positions.needsUpdate = true;
      geometry.computeVertexNormals();

      // Only log occasionally to reduce console spam
      if (updated > 100 || this.voronoiPoints.size < 1000) {
        console.log(`[VoronoiLOD] Updated ${updated} vertices with elevations (${processedCount}/${this.voronoiPoints.size} points processed)`);
      }
    }
  }

  /**
   * Apply elevations by dynamically adding vertices
   */
  _applyElevationsWithDynamicVertices() {
    if (!this.dynamicGeometry) return;

    let added = 0;
    let updated = 0;

    this.voronoiPoints.forEach((point, id) => {
      const elevation = this.pointElevations.get(id);

      if (typeof elevation !== 'number') return;

      // Get sphere position for this point
      const spherePos = this.globe.latLonToSphere(point.lat, point.lon);

      // Apply elevation
      const elevated = spherePos.clone().normalize()
        .multiplyScalar(EARTH_RADIUS + elevation);

      // Add or update vertex
      const existingIndex = this.addedVertices.get(id);

      if (existingIndex !== undefined) {
        // Update existing vertex
        if (this.dynamicGeometry.updateVertex(id, elevated)) {
          updated++;
        }
      } else {
        // Add new vertex
        const vertexIndex = this.dynamicGeometry.addVertex(elevated, id);
        this.addedVertices.set(id, vertexIndex);
        added++;
      }
    });

    // Rebuild geometry if needed
    if (this.dynamicGeometry.rebuild()) {
      console.log(`[VoronoiLOD] Dynamic geometry updated: ${added} added, ${updated} updated`);
    }
  }

  /**
   * Find nearest vertex in sphere geometry
   */
  _findNearestVertex(targetPos, positions) {
    let minDist = Infinity;
    let nearestIdx = -1;

    const vertex = new THREE.Vector3();

    // Only search base vertices (not dynamically added ones)
    const searchCount = this.baseVertexCount > 0 ? this.baseVertexCount : positions.count;

    for (let i = 0; i < searchCount; i++) {
      vertex.fromBufferAttribute(positions, i);
      const dist = vertex.distanceToSquared(targetPos);

      if (dist < minDist) {
        minDist = dist;
        nearestIdx = i;
      }
    }

    return nearestIdx;
  }

  /**
   * Get stats
   */
  getStats() {
    const stats = {
      voronoiPoints: this.voronoiPoints.size,
      elevationsCached: this.pointElevations.size,
      fetchQueueSize: this.fetchQueue.length,
      fetching: this.fetching,
      mode: this.mode
    };

    if (this.dynamicGeometry) {
      stats.dynamicGeometry = this.dynamicGeometry.getStats();
    }

    return stats;
  }

  /**
   * Dispose
   */
  dispose() {
    this.voronoiPoints.clear();
    this.pointElevations.clear();
    this.addedVertices.clear();
    this.fetchQueue = [];
  }
}
