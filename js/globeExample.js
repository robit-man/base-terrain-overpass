// globeExample.js - Complete example of globe-based terrain system
import * as THREE from 'three';
import { GlobeTerrain } from './globeTerrain.js';
import { GlobeCamera } from './globeCamera.js';

/**
 * Example integration of the globe-based terrain system
 *
 * Usage:
 * ```javascript
 * import { initGlobeTerrain } from './globeExample.js';
 *
 * const { globeTerrain, globeCamera, scene, camera, renderer } = initGlobeTerrain({
 *   container: document.getElementById('app'),
 *   initialLat: 37.7749,
 *   initialLon: -122.4194
 * });
 *
 * // Start render loop
 * function animate() {
 *   requestAnimationFrame(animate);
 *   globeCamera.update();
 *   renderer.render(scene, camera);
 * }
 * animate();
 * ```
 */

export function initGlobeTerrain(opts = {}) {
  const {
    container = document.body,
    initialLat = 37.7749, // San Francisco
    initialLon = -122.4194,
    relayAddress = '',
    spacing = 20, // meters between subdivision points
    tileRadius = 100, // meters per hex tile
    subdivisionLevels = 6 // icosahedron detail
  } = opts;

  // Create scene
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a1628);

  // Create camera
  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    20000000 // 20,000 km view distance
  );

  // Create renderer
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  // Lighting
  const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
  scene.add(ambientLight);

  const directionalLight = new THREE.DirectionalLight(0xffffff, 1.0);
  directionalLight.position.set(1, 1, 1).normalize();
  scene.add(directionalLight);

  // Add sun (distant light source)
  const sunLight = new THREE.DirectionalLight(0xffffee, 0.8);
  sunLight.position.set(1000000, 500000, 500000);
  scene.add(sunLight);

  // Add hemisphere light for better ambient
  const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x0a1628, 0.3);
  scene.add(hemiLight);

  // Create globe terrain system
  console.log('[Example] Initializing globe terrain...');
  const globeTerrain = new GlobeTerrain(scene, {
    spacing,
    tileRadius,
    subdivisionLevels,
    relayAddress,
    dataset: 'mapzen',
    onStatus: (msg, level) => {
      console.log(`[TerrainRelay] ${msg} (${level})`);
    }
  });

  // Create camera controller
  const globeCamera = new GlobeCamera(camera, globeTerrain);

  // Set initial position
  console.log(`[Example] Setting origin to ${initialLat}, ${initialLon}...`);
  globeTerrain.setOrigin(initialLat, initialLon).then(() => {
    console.log('[Example] ✓ Terrain loaded');
    globeCamera.setPosition(initialLat, initialLon);
  });

  // Add stars background
  addStarsBackground(scene);

  // Add atmosphere glow
  addAtmosphereGlow(scene, globeTerrain.globe);

  // Window resize handler
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  // Keyboard controls
  const keys = {};
  window.addEventListener('keydown', (e) => { keys[e.code] = true; });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });

  // Mouse controls for camera rotation
  let mouseDown = false;
  let lastMouseX = 0, lastMouseY = 0;

  renderer.domElement.addEventListener('mousedown', (e) => {
    mouseDown = true;
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
  });

  renderer.domElement.addEventListener('mouseup', () => {
    mouseDown = false;
  });

  renderer.domElement.addEventListener('mousemove', (e) => {
    if (mouseDown) {
      const deltaX = e.clientX - lastMouseX;
      const deltaY = e.clientY - lastMouseY;

      globeCamera.rotate(deltaX * 0.2, deltaY * 0.2);

      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
    }
  });

  // Movement update loop
  function updateMovement() {
    const moveSpeed = 50; // meters per second

    if (keys['KeyW'] || keys['ArrowUp']) {
      globeCamera.moveForward(moveSpeed * 0.016);
    }
    if (keys['KeyS'] || keys['ArrowDown']) {
      globeCamera.moveForward(-moveSpeed * 0.016);
    }
    if (keys['KeyA'] || keys['ArrowLeft']) {
      globeCamera.moveRight(-moveSpeed * 0.016);
    }
    if (keys['KeyD'] || keys['ArrowRight']) {
      globeCamera.moveRight(moveSpeed * 0.016);
    }
  }

  // Stats display
  const statsDiv = document.createElement('div');
  statsDiv.style.position = 'fixed';
  statsDiv.style.top = '10px';
  statsDiv.style.left = '10px';
  statsDiv.style.color = 'white';
  statsDiv.style.fontFamily = 'monospace';
  statsDiv.style.fontSize = '12px';
  statsDiv.style.background = 'rgba(0,0,0,0.7)';
  statsDiv.style.padding = '10px';
  statsDiv.style.borderRadius = '5px';
  container.appendChild(statsDiv);

  function updateStats() {
    const stats = globeTerrain.getStats();
    const pos = globeCamera.getPosition();
    const bearing = globeCamera.getBearing();

    statsDiv.innerHTML = `
      <strong>Globe Terrain System</strong><br>
      Position: ${pos.lat.toFixed(6)}, ${pos.lon.toFixed(6)}<br>
      Bearing: ${bearing.toFixed(1)}°<br>
      Hex Tiles: ${stats.hexTiles}<br>
      Vertices: ${stats.vertices}<br>
      Elevations: ${stats.elevationsFetched}<br>
      Cache: ${stats.cacheSize} points<br>
      <br>
      <strong>Controls:</strong><br>
      WASD / Arrows: Move<br>
      Mouse Drag: Rotate camera
    `;
  }

  setInterval(updateStats, 100);

  // Return control objects
  return {
    scene,
    camera,
    renderer,
    globeTerrain,
    globeCamera,
    updateMovement,

    // Convenience render loop
    startRenderLoop() {
      function animate() {
        requestAnimationFrame(animate);
        updateMovement();
        globeCamera.update();
        renderer.render(scene, camera);
      }
      animate();
    }
  };
}

function addStarsBackground(scene) {
  // Add star field
  const starGeometry = new THREE.BufferGeometry();
  const starCount = 10000;
  const positions = new Float32Array(starCount * 3);

  for (let i = 0; i < starCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const radius = 15000000; // 15,000 km

    positions[i * 3 + 0] = radius * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = radius * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = radius * Math.cos(phi);
  }

  starGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));

  const starMaterial = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 20000,
    sizeAttenuation: true
  });

  const stars = new THREE.Points(starGeometry, starMaterial);
  scene.add(stars);
}

function addAtmosphereGlow(scene, globe) {
  // Add atmospheric glow around Earth
  const EARTH_RADIUS = 6371000;
  const glowGeometry = new THREE.SphereGeometry(EARTH_RADIUS * 1.02, 64, 64);
  const glowMaterial = new THREE.ShaderMaterial({
    transparent: true,
    side: THREE.BackSide,
    uniforms: {
      glowColor: { value: new THREE.Color(0x88ccff) },
      intensity: { value: 0.5 }
    },
    vertexShader: `
      varying vec3 vNormal;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 glowColor;
      uniform float intensity;
      varying vec3 vNormal;
      void main() {
        float glow = pow(0.5 - dot(vNormal, vec3(0, 0, 1.0)), 2.0);
        gl_FragColor = vec4(glowColor, glow * intensity);
      }
    `
  });

  const glowMesh = new THREE.Mesh(glowGeometry, glowMaterial);
  globe.globeGroup.add(glowMesh);
}

// Export for use in other modules
export { GlobeTerrain, GlobeCamera };
