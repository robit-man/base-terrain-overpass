// surfacePatch.js - Surface-based Voronoi patch generation for globe terrain
import * as THREE from 'three';
import { geohashEncode, pickGeohashPrecision } from './geohash.js';

const EARTH_RADIUS = 6371000; // meters

/**
 * SurfacePatch: Generates a local patch of terrain detail on globe surface
 *
 * Approach:
 * 1. Raycast from player down to globe surface
 * 2. Generate Voronoi points in a circular patch around that surface point
 * 3. Convert surface points to GPS coordinates
 * 4. Fetch elevations for those coordinates
 * 5. Apply elevations by moving vertices radially from Earth center
 */
export class SurfacePatch {
  constructor(globe, opts = {}) {
    this.globe = globe;

    // Patch configuration
    this.patchRadius = opts.patchRadius || 500; // 500m radius - REDUCED for performance
    this.pointSpacing = opts.pointSpacing || 50; // 50m spacing - REDUCED point count
    this.minSpacing = opts.minSpacing || 5; // meters - minimum spacing
    this.maxSpacing = opts.maxSpacing || 100; // meters - maximum spacing

    // Current patch state
    this.centerPoint = null; // { lat, lon, surfacePos: Vector3 }
    this.patchPoints = new Map(); // Map<pointId, { lat, lon, surfacePos, elevation }>
    this.elevationCache = new Map(); // Map<geohash, elevation>
    this.pendingFetchIds = new Set(); // Track in-flight fetch requests

    // Terrain relay
    this.terrainRelay = null;

    // Debug visualization
    this.debugEnabled = opts.debugEnabled !== undefined ? opts.debugEnabled : false; // DISABLED by default
    this.debugHelpers = []; // Array of debug mesh objects

    // Fetch state
    this.fetchQueue = [];
    this.fetching = false;
    this.minUpdateInterval = Number.isFinite(opts.minUpdateInterval)
      ? Math.max(0, opts.minUpdateInterval)
      : 750;
    this.lastUpdateTime = 0;

    // Update throttling
    this.lastCenterPoint = null;
    this.updateThreshold = 200; // 200m - INCREASED to reduce updates

    console.log(`[SurfacePatch] Initialized (radius: ${this.patchRadius}m, spacing: ${this.pointSpacing}m)`);
  }

  /**
   * Set terrain relay for elevation fetching
   */
  setTerrainRelay(relay) {
    this.terrainRelay = relay;
  }

  /**
   * Update patch based on player position
   * Raycasts down to find surface point, then generates patch around it
   */
  updateFromPlayerPosition(playerWorldPos) {
    try {
      const now = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();

      // Find surface point by raycasting from player toward Earth center
      const surfacePoint = this._findSurfacePoint(playerWorldPos);

      if (!surfacePoint) {
        console.warn('[SurfacePatch] Failed to find surface point');
        return;
      }

      // Check if we need to regenerate patch
      if (this.lastCenterPoint) {
        const distance = surfacePoint.distanceTo(this.lastCenterPoint);
        if (!Number.isFinite(distance)) {
          console.warn('[SurfacePatch] Invalid center distance, skipping update');
          return;
        }

        if (distance < this.updateThreshold) {
          const elapsed = now - this.lastUpdateTime;
          if (elapsed < this.minUpdateInterval) {
            return; // Recently updated and player hasn't moved enough
          }
        }
      }

      this.lastCenterPoint = surfacePoint.clone();
      this.lastUpdateTime = now;

      // Convert surface point to GPS
      const { lat, lon } = this.globe.sphereToLatLon(surfacePoint);
      this.centerPoint = { lat, lon, surfacePos: surfacePoint };

      // Generate patch points around this surface location
      this._generatePatchPoints();
    } catch (err) {
      console.error('[SurfacePatch] Error updating patch:', err);
    }
  }

  /**
   * Find surface point on globe by raycasting from player position
   */
  _findSurfacePoint(playerWorldPos) {
    // Direction from player to Earth center
    const earthCenter = new THREE.Vector3(0, 0, 0);
    const direction = earthCenter.clone().sub(playerWorldPos).normalize();

    // Raycast to find intersection with globe
    const raycaster = new THREE.Raycaster(playerWorldPos, direction);

    if (!this.globe.baseMesh) return null;

    const intersections = raycaster.intersectObject(this.globe.baseMesh);

    if (intersections.length > 0) {
      return intersections[0].point; // First intersection
    }

    // Fallback: project player position onto sphere surface
    const playerDir = playerWorldPos.clone().normalize();
    return playerDir.multiplyScalar(EARTH_RADIUS);
  }

