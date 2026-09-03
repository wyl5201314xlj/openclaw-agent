// lib/tools/node_prober.js
// 针对商业机场中转与专线节点的轻量探活与清洗引擎

const net = require('node:net');

class NodeProber {
  async probeTcpLatency(host, port, timeoutMs = 1500) {
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

      socket.on('timeout', () => finish(false, timeoutMs));
      socket.on('error', () => finish(false, timeoutMs));
    });
  }

  async probeAndRankNodes(candidateNodes, maxConcurrency = 5, targetCount = 20) {
    console.log(`[NodeProber] 开始对 ${candidateNodes.length} 个优质商业中转节点进行真实连通性探活...`);
    const survivingNodes = [];
    let activeWorkers = 0;

    const probeSingle = async (node) => {
      const { alive, latency } = await this.probeTcpLatency(node.server, node.port, 1500);
      if (alive) {
        // 智能重塑展示名称
        let region = '亚太高速';
        const rawName = node.rawName || '';
        if (/中国|BGP|中转/i.test(rawName)) region = '🇨🇳 国内BGP中转';
        else if (/香港|HK/i.test(rawName)) region = '🇭🇰 香港专线';
        else if (/台湾|TW/i.test(rawName)) region = '🇹🇼 台湾直连';
        else if (/日本|JP/i.test(rawName)) region = '🇯🇵 日本高速';
        else if (/新加坡|SG/i.test(rawName)) region = '🇸🇬 新加坡专线';
        else if (/韩国|KR/i.test(rawName)) region = '🇰🇷 韩国高速';
        else if (/美国|US/i.test(rawName)) region = '🇺🇸 美国专线';
        else if (/德国|DE/i.test(rawName)) region = '🇩🇪 德国家宽';

        const displayName = `${region} | ${String(node.type).toUpperCase()} (${latency}ms)`;

        // 规范化补齐必填字段，彻底杜绝 alterId、cipher 缺失
        const cleanNode = {
          ...node,
          name: displayName,
          displayName,
          latency,
          udp: true
        };

        if (cleanNode.type === 'vmess') {
          cleanNode.alterId = cleanNode.alterId !== undefined ? cleanNode.alterId : 0;
          cleanNode.cipher = cleanNode.cipher || 'auto';
        }

        survivingNodes.push(cleanNode);
      }
    };

    const pool = [];
    for (let i = 0; i < candidateNodes.length; i++) {
      const p = (async () => {
        while (activeWorkers >= maxConcurrency) {
          await new Promise(r => setTimeout(r, 40));
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
    console.log(`[NodeProber] 真实连通且可用商业中转节点: ${survivingNodes.length} 个`);

    // 优先：国内BGP/香港/台湾/日本排在最前列，且按延迟升序
    survivingNodes.sort((a, b) => {
      const pDiff = (b.priority || 0) - (a.priority || 0);
      if (pDiff !== 0) return pDiff;
      return a.latency - b.latency;
    });

    return survivingNodes.slice(0, targetCount);
  }
}

module.exports = new NodeProber();
