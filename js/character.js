import * as THREE from 'three';

// Lazy import GLTFLoader so we don't touch index.html import map
const loadGLTFLoader = async () => {
  const mod = await import('https://cdn.jsdelivr.net/npm/three@0.177.0/examples/jsm/loaders/GLTFLoader.js');
  return mod.GLTFLoader;
};

// Default Mixamo soldier (same as three.js example)
const DEFAULT_MODEL = 'https://threejs.org/examples/models/gltf/Soldier.glb';

export class CharacterAnimator {
  constructor(opts = {}) {
    this.parent = opts.parent || null;
    this.modelUrl = opts.modelUrl || DEFAULT_MODEL;
    this.showOnReady = opts.showOnReady ?? true;
    this.hideFallbackMesh = opts.hideFallbackMesh || null;

    this.group = new THREE.Group();
    this.group.name = 'CharacterAnimator';
    if (this.parent) this.parent.add(this.group);

    this.mixer = null;
    this.actions = null;
    this.current = 'Idle';
    this.fadeDuration = 0.5;

    this.rotateSpeed = 0.12;       // yaw ease (rad/s-like)
    this.walkThreshold = 0.3;      // m/s
    this.runThreshold  = 3.0;      // m/s

    this._jumpYOffset = 0;         // small visual hop
    this._jumpVel = 0;
    this._grav = 20;

    this.ready = false;
    this._load();
  }

  async _load() {
    try {
      const GLTFLoader = await loadGLTFLoader();
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(this.modelUrl);

      this.model = gltf.scene;
      // Initial facing: -Z (match three example)
      this.model.rotation.y = Math.PI;
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (o.material) { o.material.metalness = 1.0; o.material.roughness = 0.2; }
      });

      this.mixer = new THREE.AnimationMixer(this.model);
      const animations = gltf.animations || [];
      // three example order: 0=Idle, 1=Run, 3=Walk
      this.actions = {
        Idle: this.mixer.clipAction(animations[0]),
        Run : this.mixer.clipAction(animations[1]),
        Walk: this.mixer.clipAction(animations[3]),
      };

      for (const k in this.actions) {
        const a = this.actions[k];
        a.enabled = true; a.setEffectiveTimeScale(1);
        if (k !== 'Idle') a.setEffectiveWeight(0);
      }
      this.actions.Idle.play();

      this.group.add(this.model);
      if (this.hideFallbackMesh) this.hideFallbackMesh.visible = false; // hide proxy
      this.model.visible = !!this.showOnReady;

      this.ready = true;
    } catch (e) {
      console.warn('[CharacterAnimator] load failed', e);
      this.ready = false;
    }
  }

  _setAction(next) {
    if (!this.actions || this.current === next) return;
    const cur = this.actions[this.current];
    const nxt = this.actions[next];
    this.current = next;
    if (!nxt || !cur) return;

    // Fixed transition with time sync (like example)
    nxt.reset();
    nxt.weight = 1.0;
    nxt.stopFading(); cur.stopFading();
    if (next !== 'Idle') {
      // sync phases so feet don't pop
      const ratio = nxt.getClip().duration / cur.getClip().duration;
      nxt.time = cur.time * ratio;
    }
    cur._scheduleFading(this.fadeDuration, cur.getEffectiveWeight(), 0);
    nxt._scheduleFading(this.fadeDuration, nxt.getEffectiveWeight(), 1);
    nxt.play();
  }

  update(dt, { position, yaw, speed, jump } = {}) {
    if (!this.ready) return;

    // Light hop on jump cue
    if (jump) {
      this._jumpVel = Math.sqrt(2 * this._grav * 0.25);
    }
    if (this._jumpVel !== 0 || this._jumpYOffset !== 0) {
      this._jumpVel -= this._grav * dt;
      this._jumpYOffset += this._jumpVel * dt;
      if (this._jumpYOffset <= 0) { this._jumpYOffset = 0; this._jumpVel = 0; }
    }

    // Drive pose
    if (position) {
      // Keep the group at supplied position; offset the model a touch for hop
      this.group.position.copy(position);
      if (this.model) this.model.position.y = this._jumpYOffset;
    }

    // Smoothly face towards yaw (Y axis)
    if (Number.isFinite(yaw)) {
      const targetQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, yaw, 0));
      this.group.quaternion.slerp(targetQ, Math.min(1, dt * (1 / Math.max(0.001, 1/this.rotateSpeed))));
    }

    // Select clip
    const next =
      speed < this.walkThreshold ? 'Idle' :
      speed < this.runThreshold  ? 'Walk' : 'Run';
    this._setAction(next);

    // Animate
    if (this.mixer) this.mixer.update(dt);
  }

  setVisible(v) {
    if (this.model) this.model.visible = !!v;
  }
}
