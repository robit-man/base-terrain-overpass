# Globe Integration Guide

## Overview

The new `globe.js` implements an **Earth-sized sphere** (6,371km radius) where:
- 1 Three.js unit = 1 meter
- The sphere uses icosahedron geometry (geodesic subdivision)
- Elevation data is fetched and applied **radially** from Earth's center
- The hexagonal tile system from `tiles.js` determines **which surface points to subdivide**

## Key Concepts

### 1. Earth-Scale Sphere
```javascript
const EARTH_RADIUS_METERS = 6371000; // 6,371 km
const GLOBE_RADIUS = EARTH_RADIUS_METERS; // 1 unit = 1 meter in Three.js
```

### 2. Lat/Lon ↔ Sphere Mapping

**From demo (lines 194-201):**
```javascript
function llToVec3(latDeg, lonDeg, r=R){
  const phi = toRad(90 - latDeg);
  const theta = toRad(lonDeg + 180);
  const x = -r * Math.sin(phi) * Math.cos(theta);
  const z =  r * Math.sin(phi) * Math.sin(theta);
  const y =  r * Math.cos(phi);
  return new THREE.Vector3(x,y,z);
}
```

### 3. Elevation Application

**Key insight from demo (line 251):**
```javascript
function radiusAtLL(lat, lon){
  const h = sampleHeightUV(u, v); // Sample heightmap
  return baseRadius + biasR + scaleR * h; // Add elevation to radius
}
```

**In globe.js:**
```javascript
// Apply elevation: move vertex radially outward from Earth center
const direction = vertex.normalize();
const newPosition = direction.multiplyScalar(GLOBE_RADIUS + elevation);
```

## Integration Strategy

### Phase 1: Hybrid System (Current tiles.js + globe.js)

Keep `tiles.js` hexagonal logic, use it to determine subdivision points on globe:

```javascript
import { Globe } from './globe.js';
import { TileManager } from './tiles.js';

// Create globe
const globe = new Globe(scene, {
  subdivisionLevels: 5, // Base icosahedron detail
  localDetailRadius: 50000, // 50km high-detail zone
  terrainRelay: terrainRelayInstance
});

// Create tile manager (existing)
const tileManager = new TileManager(scene, spacing, tileRadius);

// Set origin on both
globe.setOrigin(lat, lon);
tileManager.setOrigin(lat, lon);

// On tile fetch completion, map hexagonal points to sphere surface
tileManager.on('tileComplete', (tile) => {
  const hexPoints = tile.getHexagonalPoints(); // Get tile's hex grid points

  // Map each hex point to sphere surface
  hexPoints.forEach(point => {
    const { lat, lon } = point;
    const spherePos = globe.latLonToSphere(lat, lon);
    const elevation = tileManager.getElevationAt(lat, lon);

    // Find nearest vertex on globe and apply elevation
    globe.applyElevationAtPoint(spherePos, elevation);
  });
});
```

### Phase 2: Pure Globe System (Future)

Replace tiles entirely with adaptive sphere subdivision:

```javascript
class AdaptiveGlobe extends Globe {
  constructor() {
    super();
    this.subdividedRegions = new Map(); // Track subdivided areas
  }

  updateSubdivision(playerPos) {
    // Subdivide sphere surface near player (like hexagonal tiles, but on sphere)
    const nearbyFaces = this.findFacesWithin(playerPos, 50000); // 50km

    nearbyFaces.forEach(face => {
      if (!this.subdividedRegions.has(face.id)) {
        this.subdivideFace(face); // Split triangle into smaller triangles
        this.fetchElevationForFace(face); // Fetch elevations for new vertices
      }
    });

    // Clean up distant subdivisions
    this.cullDistantSubdivisions(playerPos, 100000); // 100km
  }
}
```

## Comparison: Flat Tiles vs. Sphere

### Current System (tiles.js)
```
Player at (0, 0, 0) in world space
Tiles laid out flat in XZ plane
Elevation moves vertices in +Y direction
Problem: Not geographically accurate at scale
```

### New System (globe.js)
```
Player at lat/lon on sphere surface
Position = latLonToSphere(lat, lon) → (x, y, z)
Elevation moves vertices radially from center (0, 0, 0)
Result: Geographically accurate, works at any scale
```

## Example: Applying Hex Tile Points to Sphere

```javascript
// From tiles.js hex grid
const hexTilePoints = [
  { lat: 37.7749, lon: -122.4194 }, // San Francisco
  { lat: 37.7750, lon: -122.4195 },
  // ... 397 more points in hexagonal pattern
];

// Map to sphere and apply elevation
hexTilePoints.forEach(point => {
  // Get position on sphere surface
  const basePos = globe.latLonToSphere(point.lat, point.lon);

  // Fetch elevation
  const elevation = await fetchElevation(point.lat, point.lon);

  // Apply elevation (move radially outward)
  const elevated = basePos.clone().normalize()
    .multiplyScalar(GLOBE_RADIUS + elevation);

  // Find nearest vertex in globe geometry and update it
  const vertexIndex = globe.findNearestVertex(basePos);
  globe.setVertexPosition(vertexIndex, elevated);
});

// Recompute normals for lighting
globe.geometry.computeVertexNormals();
```

## Benefits

1. **Geographic Accuracy**: Correct distances, bearings, curvature
2. **No Edge Artifacts**: Sphere has no edges (wraps naturally)
3. **Scalable**: Works from city-scale to planet-scale
4. **Real-World Units**: 1 unit = 1 meter (intuitive)
5. **Horizon Effects**: Natural horizon from sphere curvature

## Next Steps

1. ✅ **Created `globe.js`** - Earth-sized sphere with elevation mapping
2. **Integrate with tiles.js** - Use hex points to determine subdivision
3. **Camera System** - Position camera relative to sphere surface
4. **LOD System** - Progressive subdivision based on distance from player
5. **Texture Mapping** - Day/night textures (like demo)
