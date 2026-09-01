// lib/tools/search_tool.js
// 阶段 0-3 / 0-4 重写（第二版，源清单全部经过实测筛选）。
//
// 旧实现的致命问题：失败时返回编造话术冒充事实（幻觉注入），且丢弃 URL 无法溯源。
// 新实现原则：**宁可如实报失败，绝不编造**；每条结果必须带真实 title/url/snippet/source。
//
// 源选型实测记录（2026-09-01，本机 Node 原生 fetch）：
//   ✅ DDG html/lite —— 结果质量最好，但**并发或高频会被 HTTP 202 + anomaly 反爬**，
//      必须串行 + 最小间隔，命中反爬后进入冷却；
//   ✅ Google News RSS —— 200，时事类可靠，数据中心 IP 友好；
//   ✅ Wikipedia API（zh/en）—— 200，百科类稳定；
//   ✅ StackExchange API —— 200，编程问答类稳定；
//   ❌ Bing RSS —— 虽返回 200，但 item 与查询完全无关（实测同一批日文结果反复出现），已弃用；
//   ❌ s.jina.ai —— 401 需 API Key；r.jina.ai 代理搜索页 —— 403；
//   ❌ Qwant —— 403 DataDome；searx.be —— 浏览器验证；searxng.site / priv.au —— 403。

const { config } = require('../config');
const { createLogger } = require('../logger');
const { fetchText } = require('../safe_fetch');
const { LruTtlCache } = require('../cache');

const log = createLogger('SearchTool');

const cache = new LruTtlCache({
  name: 'search',
  maxEntries: config.cache.searchMax,
  ttlMs: config.cache.searchTtlMs,
  maxBytes: 8 * 1024 * 1024,
});

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/128.0.0.0 Safari/537.36';
const COMMON_HEADERS = { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' };

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&#x27;': "'", '&apos;': "'", '&nbsp;': ' ', '&#x2F;': '/',
};

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&[a-zA-Z#0-9]+;/g, (m) => ENTITIES[m] ?? m);
}

function stripTags(html) {
  return decodeEntities(String(html).replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

/** DDG 把真实地址包在 //duckduckgo.com/l/?uddg=<encoded> 里 */
function unwrapDdgLink(href) {
  if (!href) return '';
  const raw = decodeEntities(href);
  const wrapped = raw.match(/[?&]uddg=([^&]+)/);
  if (wrapped) {
    try {
      return decodeURIComponent(wrapped[1]);
    } catch {
      return '';
    }
  }
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw.startsWith('http') ? raw : '';
}

// ---------------- 串行闸门：DDG 必须串行且限速，否则必被反爬 ----------------

class SerialGate {
  constructor(minIntervalMs) {
    this.minIntervalMs = minIntervalMs;
    this.chain = Promise.resolve();
    this.lastAt = 0;
  }

  /** 把任务排到队尾串行执行，并保证相邻任务间隔不小于 minIntervalMs */
  run(task) {
    const scheduled = this.chain.then(async () => {
      const wait = this.minIntervalMs - (Date.now() - this.lastAt);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      try {
        return await task();
      } finally {
        this.lastAt = Date.now();
      }
    });
    // 链条本身不能因为单个任务失败而断掉
    this.chain = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  }
}

const ddgGate = new SerialGate(1500);

// 反爬冷却状态：命中 202/anomaly 后一段时间内不再打这个源。
// 2 分钟 + 随机抖动：DDG 是质量最好的源，冷却过长会长期退化到兜底源。
const DDG_COOLDOWN_MS = 120000;
const cooldowns = new Map();

function inCooldown(name) {
  const until = cooldowns.get(name) || 0;
  return Date.now() < until;
}

function setCooldown(name, ms) {
  cooldowns.set(name, Date.now() + ms);
  log.warn(`源 ${name} 触发反爬，冷却 ${Math.round(ms / 1000)}s`);
}

// ---------------- 解析器（结构均由实测样本确认）----------------

const RE_DDG_ANCHOR = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
const RE_DDG_SNIPPET = /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
const RE_LITE_LINK = /<a[^>]*href="([^"]+)"[^>]*class='result-link'[^>]*>([\s\S]*?)<\/a>/g;
const RE_LITE_SNIPPET = /<td[^>]*class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g;
const RE_RSS_ITEM = /<item>[\s\S]*?<\/item>/g;

