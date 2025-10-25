import * as THREE from 'three';

/**
 * SmartObjectManager
 * Manages Smart Objects in the NoClip 3D scene
 * - Placement via 'G' key
 * - Audio/text streaming from Hydra
 * - Microphone input capture
 * - Multi-user synchronization
 */

class SmartObjectManager {
  constructor({ scene, camera, hybrid, mesh, spatialAudio, onPlacementModeChange }) {
    this.scene = scene;
    this.camera = camera;
    this.hybrid = hybrid;
    this.mesh = mesh;
    this.spatialAudio = spatialAudio;
    this.onPlacementModeChange = (typeof onPlacementModeChange === 'function')
      ? onPlacementModeChange
      : null;

    // Object storage
    this.objects = new Map(); // uuid -> SmartObject
    this.selectedObject = null;

    // Placement mode
    this.placementMode = false;
    this.placementPreview = null;
    this._pendingPlacementPoint = null;
    this._hasPendingPlacementTarget = false;

    // Local storage key
    this.STORAGE_KEY = 'noclip_smart_objects_v1';

    this._init();
  }

  _init() {
    this._loadFromStorage();
    this._createPlacementPreview();
    this._notifyPlacementModeChange();
  }

  _notifyPlacementModeChange() {
    if (!this.onPlacementModeChange) return;
    try {
      this.onPlacementModeChange(!!this.placementMode);
    } catch (err) {
      console.warn('[SmartObjects] placement mode callback error', err);
    }
  }

  /**
   * Create a ghost preview object for placement mode
   */
  _createPlacementPreview() {
    const geometry = new THREE.BoxGeometry(1, 1, 1);
    const material = new THREE.MeshBasicMaterial({
      color: 0x5ee3a6,
      transparent: true,
      opacity: 0.5,
      wireframe: true
    });
    this.placementPreview = new THREE.Mesh(geometry, material);
    this.placementPreview.visible = false;
    this.scene.add(this.placementPreview);
  }

  /**
   * Enter placement mode - shows preview at camera position
   */
  enterPlacementMode() {
    if (this.placementMode) return;

    this.placementMode = true;
    this.placementPreview.visible = true;
    this.setPlacementTarget(null);
    this._notifyPlacementModeChange();

    console.log('[SmartObjects] Placement mode activated - click terrain to place');
  }

  /**
   * Cancel placement mode without creating an object
   */
  cancelPlacementMode() {
    if (!this.placementMode) return;
    this.placementMode = false;
    this.placementPreview.visible = false;
    this.setPlacementTarget(null);
    this._notifyPlacementModeChange();
  }

