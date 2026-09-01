// lib/model_router.js
// 阶段 1-1 / 1-2 / 1-3 重写。
//
// 旧实现的三个问题（均有 2026-09-01 实测记录，见 docs/OPTIMIZATION_PLAN.md）：
//   1. axios timeout 写死 6000ms，与 options.timeoutMs 无关。实测同一负载耗时
//      2936ms~16582ms（同模型换 Key 波动 5.6 倍），6s 一刀切会把生成一半的长回答丢弃；
//   2. 配置的 12 个模型里，落樱 5 个全挂（403/503/524）、xkiro 2 个全挂（Cloudflare 1010），
//      所谓"三级立体容灾"实际只剩 Agnes 一家；
//   3. 死模型每次请求都要重试一遍，白烧 6 次往返。
//
// 新实现：
//   · 首字节超时（判"通道是否活"）与总体超时（判"能否写完"）分离，并启用 SSE 流式；
//   · 模型链按实测延迟重排，删掉所有 403/404/503/524/1010 的死模型，补进实测可用的新模型；
//   · 每个 provider:model 独立熔断，连续失败进入指数退避冷却，冷却期直接跳过。

const { config } = require('./config');
const { createLogger } = require('./logger');
const { safeFetch } = require('./safe_fetch');

const log = createLogger('ModelRouter');

/**
 * 模型链（tier 越小越优先）。latency 为 2026-09-01 实测"400 字中文长文本"耗时，
 * 仅作排序依据与回归对比基线，不参与运行时判断。
 */
function buildProviders() {
  const p = config.providers;
  const agnesHost = new URL(p.agnesBaseUrl).hostname;
  const luoyingHost = new URL(p.luoyingBaseUrl).hostname;
  const xkiroHost = new URL(p.xkiroBaseUrl).hostname;

  const list = [
    {
      name: 'agnes-key1',
      baseUrl: p.agnesBaseUrl,
      host: agnesHost,
      apiKey: p.agnesKey1,
      maxConcurrent: 3,
      models: [
        { id: 'agnes-2.5-flash', tier: 1, latency: 2936 },
        { id: 'agnes-2.5-pro', tier: 2, latency: 4655 },
        { id: 'agnes-2.5-pro-beta', tier: 2, latency: 5397 },
        { id: 'agnes-2.0-flash', tier: 3, latency: 13828 },
      ],
    },
    {
      name: 'agnes-key2',
      baseUrl: p.agnesBaseUrl,
      host: agnesHost,
      apiKey: p.agnesKey2,
      maxConcurrent: 3,
      models: [
        // Key2 的 pro 系实测「用户额度不足 ￥0」，只留 flash 系
        { id: 'agnes-2.0-flash', tier: 1, latency: 2383 },
        { id: 'agnes-2.5-flash', tier: 3, latency: 16582 },
      ],
    },
    {
      name: 'luoying',
      baseUrl: p.luoyingBaseUrl,
      host: luoyingHost,
      apiKey: p.luoyingKey,
      maxConcurrent: 2,
      models: [
        // 旧配置的 minimax-m3 / deepseek-v4 / qwen-3.8 / gpt-5.4 / deepseek-v4-flash-0731
        // 实测全部 403/503/524，已剔除；下面三个是实测可用但旧配置里没有的
        { id: 'gemini-3.6-flash', tier: 3, latency: 5997 },
        { id: 'deepseek-v4-flash-vision-exp', tier: 4, latency: 6193 },
        { id: 'dots3-note-prev', tier: 4, latency: 8140 },
      ],
    },
  ];

  if (p.xkiroEnabled) {
    // xkiro 实测整站 403 error code 1010（Cloudflare 拦截），默认不启用；
    // 主人后台恢复后设 XKIRO_ENABLED=1 即自动接回。
    list.push({
      name: 'xkiro',
      baseUrl: p.xkiroBaseUrl,
      host: xkiroHost,
      apiKey: p.xkiroKey,
      maxConcurrent: 2,
      models: [{ id: 'qwen/qwen3-vl-plus:free', tier: 5, latency: 3046 }],
    });
  }

  return list.filter((prov) => Boolean(prov.apiKey));
}

/** 单个 provider:model 的熔断状态 */
class Breaker {
  constructor() {
    this.failures = 0;
    this.openUntil = 0;
    this.lastError = null;
    this.successes = 0;
  }

  get isOpen() {
    return Date.now() < this.openUntil;
  }