  /**
   * Generate Voronoi-distributed points in a circular patch on sphere surface
   */
  _generatePatchPoints() {
    if (!this.centerPoint) return;

    const newPoints = new Map();
    const startTime = performance.now();

    const { lat: centerLat, lon: centerLon, surfacePos } = this.centerPoint;

    // Calculate number of points based on patch area and spacing
    const patchArea = Math.PI * this.patchRadius * this.patchRadius;
    const pointArea = this.pointSpacing * this.pointSpacing;
    const numPoints = Math.ceil(patchArea / pointArea);

    // Cap maximum points for performance
    const maxPoints = 2000;
    const actualPoints = Math.min(numPoints, maxPoints);

    console.log(`[SurfacePatch] Generating ${actualPoints} points for ${this.patchRadius}m radius patch`);

    // Use Fibonacci spiral for even distribution on sphere surface
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));

    // Get local tangent frame at center point
    const localFrame = this._getLocalTangentFrame(surfacePos);

    for (let i = 0; i < actualPoints; i++) {
      // Fibonacci spiral in 2D
      const radiusFraction = Math.sqrt((i + 0.5) / actualPoints);
      const radius = radiusFraction * this.patchRadius;
      const angle = i * goldenAngle;

      // Convert to local 2D coordinates
      const localX = radius * Math.cos(angle);
      const localZ = radius * Math.sin(angle);

      // Convert to 3D surface position using local frame
      const surfacePoint = this._localToSurface(localX, localZ, localFrame);

      // Convert to GPS coordinates
      const gps = this.globe.sphereToLatLon(surfacePoint);

      // Generate unique ID
      const id = geohashEncode(gps.lat, gps.lon, pickGeohashPrecision(this.pointSpacing));
      const cachedElevation = this.elevationCache.has(id)
        ? this.elevationCache.get(id)
        : null;

      newPoints.set(id, {
        id,
        lat: gps.lat,
        lon: gps.lon,
        surfacePos: surfacePoint,
        elevation: cachedElevation,
        distance: radius
      });
    }

    const elapsed = performance.now() - startTime;
    console.log(`[SurfacePatch] Generated ${newPoints.size} points in ${elapsed.toFixed(1)}ms`);

    // Update patch points
    this.patchPoints = newPoints;

    // Update debug visualization if enabled
    if (this.debugEnabled) {
      this._updateDebugHelpers();
    }

    // Fetch elevations for points without cached data
    this._fetchMissingElevations();
  }

  /**
   * Get local tangent frame (East, North, Up) at a surface point
   */
  _getLocalTangentFrame(surfacePos) {
    const up = surfacePos.clone().normalize();

    // East is perpendicular to up in XZ plane
    let east = new THREE.Vector3(0, 1, 0).cross(up);
    if (east.lengthSq() < 1e-6) {
      east = new THREE.Vector3(1, 0, 0).cross(up);
    }
    east.normalize();

    // North completes the right-handed frame
    const north = up.clone().cross(east).normalize();

    return { origin: surfacePos, up, north, east };
  }

  /**
   * Convert local 2D coordinates to 3D surface position on sphere
   */
  _localToSurface(localX, localZ, frame) {
    const { origin, east, north } = frame;

    // Apply offsets in local tangent plane
    const offset = origin.clone()
      .addScaledVector(east, localX)
      .addScaledVector(north, -localZ);

    // Project back onto sphere surface
    const direction = offset.normalize();
    return direction.multiplyScalar(EARTH_RADIUS);
  }

  /**
   * Fetch elevations for points that don't have cached data
   */
  async _fetchMissingElevations() {
    if (!this.terrainRelay) {
      console.warn('[SurfacePatch] No terrain relay configured');
      return;
    }

    const pointsToFetch = [];

    this.patchPoints.forEach((point, id) => {
      if (point.elevation === null && !this.pendingFetchIds.has(id)) {
        pointsToFetch.push(point);
        this.pendingFetchIds.add(id);
      }
    });

    if (pointsToFetch.length === 0) {
      // All elevations cached, apply them
      this._applyElevationsToGeometry();
      return;
    }

    console.log(`[SurfacePatch] Fetching elevations for ${pointsToFetch.length} points`);

    // Add to fetch queue
    this.fetchQueue.push(...pointsToFetch);

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
      if (batch.length === 0) continue;

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
          // Store elevations in cache and update points
          for (let i = 0; i < batch.length && i < result.results.length; i++) {
            const point = batch[i];
            const elevation = result.results[i]?.elevation || 0;

            // Cache it
            this.elevationCache.set(point.id, elevation);

            // Update point if still in current patch
            const patchPoint = this.patchPoints.get(point.id);
            if (patchPoint) {
              patchPoint.elevation = elevation;
            }
          }
        }

      } catch (err) {
        console.error('[SurfacePatch] Elevation fetch failed:', err);

        // Set failed points to 0
        batch.forEach(p => {
          this.elevationCache.set(p.id, 0);
          const patchPoint = this.patchPoints.get(p.id);
          if (patchPoint) {
            patchPoint.elevation = 0;
          }
        });
      } finally {
        batch.forEach(point => this.pendingFetchIds.delete(point.id));
      }

      // Small delay between batches
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    this.fetching = false;

    // Apply elevations to geometry
    this._applyElevationsToGeometry();
  }

  /**
   * Apply fetched elevations to globe geometry
   * Moves vertices radially outward from Earth center
   */
  _applyElevationsToGeometry() {
    try {
      if (!this.globe.baseMesh) return;

      const geometry = this.globe.baseMesh.geometry;
      const positions = geometry.attributes.position;

      let updated = 0;
      const vertexUpdates = new Map();

      // For each patch point with elevation, find nearest vertex and update it
      this.patchPoints.forEach((point, id) => {
        if (typeof point.elevation !== 'number') return;

        // Find nearest vertex to this surface point
        const vertexIndex = this._findNearestVertex(point.surfacePos, positions);

        if (vertexIndex !== -1) {
          // Calculate elevated position (radially outward from Earth center)
          const direction = point.surfacePos.clone().normalize();
          const elevatedPos = direction.multiplyScalar(EARTH_RADIUS + point.elevation);

          // Store update (use highest resolution if multiple points map to same vertex)
          const existing = vertexUpdates.get(vertexIndex);
          if (!existing || Math.abs(point.elevation) > Math.abs(existing.elevation)) {
            vertexUpdates.set(vertexIndex, {
              position: elevatedPos,
              elevation: point.elevation
            });
          }
        }
      });

      // Apply vertex updates
      vertexUpdates.forEach(({ position }, vertexIndex) => {
        positions.setXYZ(vertexIndex, position.x, position.y, position.z);
        updated++;
      });

      if (updated > 0) {
        positions.needsUpdate = true;
        geometry.computeVertexNormals();

        console.log(`[SurfacePatch] Applied ${updated} elevation updates to geometry`);
      }
    } catch (err) {
      console.error('[SurfacePatch] Error applying elevations:', err);
    }
  }

  /**
   * Find nearest vertex in geometry to target position
   */
  _findNearestVertex(targetPos, positions) {
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

  /**
   * Update debug visualization helpers
   */
  _updateDebugHelpers() {
    // Clear old helpers
    this._clearDebugHelpers();

    if (!this.globe.scene) {
      console.warn('[SurfacePatch] No scene available for debug helpers');
      return;
    }

    // Create white circles at each patch point
    this.patchPoints.forEach((point, id) => {
      // Circle size based on distance from center (smaller at edges)
      const distanceFraction = point.distance / this.patchRadius;
      const baseSize = this.pointSpacing * 0.5; // Half the spacing
      const size = baseSize * (1.0 - distanceFraction * 0.5); // Smaller at edges

      // Create circle geometry
      const geometry = new THREE.CircleGeometry(size, 8);
      const material = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.8
      });
      const circle = new THREE.Mesh(geometry, material);

      // Position on sphere surface (slightly offset outward so it's visible)
      const offset = point.surfacePos.clone().normalize().multiplyScalar(10); // 10m offset
      circle.position.copy(point.surfacePos).add(offset);

      // Orient circle to face outward from sphere center
      circle.lookAt(new THREE.Vector3(0, 0, 0));
      circle.rotateX(Math.PI); // Flip to face outward

      this.globe.scene.add(circle);
      this.debugHelpers.push(circle);
    });

    console.log(`[SurfacePatch] Created ${this.debugHelpers.length} debug helpers`);
  }

  /**
   * Clear debug visualization helpers
   */
  _clearDebugHelpers() {
    if (this.globe.scene) {
      this.debugHelpers.forEach(helper => {
        this.globe.scene.remove(helper);
        helper.geometry.dispose();
        helper.material.dispose();
      });
    }
    this.debugHelpers = [];
  }

  /**
   * Toggle debug visualization
   */
  setDebugEnabled(enabled) {
    this.debugEnabled = enabled;

    if (enabled) {
      this._updateDebugHelpers();
    } else {
      this._clearDebugHelpers();
    }
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      patchPoints: this.patchPoints.size,
      elevationsCached: this.elevationCache.size,
      fetchQueueSize: this.fetchQueue.length,
      fetching: this.fetching,
      debugEnabled: this.debugEnabled,
      debugHelpersCount: this.debugHelpers.length,
      centerPoint: this.centerPoint ? {
        lat: this.centerPoint.lat.toFixed(6),
        lon: this.centerPoint.lon.toFixed(6)
      } : null
    };
  }

  /**
   * Dispose
   */
  dispose() {
    this._clearDebugHelpers();
    this.patchPoints.clear();
    this.elevationCache.clear();
    this.fetchQueue = [];
    this.pendingFetchIds.clear();
    this.lastCenterPoint = null;
  }
}
