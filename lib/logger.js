// lib/logger.js
// 结构化分级日志：替换项目里原有的 6 处空 catch，保证线上任何失败都可观测。
// 设计约束：零依赖、单行输出（Render 日志面板按行收集）、自动脱敏凭据。

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const CURRENT = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

// 任何形如 Bearer xxx / sk-xxx / ghp_xxx / 长 token 的片段一律脱敏，杜绝凭据进日志
const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi,
  /((?:sk|ghp|gho|rnd|hf)[-_][A-Za-z0-9._\-]{6,})/gi,
  /("?(?:api_?key|apikey|token|secret|password|authorization)"?\s*[:=]\s*"?)([^",\s]{6,})/gi,
];

function redact(text) {
  let out = String(text);
  out = out.replace(SECRET_PATTERNS[0], (_m, p1) => `${p1}***`);
  out = out.replace(SECRET_PATTERNS[1], (m) => `${m.slice(0, 7)}***`);
  out = out.replace(SECRET_PATTERNS[2], (_m, p1) => `${p1}***`);
  return out;
}

function serialize(value) {
  if (value === undefined) return '';
  if (value instanceof Error) {
    return redact(`${value.name}: ${value.message}`);
  }
  if (typeof value === 'string') return redact(value);
  try {
    return redact(JSON.stringify(value));
  } catch {
    return '[不可序列化]';
  }
}

function emit(level, scope, message, meta) {
  if (LEVELS[level] < CURRENT) return;
  const parts = [
    new Date().toISOString(),
    level.toUpperCase().padEnd(5),
    `[${scope}]`,
    serialize(message),
  ];
  if (meta !== undefined) parts.push(serialize(meta));
  const line = parts.join(' ');
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** 为某个模块创建带 scope 的 logger，例如 createLogger('QQ-Bot') */
function createLogger(scope) {
  return {
    debug: (msg, meta) => emit('debug', scope, msg, meta),
    info: (msg, meta) => emit('info', scope, msg, meta),
    warn: (msg, meta) => emit('warn', scope, msg, meta),
    error: (msg, meta) => emit('error', scope, msg, meta),
  };
}

module.exports = { createLogger, redact };
