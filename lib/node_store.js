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
    /**
   * 生成 Clash for Android / Clash Meta 兼容的标准 YAML 配置文件
   */
  generateClashConfig() {
    const proxyList = [];
    const proxyNames = [];

    for (let i = 0; i < this.activeNodes.length; i++) {
      const n = this.activeNodes[i];
      const name = `${n.displayName || n.name || ('Node-' + (i + 1))}`.replace(/[:]/g, '-').replace(/"/g, '');
      const p = n.protocol;
      const host = n.host;
      const port = n.port;

      if (!host || !port) continue;

      try {
        if (p === 'trojan') {
          const u = new URL(n.raw);
          const password = u.username || 'password';
          proxyList.push({
            name,
            type: 'trojan',
            server: host,
            port,
            password,
            udp: true,
            sni: n.params?.sni || host,
            'skip-cert-verify': true
          });
          proxyNames.push(name);
        } else if (p === 'vless') {
          const u = new URL(n.raw);
          const uuid = u.username || '';
          const tls = n.params?.security === 'tls' || port === 443;
          const network = n.params?.type || 'tcp';
          const proxyObj = {
            name,
            type: 'vless',
            server: host,
            port,
            uuid,
            udp: true,
            tls,
            'skip-cert-verify': true,
            network
          };
          if (network === 'ws') {
            proxyObj['ws-opts'] = {
              path: n.params?.path || '/',
              headers: { Host: n.params?.host || host }
            };
          }
          proxyList.push(proxyObj);
          proxyNames.push(name);
        } else if (p === 'ss') {
          const u = new URL(n.raw);
          let cipher = 'aes-256-gcm';
          let password = 'pass';
          if (u.username) {
            try {
              const decoded = Buffer.from(u.username, 'base64').toString('utf-8');
              if (decoded.includes(':')) {
                [cipher, password] = decoded.split(':');
              }
            } catch (_) {
              password = u.username;
            }
          }
          proxyList.push({
            name,
            type: 'ss',
            server: host,
            port,
            cipher,
            password,
            udp: true
          });
          proxyNames.push(name);
        }
      } catch (_) {}
    }

    if (proxyNames.length === 0) {
      proxyList.push({
        name: '探活备用节点',
        type: 'socks5',
        server: '127.0.0.1',
        port: 1080
      });
      proxyNames.push('探活备用节点');
    }

    let yaml = 'port: 7890\nsocks-port: 7891\nallow-lan: false\nmode: rule\nlog-level: info\nexternal-controller: 127.0.0.1:9090\n\nproxies:\n';

    for (const px of proxyList) {
      yaml += `  - name: "${px.name}"\n`;
      yaml += `    type: ${px.type}\n`;
      yaml += `    server: ${px.server}\n`;
      yaml += `    port: ${px.port}\n`;
      if (px.uuid) yaml += `    uuid: ${px.uuid}\n`;
      if (px.password) yaml += `    password: "${px.password}"\n`;
      if (px.cipher) yaml += `    cipher: ${px.cipher}\n`;
      if (px.tls !== undefined) yaml += `    tls: ${px.tls}\n`;
      if (px.udp !== undefined) yaml += `    udp: ${px.udp}\n`;
      if (px['skip-cert-verify']) yaml += `    skip-cert-verify: true\n`;
      if (px.network) yaml += `    network: ${px.network}\n`;
      if (px['ws-opts']) {
        yaml += `    ws-opts:\n`;
        yaml += `      path: "${px['ws-opts'].path}"\n`;
        yaml += `      headers:\n`;
        yaml += `        Host: "${px['ws-opts'].headers.Host}"\n`;
      }
    }

    yaml += '\nproxy-groups:\n  - name: 🚀 节点选择\n    type: select\n    proxies:\n      - ⚡ 自动选择\n      - DIRECT\n';
    for (const name of proxyNames) {
      yaml += `      - "${name}"\n`;
    }

    yaml += '\n  - name: ⚡ 自动选择\n    type: url-test\n    url: http://www.gstatic.com/generate_204\n    interval: 300\n    proxies:\n';
    for (const name of proxyNames) {
      yaml += `      - "${name}"\n`;
    }

    yaml += '\nrules:\n  - MATCH,🚀 节点选择\n';
    return yaml;
  }

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
