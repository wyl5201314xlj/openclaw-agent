// scripts/verify_store.js
// 阶段 0-7 验收：确认当前生效的持久化后端能真正完成"写入 → 读回 → 列举 → 删除"，
// 并模拟一次"服务重启后补发过期提醒"。
// 凭据由 scripts/run_with_creds.py 注入环境变量，本文件不含任何凭据。
const store = require('../lib/store');
const timerTool = require('../lib/tools/timer_tool');
const { formatBeijing } = require('../lib/time_parse');

(async () => {
  let ok = true;
  console.log(`当前后端: ${store.mode}`);

  console.log('\n=== A. 健康检查（写入-读回-删除）===');
  const health = await store.healthCheck();
  console.log(`   ok=${health.ok} mode=${health.mode} detail=${health.detail}`);
  ok = health.ok && ok;

  console.log('\n=== B. 列举能力 ===');
  const key = `timer:verify-${Date.now().toString(36)}`;
  await store.put(key, { hello: 'world', triggerAt: Date.now() + 600000 }, 3600);
  const keys = await store.listKeys('timer:');
  console.log(`   列举到 ${keys.length} 个 timer:* 键，包含刚写入的: ${keys.includes(key)}`);
  ok = keys.includes(key) && ok;

  console.log('\n=== C. 读回内容一致 ===');
  const got = await store.get(key);
  console.log(`   读回: ${JSON.stringify(got)}`);
  ok = got && got.hello === 'world' && ok;

  console.log('\n=== D. 删除后应读不到 ===');
  await store.delete(key);
  const after = await store.get(key);
  console.log(`   删除后读回: ${after === null ? 'null（正确）' : JSON.stringify(after)}`);
  ok = after === null && ok;

  console.log('\n=== E. 模拟重启补发：往持久层塞一条已过期的提醒，再 reconcile ===');
  const delivered = [];
  timerTool.setDeliver(async (openid, isGroup, text) => {
    delivered.push(text);
  });
  const overdueId = `restart-${Date.now().toString(36)}`;
  await store.put(
    `timer:${overdueId}`,
    {
      id: overdueId,
      triggerAt: Date.now() - 8 * 60 * 1000,
      remindText: '验证补发',
      targetOpenid: 'verify-openid',
      isGroup: false,
      createdAt: Date.now() - 20 * 60 * 1000,
    },
    3600
  );
  const result = await timerTool.reconcile();
  console.log(`   reconcile: ${JSON.stringify(result)}`);
  console.log(`   送达内容: ${delivered.map((t) => t.replace(/\n/g, ' ')).join(' | ').slice(0, 200)}`);
  const good = delivered.some((t) => t.includes('验证补发') && /延迟|补发/.test(t));
  console.log(`   ${good ? '✓ 过期提醒已补发且说明了延迟' : '✗ 未正确补发'}`);
  ok = good && ok;

  // 清理可能残留的键
  for (const k of await store.listKeys('timer:')) {
    await store.delete(k);
  }
  const leftover = await store.listKeys('timer:');
  console.log(`\n清理后剩余 timer:* 键 = ${leftover.length}`);

  console.log(`\n总体结果: ${ok ? '全部通过' : '存在未通过项'}`);
  process.exit(ok ? 0 : 1);
})();