/** DDG 两个变体的共同套路：标题锚点与摘要按序号一一对应 */
function parseDdgLike(html, limit, linkRe, snippetRe, sourceName) {
  const text = String(html);
  const snippets = [...text.matchAll(snippetRe)].map((m) => stripTags(m[1]));
  const out = [];
  let index = 0;
  for (const match of text.matchAll(linkRe)) {
    if (out.length >= limit) break;
    const url = unwrapDdgLink(match[1]);
    const at = index;
    index += 1;
    if (!url) continue;
    out.push({ title: stripTags(match[2]) || url, url, snippet: snippets[at] || '', source: sourceName });
  }
  return out;
}

const parseDdgHtml = (html, limit) => parseDdgLike(html, limit, RE_DDG_ANCHOR, RE_DDG_SNIPPET, 'ddg-html');
const parseDdgLite = (html, limit) => parseDdgLike(html, limit, RE_LITE_LINK, RE_LITE_SNIPPET, 'ddg-lite');

// Bing 结果块：<li class="b_algo"> ... <h2><a href="真实URL">标题</a></h2>
//              ... <div class="b_caption"><p class="b_lineclamp2">摘要</p></div>
// 注意必须用 cn.bing.com：www.bing.com 会把 href 包成 bing.com/ck/a 跟踪跳转，拿不到真实地址。
const RE_BING_BLOCK = /<li class="b_algo"[\s\S]*?<\/li>/g;
const RE_BING_TITLE = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/;
const RE_BING_SNIPPET = /<p class="b_lineclamp\d*"[^>]*>([\s\S]*?)<\/p>/;

