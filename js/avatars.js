import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadCharacterAnimationClips } from './character.js';

//const MODEL_URL = 'https://threejs.org/examples/models/gltf/Soldier.glb';
const MODEL_URL = '/models/Char.glb';

function buildFallbackTemplate() {
  const root = new THREE.Group();

  const bodyMat = new THREE.MeshStandardMaterial({ color: 0x3a82f7, metalness: 0.15, roughness: 0.65 });
  const headMat = new THREE.MeshStandardMaterial({ color: 0xffd8b5, metalness: 0.05, roughness: 0.4 });

  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 1.05, 12, 18), bodyMat);
  body.castShadow = true; body.receiveShadow = true;
  root.add(body);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 14), headMat);
  head.castShadow = true; head.receiveShadow = true;
  head.position.y = 0.95 + 0.24 + 0.05; // sit just above body top
  root.add(head);

  const visor = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.18, 0.08, 12, 1, true), new THREE.MeshStandardMaterial({ color: 0x222831, metalness: 0.6, roughness: 0.2, side: THREE.DoubleSide }));
  visor.rotation.z = Math.PI / 2;
  visor.position.set(0, head.position.y + 0.02, 0.18);
  root.add(visor);

  // Arms (simple sticks)
  const armGeo = new THREE.CapsuleGeometry(0.09, 0.65, 8, 12);
  const armL = new THREE.Mesh(armGeo, bodyMat);
  armL.rotation.z = Math.PI / 2;
  armL.position.set(0.46, 0.45, 0);
  armL.castShadow = armL.receiveShadow = true;
  root.add(armL);
  const armR = armL.clone(); armR.position.x = -0.46; root.add(armR);

  // Legs (two shorter capsules)
  const legGeo = new THREE.CapsuleGeometry(0.11, 0.8, 10, 16);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x2d2f3a, metalness: 0.1, roughness: 0.7 });
  const legL = new THREE.Mesh(legGeo, legMat);
  legL.position.set(0.18, -0.7, 0);
  legL.castShadow = legL.receiveShadow = true;
  root.add(legL);
  const legR = legL.clone(); legR.position.x = -0.18; root.add(legR);

  // Ensure feet rest on y=0 plane
  const bounds = new THREE.Box3().setFromObject(root);
  const min = bounds.min.clone();
  root.position.y -= min.y;

  const bbox = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3(); bbox.getSize(size);
  const height = size.y || 1.7;
  const footYOffset = -bbox.min.y;

  return { template: root, footYOffset, height };
}

function byName(animations, name) {
  const n = (name || '').toLowerCase();
  return animations.find(c => (c.name || '').toLowerCase() === n) || null;
}

function clipsWithFallback(anims) {
  // Example Soldier.glb ordering: [0]=Idle, [1]=Run, [3]=Walk (index 2 is often T-Pose/unused)
  const Idle = byName(anims, 'Idle') || anims[0];
  const Run  = byName(anims, 'Run')  || anims[1] || anims.find(a => /run/i.test(a.name));
  const Walk = byName(anims, 'Walk') || anims[3] || anims.find(a => /walk/i.test(a.name));
  return { Idle, Walk, Run };
}

// exp smoothing factor per (rate, dt)
function smoothAlpha(ratePerSec, dt) {
  return 1 - Math.exp(-Math.max(0, ratePerSec) * Math.max(0, dt));
}

