// lib/tools/timer_tool.js
// 阶段 0-7 + 1-5 重写。
//
// 旧实现的两个硬伤：
//   1. 定时器只存在进程内存（Map + setTimeout），Render 免费实例休眠或每次部署
//      都会让所有未触发的提醒静默蒸发，与"主动发信 100% 必达"直接冲突；
//   2. 时间解析把「下午3点」「一分钟后」「半小时后」全部落到 180 秒默认值。
//
// 新实现：解析交给 lib/time_parse.js（有 17 条单元测试兜底）；
// 记录写 Cloudflare KV，进程启动时重建；过期未送达的补发并说明延迟。

const store = require('../store');
const { createLogger } = require('../logger');
const { parseSchedule, formatBeijing } = require('../time_parse');

const log = createLogger('TimerTool');

const KEY_PREFIX = 'timer:';
const SWEEP_INTERVAL_MS = 30 * 1000;
const NEAR_TERM_MS = 24 * 3600 * 1000; // 24 小时内的用 setTimeout 精确触发，更远的交给巡检
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

class TimerTool {
  constructor() {
    this.pending = new Map(); // id -> { record, handle }
    this.deliver = null; // 由 qq_bot 注入的送达函数
    this.sweepTimer = null;
    this.reconcileTimer = null;
    this.stats = { scheduled: 0, fired: 0, lateFired: 0, failed: 0 };
  }

  /** 注入送达通道：(targetOpenid, isGroup, text) => Promise */
  setDeliver(fn) {
    this.deliver = fn;
  }

  /** 解析用户原话；解析失败时返回 ok:false 由上层回问，不猜默认值 */
  parse(text, nowMs = Date.now()) {
    return parseSchedule(text, nowMs);
  }

  /**
   * 登记一条提醒。
   * @param {{triggerAt:number, remindText:string, targetOpenid:string,
   *          isGroup:boolean, sourceText?:string}} input
   */
  async schedule(input) {
    const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const record = {
      id,
      triggerAt: input.triggerAt,
      remindText: input.remindText || '你设定的提醒事项',
      targetOpenid: input.targetOpenid,
      isGroup: Boolean(input.isGroup),
      sourceText: (input.sourceText || '').slice(0, 200),
      createdAt: Date.now(),
    };

    const ttlSeconds = Math.max(60, Math.ceil((record.triggerAt - Date.now()) / 1000) + 3600);
    const put = await store.put(KEY_PREFIX + id, record, ttlSeconds);
    this.track(record);
    this.stats.scheduled += 1;
    log.info('已登记提醒', {
      id,
      triggerAt: formatBeijing(record.triggerAt),
      persisted: put.ok,
      mode: put.mode,
    });
    return { ...record, persisted: put.ok, storeMode: put.mode };
  }

  /** 放进内存索引；24 小时内的挂精确 setTimeout，更远的交给巡检兜住 */
  track(record) {
    const existing = this.pending.get(record.id);
    if (existing?.handle) clearTimeout(existing.handle);

    const delay = record.triggerAt - Date.now();
    let handle = null;
    if (delay <= NEAR_TERM_MS) {
      handle = setTimeout(() => {
        this.fire(record.id).catch((err) => log.error('触发提醒异常', err));
      }, Math.max(0, delay));
      // 定时器不应阻止进程退出
      if (typeof handle.unref === 'function') handle.unref();
    }
    this.pending.set(record.id, { record, handle });
  }

  /** 真正送达一条提醒；无论成败都从待办里移除，避免无限重试刷爆发信配额 */
  async fire(id, options = {}) {
    const entry = this.pending.get(id);
    if (!entry) return { ok: false, reason: '提醒已不存在（可能已触发或被清理）' };
    const { record } = entry;
    if (entry.handle) clearTimeout(entry.handle);
    this.pending.delete(id);
    await store.delete(KEY_PREFIX + id);

    const lateSeconds = Math.round((Date.now() - record.triggerAt) / 1000);
    const isLate = lateSeconds > 60;
    if (isLate) this.stats.lateFired += 1;

    const body =
      `⏰ 【定时提醒】\n${record.remindText}` +
      (isLate
        ? `\n\n（原定 ${formatBeijing(record.triggerAt)} 送达，因服务重启延迟了约 ${Math.round(
            lateSeconds / 60
          )} 分钟，已为你补发）`
        : '');

    if (!this.deliver) {
      this.stats.failed += 1;
      log.error('提醒无法送达：未注入送达通道', { id });
      return { ok: false, reason: '未注入送达通道' };
    }
    try {
      await this.deliver(record.targetOpenid, record.isGroup, body, { proactive: true });
      this.stats.fired += 1;
      log.info('提醒已送达', { id, late: isLate ? lateSeconds : 0 });
      return { ok: true, late: isLate };
    } catch (err) {
      this.stats.failed += 1;
      log.error('提醒送达失败', err);
      return { ok: false, reason: err.message };
    }
  }

  /** 巡检：兜住 setTimeout 覆盖不到的远期提醒，以及被系统时钟跳变影响的情况 */
  async sweep() {
    const now = Date.now();
    const due = [...this.pending.values()]
      .filter((e) => e.record.triggerAt <= now)
      .map((e) => e.record.id);
    for (const id of due) {
      await this.fire(id);
    }
    return due.length;
  }

  /** 从持久层重建待办（进程启动、以及每 10 分钟对账一次） */
  async reconcile() {
    const keys = await store.listKeys(KEY_PREFIX);
    let restored = 0;
    let overdue = 0;
    for (const key of keys) {
      const id = key.slice(KEY_PREFIX.length);
      if (this.pending.has(id)) continue;
      const record = await store.get(key);
      if (!record || !record.triggerAt) {
        await store.delete(key);
        continue;
      }
      this.pending.set(id, { record, handle: null });
      if (record.triggerAt <= Date.now()) {
        overdue += 1;
      } else {
        this.track(record);
      }
      restored += 1;
    }
    if (overdue > 0) await this.sweep();
    if (restored > 0) {
      log.info('从持久层重建提醒', { restored, overdue, storeMode: store.mode });
    }
    return { restored, overdue, pending: this.pending.size };
  }

  /** 服务启动时调用：重建 + 启动巡检与对账 */
  async start() {
    await this.reconcile();
    this.sweepTimer = setInterval(() => {
      this.sweep().catch((err) => log.error('巡检异常', err));
    }, SWEEP_INTERVAL_MS);
    this.reconcileTimer = setInterval(() => {
      this.reconcile().catch((err) => log.error('对账异常', err));
    }, RECONCILE_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
    if (typeof this.reconcileTimer.unref === 'function') this.reconcileTimer.unref();
    log.info('定时器子系统已启动', { pending: this.pending.size, storeMode: store.mode });
  }

  stop() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    for (const entry of this.pending.values()) {
      if (entry.handle) clearTimeout(entry.handle);
    }
  }

  listPending() {
    return [...this.pending.values()]
      .map((e) => ({
        id: e.record.id,
        remindText: e.record.remindText,
        triggerAt: e.record.triggerAt,
        humanTime: formatBeijing(e.record.triggerAt),
        isGroup: e.record.isGroup,
      }))
      .sort((a, b) => a.triggerAt - b.triggerAt);
  }

  snapshot() {
    return { ...this.stats, pending: this.pending.size, storeMode: store.mode };
  }
}

module.exports = new TimerTool();
