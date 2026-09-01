// lib/config.js
// 集中配置：所有凭据与可调参数只从环境变量读取，源码内不出现任何凭据字面量。
// 常量取值全部来自 docs/OPTIMIZATION_PLAN.md 中的实测数据，不靠猜。

const { createLogger } = require('./logger');

const log = createLogger('Config');

function num(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

const config = {
  port: num('PORT', 10000),
  nodeEnv: process.env.NODE_ENV || 'development',

  // ===== HTTP 管理面鉴权（阶段 3-1）=====
  // 未设置时管理接口一律拒绝，避免"忘记配置就等于裸奔"
  adminToken: process.env.ADMIN_TOKEN || '',

  // ===== 模型通道（阶段 1-2：仅保留 2026-09-01 实测可用的模型）=====
  providers: {
    agnesBaseUrl: process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1',
    agnesKey1: process.env.AGNES_API_KEY || '',
    agnesKey2: process.env.AGNES_API_KEY_2 || '',
    luoyingBaseUrl: process.env.LUOYING_BASE_URL || 'https://apiserver.luoying.work/v1',
    luoyingKey: process.env.LUOYING_API_KEY || '',
    xkiroBaseUrl: process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1',
    xkiroKey: process.env.XKIRO_API_KEY || '',
    // xkiro 实测整站 403 error code 1010（Cloudflare 拦截），默认关闭，探活通过可由环境变量开启
    xkiroEnabled: process.env.XKIRO_ENABLED === '1',
  },

  // ===== 超时预算（阶段 1-1：首字节判活，总体判完）=====
  timeouts: {
    firstByteMs: num('MODEL_FIRST_BYTE_MS', 5000),   // 实测最快通道 264ms，5s 足够判活
    totalMs: num('MODEL_TOTAL_MS', 30000),           // 实测长文本最慢 16.6s，30s 留余量
    budgetMs: num('MODEL_BUDGET_MS', 45000),         // 一次请求跨所有通道的总预算
    imageMs: num('IMAGE_TIMEOUT_MS', 90000),         // 实测生图 44~47s，45s 太紧
    searchMs: num('SEARCH_TIMEOUT_MS', 6000),        // 单个搜索源超时
    readerMs: num('READER_TIMEOUT_MS', 15000),       // 实测 Jina 3.3s
    qqApiMs: num('QQ_API_TIMEOUT_MS', 10000),
  },

  // ===== 熔断器（阶段 1-3）=====
  breaker: {
    failureThreshold: num('BREAKER_FAILURES', 2),    // 连续失败 2 次进入冷却
    baseCooldownMs: num('BREAKER_COOLDOWN_MS', 60000),
    maxCooldownMs: num('BREAKER_MAX_COOLDOWN_MS', 900000),
  },

  // ===== ReAct 闭环（阶段 0-5）=====
  agent: {
    maxToolRounds: num('AGENT_MAX_ROUNDS', 3),
    maxTaskRecords: num('AGENT_MAX_TASKS', 40),
    tokens: { short: 512, normal: 1024, deep: 2048 }, // 阶段 2-4 token 预算分级
  },

  // ===== 缓存（阶段 2-2：把 512MB 里闲置的余量花掉，实测基线 RSS 仅 73MB）=====
  cache: {
    answerTtlMs: num('CACHE_ANSWER_TTL_MS', 5 * 60 * 1000),
    searchTtlMs: num('CACHE_SEARCH_TTL_MS', 10 * 60 * 1000),
    readerTtlMs: num('CACHE_READER_TTL_MS', 60 * 60 * 1000),
    answerMax: num('CACHE_ANSWER_MAX', 200),
    searchMax: num('CACHE_SEARCH_MAX', 300),
    readerMax: num('CACHE_READER_MAX', 120),
  },

  // ===== 会话记忆（阶段 2-1）=====
  session: {
    maxTurns: num('SESSION_MAX_TURNS', 6),
    ttlMs: num('SESSION_TTL_MS', 30 * 60 * 1000),
    maxSessions: num('SESSION_MAX', 300),
  },

  // ===== QQ 官方限频（数值来自官方文档，不可随意上调）=====
  qq: {
    appId: process.env.QQ_APP_ID || '',
    appSecret: process.env.QQ_APP_SECRET || '',
    // 官方：单聊被动回复有效期 60 分钟、每条消息可回 4 次；群聊 5 分钟、5 次
    c2cReplyWindowMs: 60 * 60 * 1000,
    c2cReplyQuota: 4,
    groupReplyWindowMs: 5 * 60 * 1000,
    groupReplyQuota: 5,
    // 官方未认证机器人：单聊主动 5/qps 且 20~30/qpm，群 30/qpm → 取保守的 20/分钟
    sendPerMinute: num('QQ_SEND_PER_MINUTE', 20),
    sendMinIntervalMs: num('QQ_SEND_MIN_INTERVAL_MS', 350),
    queueMax: num('QQ_QUEUE_MAX', 200),
    reconnectBaseMs: num('QQ_RECONNECT_BASE_MS', 1000),
    reconnectMaxMs: num('QQ_RECONNECT_MAX_MS', 60000),
  },

  // ===== 持久化（阶段 0-7：定时器不能再纯内存）=====
  store: {
    // 后端一：Cloudflare KV（延迟最低，但需要一枚带 Workers KV Storage:Edit 权限的 Token；
    // 实测主人现有的 cloudflare api_token 是只读的，配齐这三项即自动启用）
    cfAccountId: process.env.CF_ACCOUNT_ID || '',
    cfKvNamespaceId: process.env.CF_KV_NAMESPACE_ID || '',
    cfApiToken: process.env.CF_API_TOKEN || '',
    // 后端二：GitHub 私有仓库当键值存储（现有 PAT 实测可用，今天就能落地）
    ghToken: process.env.GH_STATE_TOKEN || '',
    ghRepo: process.env.GH_STATE_REPO || '',
    ghDir: process.env.GH_STATE_DIR || 'state',
  },
};

/** 启动时打印配置就绪度（只报键名与是否配置，绝不打印值） */
function reportReadiness() {
  const checks = {
    ADMIN_TOKEN: Boolean(config.adminToken),
    QQ_APP_ID: Boolean(config.qq.appId),
    QQ_APP_SECRET: Boolean(config.qq.appSecret),
    AGNES_API_KEY: Boolean(config.providers.agnesKey1),
    AGNES_API_KEY_2: Boolean(config.providers.agnesKey2),
    LUOYING_API_KEY: Boolean(config.providers.luoyingKey),
    XKIRO_API_KEY: Boolean(config.providers.xkiroKey),
    CF_KV_PERSIST: Boolean(
      config.store.cfAccountId && config.store.cfKvNamespaceId && config.store.cfApiToken
    ),
    GH_STATE_PERSIST: Boolean(config.store.ghToken && config.store.ghRepo),
  };
  log.info('配置就绪度（仅键名，不含取值）', checks);
  if (!checks.ADMIN_TOKEN) {
    log.warn('未配置 ADMIN_TOKEN：/api/dispatch 等管理接口将全部拒绝访问（安全默认）');
  }
  if (!checks.CF_KV_PERSIST && !checks.GH_STATE_PERSIST) {
    log.warn('未配置任何持久化后端：定时提醒降级为进程内存，重启/休眠会丢失');
  }
  return checks;
}

module.exports = { config, reportReadiness };
