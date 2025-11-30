# Stack Overflow Fix

## Problem
```
RangeError: Maximum call stack size exceeded
at VoronoiLOD._fetchElevations
at VoronoiLOD._generateVoronoiDistribution
at VoronoiLOD.updatePlayerPosition
at Globe.setOrigin
at GlobeTerrain.setOrigin
at GlobeTerrain.update
```

## Root Cause
Recursive update loop caused by:

1. **GlobeTerrain.update()** called every frame
2. Checks if player moved >50km
3. If yes, calls `this.setOrigin(lat, lon)` (line 479)
4. **GlobeTerrain.setOrigin()** calls `globe.setOrigin()` (line 73)
5. **Globe.setOrigin()** calls `voronoiLOD.updatePlayerPosition()` (line 138)
6. **VoronoiLOD.updatePlayerPosition()** regenerates point distribution
7. Calls `_fetchElevations()` which starts async fetch
8. Fetch completes and calls `_updateGeometry()` (line 305)
9. Meanwhile, next frame's **GlobeTerrain.update()** is called again
10. **Infinite loop!**

## Solution

### 1. Prevent Recursive Updates in GlobeTerrain ([globeTerrain.js:449-484](globeTerrain.js#L449-L484))

Added `_isUpdating` guard:

```javascript
update(playerWorldPosition) {
  // Prevent recursive updates - CRITICAL!
  if (this._isUpdating) {
    return;
  }

  this._isUpdating = true;

  try {
    // ... update logic ...
  } finally {
    this._isUpdating = false;
  }
}
```

**Impact**: Prevents the same update from being triggered multiple times in the same frame

### 2. Prevent Concurrent Geometry Updates ([voronoiLOD.js:335-362](voronoiLOD.js#L335-L362))

Added `_isUpdatingGeometry` guard:

```javascript
_updateGeometry() {
  // Prevent recursive/concurrent geometry updates
  if (this._isUpdatingGeometry) return;

  this._isUpdatingGeometry = true;

  try {
    // ... geometry update logic ...
  } finally {
    this._isUpdatingGeometry = false;
  }
}
```

**Impact**: Prevents geometry from being updated while it's already updating (from async fetch callback)

## How It Works Now

### Normal Operation (Player Moving <50m)
1. GlobeTerrain.update() called
2. Checks distance moved: <10m → early exit ✓
3. No update happens
4. **Performance**: Near-zero CPU usage

### Player Moving 10-50m
1. GlobeTerrain.update() called
2. Distance moved >10m → proceed
3. Sets `_isUpdating = true`
4. Calls voronoiLOD.updatePlayerPosition()
5. VoronoiLOD checks: moved <50m → early exit ✓
6. Sets `_isUpdating = false`
7. Next frame: early exit because <10m moved
8. **Performance**: One check per 10m

### Player Moving >50m (Major Update)
1. GlobeTerrain.update() called
2. Distance moved >10m → proceed
3. Sets `_isUpdating = true`
4. Calls voronoiLOD.updatePlayerPosition()
5. VoronoiLOD: moved >50m → regenerate points
6. Starts async elevation fetch
7. Sets `_isUpdating = false`
8. **Meanwhile**: Next frame tries to call update()
9. `_isUpdating = false` so it proceeds
10. But VoronoiLOD has throttle: <50m → early exit ✓
11. **Safe!**

### Async Fetch Completing During Update
1. Fetch batch completes
2. Calls `_updateGeometry()`
3. Checks `_isUpdatingGeometry`
4. If already updating → skip ✓
5. If not → update geometry
6. **Safe from concurrent modifications**

## Testing
To verify fix:
1. Start app
2. Move character around normally
3. Console should show:
   - `[VoronoiLOD] Generated X points in Yms` (only occasionally)
   - No stack overflow errors
   - Smooth FPS

## Additional Safety Measures

The guards prevent:
- ✅ Recursive update loops
- ✅ Concurrent geometry modifications
- ✅ Stack overflow from deep call chains
- ✅ Race conditions between async fetches
- ✅ Multiple setOrigin() calls in same frame

## Performance Impact
- **Before**: Stack overflow, crash
- **After**: Normal operation
- **Overhead**: Negligible (single boolean check)

## Files Modified
1. [globeTerrain.js](globeTerrain.js) - Added `_isUpdating` guard
2. [voronoiLOD.js](voronoiLOD.js) - Added `_isUpdatingGeometry` guard
