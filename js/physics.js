import * as THREE from 'three';
import { RapierPhysics } from 'three/addons/physics/RapierPhysics.js';
import { RapierHelper } from 'three/addons/helpers/RapierHelper.js';

const TILE_ID = (tile) => `${tile.q},${tile.r}`;
const TMP_TRANSLATION = new THREE.Vector3();
const TMP_SCALE = new THREE.Vector3();
const TMP_ROTATION = new THREE.Quaternion();
const TMP_CHARACTER_CENTER = new THREE.Vector3();
const TMP_LINEAR_VELOCITY = new THREE.Vector3();
const TMP_VELOCITY_DELTA = new THREE.Vector3();

export class PhysicsEngine {
  constructor({ sceneManager, tileManager = null, enableHelper = false, audio = null } = {}) {
    if (!sceneManager || !sceneManager.scene) throw new Error('PhysicsEngine requires a sceneManager with a scene.');

    this.sceneManager = sceneManager;
    this.scene = sceneManager.scene;
    this.tileManager = tileManager;
    this.enableHelper = enableHelper;
    this.audio = audio || null;

    this.dynamicObjects = new Set();
    this.tileColliderMap = new Map();
    this.character = null;
    this.characterReady = false;
    this._characterImpactCooldown = 0;
    this._characterSnapDefaults = { distance: 0.3, slope: 0.6 };

    this.collidersReady = new Promise((resolve) => { this._resolveCollidersReady = resolve; });
    this.ready = this._init();
  }

  async _init() {
    this.core = await RapierPhysics();
    this.core.addScene(this.scene);

    if (this.enableHelper) {
      this.helper = new RapierHelper(this.core.world);
      this.scene.add(this.helper);
    }

    return this;
  }

  update(dt) {
    if (!this.core) return;

    if (this.tileManager) this._syncInteractiveTileColliders();

    if (this._characterImpactCooldown > 0) {
      this._characterImpactCooldown = Math.max(0, this._characterImpactCooldown - dt);
    }

    this._updateCharacterSnap(dt);

    this._updateDynamicImpacts(dt);

    if (this.helper) this.helper.update();
  }

  spawnTestBall({ radius = 0.2, mass = 0.5, restitution = 0.2, color = 0xffffff, origin = new THREE.Vector3(), lift = 3 } = {}) {
    if (!this.core) return null;

    const geometry = new THREE.SphereGeometry(radius, 24, 24);
    const material = new THREE.MeshStandardMaterial({ color });
    const ball = new THREE.Mesh(geometry, material);
    ball.castShadow = true;
    ball.receiveShadow = true;
    ball.name = 'physics-test-ball';

    ball.position.copy(origin);
    ball.position.y += lift;

    this.scene.add(ball);
    this.core.addMesh(ball, mass, restitution);
    this.dynamicObjects.add(ball);

    const physicsData = ball.userData.physics;
    const body = physicsData?.body;
    if (body) {
      body.setCcdEnabled?.(true);
      body.setCanSleep?.(false);
      body.wakeUp?.();
    }
    const collider = physicsData?.collider;
    if (collider) {
      collider.setFriction?.(0.7);
      collider.setRestitution?.(restitution);
    }

    ball.userData._impactState = {
      prevVel: new THREE.Vector3(),
      speed: 0,
      cooldown: 0,
      ready: false,
    };

    return ball;
  }

  _syncInteractiveTileColliders() {
    const tiles = this.tileManager?.tiles;
    if (!tiles || typeof tiles.values !== 'function') return;

    for (const tile of tiles.values()) {
      if (!tile || tile.type !== 'interactive') continue;
      const id = TILE_ID(tile);
      if (this.tileColliderMap.has(id)) continue;
      if (typeof tile.unreadyCount === 'number' && tile.unreadyCount > 0) continue;

      const mesh = tile.grid?.mesh;
      if (!mesh) continue;

      this.registerStaticMesh(mesh);
      this.tileColliderMap.set(id, mesh);

      if (this._resolveCollidersReady) {
        this._resolveCollidersReady(mesh);
        this._resolveCollidersReady = null;
      }
    }

    for (const [id, mesh] of this.tileColliderMap) {
      if (!tiles.has(id)) {
        this.unregisterStaticMesh(mesh);
        this.tileColliderMap.delete(id);
      }
    }
  }

