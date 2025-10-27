/**
 * FPSMonitor - Tracks scene FPS and emits health status
 *
 * Monitors real-time FPS over a rolling window and categorizes performance
 * into health levels (EXCELLENT/GOOD/MODERATE/POOR/CRITICAL).
 *
 * Health Categories:
 *   EXCELLENT: >= 55fps - Smooth, can increase workload
 *   GOOD:      >= 45fps - Stable, maintain current workload
 *   MODERATE:  >= 35fps - Acceptable, reduce workload slightly
 *   POOR:      >= 25fps - Struggling, reduce workload significantly
 *   CRITICAL:  <  25fps - Severe issues, pause new work
 *
 * Usage:
 *   const monitor = new FPSMonitor({
 *     onHealthChange: (health, fps) => console.log(health, fps)
 *   });
 *
 *   // In render loop
 *   function animate() {
 *     monitor.recordFrame();
 *     renderer.render(scene, camera);
 *     requestAnimationFrame(animate);
 *   }
 */

export class FPSMonitor {
  constructor({
    onHealthChange = null,
    windowMs = 500,        // Rolling window for FPS calculation
    updateIntervalMs = 100 // How often to emit health updates
  } = {}) {
    this._onHealthChange = typeof onHealthChange === 'function' ? onHealthChange : null;
    this._windowMs = windowMs;
    this._updateIntervalMs = updateIntervalMs;

    // Frame timing tracking
    this._frameTimes = [];
    this._lastUpdateTime = 0;

    // Current state
    this._currentHealth = 'UNKNOWN';
    this._currentFPS = 0;
    this._lastFPS = 0;

    // Statistics
    this._minFPS = Infinity;
    this._maxFPS = 0;
    this._avgFPS = 0;
    this._sampleCount = 0;

    // Performance tracking
    this._healthHistory = [];
    this._maxHistoryLength = 50; // Keep last 5 seconds of history (50 * 100ms)
  }

  /**
   * Record a frame render - call this at the START of your render loop
   */
  recordFrame() {
    const now = performance.now();
    this._frameTimes.push(now);

    // Remove frames older than the rolling window
    const cutoff = now - this._windowMs;
    while (this._frameTimes.length > 0 && this._frameTimes[0] < cutoff) {
      this._frameTimes.shift();
    }

    // Update health status every updateIntervalMs
    if (now - this._lastUpdateTime >= this._updateIntervalMs) {
      this._updateHealth(now);
      this._lastUpdateTime = now;
    }
  }

  /**
   * Calculate FPS and update health status
   * @private
   */
  _updateHealth(now) {
    if (this._frameTimes.length < 2) {
      // Not enough data yet
      return;
    }

    // Calculate FPS from frame times in the window
    const timeSpan = now - this._frameTimes[0];
    const frameCount = this._frameTimes.length - 1; // -1 because we count intervals
    const fps = timeSpan > 0 ? (frameCount / timeSpan) * 1000 : 0;

    this._lastFPS = this._currentFPS;
    this._currentFPS = fps;

    // Update statistics
    this._minFPS = Math.min(this._minFPS, fps);
    this._maxFPS = Math.max(this._maxFPS, fps);
    this._sampleCount++;
    this._avgFPS = this._avgFPS === 0 ? fps : (this._avgFPS * 0.95) + (fps * 0.05); // Exponential moving average

    // Determine health level based on FPS
    let newHealth;
    if (fps >= 55) {
      newHealth = 'EXCELLENT';
    } else if (fps >= 45) {
      newHealth = 'GOOD';
    } else if (fps >= 35) {
      newHealth = 'MODERATE';
    } else if (fps >= 25) {
      newHealth = 'POOR';
    } else {
      newHealth = 'CRITICAL';
    }

    // Track health history
    this._healthHistory.push({
      timestamp: now,
      health: newHealth,
      fps: fps
    });
    if (this._healthHistory.length > this._maxHistoryLength) {
      this._healthHistory.shift();
    }

    // Emit health change event if status changed
    if (newHealth !== this._currentHealth) {
      const previousHealth = this._currentHealth;
      this._currentHealth = newHealth;

      if (this._onHealthChange) {
        this._onHealthChange(newHealth, fps, {
          previous: previousHealth,
          trend: this._getFPSTrend(),
          min: this._minFPS,
          max: this._maxFPS,
          avg: this._avgFPS
        });
      }
    }
  }

  /**
   * Analyze FPS trend over recent history
   * @private
   * @returns {'improving'|'stable'|'degrading'|'unknown'}
   */
  _getFPSTrend() {
    if (this._healthHistory.length < 5) return 'unknown';

    // Compare recent 5 samples to previous 5 samples
    const recentCount = Math.min(5, this._healthHistory.length);
    const recent = this._healthHistory.slice(-recentCount);
    const recentAvg = recent.reduce((sum, h) => sum + h.fps, 0) / recent.length;

    if (this._lastFPS === 0 || this._currentFPS === 0) return 'unknown';

    const change = this._currentFPS - recentAvg;
    const percentChange = (change / recentAvg) * 100;

    if (percentChange > 5) return 'improving';
    if (percentChange < -5) return 'degrading';
    return 'stable';
  }

  /**
   * Get current health status and FPS
   * @returns {{health: string, fps: number, trend: string, stats: object}}
   */
  getHealth() {
    return {
      health: this._currentHealth,
      fps: this._currentFPS,
      trend: this._getFPSTrend(),
      stats: {
        min: this._minFPS,
        max: this._maxFPS,
        avg: this._avgFPS,
        samples: this._sampleCount
      }
    };
  }

  /**
   * Get current FPS value
   * @returns {number}
   */
  getCurrentFPS() {
    return this._currentFPS;
  }

  /**
   * Get current health level
   * @returns {string}
   */
  getCurrentHealth() {
    return this._currentHealth;
  }

  /**
   * Check if FPS is healthy (>= GOOD threshold)
   * @returns {boolean}
   */
  isHealthy() {
    return this._currentHealth === 'EXCELLENT' || this._currentHealth === 'GOOD';
  }

  /**
   * Check if FPS is critical
   * @returns {boolean}
   */
  isCritical() {
    return this._currentHealth === 'CRITICAL';
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this._minFPS = Infinity;
    this._maxFPS = 0;
    this._avgFPS = 0;
    this._sampleCount = 0;
    this._healthHistory = [];
  }

  /**
   * Get detailed health report
   * @returns {object}
   */
  getReport() {
    return {
      current: {
        health: this._currentHealth,
        fps: this._currentFPS,
        trend: this._getFPSTrend()
      },
      statistics: {
        min: this._minFPS,
        max: this._maxFPS,
        avg: this._avgFPS,
        samples: this._sampleCount
      },
      history: this._healthHistory.slice(-10) // Last 10 samples
    };
  }
}
