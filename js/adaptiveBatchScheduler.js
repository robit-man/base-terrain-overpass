/**
 * AdaptiveBatchScheduler - Dynamically adjusts terrain tile batch sizes
 * based on real-time FPS monitoring
 *
 * Manages three priority queues:
 * - Interactive tiles (highest priority, center-out)
 * - Visual tiles (medium priority)
 * - Farfield tiles (lowest priority)
 *
 * Batch sizes adapt to FPS health:
 * - EXCELLENT (>55fps): aggressive batching (mobile: 3-5, desktop: 8-12)
 * - GOOD (45-55fps): moderate batching (mobile: 2-3, desktop: 4-6)
 * - MODERATE (35-45fps): conservative (mobile: 1-2, desktop: 2-4)
 * - POOR (25-35fps): minimal (mobile: 1, desktop: 1-2)
 * - CRITICAL (<25fps): PAUSED (0 new requests)
 *
 * The scheduler implements center-outward loading, ensuring tiles closest
 * to the player are prioritized. It also enforces safety limits to prevent
 * queue overflow and crash conditions.
 */

export class AdaptiveBatchScheduler {
  constructor({
    isMobile = false,
    tileManager = null,
    onBatchSizeChange = null,
    onStatusChange = null
  } = {}) {
    this._isMobile = isMobile;
    this._tileManager = tileManager;
    this._onBatchSizeChange = typeof onBatchSizeChange === 'function' ? onBatchSizeChange : null;
    this._onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : null;

    // Current FPS health
    this._fpsHealth = 'UNKNOWN';
    this._currentFPS = 0;
    this._fpsTrend = 'unknown';

    // Adaptive batch sizes (updated based on FPS)
    // CRITICAL: Start with 0 until FPS health is known to prevent crash
    this._currentInteractiveBatchSize = 0;  // Wait for FPS measurement
    this._currentVisualBatchSize = 0;       // Wait until interactive done
    this._currentFarfieldBatchSize = 0;     // Wait until visual done

    // Paused state (when FPS critical)
    this._paused = false;
    this._pauseReason = null;

    // Separate queues by tile type
    this._interactiveQueue = [];
    this._visualQueue = [];
    this._farfieldQueue = [];

    // Queue size limits (prevent memory issues)
    this._maxInteractiveQueueSize = this._isMobile ? 50 : 150;
    this._maxVisualQueueSize = this._isMobile ? 30 : 100;
    this._maxFarfieldQueueSize = this._isMobile ? 20 : 80;

    // Processing state
    this._processing = false;
    this._lastProcessTime = 0;
    // CRITICAL: Process VERY slowly to prevent crash
    // Mobile: 1 batch per second, Desktop: 1 batch per 500ms
    this._minProcessIntervalMs = this._isMobile ? 1000 : 500;

    // Statistics
    this._stats = {
      totalEnqueued: 0,
      totalProcessed: 0,
      totalDropped: 0,
      batchSizeChanges: 0,
      pauseCount: 0,
      lastPauseTime: null,
      lastResumeTime: null
    };

    // Initial state logging
    console.log(`[AdaptiveBatch] Initialized - ${this._isMobile ? 'MOBILE' : 'DESKTOP'} mode`);
    console.log(`[AdaptiveBatch] Starting with 1 tile batch (center only)`);
  }

