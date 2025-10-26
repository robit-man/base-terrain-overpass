import * as THREE from 'three';

const GRASS_DIFFUSE_URL = 'https://al-ro.github.io/images/grass/blade_diffuse.jpg';
const GRASS_ALPHA_URL = 'https://al-ro.github.io/images/grass/blade_alpha.jpg';
const GRASS_NOISE_URL = 'https://al-ro.github.io/images/grass/perlinFbm.jpg';

// Advanced grass material using raw ShaderMaterial with custom lighting
class AdvancedGrassMaterial {
  constructor() {
    this.uniforms = {
      time: { value: 0 },
      map: { value: null },
      alphaMap: { value: null },
      noiseTexture: { value: null },
      // Light uniforms
      ambientStrength: { value: 0.7 },
      diffuseStrength: { value: 0.5 },
      specularStrength: { value: 0.1 },
      translucencyStrength: { value: 1.5 },
      shininess: { value: 256.0 },
      lightColour: { value: new THREE.Color(1.0, 1.0, 1.0) },
      sunDirection: { value: new THREE.Vector3(-1, 1, 0).normalize() },
      cameraPosition: { value: new THREE.Vector3() },
      specularColour: { value: new THREE.Color(1.0, 1.0, 1.0) },
    };

    // Blade geometry parameters
    this.bladeWidth = 0.12;
    this.bladeHeight = 1.0;
    this.joints = 4;

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: this._getVertexShader(),
      fragmentShader: this._getFragmentShader(),
      side: THREE.DoubleSide,
    });
  }

  _getVertexShader() {
    const bladeHeight = this.bladeHeight;
    return `
      precision mediump float;
      attribute vec3 position;
      attribute vec3 normal;
      attribute vec3 offset;
      attribute vec2 uv;
      attribute vec2 halfRootAngle;
      attribute float scale;
      attribute float index;
      uniform float time;
      uniform sampler2D noiseTexture;

      uniform mat4 modelViewMatrix;
      uniform mat4 projectionMatrix;

      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;
      varying float frc;
      varying float idx;

      const float PI = 3.1415;
      const float TWO_PI = 2.0 * PI;

      vec3 rotateVectorByQuaternion(vec3 v, vec4 q){
        return 2.0 * cross(q.xyz, v * q.w + cross(q.xyz, v)) + v;
      }

      void main() {
        // Vertex height in blade geometry
        frc = position.y / float(${bladeHeight.toFixed(1)});

        // Scale vertices
        vec3 vPosition = position;
        vPosition.y *= scale;

        // Invert scaling for normals
        vNormal = normal;
        vNormal.y /= scale;

        // Rotate blade around Y axis
        vec4 direction = vec4(0.0, halfRootAngle.x, 0.0, halfRootAngle.y);
        vPosition = rotateVectorByQuaternion(vPosition, direction);
        vNormal = rotateVectorByQuaternion(vNormal, direction);

        // UV for texture
        vUv = uv;

        // Position of the blade in world space
        vec2 fractionalPos = offset.xz * 0.01;

        // Wind animation using noise texture
        vec4 noise = texture2D(noiseTexture, fractionalPos * 0.5 + time * 0.0001);
        float halfAngle = -noise.r * 0.3 * frc;

        direction = normalize(vec4(sin(halfAngle), 0.0, -sin(halfAngle), cos(halfAngle)));

        // Rotate blade and normals according to the wind
        vPosition = rotateVectorByQuaternion(vPosition, direction);
        vNormal = rotateVectorByQuaternion(vNormal, direction);

        // Move vertex to global location
        vPosition += offset;

        // Index of instance for varying colour in fragment shader
        idx = index;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(vPosition, 1.0);
      }
    `;
  }

  _getFragmentShader() {
    return `
      precision mediump float;

      uniform vec3 cameraPosition;

      // Light uniforms
      uniform float ambientStrength;
      uniform float diffuseStrength;
      uniform float specularStrength;
      uniform float translucencyStrength;
      uniform float shininess;
      uniform vec3 lightColour;
      uniform vec3 sunDirection;

      // Surface uniforms
      uniform sampler2D map;
      uniform sampler2D alphaMap;
      uniform vec3 specularColour;

      varying float frc;
      varying float idx;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vPosition;

      vec3 ACESFilm(vec3 x){
        float a = 2.51;
        float b = 0.03;
        float c = 2.43;
        float d = 0.59;
        float e = 0.14;
        return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
      }

      void main() {
        // If transparent, don't draw
        if(texture2D(alphaMap, vUv).r < 0.15){
          discard;
        }

        vec3 normal;

        // Flip normals when viewing reverse of the blade
        if(gl_FrontFacing){
          normal = normalize(vNormal);
        }else{
          normal = normalize(-vNormal);
        }

        // Get colour data from texture
        vec3 textureColour = pow(texture2D(map, vUv).rgb, vec3(2.2));

        // Add different green tones towards root
        vec3 mixColour = idx > 0.75 ? vec3(0.2, 0.8, 0.06) : vec3(0.5, 0.8, 0.08);
        textureColour = mix(0.1 * mixColour, textureColour, 0.75);

        vec3 lightTimesTexture = lightColour * textureColour;
        vec3 ambient = textureColour;
        vec3 lightDir = normalize(sunDirection);

        // How much a fragment faces the light
        float dotNormalLight = dot(normal, lightDir);
        float diff = max(dotNormalLight, 0.0);

        // Colour when lit by light
        vec3 diffuse = diff * lightTimesTexture;

        float sky = max(dot(normal, vec3(0,1,0)), 0.0);
        vec3 skyLight = sky * vec3(0.12, 0.29, 0.55);

        vec3 viewDirection = normalize(cameraPosition - vPosition);
        vec3 halfwayDir = normalize(lightDir + viewDirection);
        // How much a fragment directly reflects the light to the camera
        float spec = pow(max(dot(normal, halfwayDir), 0.0), shininess);

        // Colour of light sharply reflected into the camera
        vec3 specular = spec * specularColour * lightColour;

        // Translucency
        vec3 diffuseTranslucency = vec3(0);
        vec3 forwardTranslucency = vec3(0);
        float dotViewLight = dot(-lightDir, viewDirection);
        if(dotNormalLight <= 0.0){
          diffuseTranslucency = lightTimesTexture * translucencyStrength * -dotNormalLight;
          if(dotViewLight > 0.0){
            forwardTranslucency = lightTimesTexture * translucencyStrength * pow(dotViewLight, 16.0);
          }
        }

        vec3 col = 0.3 * skyLight * textureColour + ambientStrength * ambient + diffuseStrength * diffuse + specularStrength * specular + diffuseTranslucency + forwardTranslucency;

        // Add a shadow towards root
        col = mix(0.35*vec3(0.1, 0.25, 0.02), col, frc);

        // Tonemapping
        col = ACESFilm(col);

        // Gamma correction 1.0/2.2 = 0.4545...
        col = pow(col, vec3(0.4545));

        gl_FragColor = vec4(col, 1.0);
      }
    `;
  }

  setupTextures(diffuseTexture, alphaTexture, noiseTexture) {
    if (diffuseTexture) {
      diffuseTexture.wrapS = diffuseTexture.wrapT = THREE.RepeatWrapping;
      this.uniforms.map.value = diffuseTexture;
    }
    if (alphaTexture) {
      alphaTexture.wrapS = alphaTexture.wrapT = THREE.RepeatWrapping;
      this.uniforms.alphaMap.value = alphaTexture;
    }
    if (noiseTexture) {
      noiseTexture.wrapS = noiseTexture.wrapT = THREE.RepeatWrapping;
      this.uniforms.noiseTexture.value = noiseTexture;
    }
  }

  updateCamera(camera) {
    if (camera) {
      this.uniforms.cameraPosition.value.copy(camera.position);
    }
  }

  update(deltaTime = 0) {
    this.uniforms.time.value += deltaTime;
  }
}

