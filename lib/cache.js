// lib/cache.js
// LRU + TTL 缓存（阶段 2-2）。
// 背景：线上实测 RSS 仅 73MB / 512MB，有 400MB+ 余量闲置；
// 目标是"花内存换流畅"，但必须有条目上限与体积上限，避免把富余变成 OOM。

class LruTtlCache {
  /**
   * @param {{maxEntries?:number, ttlMs?:number, maxBytes?:number, name?:string}} opts
   */
  constructor(opts = {}) {
    this.name = opts.name || 'cache';
    this.maxEntries = opts.maxEntries ?? 200;
    this.ttlMs = opts.ttlMs ?? 5 * 60 * 1000;
    this.maxBytes = opts.maxBytes ?? 16 * 1024 * 1024; // 单个缓存默认最多 16MB
    this.map = new Map(); // Map 保序，天然可做 LRU
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
  }

  static sizeOf(value) {
    if (typeof value === 'string') return value.length * 2; // UTF-16 粗估
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 1024;
    }
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expireAt) {
      this.map.delete(key);
      this.bytes -= entry.size;
      this.misses++;
      return undefined;
    }
    // 命中后移到末尾，实现 LRU
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key, value, ttlMs) {
    const size = LruTtlCache.sizeOf(value);
    if (size > this.maxBytes) return false; // 单条就超上限，直接不缓存
    const old = this.map.get(key);
    if (old) this.bytes -= old.size;
    this.map.delete(key);
    this.map.set(key, {
      value,
      size,
      expireAt: Date.now() + (ttlMs ?? this.ttlMs),
    });
    this.bytes += size;
    this.evict();
    return true;
  }

  evict() {
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      const entry = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      this.bytes -= entry ? entry.size : 0;
    }
    if (this.bytes < 0) this.bytes = 0;
  }

  /** 清理已过期条目；由外部定时调用，避免只在 get 时被动清理导致内存滞留 */
  prune() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.map) {
      if (now > entry.expireAt) {
        this.map.delete(key);
        this.bytes -= entry.size;
        removed++;
      }
    }
    if (this.bytes < 0) this.bytes = 0;
    return removed;
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      name: this.name,
      entries: this.map.size,
      approxKB: Math.round(this.bytes / 1024),
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Number((this.hits / total).toFixed(3)) : 0,
    };
  }
}

module.exports = { LruTtlCache };
