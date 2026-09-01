// lib/qq_bot.js
// 阶段 0-1 / 0-2 / 2-3 / 3-3 / 3-4 重写。
//
// 修掉的实测缺陷（详见 docs/OPTIMIZATION_PLAN.md）：
//   P0-1 被动回复缺 msg_seq —— 官方规定"相同 msg_id + msg_seq 重复发送会失败"，
//        旧代码每条消息要回 2~3 条却都不带 msg_seq，第 2、3 条必然被服务端拒收，
//        且 catch(err){} 把错误全吞，导致用户只收到"正在启动"，永远收不到答案；
//   P2-4 重连无退避、无 Resume、无并发保护，sessionId/lastSeq 存了从不用；
//   P2-3 心跳 setInterval 里 ws.send 同步抛异常会直接 uncaughtException 杀进程；
//   P2-5 六处空 catch 吞掉全部异常；
//   P2-10 发信队列无界、无优先级、250ms 固定间隔击穿官方分钟级配额；
//   P1-4 生图只发外链（未报备域名会被拦），没走官方富媒体通道。

const WebSocket = require('ws');
const { config } = require('./config');
const { createLogger } = require('./logger');
const { fetchJson } = require('./safe_fetch');

const log = createLogger('QQ-Bot');

const TOKEN_HOST = 'bots.qq.com';
const API_HOST = 'api.sgroup.qq.com';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const GATEWAY_URL = 'https://api.sgroup.qq.com/gateway';

// 官方 intents：1<<25 = QQ 群与 C2C 事件，1<<30 = 频道公开消息。
// 旧代码还带了 1<<1（GUILD_MEMBERS，特权 intent 且本项目用不到），已去掉。
const INTENTS = (1 << 25) | (1 << 30);

const OP = { DISPATCH: 0, HEARTBEAT: 1, IDENTIFY: 2, RESUME: 6, RECONNECT: 7, INVALID_SESSION: 9, HELLO: 10, HEARTBEAT_ACK: 11 };

/** 令牌桶：把发信速率约束在官方 qpm 之内（阶段 3-4） */
class TokenBucket {
  constructor(capacity, refillPerMinute) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerMinute / 60000;
    this.lastRefill = Date.now();
  }

  refill() {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.lastRefill) * this.refillPerMs);
    this.lastRefill = now;
  }

  /** 返回需要等待的毫秒数；0 表示可以立刻发 */
  waitMs() {
    this.refill();
    if (this.tokens >= 1) return 0;
    return Math.ceil((1 - this.tokens) / this.refillPerMs);
  }

  consume() {
    this.refill();
    this.tokens = Math.max(0, this.tokens - 1);
  }
}

/**
 * 被动回复配额账本（阶段 0-1 的核心）。
 * 官方规则：单聊 60 分钟内每条 msg_id 可回 4 次；群聊 5 分钟内 5 次；
 * 且相同 msg_id + msg_seq 重复发送会失败，必须递增 msg_seq。
 */
class ReplyLedger {
  constructor(maxEntries = 500) {
    this.entries = new Map(); // msgId -> {seq, firstAt, windowMs, quota}
    this.maxEntries = maxEntries;
  }

  /** 申请下一个 msg_seq；返回 null 表示该 msg_id 已用尽配额或已过有效期 */
  next(msgId, isGroup) {
    if (!msgId) return null;
    const quota = isGroup ? config.qq.groupReplyQuota : config.qq.c2cReplyQuota;
    const windowMs = isGroup ? config.qq.groupReplyWindowMs : config.qq.c2cReplyWindowMs;
    const now = Date.now();
    let entry = this.entries.get(msgId);
    if (!entry || now - entry.firstAt > windowMs) {
      entry = { seq: 0, firstAt: now, windowMs, quota };
      this.entries.set(msgId, entry);
    }
    if (entry.seq >= quota) return null;
    entry.seq += 1;
    // 顺手清理最早的条目，避免账本无界增长
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return entry.seq;
  }

