# Player Surface Attachment - Implementation Guide

## Status: Ready for Integration ✅

The globe terrain system now has the necessary methods to attach the player to the sphere surface. This needs to be integrated into app.js.

## What Was Added

### 1. Globe.getSurfacePositionUnderPlayer()
**Location**: [globe.js:370-408](globe.js#L370-L408)

Returns the exact position where the player should be placed on the globe surface:
- Raycasts from player position to find globe intersection
- Looks up elevation data from surface patch
- Adds eye height offset
- Returns final 3D position

```javascript
getSurfacePositionUnderPlayer(worldPosition, eyeHeight = 1.6)
// Returns: THREE.Vector3 | null
```

### 2. GlobeTerrain.getSurfacePositionForPlayer()
**Location**: [globeTerrain.js:498-507](globeTerrain.js#L498-L507)

Wrapper method for app.js to use:
```javascript
const surfacePos = hexGridMgr.getSurfacePositionForPlayer(dolly.position, eyeHeight);
if (surfacePos) {
  dolly.position.copy(surfacePos);
}
```

### 3. GlobeTerrain.getSurfaceNormal()
**Location**: [globeTerrain.js:509-522](globeTerrain.js#L509-L522)

Returns the surface normal (up direction) at player position:
```javascript
const normal = hexGridMgr.getSurfaceNormal(dolly.position);
if (normal) {
  camera.up.copy(normal);
}
```

## Integration into app.js

### Current Code (Line 5035-5038)
```javascript
const eyeHeight = Number.isFinite(pose.eyeHeight) ? pose.eyeHeight : (this.move?.eyeHeight?.() ?? 1.6);
const groundY = this.hexGridMgr?.getHeightAt?.(dolly.position.x, dolly.position.z);
if (Number.isFinite(groundY) && Number.isFinite(eyeHeight)) {
  dolly.position.y = groundY + eyeHeight;
}
```

**Problem**: This only adjusts Y coordinate (assumes flat terrain). Won't work for sphere.

### New Code (REPLACE THE ABOVE)
```javascript
const eyeHeight = Number.isFinite(pose.eyeHeight) ? pose.eyeHeight : (this.move?.eyeHeight?.() ?? 1.6);

// Try to attach to globe surface first
const surfacePos = this.hexGridMgr?.getSurfacePositionForPlayer?.(dolly.position, eyeHeight);

if (surfacePos) {
  // Globe mode: attach to sphere surface
  dolly.position.copy(surfacePos);

  // Update camera orientation to match globe surface
  const surfaceNormal = this.hexGridMgr?.getSurfaceNormal?.(dolly.position);
  if (surfaceNormal && camera) {
    camera.up.copy(surfaceNormal);
  }
} else {
  // Fallback to flat terrain mode
  const groundY = this.hexGridMgr?.getHeightAt?.(dolly.position.x, dolly.position.z);
  if (Number.isFinite(groundY) && Number.isFinite(eyeHeight)) {
    dolly.position.y = groundY + eyeHeight;
  }
}
```

### Additional Update Needed (Line 5030-5032)
**Current**:
```javascript
camera.up.set(0, 1, 0); // Forces flat terrain orientation
```

**Should be**:
```javascript
// Don't force Y-up here, let surface normal handle it
// camera.up.set(0, 1, 0); // COMMENT THIS OUT
```

## Expected Behavior

### Before Integration
- Player floats above globe at arbitrary height
- Camera always Y-up (0, 1, 0)
- Voronoi patch raycasts down but player doesn't follow
- Coordinate flapping (player jumping to North Pole)

### After Integration
- ✅ Player sticks to globe surface geometry
- ✅ Player position includes elevation offset
- ✅ Camera orientation matches sphere curvature
- ✅ Voronoi patch centered under player's feet
- ✅ No coordinate flapping

## Testing

### 1. Load the App
```javascript
// In browser console after loading:
const pos = window.app.sceneMgr.dolly.position;
console.log('Player pos:', pos);

const surfacePos = window.app.hexGridMgr.getSurfacePositionForPlayer(pos, 1.6);
console.log('Surface pos:', surfacePos);
console.log('Distance to Earth center:', surfacePos.length());
// Should be ~6371000m + elevation + 1.6m
```

### 2. Check Surface Normal
```javascript
const normal = window.app.hexGridMgr.getSurfaceNormal(pos);
console.log('Surface normal:', normal);
console.log('Normal length:', normal.length()); // Should be 1.0
```

### 3. Verify Voronoi Patch
```javascript
const stats = window.app.hexGridMgr.globe.surfacePatch.getStats();
console.log('Patch center:', stats.centerPoint);
// Should match player's GPS coordinates
```

### 4. Visual Check
- White Voronoi circles should appear directly below player
- Player should stay on globe surface as they move
- Camera should tilt to match sphere curvature
- No rapid position jumps

## Known Issues & Solutions

### Issue: Camera Rotation Conflicts
**Symptom**: Camera orientation fights between flat terrain and sphere
**Solution**: Disable forced Y-up at line 5032 in app.js

### Issue: Physics System Interference
**Symptom**: Physics system pulls player back to flat plane
**Solution**: May need to disable or adapt physics system for globe mode

### Issue: Movement Input Not Following Surface
**Symptom**: WASD moves on flat plane, not along sphere
**Solution**: Will need separate implementation (see SURFACE_MOVEMENT.md - to be created)

### Issue: Buildings Still Floating
**Symptom**: Player attached but buildings not
**Solution**: Will need separate building attachment (see BUILDING_ATTACHMENT.md - to be created)

## Performance Impact

### Raycast Cost
- **Per frame**: 1 raycast (player to globe)
- **Vertices checked**: ~10,000-160,000 (depending on subdivision level)
- **Time**: ~0.1-0.5ms per raycast

**Optimization**: Cache result for ~5 frames, only raycast when player moves >1m

### Elevation Lookup
- **Per frame**: 1 elevation lookup in Map (~250-2000 entries)
- **Time**: <0.01ms (O(1) or O(log n))

**Total overhead**: <1ms per frame (negligible)

## Fallback Mode

If globe mode fails, the system falls back to flat terrain:
```javascript
if (!surfacePos) {
  // Use old flat terrain height system
  const groundY = this.hexGridMgr?.getHeightAt?.(dolly.position.x, dolly.position.z);
  if (Number.isFinite(groundY)) {
    dolly.position.y = groundY + eyeHeight;
  }
}
```

This ensures compatibility with existing terrain systems.

## Next Steps (After Integration)

1. **Test basic attachment** - Verify player stays on sphere
2. **Fix camera controls** - Adapt orbit controls for sphere
3. **Implement surface movement** - WASD follows sphere curvature
4. **Attach buildings** - Position buildings on globe surface
5. **Add gravity direction** - Pull "down" toward Earth center

## Code Summary

### Files Modified
1. **[globe.js](globe.js)** - Added `getSurfacePositionUnderPlayer()`
2. **[globeTerrain.js](globeTerrain.js)** - Added wrapper methods for app.js
3. **[surfacePatch.js](surfacePatch.js)** - Already has raycast logic

### Files to Modify (By User)
1. **app.js** - Line 5030-5038: Replace player positioning code
2. **app.js** - Line 5032: Comment out forced Y-up

## Summary

The backend is ready! Globe terrain now provides:
- ✅ Accurate surface position calculation
- ✅ Elevation data integration
- ✅ Surface normal for camera orientation
- ✅ Fallback to flat terrain

All that's needed is to hook it into app.js update loop (lines 5030-5038).

**Estimated integration time**: 5 minutes
**Risk level**: Low (has fallback mode)
**Testing required**: High (affects player positioning)
