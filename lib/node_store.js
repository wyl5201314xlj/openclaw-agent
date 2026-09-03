// lib/node_store.js
// 商业中转节点池与 Clash YAML 纯净分发引擎

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '../data');
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
          const now = Date.now();
          this._coldNodes = Array.isArray(parsed.coldNodes)
            ? parsed.coldNodes.filter(c => c && c.frozenUntil && now < c.frozenUntil)
            : [];
          console.log(`[NodeStore] 成功从本地缓存恢复 ${this.activeNodes.length} 个历史节点（冷冻中: ${this._coldNodes.length}）`);
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
        nodes: this.activeNodes,
        coldNodes: (this._coldNodes || []).filter(c => c.frozenUntil && Date.now() < c.frozenUntil)
      }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('[NodeStore] 节点持久化保存异常:', err.message);
    }
  }

  /** 评分记忆键 */
  static scoreKey(n) {
    return `${n.server || n.host || ''}:${n.port || ''}`;
  }

  /**
   * 3-1 评分记忆：合并历史评分。
   * - 存活节点：successStreak+1、failStreak 清零、ewmaLatency 更新；
   * - 历史有分但本轮未出现的节点：failStreak+1；
   * - failStreak>=3 的节点冷冻 24h（frozenUntil），期间不参选；
   * - 历史分按 6h 半衰期打折后折算为等效优先级加成。
   */
  mergeScores(surviving) {
    const now = Date.now();
    const HALF_LIFE_MS = 6 * 3600 * 1000;
    const prev = new Map();
    for (const n of this.activeNodes) {
      prev.set(NodeStore.scoreKey(n), {
        s: Number(n.successStreak) || 0,
        f: Number(n.failStreak) || 0,
        ewma: Number(n.ewmaLatency),
        frozenUntil: Number(n.frozenUntil) || 0,
        seenAt: Number(n.scoreSeenAt) || 0,
      });
    }
    // 上轮已记分的缺席节点（_coldNodes）要参与累积，否则 failStreak 永远从 1 开始
    for (const c of this._coldNodes || []) {
      if (!c || !c.key || prev.has(c.key)) continue;
      prev.set(c.key, {
        s: 0,
        f: Number(c.failStreak) || 0,
        ewma: NaN,
        frozenUntil: Number(c.frozenUntil) || 0,
        seenAt: Number(c.scoreSeenAt) || 0,
      });
    }
    const aliveKeys = new Set();
    for (const n of surviving) {
      const key = NodeStore.scoreKey(n);
      aliveKeys.add(key);
      const old = prev.get(key) || { s: 0, f: 0, ewma: NaN, frozenUntil: 0, seenAt: 0 };
      const lat = Number(n.latency);
      n.successStreak = old.s + 1;
      n.failStreak = 0;
      n.ewmaLatency = Number.isFinite(lat) && lat > 0
        ? (Number.isFinite(old.ewma) ? Math.round(old.ewma * 0.6 + lat * 0.4) : lat)
        : (Number.isFinite(old.ewma) ? old.ewma : lat);
      n.frozenUntil = 0;
      n.scoreSeenAt = now;
      // 历史加成：连续成功每次 +20，上限 +100，再按 6h 半衰期打折
      const age = now - (old.seenAt || now);
      const decay = Math.pow(0.5, age / HALF_LIFE_MS);
      n.historyBonus = Math.round(Math.min(old.s, 5) * 20 * decay);
    }
    // 本轮未出现的历史节点：failStreak+1，连续 3 次失败则冷冻 24h
    this._coldNodes = [];
    for (const [key, old] of prev) {
      if (aliveKeys.has(key)) continue;
      const f = old.f + 1;
      const rec = { key, successStreak: 0, failStreak: f, frozenUntil: old.frozenUntil };
      if (f >= 3 && (!old.frozenUntil || now > old.frozenUntil)) {
        rec.frozenUntil = now + 24 * 3600 * 1000;
      } else if (f >= 3) {
        rec.frozenUntil = old.frozenUntil;
      }
      rec.scoreSeenAt = now;
      this._coldNodes.push(rec);
    }
    return surviving;
  }

  /** 是否被冷冻（供 scheduler 快检与全量轮使用） */
  isFrozen(server, port, now = Date.now()) {
    const key = `${server}:${port}`;
    const all = [...this.activeNodes, ...(this._coldNodes || []).map(c => ({ ...c, server: c.key.split(':')[0], port: c.key.split(':')[1] }))];
    const hit = all.find(n => NodeStore.scoreKey(n) === key);
    return Boolean(hit && hit.frozenUntil && now < hit.frozenUntil);
  }

  updateActiveNodes(nodes) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    const merged = this.mergeScores(nodes);
    this.activeNodes = merged.slice(0, 25);
    this.lastUpdatedAt = Date.now();
    this.saveToDisk();
    const frozen = (this._coldNodes || []).filter(c => c.frozenUntil && Date.now() < c.frozenUntil).length;
    console.log(`[NodeStore] 活跃商业节点池已刷新！当前保有节点: ${this.activeNodes.length} 个（冷冻中: ${frozen}）`);
  }

  getResidentialCount() {
    return this.activeNodes.filter(n => (n.name || n.displayName || '').includes('家宽')).length;
  }

  generateClashConfig() {
    const proxyList = [];
    const proxyNames = [];
    const nameCounts = new Map();

    for (let i = 0; i < this.activeNodes.length; i++) {
      const n = this.activeNodes[i];
      const baseName = `${n.displayName || n.name || ('Node-' + (i + 1))}`.replace(/[:]/g, '-').replace(/"/g, '').trim();
      
      let name = baseName;
      const count = nameCounts.get(baseName) || 0;
      if (count > 0) {
        name = `${baseName} ${count + 1}`;
      }
      nameCounts.set(baseName, count + 1);

      const server = n.server || n.host;
      const port = n.port;
      const type = n.type || n.protocol;

      if (!server || !port || !type) continue;

      const px = {
        name,
        type,
        server,
        port,
        udp: true
      };

      if (n.uuid) px.uuid = n.uuid;
      if (n.password) px.password = String(n.password);
      if (n.cipher) px.cipher = n.cipher;
      if (type === 'vmess') {
        px.alterId = n.alterId !== undefined ? n.alterId : 0;
        px.cipher = px.cipher || 'auto';
      }
      if (n.tls !== undefined) px.tls = Boolean(n.tls);
      if (n['skip-cert-verify'] !== undefined) px['skip-cert-verify'] = true;
      if (n.sni) px.sni = n.sni;
      if (n.network) px.network = n.network;
      if (n['ws-opts']) px['ws-opts'] = n['ws-opts'];

      proxyList.push(px);
      proxyNames.push(name);
    }

    if (proxyNames.length === 0) {
      proxyList.push({
        name: '🇨🇳 国内BGP备用节点',
        type: 'socks5',
        server: '127.0.0.1',
        port: 1080
      });
      proxyNames.push('🇨🇳 国内BGP备用节点');
    }

    let yaml = 'port: 7890\nsocks-port: 7891\nallow-lan: false\nmode: rule\nlog-level: info\nexternal-controller: 127.0.0.1:9090\n\nproxies:\n';

    for (const px of proxyList) {
      yaml += `  - name: "${px.name}"\n`;
      yaml += `    type: ${px.type}\n`;
      yaml += `    server: ${px.server}\n`;
      yaml += `    port: ${px.port}\n`;
      if (px.uuid) yaml += `    uuid: ${px.uuid}\n`;
      if (px.type === 'vmess') {
        yaml += `    alterId: ${px.alterId !== undefined ? px.alterId : 0}\n`;
        yaml += `    cipher: ${px.cipher || 'auto'}\n`;
      }
      if (px.password) yaml += `    password: "${px.password}"\n`;
      if (px.type !== 'vmess' && px.cipher) yaml += `    cipher: ${px.cipher}\n`;
      if (px.tls !== undefined) yaml += `    tls: ${px.tls}\n`;
      if (px.udp !== undefined) yaml += `    udp: ${px.udp}\n`;
      if (px['skip-cert-verify']) yaml += `    skip-cert-verify: true\n`;
      if (px.network) yaml += `    network: ${px.network}\n`;
      if (px['ws-opts']) {
        yaml += `    ws-opts:\n`;
        yaml += `      path: "${px['ws-opts'].path || '/'}"\n`;
        if (px['ws-opts'].headers?.Host) {
          yaml += `      headers:\n`;
          yaml += `        Host: "${px['ws-opts'].headers.Host}"\n`;
        }
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

    // 3-3 分流规则：国内直连 + 国外走代理。纯文本规则，零内存成本。
    yaml += '\ndns:\n';
    yaml += '  enable: true\n';
    yaml += '  nameserver:\n';
    yaml += '    - 223.5.5.5\n';
    yaml += '    - 8.8.8.8\n';
    yaml += '  fallback:\n';
    yaml += '    - 8.8.8.8\n';
    yaml += '    - 1.1.1.1\n';
    yaml += '\nrules:\n';
    yaml += '  - GEOIP,CN,DIRECT\n';
    for (const d of ['wechat.com', 'qq.com', 'bilibili.com', 'alicdn.com', '163.com', 'csdn.net', 'zhihu.com', 'taobao.com']) {
      yaml += `  - DOMAIN-SUFFIX,${d},DIRECT\n`;
    }
    yaml += '  - MATCH,🚀 节点选择\n';
    return yaml;
  }

  generateShadowrocketSubscription() {
    if (this.activeNodes.length === 0) {
      return Buffer.from('# No active nodes\n').toString('base64');
    }
    const lines = this.activeNodes.map(n => n.raw || `${n.type || 'vmess'}://${n.server}:${n.port}#${encodeURIComponent(n.name || '')}`).join('\n');
    return Buffer.from(lines).toString('base64');
  }

  getSummaryStats() {
    const latencies = this.activeNodes
      .map(n => Number(n.latency))
      .filter(v => Number.isFinite(v) && v > 0);
    const regionStats = {};
    for (const n of this.activeNodes) {
      const m = String(n.displayName || n.name || n.rawName || '');
      const code = /香港|HK/i.test(m) ? 'HK'
        : /台湾|TW/i.test(m) ? 'TW'
        : /日本|JP/i.test(m) ? 'JP'
        : /新加坡|SG/i.test(m) ? 'SG'
        : /美国|US/i.test(m) ? 'US'
        : /中国|BGP|中转/i.test(m) ? 'CN'
        : 'Global';
      regionStats[code] = (regionStats[code] || 0) + 1;
    }
    const speeds = this.activeNodes
      .map(n => Number(n.speedMbps))
      .filter(v => Number.isFinite(v) && v > 0);
    return {
      total: this.activeNodes.length,
      residential: this.getResidentialCount(),
      regionStats,
      minLatency: latencies.length ? Math.min(...latencies) : 0,
      avgLatency: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      maxSpeedMbps: speeds.length ? Math.max(...speeds) : 0,
      nodes: this.activeNodes.map(n => ({
        name: n.displayName || n.name,
        server: n.server, port: n.port,
        latency: n.latency, tlsOk: n.tlsOk ?? null,
        speedMbps: n.speedMbps || 0,
      })),
      lastUpdatedAt: new Date(this.lastUpdatedAt).toISOString(),
    };
  }
}

module.exports = new NodeStore();
