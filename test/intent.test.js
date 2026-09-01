// test/intent.test.js
// 阶段 1-6 验收：20 条边界语料，误判率必须为 0。
const test = require('node:test');
const assert = require('node:assert');

const { classify, extractDrawPrompt } = require('../lib/intent');

// 固定"现在" = 北京时间 2026-09-01 10:00
const NOW = Date.UTC(2026, 8, 1, 2, 0, 0);

const CASES = [
  // ---- 应判定为 timer ----
  ['30分钟后提醒我开会', 'timer'],
  ['2小时后提醒我吃药', 'timer'],
  ['下午3点提醒我开会', 'timer'],
  ['明天早上8点提醒我起床', 'timer'],
  ['晚上9点半提醒我洗澡', 'timer'],
  ['半小时后提醒我', 'timer'],
  ['一分钟后叫我', 'timer'],
  ['20分钟后记得提醒我关火', 'timer'],

  // ---- 应判定为 draw ----
  ['画一只猫', 'draw'],
  ['帮我画个猫', 'draw'],
  ['生成一张赛博朋克城市的图', 'draw'],
  ['帮我生图：雪山日落', 'draw'],
  ['给我画一幅水墨山水', 'draw'],
  ['绘制一张架构示意图', 'draw'],

  // ---- 应判定为 chat（旧版这些全会误判）----
  ['提醒我看一下这道题的得分', 'chat'],
  ['帮我查一下今天的天气', 'chat'],
  ['这幅画很好看，是谁画的', 'chat'],
  ['Redis 和 MySQL 有什么区别', 'chat'],
  ['你能提醒我什么事情吗', 'chat'],
  ['3点的会议在哪个会议室', 'chat'],
];

test('20 条边界语料意图判定全部正确', () => {
  const wrong = [];
  for (const [text, expected] of CASES) {
    const got = classify(text, NOW);
    if (got.intent !== expected) {
      wrong.push(`「${text}」期望 ${expected} 实际 ${got.intent}（${got.reason}）`);
    }
  }
  assert.deepStrictEqual(wrong, [], `误判 ${wrong.length} 条:\n${wrong.join('\n')}`);
});

test('timer 意图会带回可用的解析结果', () => {
  const got = classify('30分钟后提醒我开会', NOW);
  assert.strictEqual(got.intent, 'timer');
  assert.strictEqual(got.schedule.ok, true);
  assert.strictEqual(got.schedule.seconds, 1800);
  assert.strictEqual(got.schedule.remindText, '开会');
});

test('有提醒动词但时间无法解析时落到 chat，交给智能体去问', () => {
  const got = classify('提醒我一下那件事', NOW);
  assert.strictEqual(got.intent, 'chat');
  assert.match(got.reason, /时间无法解析/);
});

test('绘图提示词提取（旧版「帮我画个猫」根本进不了生图分支）', () => {
  assert.strictEqual(extractDrawPrompt('画一只猫'), '猫');
  assert.strictEqual(extractDrawPrompt('帮我画个猫'), '猫');
  assert.strictEqual(extractDrawPrompt('给我画一幅水墨山水'), '水墨山水');
  assert.strictEqual(extractDrawPrompt('生成一张赛博朋克城市的图'), '赛博朋克城市');
  assert.strictEqual(extractDrawPrompt('帮我生图：雪山日落'), '雪山日落');
});

test('空提示词的生图请求要能被识别出来（由上层回问）', () => {
  const got = classify('画', NOW);
  assert.strictEqual(got.intent, 'draw');
  assert.strictEqual(got.param, '');
});
