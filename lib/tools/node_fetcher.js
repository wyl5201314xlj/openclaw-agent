// lib/tools/node_fetcher.js
// 商业机场真实国内中转、亚太专线与共享节点聚合引擎

const yaml = require('yaml');

const CLASH_SOURCES = [
  {
    name: 'Anaer/Sub (⭐商业机场万级共享池，含国内BGP中转与亚太直连)',
    url: 'https://raw.githubusercontent.com/anaer/Sub/main/clash.yaml',
  },
  {
    name: 'ssrsub/ssr (⭐商业推广优质试用专线池)',
    url: 'https://raw.githubusercontent.com/ssrsub/ssr/master/clash.yaml',
  }
];

// 亚太与国内优化关键词
const CHINA_OPTIMIZED_KEYWORDS = ['中国', '香港', '台湾', '日本', '新加坡', '韩国', 'HK', 'TW', 'JP', 'SG', 'KR'];

class NodeFetcher {
  constructor() {
    this.cachedNodes = [];
    this.lastFetchedAt = 0;
  }

  async fetchRawText(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Clash/1.18.0' }
      });
      clearTimeout(timer);
      if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
      return await resp.text();
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  decodeSubscription(rawText) {
    let text = String(rawText || '').trim();
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf-8');
      if (/(?:vless|vmess|trojan|ss|ssr):/i.test(decoded)) {
        text = decoded;
      }
    } catch (_) {}
    return text.split(/[\r\n]+/).map(l => l.trim()).filter(Boolean);
  }

  parseNodeLink(link) {
    try {
      const parsedUrl = new URL(link);
      const protocol = parsedUrl.protocol.replace(':', '').toLowerCase();
      return {
        protocol,
        host: parsedUrl.hostname,
        port: parseInt(parsedUrl.port || '443', 10),
        name: decodeURIComponent(parsedUrl.hash ? parsedUrl.hash.slice(1) : ''),
        raw: link
      };
    } catch {
      return null;
    }
  }

  async fetchAllCandidateNodes(maxLimit = 150) {
    const candidateProxies = [];
    const seenServers = new Set();

    for (const src of CLASH_SOURCES) {
      try {
        console.log(`[NodeFetcher] 正在抓取商业机场源: ${src.name}...`);
        const text = await this.fetchRawText(src.url);
        const parsed = yaml.parse(text);
        const proxies = Array.isArray(parsed?.proxies) ? parsed.proxies : [];
        console.log(`[NodeFetcher]   -> 成功解析出 ${proxies.length} 个原始商业节点`);

        // 筛选非回环地址且具备亚太/中国中转特性的节点
        for (const p of proxies) {
          const server = String(p.server || '').trim();
          const port = parseInt(p.port, 10);
          const name = String(p.name || '');

          if (!server || !port || server.startsWith('127.') || server === 'localhost') {
            continue;
          }

          // 彻底排除 Cloudflare 劣质公网 CDN
          if (/(?:cloudflare|workers\.dev|pages\.dev|104\.(?:1[6-9]|2[0-8])\.|172\.6[4-7]\.|162\.159\.|141\.101\.)/i.test(server)) {
            continue;
          }

          const dedupeKey = `${server}:${port}`;
          if (seenServers.has(dedupeKey)) continue;
          seenServers.add(dedupeKey);

          // 计算中国优化亲和度
          let priority = 0;
          if (/中国|BGP|中转/i.test(name)) priority += 500;
          else if (/香港|HK/i.test(name)) priority += 400;
          else if (/台湾|TW/i.test(name)) priority += 350;
          else if (/日本|JP/i.test(name)) priority += 300;
          else if (/新加坡|SG/i.test(name)) priority += 250;
          else if (/韩国|KR/i.test(name)) priority += 200;

          candidateProxies.push({
            ...p,
            rawName: name,
            priority
          });
        }
      } catch (err) {
        console.warn(`[NodeFetcher] 抓取 ${src.name} 失败: ${err.message}`);
      }
    }

    // 按中国网络优化亲和度降序排列
    candidateProxies.sort((a, b) => b.priority - a.priority);
    const selected = candidateProxies.slice(0, maxLimit);
    console.log(`[NodeFetcher] 优选出中国大陆网络高亲和度商业节点: ${selected.length} 个`);
    return selected;
  }
}

module.exports = new NodeFetcher();
