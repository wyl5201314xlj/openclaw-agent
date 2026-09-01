# OpenClaw Agent — 7×24h 云端常驻 AI 助理

QQ 官方机器人入口 + 多模型容灾 + 工具集（联网检索 / 网页抓取 / 生图 / 定时提醒）。
部署在 Render 新加坡免费实例（512MB / 共享 vCPU），线上地址
`https://openclaw-agent-8i57.onrender.com`。

> 本 README 只写**代码里真实存在**的能力。上一版曾宣称 HelioHost 关系库、InfinityFree 仓储、
> 语音 TTS，但代码里全无接线，已一并删除或改为如实描述。

## 当前实现

| 能力 | 实现位置 | 说明 |
| :--- | :--- | :--- |
| QQ 官方网关 | `lib/qq_bot.js` | WebSocket 长连接、op6 Resume、指数退避重连、令牌桶限速、`msg_seq` 递增 |
| 意图直达 | `lib/intent.js` | 定时提醒 / 生图走规则直达，其余交 ReAct；20 条边界语料回归 |
| ReAct 闭环 | `lib/agent_engine.js` | 最多 3 轮工具调用，终稿强制剥离残留 JSON，token 预算按复杂度分级 |
| 多模型容灾 | `lib/model_router.js` | 首字节/总体超时分离 + SSE 流式 + 按实测延迟排序的模型链 + 每模型熔断 |
| 联网检索 | `lib/tools/search_tool.js` | Bing / DDG(串行限速) / Wikipedia / Google News / StackOverflow 多源 RRF 融合 |
| 网页抓取 | `lib/tools/reader_tool.js` | Jina Reader 优先、直连兜底，URL 先过 SSRF 边界校验 |
| 生图 | `lib/tools/image_tool.js` | 双 Key 轮询，90s 超时（实测真实耗时 44~47s） |
| 定时提醒 | `lib/tools/timer_tool.js` + `lib/time_parse.js` | 中文时间解析（相对时长 + 绝对时刻），Cloudflare KV 持久化，重启补发 |
| 会话记忆 | `lib/session_store.js` | 按 openid 维度滚动 6 轮，30 分钟 TTL |
| 缓存 | `lib/cache.js` | 回答 / 检索 / 抓取 / 会话四路 LRU+TTL，均有条目与体积上限 |
| 自检 | `lib/selftest.js` | `/api/selftest` 逐项探活模型、检索源、抓取、持久化、SSRF 防护、QQ 凭据 |
| 出网安全 | `lib/safe_fetch.js` | 只允许 http/https，逐跳校验并阻断环回/私有/链路本地/保留地址 |

## HTTP 接口

| 路径 | 鉴权 | 用途 |
| :--- | :--- | :--- |
| `GET /health` | 公开 | 保活探针用，只返回状态与内存，不含内部统计明细 |
| `GET /api/status` | 需 `X-Admin-Token` | 网关状态、模型链熔断、缓存命中率、待办提醒数 |
| `GET /api/tasks` | 需 `X-Admin-Token` | 任务列表（`?detail=1` 返回完整步骤） |
| `GET /api/timers` | 需 `X-Admin-Token` | 待触发的提醒 |
| `POST /api/dispatch` | 需 `X-Admin-Token` | 手工下发一个目标（同步返回结果） |
| `GET /api/selftest` | 需 `X-Admin-Token` | 全链路自检（`?deep=1` 连生图一起测，约多 45 秒） |

**未配置 `ADMIN_TOKEN` 时，所有 `/api/*` 管理接口一律返回 503**，这是刻意的安全默认——
上一版这些接口在公网零鉴权，任何人都能下发任务烧额度、并读到全部对话内容。
QQ 入口不受影响，依然对所有人开放。

## 环境变量

| 变量 | 必需 | 说明 |
| :--- | :--- | :--- |
| `ADMIN_TOKEN` | 管理面必需 | HTTP 管理接口令牌 |
| `QQ_APP_ID` / `QQ_APP_SECRET` | 是 | QQ 官方机器人凭据 |
| `AGNES_API_KEY` / `AGNES_API_KEY_2` | 是 | 主力模型与生图通道 |
| `LUOYING_API_KEY` | 建议 | 第三层容灾 |
| `XKIRO_API_KEY` + `XKIRO_ENABLED=1` | 可选 | 实测整站被 Cloudflare 拦截，默认关闭 |
| `CF_ACCOUNT_ID` / `CF_KV_NAMESPACE_ID` / `CF_API_TOKEN` | 建议 | 定时提醒持久化；不配则降级为进程内存并在日志中标红 |
| `NODE_OPTIONS` | 建议 | `--max-old-space-size=384`，512MB 容器的内存护栏 |
| `TZ_OFFSET_MINUTES` | 可选 | 绝对时刻解析用的时区偏移，默认 480（北京时间） |

## 本地开发

```bash
npm ci                 # 严格按 package-lock 安装
npm test               # 运行全部单元测试
npm start              # 启动服务
```

需要真实凭据跑验证脚本时（凭据从机器级凭据库注入，不落盘）：

```bash
python scripts/run_with_creds.py router   # 模型路由实测
python scripts/run_with_creds.py agent    # ReAct 闭环实测
python scripts/run_with_creds.py server   # 带凭据启动服务
```

## 保活

Render free 实例连续 15 分钟没有**入站**流量就会休眠（连向 QQ 的是出站 WebSocket，不算入站），
因此保活是唯一命脉。

- **主通道**：Cloudflare Workers Cron，每 5 分钟（`../cloud-heartbeat/cloudflare-worker/`）
- **备份**：GitHub Actions（`../cloud-heartbeat/.github/workflows/`）

历史上只用 GitHub Actions 时实测不可靠：最近 100 次运行的 99 段间隔平均 **95.4 分钟**、
最大 **9.1 小时**、**84% 超过 15 分钟**，尽管 cron 写的是每 8 分钟。

## 相关文档

- 完整审查与优化计划：[docs/OPTIMIZATION_PLAN.md](docs/OPTIMIZATION_PLAN.md)
- 审查期间的原始实测输出：[docs/audit-evidence/](docs/audit-evidence/)
