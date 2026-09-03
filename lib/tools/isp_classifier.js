// lib/tools/isp_classifier.js
// 住宅宽带 (ISP / Residential IP) 识别引擎
// 采用：内置主流住宅运营商 ASN / 组织离线字典 + 在线元数据轻量缓存校验

const dns = require('node:dns').promises;

// 1. 全球主流住宅宽带运营商核心 ASN 白名单
const RESIDENTIAL_ASNS = new Set([
  // 美国住宅宽带
  'AS7018',  // AT&T Services
  'AS7922',  // Comcast Cable
  'AS20115', // Charter Communications / Spectrum
  'AS701',   // Verizon
  'AS5650',  // Frontier Communications
  'AS22773', // Cox Communications
  'AS6128',  // Cablevision
  'AS10796', // Charter
  'AS11427', // Spectrum
  
  // 香港住宅宽带
  'AS4755',  // HKT / PCCW Limited
  'AS9269',  // Hong Kong Broadband Network (HKBN)
  'AS9381',  // WTT HK Limited
  'AS131090', // HKBN Enterprise Solutions

  // 日本住宅宽带
  'AS4713',  // NTT Communications / OCN
  'AS2516',  // KDDI Corporation
  'AS17676', // Softbank Corp
  'AS2514',  // NTT PC Communications
  'AS7506',  // GMO Internet

  // 台湾住宅宽带
  'AS3462',  // Data Communication Business Group (HiNet 中华电信)
  'AS9924',  // Taiwan Mobile Co., Ltd.
  'AS18049', // Far EasTone Telecommunications

  // 新加坡住宅宽带
  'AS7473',  // Singapore Telecommunications (Singtel)
  'AS4657',  // StarHub Ltd
  'AS10099', // MyRepublic

  // 英国 / 欧洲 / 加拿大 / 澳洲
  'AS2856',  // British Telecommunications (BT)
  'AS5607',  // Sky UK
  'AS3320',  // Deutsche Telekom
  'AS1221',  // Telstra Corporation
  'AS812',   // Rogers Communications
  'AS852',   // Telus Communications
]);

// 2. 住宅运营商组织名关键词正则
const RESIDENTIAL_KEYWORDS_REGEX = /(?:telecom|broadband|cable|residential|fiber|ftth|fttx|home|dynamic|dialup|hinet|pccw|hkbn|singtel|starhub|charter|comcast|verizon|at&t|frontier|cox)/i;
const HOSTING_KEYWORDS_REGEX = /(?:datacenter|hosting|cloud|vps|server|dedicated|ovh|hetzner|digitalocean|linode|vultr|alibaba|tencent|aws|amazon|google cloud|azure|cloudflare|choopa|m247|leaseweb)/i;

// 3. 内存缓存 (TTL 24小时，最多存 2000 个 IP)
const ipCache = new Map();
const CACHE_TTL_MS = 24 * 3600 * 1000;

class ISPClassifier {
  constructor() {
    this.rateLimitedUntil = 0;
  }