  /**
   * Called by FPSMonitor when health changes
   * @param {string} health - EXCELLENT, GOOD, MODERATE, POOR, or CRITICAL
   * @param {number} fps - Current FPS value
   * @param {object} metadata - Additional FPS metadata (trend, etc.)
   */
  updateFPSHealth(health, fps, metadata = {}) {
    const previousHealth = this._fpsHealth;
    this._fpsHealth = health;
    this._currentFPS = fps;
    this._fpsTrend = metadata.trend || 'unknown';

    // Log health changes
    if (previousHealth !== health) {
      console.log(`[AdaptiveBatch] FPS Health: ${previousHealth} -> ${health} (${fps.toFixed(1)}fps, trend: ${this._fpsTrend})`);
    }

    // Adjust batch sizes based on health
    this._adjustBatchSizes(health, metadata);

    // Resume if we were paused and health improved
    if (this._paused && health !== 'CRITICAL' && health !== 'POOR') {
      this._resume();
    }

    // Pause if health critical
    if (health === 'CRITICAL' && !this._paused) {
      this._pause('FPS_CRITICAL');
    }

    // Emit status change
    if (this._onStatusChange) {
      this._onStatusChange(this.getStatus());
    }
  }

  /**
   * Adjust batch sizes based on FPS health
   * @private
   */
  _adjustBatchSizes(health, metadata = {}) {
    let interactiveBatch, visualBatch, farfieldBatch;

    if (this._isMobile) {
      switch (health) {
        case 'EXCELLENT':
          // ULTRA CONSERVATIVE on mobile - each tile blocks 100-400ms
          interactiveBatch = 1;
          visualBatch = 1;
          farfieldBatch = 0;
          break;
        case 'GOOD':
          // Minimal - good balance
          interactiveBatch = 1;
          visualBatch = 0;
          farfieldBatch = 0;
          break;
        case 'MODERATE':
          // Ultra conservative - prioritize interactive only
          interactiveBatch = 1;
          visualBatch = 0;
          farfieldBatch = 0;
          break;
        case 'POOR':
          // Minimal - one tile at a time
          interactiveBatch = 1;
          visualBatch = 0;
          farfieldBatch = 0;
          break;
        default: // CRITICAL or UNKNOWN
          // Paused - no new batches
          interactiveBatch = 0;
          visualBatch = 0;
          farfieldBatch = 0;
      }
    } else {
      // Desktop - more conservative than before
      // Each tile still takes 100-200ms to finalize
      switch (health) {
        case 'EXCELLENT':
          // Conservative batching - tiles are expensive
          interactiveBatch = 3;
          visualBatch = 2;
          farfieldBatch = 1;
          break;
        case 'GOOD':
          // Moderate batching
          interactiveBatch = 2;
          visualBatch = 1;
          farfieldBatch = 0;
          break;
        case 'MODERATE':
          // Conservative batching
          interactiveBatch = 1;
          visualBatch = 1;
          farfieldBatch = 0;
          break;
        case 'POOR':
          // Minimal batching
          interactiveBatch = 1;
          visualBatch = 0;
          farfieldBatch = 0;
          break;
        default: // CRITICAL or UNKNOWN
          interactiveBatch = 0;
          visualBatch = 0;
          farfieldBatch = 0;
      }
    }

    // If FPS is degrading, be more conservative
    if (metadata.trend === 'degrading') {
      interactiveBatch = Math.max(1, Math.floor(interactiveBatch * 0.7));
      visualBatch = Math.floor(visualBatch * 0.5);
      farfieldBatch = Math.floor(farfieldBatch * 0.5);
    }

    // Check if batch sizes changed
    const changed =
      this._currentInteractiveBatchSize !== interactiveBatch ||
      this._currentVisualBatchSize !== visualBatch ||
      this._currentFarfieldBatchSize !== farfieldBatch;

    if (changed) {
      const previous = {
        interactive: this._currentInteractiveBatchSize,
        visual: this._currentVisualBatchSize,
        farfield: this._currentFarfieldBatchSize
      };

      this._currentInteractiveBatchSize = interactiveBatch;
      this._currentVisualBatchSize = visualBatch;
      this._currentFarfieldBatchSize = farfieldBatch;

      this._stats.batchSizeChanges++;

      console.log(`[AdaptiveBatch] Batch sizes adjusted:`, {
        interactive: `${previous.interactive} -> ${interactiveBatch}`,
        visual: `${previous.visual} -> ${visualBatch}`,
        farfield: `${previous.farfield} -> ${farfieldBatch}`,
        health,
        fps: this._currentFPS.toFixed(1)
      });

      if (this._onBatchSizeChange) {
        this._onBatchSizeChange({
          interactive: interactiveBatch,
          visual: visualBatch,
          farfield: farfieldBatch,
          previous,
          health,
          fps: this._currentFPS
        });
      }
    }
  }