  remaining(msgId, isGroup) {
    const quota = isGroup ? config.qq.groupReplyQuota : config.qq.c2cReplyQuota;
    const windowMs = isGroup ? config.qq.groupReplyWindowMs : config.qq.c2cReplyWindowMs;
    const entry = this.entries.get(msgId);
    if (!entry || Date.now() - entry.firstAt > windowMs) return quota;
    return Math.max(0, quota - entry.seq);
  }
}

class QQBotGateway {
  constructor() {
    this.appId = config.qq.appId;
    this.appSecret = config.qq.appSecret;

    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.tokenInflight = null; // 单飞：并发调用只发一次刷新请求

    this.ws = null;
    this.heartbeatTimer = null;
    this.sessionId = '';
    this.lastSeq = 0;
    this.isConnected = false;
    this.isConnecting = false;
    this.shouldRun = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.lastAckAt = 0;

    this.queue = []; // 有界优先队列
    this.draining = false;
    this.bucket = new TokenBucket(5, config.qq.sendPerMinute);
    this.ledger = new ReplyLedger();
    this.onMessage = null; // 由 server.js 注入的业务处理器

    this.stats = {
      received: 0,
      sent: 0,
      sendFailed: 0,
      queueDropped: 0,
      quotaExhausted: 0,
      reconnects: 0,
      resumes: 0,
      mediaUploaded: 0,
    };
  }

