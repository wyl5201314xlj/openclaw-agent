// test/node_pipeline.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const nodeFetcher = require('../lib/tools/node_fetcher');
const nodeStore = require('../lib/node_store');

test('NodeFetcher: 基础 Base64 订阅解码与节点提取', () => {
  const dummyLinks = [
    'vless://11111111-2222-3333-4444-555555555555@1.2.3.4:443?encryption=none&security=tls#%E9%A6%99%E6%B8%AF01',
    'vmess://22222222-3333-4444-5555-666666666666@5.6.7.8:80?security=none#%E7%BE%8E%E5%9B%BD01'
  ].join('\n');

  const base64Encoded = Buffer.from(dummyLinks).toString('base64');
  const decodedLines = nodeFetcher.decodeSubscription(base64Encoded);
  assert.equal(decodedLines.length, 2);

  const parsed = nodeFetcher.parseNodeLink(decodedLines[0]);
  assert.equal(parsed.protocol, 'vless');
  assert.equal(parsed.host, '1.2.3.4');
  assert.equal(parsed.port, 443);
});

test('NodeStore: 生成合法 Shadowrocket Base64 订阅', () => {
  const mockNodes = [
    {
      raw: 'vless://test-uuid@1.1.1.1:443#%5B%F0%9F%8F%A0%E9%A6%99%E6%B8%AF%E5%AE%B6%E5%AE%BD%5D%20HKT',
      protocol: 'vless',
      host: '1.1.1.1',
      port: 443,
      name: '[🏠香港家宽] HKT',
      isResidential: true,
      latency: 80,
      country: 'HK'
    }
  ];

  nodeStore.updateActiveNodes(mockNodes);
  assert.equal(nodeStore.activeNodes.length, 1);
  assert.equal(nodeStore.getResidentialCount(), 1);

  const subBase64 = nodeStore.generateShadowrocketSubscription();
  assert.ok(subBase64.length > 10);

  const decoded = Buffer.from(subBase64, 'base64').toString('utf-8');
  assert.match(decoded, /vless:\/\/test-uuid@1.1.1.1:443/);
});
