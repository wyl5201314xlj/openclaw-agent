// test/qq_reply_ledger.test.js
// 阶段 0-1 / 3-4 验收：msg_seq 必须递增、配额必须按官方规则算、令牌桶必须限速。
const test = require('node:test');
const assert = require('node:assert');

const qqBot = require('../lib/qq_bot');
const { TokenBucket, ReplyLedger } = qqBot;
const { config } = require('../lib/config');

test('同一 msg_id 的连续回复会拿到递增的 msg_seq（旧版全是隐式 1，第2条起必失败）', () => {
  const ledger = new ReplyLedger();
  assert.strictEqual(ledger.next('msg-1', false), 1);
  assert.strictEqual(ledger.next('msg-1', false), 2);
  assert.strictEqual(ledger.next('msg-1', false), 3);
});

test('单聊配额为官方规定的 4 次，用尽后返回 null', () => {
  const ledger = new ReplyLedger();
  const quota = config.qq.c2cReplyQuota;
  assert.strictEqual(quota, 4, '单聊配额应与官方文档一致');
  for (let i = 1; i <= quota; i += 1) {
    assert.strictEqual(ledger.next('m', false), i);
  }
  assert.strictEqual(ledger.next('m', false), null, '第 5 次应判定为配额用尽');
});

test('群聊配额为官方规定的 5 次', () => {
  const ledger = new ReplyLedger();
  assert.strictEqual(config.qq.groupReplyQuota, 5);
  for (let i = 1; i <= 5; i += 1) {
    assert.strictEqual(ledger.next('g', true), i);
  }
  assert.strictEqual(ledger.next('g', true), null);
});

test('不同 msg_id 各自独立计数', () => {
  const ledger = new ReplyLedger();
  assert.strictEqual(ledger.next('a', false), 1);
  assert.strictEqual(ledger.next('b', false), 1);
  assert.strictEqual(ledger.next('a', false), 2);
});

test('没有 msg_id 时不发放 msg_seq（主动消息不带 msg_id）', () => {
  const ledger = new ReplyLedger();
  assert.strictEqual(ledger.next('', false), null);
  assert.strictEqual(ledger.next(null, true), null);
});

test('remaining 能正确报告剩余配额', () => {
  const ledger = new ReplyLedger();
  assert.strictEqual(ledger.remaining('x', false), 4);
  ledger.next('x', false);
  ledger.next('x', false);
  assert.strictEqual(ledger.remaining('x', false), 2);
});

test('账本有上限，不会无界增长', () => {
  const ledger = new ReplyLedger(10);
  for (let i = 0; i < 50; i += 1) ledger.next(`k${i}`, false);
  assert.ok(ledger.entries.size <= 11, `账本条目应受限，实际 ${ledger.entries.size}`);
});

test('令牌桶把速率限制在配置的每分钟条数内', () => {
  const bucket = new TokenBucket(3, 6); // 容量 3，每分钟补 6 个 → 10 秒 1 个
  assert.strictEqual(bucket.waitMs(), 0);
  bucket.consume();
  bucket.consume();
  bucket.consume();
  const wait = bucket.waitMs();
  assert.ok(wait > 0, '令牌耗尽后必须要求等待');
  assert.ok(wait <= 10000 + 50, `等待时间应约为 10 秒，实际 ${wait}ms`);
});

test('发信最小间隔与每分钟上限均已按官方频控配置（旧版 250ms≈4条/秒会击穿分钟配额）', () => {
  assert.ok(config.qq.sendMinIntervalMs >= 300, '最小间隔不应小于 300ms');
  assert.ok(config.qq.sendPerMinute <= 30, '每分钟条数不应超过官方未认证机器人的 30/qpm');
  assert.ok(config.qq.queueMax > 0, '队列必须有上限');
});
