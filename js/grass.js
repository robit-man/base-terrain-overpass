// Grass rendering system for terrain tiles
// Based on three-grass-demo by github.com/Domenicobrz
import * as THREE from 'three';

// Inline shaders to avoid MIME type issues with GLSL imports
const grassVertShader = `
varying vec2 vUv;
varying vec2 cloudUV;
varying vec3 vColor;
uniform float iTime;

void main() {
  vUv = uv;
  cloudUV = uv;
  vColor = color;
  vec3 cpos = position;

  float waveSize = 10.0;
  float tipDistance = 0.3;
  float centerDistance = 0.1;

  // Wind animation based on vertex color (tip=white, center=gray, base=black)
  if (color.x > 0.6) {
    cpos.x += sin((iTime / 500.) + (uv.x * waveSize)) * tipDistance;
  } else if (color.x > 0.0) {
    cpos.x += sin((iTime / 500.) + (uv.x * waveSize)) * centerDistance;
  }

  float diff = position.x - cpos.x;
  cloudUV.x += iTime / 20000.;
  cloudUV.y += iTime / 10000.;

  vec4 worldPosition = vec4(cpos, 1.);
  vec4 mvPosition = projectionMatrix * modelViewMatrix * vec4(cpos, 1.0);
  gl_Position = mvPosition;
}
`;

const grassFragShader = `
uniform sampler2D textures[2];

varying vec2 vUv;
varying vec2 cloudUV;
varying vec3 vColor;

void main() {
  float contrast = 1.5;
  float brightness = 0.1;
  vec3 color = texture2D(textures[0], vUv).rgb * contrast;
  color = color + vec3(brightness, brightness, brightness);
  color = mix(color, texture2D(textures[1], cloudUV).rgb, 0.4);
  gl_FragColor.rgb = color;
  gl_FragColor.a = 1.;
}
`;

export class GrassManager {
  constructor({ scene, tileManager } = {}) {
    this.scene = scene;
    this.tileManager = tileManager;

    // Grass parameters
    this.BLADE_WIDTH = 0.08;
    this.BLADE_HEIGHT = 0.6;
    this.BLADE_HEIGHT_VARIATION = 0.4;
    this.BLADE_SEGMENTS = 5; // Vertices per blade
    this.DENSITY_MULTIPLIER = 1.0; // Global grass density control

    // Performance settings
    this.enabled = true;
    this.maxBladesPerTile = 5000;
    this.lodDistances = {
      high: 100,   // Full density
      medium: 200, // 50% density
      low: 300,    // 25% density
      none: 400    // No grass
    };

    // Time uniform for wind animation
    this.startTime = Date.now();
    this.timeUniform = { type: 'f', value: 0.0 };

    // Material setup
    this._setupMaterial();

    // Tile grass tracking
    this.tileGrass = new Map(); // Map of tile key -> grass mesh
  }

  _setupMaterial() {
    // Create simple grass texture (green gradient)
    const grassCanvas = document.createElement('canvas');
    grassCanvas.width = 64;
    grassCanvas.height = 64;
    const ctx = grassCanvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 0, 64);
    gradient.addColorStop(0, '#5a8f3a');
    gradient.addColorStop(0.5, '#4a7a2a');
    gradient.addColorStop(1, '#3a6a1a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 64, 64);
    const grassTexture = new THREE.CanvasTexture(grassCanvas);

    // Create cloud texture for variation
    const cloudCanvas = document.createElement('canvas');
    cloudCanvas.width = 128;
    cloudCanvas.height = 128;
    const cctx = cloudCanvas.getContext('2d');
    cctx.fillStyle = '#ffffff';
    cctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 100; i++) {
      const x = Math.random() * 128;
      const y = Math.random() * 128;
      const radius = Math.random() * 20 + 10;
      const alpha = Math.random() * 0.3 + 0.1;
      cctx.fillStyle = `rgba(200, 200, 200, ${alpha})`;
      cctx.beginPath();
      cctx.arc(x, y, radius, 0, Math.PI * 2);
      cctx.fill();
    }
    const cloudTexture = new THREE.CanvasTexture(cloudCanvas);
    cloudTexture.wrapS = cloudTexture.wrapT = THREE.RepeatWrapping;

    // Shader material
    const grassUniforms = {
      textures: { value: [grassTexture, cloudTexture] },
      iTime: this.timeUniform
    };

