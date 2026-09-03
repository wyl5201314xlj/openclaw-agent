// lib/node_store.js
// 20 节点常驻活跃池管理器与 Shadowrocket (小火箭) 订阅生成器

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_FILE = path.join(DATA_DIR, 'active_nodes.json');

class NodeStore {
  constructor() {
    this.activeNodes = [];
    this.lastUpdatedAt = 0;
    this.initFromDisk();
  }

  initFromDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(CACHE_FILE)) {
        const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.nodes) && parsed.nodes.length > 0) {
          this.activeNodes = parsed.nodes;
          this.lastUpdatedAt = parsed.lastUpdatedAt || Date.now();
          console.log(`[NodeStore] 成功从本地缓存恢复 ${this.activeNodes.length} 个历史节点`);
        }
      }
    } catch (err) {
      console.warn('[NodeStore] 从本地恢复节点失败:', err.message);
    }
  }

  saveToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify({
        lastUpdatedAt: this.lastUpdatedAt,
        nodes: this.activeNodes
      }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[NodeStore] 节点持久化保存异常:', err.message);
    }
  }

  updateActiveNodes(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    this.activeNodes = nodes.slice(0, 20); // 严格保持在 20 个最优节点以内
    this.lastUpdatedAt = Date.now();
    this.saveToDisk();
    console.log(`[NodeStore] 活跃节点池已刷新！当前保有节点: ${this.activeNodes.length} 个 (家宽数: ${this.getResidentialCount()})`);
  }

  getResidentialCount() {
    return this.activeNodes.filter(n => n.isResidential).length;
  }

  /**
   * 生成 Shadowrocket (小火箭) 兼容的 Base64 订阅串
   */
  generateShadowrocketSubscription() {
    if (this.activeNodes.length === 0) {
      return Buffer.from('# No active nodes currently available\n').toString('base64');
    }
    const lines = this.activeNodes.map(n => n.raw).join('\n');
    return Buffer.from(lines).toString('base64');
  }

  /**
   * 获取多维度汇总数据 (供早报与监控接口调用)
   */
  getSummaryStats() {
    const total = this.activeNodes.length;
    const residential = this.getResidentialCount();
    const latencies = this.activeNodes.map(n => n.latency || 200);
    const avgLatency = total > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / total) : 0;
    const minLatency = total > 0 ? Math.min(...latencies) : 0;

    // 统计地区分布
    const regionStats = {};
    for (const n of this.activeNodes) {
      const c = n.country || 'Global';
      regionStats[c] = (regionStats[c] || 0) + 1;
    }

    return {
      total,
      residential,
      datacenter: total - residential,
      avgLatency,
      minLatency,
      regionStats,
      lastUpdatedAt: new Date(this.lastUpdatedAt).toISOString(),
    };
  }
}

module.exports = new NodeStore();
