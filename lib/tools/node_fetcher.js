// lib/tools/node_fetcher.js
// 多源开源节点抓取、解包与协议标准化引擎

const SOURCES = [
  {
    name: 'Pawdroid/Free-servers (⭐18.8k)',
    url: 'https://raw.githubusercontent.com/Pawdroid/Free-servers/main/sub',
    type: 'base64',
  },
  {
    name: 'mermeroo/V2RAY-CLASH-BASE64 (⭐500+)',
    url: 'https://raw.githubusercontent.com/mermeroo/V2RAY-CLASH-BASE64-Subscription.Links/main/v2ray%20sub/v2ray%20sub.txt',
    type: 'base64',
  },
  {
    name: 'peass/free-nodes (包含家宽池)',
    url: 'https://raw.githubusercontent.com/peass/free-nodes/main/sub/sub_merge.txt',
    type: 'base64',
  },
  {
    name: 'awesome-vpn/awesome-vpn (⭐6.2k)',
    url: 'https://raw.githubusercontent.com/awesome-vpn/awesome-vpn/master/all',
    type: 'base64',
  }
];

class NodeFetcher {
  constructor() {
    this.cachedNodes = [];
    this.lastFetchedAt = 0;
  }

  /**
   * 从单个 URL 流式抓取文本数据，带 6 秒硬超时
   */
  async fetchRawText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
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

  /**
   * 解码 Base64 或纯文本链接列表
   */
  decodeSubscription(rawText) {
    let text = rawText.trim();
    // 尝试 base64 解码
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf-8');
      // 如果解码后包含常见协议头，说明是 base64
      if (/(?:vless|vmess|trojan|ss|ssr):\/\//i.test(decoded)) {
        text = decoded;
      }
    } catch (_) {}

    const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
    return lines;
  }

  /**
   * 解析单条节点链接为结构化对象
   */
  parseNodeLink(link) {
    try {
      const parsedUrl = new URL(link);
      const protocol = parsedUrl.protocol.replace(':', '').toLowerCase();

      if (!['vless', 'vmess', 'trojan', 'ss'].includes(protocol)) {
        return null;
      }

      const host = parsedUrl.hostname;
      const port = parseInt(parsedUrl.port || '443', 10);
      let name = decodeURIComponent(parsedUrl.hash ? parsedUrl.hash.slice(1) : '');

      if (!host || isNaN(port)) return null;

      // 如果节点名为空，自动合成一个
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
      // 针对部分非标准 URI 容错
      return null;
    }
  }

  /**
   * 聚合所有上游开源源，去重并返回候选节点列表
   */
  async fetchAllCandidateNodes(maxLimit = 80) {
    const rawLinks = [];
    let successCount = 0;

    for (const src of SOURCES) {
      try {
        console.log(`[NodeFetcher] 正在抓取订阅源: ${src.name}...`);
        const text = await this.fetchRawText(src.url);
        const lines = this.decodeSubscription(text);
        if (lines.length > 0) {
          rawLinks.push(...lines);
          successCount++;
          console.log(`[NodeFetcher]   -> 成功获取 ${lines.length} 条原始节点`);
        }
      } catch (err) {
        console.warn(`[NodeFetcher] 抓取源 ${src.name} 失败: ${err.message}`);
      }
    }

    // 去重与结构化解析
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
      console.log('[NodeFetcher] 本轮抓取为空，回退使用上一轮健康缓存节点');
      return this.cachedNodes;
    }

    console.log(`[NodeFetcher] 全源聚合完成！共提炼有效去重候选节点: ${parsedNodes.length} 个`);
    return parsedNodes;
  }
}

module.exports = new NodeFetcher();