  recordSuccess() {
    this.failures = 0;
    this.openUntil = 0;
    this.lastError = null;
    this.successes += 1;
  }

  recordFailure(error) {
    this.failures += 1;
    this.lastError = String(error && error.message ? error.message : error).slice(0, 200);
    if (this.failures >= config.breaker.failureThreshold) {
      const exponent = this.failures - config.breaker.failureThreshold;
      const cooldown = Math.min(
        config.breaker.baseCooldownMs * 2 ** exponent,
        config.breaker.maxCooldownMs
      );
      this.openUntil = Date.now() + cooldown;
      return cooldown;
    }
    return 0;
  }
}

/** 解析 OpenAI 兼容的 SSE 分片，抽出增量文本 */
function extractDelta(dataLine) {
  if (dataLine === '[DONE]') return null;
  try {
    const parsed = JSON.parse(dataLine);
    const choice = parsed.choices && parsed.choices[0];
    if (!choice) return '';
    return choice.delta?.content ?? choice.message?.content ?? choice.text ?? '';
  } catch {
    return '';
  }
}

class ModelRouter {
  constructor() {
    this.providers = buildProviders();
    this.breakers = new Map(); // "provider:model" -> Breaker
    this.stats = { totalRequests: 0, successes: 0, failures: 0, failovers: 0, streamFallbacks: 0 };
    // 按 tier 再按实测延迟展开成一条扁平的尝试顺序，避免运行时反复排序
    this.chain = this.providers
      .flatMap((prov) => prov.models.map((model) => ({ provider: prov, model })))
      .sort((a, b) => a.model.tier - b.model.tier || a.model.latency - b.model.latency);
    log.info('模型链已构建', {
      providers: this.providers.map((p) => p.name),
      chain: this.chain.map((c) => `${c.provider.name}/${c.model.id}`),
    });
  }

  breakerFor(providerName, modelId) {
    const key = `${providerName}:${modelId}`;
    if (!this.breakers.has(key)) this.breakers.set(key, new Breaker());
    return this.breakers.get(key);
  }