  _updateDynamicImpacts(dt) {
    if (!this.dynamicObjects.size) return;

    const toRemove = [];

    for (const mesh of this.dynamicObjects) {
      if (!mesh || !mesh.userData) {
        toRemove.push(mesh);
        continue;
      }

      const physicsData = mesh.userData.physics;
      const body = physicsData?.body;
      if (!body || typeof body.linvel !== 'function') {
        toRemove.push(mesh);
        continue;
      }

      const state = mesh.userData._impactState || (mesh.userData._impactState = {
        prevVel: new THREE.Vector3(),
        speed: 0,
        cooldown: 0,
        ready: false,
      });

      state.cooldown = Math.max(0, (state.cooldown || 0) - dt);

      const lv = body.linvel();
      TMP_LINEAR_VELOCITY.set(lv.x, lv.y, lv.z);
      const speed = TMP_LINEAR_VELOCITY.length();

      if (!state.ready) {
        state.prevVel.copy(TMP_LINEAR_VELOCITY);
        state.speed = speed;
        state.ready = true;
        continue;
      }

      TMP_VELOCITY_DELTA.copy(state.prevVel).sub(TMP_LINEAR_VELOCITY);

      const deltaMag = TMP_VELOCITY_DELTA.length();
      const speedDrop = Math.max(0, state.speed - speed);
      const verticalDelta = Math.abs(state.prevVel.y - TMP_LINEAR_VELOCITY.y);
      const magnitude = Math.max(deltaMag * 0.55, speedDrop, verticalDelta * 0.8);

      if (this.audio && state.cooldown <= 0 && magnitude > 0.75) {
        const pos = body.translation?.();
        if (pos) {
          this._emitImpactSound(pos, magnitude);
          state.cooldown = 0.085 + Math.min(0.25, magnitude * 0.025);
        }
      }

      state.prevVel.copy(TMP_LINEAR_VELOCITY);
      state.speed = speed;
    }

    if (toRemove.length) {
      for (const mesh of toRemove) this.dynamicObjects.delete(mesh);
    }
  }

  resetTerrain() {
    if (this.tileColliderMap.size) {
      for (const mesh of this.tileColliderMap.values()) {
        this.unregisterStaticMesh(mesh);
      }
      this.tileColliderMap.clear();
    }
  }

  registerStaticMesh(mesh, { forceUpdate = false } = {}) {
    if (!mesh || !this.core || !this.core.RAPIER) return;

    const geometry = mesh.geometry;
    if (!geometry || !geometry.attributes?.position) return;

    mesh.updateMatrixWorld(true);

    const physicsData = mesh.userData.physics || {};
    const elements = mesh.matrixWorld.elements;
    if (!forceUpdate && physicsData.lastMatrixWorld) {
      let same = true;
      for (let i = 0; i < 16; i++) {
        if (Math.abs(physicsData.lastMatrixWorld[i] - elements[i]) > 1e-6) { same = false; break; }
      }
      if (same && physicsData.collider && physicsData.type === 'static-trimesh') return;
    }

    if (physicsData.collider) {
      this.core.world.removeCollider(physicsData.collider, true);
      physicsData.collider = null;
      physicsData.body = null;
    }

    mesh.matrixWorld.decompose(TMP_TRANSLATION, TMP_ROTATION, TMP_SCALE);

    const positionAttr = geometry.attributes.position;
    const vertexCount = positionAttr.count;
    const vertices = new Float32Array(vertexCount * 3);

    for (let i = 0; i < vertexCount; i++) {
      vertices[3 * i + 0] = positionAttr.getX(i) * TMP_SCALE.x;
      vertices[3 * i + 1] = positionAttr.getY(i) * TMP_SCALE.y;
      vertices[3 * i + 2] = positionAttr.getZ(i) * TMP_SCALE.z;
    }

    const indexAttr = geometry.getIndex();
    let indices;
    if (indexAttr) {
      const src = indexAttr.array;
      indices = new Uint32Array(src.length);
      for (let i = 0; i < src.length; i++) indices[i] = src[i];
    } else {
      indices = new Uint32Array(vertexCount);
      for (let i = 0; i < vertexCount; i++) indices[i] = i;
    }

    physicsData.mass = 0;
    physicsData.restitution = physicsData.restitution ?? 0;
    physicsData.friction = physicsData.friction ?? 0.9;

    const { RAPIER } = this.core;
    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(TMP_TRANSLATION.x, TMP_TRANSLATION.y, TMP_TRANSLATION.z)
      .setRotation({ x: TMP_ROTATION.x, y: TMP_ROTATION.y, z: TMP_ROTATION.z, w: TMP_ROTATION.w });
    const body = this.core.world.createRigidBody(bodyDesc);

    const colliderDesc = RAPIER.ColliderDesc.trimesh(vertices, indices)
      .setRestitution(physicsData.restitution)
      .setFriction(physicsData.friction);
    const collider = this.core.world.createCollider(colliderDesc, body);

    physicsData.body = body;
    physicsData.collider = collider;
    physicsData.type = 'static-trimesh';
    physicsData.lastMatrixWorld = physicsData.lastMatrixWorld || new Float32Array(16);
    for (let i = 0; i < 16; i++) physicsData.lastMatrixWorld[i] = elements[i];
    mesh.userData.physics = physicsData;
  }