  /**
   * Exit placement mode and create object at current preview position
   */
  exitPlacementModeAndPlace(positionOverride = null) {
    if (!this.placementMode) return;

    // Determine placement position
    let position = null;
    if (positionOverride) {
      if (typeof positionOverride.x === 'number') {
        position = new THREE.Vector3(
          positionOverride.x,
          positionOverride.y ?? 0,
          positionOverride.z ?? 0
        );
      } else if (typeof positionOverride.clone === 'function') {
        position = positionOverride.clone();
      }
    } else if (this._hasPendingPlacementTarget && this._pendingPlacementPoint) {
      position = this._pendingPlacementPoint.clone();
    } else if (this.placementPreview) {
      position = this.placementPreview.position.clone();
    }

    if (!position) {
      console.warn('[SmartObjects] No placement target available');
      return;
    }

    // Create smart object at this position
    const uuid = this._generateUUID();
    this.createSmartObject({
      uuid,
      position: {
        x: position.x,
        y: position.y,
        z: position.z,
        lat: null, // Will be calculated from scene position
        lng: null,
        alt: position.y
      },
      mesh: {
        type: 'box',
        scale: { x: 1, y: 1, z: 1 },
        color: '#5ee3a6',
        label: {
          text: '',
          fontSize: 24,
          color: '#ffffff',
          offset: 1.5
        }
      },
      sources: {
        audio: {
          enabled: false,
          nodeId: '',
          volume: 1.0,
          spatialBlend: 1.0,
          maxDistance: 50,
          rolloffFactor: 1
        },
        text: {
          enabled: false,
          nodeId: '',
          updateMode: 'delta'
        }
      },
      audioInput: {
        enabled: false,
        targetNodeId: '',
        triggerDistance: 5,
        activationMode: 'proximity'
      },
      visibility: 'public',
      owner: this.mesh?.selfPub || 'local',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    this.placementMode = false;
    this.placementPreview.visible = false;
    this.setPlacementTarget(null);
    this._notifyPlacementModeChange();

    console.log(`[SmartObjects] Created object ${uuid} at`, position);
  }

  /**
   * Update placement target from pointer intersections
   */
  setPlacementTarget(point) {
    if (!point) {
      this._hasPendingPlacementTarget = false;
      return;
    }
    if (!this._pendingPlacementPoint) {
      this._pendingPlacementPoint = new THREE.Vector3();
    }
    this._pendingPlacementPoint.copy(point);
    this._hasPendingPlacementTarget = true;
  }

  /**
   * Update placement preview position based on camera
   */
  updatePlacementPreview() {
    if (!this.placementMode || !this.placementPreview.visible) return;

    let target = null;

    if (this._hasPendingPlacementTarget && this._pendingPlacementPoint) {
      target = this._pendingPlacementPoint;
    }

    if (!target) {
      // Position preview 5 units in front of camera as a fallback
      const direction = new THREE.Vector3();
      this.camera.getWorldDirection(direction);

      const cameraPos = this.camera.position.clone();
      target = cameraPos.add(direction.multiplyScalar(5));
    }

    this.placementPreview.position.copy(target);
  }

  /**
   * Create a new Smart Object
   */
  createSmartObject(config) {
    const uuid = config.uuid || this._generateUUID();

    if (this.objects.has(uuid)) {
      console.warn(`[SmartObjects] Object ${uuid} already exists`);
      return null;
    }

    // Create 3D mesh
    const mesh = this._createObjectMesh(config);
    if (!mesh) return null;

    // Create text label if needed
    let label = null;
    if (config.mesh?.label) {
      label = this._createTextLabel(config.mesh.label);
      mesh.add(label);
    }

    // Create object data structure
    const smartObject = {
      uuid,
      config,
      mesh,
      label,
      audioSource: null, // Will be created by SpatialAudioManager
      textContent: config.mesh?.label?.text || '',
      lastUpdate: Date.now()
    };

    // Add to scene
    this.scene.add(mesh);

    // Store object
    this.objects.set(uuid, smartObject);

    // Setup audio if enabled
    if (config.sources?.audio?.enabled && this.spatialAudio) {
      this.spatialAudio.createSource(uuid, mesh.position);
    }

    // Save to storage
    this._saveToStorage();

    // Broadcast to peers
    this._broadcastObjectSync('create', smartObject);

    return smartObject;
  }

  /**
   * Update an existing Smart Object
   */
  updateSmartObject(uuid, updates) {
    const obj = this.objects.get(uuid);
    if (!obj) return false;

    // Update config
    Object.assign(obj.config, updates);
    obj.config.updatedAt = Date.now();
    obj.lastUpdate = Date.now();

    // Update visual representation
    if (updates.position) {
      obj.mesh.position.set(
        updates.position.x || obj.mesh.position.x,
        updates.position.y || obj.mesh.position.y,
        updates.position.z || obj.mesh.position.z
      );
    }

    if (updates.mesh?.label?.text !== undefined) {
      this._updateTextLabel(obj, updates.mesh.label.text);
    }

    // Save and broadcast
    this._saveToStorage();
    this._broadcastObjectSync('update', obj);

    return true;
  }

  /**
   * Delete a Smart Object
   */
  deleteSmartObject(uuid) {
    const obj = this.objects.get(uuid);
    if (!obj) return false;

    // Remove from scene
    this.scene.remove(obj.mesh);

    // Cleanup audio
    if (this.spatialAudio) {
      this.spatialAudio.removeSource(uuid);
    }

    // Remove from storage
    this.objects.delete(uuid);
    this._saveToStorage();

    // Broadcast deletion
    this._broadcastObjectSync('delete', { uuid });

    return true;
  }

  /**
   * Handle incoming audio packet from Hydra
   */
  handleAudioPacket(uuid, audioPacket) {
    const obj = this.objects.get(uuid);
    if (!obj || !obj.config.sources?.audio?.enabled) return;

    if (this.spatialAudio) {
      this.spatialAudio.playAudio(uuid, audioPacket);
    }
  }

  /**
   * Handle incoming text update from Hydra
   */
  handleTextUpdate(uuid, textData) {
    const obj = this.objects.get(uuid);
    if (!obj || !obj.config.sources?.text?.enabled) return;

    const mode = obj.config.sources.text.updateMode || 'delta';

    if (mode === 'delta') {
      // Append text incrementally
      obj.textContent += textData.text || '';
    } else {
      // Replace entire text
      obj.textContent = textData.text || '';
    }

    this._updateTextLabel(obj, obj.textContent);
  }

  /**
   * Get object at position (for raycasting)
   */
  getObjectAtPosition(raycaster) {
    const meshes = Array.from(this.objects.values()).map(obj => obj.mesh);
    const intersects = raycaster.intersectObjects(meshes);

    if (intersects.length > 0) {
      const clickedMesh = intersects[0].object;
      // Find the smart object that owns this mesh
      for (const [uuid, obj] of this.objects.entries()) {
        if (obj.mesh === clickedMesh || obj.mesh === clickedMesh.parent) {
          return obj;
        }
      }
    }

    return null;
  }

  /**
   * Create 3D mesh for object
   */
  _createObjectMesh(config) {
    const meshConfig = config.mesh || {};
    let geometry;

    switch (meshConfig.type) {
      case 'sphere':
        geometry = new THREE.SphereGeometry(0.5, 16, 16);
        break;
      case 'box':
      default:
        geometry = new THREE.BoxGeometry(1, 1, 1);
        break;
    }

    const material = new THREE.MeshStandardMaterial({
      color: meshConfig.color || '#5ee3a6',
      emissive: meshConfig.color || '#5ee3a6',
      emissiveIntensity: 0.2,
      metalness: 0.3,
      roughness: 0.7
    });

    const mesh = new THREE.Mesh(geometry, material);

    // Apply scale
    if (meshConfig.scale) {
      mesh.scale.set(
        meshConfig.scale.x || 1,
        meshConfig.scale.y || 1,
        meshConfig.scale.z || 1
      );
    }

    // Set position
    if (config.position) {
      mesh.position.set(
        config.position.x || 0,
        config.position.y || 0,
        config.position.z || 0
      );
    }

    // Store UUID for raycasting
    mesh.userData.smartObjectUUID = config.uuid;

    return mesh;
  }

  /**
   * Create text label sprite
   */
  _createTextLabel(labelConfig) {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = 512;
    canvas.height = 128;

    // Draw text
    context.fillStyle = labelConfig.color || '#ffffff';
    context.font = `${labelConfig.fontSize || 24}px Arial`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(labelConfig.text || '', canvas.width / 2, canvas.height / 2);

    // Create sprite
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture });
    const sprite = new THREE.Sprite(material);

    sprite.scale.set(4, 1, 1);
    sprite.position.y = labelConfig.offset || 1.5;

    return sprite;
  }

