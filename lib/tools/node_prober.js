// lib/tools/node_prober.js
// 512MB 内存友好型轻量 TCP 握手探活与住宅宽带优选排序引擎

const net = require('node:net');
const ispClassifier = require('./isp_classifier');

class NodeProber {
  /**
   * 针对单个节点测试底层 TCP 握手延迟
   * 采用原生 net.createConnection，轻量且无代理协议额外开销
   */
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

  /**
   * 批量并发受控探活与住宅属性鉴定
   * @param {Array} candidateNodes 候选节点
   * @param {number} maxConcurrency 并发度，默认 3
   * @param {number} targetCount 需要筛选出的最终节点数，默认 20
   */
  async probeAndRankNodes(candidateNodes, maxConcurrency = 3, targetCount = 20) {
    console.log(`[NodeProber] 开始对 ${candidateNodes.length} 个候选节点进行受控握手探活与家宽鉴定...`);
    const survivingNodes = [];
    let activeWorkers = 0;
    let index = 0;

    const probeSingle = async (node) => {
      const { alive, latency } = await this.probeTcpLatency(node.host, node.port, 1800);
      if (alive) {
        // 只有存活的节点才进行住宅属性分析，节约计算与网络开销
        const ispMeta = await ispClassifier.classify(node.host, node.name);
        
        // 格式化新节点名称，添加闪亮家宽标签与延迟标识
        const cleanOldName = node.name.replace(/\[.*?\]/g, '').trim();
        const formattedName = `${ispMeta.tag} | ${ispMeta.isp.slice(0, 12)} (${latency}ms)`;

        // 重构 raw 链接中的 hash 名称，方便小火箭直接显示
        let finalRaw = node.raw;
        try {
          const u = new URL(node.raw);
          u.hash = encodeURIComponent(formattedName);
          finalRaw = u.toString();
        } catch (_) {}

        survivingNodes.push({
          ...node,
          raw: finalRaw,
          displayName: formattedName,
          latency,
          isResidential: ispMeta.isResidential,
          isp: ispMeta.isp,
          country: ispMeta.country,
          // 综合评分：家宽享受 150ms 的优先权重抵扣
          sortScore: latency - (ispMeta.isResidential ? 150 : 0)
        });
      }
    };

    // 并发池调度执行
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

    console.log(`[NodeProber] 探活结束！存活节点: ${survivingNodes.length} 个 (其中认证住宅宽带: ${survivingNodes.filter(n => n.isResidential).length} 个)`);

    // 智能排序：优先按 sortScore（住宅宽带大幅前置），其次按延迟
    survivingNodes.sort((a, b) => a.sortScore - b.sortScore);

    // 截取前 targetCount 个优质节点作为常驻活跃池
    const finalSelection = survivingNodes.slice(0, targetCount);
    return finalSelection;
  }
}

module.exports = new NodeProber();