  unregisterStaticMesh(mesh) {
    if (!mesh || !mesh.userData) return;
    const physicsData = mesh.userData.physics;
    if (!physicsData) return;
    if (physicsData.collider && this.core?.world) {
      this.core.world.removeCollider(physicsData.collider, true);
    }
    physicsData.collider = null;
    physicsData.body = null;
    physicsData.lastMatrixWorld = null;
  }

  async configureCharacter({ position, eyeHeight, radius = 0.35, halfHeight = 0.45 } = {}) {
    await this.ready;
    if (!this.core?.RAPIER || !position) return;

    const { RAPIER } = this.core;
    const controller = this.core.world.createCharacterController(0.01);
    controller.setApplyImpulsesToDynamicBodies(false);
    controller.enableAutostep?.(0.4, 0.4, true);
    const snapDistance = this._characterSnapDefaults.distance;
    const snapSlope = this._characterSnapDefaults.slope;
    controller.enableSnapToGround?.(snapDistance, snapSlope);

    const offset = this._characterOffset(eyeHeight, radius, halfHeight);
    const center = this._characterCenter(position, offset, TMP_CHARACTER_CENTER);
    const colliderDesc = RAPIER.ColliderDesc.capsule(halfHeight, radius)
      .setFriction(0.0)
      .setRestitution(0.0)
      .setTranslation(center.x, center.y, center.z);

    const collider = this.core.world.createCollider(colliderDesc);

    this.character = {
      controller,
      collider,
      radius,
      halfHeight,
      offset,
      snapEnabled: true,
      snapResumeTimer: 0,
      snapDistance,
      snapSlope,
    };
    this._setCharacterSnap(true);
    this.characterReady = true;
  }

  isCharacterReady() {
    return !!this.characterReady && !!this.character?.controller && !!this.character?.collider;
  }

  setCharacterPosition(position, eyeHeight) {
    if (!this.isCharacterReady() || !position) return;
    const { collider, radius, halfHeight } = this.character;
    const offset = this._characterOffset(eyeHeight, radius, halfHeight);
    this.character.offset = offset;
    const center = this._characterCenter(position, offset, TMP_CHARACTER_CENTER);
    collider.setTranslation({ x: center.x, y: center.y, z: center.z });
  }

