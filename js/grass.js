import * as THREE from 'three';

const GRASS_ALPHA_URL = './assets/grass/grass-alpha.jpeg';
const GRASS_NOISE_URL = './assets/grass/perlinnoise.webp';

class FluffyGrassMaterial {
  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      uEnableShadows: { value: 1 },
      uShadowDarkness: { value: 0.5 },
      uGrassLightIntensity: { value: 1.0 },
      uNoiseScale: { value: 1.4 },
      uNoiseTexture: { value: new THREE.Texture() },
      uGrassAlphaTexture: { value: new THREE.Texture() },
      uTerrainSize: { value: 200 },
      uTipColor1: { value: new THREE.Color('#7abf65') },
      uTipColor2: { value: new THREE.Color('#1f352a') },
    };

    this.material = new THREE.MeshLambertMaterial({
      side: THREE.DoubleSide,
      color: 0xffffff,
      vertexColors: true,
      transparent: true,
      alphaTest: 0.2,
      shadowSide: THREE.DoubleSide,
    });

    this._setupShaderHook();
  }

  _setupShaderHook() {
    this.material.onBeforeCompile = (shader) => {
      shader.uniforms = {
        ...shader.uniforms,
        uTime: this.uniforms.uTime,
        uTipColor1: this.uniforms.uTipColor1,
        uTipColor2: this.uniforms.uTipColor2,
        uGrassLightIntensity: this.uniforms.uGrassLightIntensity,
        uShadowDarkness: this.uniforms.uShadowDarkness,
        uEnableShadows: this.uniforms.uEnableShadows,
        uNoiseScale: this.uniforms.uNoiseScale,
        uTerrainSize: this.uniforms.uTerrainSize,
        uNoiseTexture: this.uniforms.uNoiseTexture,
        uGrassAlphaTexture: this.uniforms.uGrassAlphaTexture,
      };

      shader.vertexShader = `
        #include <common>
        #include <fog_pars_vertex>
        #include <shadowmap_pars_vertex>

        uniform sampler2D uNoiseTexture;
        uniform float uNoiseScale;
        uniform float uTime;
        uniform float uTerrainSize;

        varying vec3 vColor;
        varying vec2 vGlobalUV;
        varying vec2 vUv;
        varying vec3 vNormal;
        varying vec3 vViewPosition;
        varying vec2 vWindColor;

        void main() {
          #include <color_vertex>
          #include <beginnormal_vertex>
          #include <defaultnormal_vertex>
          #include <uv_vertex>

          vec2 windDirection = normalize(vec2(1.0, 1.0));
          float windAmp = 0.12;
          float windFreq = 42.0;
          float windSpeed = 1.0;
          float noiseFactor = 4.25;
          float noiseSpeed = 0.0015;

          vec4 worldPosition = modelMatrix * instanceMatrix * vec4(position, 1.0);
          vec2 worldXZ = vec2(worldPosition.x, worldPosition.z);
          float terrainSize = max(uTerrainSize, 1.0);
          vGlobalUV = worldXZ / terrainSize;

          vec4 noiseSample = texture2D(uNoiseTexture, vGlobalUV + uTime * noiseSpeed);
          float windWave = sin(windFreq * dot(windDirection, vGlobalUV) + noiseSample.g * noiseFactor + uTime * windSpeed);

          float influence = (1.0 - uv.y);
          float displacement = windWave * windAmp * influence;

          worldPosition.x += displacement;
          worldPosition.z += displacement;
          worldPosition.y += exp(texture2D(uNoiseTexture, vGlobalUV * uNoiseScale).r) * 0.35 * influence;

          vec4 mvPosition = viewMatrix * worldPosition;
          gl_Position = projectionMatrix * mvPosition;

          vUv = vec2(uv.x, 1.0 - uv.y);
          vNormal = normalize(normalMatrix * normal);
          vWindColor = vec2(displacement, displacement);
          vViewPosition = mvPosition.xyz;

          #include <fog_vertex>
          #include <worldpos_vertex>
          #include <shadowmap_vertex>
        }
      `;

      shader.fragmentShader = `
        #include <alphatest_pars_fragment>
        #include <common>
        #include <packing>
        #include <fog_pars_fragment>
        #include <color_pars_fragment>
        #include <lights_pars_begin>
        #include <shadowmap_pars_fragment>
        #include <shadowmask_pars_fragment>

        uniform float uGrassLightIntensity;
        uniform float uShadowDarkness;
        uniform int uEnableShadows;
        uniform sampler2D uGrassAlphaTexture;
        uniform sampler2D uNoiseTexture;
        uniform float uNoiseScale;
        uniform vec3 uTipColor1;
        uniform vec3 uTipColor2;
        uniform float uTime;

        varying vec3 vColor;
        varying vec2 vUv;
        varying vec2 vGlobalUV;
        varying vec3 vNormal;
        varying vec3 vViewPosition;

        void main() {
          vec4 grassAlpha = texture2D(uGrassAlphaTexture, vUv);
          if (grassAlpha.r < 0.1) discard;

          vec4 noiseSample = texture2D(uNoiseTexture, vGlobalUV * uNoiseScale);
          vec3 tipColor = mix(uTipColor1, uTipColor2, noiseSample.r);

          vec3 sampleColor = vColor;
          vec3 baseColor = mix(sampleColor * 0.85, sampleColor, noiseSample.g);
          vec3 bladeColor = mix(baseColor, mix(sampleColor, tipColor, 0.65), vUv.y);
          bladeColor *= uGrassLightIntensity;

          vec3 geometryNormal = normalize(vNormal);
          vec3 geometryViewDir = (isOrthographic) ? vec3(0.0, 0.0, 1.0) : normalize(vViewPosition);
          IncidentLight directLight;
          float shading = 0.0;

          #if ( NUM_DIR_LIGHTS > 0 )
            DirectionalLight directionalLight;
            #pragma unroll_loop_start
            for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
              directionalLight = directionalLights[ i ];
              getDirectionalLightInfo( directionalLight, directLight );
              shading += saturate( dot( geometryNormal, directLight.direction ) ) * directLight.color.r;
            }
            #pragma unroll_loop_end
          #endif

          float shadowFactor = 1.0;
          if (uEnableShadows == 1) {
            shadowFactor = getShadowMask();
            shadowFactor = mix(shadowFactor, 1.0, uShadowDarkness);
          }

          vec3 finalColor = bladeColor * (0.35 + shading * 0.75) * shadowFactor;
          gl_FragColor = vec4(finalColor, 1.0);

          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }
      `;
    };
  }

  setupTextures(alphaTexture, noiseTexture) {
    if (alphaTexture) {
      alphaTexture.encoding = THREE.sRGBEncoding;
      alphaTexture.wrapS = alphaTexture.wrapT = THREE.ClampToEdgeWrapping;
      alphaTexture.needsUpdate = true;
      this.uniforms.uGrassAlphaTexture.value = alphaTexture;
    }
    if (noiseTexture) {
      noiseTexture.wrapS = noiseTexture.wrapT = THREE.RepeatWrapping;
      noiseTexture.encoding = THREE.LinearEncoding;
      noiseTexture.needsUpdate = true;
      this.uniforms.uNoiseTexture.value = noiseTexture;
    }
  }

  setTerrainSize(size) {
    this.uniforms.uTerrainSize.value = Math.max(1, size);
  }

  update(deltaTime = 0) {
    this.uniforms.uTime.value += deltaTime;
  }
}