export class Avatar {
  constructor(root, mixer, clips, footYOffset, height) {
    this.group = new THREE.Group();
    this.group.add(root);

    this.root = root;
    this.mixer = mixer;
    this.height = height;

    // Align feet to y=0
    this.root.position.y -= footYOffset;

    // Material basics
    this.root.traverse(obj => {
      if (obj.isMesh) {
        obj.castShadow = true;
        obj.receiveShadow = true;
        if (obj.material && 'metalness' in obj.material) {
          obj.material.metalness = 0.2;
          obj.material.roughness = 0.6;
          obj.material.wireframe = true;
        }
      }
    });

    // Build actions
    this.actions = {
      Idle: clips.Idle ? mixer.clipAction(clips.Idle) : null,
      Walk: clips.Walk ? mixer.clipAction(clips.Walk) : null,
      Run:  clips.Run  ? mixer.clipAction(clips.Run)  : null
    };
    for (const k of Object.keys(this.actions)) {
      const a = this.actions[k];
      if (!a) continue;
      a.enabled = true;
      a.setEffectiveTimeScale(1);
      a.setEffectiveWeight(0);
      a.clampWhenFinished = false;
      a.loop = THREE.LoopRepeat;
    }

    // Start playing (avoid T-pose)
    const start = this.actions.Idle || this.actions.Walk || this.actions.Run;
    if (start) start.setEffectiveWeight(1).play();
    this.current = start === this.actions.Idle ? 'Idle' : (start === this.actions.Walk ? 'Walk' : 'Run');

    // Transition & motion tuning
    this.fadeDuration = 0.5;      // matches demo controls.fadeDuration

    // HYSTERESIS: prevents flapping at boundaries
    this.walkOn  = 0.12;  // enter Walk above this
    this.walkOff = 0.08;  // leave Walk below this
    this.runOn   = 4.20;  // enter Run above this
    this.runOff  = 3.40;  // leave Run below this

    // Speed smoothing (EMA)
    this._vTarget = 0;           // raw setSpeed
    this._vSmooth = 0;           // filtered
    this._vRate   = 12;          // Hz — how quickly we track target speed

    // Simple jump hop
    this.GRAV = 20;
    this.JUMP_H = 0.8;
    this.jumpState = 'idle';
    this.vertVel = 0;
    this.jumpYOffset = 0;
    this.baseY = 0;
  }

  setQuaternion(q) { this.group.quaternion.copy(q); }

  setPosition(x, y, z) {
    this.baseY = y;
    this.group.position.set(x, y + this.jumpYOffset, z);
  }

  /**
   * External callers provide instantaneous speed each frame.
   * We only store it; state decisions happen in update(dt) on the smoothed value.
   */
  setSpeed(speed) {
    this._vTarget = speed;
  }

  /** Decide Idle/Walk/Run using hysteresis on the *smoothed* speed. */
  _decideState(v) {
    let desired = this.current || 'Idle';
    if (this.current === 'Run') {
      if (v <= this.runOff) desired = (v <= this.walkOff) ? 'Idle' : 'Walk';
    } else if (this.current === 'Walk') {
      if (v >= this.runOn) desired = 'Run';
      else if (v <= this.walkOff) desired = 'Idle';
    } else { // Idle
      if (v >= this.runOn) desired = 'Run';
      else if (v >= this.walkOn) desired = 'Walk';
    }
    if (!this.actions[desired]) {
      desired = ['Idle', 'Walk', 'Run'].find((name) => this.actions[name]) || desired;
    }
    return desired;
  }

  /** Do a demo-style, phase-synced transition using public APIs. */
  _transition(nextName) {
    const next = this.actions[nextName];
    const prev = this.actions[this.current];

    if (nextName === this.current) return;

    this.current = nextName;

    if (!next) {
      if (prev) prev.fadeOut(this.fadeDuration);
      return;
    }

    if (!prev || prev === next) {
      next.reset().fadeIn(this.fadeDuration).play();
      return;
    }

    // ---- Phase sync (like the demo's "fixe_transition") ----
    const prevClip = prev.getClip();
    const nextClip = next.getClip();
    const prevDur = Math.max(1e-6, prevClip?.duration || 1);
    const nextDur = Math.max(1e-6, nextClip?.duration || 1);
    const norm = (prev.time % prevDur) / prevDur;

    next.enabled = true;
    next.reset();
    next.time = norm * nextDur;
    next.setEffectiveWeight(1);

    // Cross-fade with warp=true to preserve cadence/stride
    next.crossFadeFrom(prev, this.fadeDuration, /*warp=*/true);
    next.play();
  }

