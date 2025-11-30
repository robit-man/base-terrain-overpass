# Surface Patch Implementation

## Correct Approach for Globe Terrain

### The Problem with Previous Approach
The VoronoiLOD system was generating points in 3D space around the player, which was incorrect because:
1. ❌ Points were distributed in world space, not on globe surface
2. ❌ No raycasting to find actual surface intersection
3. ❌ GPS coordinates calculated from player position, not surface position
4. ❌ Elevations applied to wrong locations

### The Correct Approach (SurfacePatch)

The new SurfacePatch system uses the proper methodology:

1. ✅ **Raycast from player to globe surface** - Find where player "stands" on sphere
2. ✅ **Generate Voronoi patch on surface** - Distribute points on sphere surface around intersection
3. ✅ **Convert surface points to GPS** - Get lat/lon for each surface point
4. ✅ **Fetch elevations** - Query terrain data for those GPS coordinates
5. ✅ **Apply radially from Earth center** - Move vertices outward along radius

## How It Works

### Step 1: Find Surface Point
```javascript
// Raycast from player position toward Earth center
const earthCenter = new THREE.Vector3(0, 0, 0);
const direction = earthCenter.clone().sub(playerWorldPos).normalize();
const raycaster = new THREE.Raycaster(playerWorldPos, direction);

// Intersect with globe mesh
const intersections = raycaster.intersectObject(this.globe.baseMesh);
const surfacePoint = intersections[0].point; // Point ON the sphere
```

### Step 2: Generate Patch on Surface
```javascript
// Create local tangent frame at surface point
const up = surfacePoint.clone().normalize();
const east = perpendicular to up
const north = up × east

// Generate points using Fibonacci spiral
for (let i = 0; i < numPoints; i++) {
  // Fibonacci spiral in 2D
  const radius = ...;
  const angle = i * goldenAngle;

  const localX = radius * Math.cos(angle);
  const localZ = radius * Math.sin(angle);

  // Convert to 3D surface position
  const surfacePos = origin + (east * localX) + (north * localZ);

  // Project back onto sphere
  surfacePos.normalize().multiplyScalar(EARTH_RADIUS);
}
```

### Step 3: Convert to GPS
```javascript
// For each surface point
const gps = globe.sphereToLatLon(surfacePoint);
// Now we have correct lat/lon for this surface location
```

### Step 4: Fetch Elevations
```javascript
// Query terrain service with GPS coordinates
const payload = {
  locations: [{ lat: gps.lat, lng: gps.lon }, ...]
};

const result = await terrainRelay.queryBatch(payload);
```

### Step 5: Apply Elevations
```javascript
// Move vertex radially outward from Earth center
const direction = surfacePoint.clone().normalize();
const elevatedPos = direction.multiplyScalar(EARTH_RADIUS + elevation);

// Find nearest vertex and update it
positions.setXYZ(vertexIndex, elevatedPos.x, elevatedPos.y, elevatedPos.z);
```

## Key Differences

| Aspect | Old (VoronoiLOD) | New (SurfacePatch) |
|--------|------------------|-------------------|
| Point generation | 3D space around player | 2D on sphere surface |
| Reference frame | World coordinates | Local tangent plane |
| GPS calculation | From player position | From surface points |
| Distribution | Rings in 3D | Circles on sphere |
| Correctness | ❌ Wrong | ✅ Correct |

## Configuration

```javascript
// In globe.js or app.js
const globe = new Globe(scene, {
  subdivisionLevels: 6,  // Higher = more vertices for detail
  patchRadius: 5000,     // 5km radius patch
  pointSpacing: 10,      // 10m between sample points
  updateThreshold: 50    // Update every 50m of movement
});
```

### Performance Settings

**For better performance** (fewer points):
```javascript
patchRadius: 2000,   // 2km radius
pointSpacing: 20,    // 20m spacing
```

**For better quality** (more points):
```javascript
patchRadius: 10000,  // 10km radius
pointSpacing: 5,     // 5m spacing
```

## Advantages

1. ✅ **Mathematically correct** - Points are actually on sphere surface
2. ✅ **GPS accuracy** - Coordinates match surface locations
3. ✅ **Flush mapping** - Elevations align with local terrain
4. ✅ **Efficient** - Only updates patch when player moves significantly
5. ✅ **Cached** - Elevations cached by geohash for reuse
6. ✅ **Throttled** - Won't regenerate patch on every frame

## Implementation Files

1. **[surfacePatch.js](surfacePatch.js)** - New surface-based patch system
2. **[globe.js](globe.js)** - Updated to use SurfacePatch
3. **[globeTerrain.js](globeTerrain.js)** - Updated to call surfacePatch

## Usage

The system is fully automatic:

```javascript
// Initialization (happens automatically in GlobeTerrain)
const globe = new Globe(scene, { ... });
globe.setOrigin(playerLat, playerLon);

// Updates (happens automatically each frame in globeTerrain.update())
globe.surfacePatch.updateFromPlayerPosition(playerWorldPos);

// Stats
const stats = globe.surfacePatch.getStats();
console.log(stats);
// {
//   patchPoints: 1963,
//   elevationsCached: 1450,
//   fetchQueueSize: 0,
//   fetching: false,
//   centerPoint: { lat: "37.774900", lon: "-122.419400" }
// }
```

## Expected Results

With this correct implementation:

1. **Terrain will be flush** with local buildings and character
2. **GPS coordinates** will match actual surface locations
3. **Elevations** will be applied to correct positions
4. **Performance** will be good (max ~2000 points for 5km radius @ 10m spacing)
5. **Updates** will be smooth (throttled to 50m movement)

## Next Steps

1. ✅ Replace VoronoiLOD with SurfacePatch
2. ✅ Test with relay address configured
3. ⏳ Verify terrain appears correctly
4. ⏳ Tune patch radius and spacing for performance
5. ⏳ Add visual debugging (optional - show patch bounds)

## Debugging

To visualize the patch:
```javascript
// In surfacePatch.js, add after generating points:
const helper = new THREE.Points(
  new THREE.BufferGeometry().setFromPoints(
    Array.from(this.patchPoints.values()).map(p => p.surfacePos)
  ),
  new THREE.PointsMaterial({ color: 0xff0000, size: 5 })
);
this.globe.scene.add(helper);
```

This will show red dots where the patch points are on the sphere.
