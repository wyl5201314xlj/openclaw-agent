// lib/tools/node_prober.js
// 针对商业机场中转与专线节点的轻量探活与清洗引擎

const net = require('node:net');
const tls = require('node:tls');
const ispClassifier = require('./isp_classifier');

// L3 测速配置：只允许 http/https，下到内存不落盘，单并发
const SPEED_TEST_URL = process.env.SPEED_TEST_URL || 'https://speed.cloudflare.com/__down?bytes=5242880';
const SPEED_TIMEOUT_MS = Number(process.env.SPEED_TIMEOUT_MS || 8000);
const SPEED_TOP_N = 8;

/** 校验测速 URL：只允许 http/https，拒绝内网与保留地址 */
function assertSafeSpeedUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('测速地址非法'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('测速地址只允许 http/https');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new Error('拒绝内网测速地址');
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(h)) {
    const p = h.split('.').map(Number);
    const [a, b] = p;
    if (a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
        (a === 169 && b === 254) || a === 0 || a >= 224) throw new Error('拒绝内网测速地址');
  }
  return u.toString();
}

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

  /**
   * L2：对声明 tls 的节点做真实 TLS ClientHello 握手。
   * 探活只判断"握手能否完成"，握手过程不传输任何凭据；
   * 免费节点普遍自签名，证书链校验交给客户端使用时按自身配置决定，
   * 这里仅验证协议可达性。握手失败的节点直接淘汰。
   */
  async probeTlsHandshake(host, port, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let isSettled = false;
      let socket = null;
      try {
        // servername 只在 host 是域名时传；IP 字面量传 servername 违反 RFC 6066（Node DEP0123）
        const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':');
        socket = tls.connect({
          host, port,
          ...(isIp ? {} : { servername: host }),
          timeout: timeoutMs,
          checkServerIdentity: () => undefined,
        });
      } catch (_) {
        return resolve({ tlsOk: false, tlsLatency: timeoutMs });
      }
      const finish = (ok) => {
        if (isSettled) return;
        isSettled = true;
        const ms = Date.now() - startTime;
        try { socket.destroy(); } catch (_) {}
        resolve({ tlsOk: ok, tlsLatency: ms });
      };
      socket.on('secureConnect', () => finish(true));
      socket.on('timeout', () => finish(false));
      socket.on('error', () => finish(false));
      const guard = setTimeout(() => finish(false), timeoutMs + 500);
      if (typeof guard.unref === 'function') guard.unref();
    });
  }

  /**
   * L3：带宽定级。对通过 L2 的前 N 个节点做 5MB 文件下载测速（单并发）。
   * 结果记 speedMbps（保留 1 位小数），失败记 0。
   */
  async probeDownloadSpeed(label = '') {
    let url;
    try {
      url = assertSafeSpeedUrl(SPEED_TEST_URL);
    } catch (err) {
      console.warn(`[NodeProber] 测速地址不合法，跳过带宽定级: ${err.message}`);
      return { speedMbps: 0 };
    }
    return new Promise((resolve) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SPEED_TIMEOUT_MS);
      const startTime = Date.now();
      let received = 0;
      fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'Clash/1.18.0' } })
        .then((resp) => {
          if (!resp.ok || !resp.body) throw new Error(`HTTP ${resp.status}`);
          const reader = resp.body.getReader();
          const pump = () =>
            reader.read().then(({ done, value }) => {
              if (done) return;
              received += value ? value.byteLength : 0;
              return pump();
            });
          return pump();
        })
        .then(() => {
          clearTimeout(timer);
          const secs = Math.max((Date.now() - startTime) / 1000, 0.01);
          const mbps = Number(((received * 8) / 1e6 / secs).toFixed(1));
          if (label) console.log(`[NodeProber] 带宽定级 ${label}: ${mbps} Mbps (${(received / 1048576).toFixed(1)}MB/${secs.toFixed(1)}s)`);
          resolve({ speedMbps: mbps });
        })
        .catch(() => {
          clearTimeout(timer);
          resolve({ speedMbps: 0 });
        });
    });
  }

  async probeAndRankNodes(candidateNodes, maxConcurrency = 5, targetCount = 20) {
    console.log(`[NodeProber] 开始对 ${candidateNodes.length} 个优质商业中转节点进行三级探活...`);
    const survivingNodes = [];
    let activeWorkers = 0;
    let tlsChecked = 0;
    let tlsPassed = 0;

    const probeSingle = async (node) => {
      // L1: TCP 握手
      const { alive, latency } = await this.probeTcpLatency(node.server, node.port, 1500);
      if (!alive) return;

      // L2: tls 节点必须通过真实 TLS 握手，否则淘汰
      let tlsOk = null;
      let tlsLatency = null;
      if (node.tls) {
        tlsChecked++;
        const r = await this.probeTlsHandshake(node.server, node.port, 5000);
        tlsOk = r.tlsOk;
        tlsLatency = r.tlsLatency;
        if (!tlsOk) return;
        tlsPassed++;
      }
      {
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

        // 家宽识别（可选增强）：失败不淘汰节点，只影响排序加权
        let isResidential = false;
        let ispTag = '';
        let scoreBonus = 0;
        try {
          const cls = await ispClassifier.classify(node.server, node.rawName || '');
          isResidential = Boolean(cls.isResidential);
          ispTag = cls.tag || '';
          scoreBonus = Number(cls.scoreBonus) || 0;
        } catch (_) {}

        // 规范化补齐必填字段，彻底杜绝 alterId、cipher 缺失
        const cleanNode = {
          ...node,
          name: displayName,
          displayName,
          latency,
          tlsOk,
          tlsLatency,
          speedMbps: 0,
          isResidential,
          ispTag,
          scoreBonus,
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
    console.log(`[NodeProber] L1 TCP 存活: ${survivingNodes.length} 个; L2 TLS 检查 ${tlsChecked} 通过 ${tlsPassed}`);

    // 优先：国内BGP/香港/台湾/日本排在最前列，且按延迟升序
    survivingNodes.sort((a, b) => {
      const pDiff = (b.priority || 0) - (a.priority || 0);
      if (pDiff !== 0) return pDiff;
      return a.latency - b.latency;
    });

    const top = survivingNodes.slice(0, targetCount);

    // L3: 对前 N 个做带宽定级（单并发，控制内存）
    const speedN = Math.min(SPEED_TOP_N, top.length);
    for (let i = 0; i < speedN; i++) {
      const { speedMbps } = await this.probeDownloadSpeed(`${i + 1}/${speedN} ${top[i].displayName}`);
      top[i].speedMbps = speedMbps;
    }
    // 按速度重排：有速度的优先；家宽加权（scoreBonus）折算为等效优先级
    top.sort((a, b) => {
      const sa = a.speedMbps || 0;
      const sb = b.speedMbps || 0;
      if (sb !== sa) return sb - sa;
      const pa = (a.priority || 0) + (a.scoreBonus || 0);
      const pb = (b.priority || 0) + (b.scoreBonus || 0);
      if (pb !== pa) return pb - pa;
      return a.latency - b.latency;
    });

    return top;
  }
}

module.exports = new NodeProber();
