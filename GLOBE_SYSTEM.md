# Globe-Based Terrain System

## Overview

Complete rewrite of the terrain system using an **Earth-sized sphere** (6,371km radius) with geographically-accurate subdivision and elevation mapping.

**Key Principle**: 1 Three.js unit = 1 meter

## Architecture

### Core Components

#### 1. **globe.js** - Earth Sphere Foundation
- Creates icosahedron geometry at Earth scale (6,371,000 meters radius)
- Handles lat/lon ↔ 3D position conversion
- Applies elevation radially from Earth's center
- Manages elevation caching by geohash

#### 2. **globeTerrain.js** - Hexagonal Subdivision Integration
- Uses hexagonal tile logic from `tiles.js` to determine WHERE to subdivide sphere
- Creates rings of hex tiles (interactive, visual, farfield)
- Generates subdivision points for each hex tile
- Fetches elevation data in batches
- Maps hex points to nearest sphere vertices

#### 3. **globeCamera.js** - Sphere-Aware Camera Controller
- Positions camera relative to sphere surface
- Handles movement along great circles
- Maintains local coordinate frame (north/east/up)
- Supports bearing and pitch control

#### 4. **globeExample.js** - Complete Integration Example
- Shows how to initialize and use the system
- Includes keyboard/mouse controls
- Adds stars, atmosphere, lighting
- Real-time stats display

## File Structure

```
base-terrain-overpass/js/
├── globe.js                 # Earth sphere with elevation mapping
├── globeTerrain.js          # Hex subdivision on sphere surface
├── globeCamera.js           # Camera controller for sphere
├── globeExample.js          # Complete working example
├── GLOBE_INTEGRATION.md     # Integration guide
└── terrainRelay.js          # Elevation data fetching (enhanced)
```

## Mathematical Foundation

### Lat/Lon → Sphere Position

```javascript
latLonToSphere(lat, lon, radius = EARTH_RADIUS) {
  // Spherical to Cartesian conversion
  const phi = degToRad(90 - lat);      // Polar angle from north pole
  const theta = degToRad(lon + 180);   // Azimuthal angle

  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  const y = radius * Math.cos(phi);

  return new THREE.Vector3(x, y, z);
}
```

### Sphere Position → Lat/Lon

```javascript
sphereToLatLon(position) {
  const normalized = position.clone().normalize();

  // Polar angle → Latitude
  const phi = Math.acos(clamp(normalized.y, -1, 1));
  const lat = 90 - radToDeg(phi);

  // Azimuthal angle → Longitude
  const theta = Math.atan2(normalized.z, -normalized.x);
  let lon = radToDeg(theta) - 180;
  lon = ((lon + 540) % 360) - 180; // Normalize to [-180, 180]

  return { lat, lon };
}
```

### Elevation Application

```javascript
// Move vertex radially outward from Earth center
const direction = vertexPosition.clone().normalize();
const elevatedPosition = direction.multiplyScalar(EARTH_RADIUS + elevation);
```

## Usage

### Basic Initialization

```javascript
import { initGlobeTerrain } from './globeExample.js';

const { globeTerrain, globeCamera, startRenderLoop } = initGlobeTerrain({
  container: document.getElementById('app'),
  initialLat: 37.7749,  // San Francisco
  initialLon: -122.4194,
  spacing: 20,          // 20 meters between subdivision points
  tileRadius: 100,      // 100 meter hex tiles
  subdivisionLevels: 6  // Icosahedron detail
});

// Start render loop
startRenderLoop();
```

### Manual Setup

```javascript
import { GlobeTerrain } from './globeTerrain.js';
import { GlobeCamera } from './globeCamera.js';

// Create terrain
const globeTerrain = new GlobeTerrain(scene, {
  spacing: 20,
  tileRadius: 100,
  subdivisionLevels: 6,
  relayAddress: 'your-nkn-relay-address'
});

// Set origin (triggers subdivision and elevation fetch)
await globeTerrain.setOrigin(37.7749, -122.4194);

// Create camera controller
const globeCamera = new GlobeCamera(camera, globeTerrain);
globeCamera.setPosition(37.7749, -122.4194);

// Render loop
function animate() {
  requestAnimationFrame(animate);
  globeCamera.update(deltaTime);
  renderer.render(scene, camera);
}
```

## How It Works

### 1. Sphere Creation

```
Earth-sized icosahedron (6,371 km radius)
    ↓
Subdivided into triangular faces (configurable detail)
    ↓
Equirectangular UV mapping applied
    ↓
Base sphere mesh created
```

