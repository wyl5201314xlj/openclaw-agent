#!/usr/bin/env node
// OpenClaw 网关启动入口：从环境变量渲染 openclaw.json（凭据只在运行时注入，不进镜像），
// 然后前台启动官方网关。网关 bind=lan 监听 0.0.0.0:$PORT，供 Render 端口检测与健康检查。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || '/var/lib/openclaw/openclaw.json';
const MODEL_ID = process.env.AGNES_MODEL_ID || 'agnes-2.5-flash';

function fail(msg) {
  console.error('[entrypoint] ' + msg);
  process.exit(1);
}

const appId = process.env.QQ_APP_ID || '';
const clientSecret = process.env.QQ_CLIENT_SECRET || '';
if (!appId || !clientSecret) fail('缺少 QQ_APP_ID / QQ_CLIENT_SECRET 环境变量');
if (!process.env.AGNES_API_KEY) fail('缺少 AGNES_API_KEY 环境变量');

// 非 loopback 绑定必须配网关访问令牌；未提供则每次启动随机生成（打印到日志供管理面使用）
let gatewayToken = process.env.GATEWAY_TOKEN || '';
if (!gatewayToken) {
  gatewayToken = require('node:crypto').randomBytes(24).toString('base64url');
  console.log('[entrypoint] 未设置 GATEWAY_TOKEN，本次启动随机生成: ' + gatewayToken);
}

const config = {
  gateway: {
    bind: 'lan',
    auth: { mode: 'token', token: gatewayToken },
  },
  models: {
    providers: {
      agnes: {
        baseUrl: process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1',
        apiKey: process.env.AGNES_API_KEY,
        api: 'openai-completions',
        models: [
          { id: MODEL_ID, name: 'Agnes Flash', contextWindow: 128000, maxTokens: 8192 },
        ],
      },
    },
  },
  agents: {
    defaults: {
      model: { primary: 'agnes/' + MODEL_ID },
      workspace: '/var/lib/openclaw/workspace',
    },
  },
  channels: {
    qqbot: {
      enabled: true,
      appId,
      clientSecret,
      markdownSupport: true,
    },
  },
};

fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log('[entrypoint] 配置已写入 ' + CONFIG_PATH);

// QQ 频道网关需要常驻前台进程；监听端口取 Render 注入的 PORT
process.env.OPENCLAW_GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || process.env.PORT || '3000';

const child = spawn('openclaw', ['gateway'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
