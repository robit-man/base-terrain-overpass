// lodBlending.js - Smooth blending and transitions between LOD levels
import * as THREE from 'three';

/**
 * LODBlending: Manages smooth transitions between detail levels
 *
 * Provides interpolation and blending to avoid harsh boundaries
 * between high and low resolution areas
 */
export class LODBlending {
  constructor(opts = {}) {
    // Blend zone configuration
    this.blendZoneWidth = opts.blendZoneWidth || 50; // meters - width of transition zone

    // Morphing settings
    this.morphingEnabled = opts.morphingEnabled !== false; // Default true

    console.log('[LODBlending] Initialized');
  }

  /**
   * Calculate blend factor for a point based on distance from player
   * Returns value 0-1, where:
   * - 0 = use lower LOD fully
   * - 1 = use higher LOD fully
   * - 0-1 = blend between LODs
   */
  getBlendFactor(distance, lodLevel, nextLodLevel) {
    if (!nextLodLevel) return 1.0; // No next level, use current fully

    // Get distance thresholds
    const currentMax = lodLevel.maxDistance;
    const nextMax = nextLodLevel.maxDistance;

    // Calculate blend zone boundaries
    const blendStart = currentMax - this.blendZoneWidth;
    const blendEnd = currentMax;

    if (distance < blendStart) {
      return 1.0; // Fully in current LOD
    } else if (distance > blendEnd) {
      return 0.0; // Fully in next LOD
    } else {
      // In blend zone - smooth interpolation
      const t = (distance - blendStart) / (blendEnd - blendStart);
      return this._smoothstep(1.0 - t); // Smooth interpolation
    }
  }

  /**
   * Smooth interpolation function (smoothstep)
   * Provides ease-in/ease-out interpolation
   */
  _smoothstep(t) {
    // Clamp t to [0, 1]
    t = Math.max(0, Math.min(1, t));
    // Smoothstep formula: 3t^2 - 2t^3
    return t * t * (3 - 2 * t);
  }

  /**
   * Apply geomorphing to vertices based on blend factors
   * This smoothly transitions vertex positions between LOD levels
   */
  applyGeomorphing(vertices, playerPosition) {
    if (!this.morphingEnabled) return;

    // For each vertex, calculate blend factor and adjust position
    vertices.forEach(vertex => {
      const distance = vertex.position.distanceTo(playerPosition);
      const blend = this.getBlendFactor(distance, vertex.lodLevel, vertex.nextLodLevel);

      if (blend < 1.0 && vertex.nextPosition) {
        // Blend between current and next position
        vertex.position.lerp(vertex.nextPosition, 1.0 - blend);
      }
    });
  }

  /**
   * Calculate alpha blending for visual transitions
   * Can be used for opacity/visibility morphing
   */
  getAlphaBlend(distance, lodLevel, nextLodLevel) {
    const blend = this.getBlendFactor(distance, lodLevel, nextLodLevel);

    // Return alpha values for current and next LOD
    return {
      currentAlpha: blend,
      nextAlpha: 1.0 - blend
    };
  }

  /**
   * Calculate normal blending for smooth lighting transitions
   */
  blendNormals(normal1, normal2, blendFactor) {
    const blended = new THREE.Vector3();
    blended.lerpVectors(normal1, normal2, blendFactor);
    blended.normalize();
    return blended;
  }

  /**
   * Poisson disk fade: gradually reduce point density at LOD boundaries
   * Returns true if point should be included based on blend factor
   */
  shouldIncludePoint(distance, lodLevel, nextLodLevel, pointId) {
    const blend = this.getBlendFactor(distance, lodLevel, nextLodLevel);

    if (blend >= 1.0) return true; // Fully in this LOD
    if (blend <= 0.0) return false; // Fully in next LOD

    // Use deterministic pseudo-random fade based on point ID
    const hash = this._hashString(pointId);
    const threshold = hash / 0xffffffff; // Normalize to 0-1

    return blend > threshold;
  }

  /**
   * Simple hash function for deterministic randomness
   */
  _hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return Math.abs(hash);
  }

  /**
   * Calculate detail scaling factor for geometry
   * Reduces detail as distance increases
   */
  getDetailScale(distance, lodLevels) {
    // Find which LOD level this distance falls into
    for (let i = 0; i < lodLevels.length; i++) {
      if (distance <= lodLevels[i].maxDistance) {
        return lodLevels[i].spacing;
      }
    }

    // Beyond all LOD levels
    return lodLevels[lodLevels.length - 1].spacing;
  }

  /**
   * Apply elevation smoothing at LOD boundaries
   * Prevents sudden elevation changes at transitions
   */
  smoothElevation(elevation, distance, lodLevel, nextLodLevel, nextElevation) {
    if (!nextLodLevel || nextElevation === undefined) {
      return elevation;
    }

    const blend = this.getBlendFactor(distance, lodLevel, nextLodLevel);

    // Interpolate elevations
    return elevation * blend + nextElevation * (1.0 - blend);
  }
}

/**
 * Helper class for managing LOD transition zones
 */
export class TransitionZone {
  constructor(innerRadius, outerRadius) {
    this.innerRadius = innerRadius;
    this.outerRadius = outerRadius;
  }

  /**
   * Check if a point is in this transition zone
   */
  contains(distance) {
    return distance >= this.innerRadius && distance <= this.outerRadius;
  }

  /**
   * Get normalized position within zone (0 = inner edge, 1 = outer edge)
   */
  getNormalizedPosition(distance) {
    if (distance <= this.innerRadius) return 0;
    if (distance >= this.outerRadius) return 1;

    return (distance - this.innerRadius) / (this.outerRadius - this.innerRadius);
  }

  /**
   * Get smoothed position using smoothstep
   */
  getSmoothedPosition(distance) {
    const t = this.getNormalizedPosition(distance);
    return t * t * (3 - 2 * t);
  }
}
