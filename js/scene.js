import * as THREE from 'three';
import { VRButton } from 'VRButton';
import { Sky } from 'Sky';

const TWILIGHT_ALTITUDE = THREE.MathUtils.degToRad(-0.5);
const NIGHT_ALTITUDE = THREE.MathUtils.degToRad(-12);
const DAY_EXPOSURE = 0.8;
const NIGHT_EXPOSURE = 0.018;
const NIGHT_FOG_COLOR = new THREE.Color(0x05070d);
const NIGHT_AMBIENT_COLOR = new THREE.Color(0x000000);
const DAY_AMBIENT_COLOR = new THREE.Color(0x1e212b);
const DUSK_SUN_COLOR = new THREE.Color(0xffa864);
const DAY_SUN_COLOR = new THREE.Color(0xffffff);

export class SceneManager {
  constructor() {

    // Lightweight mobile detection
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobi/i
      .test(navigator.userAgent || '');

    // On mobile we want:
    // - no MSAA (antialias:false)
    // - lower power hint
    // - capped pixel ratio
    // - shadows off
    this.renderer = new THREE.WebGLRenderer({
      antialias: !isMobile,
      alpha: true,
      powerPreference: isMobile ? 'low-power' : 'high-performance',
      logarithmicDepthBuffer: true
    });

    this.renderer.setSize(innerWidth, innerHeight);

    // Clamp DPR. High-DPI phones report DPR 3–4, which explodes fill rate.
    const safePR = isMobile
      ? Math.min(window.devicePixelRatio * 0.5, 1.0) // ~half res, never above 1.0
      : window.devicePixelRatio;
    this.renderer.setPixelRatio(safePR);
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.outputEncoding = THREE.sRGBEncoding;
    this.renderer.toneMappingExposure = DAY_EXPOSURE;
    this.renderer.physicallyCorrectLights = !isMobile;

    this.renderer.xr.enabled = true;
    try {
      this.renderer.xr.setReferenceSpaceType?.('local-floor');
    } catch (_) {
      this.renderer.xr.setReferenceSpaceType?.('local');
    }

    // Shadows are super expensive on tiled mobile GPUs
    this.renderer.shadowMap.enabled = !isMobile;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.renderer.domElement.classList.add('scene-canvas');
    document.body.appendChild(this.renderer.domElement);
    document.body.appendChild(VRButton.createButton(this.renderer));

    this.pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    this.scene = new THREE.Scene();


    // Camera stays at (0,0,0) in dolly local space; dolly handles eye height
    const CAMERA_FAR_DEFAULT = 200000;
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, CAMERA_FAR_DEFAULT);
    this.camera.layers.enable(1); // ensure horizon/farfield overlays (layer 1) render
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);
    this.camera.rotation.order = 'YXZ';

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

    this._farfieldSampleInsetFrac = 0.08; // sample ~8% inside the farfield edge
    this._farFogInsetFrac = 0.05;  // fog.far ~5% inside the farfield edge
    this._wireframeMode = false;
    this._wireframeThemeBg = null;
    this._defaultFogNear = 0.12;
    this._defaultFogFar = 0.98;

    // OPTIMIZED: Enhanced directional sun light with realistic intensity
    this.sunLight = new THREE.DirectionalLight(0xffffff, 3.5);  // Slightly reduced for more realistic contrast
    this.sunLight.position.set(1000, 500, -800);
    this.sunLight.castShadow = true;

    // OPTIMIZED: Higher quality shadow maps for buildings/trees
    this.sunLight.shadow.mapSize.set(1024, 1024);  // Increased from 1024 for sharper shadows
    this.sunLight.shadow.camera.near = 0;
    this.sunLight.shadow.camera.far = 3000;        // Extended to cover more area
    this.sunLight.shadow.camera.left = -800;       // Wider coverage
    this.sunLight.shadow.camera.right = 800;
    this.sunLight.shadow.camera.top = 800;
    this.sunLight.shadow.camera.bottom = -800;
    this.sunLight.shadow.bias = -0.0001;           // Reduced bias for cleaner shadows
    this.sunLight.shadow.normalBias = 0.02;        // Added normal bias to reduce artifacts
    this.sunLight.shadow.radius = 1.5;             // Soft shadow edges (PCFSoftShadowMap only)

    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);

    // OPTIMIZED: Enhanced ambient lighting for better shadow visibility
    this.ambient = new THREE.AmbientLight(DAY_AMBIENT_COLOR.clone(), 0.18);  // Increased from 0.18 to fill shadows
    this.scene.add(this.ambient);
    this._ambientDayColor = DAY_AMBIENT_COLOR.clone();
    this._ambientNightColor = NIGHT_AMBIENT_COLOR.clone();

    // Where remote avatars live
    this.remoteLayer = new THREE.Group();
    this.remoteLayer.name = 'remote-layer';
    this.scene.add(this.remoteLayer);

    this._skyEnvTarget = null;
    this.currentNightMix = 0;

    // ---- Tile radius sampling (used for fog near/far) ----
    // You can override with setTileRadiusSource(number | () => number)
    this._tileRadiusSource = 4000; // fallback

    // ---- Sky probe (offscreen) to sample color just BELOW the horizon ----
    this._initSkyProbe();

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    this.updateSun({ lat: 0, lon: 0, date: new Date() });

    // Smart Objects - will be initialized later by app.js
    this.smartObjects = null;
    this.smartModal = null;
    this.spatialAudio = null;

    // Raycaster for click detection
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this._terrainTargetProvider = null;

    // Click handler for Smart Objects
    this.renderer.domElement.addEventListener('click', (e) => this._handleClick(e));
  }

  setTerrainTargetProvider(fn) {
    this._terrainTargetProvider = typeof fn === 'function' ? fn : null;
  }

  _getTerrainRaycastTargets() {
    if (typeof this._terrainTargetProvider !== 'function') return [];
    return this._terrainTargetProvider() || [];
  }

  // Public API to supply tile radius (number) or a function that returns a number each call.
  setTileRadiusSource(src) {
    this._tileRadiusSource = src;
    if (this.currentSunAltitude !== undefined) this._syncFogToSky();
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
    this._probeCamera.up.set(0, -10, 0);
    this._probeCamera.lookAt(new THREE.Vector3(0, -100, 0));

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
      this.renderer.outputColorSpace = THREE.SRGBColorSpace; // linear
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
  // Prefer farfield world radius from the TileManager (via App → hexGridMgr)
  const tm = this.app?.hexGridMgr;
  if (tm?.getTerrainSettings) {
    const s = tm.getTerrainSettings();
    if (Number.isFinite(s.horizonOuterRadius) && s.horizonOuterRadius > 0) {
      return Math.max(300, s.horizonOuterRadius);
    }
    // Use the same notion of "world radius" used elsewhere: tileRadius * farfieldRing
    if (Number.isFinite(s.tileRadius) && Number.isFinite(s.farfieldRing)) {
      return Math.max(300, s.tileRadius * s.farfieldRing);
    }
    // Fallback: if tileRadius isn’t available, derive from spacing * farfieldRing
    if (Number.isFinite(s.spacing) && Number.isFinite(s.farfieldRing)) {
      return Math.max(300, s.spacing * s.farfieldRing);
    }
  }

  // Secondary fallback: honor any previously-set source (if present)
  const src = this._tileRadiusSource;
  const r = (typeof src === 'function') ? src() : src;
  if (Number.isFinite(r) && r > 0) return r;

  // Last resort: hard default
  return 4000;
}

  _ensureCameraFar(targetRadius) {
    if (!Number.isFinite(targetRadius) || targetRadius <= 0) return;
    const desiredFar = Math.min(400000, Math.max(this.camera.near + 100, targetRadius * 1.35));
    const currentFar = this.camera.far;
    if (!Number.isFinite(currentFar) || Math.abs(desiredFar - currentFar) > currentFar * 0.05) {
      this.camera.far = desiredFar;
      this.camera.updateProjectionMatrix();
      console.debug('[Scene] camera.far updated', { desiredFar, targetRadius });
    }
  }

  // Start close for atmospheric perspective; scale far with (possibly inset) radius; tighten at night/haze
  _computeFogDistances(radius, altitude, turbidity, nearPct = this._defaultFogNear, farPct = this._defaultFogFar) {
    radius = Math.max(50, radius);
    const nightMix = this.currentNightMix ?? 0;
    const dayFactor = 1 - nightMix;

    const clampedNearPct = THREE.MathUtils.clamp(nearPct, 0, 0.95);
    const clampedFarPct = THREE.MathUtils.clamp(farPct, clampedNearPct + 0.02, 1);

    let far = THREE.MathUtils.clamp(radius * clampedFarPct, this.camera.near + 30, this.camera.far - 25);
    if (nightMix > 0) {
      const duskClamp = THREE.MathUtils.lerp(far * 0.5, far, Math.pow(dayFactor, 0.65));
      far = Math.min(far, duskClamp);
    }
    far = Math.max(this.camera.near + 40, far);

    let near = THREE.MathUtils.clamp(radius * clampedNearPct, this.camera.near + 10, far - 10);
    if (nightMix > 0) {
      const nightNear = Math.min(far - 12, radius * Math.min(0.3, clampedNearPct + 0.12) + 20 * nightMix);
      near = THREE.MathUtils.lerp(nightNear, near, Math.pow(dayFactor, 0.7));
    }
    near = Math.min(near, far - 10);

    return { near, far };
  }

  _syncFogToSky() {
    if (this._wireframeMode) {
      const bg = this._wireframeThemeBg instanceof THREE.Color ? this._wireframeThemeBg : new THREE.Color(0x000000);
      if (!this.scene.fog) {
        this.scene.fog = new THREE.Fog(bg.clone(), this.camera.near + 5, Math.max(this.camera.near + 50, this.camera.far - 25));
      }
      this.scene.fog.color.copy(bg);
      this.scene.fog.near = this.camera.near + 5;
      this.scene.fog.far = Math.max(this.camera.near + 50, this.camera.far - 25);
      this.renderer.setClearColor(bg, 1);
      return;
    }
    const turbidity = this.sky?.material?.uniforms?.turbidity?.value ?? 2.5;

    // Base world radius of your farfield (tiles)
    const tileRadius = this._sampleTileRadius();
    this._ensureCameraFar(tileRadius);
    const settings = this.app?.hexGridMgr?.getTerrainSettings?.();
    const fogNearPct = settings?.fogNearPct ?? this._defaultFogNear;
    const fogFarPct = settings?.fogFarPct ?? this._defaultFogFar;

    // Inset distances (fractions of tile radius)
    const sampleInsetFrac = this._farfieldSampleInsetFrac ?? 0.08;
    const fogInsetFrac = this._farFogInsetFrac ?? 0.05;

    // --- 1) Sampling angle: aim a little INSIDE the farfield edge ---
    // Use a reduced target distance so the “below-horizon” row corresponds
    // to the ring at (tileRadius * (1 - sampleInsetFrac)).
    const targetD = Math.max(10, tileRadius * (1 - sampleInsetFrac));
    const cameraHeight = Math.abs(this.camera?.position?.y ?? 0);
    const edgeAngleRad = Math.atan2(cameraHeight, targetD); // angle below horizon to hit that ring
    this._horizonOffsetDeg = THREE.MathUtils.clamp(
      THREE.MathUtils.radToDeg(edgeAngleRad),
      0.75, 12
    );

    // 🔍 Sample the true color just BELOW the horizon from the Sky shader
    const fogColor = this._sampleSkyHorizonColor();

    // Optional night tinting
    const nightMix = this.currentNightMix ?? 0;
    if (nightMix > 0) {
      const t = THREE.MathUtils.clamp((nightMix - 0.08) / 0.92, 0, 1);
      const blend = Math.pow(t, 1.25);
      if (blend > 0) fogColor.lerp(NIGHT_FOG_COLOR, blend);
    }

    // --- 2) Fog distances: also pull fog.far slightly INSIDE the farfield edge ---
    const { near, far } = this._computeFogDistances(tileRadius, this.currentSunAltitude ?? 0, turbidity, fogNearPct, fogFarPct);

    if (!this.scene.fog) {
      this.scene.fog = new THREE.Fog(fogColor.clone(), near, far);
    } else {
      this.scene.fog.color.copy(fogColor);
      this.scene.fog.near = near;
      this.scene.fog.far = far;
    }

    // Match clear color so sky/fog blend seamlessly at edges
    this.renderer.setClearColor(fogColor, 1);

    // Ensure Sky is visible (not a solid color background)
    if (this.scene.background && this.scene.background.isColor) {
      this.scene.background = null;
    }
  }

  setWireframeMode(enabled) {
    const next = !!enabled;
    if (this._wireframeMode === next) {
      const night = (this.currentNightMix ?? 0) >= 0.5;
      if (next) {
        const desiredBg = new THREE.Color(night ? 0x000000 : 0xffffff);
        if (!this._wireframeThemeBg || !this._wireframeThemeBg.equals(desiredBg)) {
          this._wireframeThemeBg = desiredBg.clone();
          this.renderer.setClearColor(desiredBg, 1);
          if (!this.scene.fog) {
            this.scene.fog = new THREE.Fog(desiredBg.clone(), this.camera.near + 5, Math.max(this.camera.near + 50, this.camera.far - 25));
          } else {
            this.scene.fog.color.copy(desiredBg);
            this.scene.fog.near = this.camera.near + 5;
            this.scene.fog.far = Math.max(this.camera.near + 50, this.camera.far - 25);
          }
          this.scene.background = desiredBg.clone();
        }
      } else if (this.scene.fog) {
        this.scene.fog.near = this.camera.near + 5;
        this.scene.fog.far = Math.max(this.camera.near + 50, this.camera.far - 25);
      }
      const line = next
        ? new THREE.Color(night ? 0xffffff : 0x000000)
        : new THREE.Color(0xffffff);
      return { lineColor: line, background: this._wireframeThemeBg || null, night };
    }

    const nightMix = this.currentNightMix ?? 0;
    const isNight = nightMix >= 0.5;
    if (next) {
      this._wireframeMode = true;
      const bg = new THREE.Color(isNight ? 0x000000 : 0xffffff);
      const line = new THREE.Color(isNight ? 0xffffff : 0x000000);
      this._wireframeThemeBg = bg.clone();
      this.renderer.setClearColor(bg, 1);
      this.scene.background = bg.clone();
      if (this.sky) this.sky.visible = false;
      if (this.scene.environment) this.scene.environment = null;
      if (!this.scene.fog) {
        this.scene.fog = new THREE.Fog(bg.clone(), this.camera.near + 5, Math.max(this.camera.near + 50, this.camera.far - 25));
      } else {
        this.scene.fog.color.copy(bg);
        this.scene.fog.near = this.camera.near + 5;
        this.scene.fog.far = Math.max(this.camera.near + 50, this.camera.far - 25);
      }
      return { lineColor: line, background: bg, night: isNight };
    }

    this._wireframeMode = false;
    this._wireframeThemeBg = null;
    if (this.sky) this.sky.visible = true;
    this._syncFogToSky();
    return { lineColor: new THREE.Color(0xffffff), background: null, night: isNight };
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
    let nightMix = 0;
    if (altitude < TWILIGHT_ALTITUDE) {
      nightMix = THREE.MathUtils.clamp(
        (TWILIGHT_ALTITUDE - altitude) / (TWILIGHT_ALTITUDE - NIGHT_ALTITUDE),
        0,
        1
      );
    }
    const dayFactor = Math.max(0, 1 - nightMix);
    const daylight = THREE.MathUtils.clamp(sunStrength + 0.2, 0, 1);

    const sunIntensityBase = THREE.MathUtils.lerp(0.05, 6.5, daylight);
    const sunIntensity = sunIntensityBase * Math.pow(dayFactor, 1.8);
    this.sunLight.intensity = sunIntensity;
    this.sunLight.visible = sunIntensity > 0.02;

    const ambientDay = THREE.MathUtils.lerp(0.06, 0.22, daylight);
    const ambientIntensity = THREE.MathUtils.lerp(0.008, ambientDay, Math.pow(dayFactor, 1.1));
    this.ambient.intensity = ambientIntensity;
    this.ambient.color.copy(this._ambientNightColor).lerp(this._ambientDayColor, Math.pow(dayFactor, 1.3));

    this.sunLight.color.copy(DUSK_SUN_COLOR).lerp(DAY_SUN_COLOR, Math.pow(dayFactor, 1.6));

    const uniforms = this.sky.material.uniforms;

    // Push the sky darker earlier at night (no tone mapping involved)
    const deep = THREE.MathUtils.smoothstep(nightMix, 0.65, 1.0);   // 0→1 into deep night
    this.sky.material.transparent = true;
    this.sky.material.depthWrite = false;                           // don’t affect depth
    this.sky.material.opacity = THREE.MathUtils.lerp(0.0, 0.95, deep);  // 0..85% darkening

    // --- Kill the dome & env in deep night so clear/fog shows through ---
    const deepNight = nightMix >= 0.90;
    this.sky.visible = !deepNight;

    // Stop feeding a bright environment when it’s basically night
    if (deepNight) {
      if (this._skyEnvTarget) { this._skyEnvTarget.dispose(); this._skyEnvTarget = null; }
      this.scene.environment = null;
    } else {
      if (this._skyEnvTarget) this._skyEnvTarget.dispose();
      this._skyEnvTarget = this.pmremGenerator.fromScene(this.sky);
      this.scene.environment = this._skyEnvTarget.texture;
    } const dim = 1.0 - deep;                                       // 1 by day → 0 in deep night

    // Dim scattering terms and luminance by 'dim'
    const turbidityNight = turbidity * dim;
    const rayleighNight = rayleigh * dim;
    const mieNight = mieCoefficient * dim;
    // Also collapse directional Mie toward 0 so there's no residual forward glow
    const mieDirectionalNight = THREE.MathUtils.lerp(mieDirectionalG, 0.0, deep);

    uniforms['turbidity'].value = turbidityNight;
    uniforms['rayleigh'].value = rayleighNight;
    uniforms['mieCoefficient'].value = mieNight;
    uniforms['mieDirectionalG'].value = mieDirectionalNight;

    // Let luminance really fall off (stronger curve than linear)
    // If you see banding, clamp the floor to ~0.003 instead of 0.0
    if (uniforms['luminance']) {
      uniforms['luminance'].value = THREE.MathUtils.lerp(1.0, 0.0, Math.pow(nightMix, 0.8)) * dim;
    }

    // (Optional but very effective, still “no tone mapping”):
    // blend the sky into the (already dark) clear/fog color at deep night
    this.sky.material.transparent = true;
    this.sky.material.opacity = THREE.MathUtils.lerp(1.0, 0.20, deep);

    uniforms['sunPosition'].value.copy(direction.clone().multiplyScalar(45000));

    this.currentSunAltitude = altitude;
    this.currentSunStrength = sunStrength;
    this.currentNightMix = nightMix;

    const targetExposure = THREE.MathUtils.lerp(NIGHT_EXPOSURE, DAY_EXPOSURE, Math.pow(dayFactor, 1.1));
    this.renderer.toneMappingExposure = targetExposure;

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
    const HRaw = siderealTime(d, lw) - ra;
    const H = THREE.MathUtils.euclideanModulo(HRaw + Math.PI, Math.PI * 2) - Math.PI;

    const sinPhi = Math.sin(phi);
    const cosPhi = Math.cos(phi);
    const sinDec = Math.sin(dec);
    const cosDec = Math.cos(dec);

    const altitude = Math.asin(
      sinPhi * sinDec + cosPhi * cosDec * Math.cos(H)
    );
    const azRaw = Math.atan2(
      Math.sin(H),
      Math.cos(H) * sinPhi - Math.tan(dec) * cosPhi
    );

    const cosAlt = Math.cos(altitude);
    const direction = new THREE.Vector3(
      -Math.sin(azRaw) * cosAlt,
      Math.sin(altitude),
      Math.cos(azRaw) * cosAlt
    ).normalize();

    return {
      direction,
      altitude,
    };
  }

  /**
   * Public method for handling canvas clicks from app.js
   */
  handleCanvasClick(event) {
    this._handleClick(event);
  }

  /**
   * Handle click for Smart Object interaction
   */
  _handleClick(event) {
    if (!this.smartObjects || !this.smartModal) return;

    // Calculate mouse position in normalized device coordinates
    this.mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
    this.mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;

    // Update raycaster
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Placement mode: try to place on terrain tiles
    if (this.smartObjects.placementMode) {
      const targets = this._getTerrainRaycastTargets();
      if (targets.length) {
        const intersections = this.raycaster.intersectObjects(targets, true);
        if (intersections.length > 0) {
          const point = intersections[0].point.clone();
          this.smartObjects.exitPlacementModeAndPlace(point);
        }
      }
      return;
    }

    // Check for Smart Object intersection
    const clickedObject = this.smartObjects.getObjectAtPosition(this.raycaster);

    if (clickedObject) {
      // Check if player can interact with this object (proximity + permissions)
      const { canInteract, reason } = this.smartObjects.canInteract(clickedObject);

      if (canInteract) {
        // Open modal for this object
        this.smartModal.show(clickedObject);
      } else {
        // Show feedback why interaction is blocked
        if (typeof pushToast === 'function') {
          pushToast(`Cannot interact: ${reason}`, { duration: 2000 });
        }
        console.log(`[SmartObjects] Interaction blocked: ${reason}`);
      }
    }
  }

  /**
   * Update Smart Objects (call this in animation loop)
   */
  updateSmartObjects() {
    if (!this.smartObjects) return;

    // Update placement preview position
    this.smartObjects.updatePlacementPreview();

    // Update proximity indicators for all objects
    this.smartObjects.updateProximityIndicators();

    // Update hover detection for smart objects
    this._updateSmartObjectHover();

    // Update spatial audio listener position
    if (this.spatialAudio) {
      this.spatialAudio.updateListenerPosition();
    }
  }

  /**
   * Update hover state for smart objects based on mouse position
   */
  _updateSmartObjectHover() {
    if (!this.smartObjects || this.smartObjects.placementMode) {
      // Clear hover if in placement mode
      if (this.smartObjects) {
        this.smartObjects.updateHoverState(null);
      }
      return;
    }

    // Update raycaster from current mouse position
    this.raycaster.setFromCamera(this.mouse, this.camera);

    // Check for smart object intersection
    const hoveredObject = this.smartObjects.getObjectAtPosition(this.raycaster);

    // Update hover state
    this.smartObjects.updateHoverState(hoveredObject);
  }
}
