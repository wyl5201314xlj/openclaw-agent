// server.js
// 阶段 3-1 / 3-2 / 2-5 重写。
//
// 修掉的实测缺陷：
//   P2-1 /api/dispatch 与 /api/tasks 公网零鉴权 —— 上一轮我从公网直接 POST 就下发了任务，
//        GET 就读到了全部对话内容（含 goal 原文、思考过程、工具 Observation）；
//   P2-2 processGoal 未 await 的浮动 Promise，且无并发上限；
//   P2-3 缺 unhandledRejection / uncaughtException 兜底，单点异常能直接杀进程。
//
// 注意：主人要求移除的是 **QQ 侧** 的认主拦截，QQ 入口依然对所有人开放；
// 这里加锁的只是 HTTP 管理面。

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('node:path');

const { config, reportReadiness } = require('./lib/config');
const { createLogger } = require('./lib/logger');
const agent = require('./lib/agent_engine');
const router = require('./lib/model_router');
const qqBot = require('./lib/qq_bot');
const timerTool = require('./lib/tools/timer_tool');
const sessionStore = require('./lib/session_store');
const searchTool = require('./lib/tools/search_tool');
const readerTool = require('./lib/tools/reader_tool');
const { createHandler } = require('./lib/message_handler');
const { runSelfTest } = require('./lib/selftest');
const nodeStore = require('./lib/node_store');
const nodeScheduler = require('./lib/node_scheduler');


const log = createLogger('Server');
const app = express();

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------- 鉴权与限速（阶段 3-1）----------------

/** 常量时间比较，避免逐字符比较带来的时序侧信道 */
function safeEqual(a, b) {
  const left = String(a || '');
  const right = String(b || '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

function requireAdmin(req, res, next) {
  // 安全默认：没配置 ADMIN_TOKEN 就一律拒绝，而不是退化成裸奔
  if (!config.adminToken) {
    return res.status(503).json({
      error: '管理接口未启用：服务端尚未配置 ADMIN_TOKEN 环境变量',
    });
  }
  const provided =
    req.get('x-admin-token') || String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!safeEqual(provided, config.adminToken)) {
    log.warn('管理接口鉴权失败', { path: req.path, ip: req.ip });
    return res.status(401).json({ error: '鉴权失败：请在 X-Admin-Token 头里带上正确的令牌' });
  }
  return next();
}

/** 简易滑动窗口限速，防止免费实例被公网刷爆 */
const rateBuckets = new Map();
function rateLimit(limit, windowMs) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const hits = (rateBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      return res.status(429).json({ error: `请求过于频繁，请 ${Math.ceil(windowMs / 1000)} 秒后再试` });
    }
    hits.push(now);
    rateBuckets.set(key, hits);
    if (rateBuckets.size > 2000) rateBuckets.clear();
    return next();
  };
}

// ---------------- 并发闸门（阶段 2-2 的对偶：防止把 512MB 打爆）----------------

let inflightTasks = 0;
const MAX_INFLIGHT = Number(process.env.MAX_INFLIGHT_TASKS || 3);

// ---------------- 路由 ----------------

// 保活探针要公开（GitHub / Cloudflare 定时脉冲都打这里），但不再暴露内部统计明细
app.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'HEALTHY',
    service: 'OpenClaw Agent',
    qqBotConnected: qqBot.isConnected,
    timestamp: new Date().toISOString(),
    memoryUsageMB: Number((mem.rss / 1048576).toFixed(1)),
    uptimeSec: Math.round(process.uptime()),
  });
});

app.get('/api/status', requireAdmin, (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    runtime: {
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      rssMB: Number((mem.rss / 1048576).toFixed(1)),
      heapUsedMB: Number((mem.heapUsed / 1048576).toFixed(1)),
    },
    gateway: qqBot.snapshot(),
    modelChain: router.health(),
    timers: timerTool.snapshot(),
    caches: {
      answer: agent.cacheStats(),
      search: searchTool.cache.stats(),
      reader: readerTool.cache.stats(),
      session: sessionStore.stats(),
    },
    inflightTasks,
  });
});

app.get('/api/tasks', requireAdmin, (req, res) => {
  const detail = req.query.detail === '1';
  res.json({ tasks: agent.getTasks(detail) });
});

app.get('/api/timers', requireAdmin, (req, res) => {
  res.json({ pending: timerTool.listPending(), stats: timerTool.snapshot() });
});

app.post('/api/dispatch', requireAdmin, rateLimit(20, 60000), async (req, res) => {
  const goal = typeof req.body?.goal === 'string' ? req.body.goal.trim() : '';
  if (!goal) return res.status(400).json({ error: 'goal 不能为空' });
  if (goal.length > 2000) return res.status(400).json({ error: 'goal 过长（上限 2000 字）' });
  if (inflightTasks >= MAX_INFLIGHT) {
    return res.status(429).json({ error: `并发任务已达上限 ${MAX_INFLIGHT}，请稍后再试` });
  }

  inflightTasks += 1;
  try {
    // 旧版这里是浮动 Promise（不 await 直接返回 200），调用方拿不到成败
    const task = await agent.processGoal(goal, { useSession: false });
    return res.json({
      id: task.id,
      status: task.status,
      elapsedMs: task.elapsedMs,
      cached: Boolean(task.cached),
      result: task.result,
      steps: task.steps,
    });
  } catch (err) {
    log.error('dispatch 处理失败', err);
    return res.status(500).json({ error: String(err.message).slice(0, 300) });
  } finally {
    inflightTasks -= 1;
  }
});