  /**
   * Pause batch processing
   * @private
   */
  _pause(reason) {
    if (this._paused) return;

    this._paused = true;
    this._pauseReason = reason;
    this._stats.pauseCount++;
    this._stats.lastPauseTime = Date.now();

    console.warn(`[AdaptiveBatch] PAUSED - ${reason} (FPS: ${this._currentFPS.toFixed(1)})`);
  }

  /**
   * Resume batch processing
   * @private
   */
  _resume() {
    if (!this._paused) return;

    const pauseDuration = this._stats.lastPauseTime ? Date.now() - this._stats.lastPauseTime : 0;
    this._paused = false;
    this._pauseReason = null;
    this._stats.lastResumeTime = Date.now();

    console.log(`[AdaptiveBatch] Resumed after ${(pauseDuration / 1000).toFixed(1)}s (FPS: ${this._currentFPS.toFixed(1)})`);

    // Trigger batch processing
    this._scheduleBatchProcess();
  }

  /**
   * Add tiles to appropriate queue based on type and distance from center
   * @param {Array<Tile>|Tile} tiles - Single tile or array of tiles to enqueue
   */
  enqueueTiles(tiles) {
    const tilesArray = Array.isArray(tiles) ? tiles : [tiles];
    let enqueued = 0;
    let dropped = 0;

    for (const tile of tilesArray) {
      if (!tile || tile.populating) continue;

      // Calculate distance from center for priority
      const distance = Math.sqrt(tile.q * tile.q + tile.r * tile.r);
      const entry = {
        tile,
        distance,
        enqueuedAt: performance.now(),
        q: tile.q,
        r: tile.r
      };

      // Add to appropriate queue based on tile type
      let added = false;
      switch (tile.type) {
        case 'interactive':
          if (this._interactiveQueue.length < this._maxInteractiveQueueSize) {
            this._interactiveQueue.push(entry);
            added = true;
          } else {
            dropped++;
            console.warn(`[AdaptiveBatch] Interactive queue full, dropping tile ${tile.q},${tile.r}`);
          }
          break;
        case 'visual':
          if (this._visualQueue.length < this._maxVisualQueueSize) {
            this._visualQueue.push(entry);
            added = true;
          } else {
            dropped++;
          }
          break;
        case 'farfield':
          if (this._farfieldQueue.length < this._maxFarfieldQueueSize) {
            this._farfieldQueue.push(entry);
            added = true;
          } else {
            dropped++;
          }
          break;
      }

      if (added) enqueued++;
    }

    if (enqueued > 0) {
      this._stats.totalEnqueued += enqueued;
      this._stats.totalDropped += dropped;

      // Sort queues by distance (center-out priority)
      this._interactiveQueue.sort((a, b) => a.distance - b.distance);
      this._visualQueue.sort((a, b) => a.distance - b.distance);
      this._farfieldQueue.sort((a, b) => a.distance - b.distance);

      // Trigger batch processing
      this._scheduleBatchProcess();
    }
  }

  /**
   * Schedule batch processing if not already scheduled
   * @private
   */
  _scheduleBatchProcess() {
    if (this._processing || this._paused) return;

    const now = performance.now();
    const timeSinceLastProcess = now - this._lastProcessTime;

    if (timeSinceLastProcess < this._minProcessIntervalMs) {
      // Too soon, schedule for later
      const delay = this._minProcessIntervalMs - timeSinceLastProcess;
      setTimeout(() => this._processBatches(), delay);
    } else {
      // Process immediately
      this._processBatches();
    }
  }