  jump() {
    if (this.jumpState !== 'idle') return;
    this.vertVel = Math.sqrt(2 * this.GRAV * this.JUMP_H);
    this.jumpState = 'jumping';
  }

  update(dt) {
    // Smooth speed towards target
    const a = smoothAlpha(this._vRate, dt);
    this._vSmooth += (this._vTarget - this._vSmooth) * a;

    // Pick state using hysteresis on smoothed speed
    const desired = this._decideState(this._vSmooth);
    if (desired !== this.current) this._transition(desired);

    // Tempo adaptation (no clip restart)
    if (this.current === 'Walk' && this.actions.Walk) {
      const walkRef = 1.8; // m/s nominal
      this.actions.Walk.setEffectiveTimeScale(THREE.MathUtils.clamp(this._vSmooth / walkRef, 0.6, 1.6));
    } else if (this.current === 'Run' && this.actions.Run) {
      const runRef = 5.0;  // m/s nominal
      this.actions.Run.setEffectiveTimeScale(THREE.MathUtils.clamp(this._vSmooth / runRef, 0.7, 1.6));
    } else if (this.actions.Idle) {
      this.actions.Idle.setEffectiveTimeScale(1);
    }

    // Jump arc
    if (this.jumpState === 'jumping') {
      this.vertVel -= this.GRAV * dt;
      this.jumpYOffset += this.vertVel * dt;
      if (this.jumpYOffset <= 0) {
        this.jumpYOffset = 0;
        this.vertVel = 0;
        this.jumpState = 'idle';
      }
    }

    // Maintain y = base + jump
    this.group.position.y = this.baseY + this.jumpYOffset;

    if (this.mixer) this.mixer.update(dt);
  }
}

export class AvatarFactory {
  static _promise = null;

  static load() {
    if (this._promise) return this._promise;
    this._promise = (async () => {
      const loader = new GLTFLoader();
      try {
        const gltf = await loader.loadAsync(MODEL_URL);
        const template = gltf.scene;
        const animations = gltf.animations || [];
        const external = await loadCharacterAnimationClips(loader, template).catch(() => ({ Idle: null, Walk: null, Run: null }));
        const fallback = clipsWithFallback(animations);
        const clips = {
          Idle: external.Idle || fallback.Idle || null,
          Walk: external.Walk || fallback.Walk || null,
          Run: external.Run || fallback.Run || null,
        };

        // bounds for foot alignment and height
        const bounds = new THREE.Box3().setFromObject(template);
        const size = new THREE.Vector3(); bounds.getSize(size);
        const min = bounds.min; const height = size.y || 1.7;
        const footYOffset = -min.y;

        return new AvatarFactory(template, clips, footYOffset, height);
      } catch (err) {
        console.warn('[avatar] gltf load failed, falling back to primitive avatar', err);
        const fallback = buildFallbackTemplate();
        return new AvatarFactory(fallback.template, { Idle: null, Walk: null, Run: null }, fallback.footYOffset, fallback.height);
      }
    })();
    return this._promise;
  }

  constructor(template, clips, footYOffset, height) {
    this.template = template;
    this.clips = clips;
    this.footYOffset = footYOffset;
    this.height = height;
  }

  create() {
    // Deep clone preserves skinning and bone hierarchy
    const root = SkeletonUtils.clone(this.template);
    const mixer = new THREE.AnimationMixer(root);
    const clips = {
      Idle: this.clips.Idle ? this.clips.Idle.clone() : null,
      Walk: this.clips.Walk ? this.clips.Walk.clone() : null,
      Run:  this.clips.Run  ? this.clips.Run.clone()  : null,
    };
    return new Avatar(root, mixer, clips, this.footYOffset, this.height);
  }
}