export class GrassManager {
  constructor({ scene, tileManager } = {}) {
    this.scene = scene;
    this.tileManager = tileManager;
    this.enabled = typeof window !== 'undefined';
    this.instancesPerSample = 6;
    this.maxBladesPerTile = 7000;

    this.tileGrass = new Map();

    this._tempMatrix = new THREE.Matrix4();
    this._tempQuat = new THREE.Quaternion();
    this._tempScale = new THREE.Vector3();
    this._tempPosition = new THREE.Vector3();
    this._tempBasePosition = new THREE.Vector3();
    this._tempColor = new THREE.Color('#4b7a34');
    this._up = new THREE.Vector3(0, 1, 0);

    if (this.enabled) {
      this.material = new FluffyGrassMaterial();
      this._textureLoader = new THREE.TextureLoader();
      const terrainSize = (this.tileManager?.tileRadius ?? 100) * 2;
      this.material.setTerrainSize(terrainSize);
      this._bladeGeometry = this._createBladeGeometry();
      this._loadTextures();
    } else {
      this.material = null;
      this._textureLoader = null;
      this._bladeGeometry = null;
    }
  }

  _createBladeGeometry() {
    const geometry = new THREE.PlaneGeometry(0.12, 0.9, 1, 3);
    geometry.translate(0, 0.45, 0);
    return geometry;
  }

  _loadTexture(url, configure) {
    return new Promise((resolve, reject) => {
      if (!this._textureLoader) {
        resolve(null);
        return;
      }
      this._textureLoader.load(
        url,
        (texture) => {
          if (configure) configure(texture);
          resolve(texture);
        },
        undefined,
        (err) => reject(err)
      );
    });
  }

  _loadTextures() {
    if (!this._textureLoader || !this.material) return;
    Promise.all([
      this._loadTexture(GRASS_ALPHA_URL),
      this._loadTexture(GRASS_NOISE_URL),
    ]).then(([alpha, noise]) => {
      this.material.setupTextures(alpha, noise);
    }).catch((err) => {
      console.warn('[grass] texture load failed', err);
    });
  }