  /**
   * Process batches from queues based on current batch sizes
   * @private
   */
  _processBatches() {
    if (this._paused || !this._tileManager) {
      this._processing = false;
      return;
    }

    this._processing = true;
    this._lastProcessTime = performance.now();

    let processed = 0;

    // Process interactive tiles first (highest priority)
    if (this._currentInteractiveBatchSize > 0 && this._interactiveQueue.length > 0) {
      const interactiveBatch = this._interactiveQueue.splice(0, this._currentInteractiveBatchSize);
      for (const { tile, q, r } of interactiveBatch) {
        if (!tile.populating) {
          this._tileManager._queuePopulateIfNeeded(tile, true); // priority = true
          processed++;
        }
      }
    }

    // Only process visual if interactive queue is manageable
    const interactiveBacklog = this._interactiveQueue.length;
    if (interactiveBacklog < 5 && this._currentVisualBatchSize > 0 && this._visualQueue.length > 0) {
      const visualBatch = this._visualQueue.splice(0, this._currentVisualBatchSize);
      for (const { tile } of visualBatch) {
        if (!tile.populating) {
          this._tileManager._queuePopulateIfNeeded(tile, false);
          processed++;
        }
      }
    }

    // Only process farfield if both interactive and visual queues are small
    if (interactiveBacklog === 0 && this._visualQueue.length < 3 && this._currentFarfieldBatchSize > 0 && this._farfieldQueue.length > 0) {
      const farfieldBatch = this._farfieldQueue.splice(0, this._currentFarfieldBatchSize);
      for (const { tile } of farfieldBatch) {
        if (!tile.populating) {
          this._tileManager._queuePopulateIfNeeded(tile, false);
          processed++;
        }
      }
    }

    this._stats.totalProcessed += processed;
    this._processing = false;

    // If queues still have items and we're not paused, schedule next process
    const hasWork = this._interactiveQueue.length > 0 ||
                    this._visualQueue.length > 0 ||
                    this._farfieldQueue.length > 0;

    if (hasWork && !this._paused) {
      setTimeout(() => this._scheduleBatchProcess(), this._minProcessIntervalMs);
    }
  }

  /**
   * Get current status of the scheduler
   * @returns {object} Status object with all current state
   */
  getStatus() {
    return {
      fpsHealth: this._fpsHealth,
      currentFPS: this._currentFPS,
      fpsTrend: this._fpsTrend,
      paused: this._paused,
      pauseReason: this._pauseReason,
      batchSizes: {
        interactive: this._currentInteractiveBatchSize,
        visual: this._currentVisualBatchSize,
        farfield: this._currentFarfieldBatchSize
      },
      queueLengths: {
        interactive: this._interactiveQueue.length,
        visual: this._visualQueue.length,
        farfield: this._farfieldQueue.length
      },
      queueLimits: {
        interactive: this._maxInteractiveQueueSize,
        visual: this._maxVisualQueueSize,
        farfield: this._maxFarfieldQueueSize
      },
      stats: { ...this._stats }
    };
  }

  /**
   * Clear all queues (use with caution)
   */
  clearQueues() {
    const cleared = {
      interactive: this._interactiveQueue.length,
      visual: this._visualQueue.length,
      farfield: this._farfieldQueue.length
    };

    this._interactiveQueue = [];
    this._visualQueue = [];
    this._farfieldQueue = [];

    console.log(`[AdaptiveBatch] Cleared queues:`, cleared);
  }

  /**
   * Force resume (emergency use)
   */
  forceResume() {
    console.warn('[AdaptiveBatch] Force resume triggered');
    this._resume();
  }

  /**
   * Force pause (emergency use)
   */
  forcePause(reason = 'MANUAL') {
    console.warn('[AdaptiveBatch] Force pause triggered:', reason);
    this._pause(reason);
  }
}
