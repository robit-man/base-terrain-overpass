/**
 * ProgressiveLoader - Unified queue system for terrain, buildings, trees, grass
 *
 * Prevents crash by:
 * - Single frame budget shared across ALL systems
 * - Center-outward priority (closest tiles first)
 * - Conservative budgets that never block main thread
 * - Gradual loading that spreads work across many frames
 */

export class ProgressiveLoader {
  constructor({ isMobile = false } = {}) {
    this._isMobile = isMobile;

    // CRITICAL: Conservative frame budgets to prevent blocking
    // Mobile: 6ms allows ~1-2 buildings per frame without blocking
    // Desktop: 8ms allows faster loading
    this._frameBudgetMs = isMobile ? 6 : 8;

    // Unified queue: { type, tile, priority, distance, data }
    this._queue = [];
    this._processing = new Set(); // Track what's currently being processed

    // Center position for distance calculations
    this._centerQ = 0;
    this._centerR = 0;

    // Callbacks for each system
    this._handlers = {
      terrain: null,      // (tile) => process terrain
      buildings: null,    // (tile, data) => process buildings
      trees: null,        // (tile) => process trees
      grass: null,        // (tile) => process grass
    };

    // Stats
    this._stats = {
      queueLength: 0,
      processed: 0,
      skipped: 0,
    };
  }

  setCenter(q, r) {
    this._centerQ = q;
    this._centerR = r;
  }

  setHandler(type, handler) {
    if (this._handlers.hasOwnProperty(type)) {
      this._handlers[type] = handler;
    }
  }

  // Enqueue work with automatic priority based on distance from center
  enqueue(type, tile, data = null) {
    if (!tile || !this._handlers[type]) return;

    const queueKey = tile.__plKey
      || (data && data.queueKey)
      || (type === 'buildings' && data?.job?.tileKey != null && data?.featureIndex != null
        ? `${data.job.tileKey}:${data.featureIndex}`
        : null);

    const q = Number.isFinite(tile.q) ? tile.q : this._centerQ;
    const r = Number.isFinite(tile.r) ? tile.r : this._centerR;

    const key = queueKey ? `${type}:${queueKey}` : `${type}:${q},${r}`;

    // Skip if already in queue or processing
    if (this._processing.has(key)) return;
    if (this._queue.some(item => item.key === key)) return;

    // Calculate distance from center (hex distance)
    const dq = Math.abs(q - this._centerQ);
    const dr = Math.abs(r - this._centerR);
    const distance = Math.max(dq, dr, Math.abs(dq - dr));

    // Priority: lower distance = higher priority (process first)
    // Terrain gets slight boost over buildings
    const typePriority = { terrain: 0, buildings: 1, trees: 2, grass: 3 };
    const priority = distance * 10 + (typePriority[type] || 999);

    this._queue.push({
      type,
      tile,
      data,
      priority,
      distance,
      key,
    });

    // Keep queue sorted by priority (low = high priority)
    this._queue.sort((a, b) => a.priority - b.priority);

    // CRITICAL: Limit queue size to prevent memory explosion
    const maxQueue = this._isMobile ? 50 : 150;
    if (this._queue.length > maxQueue) {
      // Remove lowest priority items (end of array)
      this._queue = this._queue.slice(0, maxQueue);
    }
  }

  // Process queue incrementally each frame
  drain() {
    if (this._queue.length === 0) return;

    const start = performance.now();
    const budget = this._frameBudgetMs;

    let processedThisDrain = 0;

    while (this._queue.length > 0) {
      // Check budget
      if (performance.now() - start > budget) break;

      const item = this._queue.shift();
      if (!item) continue;

      // Mark as processing
      this._processing.add(item.key);

      try {
        const handler = this._handlers[item.type];
        if (handler) {
          handler(item.tile, item.data);
          this._stats.processed++;
        } else {
          this._stats.skipped++;
        }
      } catch (err) {
        console.error(`[ProgressiveLoader] Error processing ${item.type}:`, err);
        this._stats.skipped++;
      }

      // Remove from processing set
      this._processing.delete(item.key);

      // Only process one item per drain to be extra conservative
      // This ensures we never block the main thread
      processedThisDrain++;

      if (processedThisDrain >= 1) {
        const timeUsed = performance.now() - start;
        const next = this._queue[0];
        const allowSecond = processedThisDrain < 2 && next && next.type !== item.type && timeUsed <= budget * 0.6;
        if (!allowSecond) break;
      }
    }

    this._stats.queueLength = this._queue.length;
  }

  clear() {
    this._queue = [];
    this._processing.clear();
  }

  getStats() {
    return { ...this._stats };
  }
}
