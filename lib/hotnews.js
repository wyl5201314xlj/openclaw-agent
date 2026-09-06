// lib/hotnews.js
// 每日热门资讯抓取与 QQ 推送摘要生成。
//
// 设计要点：
// - 主源 Google News 中文热点 RSS（实测 26 items，200）；备源 HN front page；
// - 摘要不含任何 URL（QQ 对未报备外链会过滤，见 docs/OPTIMIZATION_PLAN.md P1-4 结论）；
// - 标题去重：与上次推送的标题比对（经 lib/store 持久化），避免同一天重复刷屏；
// - 文本长度控制在 ~700 字内，单条 QQ 文本消息可承载。

const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('HotNews');

const LAST_KEY = 'hotnews:last';
const MAX_ITEMS = 8;
const TITLE_MAX = 48;
const FEEDS = [
  {
    name: 'GoogleNews',
    url: 'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans',
  },
  {
    name: 'HN',
    url: 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10',
  },
];

function stripCdata(x) {
  const m = String(x || '').match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
  return m ? m[1].trim() : '';
}

function cleanTitle(t) {
  // Google News 标题常带 " - 来源" 后缀；来源单独展示
  return String(t || '').replace(/\s+-\s+[^-]{2,20}$/, '').trim();
}

async function fetchGoogleNews(signal) {
  const text = await fetchText(FEEDS[0].url, signal);
  const items = [...String(text).matchAll(/<item>[\s\S]*?<\/item>/g)].map((m) => m[0]);
  const out = [];
  for (const raw of items) {
    const title = cleanTitle(stripCdata(raw));
    const srcM = raw.match(/<source[^>]*>([\s\S]*?)<\/source>/);
    const source = srcM ? srcM[1].trim() : '';
    if (title) out.push({ title, source: source || '新闻' });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

async function fetchHN(signal) {
  const text = await fetchText(FEEDS[1].url, signal);
  const data = JSON.parse(text);
  return (data.hits || [])
    .filter((h) => h.title)
    .slice(0, MAX_ITEMS)
    .map((h) => ({ title: String(h.title).trim(), source: 'HackerNews' }));
}

// 延迟引入，避免循环依赖
function fetchText(url, options) {
  return require('./safe_fetch').fetchText(url, options);
}

/**
 * 抓取热门资讯。主源失败自动切备源；两源全挂返回 ok:false。
 * @param {{signal?:AbortSignal}} [options]
 * @returns {Promise<{ok:boolean, items?:Array<{title:string,source:string}>, reason?:string}>}
 */
async function fetchTopNews(options = {}) {
  let lastErr = null;
  for (const fetcher of [fetchGoogleNews, fetchHN]) {
    try {
      const items = await fetcher(options.signal);
      if (items.length > 0) return { ok: true, items };
      lastErr = new Error('源返回 0 条');
    } catch (err) {
      lastErr = err;
      log.warn(`源 ${fetcher === fetchGoogleNews ? FEEDS[0].name : FEEDS[1].name} 失败: ${err.message}`);
    }
  }
  return { ok: false, reason: lastErr ? lastErr.message : '所有新闻源均不可用' };
}

/** 生成 QQ 推送文本（不含 URL；~700 字内） */
function buildDigest(items, dateLabel) {
  const lines = [`📰 今日热点速览（${dateLabel}）`, '———————————'];
  items.forEach((it, i) => {
    const t = it.title.length > TITLE_MAX ? `${it.title.slice(0, TITLE_MAX)}…` : it.title;
    lines.push(`${i + 1}. ${t}（${it.source}）`);
  });
  lines.push('———————————');
  lines.push('💬 想深挖哪条？直接回复「详情 N」+ 序号，我来帮你检索。');
  return lines.join('\n');
}

/** 读取上次推送记录（标题去重 + 当日已发判断） */
async function getLastState() {
  const s = await store.get(LAST_KEY);
  return s && typeof s === 'object' ? s : { date: '', titles: [] };
}

async function saveLastState(state) {
  await store.put(LAST_KEY, state, 7 * 24 * 3600);
}

/**
 * 组装今日推送：抓取 → 去重（同标题不再推）→ 截取 MAX_ITEMS。
 * force=false 时，若今天已推过则返回 skip。
 */
async function prepareDigest(now = new Date(), force = false) {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const today = bj.toISOString().slice(0, 10);
  const dateLabel = `${bj.getUTCMonth() + 1}月${bj.getUTCDate()}日`;

  const last = await getLastState();
  if (!force && last.date === today) {
    return { ok: false, skip: true, reason: '今天已推送过' };
  }

  const r = await fetchTopNews();
  if (!r.ok) return r;

  const seen = new Set(last.date === today ? last.titles : []);
  const fresh = r.items.filter((it) => !seen.has(it.title));
  const picked = (fresh.length >= 3 ? fresh : r.items).slice(0, MAX_ITEMS);

  return {
    ok: true,
    dateLabel,
    today,
    items: picked,
    text: buildDigest(picked, dateLabel),
  };
}

/** 记录今日已推送（标题列表用于去重） */
async function markSent(today, items) {
  await saveLastState({ date: today, titles: items.map((it) => it.title) });
}

/**
 * 完整推送流程：准备摘要 → 经 QQ 主动消息通道发送 → 记录已发。
 * force=false 时当日已推过则跳过；手动触发传 force=true。
 */
async function sendHotNews(force = false) {
  const { config } = require('./config');
  if (!config.hotnews.enabled) return { ok: false, reason: '热点推送已禁用(HOTNEWS_ENABLED=0)' };
  if (!config.hotnews.openid) return { ok: false, reason: '未配置 MASTER_OPENID，无法推送' };

  const prep = await prepareDigest(new Date(), force);
  if (!prep.ok || prep.skip) return prep;

  const qqBot = require('./qq_bot');
  const res = await qqBot.pushProactive(config.hotnews.openid, false, prep.text);
  if (res && res.ok === false) {
    log.error('热点推送失败', res.reason);
    return { ok: false, reason: res.reason || '推送失败' };
  }
  await markSent(prep.today, prep.items);
  log.info('热点推送成功', { count: prep.items.length, id: res && res.id });
  return { ok: true, id: res && res.id, count: prep.items.length, text: prep.text };
}

module.exports = { fetchTopNews, buildDigest, prepareDigest, markSent, getLastState, sendHotNews };