    this.grassMaterial = new THREE.ShaderMaterial({
      uniforms: grassUniforms,
      vertexShader: grassVertShader,
      fragmentShader: grassFragShader,
      vertexColors: true,
      side: THREE.DoubleSide,
      transparent: false
    });
  }

  update(deltaTime) {
    if (!this.enabled) return;

    // Update time uniform for wind animation
    const elapsedTime = Date.now() - this.startTime;
    this.timeUniform.value = elapsedTime;
  }

  /**
   * Generate grass for a tile based on green sample points
   * @param {Object} tile - Tile object
   * @param {Array} greenSamples - Array of {u, v} coordinates in [0,1] range
   * @param {Object} bounds - Tile lat/lon bounds
   */
  generateGrassForTile(tile, greenSamples, bounds) {
    if (!this.enabled || !greenSamples || greenSamples.length === 0) {
      this.removeGrassForTile(tile);
      return;
    }

    const tileKey = `${tile.q},${tile.r}`;

    // Remove existing grass
    this.removeGrassForTile(tile);

    // Calculate blade count based on samples and density
    const baseBladeCount = Math.min(greenSamples.length * 20, this.maxBladesPerTile);
    const bladeCount = Math.round(baseBladeCount * this.DENSITY_MULTIPLIER);

    if (bladeCount === 0) return;

    // Generate grass geometry
    const geometry = this._generateGrassGeometry(tile, greenSamples, bladeCount, bounds);
    if (!geometry) return;

    // Create mesh
    const mesh = new THREE.Mesh(geometry, this.grassMaterial);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.frustumCulled = true;
    mesh.name = `grass-${tileKey}`;

    // Add to tile group
    tile.grid.group.add(mesh);

    // Track
    this.tileGrass.set(tileKey, { mesh, tile, bladeCount });
  }

  _generateGrassGeometry(tile, greenSamples, bladeCount, bounds) {
    const positions = [];
    const uvs = [];
    const indices = [];
    const colors = [];

    const tileRadius = tile._radiusOverride ?? this.tileManager?.tileRadius ?? 100;
    const center = tile.grid.group.position;

    // Sample green areas to place grass blades
    const used = new Set();
    let placedCount = 0;

    for (let attempt = 0; attempt < bladeCount * 3 && placedCount < bladeCount; attempt++) {
      // Pick random green sample
      const sample = greenSamples[Math.floor(Math.random() * greenSamples.length)];

      // Add some jitter within the sample area
      const jitter = 0.02; // 2% of tile size
      const u = THREE.MathUtils.clamp(sample.u + (Math.random() - 0.5) * jitter, 0, 1);
      const v = THREE.MathUtils.clamp(sample.v + (Math.random() - 0.5) * jitter, 0, 1);

      // Convert to world position
      const worldPos = this._uvToWorldPosition(u, v, bounds, center, tileRadius);
      if (!worldPos) continue;

      // Check if position is within tile radius
      const dx = worldPos.x - center.x;
      const dz = worldPos.z - center.z;
      const distSq = dx * dx + dz * dz;
      if (distSq > tileRadius * tileRadius) continue;

      // Avoid duplicates
      const key = `${Math.round(worldPos.x * 10)},${Math.round(worldPos.z * 10)}`;
      if (used.has(key)) continue;
      used.add(key);

      // Get ground height
      const groundY = this.tileManager?.getHeightAt(worldPos.x, worldPos.z);
      if (!Number.isFinite(groundY)) continue;

      // Convert to local coordinates
      // Offset grass base slightly below terrain surface for proper embedding
      const grassBaseOffset = -0.15; // Push base 15cm underground
      const localPos = new THREE.Vector3(
        worldPos.x - center.x,
        groundY + grassBaseOffset,
        worldPos.z - center.z
      );

      // Generate blade geometry
      const blade = this._generateBlade(localPos, placedCount * this.BLADE_SEGMENTS, [u, v]);
      blade.verts.forEach(vert => {
        positions.push(...vert.pos);
        uvs.push(...vert.uv);
        colors.push(...vert.color);
      });
      blade.indices.forEach(index => indices.push(index));

      placedCount++;
    }

    if (positions.length === 0) return null;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
    geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colors), 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    return geometry;
  }

  _generateBlade(center, vArrOffset, uv) {
    const MID_WIDTH = this.BLADE_WIDTH * 0.5;
    const TIP_OFFSET = 0.1;
    const height = this.BLADE_HEIGHT + (Math.random() * this.BLADE_HEIGHT_VARIATION);

    const yaw = Math.random() * Math.PI * 2;
    const yawUnitVec = new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw));
    const tipBend = Math.random() * Math.PI * 2;
    const tipBendUnitVec = new THREE.Vector3(Math.sin(tipBend), 0, -Math.cos(tipBend));

    // Find the Bottom Left, Bottom Right, Top Left, Top Right, Top Center vertex positions
    const bl = new THREE.Vector3().addVectors(center, new THREE.Vector3().copy(yawUnitVec).multiplyScalar((this.BLADE_WIDTH / 2) * 1));
    const br = new THREE.Vector3().addVectors(center, new THREE.Vector3().copy(yawUnitVec).multiplyScalar((this.BLADE_WIDTH / 2) * -1));
    const tl = new THREE.Vector3().addVectors(center, new THREE.Vector3().copy(yawUnitVec).multiplyScalar((MID_WIDTH / 2) * 1));
    const tr = new THREE.Vector3().addVectors(center, new THREE.Vector3().copy(yawUnitVec).multiplyScalar((MID_WIDTH / 2) * -1));
    const tc = new THREE.Vector3().addVectors(center, new THREE.Vector3().copy(tipBendUnitVec).multiplyScalar(TIP_OFFSET));

    tl.y += height / 2;
    tr.y += height / 2;
    tc.y += height;

    // Vertex Colors (used for wind animation)
    const black = [0, 0, 0];   // Base (no movement)
    const gray = [0.5, 0.5, 0.5]; // Middle (slight movement)
    const white = [1.0, 1.0, 1.0]; // Tip (max movement)

    const verts = [
      { pos: bl.toArray(), uv: uv, color: black },
      { pos: br.toArray(), uv: uv, color: black },
      { pos: tr.toArray(), uv: uv, color: gray },
      { pos: tl.toArray(), uv: uv, color: gray },
      { pos: tc.toArray(), uv: uv, color: white }
    ];

    const indices = [
      vArrOffset,
      vArrOffset + 1,
      vArrOffset + 2,
      vArrOffset + 2,
      vArrOffset + 4,
      vArrOffset + 3,
      vArrOffset + 3,
      vArrOffset,
      vArrOffset + 2
    ];

    return { verts, indices };
  }

  _uvToWorldPosition(u, v, bounds, center, tileRadius) {
    if (!bounds || !this.tileManager?.origin) return null;

    const { lonMin, lonMax, latMin, latMax } = bounds;
    const lon = lonMin + (lonMax - lonMin) * u;
    const lat = latMax - (latMax - latMin) * v;

    // Convert lat/lon to world coordinates using approximate method
    // This matches the tile manager's approach
    const R = 6371000; // Earth radius in meters
    const originLat = this.tileManager.origin.lat;
    const originLon = this.tileManager.origin.lon;

    const dLat = lat - originLat;
    const dLon = lon - originLon;

    const x = dLon * R * Math.cos((originLat * Math.PI) / 180) * (Math.PI / 180);
    const z = -dLat * R * (Math.PI / 180);

    return { x, z };
  }

  removeGrassForTile(tile) {
    const tileKey = `${tile.q},${tile.r}`;
    const grassData = this.tileGrass.get(tileKey);

    if (grassData) {
      // Remove from scene
      if (grassData.mesh.parent) {
        grassData.mesh.parent.remove(grassData.mesh);
      }

      // Dispose geometry
      if (grassData.mesh.geometry) {
        grassData.mesh.geometry.dispose();
      }

      this.tileGrass.delete(tileKey);
    }
  }

  dispose() {
    // Remove all grass
    for (const [tileKey, grassData] of this.tileGrass.entries()) {
      if (grassData.mesh.parent) {
        grassData.mesh.parent.remove(grassData.mesh);
      }
      if (grassData.mesh.geometry) {
        grassData.mesh.geometry.dispose();
      }
    }
    this.tileGrass.clear();

    // Dispose material
    if (this.grassMaterial) {
      this.grassMaterial.dispose();
    }
  }
}