  resolveCharacterMovement(position, eyeHeight, desiredMove) {
    if (!this.isCharacterReady() || !position || !desiredMove) {
      return desiredMove ? desiredMove.clone() : new THREE.Vector3();
    }

    if (desiredMove.lengthSq() < 1e-9) return new THREE.Vector3();

    const { controller, collider, radius, halfHeight } = this.character;
    const offset = this._characterOffset(eyeHeight, radius, halfHeight);
    this.character.offset = offset;
    const center = this._characterCenter(position, offset, TMP_CHARACTER_CENTER);
    collider.setTranslation({ x: center.x, y: center.y, z: center.z });

    const moveVec = new this.core.RAPIER.Vector3(desiredMove.x, desiredMove.y, desiredMove.z);
    controller.computeColliderMovement(collider, moveVec);

    const translation = controller.computedMovement();
    const colliderPos = collider.translation();
    colliderPos.x += translation.x;
    colliderPos.y += translation.y;
    colliderPos.z += translation.z;
    collider.setTranslation(colliderPos);

    return new THREE.Vector3(translation.x, translation.y, translation.z);
  }

  notifyCharacterImpact(position, magnitude = 1) {
    if (!this.audio || !position) return;
    if (this._characterImpactCooldown > 0) return;
    const safeMag = THREE.MathUtils.clamp(magnitude, 0.08, 3.5);
    this._characterImpactCooldown = 0.08 + safeMag * 0.04;
    this._emitImpactSound(position, safeMag, { frequencyBias: -80, roughness: 0.42 });
  }

  triggerImpactAt(position, magnitude = 1, options = {}) {
    this._emitImpactSound(position, magnitude, options);
  }

  _characterOffset(eyeHeight = 1.6, radius = 0.35, halfHeight = 0.45) {
    const offset = eyeHeight - (radius + halfHeight);
    return Number.isFinite(offset) ? Math.max(0, offset) : 0;
  }

  suspendCharacterSnap(duration = 0.3) {
    if (!this.isCharacterReady()) return;
    const state = this.character;
    if (typeof state.controller?.disableSnapToGround !== 'function') {
      return;
    }
    state.snapResumeTimer = Math.max(state.snapResumeTimer || 0, Number.isFinite(duration) ? Math.max(0, duration) : 0.3);
    this._setCharacterSnap(false);
  }

  _updateCharacterSnap(dt = 0) {
    if (!this.isCharacterReady()) return;
    const state = this.character;
    if (!state) return;
    if (state.snapResumeTimer && state.snapResumeTimer > 0) {
      state.snapResumeTimer = Math.max(0, state.snapResumeTimer - Math.max(0, dt));
      if (state.snapResumeTimer === 0) {
        this._setCharacterSnap(true);
      }
    }
  }

  _setCharacterSnap(enabled) {
    if (!this.isCharacterReady()) return;
    const state = this.character;
    const controller = state?.controller;
    if (!controller) return;

    if (enabled) {
      if (!state.snapEnabled) {
        const dist = state.snapDistance ?? this._characterSnapDefaults.distance;
        const slope = state.snapSlope ?? this._characterSnapDefaults.slope;
        controller.enableSnapToGround?.(dist, slope);
        state.snapEnabled = true;
      }
      return;
    }

    if (state.snapEnabled && typeof controller.disableSnapToGround === 'function') {
      controller.disableSnapToGround();
      state.snapEnabled = false;
    }
  }

  _characterCenter(position, offset, target = new THREE.Vector3()) {
    target.set(position.x, position.y - offset, position.z);
    return target;
  }

  _emitImpactSound(position, magnitude = 1, { frequency, frequencyBias = 0, roughness, decay, intensity } = {}) {
    if (!this.audio || !position) return;

    const mag = Math.max(0, magnitude);
    const freqBase = frequency ?? (240 + Math.min(680, mag * 140 + frequencyBias));
    const baseFreq = Math.max(60, freqBase + (Math.random() - 0.5) * 40);
    const rough = roughness ?? THREE.MathUtils.clamp(0.28 + mag * 0.08, 0.15, 0.85);
    const envDecay = decay ?? (0.14 + Math.min(0.3, mag * 0.05));
    const loudness = intensity ?? (0.25 + mag * 0.32);

    this.audio.triggerImpact(position.x, position.y, position.z, {
      intensity: loudness,
      frequency: baseFreq,
      roughness: rough,
      decay: envDecay,
    });
  }
}
