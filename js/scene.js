import * as THREE from 'three';
import { VRButton } from 'VRButton';
import { Sky } from 'Sky';

export class SceneManager {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(devicePixelRatio);
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.physicallyCorrectLights = true;
    this.renderer.xr.enabled = true;
    try {
      this.renderer.xr.setReferenceSpaceType?.('local-floor');
    } catch (_) {
      this.renderer.xr.setReferenceSpaceType?.('local');
    }
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    document.body.appendChild(this.renderer.domElement);
    document.body.appendChild(VRButton.createButton(this.renderer));

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene = new THREE.Scene();

    // 🎯 Camera stays at (0,0,0) in dolly local space; dolly handles eye height
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 22000);
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);

    // Dolly = player rig; add camera as a child (critical for chasecam & FPV)
    this.dolly = new THREE.Group();
    this.dolly.name = 'player-dolly';
    this.dolly.add(this.camera);
    this.scene.add(this.dolly);

    // Sky & sun lighting
    this.sky = new Sky();
    this.sky.scale.setScalar(60000);
    this.scene.add(this.sky);
    const skyUniforms = this.sky.material.uniforms;
    skyUniforms['turbidity'].value = 2.5;
    skyUniforms['rayleigh'].value = 1.2;
    skyUniforms['mieCoefficient'].value = 0.004;
    skyUniforms['mieDirectionalG'].value = 0.95;

    this.sunLight = new THREE.DirectionalLight(0xffffff, 4);
    this.sunLight.position.set(1000, 500, -800);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(4096, 4096);
    this.sunLight.shadow.camera.near = 10;
    this.sunLight.shadow.camera.far = 1800;
    this.sunLight.shadow.camera.left = -600;
    this.sunLight.shadow.camera.right = 600;
    this.sunLight.shadow.camera.top = 600;
    this.sunLight.shadow.camera.bottom = -600;
    this.sunLight.shadow.bias = -0.00015;
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.ambient = new THREE.AmbientLight(0x1e212b, 0.18);
    this.scene.add(this.ambient);

    // Where remote avatars live
    this.remoteLayer = new THREE.Group();
    this.remoteLayer.name = 'remote-layer';
    this.scene.add(this.remoteLayer);

    this._skyEnvTarget = null;

    // ---- Tile radius sampling (used for fog near/far) ----
    // You can override with setTileRadiusSource(number | () => number)
    this._tileRadiusSource = 4000; // fallback

    // ---- Sky probe (offscreen) to sample horizon color ----
    this._initSkyProbe();

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    this.updateSun({ lat: 0, lon: 0, date: new Date() });
  }

  // Public API to supply tile radius (number) or a function that returns a number each call.
  setTileRadiusSource(src) {
    this._tileRadiusSource = src;
    if (this.currentSunAltitude !== undefined) this._syncFogToSky();
  }

  // ---------- SKY PROBE: offscreen sampling ----------
  _initSkyProbe() {
    // Small target; linear color (default), no depth/stencil needed
    const S = 64;
    this._probeSize = S;
    this._probeRT = new THREE.WebGLRenderTarget(S, S, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType
    });

    // Separate scene with a Sky sharing the SAME material (so uniforms track)
    this._probeScene = new THREE.Scene();
    this._probeSky = new Sky();
    this._probeSky.scale.setScalar(60000);
    this._probeSky.material = this.sky.material; // share the material/uniforms
    this._probeScene.add(this._probeSky);

    // Level camera; horizon sits at vertical center when level
    this._probeCamera = new THREE.PerspectiveCamera(75, 1, 1, 100000);
    this._probeCamera.position.set(0, 0, 0);
    this._probeCamera.up.set(0, 1, 0);
    this._probeCamera.lookAt(new THREE.Vector3(0, 0, -1));

    // Buffer reused for reads
    this._probePixels = new Uint8Array(S * S * 4);

    // Last good color fallback
    this._lastFogColor = new THREE.Color(0x223344);
  }

  _sampleSkyHorizonColor() {
    const rt = this._probeRT;
    const S = this._probeSize;

    // Save renderer state
    const prevRT = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    const prevClearColor = new THREE.Color();
    const prevClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(prevClearColor);

    // Render sky-only to offscreen
    this.renderer.setRenderTarget(rt);
    this.renderer.autoClear = true;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.clear();
    this.renderer.render(this._probeScene, this._probeCamera);

    // Read pixels
    this.renderer.readRenderTargetPixels(rt, 0, 0, S, S, this._probePixels);

    // Restore renderer state
    this.renderer.setRenderTarget(prevRT);
    this.renderer.setClearColor(prevClearColor, prevClearAlpha);
    this.renderer.autoClear = prevAutoClear;

    // Sample a thin band just BELOW the horizon (center - small offset)
    const offset = Math.max(1, Math.floor(S * 0.02)); // ~2% of height
    const horizonRow = Math.max(0, Math.min(S - 1, Math.floor(S * 0.5) - offset));

    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    // Average across 3 rows to smooth, skip edges
    for (let dy = 0; dy < 3; dy++) {
      const y = Math.max(0, Math.min(S - 1, horizonRow - dy));
      for (let x = 2; x < S - 2; x++) {
        const idx = (y * S + x) * 4;
        rSum += this._probePixels[idx + 0];
        gSum += this._probePixels[idx + 1];
        bSum += this._probePixels[idx + 2];
        count++;
      }
    }

    if (count === 0) return this._lastFogColor.clone();

    // Pixels are in linear space (target encoding is LinearEncoding)
    const r = (rSum / count) / 255;
    const g = (gSum / count) / 255;
    const b = (bSum / count) / 255;

    // Guard against fully transparent/black clears (shouldn't happen since Sky fills)
    const c = (r + g + b) > 0.0001 ? new THREE.Color(r, g, b) : this._lastFogColor.clone();
    this._lastFogColor.copy(c);
    return c;
  }

  // ---------- Tile radius helpers & fog distances ----------
  _sampleTileRadius() {
    const src = this._tileRadiusSource;
    let r = (typeof src === 'function') ? src() : src;
    if (!isFinite(r) || r <= 0) r = 4000;
    return r;
  }

  // Start close for atmospheric perspective; scale far with tile radius; tighten at night/haze
  _computeFogDistances(tileRadius, altitude, turbidity) {
    const R = tileRadius;

    const altDeg = THREE.MathUtils.radToDeg(altitude ?? 0);
    const night = 1 - THREE.MathUtils.smoothstep(altDeg, -12, 10); // 0 day -> 1 night
    const haze  = THREE.MathUtils.clamp((turbidity - 2) / 8, 0, 1);

    const nearBase = THREE.MathUtils.clamp(R * 0.012, 10, 40);      // ~10–40m typical
    let near = nearBase * (1 - 0.35 * haze) * (1 - 0.25 * night);

    const farBase = R * 1.45;
    let far = farBase * (1 - 0.18 * haze - 0.28 * night);

    // Clamp and keep healthy separation
    const EPS = 5;
    near = THREE.MathUtils.clamp(near, this.camera.near + EPS, this.camera.far - EPS);
    far  = THREE.MathUtils.clamp(far,  near + 150,          this.camera.far - EPS);

    return { near, far };
  }

  _syncFogToSky() {
    const turbidity = this.sky?.material?.uniforms?.turbidity?.value ?? 2.5;

    // 🔍 Sample the true horizon color from the Sky shader
    const fogColor = this._sampleSkyHorizonColor();

    // Distances based on tile radius + atmosphere
    const tileRadius = this._sampleTileRadius();
    const { near, far } = this._computeFogDistances(tileRadius, this.currentSunAltitude ?? 0, turbidity);

    if (!this.scene.fog) {
      this.scene.fog = new THREE.Fog(fogColor.clone(), near, far);
    } else {
      this.scene.fog.color.copy(fogColor);
      this.scene.fog.near = near;
      this.scene.fog.far  = far;
    }

    // Match clear color so sky/fog blend seamlessly at edges
    this.renderer.setClearColor(fogColor, 1);

    // Ensure Sky is visible (not a solid color background)
    if (this.scene.background && this.scene.background.isColor) {
      this.scene.background = null;
    }
  }

  updateSun({
    lat = 0,
    lon = 0,
    date = new Date(),
    turbidity = 2.5,
    rayleigh = 1.2,
    mieCoefficient = 0.004,
    mieDirectionalG = 0.95,
  } = {}) {
    const { direction, altitude } = this._computeSunDirection(lat, lon, date);
    const target = new THREE.Vector3(0, 0, 0);

    this.sunLight.position.copy(direction).multiplyScalar(4000);
    this.sunLight.target.position.copy(target);
    this.sunLight.target.updateMatrixWorld();

    const sunStrength = Math.max(0, Math.sin(altitude));
    this.sunLight.intensity = THREE.MathUtils.lerp(0.05, 6.5, THREE.MathUtils.clamp(sunStrength + 0.2, 0, 1));
    this.sunLight.visible = altitude > -0.35;
    this.ambient.intensity = THREE.MathUtils.lerp(0.05, 0.22, THREE.MathUtils.clamp(sunStrength + 0.3, 0, 1));

    const uniforms = this.sky.material.uniforms;
    uniforms['turbidity'].value = turbidity;
    uniforms['rayleigh'].value = rayleigh;
    uniforms['mieCoefficient'].value = mieCoefficient;
    uniforms['mieDirectionalG'].value = mieDirectionalG;
    uniforms['sunPosition'].value.copy(direction.clone().multiplyScalar(45000));

    this.currentSunAltitude = altitude;
    this.currentSunStrength = sunStrength;

    if (this._skyEnvTarget) this._skyEnvTarget.dispose();
    this._skyEnvTarget = this.pmremGenerator.fromScene(this.sky);
    this.scene.environment = this._skyEnvTarget.texture;

    // ⬇️ keep fog in lockstep with sky & tile radius
    this._syncFogToSky();
  }

  _computeSunDirection(lat, lon, date) {
    const rad = Math.PI / 180;
    const dayMs = 86400000;
    const J1970 = 2440588;
    const J2000 = 2451545;
    const toJulian = (time) => time / dayMs - 0.5 + J1970;
    const toDays = (time) => toJulian(time) - J2000;

    const lw = rad * -lon;
    const phi = rad * lat;
    const d = toDays(date.getTime());

    const solarMeanAnomaly = (d) => rad * (357.5291 + 0.98560028 * d);
    const eclipticLongitude = (M) => {
      const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
      const P = rad * 102.9372;
      return M + C + P + Math.PI;
    };
    const obliquity = rad * 23.4397;
    const declination = (L) => Math.asin(Math.sin(obliquity) * Math.sin(L));
    const rightAscension = (L) => Math.atan2(Math.sin(L) * Math.cos(obliquity), Math.cos(L));
    const siderealTime = (d, lw) => rad * (280.16 + 360.9856235 * d) - lw;

    const M = solarMeanAnomaly(d);
    const L = eclipticLongitude(M);
    const dec = declination(L);
    const ra = rightAscension(L);
    const H = siderealTime(d, lw) - ra;

    const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
    const azimuthSouth = Math.PI + Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
    const azimuth = (azimuthSouth + Math.PI) % (Math.PI * 2);

    const cosAlt = Math.cos(altitude);
    const x = Math.sin(azimuth) * cosAlt;
    const y = Math.sin(altitude);
    const z = Math.cos(azimuth) * cosAlt;

    return {
      direction: new THREE.Vector3(x, y, z).normalize(),
      altitude,
    };
  }
}
