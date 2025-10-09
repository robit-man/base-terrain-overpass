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
    this.scene.fog = new THREE.Fog(0x1e212b, 1000, 10000);
    this.scene.background = new THREE.Color(0x1e212b);

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

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });

    this.updateSun({ lat: 0, lon: 0, date: new Date() });
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