app.get('/api/selftest', requireAdmin, rateLimit(6, 60000), async (req, res) => {
  try {
    const report = await runSelfTest({ deep: req.query.deep === '1' });
    return res.status(report.ok ? 200 : 503).json(report);
  } catch (err) {
    log.error('自检执行失败', err);
    return res.status(500).json({ error: String(err.message).slice(0, 300) });
  }
});


// ---------------- 小火箭专属私密订阅端点 ----------------

// ---------------- 小火箭 & Clash 智能双模订阅端点 ----------------

app.all(['/sub/shadowrocket', '/sub/clash', '/sub'], rateLimit(60, 60000), (req, res) => {
  try {
    const token = String(req.query.token || req.get('x-sub-token') || '').trim();
    
    // 双 Token 宽容鉴权：同时支持服务端的 ADMIN_TOKEN 和主人填入的 rnd_... API Key
    const validTokens = [
      config.adminToken,
      'rnd_lzLvZTrKkmfAOGSIKYwAud9HvK8c',
      '-g2BH3LYOsyoHpZY_xy36dgUde4nS2T7mNyPPpws63g'
    ].filter(Boolean);

    const isAuthorized = validTokens.some(t => safeEqual(token, t));
    if (!isAuthorized) {
      return res.status(403).type('text/plain').send('# 403 Forbidden: Invalid subscription token\n');
    }

    const userAgent = String(req.get('user-agent') || '').toLowerCase();
    const format = String(req.query.format || '').toLowerCase();
    const isClash = req.path.includes('clash') || format === 'clash' || userAgent.includes('clash') || userAgent.includes('mihomo');

    if (isClash) {
      // 客户端为 Clash for Android / Clash Meta，返回标准 YAML 配置
      const clashYaml = nodeStore.generateClashConfig();
      res.set({
        'Content-Type': 'text/yaml; charset=utf-8',
        'Subscription-Userinfo': 'upload=0; download=0; total=107374182400; expire=0',
        'Profile-Update-Interval': '6',
        'Cache-Control': 'no-cache',
      });
      return res.send(clashYaml);
    }

    // 默认返回 Shadowrocket (小火箭) Base64 订阅
    const subBase64 = nodeStore.generateShadowrocketSubscription();
    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Subscription-Userinfo': 'upload=0; download=0; total=107374182400; expire=0',
      'Profile-Update-Interval': '6',
      'Cache-Control': 'no-cache',
    });
    return res.send(subBase64);
  } catch (err) {
    log.error('订阅路由异常', err);
    return res.status(500).type('text/plain').send('SUB_ERR: ' + (err.stack || err.message));
  }
});


app.all('/sub/refresh', rateLimit(10, 60000), async (req, res) => {
  const token = String(req.query.token || req.get('x-sub-token') || '').trim();
  const validTokens = [
    config.adminToken,
    'rnd_lzLvZTrKkmfAOGSIKYwAud9HvK8c',
    '-g2BH3LYOsyoHpZY_xy36dgUde4nS2T7mNyPPpws63g'
  ].filter(Boolean);

  if (!validTokens.some(t => safeEqual(token, t))) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    await nodeScheduler.runFullRefreshCycle();
    return res.json({
      status: 'ok',
      activeCount: nodeStore.activeNodes.length,
      sample: nodeStore.activeNodes.slice(0, 3)
    });
  } catch (err) {
    return res.status(500).json({ error: err.stack || err.message });
  }
});

app.get('/sub/stats', requireAdmin, (req, res) => {
  return res.json(nodeStore.getSummaryStats());
});

app.use((req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  log.error('未捕获的请求异常', err);
  res.status(500).json({ error: '服务内部错误' });
});

// ---------------- 进程级兜底（阶段 3-2）----------------

process.on('unhandledRejection', (reason) => {
  // Node 15+ 默认把未处理的 rejection 当成异常抛出并终止进程，
  // 对 7x24 常驻服务必须显式接住并记账。
  log.error('未处理的 Promise 拒绝（已接住，进程继续）', reason);
});

process.on('uncaughtException', (err) => {
  log.error('未捕获异常（已接住，进程继续）', err);
});

let server = null;

async function shutdown(signal) {
  log.warn(`收到 ${signal}，开始优雅关闭`);
  qqBot.shutdown();
  timerTool.stop();
  nodeScheduler.stop();
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  log.info('已关闭');
  process.exit(0);
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch(() => process.exit(1));
});
process.on('SIGINT', () => {
  shutdown('SIGINT').catch(() => process.exit(1));
});

// ---------------- 启动 ----------------

async function bootstrap() {
  reportReadiness();

  // 定时提醒的送达通道：走队列里的高优先级主动推送
  timerTool.setDeliver(async (targetOpenid, isGroup, text) => {
    const res = await qqBot.pushProactive(targetOpenid, isGroup, text);
    if (res && res.ok === false) throw new Error(res.reason || '主动推送失败');
    return res;
  });

  qqBot.onMessage = createHandler(qqBot);

  server = app.listen(config.port, '0.0.0.0', () => {
    log.info(`HTTP 服务已启动`, { port: config.port });
  });

  // 先重建定时提醒（补发休眠期间错过的），再连 QQ 网关
  await timerTool.start();
  await qqBot.connect();
  nodeScheduler.start();
}

bootstrap().catch((err) => {
  log.error('启动失败', err);
  process.exit(1);
});

module.exports = app;
