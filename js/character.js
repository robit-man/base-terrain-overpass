import * as THREE from 'three';

// Lazy import GLTFLoader so we don't touch index.html import map
const loadGLTFLoader = async () => {
  const mod = await import('https://cdn.jsdelivr.net/npm/three@0.177.0/examples/jsm/loaders/GLTFLoader.js');
  return mod.GLTFLoader;
};

const RAW_ANIMATION_URLS = {
  Idle: '/models/anims/Idle.glb',
  Walk: '/models/anims/Walk_Forward.glb',
  Run: '/models/anims/Sprint .glb',
};
const ANIMATION_URLS = Object.fromEntries(
  Object.entries(RAW_ANIMATION_URLS).map(([k, url]) => [k, encodeURI(url)])
);

let animationClipCachePromise = null;
let animationSourcePromise = null;
let skeletonUtilsPromise = null;

const clipNameMatches = (clip, regex) => {
  const name = clip?.name || '';
  return regex.test(name.toLowerCase());
};

const pickClip = (preferred, fallbackClips, regex, fallbackOrder = []) => {
  if (preferred) return preferred;
  if (Array.isArray(fallbackClips)) {
    if (regex) {
      const byName = fallbackClips.find((clip) => clipNameMatches(clip, regex));
      if (byName) return byName;
    }
    for (const idx of fallbackOrder) {
      const clip = fallbackClips[idx];
      if (clip) return clip;
    }
  }
  return null;
};

const cloneClip = (clip) => (clip ? clip.clone() : null);

const loadSkeletonUtils = async () => {
  if (!skeletonUtilsPromise) {
    skeletonUtilsPromise = import('https://cdn.jsdelivr.net/npm/three@0.177.0/examples/jsm/utils/SkeletonUtils.js');
  }
  return skeletonUtilsPromise;
};

const getSkinBundle = (root) => {
  if (!root) return null;
  let mesh = null;
  root.traverse((obj) => {
    if (mesh || !obj.isSkinnedMesh) return;
    mesh = obj;
  });
  if (mesh && mesh.skeleton) return { mesh, skeleton: mesh.skeleton };
  if (mesh) {
    const helper = new THREE.SkeletonHelper(mesh);
    const skeleton = new THREE.Skeleton(helper.bones);
    helper.visible = false;
    helper.dispose?.();
    return { mesh, skeleton };
  }
  const helper = new THREE.SkeletonHelper(root);
  const skeleton = new THREE.Skeleton(helper.bones);
  helper.visible = false;
  helper.dispose?.();
  return { mesh: root, skeleton };
};

async function loadAnimationSources(loader) {
  if (!animationSourcePromise) {
    animationSourcePromise = Promise.all(Object.entries(ANIMATION_URLS).map(async ([key, url]) => {
      try {
        const gltf = await loader.loadAsync(url);
        const clip = gltf.animations?.[0] || null;
        if (!clip) {
          console.warn(`[CharacterAnimator] animation "${key}" missing clip in ${url}`);
          return [key, { clip: null, root: null }];
        }
        return [key, { clip, root: gltf.scene }];
      } catch (err) {
        console.warn(`[CharacterAnimator] failed to load ${url}`, err);
        return [key, { clip: null, root: null }];
      }
    })).then((entries) => {
      const out = {};
      for (const [key, value] of entries) out[key] = value;
      return out;
    });
  }
  return animationSourcePromise;
}

export async function loadCharacterAnimationClips(loader, target) {
  if (!loader) throw new Error('GLTFLoader instance required for loadCharacterAnimationClips');
  if (!target) throw new Error('Target object required to retarget animation clips');

  if (!animationClipCachePromise) {
    animationClipCachePromise = (async () => {
      const sources = await loadAnimationSources(loader);
      return sources;
    })();
  }

  const [sources, skeletonUtilsMod] = await Promise.all([
    animationClipCachePromise,
    loadSkeletonUtils()
  ]);
  const targetBundle = getSkinBundle(target);
  if (!targetBundle) {
    console.warn('[CharacterAnimator] no skinned mesh found on target model', target);
  }
  const { SkeletonUtils } = skeletonUtilsMod;

  const result = {};
  for (const key of Object.keys(ANIMATION_URLS)) {
    const source = sources[key];
    if (!source?.clip || !source?.root) {
      result[key] = null;
      continue;
    }
    const sourceScene = SkeletonUtils.clone(source.root);
    const sourceBundle = getSkinBundle(sourceScene);
    if (!targetBundle || !sourceBundle) {
      console.warn(`[CharacterAnimator] missing skeleton for ${key}`);
      result[key] = null;
      continue;
    }
    const clipClone = cloneClip(source.clip);
    let retargeted = null;
    try {
      retargeted = SkeletonUtils.retargetClip(
        targetBundle.mesh,
        sourceBundle.skeleton,
        clipClone,
        { useTargetRestPose: true }
      );
    } catch (err) {
      console.warn(`[CharacterAnimator] retarget failed for ${key}`, err);
    }
    result[key] = retargeted || clipClone || null;
  }
  return result;
}

// Default Mixamo soldier (same as three.js example)
//const DEFAULT_MODEL = 'https://threejs.org/examples/models/gltf/Soldier.glb';
const DEFAULT_MODEL = '/models/Char.glb';

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

      const externalClips = await loadCharacterAnimationClips(loader, this.model).catch(() => ({ Idle: null, Walk: null, Run: null }));

      // Initial facing: -Z (match three example)
      this.model.rotation.y = Math.PI;
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (o.material) { o.material.metalness = 1.0; o.material.roughness = 0.2; }
      });

      this.mixer = new THREE.AnimationMixer(this.model);
      const fallback = gltf.animations || [];
      const idleClip = pickClip(externalClips?.Idle, fallback, /idle/, [0]);
      const runClip  = pickClip(externalClips?.Run,  fallback, /run|sprint/, [1, 2]);
      const walkClip = pickClip(externalClips?.Walk, fallback, /walk/, [3, 2]);
      this.actions = {
        Idle: idleClip ? this.mixer.clipAction(idleClip) : null,
        Run : runClip  ? this.mixer.clipAction(runClip)   : null,
        Walk: walkClip ? this.mixer.clipAction(walkClip)  : null,
      };

      for (const k in this.actions) {
        const a = this.actions[k];
        if (!a) continue;
        a.enabled = true; a.setEffectiveTimeScale(1);
        if (k !== 'Idle') a.setEffectiveWeight(0);
      }
      const startKey = idleClip ? 'Idle' : (walkClip ? 'Walk' : (runClip ? 'Run' : null));
      if (startKey && this.actions[startKey]) {
        this.actions[startKey].setEffectiveWeight(1).play();
        this.current = startKey;
      }
      if (!this.actions[this.current]) {
        const fallbackKey = ['Idle', 'Walk', 'Run'].find((k) => this.actions[k]);
        if (fallbackKey) this.current = fallbackKey;
      }

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
    const nxt = this.actions[next];
    if (!nxt) return;
    const cur = this.actions[this.current];
    this.current = next;
    if (!cur) {
      nxt.reset().setEffectiveWeight(1).play();
      return;
    }

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
