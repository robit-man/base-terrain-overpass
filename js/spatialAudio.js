import * as THREE from 'three';

/**
 * SpatialAudioManager
 * Manages 3D spatial audio playback for Smart Objects
 * Uses Web Audio API PannerNode for positioned sound
 */

class SpatialAudioManager {
  constructor({ camera, listener }) {
    this.camera = camera;
    this.listener = listener;

    // Audio context
    this.audioContext = null;
    this.audioListener = null;

    // Audio sources (uuid -> AudioSource)
    this.sources = new Map();

    // Master gain
    this.masterGain = null;

    this._init();
  }

  _init() {
    try {
      // Create AudioContext
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();

      // Create master gain
      this.masterGain = this.audioContext.createGain();
      this.masterGain.gain.value = 1.0;
      this.masterGain.connect(this.audioContext.destination);

      // Create AudioListener (attached to camera)
      this.audioListener = this.audioContext.listener;

      console.log('[SpatialAudio] Initialized with sample rate:', this.audioContext.sampleRate);
    } catch (err) {
      console.error('[SpatialAudio] Failed to initialize:', err);
    }
  }

  /**
   * Create a spatial audio source for a Smart Object
   */
  createSource(uuid, position) {
    if (!this.audioContext) return null;

    if (this.sources.has(uuid)) {
      console.warn(`[SpatialAudio] Source ${uuid} already exists`);
      return this.sources.get(uuid);
    }

    // Create panner node for 3D positioning
    const panner = this.audioContext.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = 1;
    panner.maxDistance = 50;
    panner.rolloffFactor = 1;
    panner.coneInnerAngle = 360;
    panner.coneOuterAngle = 360;
    panner.coneOuterGain = 0;

    // Set position
    if (position) {
      panner.positionX.value = position.x || 0;
      panner.positionY.value = position.y || 0;
      panner.positionZ.value = position.z || 0;
    }

    // Create gain node for volume control
    const gainNode = this.audioContext.createGain();
    gainNode.gain.value = 1.0;

    // Connect: panner -> gain -> master
    panner.connect(gainNode);
    gainNode.connect(this.masterGain);

    // Create source data
    const source = {
      uuid,
      panner,
      gainNode,
      position: position ? { ...position } : { x: 0, y: 0, z: 0 },
      queue: [], // Audio packet queue
      isPlaying: false,
      currentSource: null, // Current AudioBufferSourceNode
      nextStartTime: 0
    };

    this.sources.set(uuid, source);

    console.log(`[SpatialAudio] Created source ${uuid} at`, position);

    return source;
  }

  /**
   * Remove a spatial audio source
   */
  removeSource(uuid) {
    const source = this.sources.get(uuid);
    if (!source) return false;

    // Stop current playback
    if (source.currentSource) {
      try {
        source.currentSource.stop();
      } catch (err) {
        // Already stopped
      }
    }

    // Disconnect nodes
    source.panner.disconnect();
    source.gainNode.disconnect();

    this.sources.delete(uuid);

    console.log(`[SpatialAudio] Removed source ${uuid}`);

    return true;
  }

  /**
   * Play audio packet at spatial position
   */
  async playAudio(uuid, audioPacket) {
    if (!this.audioContext) return;

    const source = this.sources.get(uuid);
    if (!source) {
      console.warn(`[SpatialAudio] Source ${uuid} not found`);
      return;
    }

    try {
      // Resume audio context if suspended
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Convert audio packet to AudioBuffer
      const audioBuffer = await this._audioPacketToBuffer(audioPacket);
      if (!audioBuffer) return;

      // Create buffer source
      const bufferSource = this.audioContext.createBufferSource();
      bufferSource.buffer = audioBuffer;

      // Connect to panner
      bufferSource.connect(source.panner);

      // Schedule playback
      const now = this.audioContext.currentTime;
      const startTime = Math.max(now, source.nextStartTime);

      bufferSource.start(startTime);

      // Update next start time for gapless playback
      source.nextStartTime = startTime + audioBuffer.duration;
      source.currentSource = bufferSource;

      // Cleanup on end
      bufferSource.onended = () => {
        if (source.currentSource === bufferSource) {
          source.currentSource = null;
        }
      };

    } catch (err) {
      console.error(`[SpatialAudio] Failed to play audio for ${uuid}:`, err);
    }
  }