export class GrassManager {
  constructor({ scene, tileManager, camera } = {}) {
    this.scene = scene;
    this.tileManager = tileManager;
    this.camera = camera;
    this.enabled = typeof window !== 'undefined';
    this.instancesPerSample = 6;
    this.maxBladesPerTile = 7000;

    this.tileGrass = new Map();

    this._tempMatrix = new THREE.Matrix4();
    this._tempQuat = new THREE.Quaternion();
    this._tempScale = new THREE.Vector3();
    this._tempPosition = new THREE.Vector3();
    this._tempBasePosition = new THREE.Vector3();
    this._up = new THREE.Vector3(0, 1, 0);

    if (this.enabled) {
      this.material = new AdvancedGrassMaterial();
      this._textureLoader = new THREE.TextureLoader();
      this._bladeGeometry = this._createBladeGeometry();
      this._loadTextures();
    } else {
      this.material = null;
      this._textureLoader = null;
      this._bladeGeometry = null;
    }
  }

  _createBladeGeometry() {
    const bladeWidth = this.material.bladeWidth;
    const bladeHeight = this.material.bladeHeight;
    const joints = this.material.joints;

    // Create base plane for grass blade
    const geometry = new THREE.PlaneGeometry(bladeWidth, bladeHeight, 1, joints);
    geometry.translate(0, bladeHeight / 2, 0);

    // Define the bend of the grass blade as quaternion rotations
    const vertex = new THREE.Vector3();
    const quaternion0 = new THREE.Quaternion();
    const quaternion1 = new THREE.Quaternion();
    const quaternion2 = new THREE.Quaternion();
    const rotationAxis = new THREE.Vector3();

    // Rotate around Y
    let angle = 0.05;
    let sinAngle = Math.sin(angle / 2.0);
    rotationAxis.set(0, 1, 0);
    quaternion0.set(
      rotationAxis.x * sinAngle,
      rotationAxis.y * sinAngle,
      rotationAxis.z * sinAngle,
      Math.cos(angle / 2.0)
    );

    // Rotate around X
    angle = 0.3;
    sinAngle = Math.sin(angle / 2.0);
    rotationAxis.set(1, 0, 0);
    quaternion1.set(
      rotationAxis.x * sinAngle,
      rotationAxis.y * sinAngle,
      rotationAxis.z * sinAngle,
      Math.cos(angle / 2.0)
    );
    quaternion0.multiply(quaternion1);

    // Rotate around Z
    angle = 0.1;
    sinAngle = Math.sin(angle / 2.0);
    rotationAxis.set(0, 0, 1);
    quaternion1.set(
      rotationAxis.x * sinAngle,
      rotationAxis.y * sinAngle,
      rotationAxis.z * sinAngle,
      Math.cos(angle / 2.0)
    );
    quaternion0.multiply(quaternion1);

    // Bend grass base geometry for more organic look
    const positions = geometry.attributes.position;
    for (let v = 0; v < positions.count; v++) {
      vertex.fromBufferAttribute(positions, v);
      const frac = vertex.y / bladeHeight;
      quaternion2.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
      quaternion2.slerp(quaternion0, frac);
      vertex.applyQuaternion(quaternion2);
      positions.setXYZ(v, vertex.x, vertex.y, vertex.z);
    }

    geometry.computeVertexNormals();
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
      this._loadTexture(GRASS_DIFFUSE_URL),
      this._loadTexture(GRASS_ALPHA_URL),
      this._loadTexture(GRASS_NOISE_URL),
    ]).then(([diffuse, alpha, noise]) => {
      this.material.setupTextures(diffuse, alpha, noise);
    }).catch((err) => {
      console.warn('[grass] texture load failed', err);
    });
  }

  update(deltaTime = 0) {
    if (!this.material) return;
    this.material.update(deltaTime);
    if (this.camera) {
      this.material.updateCamera(this.camera);
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

    // Create InstancedBufferGeometry with custom attributes
    const instancedGeometry = new THREE.InstancedBufferGeometry();
    instancedGeometry.index = this._bladeGeometry.index;
    instancedGeometry.attributes.position = this._bladeGeometry.attributes.position;
    instancedGeometry.attributes.uv = this._bladeGeometry.attributes.uv;
    instancedGeometry.attributes.normal = this._bladeGeometry.attributes.normal;

    // Per-instance attributes
    const indices = [];
    const offsets = [];
    const scales = [];
    const halfRootAngles = [];

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

        // Index for color variation
        indices.push(placed / targetCount);

        // Offset position
        offsets.push(this._tempPosition.x, this._tempPosition.y, this._tempPosition.z);

        // Random orientation around Y axis
        const angle = Math.PI - Math.random() * (2 * Math.PI);
        halfRootAngles.push(Math.sin(0.5 * angle), Math.cos(0.5 * angle));

        // Random scale variation
        if (placed % 3 !== 0) {
          scales.push(2.0 + Math.random() * 1.25);
        } else {
          scales.push(2.0 + Math.random());
        }

        placed += 1;
      }
    }

    if (placed === 0) return;

    // Set instance attributes
    const offsetAttribute = new THREE.InstancedBufferAttribute(new Float32Array(offsets), 3);
    const scaleAttribute = new THREE.InstancedBufferAttribute(new Float32Array(scales), 1);
    const halfRootAngleAttribute = new THREE.InstancedBufferAttribute(new Float32Array(halfRootAngles), 2);
    const indexAttribute = new THREE.InstancedBufferAttribute(new Float32Array(indices), 1);

    instancedGeometry.setAttribute('offset', offsetAttribute);
    instancedGeometry.setAttribute('scale', scaleAttribute);
    instancedGeometry.setAttribute('halfRootAngle', halfRootAngleAttribute);
    instancedGeometry.setAttribute('index', indexAttribute);

    const mesh = new THREE.Mesh(instancedGeometry, this.material.material);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.name = `grass-${tile.q},${tile.r}`;

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
    if (mesh?.geometry) {
      mesh.geometry.dispose();
    }
    this.tileGrass.delete(key);
  }

  dispose() {
    for (const entry of this.tileGrass.values()) {
      if (entry.mesh?.parent) entry.mesh.parent.remove(entry.mesh);
      if (entry.mesh?.geometry) entry.mesh.geometry.dispose();
    }
    this.tileGrass.clear();
    this._bladeGeometry?.dispose?.();
    this.material?.material?.dispose?.();
    this.material = null;
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
