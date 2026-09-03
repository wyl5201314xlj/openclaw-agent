// lib/selftest.js
// 阶段 2-5：一键探活。上一轮审查中几乎每个故障都只能靠外部黑盒探测反推，
// 这里把"模型 / 检索 / 抓取 / 生图 / QQ 凭据 / 持久化 / 内存"全部做成可读报告。

const router = require('./model_router');
const searchTool = require('./tools/search_tool');
const readerTool = require('./tools/reader_tool');
const imageTool = require('./tools/image_tool');
const timerTool = require('./tools/timer_tool');
const store = require('./store');
const sessionStore = require('./session_store');
const agent = require('./agent_engine');
const qqBot = require('./qq_bot');
const { config } = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('SelfTest');

async function timed(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, ms: Date.now() - t0, detail };
  } catch (err) {
    return { name, ok: false, ms: Date.now() - t0, error: String(err.message).slice(0, 240) };
  }
}

/**
 * 逐项探活。
 * @param {{deep?:boolean}} [options] deep=true 时会真的跑一次生图（耗时约 45 秒）
 */
async function runSelfTest(options = {}) {
  const startedAt = Date.now();

  const checks = [];

  // 1. 模型通道：真发一次极短请求，验证链路与首字节延迟
  checks.push(
    await timed('model', async () => {
      const r = await router.chat([{ role: 'user', content: '回复两个字：正常' }], {
        maxTokens: 16,
        budgetMs: 20000,
      });
      return {
        target: `${r.provider}/${r.model}`,
        firstByteMs: r.firstByteMs,
        totalMs: r.latencyMs,
        streamed: r.streamed,
        content: r.content.slice(0, 20),
        failoversBefore: r.attempts.length,
      };
    })
  );

  // 2. 检索：逐源报告，这是判断"DDG 在当前部署环境能否用"的唯一手段
  checks.push(
    await timed('search-sources', async () => {
      const probe = await searchTool.probeSources('Node.js LTS');
      const usable = [...probe.web, ...probe.fallback].filter((s) => s.ok);
      if (usable.length === 0) throw new Error('所有检索源均不可用');
      return { web: probe.web, fallback: probe.fallback, usableCount: usable.length };
    })
  );

  // 3. 端到端检索（含融合排序与相关性过滤）
  checks.push(
    await timed('search-e2e', async () => {
      const r = await searchTool.searchWeb('Node.js 22 LTS 版本', { maxResults: 3, noCache: true });
      if (!r.ok) throw new Error(r.reason);
      return {
        count: r.results.length,
        elapsedMs: r.elapsedMs,
        top: r.results.slice(0, 3).map((x) => ({ source: x.source, title: x.title.slice(0, 60), url: x.url })),
      };
    })
  );

  // 4. 网页抓取
  checks.push(
    await timed('reader', async () => {
      const r = await readerTool.readUrlContent('https://nodejs.org/en/about/previous-releases', {
        noCache: true,
      });
      if (!r.ok) throw new Error(r.reason);
      return { via: r.via, chars: r.content.length };
    })
  );

  // 5. SSRF 边界：确认内网地址会被拒绝（安全回归）
  checks.push(
    await timed('ssrf-guard', async () => {
      const blocked = [];
      for (const bad of [
        'http://127.0.0.1:10000/health',
        'http://169.254.169.254/latest/meta-data/',
        'http://10.0.0.1/',
        'file:///etc/passwd',
      ]) {
        const r = await readerTool.readUrlContent(bad, { noCache: true });
        blocked.push({ url: bad, rejected: r.ok === false });
      }
      const leaks = blocked.filter((b) => !b.rejected);
      if (leaks.length > 0) throw new Error(`以下地址未被拦截: ${leaks.map((l) => l.url).join(', ')}`);
      return { checked: blocked.length, allRejected: true };
    })
  );

  // 6. 持久化
  checks.push(
    await timed('store', async () => {
      const health = await store.healthCheck();
      if (!health.ok) throw new Error(`${health.mode}: ${health.detail}`);
      return health;
    })
  );

  // 7. 生图（默认跳过，实测单次 44~47 秒）
  if (options.deep) {
    checks.push(
      await timed('image', async () => {
        const r = await imageTool.generateImage('a small red cube on white background');
        if (!r.ok) throw new Error(r.reason);
        return { via: r.via, elapsedMs: r.elapsedMs, hasUrl: Boolean(r.url), hasB64: Boolean(r.b64) };
      })
    );
  }

  // 8. QQ 凭据与连接状态（不发任何消息，避免消耗官方配额）
  checks.push(
    await timed('qq-credential', async () => {
      if (!config.qq.appId || !config.qq.appSecret) throw new Error('未配置 QQ_APP_ID / QQ_APP_SECRET');
      await qqBot.getAccessToken();
      return { appId: config.qq.appId, tokenReady: true, gateway: qqBot.snapshot() };
    })
  );

  // 9. 订阅 YAML 手机可导入性（3-5 的服务端等价验证）
  checks.push(
    await timed('sub-clash', async () => {
      const nodeStore = require('./node_store');
      const yaml = nodeStore.generateClashConfig();
      const doc = require('yaml').parse(yaml);
      const proxies = doc.proxies || [];
      if (proxies.length === 0) throw new Error('订阅无可用节点');
      const bad = proxies.filter((p) => {
        if (p.type === 'vmess') return !p.uuid || p.alterId === undefined || !p.cipher;
        if (p.type === 'vless') return !p.uuid || !p.server;
        if (p.type === 'trojan') return !p.password || !p.server;
        if (p.type === 'ss') return !p.password || !p.cipher;
        return false;
      });
      if (bad.length > 0) throw new Error(`${bad.length} 个节点缺必填字段: ${bad[0].name}`);
      const names = new Set(proxies.map((p) => p.name));
      const groupNames = new Set((doc['proxy-groups'] || []).map((g) => g.name));
      for (const g of doc['proxy-groups'] || []) {
        for (const n of g.proxies || []) {
          if (!names.has(n) && !groupNames.has(n) && !['DIRECT', 'REJECT'].includes(n)) {
            throw new Error(`分组引用缺失节点: ${n}`);
          }
        }
      }
      const rules = doc.rules || [];
      if (!rules.some((r) => String(r).includes('GEOIP'))) throw new Error('缺少 GEOIP 分流规则');
      if (!doc.dns) throw new Error('缺少 dns 段');
      return { proxies: proxies.length, rules: rules.length, dns: true };
    })
  );

  // 10. 节点池新鲜度与速度覆盖率（漂洗是否在正常工作）
  checks.push(
    await timed('pool-freshness', async () => {
      const nodeStore = require('./node_store');
      const stats = nodeStore.getSummaryStats();
      const ageMin = (Date.now() - nodeStore.lastUpdatedAt) / 60000;
      if (stats.total === 0) throw new Error('节点池为空');
      if (ageMin > 60) throw new Error(`节点池 ${Math.round(ageMin)} 分钟未刷新（应≤60 分钟）`);
      const withSpeed = nodeStore.activeNodes.filter((n) => Number(n.speedMbps) > 0).length;
      return {
        total: stats.total, residential: stats.residential,
        ageMin: Math.round(ageMin), withSpeed,
        maxSpeedMbps: stats.maxSpeedMbps,
      };
    })
  );

  const mem = process.memoryUsage();
  const failed = checks.filter((c) => !c.ok);
  const report = {
    ok: failed.length === 0,
    elapsedMs: Date.now() - startedAt,
    failedCount: failed.length,
    checks,
    runtime: {
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      rssMB: Number((mem.rss / 1048576).toFixed(1)),
      heapUsedMB: Number((mem.heapUsed / 1048576).toFixed(1)),
      externalMB: Number((mem.external / 1048576).toFixed(1)),
      memoryLimitMB: 512,
    },
    caches: {
      answer: agent.cacheStats(),
      search: searchTool.cache.stats(),
      reader: readerTool.cache.stats(),
      session: sessionStore.stats(),
    },
    timers: timerTool.snapshot(),
    modelChain: router.health(),
    image: imageTool.snapshot(),
  };

  log.info('自检完成', { ok: report.ok, failed: failed.map((f) => f.name), elapsedMs: report.elapsedMs });
  return report;
}

module.exports = { runSelfTest };
