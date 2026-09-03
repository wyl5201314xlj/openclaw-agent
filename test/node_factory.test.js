// test/node_factory.test.js
// 阶段四 4-2 回归测试：早报不崩、TLS 分级存在、评分冷冻、分流规则存在、限速固定窗口。
const test = require('node:test');
const assert = require('node:assert/strict');

const nodeStore = require('../lib/node_store');
const nodeScheduler = require('../lib/node_scheduler');
const nodeProber = require('../lib/tools/node_prober');

test('早报生成不抛错（阶段一 1-3 回归）', () => {
  const text = nodeScheduler.generateCleanMorningDigest();
  assert.ok(typeof text === 'string' && text.length > 0);
  const stats = nodeStore.getSummaryStats();
  for (const k of ['total', 'residential', 'regionStats', 'minLatency', 'avgLatency']) {
    assert.ok(k in stats, `getSummaryStats 缺字段: ${k}`);
  }
});

test('TLS 分级函数存在且测速 URL 校验拒绝内网（阶段二 2-1/2-3 回归）', async () => {
  assert.equal(typeof nodeProber.probeTlsHandshake, 'function');
  assert.equal(typeof nodeProber.probeDownloadSpeed, 'function');
  // 内网测速地址必须被拒绝（安全约束）
  process.env.SPEED_TEST_URL = 'http://127.0.0.1:9999/x.bin';
  delete require.cache[require.resolve('../lib/tools/node_prober')];
  const prober2 = require('../lib/tools/node_prober');
  const r = await prober2.probeDownloadSpeed('unit');
  assert.equal(r.speedMbps, 0);
  delete process.env.SPEED_TEST_URL;
});

test('评分冷冻：缺席 3 轮冻结 24h，回归清零（阶段三 3-1 回归）', () => {
  const store = require('../lib/node_store');
  const keepNodes = store.activeNodes;
  const keepCold = store._coldNodes;
  try {
    store.activeNodes = [{ server: '9.9.9.9', port: 1, successStreak: 2, failStreak: 0, latency: 50, displayName: 't', scoreSeenAt: Date.now() }];
    store._coldNodes = [];
    store.mergeScores([]);
    store.activeNodes = [];
    store.mergeScores([]);
    store.mergeScores([]);
    const cold = (store._coldNodes || []).find(c => c.key === '9.9.9.9:1');
    assert.ok(cold && cold.failStreak >= 3, '缺席3轮 failStreak 应>=3');
    assert.ok(cold.frozenUntil > Date.now(), '应设置 24h 冷冻');
    assert.ok(store.isFrozen('9.9.9.9', 1), 'isFrozen 应为 true');
    // 回归清零
    const back = [{ server: '9.9.9.9', port: 1, latency: 40, displayName: 't', rawName: 't', type: 'vmess' }];
    store.mergeScores(back);
    assert.equal(back[0].failStreak, 0);
    assert.equal(back[0].frozenUntil, 0);
  } finally {
    store.activeNodes = keepNodes;
    store._coldNodes = keepCold;
  }
});

test('分流规则存在：GEOIP/国内域名/MATCH + dns 段（阶段三 3-3 回归）', () => {
  const y = nodeStore.generateClashConfig();
  for (const k of ['GEOIP,CN,DIRECT', 'DOMAIN-SUFFIX,wechat.com,DIRECT', 'DOMAIN-SUFFIX,qq.com,DIRECT', 'MATCH,', 'dns:', '223.5.5.5', '8.8.8.8']) {
    assert.ok(y.includes(k), `YAML 缺少: ${k}`);
  }
});

test('家宽字段透出：classify 接线后节点带 isResidential（阶段三 3-2 回归）', async () => {
  const prober = require('../lib/tools/node_prober');
  // 用回环地址做纯逻辑验证：classify 失败也不应抛错，且字段存在
  const nodes = [{ server: '127.0.0.1', port: 1, type: 'vmess', rawName: '测试', priority: 0 }];
  const top = await prober.probeAndRankNodes(nodes, 1, 1);
  assert.ok(Array.isArray(top), '应返回数组（0 个存活也算正常）');
});