  update(deltaTime = 0) {
    if (!this.material) return;
    this.material.update(deltaTime);
    if (this.tileManager?.tileRadius) {
      this.material.setTerrainSize(this.tileManager.tileRadius * 2);
    }
  }

  generateGrassForTile(tile, samples, bounds) {
    if (!this.enabled || !this.material || !this._bladeGeometry) return;
    if (!tile || !samples || !samples.length || !bounds) {
      this.removeGrassForTile(tile);
      return;
    }
    const group = tile?.grid?.group;
    if (!group) return;

    this.removeGrassForTile(tile);

    const tileRadius = tile._radiusOverride ?? this.tileManager?.tileRadius ?? 100;
    const targetCount = Math.min(samples.length * this.instancesPerSample, this.maxBladesPerTile);
    if (targetCount <= 0) return;

    const origin = this.tileManager?.origin;
    if (!origin) return;
    const center = group.position.clone();

    const mesh = new THREE.InstancedMesh(this._bladeGeometry, this.material.material, targetCount);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.name = `grass-${tile.q},${tile.r}`;

    const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(targetCount * 3), 3);
    colorAttr.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = colorAttr;

    let placed = 0;
    for (const sample of samples) {
      if (placed >= targetCount) break;
      const world = this._uvToWorldPosition(sample?.u, sample?.v, bounds, origin);
      if (!world) continue;

      const dx = world.x - center.x;
      const dz = world.z - center.z;
      if ((dx * dx + dz * dz) > tileRadius * tileRadius * 1.1) continue;

      const ground = this.tileManager?.getHeightAt?.(world.x, world.z);
      if (!Number.isFinite(ground)) continue;

      this._tempBasePosition.set(
        world.x - center.x,
        ground - center.y - 0.04,
        world.z - center.z
      );

      for (let i = 0; i < this.instancesPerSample && placed < targetCount; i += 1) {
        const jitterX = (Math.random() - 0.5) * 0.6;
        const jitterZ = (Math.random() - 0.5) * 0.6;
        this._tempPosition.copy(this._tempBasePosition);
        this._tempPosition.x += jitterX;
        this._tempPosition.z += jitterZ;

        this._tempQuat.setFromAxisAngle(this._up, Math.random() * Math.PI * 2);
        const heightScale = THREE.MathUtils.lerp(0.7, 1.8, Math.random());
        const widthScale = THREE.MathUtils.lerp(0.6, 1.1, Math.random());
        this._tempScale.set(widthScale, heightScale, 1);

        this._tempMatrix.compose(this._tempPosition, this._tempQuat, this._tempScale);
        mesh.setMatrixAt(placed, this._tempMatrix);

        const color = this._colorFromSample(sample);
        mesh.setColorAt(placed, color);

        placed += 1;
      }
    }

    if (placed === 0) return;

    mesh.count = placed;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    group.add(mesh);
    this.tileGrass.set(this._tileKey(tile), { mesh, tile });
  }

  removeGrassForTile(tile) {
    if (!tile) return;
    const key = this._tileKey(tile);
    const entry = this.tileGrass.get(key);
    if (!entry) return;
    const mesh = entry.mesh;
    if (mesh?.parent) {
      mesh.parent.remove(mesh);
    }
    if (mesh?.instanceColor) {
      mesh.instanceColor.array.fill(0);
    }
    this.tileGrass.delete(key);
  }

  dispose() {
    for (const entry of this.tileGrass.values()) {
      if (entry.mesh?.parent) entry.mesh.parent.remove(entry.mesh);
    }
    this.tileGrass.clear();
    this._bladeGeometry?.dispose?.();
    this.material?.material?.dispose?.();
    this.material = null;
  }

  _colorFromSample(sample) {
    if (sample?.color) {
      this._tempColor.setRGB(
        (sample.color.r ?? 100) / 255,
        (sample.color.g ?? 140) / 255,
        (sample.color.b ?? 80) / 255
      );
    } else {
      this._tempColor.set('#4b7a34');
    }
    return this._tempColor;
  }

  _tileKey(tile) {
    return tile ? `${tile.q},${tile.r},${tile.type}` : 'unknown';
  }

  _uvToWorldPosition(u, v, bounds, origin) {
    if (!Number.isFinite(u) || !Number.isFinite(v) || !bounds || !origin) return null;
    const lon = bounds.lonMin + (bounds.lonMax - bounds.lonMin) * u;
    const lat = bounds.latMax - (bounds.latMax - bounds.latMin) * v;
    const R = 6371000;
    const originLatRad = THREE.MathUtils.degToRad(origin.lat);
    const dLat = THREE.MathUtils.degToRad(lat - origin.lat);
    const dLon = THREE.MathUtils.degToRad(lon - origin.lon);
    const x = dLon * Math.cos(originLatRad) * R;
    const z = -dLat * R;
    return { x, z };
  }
}
