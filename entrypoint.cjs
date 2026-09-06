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
    // cron/automations 默认被 POST /tools/invoke 屏蔽（owner-only）。显式放行后
    // 可用共享令牌直接注册/查询定时任务，用于独立验证闹钟链路是否真的落地，
    // 不必依赖模型自觉完成两段调用。共享令牌本身即全权 operator 凭据，不外泄。
    tools: { allow: ['cron'] },
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
//
// 线上实测（2026-09-06 10:57 那次 5 分钟闹钟）失败的完整根因链：
//   1. 官方技能教的是两步（qqbot_remind 拿参数 → cron 落地），第二步一漏就静默失败；
//   2. 更致命的是官方示例把时间写成 "atMs": {当前时间戳 + N*60000}，模型照抄成
//      算术表达式 "atMs": 1788697580868 + 180000 —— 这不是合法 JSON，
//      参数解析失败后整个 job 退化成废字符串，网关拒收，闹钟压根没进调度器。
//      本地复测该写法：job 参数 5/6 次是无法解析的字符串，真实落地率仅 1/6。
// 故这里改成：单次 cron 调用 + 用 ISO-8601 的 \`at\` 字段（官方 schema 原生支持，
// 内部本就会把 atMs 转成 at 的 ISO 串）。人类可读时间做加减不涉及 13 位数字运算，
// 从结构上消灭了算术表达式；同时少一跳，省掉一整个模型往返（实测那一跳 12 秒）。
const AGENTS_MD = `# 本机器人硬规则

## 定时提醒：只用一次 \`cron\` 调用搞定
用户说"提醒/闹钟/定时/N分钟后/每天X点/叫我"时，**直接调 \`cron\` 工具一次**
（不要先调 \`qqbot_remind\` 再调 \`cron\`，两步容易漏第二步导致闹钟没设上）。

一次性提醒（N 分钟/小时后）：
\`\`\`json
{
  "action": "add",
  "job": {
    "name": "提醒-{事项}",
    "schedule": { "kind": "at", "at": "2026-09-06T20:15:00+08:00" },
    "sessionTarget": "isolated",
    "wakeMode": "now",
    "deleteAfterRun": true,
    "payload": { "kind": "agentTurn", "message": "用一句温暖的话提醒用户：{事项}。直接输出提醒本身，不要解释你是谁，2 句以内，可加 emoji。" },
    "delivery": { "mode": "announce", "channel": "qqbot", "to": "{用户openid}", "accountId": "default" }
  }
}
\`\`\`

周期提醒（每天/每周）：把 \`schedule\` 换成
\`{ "kind": "cron", "expr": "0 8 * * *", "tz": "Asia/Shanghai" }\`，并去掉 \`deleteAfterRun\`。

### 时间字段的硬性写法（最容易出错，务必照做）
用 \`at\`，值是**带 +08:00 时区的 ISO-8601 字符串**，例如 \`"2026-09-06T20:15:00+08:00"\`。

算法：从你上下文里的当前北京时间取"时:分"，加上用户要的分钟数，写成 ISO 串。
比如现在 20:12、用户说"3分钟后"，就写 \`"2026-09-06T20:15:00+08:00"\`；跨小时进位
（20:58 + 5 分钟）写成次一小时 \`"...T21:03:00+08:00"\`，跨天则日期 +1。

**绝对禁止**在 JSON 里写任何算术式、表达式或占位符。以下全是错的，会让闹钟静默失效：
- ✗ \`"at": 当前时间戳 + 180000\`
- ✗ \`"atMs": 1788697580868 + 180000\`（**这是真实发生过的故障**：JSON 不允许运算，解析直接失败）
- ✗ \`"at": "{3分钟后}"\`、\`"at": "now+3m"\`、\`"at": "3m"\`
JSON 里只能出现**已经算好的字面值**。你不确定当前时间就先调 \`session_status\` 查，
查到后自己把最终时刻算出来再填。

其余要点：
- \`payload.kind\` 必须是 \`"agentTurn"\`（\`systemEvent\` 不会发 QQ 消息）；
- \`to\` 填当前对话用户的 openid；群聊填 \`"qqbot:group:{group_openid}"\`；
- 只有 \`cron\` 返回成功后才能回复"已设定"。**没调 cron 就回话等于闹钟没设上，到点不会响**；
- 你没有后台线程，口头承诺无效；调用失败就如实说没设上，不要假装成功。

查询用 \`{"action":"list"}\`，取消用 \`{"action":"remove","jobId":"..."}\`。

## 时区
用户在北京时间（UTC+8），系统已配 Asia/Shanghai。周期提醒一律带 \`"tz": "Asia/Shanghai"\`。

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
