// scripts/verify_router.js
// 阶段 1-1 / 1-2 / 1-3 的验收脚本：用真实长文本负载跑通新版 model_router，
// 检查首字节延迟、流式、模型链顺序与熔断状态。
// 凭据由 scripts/run_with_creds.py 从机器级凭据库注入到环境变量，本文件不含任何凭据。
const router = require('../lib/model_router');

const LONG_PROMPT =
  '请用中文写一份约 400 字、条理清晰的说明：如何在 512MB 内存的容器里调优 Node.js 常驻服务。';

(async () => {
  console.log('=== A. 长文本负载（旧版 6s 硬熔断会在此丢弃一半回答）===');
  for (let i = 1; i <= 2; i += 1) {
    const t0 = Date.now();
    try {
      const r = await router.chat([{ role: 'user', content: LONG_PROMPT }], { maxTokens: 1500 });
      console.log(
        `  第${i}次 成功 | 总 ${Date.now() - t0}ms | 首字节 ${r.firstByteMs}ms | ` +
        `${r.provider}/${r.model} | 流式=${r.streamed} | 字符 ${r.content.length} | 顺位失败 ${r.attempts.length}`
      );
    } catch (e) {
      console.log(`  第${i}次 失败 | ${Date.now() - t0}ms | ${e.message}`);
    }
  }

  console.log('');
  console.log('=== B. 短问答（应显著更快）===');
  {
    const t0 = Date.now();
    const r = await router.chat([{ role: 'user', content: '用一句话说明 Redis 是什么' }], {
      maxTokens: 200,
    });
    console.log(`  成功 | 总 ${Date.now() - t0}ms | 首字节 ${r.firstByteMs}ms | ${r.provider}/${r.model}`);
    console.log(`  内容: ${r.content.slice(0, 90).replace(/\n/g, ' ')}`);
  }

  console.log('');
  console.log('=== C. 故意打不存在的模型，验证熔断记账 ===');
  {
    const fake = router.chain[0];
    const original = fake.model.id;
    fake.model.id = '__definitely_not_a_real_model__';
    try {
      await router.chat([{ role: 'user', content: 'hi' }], { maxTokens: 20, budgetMs: 20000 });
      console.log('  （其他通道兜住了，属预期：容灾生效）');
    } catch (e) {
      console.log(`  全链失败: ${e.message.slice(0, 160)}`);
    }
    const bad = router.health().chain.find((c) => c.target.includes('__definitely_not'));
    console.log(`  假模型熔断状态: 失败次数=${bad?.failures} 已熔断=${bad?.open} 冷却剩余=${bad?.openForMs}ms`);
    fake.model.id = original;
  }

  console.log('');
  console.log('=== D. 模型链与熔断总览 ===');
  const h = router.health();
  h.chain.forEach((c) =>
    console.log(
      `  tier${c.tier} ${c.target.padEnd(42)} 基线${String(c.baselineMs).padStart(6)}ms ` +
      `成功${c.successes} 失败${c.failures} 熔断=${c.open}${c.lastError ? ' | ' + c.lastError.slice(0, 60) : ''}`
    )
  );
  console.log(`  统计: ${JSON.stringify(h.stats)}`);
  process.exit(0);
})();
