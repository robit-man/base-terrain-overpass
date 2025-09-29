import * as THREE from 'three';
import { VRButton } from 'VRButton';

export class SceneManager {
  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(innerWidth, innerHeight);
    this.renderer.setPixelRatio(devicePixelRatio);
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

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x121212, 40, 220);
    this.scene.background = new THREE.Color(0x121212);

    // 🎯 Camera stays at (0,0,0) in dolly local space; dolly handles eye height
    this.camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 1000);
    this.camera.position.set(0, 0, 0);
    this.camera.up.set(0, 1, 0);

    // Dolly = player rig; add camera as a child (critical for chasecam & FPV)
    this.dolly = new THREE.Group();
    this.dolly.name = 'player-dolly';
    this.dolly.add(this.camera);
    this.scene.add(this.dolly);

    // Lights
    const hemi = new THREE.HemisphereLight(0x30344a, 0x050507, 0.45);
    this.scene.add(hemi);

    const keyLight = new THREE.DirectionalLight(0xffe7c4, 1.35);
    keyLight.position.set(160, 240, 120);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(2048, 2048);
    keyLight.shadow.camera.near = 10;
    keyLight.shadow.camera.far = 800;
    keyLight.shadow.camera.left = -320;
    keyLight.shadow.camera.right = 320;
    keyLight.shadow.camera.top = 320;
    keyLight.shadow.camera.bottom = -320;
    this.scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x526dff, 0.55);
    rimLight.position.set(-220, 140, -260);
    this.scene.add(rimLight);

    const ambient = new THREE.AmbientLight(0x1a1b23, 0.3);
    this.scene.add(ambient);

    // Where remote avatars live
    this.remoteLayer = new THREE.Group();
    this.remoteLayer.name = 'remote-layer';
    this.scene.add(this.remoteLayer);

    addEventListener('resize', () => {
      this.camera.aspect = innerWidth / innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(innerWidth, innerHeight);
    });
  }
}
