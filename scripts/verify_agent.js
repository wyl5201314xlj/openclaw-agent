// scripts/verify_agent.js
// 阶段 0-5 / 0-3 / 2-1 / 2-2 的端到端验收：真 ReAct 闭环、无编造、无裸 JSON 泄漏、会话记忆、缓存。
// 凭据由 scripts/run_with_creds.py 注入环境变量，本文件不含任何凭据。
const agent = require('../lib/agent_engine');
const sessionStore = require('../lib/session_store');

function assertNoJsonLeak(label, text) {
  const leaked = /"action"\s*:|"thought"\s*:/.test(text);
  console.log(`   ${leaked ? '✗ 检测到裸 JSON 泄漏' : '✓ 无裸 JSON 泄漏'}（${label}）`);
  return !leaked;
}

(async () => {
  let allOk = true;

  console.log('=== A. 纯问答（不应调用任何工具）===');
  {
    const t0 = Date.now();
    const task = await agent.processGoal('用三句话介绍 Redis 是什么', {
      sessionScope: 'verify-1',
    });
    console.log(`   状态=${task.status} 端到端=${Date.now() - t0}ms 步骤=${task.steps.length}`);
    console.log(`   回答: ${String(task.result).slice(0, 110).replace(/\n/g, ' ')}`);
    allOk = assertNoJsonLeak('纯问答', task.result) && allOk;
  }

  console.log('');
  console.log('=== B. 缓存命中（同一问题第二次应几乎瞬时）===');
  {
    const t0 = Date.now();
    const task = await agent.processGoal('用三句话介绍 Redis 是什么', { sessionScope: 'verify-1' });
    console.log(`   cached=${Boolean(task.cached)} 端到端=${Date.now() - t0}ms`);
    if (!task.cached) {
      console.log('   ✗ 未命中缓存');
      allOk = false;
    } else {
      console.log('   ✓ 命中缓存');
    }
  }

  console.log('');
  console.log('=== C. 多轮会话记忆（追问用代词，应能接上上下文）===');
  {
    await agent.processGoal('MySQL 是什么数据库', { sessionScope: 'verify-mem' });
    const task = await agent.processGoal('那它和 Redis 的主要区别是什么', {
      sessionScope: 'verify-mem',
    });
    const hit = /MySQL|关系|磁盘|事务/i.test(task.result);
    console.log(`   回答: ${String(task.result).slice(0, 140).replace(/\n/g, ' ')}`);
    console.log(`   ${hit ? '✓ 正确接上了上文的 MySQL' : '✗ 未能接上上文'}`);
    console.log(`   会话缓存: ${JSON.stringify(sessionStore.stats())}`);
    allOk = hit && allOk;
  }

  console.log('');
  console.log('=== D. 需要联网检索的问题（真 ReAct 闭环）===');
  {
    const t0 = Date.now();
    const progress = [];
    const task = await agent.processGoal('检索一下 Node.js 22 的 LTS 版本号是多少', {
      sessionScope: 'verify-search',
      onProgress: (n) => progress.push(n),
      useCache: false,
    });
    console.log(`   状态=${task.status} 端到端=${Date.now() - t0}ms`);
    task.steps.forEach((s, i) =>
      console.log(`     [${i}] ${s.step}${s.ok === undefined ? '' : ` ok=${s.ok}`}${s.param ? ` param=${String(s.param).slice(0, 40)}` : ''}`)
    );
    console.log(`   进度回调: ${JSON.stringify(progress)}`);
    console.log(`   回答: ${String(task.result).slice(0, 220).replace(/\n/g, ' ')}`);
    allOk = assertNoJsonLeak('检索路径', task.result) && allOk;
  }

  console.log('');
  console.log('=== E. 检索失败时必须如实说明，不得编造 ===');
  {
    const searchTool = require('../lib/tools/search_tool');
    const original = searchTool.searchWeb;
    // 临时把检索工具打成"全通道不可用"，看模型会不会编
    searchTool.searchWeb = async () => ({
      ok: false,
      reason: '（测试注入）所有检索源均不可用',
      sourcesTried: [],
      elapsedMs: 1,
    });
    const task = await agent.processGoal('检索一下 2026 年 9 月 1 日的黄金实时价格是多少', {
      sessionScope: 'verify-fail',
      useCache: false,
    });
    searchTool.searchWeb = original;
    const honest = /失败|不可用|无法|没能|抱歉/.test(task.result);
    console.log(`   回答: ${String(task.result).slice(0, 200).replace(/\n/g, ' ')}`);
    console.log(`   ${honest ? '✓ 如实告知检索失败' : '✗ 未如实说明，可能在编造'}`);
    allOk = honest && allOk;
  }

  console.log('');
  console.log(`总体结果: ${allOk ? '全部通过' : '存在未通过项'}`);
  console.log(`缓存统计: ${JSON.stringify(agent.cacheStats())}`);
  process.exit(allOk ? 0 : 1);
})();
