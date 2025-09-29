import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const MODEL_URL = 'https://threejs.org/examples/models/gltf/Soldier.glb';

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
    if (this.current === 'Walk') {
      const walkRef = 1.8; // m/s nominal
      this.actions.Walk.setEffectiveTimeScale(THREE.MathUtils.clamp(this._vSmooth / walkRef, 0.6, 1.6));
    } else if (this.current === 'Run') {
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
    this._promise = new Promise((resolve, reject) => {
      const loader = new GLTFLoader();
      loader.load(MODEL_URL, (gltf) => {
        const template = gltf.scene;
        const animations = gltf.animations || [];
        const { Idle, Walk, Run } = clipsWithFallback(animations);

        // bounds for foot alignment and height
        const bounds = new THREE.Box3().setFromObject(template);
        const size = new THREE.Vector3(); bounds.getSize(size);
        const min = bounds.min; const height = size.y || 1.7;
        const footYOffset = -min.y;

        const factory = new AvatarFactory(template, { Idle, Walk, Run }, footYOffset, height);
        resolve(factory);
      }, undefined, reject);
    });
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
    return new Avatar(root, mixer, this.clips, this.footYOffset, this.height);
  }
}
