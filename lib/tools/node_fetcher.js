// lib/tools/node_fetcher.js
// 多源开源节点抓取、解包与协议标准化引擎 (支持 VMess/VLESS/Trojan/SS)

const SOURCES = [
  {
    name: 'freefq/free (⭐10k+ 老牌优质亚太直连源)',
    url: 'https://raw.githubusercontent.com/freefq/free/master/v2',
    type: 'base64',
  },
  {
    name: 'Pawdroid/Free-servers (⭐18.8k 顶流聚合源)',
    url: 'https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub',
    type: 'base64',
  },
  {
    name: 'awesome-vpn/awesome-vpn (⭐6.2k 亚太特选)',
    url: 'https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all',
    type: 'base64',
  }
];

// 彻底清退 Cloudflare 免费 CDN 节点（彻底告别丢包与高延迟）
const CF_BLACKLIST_REGEX = /(?:cloudflare|workers\.dev|pages\.dev|104\.(?:1[6-9]|2[0-8])\.|172\.6[4-7]\.|162\.159\.|108\.162\.|141\.101\.|188\.114\.|kdns\.fr)/i;

class NodeFetcher {
  constructor() {
    this.cachedNodes = [];
    this.lastFetchedAt = 0;
  }

  async fetchRawText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });
      clearTimeout(timer);
      if (resp.status !== 200) {
        throw new Error(`HTTP ${resp.status}`);
      }
      return await resp.text();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  decodeSubscription(rawText) {
    let text = rawText.trim();
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf-8');
      if (/(?:vless|vmess|trojan|ss|ssr):\/\//i.test(decoded)) {
        text = decoded;
      }
    } catch (_) {}

    return text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  }

  parseNodeLink(link) {
    try {
      if (link.startsWith('vmess://')) {
        const b64 = link.slice(8);
        const jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
        const v = JSON.parse(jsonStr);
        const host = v.add;
        const port = parseInt(v.port, 10);
        if (!host || isNaN(port)) return null;

        // 强力过滤 Cloudflare
        if (CF_BLACKLIST_REGEX.test(host) || CF_BLACKLIST_REGEX.test(v.host || '')) {
          return null;
        }

        const name = v.ps || `${host}:${port}`;
        return {
          raw: link,
          protocol: 'vmess',
          host,
          port,
          name,
          uuid: v.id,
          alterId: parseInt(v.aid || '0', 10),
          network: v.net || 'tcp',
          tls: v.tls === 'tls',
          params: {
            host: v.host || '',
            path: v.path || '/'
          }
        };
      }

      const parsedUrl = new URL(link);
      const protocol = parsedUrl.protocol.replace(':', '').toLowerCase();

      if (!['vless', 'trojan', 'ss'].includes(protocol)) {
        return null;
      }

      const host = parsedUrl.hostname;
      const port = parseInt(parsedUrl.port || '443', 10);
      let name = decodeURIComponent(parsedUrl.hash ? parsedUrl.hash.slice(1) : '');

      if (!host || isNaN(port)) return null;

      // 强力过滤 Cloudflare
      const searchStr = parsedUrl.search || '';
      if (CF_BLACKLIST_REGEX.test(host) || CF_BLACKLIST_REGEX.test(searchStr) || CF_BLACKLIST_REGEX.test(name)) {
        return null;
      }

      if (!name) {
        name = `${protocol.toUpperCase()}-${host}:${port}`;
      }

      return {
        raw: link,
        protocol,
        host,
        port,
        name,
        params: Object.fromEntries(parsedUrl.searchParams.entries()),
      };
    } catch {
      return null;
    }
  }

  async fetchAllCandidateNodes(maxLimit = 120) {
    const rawLinks = [];
    for (const src of SOURCES) {
      try {
        console.log(`[NodeFetcher] 正在抓取: ${src.name}...`);
        const text = await this.fetchRawText(src.url);
        const lines = this.decodeSubscription(text);
        if (lines.length > 0) {
          rawLinks.push(...lines);
          console.log(`[NodeFetcher]   -> 获得 ${lines.length} 条原始记录`);
        }
      } catch (err) {
        console.warn(`[NodeFetcher] 抓取 ${src.name} 失败: ${err.message}`);
      }
    }

    const parsedNodes = [];
    const seenKeys = new Set();

    for (const link of rawLinks) {
      const node = this.parseNodeLink(link);
      if (!node) continue;

      const dedupeKey = `${node.protocol}://${node.host}:${node.port}`;
      if (!seenKeys.has(dedupeKey)) {
        seenKeys.add(dedupeKey);
        parsedNodes.push(node);
      }

      if (parsedNodes.length >= maxLimit) break;
    }

    if (parsedNodes.length > 0) {
      this.cachedNodes = parsedNodes;
      this.lastFetchedAt = Date.now();
    } else if (this.cachedNodes.length > 0) {
      return this.cachedNodes;
    }

    console.log(`[NodeFetcher] 彻底剔除 Cloudflare 后，保留纯净中国优化候选节点: ${parsedNodes.length} 个`);
    return parsedNodes;
  }
}

module.exports = new NodeFetcher();
