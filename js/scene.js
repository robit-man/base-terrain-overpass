import * as THREE from 'three';
import { VRButton } from 'VRButton';
import { Sky } from 'Sky';
import { EARTH_RADIUS_METERS } from './geolocate.js';
import { PlanetSurface } from './planetSurface.js';

export class SceneManager {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      logarithmicDepthBuffer: true,
    });
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

    this.planetSurface = new PlanetSurface({
      scene: this.scene,
      renderer: this.renderer,
      radius: EARTH_RADIUS_METERS,
    });
    this.planetRadius = EARTH_RADIUS_METERS;
    this.planetRoot = this.planetSurface.group;

    this.surfaceAnchor = new THREE.Group();
    this.surfaceAnchor.name = 'planet-surface-anchor';
    this.scene.add(this.surfaceAnchor);

    // 🎯 Camera stays at (0,0,0) in dolly local space; dolly handles eye height
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, EARTH_RADIUS_METERS * 4);
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);

    // Dolly = player rig; add camera as a child (critical for chasecam & FPV)
    this.dolly = new THREE.Group();
    this.dolly.name = 'player-dolly';
    this.dolly.add(this.camera);
    this.surfaceAnchor.add(this.dolly);

    // Sky & sun lighting
    this.sky = new Sky();
    this.sky.scale.setScalar(EARTH_RADIUS_METERS * 3);
    this.surfaceAnchor.add(this.sky);
    const skyUniforms = this.sky.material.uniforms;
    skyUniforms['turbidity'].value = 2.5;
    skyUniforms['rayleigh'].value = 1.2;
    skyUniforms['mieCoefficient'].value = 0.004;
    skyUniforms['mieDirectionalG'].value = 0.95;

    this.AU = 149597870700; // meters
    const sunIntensity = 1361 / Math.PI;
    this.sunLight = new THREE.DirectionalLight(0xffffff, sunIntensity);
    this.sunLight.position.set(this.AU, 0, 0);
    this.sunLight.target.position.set(0, 0, 0);
    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    this.ambient = new THREE.AmbientLight(0x1e212b, 0.18);
    this.scene.add(this.ambient);

    // Where remote avatars live
    this.remoteLayer = new THREE.Group();
    this.remoteLayer.name = 'remote-layer';
    this.surfaceAnchor.add(this.remoteLayer);

    this._skyEnvTarget = null;

    // ---- Tile radius sampling (used for fog near/far) ----
    // You can override with setTileRadiusSource(number | () => number)
    this._tileRadiusSource = 4000; // fallback
    this.enableFog = false;

    // ---- Sky probe (offscreen) to sample color just BELOW the horizon ----
    this._initSkyProbe();

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    this.updatePlanetFrame(0, 0, 0);
    this.updateSun({ lat: 0, lon: 0, date: new Date() });
  }

  // Public API to supply tile radius (number) or a function that returns a number each call.
  setTileRadiusSource(src) {
    this._tileRadiusSource = src;
    if (this.currentSunAltitude !== undefined) this._syncFogToSky();
  }

  updatePlanetFrame(lat = 0, lon = 0, height = 0) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    this.planetSurface?.setOrigin(lat, lon, { height });
    const anchor = this.planetSurface?.getAnchorTransform?.();
    if (anchor) {
      this.surfaceAnchor.position.copy(anchor.position);
      this.surfaceAnchor.quaternion.copy(anchor.quaternion);
    } else {
      this.surfaceAnchor.position.set(0, 0, 0);
      this.surfaceAnchor.quaternion.identity();
    }
    this.sky.position.set(0, 0, 0);
    this.surfaceAnchor.updateMatrixWorld(true);
    this.remoteLayer.position.set(0, 0, 0);
    this.remoteLayer.quaternion.identity();
  }

  // ---------- SKY PROBE: offscreen sampling (below the horizon) ----------
  _initSkyProbe() {
    // Small target; linear color (default), no depth/stencil needed
    const S = 64;
    this._probeSize = S;
    this._probeRT = new THREE.WebGLRenderTarget(S, S, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: false,
      stencilBuffer: false,
      type: THREE.UnsignedByteType // stays robust for readRenderTargetPixels
      // Note: encoding of a RenderTarget is controlled by the renderer, so we
      // temporarily force linear + no tone mapping while rendering the probe.
    });

    // Separate scene with a Sky sharing the SAME material (so uniforms track)
    this._probeScene = new THREE.Scene();
    this._probeSky = new Sky();
    this._probeSky.scale.setScalar(60000);
    this._probeSky.material = this.sky.material; // share the material/uniforms
    this._probeScene.add(this._probeSky);

    // Level camera; the horizon sits at the vertical center when level.
    // We look forward (-Z). The "below horizon" band is a few pixels *below* mid-height.
    this._probeCamera = new THREE.PerspectiveCamera(75, 1, 1, 100000);
    this._probeCamera.position.set(0, 0, 0);
    this._probeCamera.up.set(0, 1, 0);
    this._probeCamera.lookAt(new THREE.Vector3(0, 0, -1));

    // How far beneath the horizon to sample (in degrees of vertical FOV).
    // ~2–3° below the horizon matches human perception for distant fade.
    this._horizonOffsetDeg = 2.5;

    // Buffer reused for reads
    this._probePixels = new Uint8Array(S * S * 4);

    // Last good color fallback
    this._lastFogColor = new THREE.Color(0x223344);
  }

  /**
   * Sample a thin band a few degrees BELOW the horizon from the sky shader.
   * This better matches perceived atmospheric color for distant fog/fade.
   * We temporarily disable tone mapping and sRGB output to read a linear color.
   * We also optionally ignore a narrow wedge around the sun if it's in front.
   */
  _sampleSkyHorizonColor() {
    const rt = this._probeRT;
    const S = this._probeSize;

    // Save renderer state
    const prevRT = this.renderer.getRenderTarget();
    const prevAutoClear = this.renderer.autoClear;
    const prevClearColor = new THREE.Color();
    const prevClearAlpha = this.renderer.getClearAlpha();
    const prevTone = this.renderer.toneMapping;
    const prevOutEnc = this.renderer.outputEncoding ?? this.renderer.outputColorSpace;

    this.renderer.getClearColor(prevClearColor);

    // Force linear pass-through for the probe render
    this.renderer.toneMapping = THREE.NoToneMapping;
    if ('outputEncoding' in this.renderer) {
      this.renderer.outputEncoding = THREE.LinearEncoding;
    } else if ('outputColorSpace' in this.renderer) {
      // @ts-ignore legacy/modern compat
      this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // linear
    }

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
    this.renderer.toneMapping = prevTone;
    if ('outputEncoding' in this.renderer) {
      this.renderer.outputEncoding = prevOutEnc;
    } else if ('outputColorSpace' in this.renderer) {
      // @ts-ignore
      this.renderer.outputColorSpace = prevOutEnc;
    }

    // Row just BELOW the horizon (center of image is horizon when level)
    const pixelsPerDegree = S / this._probeCamera.fov;
    const offsetPx = Math.max(1, Math.round(pixelsPerDegree * this._horizonOffsetDeg));
    const baseRow = Math.min(S - 1, Math.max(0, Math.floor(S * 0.5) + offsetPx));

    // Optional: ignore a thin vertical region around the sun when it's in front,
    // to avoid biasing the average toward direct forward scattering.
    let skipMinX = -1, skipMaxX = -1;
    try {
      const sunDir = this.sunLight.position.clone().normalize();

      // Transform sun direction into probe camera clip space
      const viewMat = this._probeCamera.matrixWorldInverse;
      const projMat = this._probeCamera.projectionMatrix;

      // Treat direction as a far-away point along that direction
      const sunPosWS = sunDir.clone().multiplyScalar(1000); // any positive scalar
      const sunPosVS = sunPosWS.clone().applyMatrix4(viewMat);
      const sunPosClip = sunPosVS.clone().applyMatrix4(projMat);

      if (sunPosClip.w !== 0) {
        const ndcX = sunPosClip.x / sunPosClip.w;
        const ndcY = sunPosClip.y / sunPosClip.w;

        // In front and within view frustum?
        const inFront = sunPosVS.z < 0; // camera looks down -Z
        const onScreen = Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1;

        // Only mask if the sun is near the horizon (±15°) to reduce over-masking
        const nearHorizon = Math.abs(this.currentSunAltitude ?? 0) <= THREE.MathUtils.degToRad(15);

        if (inFront && onScreen && nearHorizon) {
          const sunX = Math.round(((ndcX + 1) * 0.5) * (S - 1));
          const half = Math.max(1, Math.floor(S * 0.08)); // ~8% of width
          skipMinX = Math.max(0, sunX - half);
          skipMaxX = Math.min(S - 1, sunX + half);
        }
      }
    } catch (_) {
      // non-fatal; just don't skip any columns
      skipMinX = skipMaxX = -1;
    }

    // Average across a few rows to smooth, skip edges and (optionally) the sun band
    let rSum = 0, gSum = 0, bSum = 0, count = 0;

    const rowsToAverage = 5;
    for (let dy = 0; dy < rowsToAverage; dy++) {
      // Sample a small cluster straddling the target row (below the horizon)
      const y = Math.max(0, Math.min(S - 1, baseRow - Math.floor(rowsToAverage / 2) + dy));
      for (let x = 2; x < S - 2; x++) {
        if (skipMinX >= 0 && x >= skipMinX && x <= skipMaxX) continue; // skip sun band
        const idx = (y * S + x) * 4;
        rSum += this._probePixels[idx + 0];
        gSum += this._probePixels[idx + 1];
        bSum += this._probePixels[idx + 2];
        count++;
      }
    }

    // If we skipped too much (e.g., everything), fall back to sampling without the mask
    if (count === 0) {
      for (let dy = 0; dy < 3; dy++) {
        const y = Math.max(0, Math.min(S - 1, baseRow - dy));
        for (let x = 2; x < S - 2; x++) {
          const idx = (y * S + x) * 4;
          rSum += this._probePixels[idx + 0];
          gSum += this._probePixels[idx + 1];
          bSum += this._probePixels[idx + 2];
          count++;
        }
      }
    }

    if (count === 0) return this._lastFogColor.clone();

    // Pixels are linear because we disabled tone mapping and sRGB conversion
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
    const R = Math.max(50, tileRadius);

    const far = Math.min(R, this.camera.far - 50);
    let near = Math.max(this.camera.near + 10, Math.min(far - 20, R * 0.06));
    if (near >= far - 5) near = Math.max(this.camera.near + 5, far - 5);

    return { near, far };
  }

  _syncFogToSky() {
    if (!this.enableFog) {
      this.scene.fog = null;
      if (this.scene.background && this.scene.background.isColor) {
        this.scene.background = null;
      }
      this.renderer.setClearColor(0x000000, 1);
      return;
    }

    const turbidity = this.sky?.material?.uniforms?.turbidity?.value ?? 2.5;

    // 🔍 Sample the true color just BELOW the horizon from the Sky shader
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

    this.sunLight.position.copy(direction).multiplyScalar(this.AU);
    this.sunLight.target.position.copy(target);
    this.sunLight.target.updateMatrixWorld();

    const sunStrength = Math.max(0, Math.sin(altitude));
    this.sunLight.intensity = 1361 / Math.PI;
    this.sunLight.visible = altitude > -0.2;
    this.ambient.intensity = THREE.MathUtils.lerp(0.04, 0.18, THREE.MathUtils.clamp(sunStrength + 0.3, 0, 1));

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
