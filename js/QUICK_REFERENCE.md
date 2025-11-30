# Globe Surface Positioning - Quick Reference

## Console Commands for Testing

### Check Player Position
```javascript
const p = window.app.sceneMgr.dolly.position;
console.log(`Player: (${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})`);
console.log(`Distance from Earth center: ${p.length().toFixed(1)}m`);
// Should be ~6,371,000m
```

### Check Camera Orientation
```javascript
const c = window.app.sceneMgr.camera;
console.log(`Camera up: (${c.up.x.toFixed(3)}, ${c.up.y.toFixed(3)}, ${c.up.z.toFixed(3)})`);
// Should NOT be (0, 1, 0) in globe mode
```

### Check Voronoi Patch
```javascript
const stats = window.app.hexGridMgr.globe.surfacePatch.getStats();
console.table(stats);
```

### Toggle Voronoi Visualization
```javascript
// Hide circles
window.app.hexGridMgr.globe.surfacePatch.setDebugEnabled(false);

// Show circles
window.app.hexGridMgr.globe.surfacePatch.setDebugEnabled(true);
```

### Check Building Positions
```javascript
const buildings = window.app.buildingMgr.group.children.filter(c => c.type === 'Mesh');
console.log(`Total buildings: ${buildings.length}`);

const first = buildings[0];
if (first) {
  console.log(`First building distance from center: ${first.position.length().toFixed(1)}m`);
  console.log(`First building up vector:`, first.up);
}
```

### Get Surface Position at GPS
```javascript
const globe = window.app.hexGridMgr.globe;

// Example: Portland, OR
const lat = 45.5231;
const lon = -122.6765;

const surfacePos = globe.latLonToSurfaceWithElevation(lat, lon, 0);
console.log('Surface position:', surfacePos);
console.log('Distance from center:', surfacePos.length());
```

## Expected Values

### Player Position
- **X, Y, Z**: Varies by GPS location
- **Distance from Earth center**: ~6,371,000m + elevation + 1.6m (eye height)
- **Example**: 6,371,050m (50m elevation + 1.6m eye height)

### Camera Orientation
- **In Globe Mode**:
  - `camera.up` should match player's surface normal
  - NOT (0, 1, 0)
  - Length should be 1.0

- **In Flat Mode**:
  - `camera.up` = (0, 1, 0)
  - Standard Y-up

### Building Position
- **Distance from Earth center**: ~6,371,000m + elevation
- **Up vector**: Points away from Earth center
- **Quaternion**: Rotated to align with surface

### Voronoi Patch
- **patchPoints**: 250-2000 (depends on settings)
- **debugHelpersCount**: Same as patchPoints (if enabled)
- **centerPoint**: Should match player's GPS coordinates
- **elevationsCached**: Grows as player moves

## Visual Indicators

### Globe Mode Active
- ✅ White circles visible on globe surface
- ✅ Camera tilts as you move
- ✅ Buildings stand perpendicular to sphere
- ✅ Horizon curves (sphere visible)

### Flat Mode Active
- ❌ No white circles
- ❌ Camera stays Y-up
- ❌ Buildings on flat plane
- ❌ Flat horizon

## Settings

### Reduce Voronoi Point Count
```javascript
const patch = window.app.hexGridMgr.globe.surfacePatch;
patch.patchRadius = 500;    // 500m radius (default: 1000m)
patch.pointSpacing = 30;    // 30m spacing (default: 20m)
// Result: ~85 points
```

### Increase Voronoi Point Count
```javascript
const patch = window.app.hexGridMgr.globe.surfacePatch;
patch.patchRadius = 2000;   // 2km radius
patch.pointSpacing = 10;    // 10m spacing
// Result: ~1250 points
```

### Change Update Frequency
```javascript
const patch = window.app.hexGridMgr.globe.surfacePatch;
patch.updateThreshold = 50;  // Update every 50m (default: 100m)
```

## Debugging

### Issue: Player Floating
**Check**:
```javascript
const surfacePos = window.app.hexGridMgr.getSurfacePositionForPlayer(
  window.app.sceneMgr.dolly.position,
  1.6
);
console.log('Surface position:', surfacePos);
// Should return Vector3, not null
```