### 2. Hexagonal Subdivision

```
Player sets origin (lat, lon)
    ↓
Create hex tiles in rings around player:
  - Interactive: 2 rings (closest, high detail)
  - Visual: 4 rings (medium distance, medium detail)
  - Farfield: 8 rings (distant, low detail)
    ↓
Each hex tile generates subdivision points
  - Interactive: 20 points per side
  - Visual: 10 points per side
  - Farfield: 5 points per side
    ↓
Points distributed in hexagonal pattern
```

### 3. Elevation Fetching

```
Collect all subdivision points from all tiles
    ↓
Convert lat/lon to geohashes
    ↓
Batch points (100 per batch)
    ↓
Query terrain relay (NKN → WebSocket → OpenTopoData)
    ↓
Store elevations in tile data
```

### 4. Sphere Vertex Mapping

```
For each hex subdivision point:
    ↓
Calculate sphere position (lat/lon → 3D)
    ↓
Find nearest vertex in sphere geometry
    ↓
Apply elevation radially:
  newPos = direction * (EARTH_RADIUS + elevation)
    ↓
Update vertex position
    ↓
Recompute normals for lighting
```

### 5. Camera Positioning

```
Get player position on sphere (with elevation)
    ↓
Calculate local coordinate frame:
  - up: radial direction
  - north: towards north pole (tangent)
  - east: cross(up, north)
    ↓
Position camera: behind and above player
    ↓
Look-at: ahead of player on surface
```

## Controls

- **WASD / Arrow Keys**: Move along sphere surface
- **Mouse Drag**: Rotate camera (change bearing/pitch)
- **Automatic**: Re-subdivision when player moves > 50km

## Performance

### Subdivision Levels

| Level | Vertices | Faces | Use Case |
|-------|----------|-------|----------|
| 3 | 162 | 320 | Testing |
| 4 | 642 | 1,280 | Low detail |
| 5 | 2,562 | 5,120 | Medium detail |
| 6 | 10,242 | 20,480 | High detail |
| 7 | 40,962 | 81,920 | Very high detail |

### Hex Tile Settings

| Spacing | Points per Tile (Interactive) | Total Points (2 rings) |
|---------|-------------------------------|------------------------|
| 10m | ~314 | ~4,710 |
| 20m | ~78 | ~1,170 |
| 50m | ~12 | ~180 |

**Recommendation**: Start with level 6, spacing 20m for good balance.

## Key Differences from Old System

| Feature | Old (Flat Tiles) | New (Globe) |
|---------|------------------|-------------|
| **Geometry** | Flat XZ plane | Earth sphere |
| **Scale** | Local coordinates | Earth scale (6,371 km) |
| **Units** | Arbitrary | 1 unit = 1 meter |
| **Elevation** | Move in +Y | Radial from center |
| **Geography** | Approximate | WGS84 accurate |
| **Curvature** | Flat | Natural sphere |
| **Wrapping** | Edge problems | Seamless |
| **Distance** | Euclidean | Great circle |

## Elevation Data Flow

```
1. NKN Relay (primary)
      ↓ timeout/fail
2. WebSocket (secondary)
      ↓ timeout/fail
3. OpenTopoData API (final fallback)
      ↓ success
Store in elevation cache (Map<geohash, elevation>)
      ↓
Apply to sphere vertices
```

## Future Enhancements

- [ ] Dynamic LOD (subdivide only visible areas)
- [ ] Texture mapping (day/night textures like demo)
- [ ] Atmospheric scattering
- [ ] Cloud layer
- [ ] Ocean rendering (separate water sphere)
- [ ] Adaptive subdivision (more detail near player)
- [ ] Normal mapping for micro-detail
- [ ] Shadow mapping from sun
- [ ] GeoJSON overlay (borders, roads)

## Debugging

Enable debug logging:
```javascript
globeTerrain.globe.debug = true;
globeCamera.debug = true;
```

Check stats:
```javascript
const stats = globeTerrain.getStats();
console.log(stats);
// {
//   patches: 0,
//   vertices: 10242,
//   elevationsFetched: 1170,
//   cacheHits: 450,
//   hexTiles: 15,
//   origin: { lat: 37.7749, lon: -122.4194 }
// }
```

## Credits

Inspired by:
- **geojson-geohash-demo/index.html** - Sphere coordinate mapping
- **tiles.js** - Hexagonal subdivision logic
- **WGS84** - World Geodetic System 1984

## License

Same as parent project
