// dynamicGeometry.js - Dynamic vertex insertion and Delaunay triangulation for adaptive LOD
import * as THREE from 'three';

/**
 * DynamicGeometry: Manages dynamic vertex insertion into sphere geometry
 *
 * Provides efficient vertex addition and triangulation updates for
 * adaptive terrain detail without rebuilding entire geometry
 */
export class DynamicGeometry {
  constructor(baseGeometry) {
    this.baseGeometry = baseGeometry;

    // Original geometry data (immutable)
    this.basePositions = new Float32Array(baseGeometry.attributes.position.array);
    this.baseIndices = baseGeometry.index ? new Uint32Array(baseGeometry.index.array) : null;
    this.baseVertexCount = baseGeometry.attributes.position.count;

    // Dynamic additions
    this.addedVertices = []; // Array of { position: Vector3, id: string }
    this.addedVertexMap = new Map(); // Map<id, index>

    // Combined geometry state
    this.needsRebuild = false;

    console.log(`[DynamicGeometry] Initialized with ${this.baseVertexCount} base vertices`);
  }

  /**
   * Add a new vertex to the geometry
   * Returns the vertex index
   */
  addVertex(position, id) {
    // Check if already exists
    if (this.addedVertexMap.has(id)) {
      return this.addedVertexMap.get(id);
    }

    const index = this.baseVertexCount + this.addedVertices.length;

    this.addedVertices.push({
      position: position.clone(),
      id
    });

    this.addedVertexMap.set(id, index);
    this.needsRebuild = true;

    return index;
  }

  /**
   * Update an existing vertex position
   */
  updateVertex(id, position) {
    const index = this.addedVertexMap.get(id);
    if (index === undefined) return false;

    const localIndex = index - this.baseVertexCount;
    if (localIndex >= 0 && localIndex < this.addedVertices.length) {
      this.addedVertices[localIndex].position.copy(position);
      this.needsRebuild = true;
      return true;
    }

    return false;
  }

  /**
   * Remove added vertices (reset to base geometry)
   */
  clearAddedVertices() {
    if (this.addedVertices.length > 0) {
      this.addedVertices = [];
      this.addedVertexMap.clear();
      this.needsRebuild = true;
    }
  }

  /**
   * Rebuild geometry buffers with added vertices
   * Uses adaptive triangulation to integrate new vertices
   */
  rebuild() {
    if (!this.needsRebuild) return false;

    const totalVertexCount = this.baseVertexCount + this.addedVertices.length;

    // Create new position buffer
    const newPositions = new Float32Array(totalVertexCount * 3);

    // Copy base vertices
    newPositions.set(this.basePositions);

    // Add new vertices
    for (let i = 0; i < this.addedVertices.length; i++) {
      const offset = (this.baseVertexCount + i) * 3;
      const pos = this.addedVertices[i].position;
      newPositions[offset + 0] = pos.x;
      newPositions[offset + 1] = pos.y;
      newPositions[offset + 2] = pos.z;
    }

    // Update geometry buffers
    this.baseGeometry.setAttribute(
      'position',
      new THREE.BufferAttribute(newPositions, 3)
    );

    // Retriangulate if we added vertices
    if (this.addedVertices.length > 0) {
      this._retriangulate();
    }

    // Recompute normals
    this.baseGeometry.computeVertexNormals();

    this.needsRebuild = false;

    console.log(`[DynamicGeometry] Rebuilt geometry: ${totalVertexCount} vertices`);

    return true;
  }

  /**
   * Retriangulate geometry to incorporate new vertices
   * Uses a simplified approach: for each new vertex, find nearest face and subdivide
   */
  _retriangulate() {
    // For sphere geometry, we can use a simpler approach:
    // Find which face each new vertex is closest to, and subdivide that face

    if (!this.baseIndices) {
      // No indices - can't retriangulate easily
      console.warn('[DynamicGeometry] Base geometry has no indices, skipping retriangulation');
      return;
    }

    const positions = this.baseGeometry.attributes.position;
    const newIndices = Array.from(this.baseIndices);

    // For each added vertex, find nearest face and subdivide it
    for (let i = 0; i < this.addedVertices.length; i++) {
      const vertexIndex = this.baseVertexCount + i;
      const vertexPos = this.addedVertices[i].position;

      // Find nearest face (triangle)
      const { faceIndex, closestPoint } = this._findNearestFace(vertexPos, positions, this.baseIndices);

      if (faceIndex !== -1) {
        // Subdivide this face by replacing it with 3 new faces
        this._subdivideFace(faceIndex, vertexIndex, newIndices);
      }
    }

    // Update indices
    this.baseGeometry.setIndex(new THREE.BufferAttribute(new Uint32Array(newIndices), 1));
  }

  /**
   * Find the nearest face to a given position
   */
  _findNearestFace(position, positions, indices) {
    let minDist = Infinity;
    let nearestFaceIndex = -1;
    let closestPoint = new THREE.Vector3();

    const v0 = new THREE.Vector3();
    const v1 = new THREE.Vector3();
    const v2 = new THREE.Vector3();
    const triangle = new THREE.Triangle();
    const tempClosest = new THREE.Vector3();

    const faceCount = indices.length / 3;

    for (let i = 0; i < faceCount; i++) {
      const i0 = indices[i * 3 + 0];
      const i1 = indices[i * 3 + 1];
      const i2 = indices[i * 3 + 2];

      v0.fromBufferAttribute(positions, i0);
      v1.fromBufferAttribute(positions, i1);
      v2.fromBufferAttribute(positions, i2);

      triangle.set(v0, v1, v2);
      triangle.closestPointToPoint(position, tempClosest);

      const dist = position.distanceToSquared(tempClosest);

      if (dist < minDist) {
        minDist = dist;
        nearestFaceIndex = i;
        closestPoint.copy(tempClosest);
      }
    }

    return { faceIndex: nearestFaceIndex, closestPoint };
  }

  /**
   * Subdivide a face by inserting a vertex
   * Replaces triangle (a, b, c) with three triangles:
   * (a, b, v), (b, c, v), (c, a, v)
   */
  _subdivideFace(faceIndex, newVertexIndex, indices) {
    const baseIndex = faceIndex * 3;

    const i0 = indices[baseIndex + 0];
    const i1 = indices[baseIndex + 1];
    const i2 = indices[baseIndex + 2];

    // Replace original face with first new face
    indices[baseIndex + 0] = i0;
    indices[baseIndex + 1] = i1;
    indices[baseIndex + 2] = newVertexIndex;

    // Add two more faces
    indices.push(
      i1, i2, newVertexIndex,
      i2, i0, newVertexIndex
    );
  }

  /**
   * Get total vertex count
   */
  getVertexCount() {
    return this.baseVertexCount + this.addedVertices.length;
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      baseVertices: this.baseVertexCount,
      addedVertices: this.addedVertices.length,
      totalVertices: this.getVertexCount(),
      needsRebuild: this.needsRebuild
    };
  }
}
