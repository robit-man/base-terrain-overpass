# Voronoi LOD Terrain System

## Overview

The Voronoi LOD (Level of Detail) system provides progressive, adaptive terrain detail on the Earth-scale globe. It uses sparse Voronoi sampling with distance-based density to create high-resolution terrain near the player that smoothly transitions to lower resolution at distance.

## Key Features

1. **Progressive Detail Levels**: 6 LOD levels from ultra-high (2m spacing) to very low (2km spacing)
2. **Sparse Voronoi Sampling**: Fibonacci spiral distribution for even point coverage
3. **Smooth Transitions**: Automatic blending between LOD levels to prevent harsh boundaries
4. **Elevation Fetching**: Automatic batched fetching of terrain elevations
5. **Flush Mapping**: Ultra-high resolution near player for accurate alignment with buildings/character

## Architecture

### Components

#### 1. VoronoiLOD ([voronoiLOD.js](voronoiLOD.js))
- Main LOD management system
- Generates point distributions based on player position
- Manages elevation fetching and caching
- Updates globe geometry with terrain data

#### 2. LODBlending ([lodBlending.js](lodBlending.js))
- Smooth transitions between LOD levels
- Point density fade-out at boundaries
- Elevation smoothing
- Deterministic pseudo-random blending

#### 3. DynamicGeometry ([dynamicGeometry.js](dynamicGeometry.js))
- Optional: Dynamically adds vertices to globe mesh
- Delaunay triangulation for new vertices
- More complex but provides true adaptive subdivision

## LOD Levels (Default Configuration)

| Level | Max Distance | Spacing | Use Case |
|-------|-------------|---------|----------|
| 0 | 100m | 2m | Ultra-high detail: Flush with character/buildings |
| 1 | 500m | 5m | Very high detail: Immediate surroundings |
| 2 | 2km | 20m | High detail: Nearby terrain |
| 3 | 10km | 100m | Medium detail: Mid-range visibility |
| 4 | 50km | 500m | Low detail: Distant terrain |
| 5 | 200km | 2km | Very low detail: Far horizon |

## How It Works

### 1. Point Distribution

The system generates sample points in concentric annular rings around the player:

```
Player → [Ultra-high density] → [High density] → [Medium] → [Low] → [Very low]
         └─ 0-100m (2m) ─┘ └ 100-500m (5m) ┘  └ ... ┘
```

Points are distributed using a **Fibonacci spiral** for even coverage:
- Provides better distribution than regular grids
- Avoids clustering and gaps
- Maintains consistent point density within each ring

### 2. Elevation Fetching

When new points are generated:
1. Check elevation cache (by geohash)
2. If not cached, add to fetch queue
3. Batch fetch elevations (100 points at a time)
4. Cache results for future use
5. Apply to geometry

### 3. Geometry Updates

Two modes available:

#### A. Nearest-Vertex Mode (Default)
- Simpler and more stable
- Finds nearest sphere vertex for each Voronoi point
- Applies elevation by moving vertex radially
- Works with existing icosahedron subdivision

#### B. Dynamic-Vertex Mode (Advanced)
- Actually adds new vertices to geometry
- Uses Delaunay triangulation to integrate
- Provides true adaptive subdivision
- More complex, requires careful management

### 4. Smooth Transitions

LOD boundaries use multiple techniques:
- **Point fading**: Deterministically fade out points at boundaries
- **Smoothstep interpolation**: Smooth elevation blending
- **Blend zones**: 50m transition zones between levels

## Integration

### Basic Setup (Already Integrated in Globe)

The VoronoiLOD is automatically initialized in [globe.js](globe.js:40-50):

```javascript
this.voronoiLOD = new VoronoiLOD(this, {
  lodLevels: [...], // 6 levels defined
  mode: 'nearest',  // or 'dynamic'
  blendZoneWidth: 50,
  morphingEnabled: true
});
```

### Usage

The system automatically updates when player position changes:

```javascript
// In Globe.setOrigin() and Globe.updatePlayerPosition()
this.voronoiLOD.updatePlayerPosition(worldPosition, { lat, lon });
```

No manual intervention needed - the system handles everything automatically!

## Performance Characteristics

### Point Counts (Approximate)

With default settings, around player:
- 0-100m: ~1,250 points (π × 100² / 2² spacing)
- 100-500m: ~10,000 points
- 2-10km: ~15,000 points
- **Total: ~50,000-80,000 points** across all LOD levels

### Optimizations

