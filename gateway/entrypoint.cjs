#!/usr/bin/env node
// OpenClaw 网关启动入口：从环境变量渲染 openclaw.json（凭据只在运行时注入，不进镜像），
// 然后前台启动官方网关。网关 bind=lan 监听 0.0.0.0:$PORT，供 Render 端口检测与健康检查。
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH || '/var/lib/openclaw/openclaw.json';
const MODEL_ID = process.env.AGNES_MODEL_ID || 'agnes-2.5-flash';
const WORKSPACE = process.env.OPENCLAW_WORKSPACE || '/var/lib/openclaw/workspace';
// 容器时区为 UTC，若不显式声明用户时区，「每天8点」会按 UTC 落到北京时间 16 点
const USER_TZ = process.env.USER_TIMEZONE || 'Asia/Shanghai';

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
    // 官方网关硬要求：缺 gateway.mode 会被判定为可疑配置并以退出码 78 拒绝启动
    mode: 'local',
    bind: 'lan',
    auth: { mode: 'token', token: gatewayToken },
    // Render 的反向代理从容器内 loopback 接入并注入 X-Forwarded-For，网关判定为
    // "不可归因的代理流量"并对所有管理路由回 403 proxy_attribution_required。
    // 把 loopback 列为受信代理即可恢复管理 API（鉴权仍由 auth.mode=token 把关）。
    trustedProxies: ['127.0.0.1', '::1'],
  },
  models: {
    // 每次启动都会拉取云端模型目录，实测把 auth 阶段拖到 13.1 秒（占单轮延迟约 1/5），
    // 而本地已显式声明 Agnes 模型，远端目录对本部署无用，直接关掉。
    catalogRefresh: { enabled: false },
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
      workspace: WORKSPACE,
      // 容器时区是 UTC（日志时间戳均为 +00:00）。不显式声明的话，「每天早上8点」
      // 会被按 UTC 解释、实际在北京时间下午 4 点触发。
      userTimezone: 'Asia/Shanghai',
    },
  },
  // 工具策略是顶层键（实测放在 agents.defaults 下会被校验拒绝：
  // "agents.defaults: Unrecognized key: tools"，网关以退出码 78 拒绝启动）。
  // bundle-tools 阶段实测 4.9 秒：逐个装配全部工具的 schema。用 deny 裁掉
  // QQ 聊天用不到的重工具组（deny 是减法，不会误伤没列出的工具）。
  // 必须保留：cron（定时闹钟）、group:messaging、group:web、group:memory
  // 以及插件工具 qqbot_remind / qqbot_platform_api。
  tools: {
    deny: [
      'group:fs',       // read/write/edit/apply_patch：云端无本地文件可操作
      'group:runtime',  // exec/process/code_execution：容器内不给 agent 执行权
      'group:ui',       // browser/canvas/screen/terminal：无显示环境
      'group:nodes',    // nodes/computer：未接入节点
      'image_generate',
      'music_generate',
      'video_generate',
    ],
  },
  channels: {
    qqbot: {
      enabled: true,
      appId,
      clientSecret,
      markdownSupport: true,
      // dmPolicy=open 时必须显式放行 "*"，否则所有私聊消息会被静默丢弃
      dmPolicy: 'open',
      allowFrom: ['*'],
    },
  },
  // 外部插件必须显式信任启用，否则 qqbot 频道不会加载（网关只打警告不生效）
  plugins: {
    entries: {
      'openclaw-qqbot': { enabled: true },
      // memory-core 的 dreaming 会在启动时注册后台 cron 并做记忆整理，实测把
      // bootstrap-context 阶段拖到 6.8 秒且推高堆占用；QQ 闲聊不需要长期记忆梦境。
      'memory-core': { enabled: true, config: { dreaming: { enabled: false } } },
      // 512MB 免费实例内存吃紧（RSS 曾达 339MB 触发 critical），显式关闭
      // 与 QQ 聊天无关的重插件；模型适配走 models.providers（Agnes），保留 openai 适配器
      browser: { enabled: false },
      canvas: { enabled: false },
      'cua-computer': { enabled: false },
      'talk-voice': { enabled: false },
      geolocation: { enabled: false },
      'device-pair': { enabled: false },
      'file-transfer': { enabled: false },
      ollama: { enabled: false },
      xai: { enabled: false },
      anthropic: { enabled: false },
    },
  },
};

fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log('[entrypoint] 配置已写入 ' + CONFIG_PATH);

// 定时闹钟必须两段调用才会真正落地：qqbot_remind 只返回 cronParams，
// 还要把它原样交给 cron 工具注册。线上实测漏过第二步——模型调完 qqbot_remind
// 就直接回话（"好的，5分钟后提醒你"），日志里零 cron 注册，闹钟到点不响。
// AGENTS.md 会被注入系统提示（agents.defaults.contextInjection 默认 always），
// 在这里把这条规则写死，比只依赖插件技能文档更硬。
const AGENTS_MD = `# 本机器人硬规则

## 定时提醒必须注册成功才算完成
用户说"提醒/闹钟/定时/N分钟后/每天X点"时：

1. 先调 \`qqbot_remind\`（action=add，content=事项，time=相对时间或 cron 表达式）；
2. **必须立刻**把它返回的 \`cronParams\` **原样**传给 \`cron\` 工具完成注册，
   \`delivery.accountId\` 等字段一个都不能改、不能省；
3. 只有 \`cron\` 返回成功后，才能回复用户"已设定"。

只调第一步就回话等于**没设成闹钟**，到点不会响。口头承诺无效——
你没有后台线程，唯一让提醒真正生效的方式就是完成第 2 步的 \`cron\` 注册。
若 \`cron\` 调用失败，如实告诉用户没设上并说明原因，不要假装成功。

## 时区
用户在北京时间（UTC+8）。周期提醒一律带 \`"tz": "Asia/Shanghai"\`。

## 回复风格
简体中文，简短口语化，不写长篇大论。
`;
try {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.writeFileSync(path.join(WORKSPACE, 'AGENTS.md'), AGENTS_MD);
  console.log('[entrypoint] AGENTS.md 已写入 ' + WORKSPACE + '（含闹钟两段调用硬规则）');
} catch (err) {
  // 工作区写失败不阻塞网关启动，但要留痕，避免"规则没生效却查不出原因"
  console.error('[entrypoint] AGENTS.md 写入失败（闹钟硬规则未注入）: ' + err.message);
}

// QQ 频道网关需要常驻前台进程；监听端口取 Render 注入的 PORT
process.env.OPENCLAW_GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || process.env.PORT || '3000';

const child = spawn('openclaw', ['gateway'], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code || 0));
