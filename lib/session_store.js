// lib/session_store.js
// 多轮会话记忆（阶段 2-1）。
//
// 旧实现每条消息完全无状态，追问「那它和 Redis 比呢」必然答错。
// 线上实测 RSS 仅 73MB / 512MB，按 300 会话 × 6 轮 × 约 1KB 估算不到 2MB，完全放得下。

const { config } = require('./config');
const { LruTtlCache } = require('./cache');

const MAX_CONTENT_CHARS = 1200; // 单条消息入库上限，防止长报告把窗口撑爆

const store = new LruTtlCache({
  name: 'session',
  maxEntries: config.session.maxSessions,
  ttlMs: config.session.ttlMs,
  maxBytes: 12 * 1024 * 1024,
});

function keyOf(scope) {
  return String(scope || 'default');
}

/** 取某个会话的历史消息（已按窗口截断，可直接拼进 messages） */
function getHistory(scope) {
  return store.get(keyOf(scope)) || [];
}

/** 追加一轮对话；超出窗口的最早若干轮自动淘汰 */
function appendTurn(scope, userText, assistantText) {
  const key = keyOf(scope);
  const history = store.get(key) || [];
  history.push({ role: 'user', content: String(userText || '').slice(0, MAX_CONTENT_CHARS) });
  history.push({
    role: 'assistant',
    content: String(assistantText || '').slice(0, MAX_CONTENT_CHARS),
  });
  const maxMessages = config.session.maxTurns * 2;
  while (history.length > maxMessages) history.shift();
  store.set(key, history);
  return history.length / 2;
}

function clear(scope) {
  const key = keyOf(scope);
  const had = Boolean(store.get(key));
  store.set(key, []);
  return had;
}

function stats() {
  return store.stats();
}

module.exports = { getHistory, appendTurn, clear, stats, _store: store };