  /** 将域名解析为真实 IP */
  async resolveToIP(host) {
    if (!host) return '';
    // 如果已经是 IPV4 / IPV6
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.includes(':')) {
      return host;
    }
    try {
      const res = await dns.lookup(host);
      return res.address || '';
    } catch {
      return '';
    }
  }

  /**
   * 综合分析并鉴定一个节点的 IP 是否为原生住宅宽带
   * @param {string} host 节点的主机名或 IP
   * @param {string} [nodeName=''] 节点原本备注名称 (可能自带 "家宽" / "ISP")
   * @returns {Promise<{ isResidential: boolean, isp: string, country: string, tag: string, scoreBonus: number }>}
   */
  async classify(host, nodeName = '') {
    // 1. 如果节点原本名称就明确带有 "家宽" / "住宅" / "ISP"
    if (/(?:家宽|住宅|residential|isp)/i.test(nodeName)) {
      return {
        isResidential: true,
        isp: 'Community Verified ISP',
        country: this.extractCountry(nodeName),
        tag: '🏠原生家宽',
        scoreBonus: 100,
      };
    }

    const ip = await this.resolveToIP(host);
    if (!ip) {
      return { isResidential: false, isp: 'Unknown', country: 'Global', tag: '机房', scoreBonus: 0 };
    }

    // 2. 查缓存
    const now = Date.now();
    const cached = ipCache.get(ip);
    if (cached && (now - cached.time < CACHE_TTL_MS)) {
      return cached.data;
    }

    // 3. 尝试调用轻量元数据接口查询 (ip-api.com)
    let meta = null;
    if (now > this.rateLimitedUntil) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2000); // 2秒快速超时
        const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,isp,org,as,hosting`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'OpenClawISPClassifier/1.0' }
        });
        clearTimeout(timer);

        if (resp.status === 200) {
          meta = await resp.json();
        } else if (resp.status === 429) {
          this.rateLimitedUntil = now + 60000; // 冷却 1 分钟
        }
      } catch (err) {
        // 网络超时静默降级
      }
    }

    // 4. 判定规则计算
    let isResidential = false;
    let ispName = 'Global Network';
    let countryCode = 'Global';

    if (meta && meta.status === 'success') {
      ispName = meta.isp || meta.org || '';
      countryCode = meta.countryCode || meta.country || '';

      const asNumber = (meta.as || '').split(' ')[0].toUpperCase();
      
      // 核心依据 A: 命中全球主流住宅 ASN
      if (RESIDENTIAL_ASNS.has(asNumber)) {
        isResidential = true;
      }
      // 核心依据 B: 明确标注 hosting === false，且 ISP 包含宽带关键词，不含机房词
      else if (meta.hosting === false && RESIDENTIAL_KEYWORDS_REGEX.test(ispName) && !HOSTING_KEYWORDS_REGEX.test(ispName)) {
        isResidential = true;
      }
      // 核心依据 C: hosting 为 false 且非公认大机房
      else if (meta.hosting === false && !HOSTING_KEYWORDS_REGEX.test(ispName)) {
        isResidential = true;
      }
    } else {
      // 离线备用规则：从原始节点名称粗推
      countryCode = this.extractCountry(nodeName);
      if (RESIDENTIAL_KEYWORDS_REGEX.test(nodeName) && !HOSTING_KEYWORDS_REGEX.test(nodeName)) {
        isResidential = true;
      }
    }

    const tag = isResidential ? `🏠${this.formatCountryTag(countryCode)}家宽` : `${this.formatCountryTag(countryCode)}机房`;
    const scoreBonus = isResidential ? 100 : 0;

    const result = {
      isResidential,
      isp: ispName,
      country: countryCode,
      tag,
      scoreBonus,
    };

    // 写缓存
    ipCache.set(ip, { time: now, data: result });
    if (ipCache.size > 2000) {
      const firstKey = ipCache.keys().next().value;
      ipCache.delete(firstKey);
    }

    return result;
  }

  formatCountryTag(code) {
    const c = String(code || '').toUpperCase();
    if (c.includes('US') || c.includes('美')) return '美国';
    if (c.includes('HK') || c.includes('港')) return '香港';
    if (c.includes('JP') || c.includes('日')) return '日本';
    if (c.includes('SG') || c.includes('新')) return '新加坡';
    if (c.includes('TW') || c.includes('台')) return '台湾';
    if (c.includes('GB') || c.includes('UK') || c.includes('英')) return '英国';
    if (c.includes('DE') || c.includes('德')) return '德国';
    return '海外';
  }

  extractCountry(name) {
    const n = String(name || '');
    if (/香港|HK|Hong/i.test(n)) return 'HK';
    if (/日本|JP|Japan/i.test(n)) return 'JP';
    if (/美国|US|America|United States/i.test(n)) return 'US';
    if (/新加坡|SG|Singapore/i.test(n)) return 'SG';
    if (/台湾|TW|Taiwan/i.test(n)) return 'TW';
    return 'US';
  }
}

module.exports = new ISPClassifier();
