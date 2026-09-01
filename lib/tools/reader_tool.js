// lib/tools/reader_tool.js
// 网页正文抓取。相比旧版的改动：
//   1. URL 来自模型输出（不可信输入），必须先过 SSRF 边界校验，
//      否则可被诱导访问容器内网 / 云元数据 / 本机端口；
//   2. 结果加缓存（实测 Jina 单次 3.3s，重复读同一页面没必要再等）；
//   3. 失败返回显式结构而非把错误串当正文塞给模型；
//   4. Jina 失败时直连目标站兜底（同样过边界校验）。

const { config } = require('../config');
const { createLogger } = require('../logger');
const { fetchText, assertSafeUrl } = require('../safe_fetch');
const { LruTtlCache } = require('../cache');

const log = createLogger('ReaderTool');

const cache = new LruTtlCache({
  name: 'reader',
  maxEntries: config.cache.readerMax,
  ttlMs: config.cache.readerTtlMs,
  maxBytes: 24 * 1024 * 1024,
});

const MAX_CHARS = 6000;
const UA = 'OpenClaw-Agent/2.0 (+https://openclaw-agent-8i57.onrender.com)';

/** 把 HTML 粗略转成可读文本（仅用于 Jina 不可用时的兜底） */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 抓取并转译网页正文。
 * @param {string} targetUrl 模型给出的目标地址（不可信）
 * @param {{signal?:AbortSignal, noCache?:boolean}} [options]
 * @returns {Promise<{ok:boolean, url:string, content?:string, via?:string, reason?:string,
 *                    truncated?:boolean, elapsedMs:number, cached?:boolean}>}
 */
async function readUrlContent(targetUrl, options = {}) {
  const started = Date.now();
  const raw = String(targetUrl || '').trim();
  if (!raw) {
    return { ok: false, url: raw, reason: 'URL 为空', elapsedMs: 0 };
  }

  // 第一道闸：先校验模型给的地址本身是否安全，不安全直接拒绝，不发任何请求
  let normalized;
  try {
    normalized = (await assertSafeUrl(raw)).toString();
  } catch (err) {
    log.warn(`拒绝抓取不安全地址: ${raw.slice(0, 120)}`, err);
    return { ok: false, url: raw, reason: `地址未通过安全校验: ${err.message}`, elapsedMs: Date.now() - started };
  }

  if (!options.noCache) {
    const hit = cache.get(normalized);
    if (hit) return { ...hit, cached: true, elapsedMs: Date.now() - started };
  }

  const attempts = [];

  // 通道一：Jina Reader（云端渲染 + 正文抽取，质量最好，实测 3.3s）
  try {
    const text = await fetchText(`https://r.jina.ai/${normalized}`, {
      headers: { Accept: 'text/plain, text/markdown', 'User-Agent': UA },
      timeoutMs: config.timeouts.readerMs,
      signal: options.signal,
      allowHosts: ['r.jina.ai'],
    });
    if (text && text.trim().length > 80) {
      const truncated = text.length > MAX_CHARS;
      const payload = {
        ok: true,
        url: normalized,
        via: 'jina-reader',
        content: text.slice(0, MAX_CHARS),
        truncated,
      };
      cache.set(normalized, payload);
      log.info(`抓取成功 via jina-reader`, { url: normalized, chars: payload.content.length });
      return { ...payload, elapsedMs: Date.now() - started };
    }
    attempts.push('jina-reader: 返回内容过短');
  } catch (err) {
    attempts.push(`jina-reader: ${String(err.message).slice(0, 120)}`);
  }

  // 通道二：直连目标站（已过边界校验，重定向逐跳再校验）
  try {
    const html = await fetchText(normalized, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      },
      timeoutMs: config.timeouts.readerMs,
      signal: options.signal,
    });
    const text = htmlToText(html);
    if (text.length > 80) {
      const truncated = text.length > MAX_CHARS;
      const payload = {
        ok: true,
        url: normalized,
        via: 'direct',
        content: text.slice(0, MAX_CHARS),
        truncated,
      };
      cache.set(normalized, payload);
      log.info('抓取成功 via direct', { url: normalized, chars: payload.content.length });
      return { ...payload, elapsedMs: Date.now() - started };
    }
    attempts.push('direct: 正文过短');
  } catch (err) {
    attempts.push(`direct: ${String(err.message).slice(0, 120)}`);
  }

  const reason = `两条抓取通道均失败（${attempts.join('；')}）`;
  log.warn(`抓取失败: ${normalized}`, reason);
  return { ok: false, url: normalized, reason, elapsedMs: Date.now() - started };
}

/** 渲染成给模型看的文本，失败时明确禁止编造 */
function formatForModel(result) {
  if (!result.ok) {
    return `【网页抓取失败】${result.url}\n原因：${result.reason}\n禁止编造该网页内容，须如实告知用户抓取失败。`;
  }
  return (
    `【网页正文】${result.url}（来源通道 ${result.via}` +
    `${result.truncated ? '，内容已截断' : ''}）\n${result.content}`
  );
}

module.exports = { readUrlContent, formatForModel, cache, _internal: { htmlToText } };