  /**
   * Update text label content
   */
  _updateTextLabel(obj, text) {
    if (!obj.label) return;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = 512;
    canvas.height = 128;

    const labelConfig = obj.config.mesh?.label || {};

    context.fillStyle = labelConfig.color || '#ffffff';
    context.font = `${labelConfig.fontSize || 24}px Arial`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2);

    const texture = new THREE.CanvasTexture(canvas);
    obj.label.material.map = texture;
    obj.label.material.needsUpdate = true;
  }

  /**
   * Broadcast object sync to peers
   */
  _broadcastObjectSync(action, object) {
    if (!this.mesh) return;

    const message = {
      type: 'smart-object-sync',
      action,
      object: action === 'delete' ? { uuid: object.uuid } : {
        uuid: object.uuid,
        config: object.config
      },
      from: this.mesh.selfPub || 'local',
      timestamp: Date.now()
    };

    // Broadcast via mesh network
    if (this.mesh.broadcast) {
      this.mesh.broadcast(message);
    }
  }

  /**
   * Handle incoming sync from peers
   */
  handlePeerSync(message) {
    if (!message || message.type !== 'smart-object-sync') return;

    const { action, object, from } = message;

    // Don't process our own messages
    if (from === (this.mesh?.selfPub || 'local')) return;

    // Check visibility/permissions
    const obj = this.objects.get(object.uuid);
    if (obj) {
      const visibility = obj.config.visibility;
      if (visibility === 'private' && obj.config.owner !== from) return;
      // TODO: Check friends list for 'friends' visibility
    }

    switch (action) {
      case 'create':
        if (!this.objects.has(object.uuid)) {
          this.createSmartObject(object.config);
        }
        break;
      case 'update':
        this.updateSmartObject(object.uuid, object.config);
        break;
      case 'delete':
        this.deleteSmartObject(object.uuid);
        break;
    }
  }

  /**
   * Save objects to localStorage
   */
  _saveToStorage() {
    try {
      const data = Array.from(this.objects.values()).map(obj => ({
        uuid: obj.uuid,
        config: obj.config,
        textContent: obj.textContent
      }));

      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    } catch (err) {
      console.error('[SmartObjects] Failed to save to storage:', err);
    }
  }

  /**
   * Load objects from localStorage
   */
  _loadFromStorage() {
    try {
      const data = localStorage.getItem(this.STORAGE_KEY);
      if (!data) return;

      const objects = JSON.parse(data);
      objects.forEach(objData => {
        this.createSmartObject(objData.config);
        if (objData.textContent) {
          const obj = this.objects.get(objData.uuid);
          if (obj) {
            obj.textContent = objData.textContent;
            this._updateTextLabel(obj, objData.textContent);
          }
        }
      });

      console.log(`[SmartObjects] Loaded ${objects.length} objects from storage`);
    } catch (err) {
      console.error('[SmartObjects] Failed to load from storage:', err);
    }
  }

  /**
   * Generate UUID v4
   */
  _generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * Cleanup
   */
  dispose() {
    // Remove all objects
    this.objects.forEach((obj) => {
      this.scene.remove(obj.mesh);
    });
    this.objects.clear();

    // Remove preview
    if (this.placementPreview) {
      this.scene.remove(this.placementPreview);
    }
  }
}

export { SmartObjectManager };
