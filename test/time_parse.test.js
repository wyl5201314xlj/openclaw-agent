// test/time_parse.test.js
// 阶段 1-5 的验收测试：docs/OPTIMIZATION_PLAN.md 里 P1-5 表格的每一条都必须解析正确。
const test = require('node:test');
const assert = require('node:assert');

const { parseSchedule, normalizeNumbers, cnNumberToInt, formatBeijing } = require('../lib/time_parse');

// 固定"现在" = 北京时间 2026-09-01 10:00（UTC 02:00），让绝对时刻断言可复现
const NOW = Date.UTC(2026, 8, 1, 2, 0, 0);
const BEIJING = 8 * 3600 * 1000;

/** 把 UTC 毫秒还原成北京时间的 [年,月,日,时,分] */
function beijingParts(ms) {
  const d = new Date(ms + BEIJING);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()];
}

test('中文数字转换', () => {
  assert.strictEqual(cnNumberToInt('一'), 1);
  assert.strictEqual(cnNumberToInt('十'), 10);
  assert.strictEqual(cnNumberToInt('十五'), 15);
  assert.strictEqual(cnNumberToInt('二十三'), 23);
  assert.strictEqual(cnNumberToInt('两'), 2);
  assert.strictEqual(cnNumberToInt('45'), 45);
});

test('数字归一化：半小时 / 一个半小时 / 一刻钟', () => {
  assert.match(normalizeNumbers('半小时后提醒我'), /0\.5小时/);
  assert.match(normalizeNumbers('一个半小时后'), /1\.5小时/);
  assert.match(normalizeNumbers('一刻钟后'), /15分钟/);
  assert.match(normalizeNumbers('三刻钟后'), /45分钟/);
});

// ---------- P1-5 表格逐条验收 ----------

test('相对时长：30分钟后提醒我开会', () => {
  const r = parseSchedule('30分钟后提醒我开会', NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'relative');
  assert.strictEqual(r.seconds, 1800);
  assert.strictEqual(r.remindText, '开会');
});

test('相对时长：2小时后提醒我吃药', () => {
  const r = parseSchedule('2小时后提醒我吃药', NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.seconds, 7200);
  assert.strictEqual(r.remindText, '吃药');
});

test('相对时长：一分钟后提醒我（旧版错成 180 秒）', () => {
  const r = parseSchedule('一分钟后提醒我', NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.seconds, 60);
});

test('相对时长：半小时后提醒我（旧版错成 180 秒）', () => {
  const r = parseSchedule('半小时后提醒我', NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.seconds, 1800);
});

test('相对时长：组合 1小时20分钟后', () => {
  const r = parseSchedule('1小时20分钟后提醒我交报告', NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.seconds, 3600 + 1200);
  assert.strictEqual(r.remindText, '交报告');
});

test('绝对时刻：下午3点提醒我开会 → 当天 15:00（旧版错成 3 分钟后）', () => {
  const r = parseSchedule('下午3点提醒我开会', NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.kind, 'absolute');
  assert.deepStrictEqual(beijingParts(r.triggerAt), [2026, 9, 1, 15, 0]);
  assert.strictEqual(r.remindText, '开会');
  assert.strictEqual(r.humanTime, '今天 15:00');
});

test('绝对时刻：明天早上8点提醒我起床 → 次日 08:00（旧版错成 3 分钟后）', () => {
  const r = parseSchedule('明天早上8点提醒我起床', NOW);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(beijingParts(r.triggerAt), [2026, 9, 2, 8, 0]);
  assert.strictEqual(r.remindText, '起床');
  assert.strictEqual(r.humanTime, '明天 08:00');
});

test('绝对时刻：晚上9点半提醒我洗澡 → 当天 21:30（旧版错成 3 分钟后）', () => {
  const r = parseSchedule('晚上9点半提醒我洗澡', NOW);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(beijingParts(r.triggerAt), [2026, 9, 1, 21, 30]);
  assert.strictEqual(r.remindText, '洗澡');
});

test('绝对时刻：中文数字「下午三点半」', () => {
  const r = parseSchedule('下午三点半提醒我取快递', NOW);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(beijingParts(r.triggerAt), [2026, 9, 1, 15, 30]);
  assert.strictEqual(r.remindText, '取快递');
});

test('绝对时刻：时刻已过且未写日期 → 顺延到明天', () => {
  // 现在是北京时间 10:00，说"8点"应指明天 08:00
  const r = parseSchedule('8点提醒我开会', NOW);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(beijingParts(r.triggerAt), [2026, 9, 2, 8, 0]);
});

test('绝对时刻：冒号写法 14:45', () => {
  const r = parseSchedule('14:45提醒我打电话', NOW);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(beijingParts(r.triggerAt), [2026, 9, 1, 14, 45]);
});

// ---------- 误判防护：这些都不该被当成定时任务 ----------

test('不含未来指向词的"分"不能被当成时长（旧版把它错设成 3 分钟定时器）', () => {
  const r = parseSchedule('提醒我看一下这道题的得分', NOW);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /没能识别出具体时间/);
});

test('纯问句不应解析出时间', () => {
  for (const text of ['帮我查一下天气', '你是谁', 'Redis 是什么']) {
    assert.strictEqual(parseSchedule(text, NOW).ok, false, `不该解析: ${text}`);
  }
});

test('过短与过长时长都要明确拒绝，而不是猜默认值', () => {
  const tooShort = parseSchedule('1秒后提醒我', NOW);
  assert.strictEqual(tooShort.ok, false);
  assert.match(tooShort.reason, /过短/);

  const tooLong = parseSchedule('100天后提醒我', NOW);
  assert.strictEqual(tooLong.ok, false);
  assert.match(tooLong.reason, /30 天/);
});

test('formatBeijing 跨天显示', () => {
  assert.strictEqual(formatBeijing(NOW + 5 * 3600 * 1000, NOW), '今天 15:00');
  assert.strictEqual(formatBeijing(NOW + 22 * 3600 * 1000, NOW), '明天 08:00');
});
