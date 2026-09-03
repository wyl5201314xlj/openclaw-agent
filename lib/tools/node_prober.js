// lib/tools/node_prober.js
// 针对中国网络深度优化的轻量探活与权重排序引擎

const net = require('node:net');
const ispClassifier = require('./isp_classifier');

// 亚太低延迟直连/中转地区高权重列表
const ASIA_PACIFIC_REGIONS = new Set(['HK', 'JP', 'SG', 'TW', 'KR', 'MO']);

class NodeProber {
  async probeTcpLatency(host, port, timeoutMs = 1800) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let isSettled = false;

      const socket = net.createConnection({ host, port });
      socket.setTimeout(timeoutMs);

      const finish = (alive, latency) => {
        if (isSettled) return;
        isSettled = true;
        try {
          socket.destroy();
        } catch (_) {}
        resolve({ alive, latency });
      };

      socket.on('connect', () => {
        const latency = Date.now() - startTime;
        finish(true, latency);
      });

      socket.on('timeout', () => {
        finish(false, timeoutMs);
      });

      socket.on('error', () => {
        finish(false, timeoutMs);
      });
    });
  }

  async probeAndRankNodes(candidateNodes, maxConcurrency = 3, targetCount = 20) {
    console.log(`[NodeProber] 开始对 ${candidateNodes.length} 个非 Cloudflare 候选节点进行探活与中国优化加权...`);
    const survivingNodes = [];
    let activeWorkers = 0;

    const probeSingle = async (node) => {
      const { alive, latency } = await this.probeTcpLatency(node.host, node.port, 1800);
      if (alive) {
        const ispMeta = await ispClassifier.classify(node.host, node.name);
        
        // 格式化名称：明确标明 港/日/新/美/家宽
        const regionTag = ispMeta.tag || '亚太直连';
        const formattedName = `${regionTag} | ${node.protocol.toUpperCase()} (${latency}ms)`;

        let finalRaw = node.raw;
        try {
          if (node.protocol !== 'vmess') {
            const u = new URL(node.raw);
            u.hash = encodeURIComponent(formattedName);
            finalRaw = u.toString();
          }
        } catch (_) {}

        // 中国大陆网络优化加权打分算法 (分值越低越靠前)
        let sortScore = latency;
        
        // 1. 亚太低延迟区域 (港/日/新/台/韩)：-200ms 优先倾斜
        if (ASIA_PACIFIC_REGIONS.has(ispMeta.country) || /(?:香港|日本|新加坡|台湾|澳门|韩国|HK|JP|SG|TW|KR)/i.test(node.name)) {
          sortScore -= 200;
        }

        // 2. 认证住宅宽带 (ISP)：额外 -150ms 优先倾斜
        if (ispMeta.isResidential) {
          sortScore -= 150;
        }

        survivingNodes.push({
          ...node,
          raw: finalRaw,
          displayName: formattedName,
          latency,
          isResidential: ispMeta.isResidential,
          isp: ispMeta.isp,
          country: ispMeta.country,
          sortScore
        });
      }
    };

    const pool = [];
    for (let i = 0; i < candidateNodes.length; i++) {
      const p = (async () => {
        while (activeWorkers >= maxConcurrency) {
          await new Promise(r => setTimeout(r, 50));
        }
        activeWorkers++;
        try {
          await probeSingle(candidateNodes[i]);
        } finally {
          activeWorkers--;
        }
      })();
      pool.push(p);
    }

    await Promise.all(pool);
    console.log(`[NodeProber] 存活且经中国优化加权节点: ${survivingNodes.length} 个`);

    // 智能升序排序：亚太高速 + 家宽排在最顶部
    survivingNodes.sort((a, b) => a.sortScore - b.sortScore);
    return survivingNodes.slice(0, targetCount);
  }
}

module.exports = new NodeProber();