  /**
   * 向单个 provider/model 发一次流式请求。
   * 首字节超时只用来判"通道是否活"，总体超时用来判"能否写完"，两者分离是本次核心修复。
   */
  async callOne(provider, model, messages, options, deadlineSignal) {
    const url = `${provider.baseUrl}/chat/completions`;
    const body = {
      model: model.id,
      messages,
      temperature: options.temperature ?? 0.6,
      max_tokens: options.maxTokens ?? config.agent.tokens.normal,
      stream: options.stream !== false,
    };

    const started = Date.now();
    const resp = await safeFetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${provider.apiKey}`,
        'Content-Type': 'application/json',
        Accept: body.stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(body),
      // 响应头必须在首字节预算内到达，否则判定通道不活
      timeoutMs: options.firstByteMs ?? config.timeouts.firstByteMs,
      allowHosts: [provider.host],
      signal: deadlineSignal,
    });

    if (!resp.ok) {
      const text = await resp.text();
      const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 180)}`);
      err.status = resp.status;
      err.bodySnippet = text.slice(0, 400);
      throw err;
    }

    // 非流式：直接整体解析
    if (!body.stream) {
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content ?? '';
      if (!content) throw new Error('响应中没有可用内容');
      return { content, firstByteMs: Date.now() - started, streamed: false };
    }

    // 流式：逐块累积；总体超时由 deadlineSignal 统一掐断
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let firstByteAt = 0;

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!firstByteAt) firstByteAt = Date.now();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          const delta = extractDelta(payload);
          if (delta === null) {
            buffer = '';
            return {
              content,
              firstByteMs: (firstByteAt || Date.now()) - started,
              streamed: true,
            };
          }
          content += delta;
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* 已释放则忽略 */
      }
    }

    if (!content) throw new Error('流式响应未产出任何内容');
    return { content, firstByteMs: (firstByteAt || Date.now()) - started, streamed: true };
  }

  /**
   * 按模型链依次尝试，直到拿到结果或总预算耗尽。
   * @param {Array<{role:string,content:string}>} messages
   * @param {{maxTokens?:number, temperature?:number, budgetMs?:number,
   *          totalMs?:number, firstByteMs?:number, stream?:boolean}} [options]
   */
  async chat(messages, options = {}) {
    this.stats.totalRequests += 1;
    const startedAt = Date.now();
    const budgetMs = options.budgetMs ?? config.timeouts.budgetMs;
    const perCallTotalMs = options.totalMs ?? config.timeouts.totalMs;
    const attempts = [];
    let lastError = null;

    if (this.chain.length === 0) {
      throw new Error('没有任何可用模型通道：请检查 AGNES_API_KEY / LUOYING_API_KEY 是否已配置');
    }

    for (const link of this.chain) {
      const { provider, model } = link;
      const remaining = budgetMs - (Date.now() - startedAt);
      // 剩余预算连一次首字节都不够，就别再开新请求了
      if (remaining <= (options.firstByteMs ?? config.timeouts.firstByteMs)) {
        attempts.push({ target: `${provider.name}/${model.id}`, skipped: '总预算已耗尽' });
        break;
      }

      const breaker = this.breakerFor(provider.name, model.id);
      if (breaker.isOpen) {
        attempts.push({
          target: `${provider.name}/${model.id}`,
          skipped: `熔断冷却中（${Math.ceil((breaker.openUntil - Date.now()) / 1000)}s）`,
        });
        continue;
      }

      // 单次调用的总时长受"剩余预算"与"单次总体超时"双重约束
      const callBudget = Math.min(perCallTotalMs, remaining);
      const deadline = AbortSignal.timeout(callBudget);
      const t0 = Date.now();
      let useStream = options.stream !== false;

      for (let pass = 0; pass < 2; pass += 1) {
        try {
          const result = await this.callOne(
            provider,
            model,
            messages,
            { ...options, stream: useStream },
            deadline
          );
          breaker.recordSuccess();
          this.stats.successes += 1;
          const elapsed = Date.now() - startedAt;
          log.info('模型调用成功', {
            target: `${provider.name}/${model.id}`,
            firstByteMs: result.firstByteMs,
            totalMs: Date.now() - t0,
            chars: result.content.length,
            streamed: result.streamed,
            attemptsBefore: attempts.length,
          });
          return {
            content: result.content,
            model: model.id,
            provider: provider.name,
            firstByteMs: result.firstByteMs,
            latencyMs: elapsed,
            streamed: result.streamed,
            attempts,
          };
        } catch (err) {
          // 某些中转不支持 stream:true，用非流式再试一次同一个模型
          const streamUnsupported =
            useStream &&
            pass === 0 &&
            (err.status === 400 || err.status === 422) &&
            /stream/i.test(String(err.bodySnippet || err.message));
          if (streamUnsupported) {
            useStream = false;
            this.stats.streamFallbacks += 1;
            log.warn(`${provider.name}/${model.id} 不支持流式，改用非流式重试`);
            continue;
          }
          const cooldown = breaker.recordFailure(err);
          this.stats.failures += 1;
          this.stats.failovers += 1;
          lastError = err;
          attempts.push({
            target: `${provider.name}/${model.id}`,
            ms: Date.now() - t0,
            error: String(err.message).slice(0, 160),
            cooldownMs: cooldown || undefined,
          });
          log.warn(`模型调用失败，顺位切换: ${provider.name}/${model.id}`, {
            error: String(err.message).slice(0, 200),
            cooldownMs: cooldown || undefined,
          });
          break;
        }
      }
    }

    const summary = attempts
      .map((a) => `${a.target}${a.skipped ? `(跳过:${a.skipped})` : `(${a.error})`}`)
      .join(' → ');
    const error = new Error(
      `全部模型通道均未成功（用时 ${Date.now() - startedAt}ms）：${summary || '无可用通道'}`
    );
    error.attempts = attempts;
    error.lastError = lastError;
    throw error;
  }

  /** 兼容旧调用点的别名 */
  async executeWithFailover(messages, options = {}) {
    const mapped = {
      ...options,
      maxTokens: options.max_tokens ?? options.maxTokens,
      budgetMs: options.timeoutMs ?? options.budgetMs,
    };
    return this.chat(messages, mapped);
  }

  /** 供 /api/selftest 使用：报告每个通道的熔断状态 */
  health() {
    return {
      chain: this.chain.map((link) => {
        const b = this.breakerFor(link.provider.name, link.model.id);
        return {
          target: `${link.provider.name}/${link.model.id}`,
          tier: link.model.tier,
          baselineMs: link.model.latency,
          open: b.isOpen,
          openForMs: b.isOpen ? b.openUntil - Date.now() : 0,
          failures: b.failures,
          successes: b.successes,
          lastError: b.lastError,
        };
      }),
      stats: this.stats,
    };
  }
}

module.exports = new ModelRouter();


