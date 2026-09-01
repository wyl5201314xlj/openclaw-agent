// lib/tools/image_tool.js
// 阶段 1-4 重写。
//
// 实测依据（2026-09-01）：`agnes-image-2.1-flash` 两把 Key 都能成功出图，
// 但真实耗时 **KEY1 44028ms / KEY2 46884ms**，而旧代码 timeout 只有 45000ms
// —— 约一半请求会在即将成功时被掐断，再换 Key 又等 45s，最坏 90s 后误报"通道不可用"。
// 另外旧代码只在返回 url 时才发给用户，返回 b64_json 时只回一句"渲染完成"，什么都没给。

const { config } = require('../config');
const { createLogger } = require('../logger');
const { safeFetch, fetchJson } = require('../safe_fetch');

const log = createLogger('ImageTool');

const IMAGE_MODEL = process.env.AGNES_IMAGE_MODEL || 'agnes-image-2.1-flash';
const MAX_BYTES = 8 * 1024 * 1024; // 单张图上限，避免 512MB 容器被大图打爆

class ImageTool {
  constructor() {
    const base = config.providers.agnesBaseUrl;
    this.host = new URL(base).hostname;
    this.endpoint = `${base}/images/generations`;
    this.accounts = [
      { name: 'agnes-key1', apiKey: config.providers.agnesKey1 },
      { name: 'agnes-key2', apiKey: config.providers.agnesKey2 },
    ].filter((a) => Boolean(a.apiKey));
    this.cursor = 0;
    this.stats = { requests: 0, successes: 0, failures: 0 };
  }

  /**
   * 生成图片。永不静默失败：失败返回 {ok:false, reason}。
   * @param {string} prompt
   * @param {{size?:string, signal?:AbortSignal}} [options]
   */
  async generateImage(prompt, options = {}) {
    const text = String(prompt || '').trim();
    if (!text) return { ok: false, reason: '绘图提示词为空' };
    if (this.accounts.length === 0) {
      return { ok: false, reason: '未配置 AGNES_API_KEY / AGNES_API_KEY_2，无法生图' };
    }

    this.stats.requests += 1;
    const started = Date.now();
    const attempts = [];

    for (let i = 0; i < this.accounts.length; i += 1) {
      const idx = (this.cursor + i) % this.accounts.length;
      const account = this.accounts[idx];
      const t0 = Date.now();
      try {
        log.info(`调用 ${account.name} 生成图片`, { prompt: text.slice(0, 80) });
        const data = await fetchJson(this.endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${account.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: IMAGE_MODEL,
            prompt: text,
            n: 1,
            size: options.size || '1024x1024',
          }),
          // 实测 44~47s，给到 90s 才不会在临成功时被掐断
          timeoutMs: config.timeouts.imageMs,
          allowHosts: [this.host],
          signal: options.signal,
        });

        const first = data?.data?.[0];
        const url = first?.url || '';
        const b64 = first?.b64_json || '';
        if (!url && !b64) throw new Error('接口未返回 url 也未返回 b64_json');

        this.cursor = (idx + 1) % this.accounts.length;
        this.stats.successes += 1;
        const result = {
          ok: true,
          prompt: text,
          url,
          b64: b64 || '',
          hasBinary: Boolean(b64),
          via: account.name,
          model: IMAGE_MODEL,
          elapsedMs: Date.now() - started,
          attempts,
        };
        log.info('生图成功', { via: account.name, ms: result.elapsedMs, hasUrl: Boolean(url) });
        return result;
      } catch (err) {
        attempts.push({ account: account.name, ms: Date.now() - t0, error: String(err.message).slice(0, 160) });
        log.warn(`${account.name} 生图失败，尝试下一账号`, err);
      }
    }

    this.stats.failures += 1;
    return {
      ok: false,
      reason: `全部生图账号均失败（${attempts.map((a) => `${a.account}: ${a.error}`).join('；')}）`,
      attempts,
      elapsedMs: Date.now() - started,
    };
  }

  /**
   * 把图片下载成 Buffer，供 QQ 富媒体上传的 base64 兜底路径使用。
   * 目标地址来自生图接口返回（可信度有限），仍走 safeFetch 的 SSRF 边界校验。
   */
  async fetchBytes(url) {
    const resp = await safeFetch(url, {
      method: 'GET',
      headers: { Accept: 'image/*' },
      timeoutMs: 30000,
    });
    if (!resp.ok) throw new Error(`下载图片失败 HTTP ${resp.status}`);
    const declared = Number(resp.headers.get('content-length') || 0);
    if (declared && declared > MAX_BYTES) {
      throw new Error(`图片体积 ${declared} 字节超过上限 ${MAX_BYTES}`);
    }
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`图片体积 ${buf.length} 字节超过上限`);
    return { buffer: buf, mime: resp.headers.get('content-type') || 'image/png' };
  }

  snapshot() {
    return { ...this.stats, accounts: this.accounts.map((a) => a.name), model: IMAGE_MODEL };
  }
}

module.exports = new ImageTool();
