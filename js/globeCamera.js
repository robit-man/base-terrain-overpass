// globeCamera.js - Camera controller for Earth sphere
import * as THREE from 'three';

const EARTH_RADIUS = 6371000; // meters

export class GlobeCamera {
  constructor(camera, globeTerrain, opts = {}) {
    this.camera = camera;
    this.globeTerrain = globeTerrain;
    this.autoApply = opts.autoApply !== false;

    // Player position on sphere
    this.playerLat = 0;
    this.playerLon = 0;
    this.playerAltitude = 2; // meters above surface (player height)

    // Camera settings
    this.cameraHeight = 100; // meters above player
    this.cameraDistance = 200; // meters behind player
    this.lookAheadDistance = 50; // meters ahead to look at

    // Movement
    this.velocity = new THREE.Vector3();
    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();

    // Orientation (local to sphere surface)
    this.bearing = 0; // degrees (0 = north)
    this.pitch = 0; // degrees (looking up/down)

    // Cached pose for consumers
    this._pose = null;

    console.log('[GlobeCamera] Initialized');
  }

  // Set player position
  setPosition(lat, lon, altitude = undefined) {
    this.playerLat = lat;
    this.playerLon = lon;
    if (Number.isFinite(altitude)) {
      this.playerAltitude = altitude;
    }
    this._updateCamera();
  }

  // Get player's position on sphere surface (with elevation)
  getPlayerPosition() {
    const elevation = this.globeTerrain.globe.getElevationAt(this.playerLat, this.playerLon);
    const radius = EARTH_RADIUS + elevation + this.playerAltitude;
    return this.globeTerrain.globe.latLonToSphere(this.playerLat, this.playerLon, radius);
  }

  // Update camera position and orientation
  _updateCamera() {
    // Get player position on sphere
    const playerPos = this.getPlayerPosition();

    // Get local coordinate frame at player position
    const up = playerPos.clone().normalize(); // Radial direction (local "up")
    const north = this._getNorthDirection(up);
    const east = new THREE.Vector3().crossVectors(up, north).normalize();

    // Calculate bearing direction
    const bearingRad = THREE.MathUtils.degToRad(this.bearing);
    const forward = new THREE.Vector3()
      .addScaledVector(north, Math.cos(bearingRad))
      .addScaledVector(east, Math.sin(bearingRad))
      .normalize();

    // Camera position: behind and above player
    const cameraPos = playerPos.clone()
      .addScaledVector(forward, -this.cameraDistance) // Behind player
      .addScaledVector(up, this.cameraHeight); // Above player

    // Look-at point: ahead of player
    const lookAt = playerPos.clone()
      .addScaledVector(forward, this.lookAheadDistance)
      .addScaledVector(up, this.playerAltitude);

    // Cache pose for external consumers
    this._pose = {
      playerSurface: playerPos.clone().addScaledVector(up, -this.playerAltitude),
      playerEye: playerPos.clone(),
      up: up.clone(),
      north: north.clone(),
      east: east.clone(),
      forward: forward.clone(),
      cameraWorld: cameraPos.clone(),
      lookAt: lookAt.clone()
    };

    if (this.autoApply && this.camera) {
      this.camera.position.copy(cameraPos);
      this.camera.lookAt(lookAt);
    }

    // Store forward/right for movement
    this.forward.copy(forward);
    this.right.copy(east);
  }

  _getNorthDirection(up) {
    // Get north direction in local tangent plane
    // North is towards the north pole, projected onto tangent plane

    const northPole = new THREE.Vector3(0, EARTH_RADIUS, 0);
    const toNorth = northPole.clone().sub(up.clone().multiplyScalar(EARTH_RADIUS));

    // Project onto tangent plane (remove radial component)
    const radialComponent = toNorth.dot(up);
    const northTangent = toNorth.clone().sub(up.clone().multiplyScalar(radialComponent));

    if (northTangent.lengthSq() < 0.001) {
      // At pole, use arbitrary direction
      return new THREE.Vector3(1, 0, 0);
    }

    return northTangent.normalize();
  }

  // Movement methods
  moveForward(distance) {
    // Move along sphere surface in forward direction
    this._moveOnSphere(this.forward, distance);
  }

  moveRight(distance) {
    // Move along sphere surface in right direction
    this._moveOnSphere(this.right, distance);
  }

  _moveOnSphere(direction, distance) {
    // Move distance meters in direction along sphere surface
    // This is a simplified great circle movement

    // Convert distance to angular distance
    const angularDist = distance / EARTH_RADIUS;

    // Current position
    const currentPos = this.globeTerrain.globe.latLonToSphere(
      this.playerLat,
      this.playerLon,
      EARTH_RADIUS
    );

    // Move along direction (on sphere surface)
    const up = currentPos.clone().normalize();

    // Project direction onto tangent plane
    const radialComponent = direction.dot(up);
    const tangentDir = direction.clone().sub(up.clone().multiplyScalar(radialComponent)).normalize();

    // Rotate current position around axis perpendicular to movement
    const axis = new THREE.Vector3().crossVectors(up, tangentDir).normalize();
    const rotation = new THREE.Quaternion().setFromAxisAngle(axis, angularDist);
    const newPos = currentPos.clone().applyQuaternion(rotation);

    // Convert back to lat/lon
    const { lat, lon } = this.globeTerrain.globe.sphereToLatLon(newPos);
    this.playerLat = lat;
    this.playerLon = lon;

    this._updateCamera();
  }

  // Rotate camera
  rotate(deltaYaw, deltaPitch) {
    this.bearing += deltaYaw;
    this.bearing = ((this.bearing + 360) % 360);

    this.pitch += deltaPitch;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -80, 80);

    this._updateCamera();
  }

  // Update (called each frame)
  update(deltaTime = 0.016) {
    // Apply velocity if any
    if (this.velocity.lengthSq() > 0.001) {
      const speed = this.velocity.length();
      const moveDistance = speed * deltaTime;

      // Move in velocity direction
      this.moveForward(this.velocity.z * deltaTime);
      this.moveRight(this.velocity.x * deltaTime);

      // Damping
      this.velocity.multiplyScalar(0.9);
    }

    // Update globe terrain system
    const playerWorldPos = this.getPlayerPosition();
    this.globeTerrain.update(playerWorldPos);
  }

  // Set camera parameters
  setCameraOffset(distance, height) {
    this.cameraDistance = distance;
    this.cameraHeight = height;
    this._updateCamera();
  }

  getPose() {
    if (!this._pose) return null;
    return {
      playerSurface: this._pose.playerSurface.clone(),
      playerEye: this._pose.playerEye.clone(),
      up: this._pose.up.clone(),
      north: this._pose.north.clone(),
      east: this._pose.east.clone(),
      forward: this._pose.forward.clone(),
      cameraWorld: this._pose.cameraWorld.clone(),
      lookAt: this._pose.lookAt.clone()
    };
  }

  // Get current bearing
  getBearing() {
    return this.bearing;
  }

  // Get current position
  getPosition() {
    return { lat: this.playerLat, lon: this.playerLon };
  }
}
