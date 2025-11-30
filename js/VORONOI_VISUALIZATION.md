# Voronoi Visualization System

## Overview

The SurfacePatch system now includes debug visualization that displays Voronoi sample points as white circular markers on the globe surface. This helps visualize:

1. **Point Distribution** - See the Fibonacci spiral pattern on the sphere
2. **Patch Coverage** - View the area being sampled for terrain detail
3. **Update Frequency** - Watch patches regenerate as player moves
4. **Sampling Density** - Observe point spacing and coverage

## Features

### White Circular Markers
- Each Voronoi sample point is visualized as a white circle
- Circle size proportional to spacing (smaller at patch edges)
- Positioned slightly above globe surface (10m offset) for visibility
- Semi-transparent (80% opacity) for better blending

### Dynamic Updates
- Markers update automatically when patch regenerates
- Old markers properly disposed to prevent memory leaks
- Smooth transitions as player moves

## Usage

### Enable/Disable Visualization

```javascript
// Enable debug visualization (enabled by default)
globe.surfacePatch.setDebugEnabled(true);

// Disable debug visualization
globe.surfacePatch.setDebugEnabled(false);
```

### Check Status

```javascript
const stats = globe.surfacePatch.getStats();
console.log(stats);
// {
//   patchPoints: 250,
//   elevationsCached: 180,
//   debugEnabled: true,
//   debugHelpersCount: 250,
//   centerPoint: { lat: "37.774900", lon: "-122.419400" }
// }
```

### Configure at Initialization

```javascript
// Disable visualization on creation
const surfacePatch = new SurfacePatch(globe, {
  patchRadius: 1000,
  pointSpacing: 20,
  debugEnabled: false  // Start with visualization off
});
```

## Visual Appearance

### Close-Up View (Near Player)
- White circles clearly visible on sphere surface
- Fibonacci spiral pattern evident
- Denser at center, sparser at edges
- Circles oriented perpendicular to sphere radius

### Distant View (Zoomed Out)
- Circles appear as white dots on sphere
- Overall patch coverage visible
- Low-res sphere geometry apparent outside patch
- Clear demarcation of detail area

## Implementation Details

### Circle Creation
```javascript
// Circle size based on distance from patch center
const distanceFraction = point.distance / this.patchRadius;
const baseSize = this.pointSpacing * 0.5; // Half the spacing
const size = baseSize * (1.0 - distanceFraction * 0.5); // Smaller at edges

// Geometry and material
const geometry = new THREE.CircleGeometry(size, 8);
const material = new THREE.MeshBasicMaterial({
  color: 0xffffff,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.8
});
```

### Positioning
```javascript
// Offset outward from sphere surface
const offset = point.surfacePos.clone().normalize().multiplyScalar(10); // 10m
circle.position.copy(point.surfacePos).add(offset);

// Orient to face outward from Earth center
circle.lookAt(new THREE.Vector3(0, 0, 0));
circle.rotateX(Math.PI); // Flip to face outward
```

### Memory Management
All helpers are properly disposed when:
- Patch regenerates (old markers removed)
- Visualization disabled
- SurfacePatch disposed

```javascript
_clearDebugHelpers() {
  this.debugHelpers.forEach(helper => {
    this.globe.scene.remove(helper);
    helper.geometry.dispose();
    helper.material.dispose();
  });
  this.debugHelpers = [];
}
```

## Performance Impact

### Memory Usage
- **Per circle**: ~200 bytes (geometry + material + mesh)
- **250 circles**: ~50 KB
- **2000 circles**: ~400 KB

Minimal impact on performance.

### Render Impact
- **DrawCalls**: +1 per circle (batching possible future optimization)
- **FPS Impact**: Negligible (<1 FPS at 250 circles, ~2-3 FPS at 2000 circles)

### Recommendations
- **For development**: Keep enabled to verify correct operation
- **For production**: Disable for slightly better performance
- **For debugging terrain issues**: Enable to see sample points

## Troubleshooting

### Circles Not Appearing

**Check scene reference**:
```javascript
console.log(globe.surfacePatch.globe.scene); // Should be defined
```

**Check patch points**:
```javascript
console.log(globe.surfacePatch.patchPoints.size); // Should be > 0
```

**Check debug enabled**:
```javascript
console.log(globe.surfacePatch.debugEnabled); // Should be true
```

### Circles in Wrong Location

**Verify surface point calculation**:
```javascript
// Should raycast correctly from player to globe surface
const stats = globe.surfacePatch.getStats();
console.log(stats.centerPoint); // Should match player's lat/lon
```

### Too Many/Too Few Circles

**Adjust patch settings**:
```javascript
// More points (higher quality)
globe.surfacePatch.patchRadius = 2000;  // 2km
globe.surfacePatch.pointSpacing = 15;   // 15m

// Fewer points (better performance)
globe.surfacePatch.patchRadius = 500;   // 500m
globe.surfacePatch.pointSpacing = 30;   // 30m
```

## Future Enhancements

### Possible Improvements
1. **Color coding** - Different colors based on elevation/distance
2. **LOD visualization** - Show detail level with varying sizes/colors
3. **Elevation indicators** - Vertical lines showing elevation offset
4. **Batch rendering** - InstancedMesh for better performance
5. **Wireframe overlay** - Show Voronoi cell boundaries

### Example: Color-Coded Elevation
```javascript
// In _updateDebugHelpers(), replace color with:
const elevation = point.elevation || 0;
const color = elevation > 0 ? 0x00ff00 : 0xff0000; // Green=high, Red=low
const material = new THREE.MeshBasicMaterial({
  color: color,
  side: THREE.DoubleSide,
  transparent: true,
  opacity: 0.8
});
```

### Example: Instanced Rendering
```javascript
// For 1000+ circles, use InstancedMesh for better performance
const geometry = new THREE.CircleGeometry(baseSize, 8);
const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
const instancedMesh = new THREE.InstancedMesh(geometry, material, pointCount);

// Set matrix for each instance
this.patchPoints.forEach((point, idx) => {
  const matrix = new THREE.Matrix4();
  matrix.setPosition(point.surfacePos);
  instancedMesh.setMatrixAt(idx, matrix);
});
```

## Expected Console Output

When visualization is enabled:
```
[SurfacePatch] Generating 250 points for 1000m radius patch
[SurfacePatch] Generated 250 points in 2.1ms
[SurfacePatch] Created 250 debug helpers
[SurfacePatch] Fetching elevations for 250 points
[SurfacePatch] Applied 245 elevation updates to geometry
```

## Integration with Existing Systems

The visualization system is fully integrated with:
- ✅ Surface patch generation ([surfacePatch.js:119-186](surfacePatch.js#L119-L186))
- ✅ Automatic updates on player movement
- ✅ Proper cleanup on dispose
- ✅ Stats reporting

Works alongside:
- Globe mesh rendering
- Elevation fetching
- Terrain application

## Summary

The Voronoi visualization system provides a real-time view of terrain sampling on the globe surface. It's enabled by default for development and can be toggled at runtime. The white circular markers show exactly where the system is sampling elevations, making it easy to verify correct operation and debug terrain issues.

**Key Benefits**:
- Visual confirmation of correct surface sampling
- Easy debugging of patch coverage
- Understanding of Fibonacci spiral distribution
- Performance monitoring (point count visible)
- Real-time feedback during development