1. **Update Throttling**: Only updates when player moves >10m
2. **Batched Fetching**: 100 elevations per request
3. **Geohash Caching**: Permanent elevation cache
4. **Fibonacci Spiral**: O(n) point generation
5. **Spatial Queries**: Only searches base vertices

### Memory Usage

- ~2-4 MB for point data (50k-80k points)
- ~1-2 MB for elevation cache (depends on coverage)
- Minimal geometry overhead (nearest mode)
- Dynamic mode adds vertex memory (not recommended initially)

## Configuration Options

### Custom LOD Levels

```javascript
const customLevels = [
  { maxDistance: 50, spacing: 1 },     // Even higher detail close-up
  { maxDistance: 200, spacing: 4 },
  { maxDistance: 1000, spacing: 15 },
  { maxDistance: 5000, spacing: 75 },
  { maxDistance: 25000, spacing: 400 }
];

const voronoi = new VoronoiLOD(globe, {
  lodLevels: customLevels
});
```

### Blend Zone Width

Control transition smoothness:

```javascript
const voronoi = new VoronoiLOD(globe, {
  blendZoneWidth: 100 // Wider = smoother but more overdraw
});
```

### Update Threshold

Control update frequency:

```javascript
voronoi.updateThreshold = 5; // Update every 5m of movement
```

## Debugging

### Stats

Get current state:

```javascript
const stats = globe.voronoiLOD.getStats();
console.log(stats);
// {
//   voronoiPoints: 65432,
//   elevationsCached: 45123,
//   fetchQueueSize: 0,
//   fetching: false,
//   mode: 'nearest'
// }
```

### Visualize Distribution

Add this to see point distribution (for debugging):

```javascript
// In voronoiLOD.js _generateVoronoiDistribution()
console.log('LOD Level Distribution:');
this.lodLevels.forEach((level, i) => {
  const count = Array.from(newPoints.values())
    .filter(p => p.lodLevel === i).length;
  console.log(`  Level ${i} (${level.spacing}m): ${count} points`);
});
```

## Flush Mapping with Local Terrain

The **ultra-high detail level (0-100m, 2m spacing)** ensures terrain is flush with local buildings and character:

### How It Works

1. **Fine Granularity**: 2m point spacing matches typical building/object scale
2. **Dense Sampling**: ~1,250 sample points within 100m radius
3. **Real Elevations**: Each point fetches actual terrain elevation
4. **Vertex Density**: Globe base mesh has sufficient vertices from subdivision

### Requirements for Perfect Alignment

To ensure flush alignment:

1. **Globe Subdivision**: Use `subdivisionLevels: 6` or higher
   - Level 6 = ~40,000 vertices on sphere
   - Level 7 = ~160,000 vertices (better but slower)

2. **Terrain Relay**: Must be configured and working
   ```javascript
   globe.terrainRelay = new TerrainRelay({
     defaultRelay: 'https://your-terrain-server.com',
     dataset: 'mapzen'
   });
   ```

3. **Local Frame Alignment**: Ensure GlobeTerrain's local frame is correct
   - This aligns globe coordinates with local XZ plane
   - Already handled in [globeTerrain.js](globeTerrain.js:124-170)

## Troubleshooting

### Terrain Not Updating
- Check `terrainRelay` is set: `globe.voronoiLOD.terrainRelay`
- Verify relay address is correct
- Check network console for fetch errors

### Harsh LOD Boundaries
- Increase `blendZoneWidth` (default: 50m)
- Check `morphingEnabled` is true
- Verify points are being faded (check stats)

### Low Performance
- Reduce number of LOD levels
- Increase spacing in high levels
- Use `mode: 'nearest'` instead of `'dynamic'`
- Increase `updateThreshold` to reduce update frequency

### Terrain Not Flush
- Increase globe `subdivisionLevels` (6 or 7)
- Reduce ultra-high detail spacing (1m instead of 2m)
- Verify elevations are being fetched (check cache size)

## Future Enhancements

Potential improvements:

1. **GPU-based Tessellation**: Move subdivision to shaders
2. **Quadtree Tiling**: Replace rings with adaptive quadtree
3. **Displacement Mapping**: Use texture-based displacement
4. **Occlusion Culling**: Skip points behind terrain
5. **Temporal Coherence**: Reuse vertices between frames

## References

- Fibonacci Spiral Distribution: https://en.wikipedia.org/wiki/Fermat%27s_spiral
- Delaunay Triangulation: https://en.wikipedia.org/wiki/Delaunay_triangulation
- LOD Geomorphing: https://developer.nvidia.com/gpugems/gpugems2/part-i-geometric-complexity/chapter-2-terrain-rendering-using-gpu-based-geometry