  /**
   * Update source position (call this when object moves)
   */
  updateSourcePosition(uuid, position) {
    const source = this.sources.get(uuid);
    if (!source) return false;

    source.position = { ...position };

    if (source.panner) {
      source.panner.positionX.value = position.x || 0;
      source.panner.positionY.value = position.y || 0;
      source.panner.positionZ.value = position.z || 0;
    }

    return true;
  }

  /**
   * Update source volume
   */
  updateSourceVolume(uuid, volume) {
    const source = this.sources.get(uuid);
    if (!source) return false;

    const clampedVolume = Math.max(0, Math.min(1, volume));
    source.gainNode.gain.value = clampedVolume;

    return true;
  }

  /**
   * Update source spatial settings
   */
  updateSourceSettings(uuid, settings) {
    const source = this.sources.get(uuid);
    if (!source) return false;

    if (settings.maxDistance !== undefined) {
      source.panner.maxDistance = settings.maxDistance;
    }

    if (settings.rolloffFactor !== undefined) {
      source.panner.rolloffFactor = settings.rolloffFactor;
    }

    if (settings.volume !== undefined) {
      this.updateSourceVolume(uuid, settings.volume);
    }

    return true;
  }

  /**
   * Update listener position (camera position)
   */
  updateListenerPosition() {
    if (!this.audioListener || !this.camera) return;

    const position = this.camera.position;
    const quaternion = this.camera.quaternion;

    // Update listener position
    if (this.audioListener.positionX) {
      this.audioListener.positionX.value = position.x;
      this.audioListener.positionY.value = position.y;
      this.audioListener.positionZ.value = position.z;
    } else {
      // Fallback for older API
      this.audioListener.setPosition(position.x, position.y, position.z);
    }

    // Update listener orientation
    const forward = new THREE.Vector3(0, 0, -1);
    const up = new THREE.Vector3(0, 1, 0);

    forward.applyQuaternion(quaternion);
    up.applyQuaternion(quaternion);

    if (this.audioListener.forwardX) {
      this.audioListener.forwardX.value = forward.x;
      this.audioListener.forwardY.value = forward.y;
      this.audioListener.forwardZ.value = forward.z;
      this.audioListener.upX.value = up.x;
      this.audioListener.upY.value = up.y;
      this.audioListener.upZ.value = up.z;
    } else {
      // Fallback for older API
      this.audioListener.setOrientation(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /**
   * Convert audio packet to AudioBuffer
   */
  async _audioPacketToBuffer(audioPacket) {
    try {
      const format = audioPacket.format || 'pcm16';
      const sampleRate = audioPacket.sampleRate || 22050;
      const channels = audioPacket.channels || 1;
      const data = audioPacket.data;

      if (!data || !Array.isArray(data)) {
        console.error('[SpatialAudio] Invalid audio data');
        return null;
      }

      let floatArray;

      if (format === 'pcm16') {
        // Convert PCM16 Int16Array to Float32Array
        const int16Array = new Int16Array(data);
        floatArray = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
          floatArray[i] = int16Array[i] / 32768.0;
        }
      } else if (format === 'float32') {
        floatArray = new Float32Array(data);
      } else {
        console.error(`[SpatialAudio] Unsupported format: ${format}`);
        return null;
      }

      // Create AudioBuffer
      const audioBuffer = this.audioContext.createBuffer(
        channels,
        floatArray.length / channels,
        sampleRate
      );

      // Copy data to buffer
      for (let channel = 0; channel < channels; channel++) {
        const channelData = audioBuffer.getChannelData(channel);
        for (let i = 0; i < channelData.length; i++) {
          channelData[i] = floatArray[i * channels + channel];
        }
      }

      return audioBuffer;

    } catch (err) {
      console.error('[SpatialAudio] Failed to create AudioBuffer:', err);
      return null;
    }
  }

  /**
   * Set master volume
   */
  setMasterVolume(volume) {
    if (!this.masterGain) return;

    const clampedVolume = Math.max(0, Math.min(1, volume));
    this.masterGain.gain.value = clampedVolume;
  }

  /**
   * Mute/unmute all audio
   */
  setMuted(muted) {
    if (!this.masterGain) return;

    this.masterGain.gain.value = muted ? 0 : 1;
  }

  /**
   * Cleanup
   */
  dispose() {
    // Stop all sources
    this.sources.forEach((source) => {
      if (source.currentSource) {
        try {
          source.currentSource.stop();
        } catch (err) {
          // Already stopped
        }
      }
      source.panner.disconnect();
      source.gainNode.disconnect();
    });

    this.sources.clear();

    // Close audio context
    if (this.audioContext) {
      this.audioContext.close();
    }
  }
}

export { SpatialAudioManager };
