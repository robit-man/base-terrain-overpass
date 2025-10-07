import * as THREE from 'three';

// Lazy import GLTFLoader so we don't touch index.html import map
const loadGLTFLoader = async () => {
  const mod = await import('https://cdn.jsdelivr.net/npm/three@0.177.0/examples/jsm/loaders/GLTFLoader.js');
  return mod.GLTFLoader;
};

const RAW_ANIMATION_URLS = {
  Idle: '/models/anims/Idle.glb',
  Walk: '/models/anims/Walk_Forward.glb',
  Run: '/models/anims/Sprint.glb',
};
const ANIMATION_URLS = Object.fromEntries(
  Object.entries(RAW_ANIMATION_URLS).map(([k, url]) => [k, encodeURI(url)])
);

let animationClipCachePromise = null;
let animationSourcePromise = null;
let skeletonUtilsPromise = null;

const ROOT_BONE_HINTS = ['characters3dcom___hips', 'mixamorighips', 'hips'];

const clipNameMatches = (clip, regex) => {
  const name = clip?.name || '';
  return regex.test(name.toLowerCase());
};

const CHARACTER_CLIP_SPECS = {
  Idle: {
    names: ['Idle'],
    match: [/\bidle\b/],
    fallback: [0]
  },
  WalkForward: {
    names: ['Walk Forward', 'Walk'],
    match: [/walk\s*forward/, /\bwalk\b/],
    fallback: [2, 3]
  },
  WalkBackward: {
    names: ['Walk Backward'],
    match: [/walk\s*back/],
    fallback: [1]
  },
  WalkLeft: {
    names: ['Walk Left'],
    match: [/walk\s*left/],
    fallback: [3]
  },
  WalkRight: {
    names: ['Walk Right'],
    match: [/walk\s*right/],
    fallback: [4]
  },
  Sprint: {
    names: ['Sprint', 'Run'],
    match: [/\bsprint\b/, /\brun\b/],
    fallback: [13, 1]
  },
  CrouchIdle: {
    names: ['Crouch Idle'],
    match: [/crouch\s*idle/],
    fallback: [5]
  },
  CrouchForward: {
    names: ['Crouch Move Forward Stealth', 'Crouch Walk'],
    match: [/crouch.*forward/, /crouch.*walk/],
    fallback: [7, 8]
  },
  CrouchBackward: {
    names: ['Crouch Move Backward Stealth'],
    match: [/crouch.*back/],
    fallback: [6]
  },
  CrouchLeft: {
    names: ['Crouch Move Left Stealth'],
    match: [/crouch.*left/],
    fallback: [9]
  },
  CrouchRight: {
    names: ['Crouch Move Right Stealth'],
    match: [/crouch.*right/],
    fallback: [10]
  },
  Fall: {
    names: ['Fall'],
    match: [/fall/],
    fallback: [11]
  },
  Death: {
    names: ['Death'],
    match: [/death/],
    fallback: [12]
  },
  Surrender: {
    names: ['Surrender'],
    match: [/surrender/],
    fallback: [14]
  },
  Meditate: {
    names: ['Meditate'],
    match: [/meditate/],
    fallback: [15]
  }
};

const cloneClip = (clip) => (clip ? clip.clone() : null);

export const stripRootMotionFromClip = (clip, opts = {}) => {
  if (!clip) return clip;
  const { rootNames = ROOT_BONE_HINTS, freeze = { x: true, z: true }, preserveY = true } = opts;
  const roots = (rootNames || []).map((name) => String(name || '').toLowerCase());
  const shouldFreezeAxis = (axis) => {
    if (!freeze || typeof freeze !== 'object') return true;
    if (typeof freeze[axis] === 'boolean') return freeze[axis];
    return true;
  };

  for (const track of clip.tracks || []) {
    const trackName = (track?.name || '').toLowerCase();
    if (!trackName.endsWith('.position')) continue;
    if (roots.length && !roots.some((root) => trackName.includes(root))) continue;
    const valueSize = typeof track.getValueSize === 'function' ? track.getValueSize() : track.ValueTypeName === 'vector' ? 3 : null;
    if (valueSize !== 3) continue;
    const values = track.values;
    if (!values || values.length === 0) continue;
    for (let i = 0; i < values.length; i += 3) {
      if (shouldFreezeAxis('x')) values[i] = 0;
      if (!preserveY) values[i + 1] = 0;
      if (shouldFreezeAxis('z')) values[i + 2] = 0;
    }
    track.needsUpdate = true;
  }
  clip.optimize?.();
  return clip;
};

const lowerEquals = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

const findClipInList = (clips, spec) => {
  if (!Array.isArray(clips) || !spec) return null;
  const haystack = clips.filter(Boolean);
  if (!haystack.length) return null;

  if (spec.names) {
    for (const name of spec.names) {
      const found = haystack.find((clip) => lowerEquals(clip?.name, name));
      if (found) return cloneClip(found);
    }
  }

  if (spec.match) {
    const regexes = Array.isArray(spec.match) ? spec.match : [spec.match];
    for (const rx of regexes) {
      const found = haystack.find((clip) => clipNameMatches(clip, rx));
      if (found) return cloneClip(found);
    }
  }

  if (spec.fallback) {
    for (const idx of spec.fallback) {
      if (idx != null && idx >= 0 && idx < haystack.length) {
        const clip = haystack[idx];
        if (clip) return cloneClip(clip);
      }
    }
  }

  return null;
};

