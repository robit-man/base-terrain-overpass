import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadCharacterAnimationClips, deriveClipsFromAnimations, CHARACTER_CLIP_KEYS } from './character.js';

//const MODEL_URL = 'https://threejs.org/examples/models/gltf/Soldier.glb';
const MODEL_URL = '/models/Character.glb';

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

// exp smoothing factor per (rate, dt)
function smoothAlpha(ratePerSec, dt) {
  return 1 - Math.exp(-Math.max(0, ratePerSec) * Math.max(0, dt));
}

const PRIMARY_STATE_KEYS = [
  'Idle',
  'WalkForward',
  'WalkBackward',
  'WalkLeft',
  'WalkRight',
  'Sprint',
  'CrouchIdle',
  'CrouchForward',
  'CrouchBackward',
  'CrouchLeft',
  'CrouchRight',
  'Fall'
];

const STATE_ALIASES = {
  Walk: 'WalkForward',
  Run: 'Sprint'
};

const STATE_SPEED_REF = {
  WalkForward: 1.8,
  WalkBackward: 1.6,
  WalkLeft: 1.4,
  WalkRight: 1.4,
  Sprint: 5.0,
  CrouchForward: 1.1,
  CrouchBackward: 1.1,
  CrouchLeft: 1.0,
  CrouchRight: 1.0
};