function parseBingHtml(html, limit) {
  const out = [];
  for (const [block] of String(html).matchAll(RE_BING_BLOCK)) {
    if (out.length >= limit) break;
    const titleMatch = block.match(RE_BING_TITLE);
    if (!titleMatch) continue;
    const url = decodeEntities(titleMatch[1]);
    // 跟踪跳转链接拿不到真实目标，直接丢弃而不是把跳转地址交给模型
    if (!/^https?:\/\//.test(url) || /bing\.com\/ck\/a/i.test(url)) continue;
    const snippetMatch = block.match(RE_BING_SNIPPET);
    out.push({
      title: stripTags(titleMatch[2]) || url,
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : '',
      source: 'bing',
    });
  }
  return out;
}

function parseRss(xml, limit, sourceName) {  const out = [];
  for (const [item] of String(xml).matchAll(RE_RSS_ITEM)) {
    if (out.length >= limit) break;
    const title = item.match(/<title>([\s\S]*?)<\/title>/);
    const link = item.match(/<link>([\s\S]*?)<\/link>/);
    const desc = item.match(/<description>([\s\S]*?)<\/description>/);
    const url = link ? stripTags(link[1]) : '';
    if (!url || !/^https?:\/\//.test(url)) continue;
    out.push({
      title: title ? stripTags(title[1]) : url,
      url,
      snippet: desc ? stripTags(desc[1]).slice(0, 300) : '',
      source: sourceName,
    });
  }
  return out;
}

function parseWikipedia(json, limit, lang) {
  const list = json?.query?.search || [];
  return list.slice(0, limit).map((it) => ({
    title: it.title,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(it.title.replace(/ /g, '_'))}`,
    snippet: stripTags(it.snippet || ''),
    source: `wikipedia-${lang}`,
  }));
}

function parseStackExchange(json, limit) {
  const items = json?.items || [];
  return items.slice(0, limit).map((it) => ({
    title: decodeEntities(it.title || ''),
    url: it.link || '',
    snippet:
      `${it.is_answered ? '已解决' : '未解决'} · 得分 ${it.score ?? 0} · 回答 ${it.answer_count ?? 0}` +
      (it.tags?.length ? ` · 标签 ${it.tags.slice(0, 5).join('/')}` : ''),
    source: 'stackoverflow',
  }));
}

// ---------------- 源注册表 ----------------

/** 通用网页源：质量最好。Bing 无反爬压力可直连；DDG 必须走串行闸门限速 */
const WEB_SOURCES = [
  {
    name: 'bing',
    build: (q) => `https://cn.bing.com/search?q=${encodeURIComponent(q)}`,
    parse: parseBingHtml,
    accept: 'text/html',
    gate: null,
  },
  {
    name: 'ddg-lite',
    build: (q) => `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(q)}`,
    parse: parseDdgLite,
    accept: 'text/html',
    gate: ddgGate,
  },
  {
    name: 'ddg-html',
    build: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    parse: parseDdgHtml,
    accept: 'text/html',
    gate: ddgGate,
  },
];

/** 兜底源：不受反爬影响，可并发，覆盖百科 / 时事 / 编程问答三类 */
const FALLBACK_SOURCES = [
  {
    name: 'wikipedia-zh',
    build: (q) =>
      `https://zh.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=4` +
      `&srsearch=${encodeURIComponent(q)}`,
    parse: (text, limit) => parseWikipedia(JSON.parse(text), limit, 'zh'),
    accept: 'application/json',
  },
  {
    name: 'google-news',
    build: (q) =>
      `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`,
    parse: (text, limit) => parseRss(text, limit, 'google-news'),
    accept: 'application/rss+xml, application/xml, text/xml, */*',
  },
  {
    name: 'stackoverflow',
    build: (q) =>
      `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&site=stackoverflow` +
      `&pagesize=4&filter=default&q=${encodeURIComponent(q)}`,
    parse: (text, limit) => parseStackExchange(JSON.parse(text), limit),
    accept: 'application/json',
  },
];

// 各源在融合排序中的权重。实测依据：DDG 对多词中文查询的相关性明显最好；
// Bing（cn.bing.com）响应最快但对多词查询存在"只按首个词返回"的降级现象，故权重更低。
const SOURCE_WEIGHT = {
  'ddg-lite': 1.0,
  'ddg-html': 1.0,
  bing: 0.7,
  'google-news': 0.6,
  'wikipedia-zh': 0.5,
  stackoverflow: 0.5,
};

/** 判定 DDG 是否被反爬拦下（HTTP 202 或页面里出现 anomaly 提示） */
function looksBlocked(text) {
  return /anomaly|Please try again|unfortunately, bots/i.test(String(text).slice(0, 4000));
}

function dedupeKey(url) {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

// ---------------- 相关性过滤 ----------------
// 背景：Wikipedia / StackExchange / Google News 都是关键词检索 API，
// 对自然语言问句会返回明显无关的条目（实测「今天有什么科技新闻」返回了"刘亚东""孙笑川"）。
// 把无关条目喂给模型，等于旧版编造兜底的翻版，所以必须在入口就滤掉。

// 中文里高频但没有区分度的词，用作停用词
const CJK_STOPWORDS = new Set([
  '什么', '怎么', '为什', '哪些', '哪个', '如何', '可以', '现在', '今天', '一下',
  '请问', '告诉', '我想', '知道', '是否', '多少', '有没', '没有', '这个', '那个',
]);

/** 提取可比对的词元：拉丁词 + 中文二元组（单个汉字区分度太低，不用） */
function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const latin = (lower.match(/[a-z0-9][a-z0-9.+#_-]*/g) || []).filter((w) => w.length >= 2);
  const cjkRuns = lower.match(/[\u4e00-\u9fff]+/g) || [];
  const bigrams = [];
  for (const run of cjkRuns) {
    for (let i = 0; i + 1 < run.length; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!CJK_STOPWORDS.has(gram)) bigrams.push(gram);
    }
    if (run.length === 1) bigrams.push(run);
  }
  return new Set([...latin, ...bigrams]);
}

/** 结果与查询的词元重合数；0 表示完全不相关 */
function relevanceScore(queryTokens, item) {
  if (queryTokens.size === 0) return 1; // 查询本身没有有效词元时不做过滤
  const itemTokens = tokenize(`${item.title} ${item.snippet}`);
  let score = 0;
  for (const t of queryTokens) {
    if (itemTokens.has(t)) score += 1;
  }
  return score;
}


// ---------------- 主流程 ----------------

async function tryWebSource(src, query, limit, signal) {
  if (inCooldown(src.name)) {
    return { name: src.name, ok: false, error: '处于反爬冷却期，本次跳过', skipped: true };
  }
  const t0 = Date.now();
  try {
    const doFetch = () =>
      fetchText(src.build(query), {
        headers: { ...COMMON_HEADERS, Accept: src.accept },
        timeoutMs: config.timeouts.searchMs,
        signal,
      });
    // DDG 必须串行 + 限速，否则必被 202 反爬；Bing 无此约束，直连更快
    const text = src.gate ? await src.gate.run(doFetch) : await doFetch();
    if (looksBlocked(text)) {
      setCooldown(src.name, DDG_COOLDOWN_MS + Math.floor(Math.random() * 30000));
      return { name: src.name, ok: false, error: '被反爬拦截（anomaly 页）', ms: Date.now() - t0 };
    }
    const items = src.parse(text, limit + 3);
    if (items.length === 0) {
      return { name: src.name, ok: true, items: [], ms: Date.now() - t0 };
    }
    return { name: src.name, ok: true, items, ms: Date.now() - t0 };
  } catch (err) {
    // HTTP 202 也走这里（fetchText 对非 2xx 抛错；202 属 2xx 故由 looksBlocked 兜住）
    if (err.status === 202 || err.status === 429 || err.status === 403) {
      setCooldown(src.name, DDG_COOLDOWN_MS + Math.floor(Math.random() * 30000));
    }
    return { name: src.name, ok: false, error: String(err.message).slice(0, 160), ms: Date.now() - t0 };
  }
}

async function tryFallbackSource(src, query, limit, signal) {
  const t0 = Date.now();
  try {
    const text = await fetchText(src.build(query), {
      headers: { ...COMMON_HEADERS, Accept: src.accept },
      timeoutMs: config.timeouts.searchMs,
      signal,
    });
    return { name: src.name, ok: true, items: src.parse(text, limit), ms: Date.now() - t0 };
  } catch (err) {
    return { name: src.name, ok: false, error: String(err.message).slice(0, 160), ms: Date.now() - t0 };
  }
}

/**
 * 全网检索。**永不编造**：全部源失败时明确返回 ok:false。
 * 策略：先打通用网页源（质量最好，串行限速）；结果不足时再并发补齐兜底源。
 * @param {string} query
 * @param {{maxResults?:number, signal?:AbortSignal, noCache?:boolean}} [options]
 */
async function searchWeb(query, options = {}) {
  const started = Date.now();
  const maxResults = options.maxResults ?? 5;
  const q = String(query || '').trim().slice(0, 200);
  if (!q) return { ok: false, reason: '检索关键词为空', sourcesTried: [], elapsedMs: 0 };

  const cacheKey = `${q}::${maxResults}`;
  if (!options.noCache) {
    const hit = cache.get(cacheKey);
    if (hit) return { ...hit, cached: true, elapsedMs: Date.now() - started };
  }

  const sourcesTried = [];
  const queryTokens = tokenize(q);

  // 所有源并发（DDG 内部经串行闸门自我限速，Bing 与兜底源直连），
  // 再用 RRF（Reciprocal Rank Fusion）融合排序：多源共同命中的结果自然靠前。
  const reports = await Promise.all([
    ...WEB_SOURCES.map((src) => tryWebSource(src, q, maxResults + 3, options.signal)),
    ...FALLBACK_SOURCES.map((src) => tryFallbackSource(src, q, 6, options.signal)),
  ]);

  const pool = new Map(); // dedupeKey -> 融合条目
  let droppedTotal = 0;

  for (const report of reports) {
    let kept = 0;
    let dropped = 0;
    (report.items || []).forEach((item, rank) => {
      if (!item.url) return;
      // 相关性下限：与查询毫无词元重合的条目一律丢弃，避免把噪声当事实喂给模型
      const relevance = relevanceScore(queryTokens, item);
      if (relevance === 0) {
        dropped += 1;
        return;
      }
      const key = dedupeKey(item.url);
      const weight = SOURCE_WEIGHT[item.source] ?? 0.5;
      const existing = pool.get(key);
      if (existing) {
        existing.fusion += weight / (10 + rank);
        existing.sources.add(item.source);
        if (!existing.item.snippet && item.snippet) existing.item.snippet = item.snippet;
      } else {
        pool.set(key, {
          item,
          fusion: weight / (10 + rank),
          relevance,
          sources: new Set([item.source]),
        });
      }
      kept += 1;
    });
    droppedTotal += dropped;
    sourcesTried.push({
      name: report.name,
      ok: report.ok,
      count: kept,
      dropped: dropped || undefined,
      ms: report.ms,
      error: report.error,
    });
  }

  const ranked = [...pool.values()].sort((a, b) => {
    // 先看被多少个源同时命中（强信号），再看融合分，最后看词元重合度
    if (b.sources.size !== a.sources.size) return b.sources.size - a.sources.size;
    if (b.fusion !== a.fusion) return b.fusion - a.fusion;
    return b.relevance - a.relevance;
  });

  const results = ranked.slice(0, maxResults).map((entry) => ({
    ...entry.item,
    source: [...entry.sources].join('+'),
  }));
  const elapsedMs = Date.now() - started;

  if (results.length === 0) {
    const failed = sourcesTried.filter((s) => !s.ok);
    let reason;
    if (failed.length === sourcesTried.length) {
      reason = `所有检索源均不可用（${failed.map((s) => `${s.name}: ${s.error}`).join('；')}）`;
    } else if (droppedTotal > 0) {
      reason = `检索到 ${droppedTotal} 条结果但与问题均不相关，视为无有效资料`;
    } else {
      reason = '所有可用检索源均返回 0 条结果，关键词可能过窄';
    }
    log.warn(`检索失败: ${q}`, { reason, elapsedMs });
    return { ok: false, reason, sourcesTried, elapsedMs };
  }



  cache.set(cacheKey, { ok: true, results, sourcesTried });
  log.info(`检索完成: ${q}`, {
    count: results.length,
    elapsedMs,
    sources: sourcesTried.filter((s) => s.ok && s.count > 0).map((s) => s.name),
  });
  return { ok: true, results, sourcesTried, elapsedMs };
}

/** 渲染成给模型看的紧凑文本，强制带 URL 以便模型溯源与二次深读 */
function formatForModel(searchResult) {
  if (!searchResult.ok) {
    return `【检索失败】${searchResult.reason}\n禁止编造事实：请如实告知用户检索通道当前不可用，并说明可改用哪些方式获取信息。`;
  }
  return searchResult.results
    .map(
      (r, i) =>
        `[${i + 1}] ${r.title}\n    来源: ${r.source}\n    URL: ${r.url}\n    摘要: ${r.snippet || '(无摘要)'}`
    )
    .join('\n');
}

/** 供 /api/selftest 使用：逐源独立探活，报告每个源在当前部署环境下能否用 */
async function probeSources(query = 'Node.js LTS') {
  const web = [];
  for (const src of WEB_SOURCES) {
    web.push(await tryWebSource(src, query, 3, undefined));
  }
  const fallback = await Promise.all(
    FALLBACK_SOURCES.map((src) => tryFallbackSource(src, query, 3, undefined))
  );
  const shape = (r) => ({ name: r.name, ok: Boolean(r.ok && (r.items || []).length > 0), count: (r.items || []).length, ms: r.ms, error: r.error });
  return { web: web.map(shape), fallback: fallback.map(shape) };
}

module.exports = {
  searchWeb,
  formatForModel,
  probeSources,
  cache,
  _internal: {
    parseBingHtml,
    parseDdgHtml,
    parseDdgLite,
    parseRss,
    parseWikipedia,
    parseStackExchange,
    unwrapDdgLink,
    stripTags,
    decodeEntities,
    looksBlocked,
    tokenize,
    relevanceScore,
    SerialGate,
  },
};