  // ---------------- 凭据 ----------------

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) return this.accessToken;
    if (this.tokenInflight) return this.tokenInflight;

    this.tokenInflight = (async () => {
      try {
        const data = await fetchJson(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
          timeoutMs: config.timeouts.qqApiMs,
          allowHosts: [TOKEN_HOST],
        });
        if (!data.access_token) throw new Error(`返回中没有 access_token: ${JSON.stringify(data).slice(0, 160)}`);
        this.accessToken = data.access_token;
        this.tokenExpiresAt = Date.now() + Number(data.expires_in || 7200) * 1000;
        log.info('AccessToken 已刷新', { expiresInSec: Number(data.expires_in || 7200) });
        return this.accessToken;
      } finally {
        this.tokenInflight = null;
      }
    })();
    return this.tokenInflight;
  }

  authHeader(token) {
    return { Authorization: `QQBot ${token}`, 'Content-Type': 'application/json' };
  }

  // ---------------- 连接与重连 ----------------

  async getGatewayUrl() {
    const token = await this.getAccessToken();
    const data = await fetchJson(GATEWAY_URL, {
      headers: this.authHeader(token),
      timeoutMs: config.timeouts.qqApiMs,
      allowHosts: [API_HOST],
    });
    if (!data.url) throw new Error('gateway 接口未返回 url');
    return data.url;
  }

  async connect() {
    if (!this.appId || !this.appSecret) {
      log.warn('未配置 QQ_APP_ID / QQ_APP_SECRET，跳过 QQ 网关连接');
      return;
    }
    this.shouldRun = true;
    // 并发保护：旧版没有这个守卫，重入会出现两个 socket 同时收消息 → 重复回复
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      log.debug('已有连接或正在连接中，忽略重复 connect');
      return;
    }
    this.isConnecting = true;

    try {
      const gatewayUrl = await this.getGatewayUrl();
      const ws = new WebSocket(gatewayUrl, { handshakeTimeout: 15000 });
      this.ws = ws;

      ws.on('open', () => log.info('WebSocket 已建立，等待 Hello'));
      ws.on('message', (raw) => {
        this.handleRaw(raw).catch((err) => log.error('处理网关消息异常', err));
      });
      ws.on('close', (code, reason) => {
        const wasConnected = this.isConnected;
        this.teardown();
        log.warn('WebSocket 已关闭', { code, reason: String(reason || '').slice(0, 120), wasConnected });
        this.scheduleReconnect();
      });
      ws.on('error', (err) => {
        // ws 的 error 之后一定会有 close，这里只记账不重连，避免双触发
        log.error('WebSocket 错误', err);
      });
      ws.on('pong', () => {
        this.lastAckAt = Date.now();
      });
    } catch (err) {
      log.error('建立网关连接失败', err);
      this.scheduleReconnect();
    } finally {
      this.isConnecting = false;
    }
  }

  /** 指数退避 + 抖动：旧版固定 3s/5s，网关故障时高频重连容易被腾讯限频 */
  scheduleReconnect() {
    if (!this.shouldRun) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    this.stats.reconnects += 1;
    const base = Math.min(
      config.qq.reconnectBaseMs * 2 ** Math.min(this.reconnectAttempts - 1, 6),
      config.qq.reconnectMaxMs
    );
    const jitter = Math.floor(base * 0.25 * Math.random());
    const delay = base + jitter;
    log.info(`将在 ${delay}ms 后重连（第 ${this.reconnectAttempts} 次）`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => log.error('重连失败', err));
    }, delay);
    if (typeof this.reconnectTimer.unref === 'function') this.reconnectTimer.unref();
  }

  teardown() {
    this.isConnected = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      // 显式摘掉监听并销毁旧 socket，杜绝"两个 socket 同时收消息"
      this.ws.removeAllListeners();
      try {
        if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
          this.ws.terminate();
        }
      } catch (err) {
        log.debug('销毁旧 socket 时忽略异常', err);
      }
      this.ws = null;
    }
  }

  /** 主动停止（进程退出时用），不再重连 */
  shutdown() {
    this.shouldRun = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardown();
  }

  // ---------------- 网关协议 ----------------

  async handleRaw(raw) {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch (err) {
      log.warn('网关下发的报文不是合法 JSON，已跳过', err);
      return;
    }
    const { op, d, s, t } = payload;
    if (typeof s === 'number' && s > 0) this.lastSeq = s;

    if (op === OP.HELLO) {
      this.startHeartbeat(d?.heartbeat_interval || 40000);
      // 有 sessionId 就走 Resume 补收断线期间的消息，否则重新 Identify
      if (this.sessionId && this.lastSeq > 0) await this.sendResume();
      else await this.sendIdentify();
      return;
    }

    if (op === OP.HEARTBEAT_ACK) {
      this.lastAckAt = Date.now();
      return;
    }

    if (op === OP.RECONNECT) {
      log.warn('网关要求重连（op 7）');
      this.teardown();
      this.scheduleReconnect();
      return;
    }

    if (op === OP.INVALID_SESSION) {
      log.warn('会话失效（op 9），清空 session 后重新鉴权');
      this.sessionId = '';
      this.lastSeq = 0;
      this.teardown();
      this.scheduleReconnect();
      return;
    }

    if (op !== OP.DISPATCH) return;

    if (t === 'READY') {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.sessionId = d?.session_id || '';
      this.lastAckAt = Date.now();
      log.info('机器人已上线（READY）', { appId: this.appId, sessionId: this.sessionId.slice(0, 8) });
      return;
    }

    if (t === 'RESUMED') {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.stats.resumes += 1;
      this.lastAckAt = Date.now();
      log.info('会话已 Resume，断线期间的消息将被补收');
      return;
    }

    if (t === 'C2C_MESSAGE_CREATE' || t === 'GROUP_AT_MESSAGE_CREATE') {
      this.stats.received += 1;
      await this.dispatchUserMessage(t, d);
    }
  }

  startHeartbeat(intervalMs) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      // 旧版这里裸调 ws.send：socket 处于 CLOSING 时会同步抛异常，
      // setInterval 回调里的同步异常 = uncaughtException = 进程直接退出。
      try {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: this.lastSeq || null }));
        } else {
          log.warn('心跳时发现连接不可用，触发重连');
          this.teardown();
          this.scheduleReconnect();
        }
      } catch (err) {
        log.error('发送心跳失败，触发重连', err);
        this.teardown();
        this.scheduleReconnect();
      }
    }, Math.max(5000, intervalMs));
    if (typeof this.heartbeatTimer.unref === 'function') this.heartbeatTimer.unref();
  }

  async sendIdentify() {
    const token = await this.getAccessToken();
    this.safeSocketSend({
      op: OP.IDENTIFY,
      d: { token: `QQBot ${token}`, intents: INTENTS, shard: [0, 1] },
    });
    log.info('已发送 Identify', { intents: INTENTS });
  }

  async sendResume() {
    const token = await this.getAccessToken();
    this.safeSocketSend({
      op: OP.RESUME,
      d: { token: `QQBot ${token}`, session_id: this.sessionId, seq: this.lastSeq },
    });
    log.info('已发送 Resume', { seq: this.lastSeq });
  }

  safeSocketSend(obj) {
    try {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`socket 状态异常: ${this.ws ? this.ws.readyState : 'null'}`);
      }
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (err) {
      log.error('向网关发送报文失败', err);
      this.teardown();
      this.scheduleReconnect();
      return false;
    }
  }

  async dispatchUserMessage(eventType, data) {
    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const senderId = data?.author?.member_openid || data?.author?.user_openid || data?.author?.id || '';
    const target = isGroup ? data?.group_openid : senderId;
    const content = String(data?.content || '')
      .replace(/<@!?[^>]+>/g, '')
      .trim();
    const msgId = data?.id || '';

    log.info('收到消息', { isGroup, sender: senderId.slice(0, 10), chars: content.length });

    if (!content) {
      log.debug('内容为空，忽略');
      return;
    }
    if (!this.onMessage) {
      log.error('未注入业务处理器 onMessage，消息被丢弃');
      return;
    }

    const ctx = {
      isGroup,
      senderId,
      target,
      msgId,
      // 会话作用域：群里按"群+人"隔离，私聊按人
      sessionScope: isGroup ? `g:${target}:${senderId}` : `c:${senderId}`,
      reply: (text) => this.replyPassive(ctx, text),
      replyImage: (image) => this.replyImage(ctx, image),
      push: (text) => this.pushProactive(target, isGroup, text),
    };

    try {
      await this.onMessage(content, ctx);
    } catch (err) {
      log.error('业务处理器抛出异常', err);
      await this.replyPassive(ctx, `处理时出错了：${String(err.message).slice(0, 120)}`).catch(() => {});
    }
  }

  // ---------------- 发信：配额、队列、限速 ----------------

  /**
   * 被动回复（带 msg_id + 递增 msg_seq）。配额用尽时自动降级为主动推送并说明。
   * @param {object} ctx dispatchUserMessage 里构造的上下文
   * @param {string} text
   */
  async replyPassive(ctx, text) {
    const seq = this.ledger.next(ctx.msgId, ctx.isGroup);
    if (seq === null) {
      this.stats.quotaExhausted += 1;
      log.warn('被动回复配额已用尽，降级为主动推送', {
        isGroup: ctx.isGroup,
        quota: ctx.isGroup ? config.qq.groupReplyQuota : config.qq.c2cReplyQuota,
      });
      return this.pushProactive(ctx.target, ctx.isGroup, text);
    }
    return this.enqueue({
      kind: 'text',
      target: ctx.target,
      isGroup: ctx.isGroup,
      text,
      msgId: ctx.msgId,
      msgSeq: seq,
      priority: 1,
    });
  }

  /** 主动推送（定时提醒用），优先级高于普通回复 */
  async pushProactive(target, isGroup, text) {
    return this.enqueue({ kind: 'text', target, isGroup, text, msgId: null, msgSeq: null, priority: 0 });
  }

  /** 以富媒体方式回复图片（阶段 1-4：官方正解，不再发未报备外链） */
  async replyImage(ctx, image) {
    const seq = this.ledger.next(ctx.msgId, ctx.isGroup);
    return this.enqueue({
      kind: 'image',
      target: ctx.target,
      isGroup: ctx.isGroup,
      image,
      msgId: seq === null ? null : ctx.msgId,
      msgSeq: seq,
      priority: 1,
    });
  }

  /** 有界优先队列：满了就丢最低优先级的，并如实记账（旧版是无界数组） */
  enqueue(task) {
    if (this.queue.length >= config.qq.queueMax) {
      const victimIndex = this.queue.reduce(
        (worst, item, idx) => (item.priority > this.queue[worst].priority ? idx : worst),
        0
      );
      if (this.queue[victimIndex].priority <= task.priority) {
        this.stats.queueDropped += 1;
        log.error('发信队列已满且新任务优先级不更高，丢弃本次发送', { queued: this.queue.length });
        return Promise.resolve({ ok: false, reason: '发信队列已满' });
      }
      this.queue.splice(victimIndex, 1);
      this.stats.queueDropped += 1;
      log.warn('发信队列已满，挤掉一条低优先级消息');
    }

    return new Promise((resolve) => {
      this.queue.push({ ...task, resolve, enqueuedAt: Date.now() });
      // 稳定排序：先按优先级，再按入队顺序
      this.queue.sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt);
      this.drain().catch((err) => log.error('队列消费异常', err));
    });
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const wait = this.bucket.waitMs();
        if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
        if (this.bucket.waitMs() > 0) continue;

        const task = this.queue.shift();
        this.bucket.consume();
        let result;
        try {
          result =
            task.kind === 'image'
              ? await this.sendImage(task)
              : await this.sendText(task);
        } catch (err) {
          this.stats.sendFailed += 1;
          log.error('发送失败', err);
          result = { ok: false, reason: String(err.message).slice(0, 200) };
        }
        task.resolve(result);
        // 相邻消息之间保留最小间隔，避免瞬时 qps 触顶
        await new Promise((r) => setTimeout(r, config.qq.sendMinIntervalMs));
      }
    } finally {
      this.draining = false;
    }
  }

  messageEndpoint(target, isGroup) {
    return isGroup
      ? `https://${API_HOST}/v2/groups/${encodeURIComponent(target)}/messages`
      : `https://${API_HOST}/v2/users/${encodeURIComponent(target)}/messages`;
  }

  filesEndpoint(target, isGroup) {
    return isGroup
      ? `https://${API_HOST}/v2/groups/${encodeURIComponent(target)}/files`
      : `https://${API_HOST}/v2/users/${encodeURIComponent(target)}/files`;
  }

  async sendText(task) {
    const token = await this.getAccessToken();
    const body = { content: task.text, msg_type: 0 };
    if (task.msgId) {
      body.msg_id = task.msgId;
      // 关键修复：官方规定相同 msg_id + msg_seq 重复发送会失败，必须递增
      body.msg_seq = task.msgSeq;
    }
    try {
      const data = await fetchJson(this.messageEndpoint(task.target, task.isGroup), {
        method: 'POST',
        headers: this.authHeader(token),
        body: JSON.stringify(body),
        timeoutMs: config.timeouts.qqApiMs,
        allowHosts: [API_HOST],
      });
      this.stats.sent += 1;
      log.info('文本已送达', {
        isGroup: task.isGroup,
        passive: Boolean(task.msgId),
        msgSeq: task.msgSeq ?? null,
        chars: task.text.length,
        id: data?.id ? String(data.id).slice(0, 12) : undefined,
      });
      return { ok: true, id: data?.id };
    } catch (err) {
      this.stats.sendFailed += 1;
      // 完整记录官方返回的 code/message，旧版这里是空 catch，线上完全看不到
      log.error('文本发送失败', {
        isGroup: task.isGroup,
        passive: Boolean(task.msgId),
        msgSeq: task.msgSeq ?? null,
        status: err.status,
        detail: String(err.bodySnippet || err.message).slice(0, 300),
      });
      return { ok: false, reason: String(err.message).slice(0, 200), status: err.status };
    }
  }

  /**
   * 官方富媒体两步走：先上传拿 file_info，再用 msg_type=7 发送。
   * 先试 url 直传（QQ 服务端自己去下载），失败再退到 base64 上传。
   */
  async sendImage(task) {
    const token = await this.getAccessToken();
    const endpoint = this.filesEndpoint(task.target, task.isGroup);
    const image = task.image || {};
    let fileInfo = null;
    const attempts = [];

    if (image.url) {
      try {
        const data = await fetchJson(endpoint, {
          method: 'POST',
          headers: this.authHeader(token),
          body: JSON.stringify({ file_type: 1, url: image.url, srv_send_msg: false }),
          timeoutMs: 30000,
          allowHosts: [API_HOST],
        });
        fileInfo = data?.file_info || null;
        if (!fileInfo) throw new Error('上传返回中没有 file_info');
      } catch (err) {
        attempts.push(`url 直传失败: ${String(err.bodySnippet || err.message).slice(0, 160)}`);
      }
    }

    if (!fileInfo) {
      try {
        const base64 = image.b64 || (await this.resolveBase64(image.url));
        if (!base64) throw new Error('没有可用的图片数据');
        const data = await fetchJson(endpoint, {
          method: 'POST',
          headers: this.authHeader(token),
          body: JSON.stringify({ file_type: 1, file_data: base64, srv_send_msg: false }),
          timeoutMs: 60000,
          allowHosts: [API_HOST],
        });
        fileInfo = data?.file_info || null;
        if (!fileInfo) throw new Error('base64 上传返回中没有 file_info');
      } catch (err) {
        attempts.push(`base64 上传失败: ${String(err.bodySnippet || err.message).slice(0, 160)}`);
      }
    }

    if (!fileInfo) {
      log.error('图片上传两条通道均失败', attempts.join('；'));
      // 富媒体彻底不通时才退回文字说明；不谎称成功
      const fallback = image.url
        ? `图片生成好了，但通过 QQ 直接发送失败，你可以点这个链接查看：${image.url}`
        : '图片生成好了，但通过 QQ 发送失败了。';
      return this.sendText({ ...task, kind: 'text', text: fallback });
    }

    this.stats.mediaUploaded += 1;
    const body = { msg_type: 7, media: { file_info: fileInfo } };
    if (task.msgId) {
      body.msg_id = task.msgId;
      body.msg_seq = task.msgSeq;
    }
    try {
      const data = await fetchJson(this.messageEndpoint(task.target, task.isGroup), {
        method: 'POST',
        headers: this.authHeader(token),
        body: JSON.stringify(body),
        timeoutMs: config.timeouts.qqApiMs,
        allowHosts: [API_HOST],
      });
      this.stats.sent += 1;
      log.info('图片已送达', { isGroup: task.isGroup, msgSeq: task.msgSeq ?? null });
      return { ok: true, id: data?.id };
    } catch (err) {
      this.stats.sendFailed += 1;
      log.error('图片消息发送失败', {
        status: err.status,
        detail: String(err.bodySnippet || err.message).slice(0, 300),
      });
      return { ok: false, reason: String(err.message).slice(0, 200) };
    }
  }

  /** 把图片 URL 下载成 base64，供富媒体 base64 兜底路径使用 */
  async resolveBase64(url) {
    if (!url) return '';
    const imageTool = require('./tools/image_tool');
    const { buffer } = await imageTool.fetchBytes(url);
    return buffer.toString('base64');
  }

  snapshot() {
    return {
      connected: this.isConnected,
      sessionId: this.sessionId ? `${this.sessionId.slice(0, 8)}…` : '',
      lastSeq: this.lastSeq,
      queued: this.queue.length,
      reconnectAttempts: this.reconnectAttempts,
      secondsSinceAck: this.lastAckAt ? Math.round((Date.now() - this.lastAckAt) / 1000) : null,
      stats: this.stats,
    };
  }
}

module.exports = new QQBotGateway();
module.exports.TokenBucket = TokenBucket;
module.exports.ReplyLedger = ReplyLedger;



