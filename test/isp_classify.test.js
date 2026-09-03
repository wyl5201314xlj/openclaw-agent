// test/isp_classify.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ispClassifier = require('../lib/tools/isp_classifier');

test('ISPClassifier: 显式包含家宽/住宅标签时秒级通过', async () => {
  const res = await ispClassifier.classify('1.1.1.1', '香港 HKT 原生家宽 01');
  assert.equal(res.isResidential, true);
  assert.equal(res.scoreBonus, 100);
  assert.match(res.tag, /家宽/);
});

test('ISPClassifier: 格式化国家标签解析正确', () => {
  assert.equal(ispClassifier.formatCountryTag('US'), '美国');
  assert.equal(ispClassifier.formatCountryTag('HK'), '香港');
  assert.equal(ispClassifier.formatCountryTag('JP'), '日本');
  assert.equal(ispClassifier.formatCountryTag('SG'), '新加坡');
});