**Fix**: If null, check that globe and surfacePatch exist.

### Issue: Buildings at Origin
**Check**:
```javascript
console.log('Building manager has globe:',
  !!window.app.buildingMgr.tileManager?.globe
);
// Should be true
```

**Fix**: Ensure GlobeTerrain is initialized before buildings.

### Issue: No White Circles
**Check**:
```javascript
const patch = window.app.hexGridMgr.globe.surfacePatch;
console.log('Debug enabled:', patch.debugEnabled);
console.log('Debug helpers:', patch.debugHelpers.length);
console.log('Scene exists:', !!patch.globe.scene);
```

**Fix**: Enable debug with `patch.setDebugEnabled(true)`.

### Issue: Camera Not Tilting
**Check**:
```javascript
const normal = window.app.hexGridMgr.getSurfaceNormal(
  window.app.sceneMgr.dolly.position
);
console.log('Surface normal:', normal);
// Should return Vector3, not null
```

**Fix**: Check that surfacePatch exists and is updating.

## Key Methods

### Globe Methods
```javascript
// Convert GPS to sphere surface position
globe.latLonToSphere(lat, lon)
// Returns: Vector3 on base sphere

// Convert GPS to surface + elevation
globe.latLonToSurfaceWithElevation(lat, lon, heightAboveGround)
// Returns: Vector3 on terrain

// Convert 3D position to GPS
globe.sphereToLatLon(position)
// Returns: { lat, lon }
```

### GlobeTerrain Methods
```javascript
// Get player surface position
hexGridMgr.getSurfacePositionForPlayer(playerPos, eyeHeight)
// Returns: Vector3 | null

// Get surface normal
hexGridMgr.getSurfaceNormal(playerPos)
// Returns: Vector3 | null
```

### Building Methods
```javascript
// Position building on globe (called automatically)
buildingMgr._positionBuildingOnGlobe(mesh, lat, lon)
```

### SurfacePatch Methods
```javascript
// Update patch from player position
surfacePatch.updateFromPlayerPosition(playerPos)

// Toggle debug visualization
surfacePatch.setDebugEnabled(true/false)

// Get stats
surfacePatch.getStats()
```

## Performance Monitoring

```javascript
// Monitor frame time
let lastTime = performance.now();
requestAnimationFrame(function measure() {
  const now = performance.now();
  const frameTime = now - lastTime;
  console.log(`Frame time: ${frameTime.toFixed(2)}ms`);
  lastTime = now;
  requestAnimationFrame(measure);
});
```

## Common Issues & Solutions

| Issue | Check | Solution |
|-------|-------|----------|
| Player floating | `getSurfacePositionForPlayer` returns null | Ensure globe initialized |
| Buildings at 0,0,0 | `buildingMgr.tileManager.globe` is null | Check initialization order |
| No white circles | `debugEnabled` is false | Call `setDebugEnabled(true)` |
| Camera not tilting | Surface normal is null | Check surfacePatch exists |
| Position flapping | Console shows coordinate jumps | Check latest fixes applied |

## Success Indicators

When everything is working:
- ✅ Player position distance ≈ 6,371,000m
- ✅ Camera up vector changes as you move
- ✅ Buildings distance ≈ 6,371,000m
- ✅ White circles visible around player
- ✅ Console shows "Applied N elevation updates"
- ✅ No "moved 4959.4km" messages (position flapping)
- ✅ Patch center matches player GPS

## Quick Reload Test

After making changes:
```javascript
// 1. Reload page
// 2. Wait for load
// 3. Run this:

const dolly = window.app.sceneMgr.dolly;
const camera = window.app.sceneMgr.camera;
const globe = window.app.hexGridMgr.globe;

console.log('✅ Tests:');
console.log('Player on globe:', dolly.position.length() > 6_370_000);
console.log('Camera tilted:', camera.up.y < 0.99);
console.log('Globe exists:', !!globe);
console.log('Surface patch exists:', !!globe?.surfacePatch);
console.log('Debug helpers:', globe?.surfacePatch?.debugHelpers.length || 0);
```

All should be `true` or `> 0` for working system!
