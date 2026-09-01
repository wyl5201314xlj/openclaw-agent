// test/json_extract.test.js
// 阶段 0-5 验收：贪婪正则导致的"裸 JSON 泄漏给用户"必须被彻底消除。
const test = require('node:test');
const assert = require('node:assert');

const { findBalancedObjects, extractAction, stripThoughtJson } = require('../lib/json_extract');

test('括号配对扫描能分别识别多个 JSON 块（旧版贪婪正则会连成一块）', () => {
  const text = '前言 {"a":1} 中间 {"action":"search","param":"x"} 结尾';
  const blocks = findBalancedObjects(text);
  assert.strictEqual(blocks.length, 2);
  assert.strictEqual(blocks[0].raw, '{"a":1}');
  assert.strictEqual(blocks[1].raw, '{"action":"search","param":"x"}');
});

test('正文里出现花括号不影响解析', () => {
  const text = '代码示例 function f() { return 1; } 然后 {"action":"finish","param":"好了"}';
  const got = extractAction(text);
  assert.ok(got);
  assert.strictEqual(got.action.action, 'finish');
});

test('字符串里的花括号与转义引号不会破坏配对', () => {
  const text = '{"action":"search","param":"含 { 和 } 以及 \\" 引号"}';
  const got = extractAction(text);
  assert.ok(got);
  assert.strictEqual(got.action.action, 'search');
  assert.match(got.action.param, /引号/);
});

test('嵌套对象能被完整抽取', () => {
  const text = '思考中 {"thought":"t","action":"draw","param":"cat","meta":{"n":1,"deep":{"k":"v"}}}';
  const got = extractAction(text);
  assert.ok(got);
  assert.strictEqual(got.action.action, 'draw');
  assert.strictEqual(got.action.meta.deep.k, 'v');
});

test('没有 action 字段时返回 null，不会误判', () => {
  assert.strictEqual(extractAction('纯自然语言回答，没有任何 JSON'), null);
  assert.strictEqual(extractAction('{"thought":"只有思考没有动作"}'), null);
});

test('剥离残留思考 JSON —— 复现线上真实泄漏样本', () => {
  // 这段就是 2026-09-01 线上 /api/tasks 里读到的真实 result 开头
  const leaked =
    '根据检索结果，该工具返回的信息较为笼统。为了给您准确的答案，我将尝试更精确地查询。\n\n' +
    '{"thought": "初次搜索返回的信息不够具体，我需要重新搜索。", "action": "search", "param": "Node.js 22.11.0 LTS"}';
  const cleaned = stripThoughtJson(leaked);
  assert.ok(!cleaned.includes('"action"'), '清洗后不应残留 action 字段');
  assert.ok(!cleaned.includes('thought'), '清洗后不应残留 thought 字段');
  assert.match(cleaned, /根据检索结果/);
});

test('剥离多个 JSON 块且不破坏正文顺序', () => {
  const text = 'A {"action":"search","param":"1"} B {"thought":"x"} C';
  const cleaned = stripThoughtJson(text);
  assert.match(cleaned, /^A\s+B\s+C$/);
});

test('纯自然语言经过清洗后保持原样', () => {
  const text = '这是一段完全正常的中文回答，包含数字 3 和符号 —— 不应被改动。';
  assert.strictEqual(stripThoughtJson(text), text);
});