const DIRECTION_THRESHOLD = 0.25;
const IDLE_SPEED_THRESHOLD = 0.12;
const RUN_SPEED_THRESHOLD = 3.4;

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
          obj.material.wireframe = false;
        }
      }
    });

    // Build actions
    this.actions = {};
    this._stateOrder = [];
    const registerAction = (state, clip) => {
      if (!clip || this.actions[state]) return;
      const action = mixer.clipAction(clip);
      action.enabled = true;
      action.setEffectiveTimeScale(1);
      action.setEffectiveWeight(0);
      action.loop = state === 'Fall' ? THREE.LoopOnce : THREE.LoopRepeat;
      action.clampWhenFinished = state === 'Fall';
      this.actions[state] = action;
      this._stateOrder.push(state);
    };
    const gatherClipForState = (state) => {
      if (clips[state]) return clips[state];
      for (const [alias, target] of Object.entries(STATE_ALIASES)) {
        if (target === state && clips[alias]) return clips[alias];
      }
      return null;
    };
    for (const state of PRIMARY_STATE_KEYS) {
      const clip = gatherClipForState(state);
      if (clip) registerAction(state, clip);
    }

    const startState = this._chooseAvailable(['Idle', 'CrouchIdle', 'WalkForward', 'Sprint', 'Walk']);
    if (startState && this.actions[startState]) {
      this.actions[startState].setEffectiveWeight(1).play();
    }
    this.current = startState || null;

    this._isCrouch = false;
    this._airborneManual = false;
    this._airborneAuto = false;
    this._lastPos = new THREE.Vector3();
    this._velWorld = new THREE.Vector3();
    this._velLocal = new THREE.Vector3();
    this._invQuat = new THREE.Quaternion();
    this._hasPrevPos = false;

    // Transition & motion tuning
    this.fadeDuration = 0.5;      // matches demo controls.fadeDuration

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
    const newY = y + this.jumpYOffset;
    this.group.position.set(x, newY, z);
    if (!this._hasPrevPos) {
      this._lastPos.set(x, newY, z);
      this._hasPrevPos = true;
    } else {
      const dx = x - this._lastPos.x;
      const dy = newY - this._lastPos.y;
      const dz = z - this._lastPos.z;
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > 25) {
        this._lastPos.set(x, newY, z);
      }
    }
  }

  /**
   * External callers provide instantaneous speed each frame.
   * We only store it; state decisions happen in update(dt) on the smoothed value.
   */
  setSpeed(speed) {
    this._vTarget = speed;
  }

  setCrouch(active) {
    this._isCrouch = !!active;
  }

  setAirborne(active) {
    this._airborneManual = !!active;
  }

  _chooseAvailable(candidates = []) {
    for (const name of candidates) {
      const mapped = STATE_ALIASES[name] || name;
      if (this.actions[mapped]) return mapped;
    }
    for (const state of this._stateOrder) {
      if (this.actions[state]) return state;
    }
    return this.current && this.actions[this.current] ? this.current : null;
  }

  _selectState({ speed, forward, strafe, airborne }) {
    if (airborne && this.actions.Fall) {
      return 'Fall';
    }

    const absForward = Math.abs(forward);
    const absStrafe = Math.abs(strafe);
    const primaryForward = absForward >= absStrafe;

    if (speed < IDLE_SPEED_THRESHOLD) {
      return this._isCrouch
        ? this._chooseAvailable(['CrouchIdle', 'Idle'])
        : this._chooseAvailable(['Idle', 'CrouchIdle', 'WalkForward']);
    }

    if (this._isCrouch) {
      if (primaryForward) {
        if (forward > DIRECTION_THRESHOLD) return this._chooseAvailable(['CrouchForward', 'CrouchIdle']);
        if (forward < -DIRECTION_THRESHOLD) return this._chooseAvailable(['CrouchBackward', 'CrouchIdle']);
      } else {
        if (strafe > DIRECTION_THRESHOLD) return this._chooseAvailable(['CrouchRight', 'CrouchForward', 'CrouchIdle']);
        if (strafe < -DIRECTION_THRESHOLD) return this._chooseAvailable(['CrouchLeft', 'CrouchForward', 'CrouchIdle']);
      }
      return this._chooseAvailable(['CrouchIdle', 'Idle']);
    }

    if (primaryForward) {
      if (forward > DIRECTION_THRESHOLD) {
        if (speed >= RUN_SPEED_THRESHOLD) {
          return this._chooseAvailable(['Sprint', 'Run', 'WalkForward', 'Walk']);
        }
        return this._chooseAvailable(['WalkForward', 'Walk', 'Sprint']);
      }
      if (forward < -DIRECTION_THRESHOLD) {
        return this._chooseAvailable(['WalkBackward', 'WalkForward', 'Walk']);
      }
    } else {
      if (strafe > DIRECTION_THRESHOLD) {
        return this._chooseAvailable(['WalkRight', 'WalkForward', 'Walk']);
      }
      if (strafe < -DIRECTION_THRESHOLD) {
        return this._chooseAvailable(['WalkLeft', 'WalkForward', 'Walk']);
      }
    }

    if (speed >= RUN_SPEED_THRESHOLD) {
      return this._chooseAvailable(['Sprint', 'Run', 'WalkForward', 'Walk']);
    }
    return this._chooseAvailable(['WalkForward', 'Walk', 'Idle']);
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
    this._airborneAuto = true;
  }

  update(dt) {
    // Smooth speed towards target (external hint)
    const a = smoothAlpha(this._vRate, dt);
    this._vSmooth += (this._vTarget - this._vSmooth) * a;

    // Measure velocity from motion
    const invDt = 1 / Math.max(dt, 1e-5);
    if (!this._hasPrevPos) {
      this._lastPos.copy(this.group.position);
      this._hasPrevPos = true;
    }
    this._velWorld.set(
      (this.group.position.x - this._lastPos.x) * invDt,
      (this.group.position.y - this._lastPos.y) * invDt,
      (this.group.position.z - this._lastPos.z) * invDt
    );
    this._lastPos.copy(this.group.position);

    const horizontalSpeed = Math.hypot(this._velWorld.x, this._velWorld.z);

    this._velLocal.set(this._velWorld.x, 0, this._velWorld.z);
    if (this._velLocal.lengthSq() > 1e-6) {
      this._invQuat.copy(this.group.quaternion).invert();
      this._velLocal.applyQuaternion(this._invQuat);
    } else {
      this._velLocal.set(0, 0, 0);
    }
    const forward = -this._velLocal.z;
    const strafe = this._velLocal.x;

    const airborneFlag = this._airborneManual || this._airborneAuto || this.jumpState !== 'idle' || this.jumpYOffset > 0;
    const desired = this._selectState({
      speed: Math.max(this._vSmooth, horizontalSpeed),
      forward,
      strafe,
      airborne: airborneFlag
    });
    if (desired && desired !== this.current) this._transition(desired);

    // Tempo adaptation (no clip restart)
    if (this.current && this.actions[this.current]) {
      const ref = STATE_SPEED_REF[this.current];
      if (ref) {
        const scaleSource = Math.max(horizontalSpeed, this._vSmooth);
        this.actions[this.current].setEffectiveTimeScale(
          THREE.MathUtils.clamp(scaleSource / ref, 0.6, 1.6)
        );
      } else {
        this.actions[this.current].setEffectiveTimeScale(1);
      }
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

    if (this.jumpState !== 'idle' || this.jumpYOffset > 1e-3) {
      this._airborneAuto = true;
    } else if (!this._airborneManual) {
      this._airborneAuto = false;
    }

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
        template.rotation.y = Math.PI;
        template.updateMatrixWorld(true);
        const animations = gltf.animations || [];
        const derived = deriveClipsFromAnimations(animations);
        let clipMap = {};
        try {
          clipMap = await loadCharacterAnimationClips(loader, template, animations);
        } catch (err) {
          console.warn('[avatar] retargeted clip load failed, using native clips', err);
          clipMap = {};
        }

        const merged = {};
        const baseKeys = new Set([...CHARACTER_CLIP_KEYS, 'Walk', 'Run']);
        for (const key of baseKeys) {
          merged[key] = clipMap[key] || derived[key] || null;
        }
        for (const [key, value] of Object.entries(clipMap)) {
          if (merged[key] == null) merged[key] = value;
        }

        // bounds for foot alignment and height
        const bounds = new THREE.Box3().setFromObject(template);
        const size = new THREE.Vector3(); bounds.getSize(size);
        const min = bounds.min; const height = size.y || 1.7;
        const footYOffset = -min.y;

        return new AvatarFactory(template, merged, footYOffset, height);
      } catch (err) {
        console.warn('[avatar] gltf load failed, falling back to primitive avatar', err);
        const fallback = buildFallbackTemplate();
        const emptyClips = {};
        for (const key of CHARACTER_CLIP_KEYS) emptyClips[key] = null;
        emptyClips.Walk = null;
        emptyClips.Run = null;
        return new AvatarFactory(fallback.template, emptyClips, fallback.footYOffset, fallback.height);
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
    const clips = {};
    for (const [key, clip] of Object.entries(this.clips || {})) {
      clips[key] = clip ? clip.clone() : null;
    }
    return new Avatar(root, mixer, clips, this.footYOffset, this.height);
  }
}
