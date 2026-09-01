// test/timer_tool.test.js
// 阶段 0-7 验收：登记 → 持久化 → 重建 → 补发全链路（内存降级模式下即可验证语义）。
const test = require('node:test');
const assert = require('node:assert');

const timerTool = require('../lib/tools/timer_tool');
const store = require('../lib/store');

test('登记后可在待办列表里查到，并写入持久层', async () => {
  const delivered = [];
  timerTool.setDeliver(async (openid, isGroup, text) => {
    delivered.push({ openid, isGroup, text });
  });

  const parsed = timerTool.parse('30分钟后提醒我开会');
  assert.strictEqual(parsed.ok, true);

  const rec = await timerTool.schedule({
    triggerAt: parsed.triggerAt,
    remindText: parsed.remindText,
    targetOpenid: 'user-abc',
    isGroup: false,
    sourceText: '30分钟后提醒我开会',
  });

  assert.ok(rec.id);
  const pending = timerTool.listPending();
  assert.ok(pending.some((p) => p.id === rec.id && p.remindText === '开会'));

  const persisted = await store.get(`timer:${rec.id}`);
  assert.ok(persisted, '持久层应能读回记录');
  assert.strictEqual(persisted.remindText, '开会');

  // 清理，避免影响后续用例
  await timerTool.fire(rec.id);
  assert.strictEqual(delivered.length, 1);
  assert.match(delivered[0].text, /开会/);
});

test('到点触发会调用送达通道，并从持久层删除', async () => {
  const delivered = [];
  timerTool.setDeliver(async (openid, isGroup, text) => {
    delivered.push(text);
  });

  const rec = await timerTool.schedule({
    triggerAt: Date.now() + 200,
    remindText: '喝水',
    targetOpenid: 'user-xyz',
    isGroup: false,
  });

  await new Promise((r) => setTimeout(r, 500));
  await timerTool.sweep();

  assert.strictEqual(delivered.length, 1);
  assert.match(delivered[0], /喝水/);
  assert.strictEqual(await store.get(`timer:${rec.id}`), null, '触发后应从持久层删除');
});

test('重启场景：持久层里已过期的提醒会被补发并带延迟说明', async () => {
  const delivered = [];
  timerTool.setDeliver(async (openid, isGroup, text) => {
    delivered.push(text);
  });

  // 直接往持久层塞一条"本该 10 分钟前触发"的记录，模拟休眠期间错过
  const id = 'restart-case-1';
  await store.put(
    `timer:${id}`,
    {
      id,
      triggerAt: Date.now() - 10 * 60 * 1000,
      remindText: '交房租',
      targetOpenid: 'user-restart',
      isGroup: false,
      createdAt: Date.now() - 20 * 60 * 1000,
    },
    120
  );

  const result = await timerTool.reconcile();
  assert.ok(result.restored >= 1, '应从持久层重建至少一条');
  assert.strictEqual(delivered.length, 1);
  assert.match(delivered[0], /交房租/);
  assert.match(delivered[0], /延迟|补发/, '补发必须说明延迟原因');
});

test('未注入送达通道时明确报错，而不是静默丢弃', async () => {
  timerTool.setDeliver(null);
  const rec = await timerTool.schedule({
    triggerAt: Date.now() + 60000,
    remindText: '测试',
    targetOpenid: 'user-none',
    isGroup: false,
  });
  const res = await timerTool.fire(rec.id);
  assert.strictEqual(res.ok, false);
  assert.match(res.reason, /送达通道/);
});

test('解析失败时不产生任何定时器', () => {
  const parsed = timerTool.parse('提醒我看一下这道题的得分');
  assert.strictEqual(parsed.ok, false);
});
