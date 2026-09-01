// lib/safe_fetch.js
// 统一出网层：原生 fetch + 首字节超时 + SSRF 边界校验。
//
// 为什么必须有边界校验：`read` 工具的 URL 来自模型输出（等价于不可信输入），
// 若不校验就可能被诱导去访问容器内网、云元数据服务或本机端口。
// 规则：只允许 http/https；解析目标主机 IP，拒绝环回/私有/链路本地/保留地址；
// 重定向手动跟随并对每一跳重新校验，防 DNS rebinding 与跳转绕过。

const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_REDIRECTS = 3;

/** 判断一个 IP 字面量是否属于禁止访问的内网/保留网段 */
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;              // 本网络 / 私有 A / 环回
    if (a === 169 && b === 254) return true;                         // 链路本地（含云元数据 169.254.169.254）
    if (a === 172 && b >= 16 && b <= 31) return true;                // 私有 B
    if (a === 192 && b === 168) return true;                         // 私有 C
    if (a === 100 && b >= 64 && b <= 127) return true;               // 运营商级 NAT
    if (a === 192 && b === 0) return true;                            // IETF 保留
    if (a >= 224) return true;                                        // 组播 / 保留
    return false;
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase();
    if (low === '::' || low === '::1') return true;                   // 未指定 / 环回
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('ff')) return true;                            // 组播
    // IPv4-mapped（::ffff:10.0.0.1）需回落到 IPv4 规则判断
    const mapped = low.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    return false;
  }
  return true; // 解析不出来的一律拒绝
}

/**
 * 校验一个 URL 是否可以安全地由服务端发起请求。
 * @param {string} rawUrl 待校验 URL
 * @param {{allowHosts?: string[]}} [opts] 传 allowHosts 时改为严格白名单模式（用于我们自己的 API 域名）
 */
async function assertSafeUrl(rawUrl, opts = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`URL 格式非法: ${String(rawUrl).slice(0, 120)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`只允许 http/https 协议，实际为 ${url.protocol}`);
  }
  if (Array.isArray(opts.allowHosts) && opts.allowHosts.length > 0) {
    if (!opts.allowHosts.includes(url.hostname)) {
      throw new Error(`主机不在白名单内: ${url.hostname}`);
    }
  }
  const host = url.hostname;
  // 主机本身就是 IP 字面量时直接判定
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new Error(`拒绝访问内网/保留地址: ${host}`);
    return url;
  }
  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`域名解析失败 (${host}): ${err.message}`);
  }
  if (!records.length) throw new Error(`域名无解析记录: ${host}`);
  for (const rec of records) {
    if (isBlockedIp(rec.address)) {
      throw new Error(`域名 ${host} 解析到内网/保留地址，已阻断`);
    }
  }
  return url;
}

/**
 * 安全 fetch：手动跟随重定向并逐跳校验；用 AbortSignal 控制首字节超时。
 * @param {string} rawUrl
 * @param {{method?:string, headers?:object, body?:any, timeoutMs?:number,
 *          allowHosts?:string[], signal?:AbortSignal}} options
 */
async function safeFetch(rawUrl, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15000;
  let target = rawUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(target, { allowHosts: options.allowHosts });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`首字节超时 ${timeoutMs}ms`)), timeoutMs);
    // 外部传入的 signal（例如总预算耗尽）也要能取消本次请求
    const onAbort = () => controller.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) {
        clearTimeout(timer);
        throw new Error('请求在发起前已被取消');
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    let resp;
    try {
      resp = await fetch(target, {
        method: options.method || 'GET',
        headers: options.headers,
        body: options.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) return resp;
      target = new URL(location, target).toString();
      continue; // 下一跳重新校验
    }
    return resp;
  }
  throw new Error(`重定向次数超过 ${MAX_REDIRECTS} 次，已中止`);
}

/** 读取 JSON 响应；非 2xx 时抛出带状态码与响应片段的错误，便于线上定位 */
async function fetchJson(rawUrl, options = {}) {
  const resp = await safeFetch(rawUrl, options);
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    err.bodySnippet = text.slice(0, 500);
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON: ${text.slice(0, 200)}`);
  }
}

/** 读取纯文本响应 */
async function fetchText(rawUrl, options = {}) {
  const resp = await safeFetch(rawUrl, options);
  const text = await resp.text();
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    err.status = resp.status;
    throw err;
  }
  return text;
}

module.exports = { assertSafeUrl, safeFetch, fetchJson, fetchText, isBlockedIp };