const buildClipMapFromList = (clips, opts = {}) => {
  const out = {};
  if (!Array.isArray(clips)) return out;
  for (const [key, spec] of Object.entries(CHARACTER_CLIP_SPECS)) {
    const found = findClipInList(clips, spec);
    out[key] = found ? stripRootMotionFromClip(found, opts.stripOptions) : null;
  }
  return out;
};

export const CHARACTER_CLIP_KEYS = Object.freeze(Object.keys(CHARACTER_CLIP_SPECS));

export const deriveClipsFromAnimations = (animations, opts = {}) => {
  return buildClipMapFromList(animations, opts);
};

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

export async function loadCharacterAnimationClips(loader, target, nativeClips = null) {
  if (!loader) throw new Error('GLTFLoader instance required for loadCharacterAnimationClips');
  if (!target) throw new Error('Target object required to retarget animation clips');

  if (nativeClips && !Array.isArray(nativeClips)) {
    throw new Error('nativeClips, when provided, must be an array');
  }

  const nativeMap = deriveClipsFromAnimations(nativeClips || []);
  let needsExternal = CHARACTER_CLIP_KEYS.some((key) => !nativeMap[key]);

  const externalMap = {};

  if (needsExternal) {
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
    } else {
      const { SkeletonUtils } = skeletonUtilsMod;
      const retargeted = {};
      for (const key of Object.keys(ANIMATION_URLS)) {
        const source = sources[key];
        if (!source?.clip || !source?.root) {
          retargeted[key] = null;
          continue;
        }
        const sourceScene = SkeletonUtils.clone(source.root);
        const sourceBundle = getSkinBundle(sourceScene);
        if (!sourceBundle) {
          console.warn(`[CharacterAnimator] missing skeleton for ${key}`);
          retargeted[key] = null;
          continue;
        }
        const clipClone = cloneClip(source.clip);
        let remapped = null;
        try {
          remapped = SkeletonUtils.retargetClip(
            targetBundle.mesh,
            sourceBundle.skeleton,
            clipClone,
            { useTargetRestPose: true }
          );
        } catch (err) {
          console.warn(`[CharacterAnimator] retarget failed for ${key}`, err);
        }
        retargeted[key] = stripRootMotionFromClip(remapped || clipClone || null);
      }

      externalMap.Idle = retargeted.Idle || null;
      externalMap.WalkForward = retargeted.Walk || retargeted.WalkForward || null;
      externalMap.Sprint = retargeted.Run || retargeted.Sprint || null;
      externalMap.Walk = externalMap.WalkForward || null;
      externalMap.Run = externalMap.Sprint || null;
    }
  }

  const final = {};
  for (const key of CHARACTER_CLIP_KEYS) {
    final[key] = nativeMap[key] || externalMap[key] || null;
  }
  // Provide legacy aliases expected elsewhere.
  final.Walk = final.WalkForward || final.Walk || null;
  final.Run = final.Sprint || final.Run || null;

  return final;
}

// Default in-repo avatar model
//const DEFAULT_MODEL = 'https://threejs.org/examples/models/gltf/Soldier.glb';
const DEFAULT_MODEL = '/models/Character.glb';

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

      const nativeDerived = deriveClipsFromAnimations(gltf.animations || []);
      let externalClips = {};
      try {
        externalClips = await loadCharacterAnimationClips(loader, this.model, gltf.animations || []);
      } catch (err) {
        console.warn('[CharacterAnimator] retargeted clips unavailable, using native animations', err);
        externalClips = {};
      }
      const clipMap = { ...nativeDerived, ...externalClips };
      clipMap.Walk = clipMap.Walk || clipMap.WalkForward || null;
      clipMap.Run = clipMap.Run || clipMap.Sprint || null;
      const idleClip = clipMap.Idle || clipMap.CrouchIdle || clipMap.WalkForward || null;
      const runClip  = clipMap.Sprint || clipMap.Run || null;
      const walkClip = clipMap.WalkForward || clipMap.Walk || clipMap.Sprint || null;
      const fallClip = clipMap.Fall || null;

      // Initial facing: -Z (match three example)
      this.model.rotation.y = Math.PI;
      this.model.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = true; o.receiveShadow = true;
        if (o.material) { o.material.metalness = 1.0; o.material.roughness = 0.2; }
      });

      this.mixer = new THREE.AnimationMixer(this.model);
      this.actions = {
        Idle: idleClip ? this.mixer.clipAction(idleClip) : null,
        Run : runClip  ? this.mixer.clipAction(runClip)   : null,
        Walk: walkClip ? this.mixer.clipAction(walkClip)  : null,
        Fall: fallClip ? this.mixer.clipAction(fallClip)  : null,
      };

      for (const k in this.actions) {
        const a = this.actions[k];
        if (!a) continue;
        a.enabled = true;
        a.setEffectiveTimeScale(1);
        if (k !== 'Idle') a.setEffectiveWeight(0);
        if (k === 'Fall') {
          a.loop = THREE.LoopOnce;
          a.clampWhenFinished = true;
        }
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
    let next = 'Idle';
    if ((jump || this._jumpYOffset > 1e-3) && this.actions?.Fall) {
      next = 'Fall';
    } else if (speed >= this.runThreshold && this.actions?.Run) {
      next = 'Run';
    } else if (speed >= this.walkThreshold && this.actions?.Walk) {
      next = 'Walk';
    }
    this._setAction(next);

    // Animate
    if (this.mixer) this.mixer.update(dt);
  }

  setVisible(v) {
    if (this.model) this.model.visible = !!v;
  }
}
