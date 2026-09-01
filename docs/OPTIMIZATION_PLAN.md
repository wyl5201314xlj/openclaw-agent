# OpenClaw Agent 系统优化与升级执行计划

> 审查日期：**2026-09-01** ｜ 审查对象：`D:\ai\openclaw-agent`（GitHub `wyl5201314xlj/openclaw-agent`，public）
> 线上实体：Render 账号 2 · `srv-dab7hass728c739r9oq0` · 新加坡 · free · **runtime=docker** · `https://openclaw-agent-8i57.onrender.com`
> 状态：**待主人审核批准，未动任何一行业务代码**
> 原始实测输出：`docs/audit-evidence/`

---

## 零、一句话结论

系统的**骨架是对的**（多通道容灾 + 工具集 + 官方 WS 网关 + 发信队列的分层是合理的），
但**三条主干链路目前在生产环境是断的**：用户收不到答案（缺 `msg_seq`）、
检索能力是编造的（`search_tool` 假数据兜底）、保活是失效的（实测平均 95.4 分钟才打一次点）。
内存完全不是瓶颈（实测 RSS **73.18MB / 512MB**），瓶颈在正确性与可观测性。

---

## 一、需求与边界深度剖析

### 1.1 主人的真实使用形态（从代码取向与配置反推）

| 维度 | 判定 | 依据 |
| :--- | :--- | :--- |
| 主力场景 | 单人/极少数人的**私聊个人助理**，而非公开群机器人 | 只实装了提醒、生图、问答三类个人向能力；`MASTER_OPENID` 曾存在 |
| 核心诉求 | **发一句话就出结果**，不接受多轮确认 | Fast-Path 关键词直达的设计取向 |
| 延迟容忍 | 秒级期望；生图可接受数十秒但要有进度反馈 | 6s 熔断、2.5s 搜索熔断、250ms 发信队列 |
| 可靠性期望 | 提醒**必须到**，不接受静默丢失 | 专门实装了主动发信通道突破 msg_id 时效 |
| 运维期望 | 零本地负担、零人工值守 | 云端优先 + GitHub Actions 保活 |

### 1.2 三条硬指标 vs 实测现状

| 硬指标 | 实测现状 | 判定 |
| :--- | :--- | :--- |
| 内存 ≤ 512MB，余量做足缓存 | RSS **73.18MB**，无 `NODE_OPTIONS` 上限保护 | **余量巨大但零缓存**，方向应从"省内存"转为"花内存换流畅" |
| 常见指令 Fast-Path 直达 | 关键词闸门误判严重（见 P1-5），且回复发不出去（P0-1） | **未达成** |
| 7×24 不掉线、主动发信 100% 必达 | 保活脉冲 84% 的间隔 > 15 分钟；无 Resume；定时器纯内存 | **未达成** |

### 1.3 被忽略的边界（本次新识别）

1. **腾讯官方限频是硬约束，不是建议**：单聊被动回复「60 分钟内每条消息可回 4 次」，群聊「5 分钟 5 次」，
   且相同 `msg_id + msg_seq` 重复发送**必然失败**。当前"先发进度、再发报告 1/2、2/2"的三段式设计，
   必须在 `msg_seq` 递增下才成立。
2. **Render free 的休眠判定只看"入站"流量**：官方明确 "spins down a Free web service that goes 15 minutes
   without receiving any inbound traffic"。我们连向 QQ 的是**出站** WebSocket，**不计入**入站流量，
   所以保活探针不是锦上添花，而是唯一命脉。
3. **公网 URL 就是攻击面**：`/api/dispatch`、`/api/tasks` 目前零鉴权（已实测），
   主人要求"移除认主"针对的是 QQ 侧，HTTP 管理面不设防是另一回事。
4. **免费额度是共享资源**：Render free 每月 750 实例小时（7×24 = 720 小时，刚好卡线），
   Agnes Key2 的 pro 系模型实测已「用户额度不足, 剩余额度: ￥0」。

---

## 二、代码审查结论：缺陷清单

标注规则：**【实测确认】**= 本轮有原始 stdout／官方文档原文佐证；**【代码推演】**= 逻辑可确定但未触发实证。

### P0 — 让核心功能在生产环境实际不可用

#### P0-1 QQ 被动回复缺 `msg_seq`，第 2 条起必然发送失败 【实测确认】

`lib/qq_bot.js:213` 的请求体只有 `content / msg_type / msg_id`，从不带 `msg_seq`。

- 腾讯官方文档（`bot.q.qq.com/wiki/.../message/overview.html`，上次更新 2026-07-21）原文：
  「相同 msg_id 可能多次推送，请结合 msg_seq 去重。**被动回复时，相同的 msg_id + msg_seq 重复发送会失败**，
  可递增 msg_seq 实现对同一消息的多次回复。」
- 腾讯官方 SDK botpy `botpy/api.py:1390 / 1413`（`post_group_message`）与 `:1436 / 1459`（`post_c2c_message`）
  均显式声明 `msg_seq: int = 1`，注释同上。

**后果**：每条用户消息代码要回 2～3 条（先「🧠 正在启动 ReAct…」，再「执行报告 1/2」「2/2」），
第 2、3 条的 `msg_id + msg_seq` 与第 1 条完全相同 → 服务端拒收。
**用户永远只收到"正在启动"，收不到真正的答案**；生图同理，只收到"正在渲染"。

**两处加剧**：
- `sendDirect` 的 `catch (err) {}`（`qq_bot.js:224-234`）把错误全吞，线上零日志、零告警；
- 400 兜底 `delete body.msg_id` 后重发，把一条**被动回复**降级成**主动消息**——既掩盖了真正病因，
  又消耗主动消息配额，且用户一旦在 QQ 客户端关掉「允许主动发送」就直接失败。

#### P0-2 `search_tool` 失败时编造事实，并当作"工具返回的事实数据"喂给模型 【实测确认】

`lib/tools/search_tool.js:36-38` 的兜底 return 是一句伪造的通用话术。

**Render 容器内的真实 Observation**（公网 GET `/api/tasks` 取得）：

```json
[{"title": "最新事实检索",
  "snippet": "关于 \"Node.js 22 LTS版本 当前稳定版 2024\" 的最新动态：该领域当前正在快速演进并受到广泛关注。"}]
```

本地两次查询（`Node.js 22 latest LTS version number`、`Render free tier 512MB 内存限制`）同样全部命中该编造串。

**后果**：所谓"全网实时检索"能力**事实上不存在**；`agent_engine.js:94` 还把它以
「【外部工具执行返回事实数据】」的名义交给模型 → 模型据此写出自信的"专业报告"。
这是本次审查里危害最大的一类缺陷：**幻觉注入**，且调用方无法区分成功与失败。

**附带缺陷**：即使 DDG 抓取成功，正则只取 `result__snippet`，标题写死为「搜索结果 #N」、
**URL 被完全丢弃** → 无法溯源、无法把结果交给 `read` 做二次深读。

#### P0-3 ReAct 只有固定两步，第二轮再吐 JSON 就原样泄漏给用户 【实测确认】

`lib/agent_engine.js:90-100` 执行完一次工具后直接把第二轮输出当最终答案，不再解析。

**线上真实 result 前 300 字**：

```
{"thought": "搜索结果不够具体，需要更精确的查询来获取Node.js 22 LTS的具体版本号。让我重新搜索更精确的信息。",
 "action": "search", "param": "Node.js 22.11.0 LTS Codename Iron"}
```

**后果**：用户收到裸 JSON 当"执行报告"；且因为不循环，第一次没搜到就永远没机会补救。
另外 `agent_engine.js:57` 的抽取正则 `/\{[\s\S]*"action"...[\s\S]*\}/` 是贪婪的，
会从第一个 `{` 吃到最后一个 `}`，正文里带花括号或出现两段 JSON 时必然解析失败并被空 catch 吞掉。

#### P0-4 保活机制实测失效，7×24 不成立 【实测确认】

`cloud-heartbeat` 最近 100 次 workflow run 的 99 段相邻间隔统计：

| 指标 | 实测值 |
| :--- | :--- |
| 平均间隔 | **95.4 分钟** |
| 最大间隔 | **546.2 分钟（9.1 小时）** |
| 超过 15 分钟的空窗 | **83 / 99 段 = 84%** |
| keeper.yml 声明的 cron | `*/8 * * * *`（每 8 分钟） |

原因两条，均有官方依据：
- GitHub 官方：`schedule` 事件在高负载期会被延迟，"**some queued jobs may be dropped**"；
  且 `cloud-heartbeat` 实测 `private=True`，私有仓库的定时任务尤其容易被降级/跳过。
- Render 官方：free web service 连续 15 分钟无**入站**流量即 spin down。

**后果链**：容器大部分时间在睡 → 每次休眠都会切断 QQ 长连接 →
**内存里所有未触发的定时提醒全部静默蒸发**（`timer_tool` 无任何持久化）。

另：`sentinel.yml` 单次运行 12 轮 × 180s ≈ **36 分钟**、声明每 20 分钟调度一次。
按声明频率算会远超私有仓库 2000 分钟/月的免费额度；实际因为 cron 本身大量被跳过才没爆
（Actions 用量 API 实测返回 404，PAT 权限不足，**未能取到确切的已用分钟数，此项标记为未验证**）。
更关键的是它探测的两个节点是 `bot.123458.online` 与 `qq-bot-minimax.onrender.com`
（**账号 1 的 QQ 机器人**），**完全没有覆盖 openclaw-agent** —— 所谓"第二道防线"对本项目是空的。

---

### P1 — 严重影响流畅度与可靠性

#### P1-1 6s 硬熔断与真实生成耗时严重错配 【实测确认】

`lib/model_router.js:75` 的 `timeout: 6000` 是写死的，与 `options.timeoutMs` 完全无关。

同一负载（400 字中文，`max_tokens=1500`）实测：

| 通道 / 模型 | 真实耗时 | 6s 内完成 |
| :--- | ---: | :---: |
| agnes-key1 / agnes-2.5-flash | 2936 ms | ✅ |
| agnes-key1 / agnes-2.5-pro | 4655 ms | ✅ |
| agnes-key1 / agnes-2.0-flash | **13828 ms** | ❌ |
| agnes-key2 / agnes-2.5-flash | **16582 ms** | ❌ |
| agnes-key2 / agnes-2.0-flash | 2383 ms | ✅ |

同一模型换把 Key 波动 **5.6 倍**。6s 一刀切会把**已经生成一半的长回答直接丢弃**，
既浪费已产出的 token，又把请求推进后面那条大部分已死的容灾链。

顺带纠正一处**文档与代码不符**：所谓"6s 超时 + 60s 无限循环容灾"，
代码实际是 `for (round = 1; round <= 2; ...)` 固定两轮 + 默认 25s 总预算（`agent_engine` 传 30s）；
且外层 `for (const provider ...)` **不检查截止时间**，只有内层 model 循环检查 → 最坏耗时 ≈ 预算 + 6s。

#### P1-2 "三级立体容灾"实际只剩一级 【实测确认】

按 `model_router.js` 配置的顺序逐个实打实调用（2026-09-01，长负载）：

| 层级 | 配置模型 | 实测结果 |
| :--- | :--- | :--- |
| 第二层 luoying | `minimax-m3` | **HTTP 524 网关超时（30s）** |
| | `deepseek-v4-flash-0731` | HTTP 503 `model_not_found` |
| | `qwen-3.8` / `deepseek-v4` / `gpt-5.4` | HTTP 403「模型未启用或不存在」 |
| 第三层 xkiro | `minimax-m2.7` / `gpt-5.4` | **HTTP 403 `error code: 1010`（Cloudflare 整站拦截）** |

→ **落樱 5 个配置模型 0 可用，xkiro 救援层 100% 死亡**（连 40 分钟前基准里还能用的
`qwen/qwen3-vl-plus:free` 也已变成 1010）。系统真实算力 = **只有 Agnes 一家两把 Key**，是单点。

同时存在**实测可用但没进容灾链**的模型：

| 通道 | 模型 | 长负载耗时 |
| :--- | :--- | ---: |
| luoying | `gemini-3.6-flash` | 5997 ms |
| luoying | `deepseek-v4-flash-vision-exp` | 6193 ms |
| luoying | `dots3-note-prev` | 8140 ms |
| agnes-key1 | `agnes-2.5-pro-beta` | 5397 ms |
| agnes-key1 | `agnes-2.5-pro-alpha` | 7270 ms |

#### P1-3 生图超时恰好卡在成功边界上 【实测确认】

`lib/tools/image_tool.js:32` 设 `timeout: 45000`，而 `agnes-image-2.1-flash` 实测真实耗时：

- KEY1 → HTTP 200，**44028 ms**
- KEY2 → HTTP 200，**46884 ms**

→ 约一半请求会在**即将成功时**被掐断，再换第二把 Key 又等 45s，最坏 90s 后报"所有生图通道均不可用"。
（端点本身是健康的，两把 Key 都真实返回了图片 URL。）

#### P1-4 生图发的是未报备外链，且没走官方富媒体通道 【实测确认（官方文档）】

- 官方文档（消息模板页）原文：「如果发送的消息中包含链接（网页、图片、视频链接等），
  **需要提前在机器人管理端报备**，操作路径：开发设置 → 消息 URL 配置。」
- 官方正解是先上传富媒体拿 `file_info`，再用 `msg_type=7` 发送（overview 页明确列出单聊上传/群聊上传/分片上传）。
- 现状：`qq_bot.js:146` 直接发纯文本 `高清直链: https://cos-platform-outputs.agnes-ai.cn/....png`，
  域名未报备 → 大概率被拦；即便发出去也只是一条链接，不是图片。
- 分支缺陷：`generateImage` 可能只返回 `b64_json`（`image_tool.js:38`），
  此时 `qq_bot.js:148` 只回一句「🖼️ 画作已渲染完成！」，什么都没给用户。

#### P1-5 定时提醒的时间解析大面积错误 【实测确认】

`lib/tools/timer_tool.js:7-19` 实测：

| 用户说法 | 实际解析 | 应为 |
| :--- | :--- | :--- |
| 下午3点提醒我开会 | **180s（3 分钟）** | 当天 15:00 |
| 明天早上8点提醒我起床 | **180s** | 次日 08:00 |
| 晚上9点半提醒我洗澡 | **180s** | 当天 21:30 |
| 一分钟后提醒我 | **180s** | 60s |
| 半小时后提醒我 | **180s** | 1800s |
| 30分钟后提醒我开会 | 1800s ✅ | 1800s |
| 2小时后提醒我吃药 | 7200s ✅ | 7200s |

绝对时刻、中文数字、"半小时"三类全部落到 `|| 180` 默认值，**而且不报错、不告知用户**。

配套的意图闸门 `qq_bot.js:126` 是 `含"提醒" && 含(后|分|秒|点)`，于是：
- 「下午3点提醒我开会」被静默设成 3 分钟后触发；
- 「**提醒我看一下这道题的得分**」因含"分"被误判成定时任务（实测解析成 180s），而不是去回答问题。

提醒正文提取 `content.replace(/.*(?:后|在)/, '')` 是**贪婪**匹配到最后一个 后/在，
实测「下午3点提醒我开会」→ 正文变成「下午3点开会」（时间没剥掉）。

#### P1-6 定时器纯内存、零持久化 【代码推演】

`timer_tool.js:4` 的 `this.timers = new Map()` 与 `setTimeout` 全在进程内。
叠加 P0-4 的休眠与 Render 每次部署重启，**所有未触发的提醒静默蒸发**，用户完全无感知。
这与"主动发信 100% 必达"直接冲突。

---

### P2 — 稳定性、安全与工程卫生

#### P2-1 `/api/dispatch` 与 `/api/tasks` 完全无鉴权 【实测确认】

本轮从公网直接：`POST /api/dispatch` → `HTTP 200 {"message":"Task dispatched successfully"}`；
`GET /api/tasks` → 读到完整任务记录，含 goal 原文、模型思考过程、工具 Observation。

**后果**：(a) 任何人可无限下发任务，白烧 Agnes 额度并把 512MB 容器压满；
(b) **任何 QQ 用户与机器人的对话内容都可被公网任意读取**。
请注意这与"移除 QQ 侧认主"是两件事——QQ 侧开放，不等于 HTTP 管理面要裸奔。

#### P2-2 `/api/dispatch` 不 await，浮动 Promise 且无并发上限 【代码推演】

`server.js:39` `agent.processGoal(goal)` 未 await 即返回 200：调用方拿不到成败，
服务端也没有并发闸门。10 个并发请求 = 10 条 ReAct 链 × 每条两次 1500-token 调用。

#### P2-3 进程级异常兜底缺失 【代码推演】

全项目没有 `process.on('unhandledRejection')` / `('uncaughtException')`。
最具体的崩溃路径：`qq_bot.js:99-103` 的 `setInterval` 回调里 `this.ws.send()`
在 socket 处于 CLOSING 状态时会**同步抛异常**，而 setInterval 回调里的同步异常
= uncaughtException = **Node 进程直接退出**。

#### P2-4 重连无退避、无 Resume、无并发保护 【代码推演】

- `qq_bot.js:66/70` 固定 3s / 5s 重连，网关侧故障时高频重连易触发腾讯限频；
- `sessionId`（:89）与 `lastSeq`（:81）存了却**从不使用**，没有 op 6 Resume
  → 断线窗口内的消息永久丢失，与"100% 必达"冲突；
- 无 `isConnecting` 守卫、旧 ws 不销毁：一旦 `connect()` 被重入，会出现两个 socket 同时收消息
  → **重复回复**（且第二条必然因 P0-1 的 msg_seq 冲突而失败）。

#### P2-5 六处空 catch 吞掉全部异常 【实测确认】

`qq_bot.js:62`、`:201`、`:232`、`agent_engine.js:61`、`sendDirect` 内层、`image_tool` 部分分支。
直接后果：本次审查中几乎每一个故障都只能靠外部黑盒探测反推，线上完全不可观测。

#### P2-6 git remote URL 内嵌明文 PAT 【实测确认】

`git remote -v` 输出形如 `https://wyl5201314xlj:ghp_S0D5****@github.com/...`。
违反全局规则第八条硬红线（凭据只走 `D:\Tools\creds.py` / `git-askpass.py`）。
虽不会随 push 外泄，但已明文落盘，且会出现在任何 `git remote -v` / CI 日志里。
**建议轮换该 PAT，并把 remote 改为不含凭据的纯 URL + askpass 取用。**

#### P2-7 构建不可复现 + 三个死依赖 【实测确认】

- **无 `package-lock.json`**，Dockerfile 用 `npm install --omit=dev --legacy-peer-deps`
  → 每次部署重新解析 semver 范围，上游一个 minor 就能悄悄改变线上行为。
- 依赖引用实测（grep 全仓）：`mysql2` **零引用**、`basic-ftp` **零引用**；
  `msedge-tts` 仅被 `lib/tools/voice_tool.js` 引用，而 `voice_tool.js`
  **没有任何文件 require 它** → 三个依赖全是死重量。

#### P2-8 无内存上限保护（但余量巨大） 【实测确认】

Render 环境变量实测 9 个（`AGNES_API_KEY`、`AGNES_API_KEY_2`、`LUOYING_API_KEY`、`XKIRO_API_KEY`、
`MASTER_OPENID`、`NODE_ENV`、`PORT`、`QQ_APP_ID`、`QQ_APP_SECRET`），**没有 `NODE_OPTIONS`**。
512MB cgroup 下建议显式给 V8 老生代封顶，避免其按宿主可见内存把堆设得过大而 OOM。
当前 RSS 仅 **73.18MB** → 有 400MB+ 余量，策略应从"省内存"转向"花内存换流畅"。

#### P2-9 `render.yaml` 与真实部署方式不一致 + 无效环境变量 【实测确认】

Render API 实测 `runtime=docker` → 线上走的是 **Dockerfile**，
`render.yaml` 里的 `runtime: node` / `buildCommand` / `envVars` **全部不生效**
（环境变量是在控制台单独配的 9 个）。留着只会误导后续维护。
另 `MASTER_OPENID` 已配置但代码从不读取（认主已移除）→ 无效变量。

#### P2-10 发信队列无界、无优先级、间隔与官方配额不匹配 【实测确认（官方文档）】

- `sendQueue` 是无界数组，叠加 P2-1 的公网刷任务会无限堆积；
- 时效敏感的定时提醒（主动消息）与普通回复共用一条队列、无优先级；
- 固定 250ms ≈ 4 条/秒，而官方未认证机器人单聊主动消息限 **5/qps 且 20~30/qpm**、
  群 **30/qpm**（≈0.5 条/秒）→ **分钟级配额会被击穿**，突发时被限频。

#### P2-11 已排查确认**不是**问题的几处（避免后续误改）

- `agent_engine.js:24` 的 `this.tasks` 有 `length > 50` 上限并 `pop()` 淘汰，**不是内存泄漏**；
  但每条记录带完整 Observation（搜索 JSON + 网页 500 字切片），配合 P2-1 的公网可读性
  属于**隐私问题**而非内存问题。
- `qq_bot.js:108` 的 intents `(1<<25)|(1<<30)|(1<<1)` 中 `1<<25` 正是 QQ 群/C2C 事件位，
  线上 `/health` 实测 `qqBotConnected: true`，**鉴权链路正常**（`1<<1` GUILD_MEMBERS 属多余，可清理但无害）。
- `getAccessToken` 有 60s 提前刷新窗口，逻辑正确；只是缺并发去重（多个调用会各发一次请求），属优化项非缺陷。
- `reader_tool.js` 实测正常：`https://nodejs.org/en/about/previous-releases` → 3308ms、返回 4000 字真实正文。
- 本轮探针用 curl POST `/api/dispatch` 时中文 goal 出现乱码，经排查是 **Git Bash 命令行编码**问题，
  非服务端缺陷（QQ 消息走 WebSocket UTF-8 JSON，不受影响），**不计入 Bug**。

---

### P3 — 面向"丝滑体验"的增强项（当前完全缺失）

| # | 缺失能力 | 现状影响 |
| :--- | :--- | :--- |
| P3-1 | **多轮会话记忆** | 每条消息完全无状态，追问「那它和 Redis 比呢」必然答错 |
| P3-2 | **本地回答/检索缓存** | Agnes 侧有相同 prompt 缓存（实测 3273ms→422ms→**61ms**），但换 Key 即失效；本地零缓存，白扔 400MB 余量 |
| P3-3 | **Fast-Path 判定质量** | `startsWith('画')` 与 `includes('画一只')` 的拼凑导致「帮我画个猫」进不了生图分支，行为不一致 |
| P3-4 | **渐进式反馈** | 长任务只能干等；`msg_seq` 修好后才有条件做"先发进度、再发结论" |
| P3-5 | **token 预算分级** | `max_tokens: 1500` 一刀切，短问答按长文成本走，拖慢首字延迟 |
| P3-6 | **自检端点** | 本次所有故障都靠外部探测才暴露，应有 `/api/selftest` 逐项打通道 |

---

## 三、分阶段执行计划

原则：**先把断的接上（正确性）→ 再把慢的提速（体验）→ 最后把脆的加固（韧性）**。
每阶段独立可交付、可回滚，每项都给出可复核的验收标准。

### 阶段 0 · 止血（覆盖 P0，目标：让用户真的能收到答案）

| # | 动作 | 修改范围 | 预期效果 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| 0-1 | `sendDirect` 增加**按 msg_id 维度自增的 `msg_seq`**；同一 msg_id 的回复计数落 LRU（TTL 60 分钟，对齐单聊有效期）；超出配额（单聊 4 次 / 群聊 5 次）时自动合并剩余内容或降级为主动消息并**明确告知用户** | `lib/qq_bot.js` | 多段回复真正送达 | 私聊与群聊各发一条需要分段的长问题，**收到全部分段**；日志打印每条的 `msg_seq` 与 HTTP 状态 |
| 0-2 | 移除所有空 catch，改为**分级结构化日志**（含 QQ 返回的 `code/message/trace_id`）；`sendDirect` 失败必须冒泡到调用方 | `lib/qq_bot.js`、`lib/agent_engine.js`、`lib/tools/*` | 线上可观测 | 人为构造一次发信失败，`/health` 与日志能看到具体错误码 |
| 0-3 | 删除 `search_tool` 的**编造兜底**，改为返回显式失败对象 `{ok:false, reason}`；`agent_engine` 收到失败时如实告知用户"检索通道不可用"，**禁止让模型基于空数据编报告** | `lib/tools/search_tool.js`、`lib/agent_engine.js` | 彻底消除幻觉注入 | 断网条件下提问，用户收到的是"检索失败"而不是编造结论 |
| 0-4 | 重建检索通道：抓取结果**必须带 title + url + snippet**；主通道换为多源并发（DDG html / Bing / SearXNG 多实例）+ Jina Reader 兜底；从 Render 容器内实测通道可用性 | `lib/tools/search_tool.js`（重写） | 检索能力从"不存在"变为"真实可用且可溯源" | 线上 `/api/selftest` 返回真实搜索结果条数 ≥ 3 且每条含真实 URL |
| 0-5 | ReAct 改为**真闭环**：最多 N 轮（建议 3），每轮都解析 action；输出终稿前强制剥离 JSON；JSON 抽取改用**非贪婪 + 括号配对**扫描 | `lib/agent_engine.js` | 不再泄漏裸 JSON，多步调研可用 | 复现本次用例「Node.js 22 最新 LTS 版本号」，最终回答为自然语言且含真实版本号 |
| 0-6 | 保活换主力通道：改用 **Cloudflare Workers Cron Trigger**（主人已有 Cloudflare 凭据）每 5 分钟打点，GitHub Actions 降为备份；同时把 `sentinel.yml` 的目标补上 openclaw-agent 并把 12×180s 的长驻改为短任务 | `D:\ai\cloud-heartbeat`（+ 新建 Worker） | 真正做到 7×24 不休眠 | 连续 24 小时统计打点间隔，**最大间隔 < 15 分钟、超时段占比 0%** |
| 0-7 | 定时器**持久化**：落 Cloudflare KV 或 HelioHost MySQL；进程启动时重建未触发任务，已过期的立即补发并说明延迟原因 | `lib/tools/timer_tool.js` + 存储适配层 | 重启/休眠不再丢提醒 | 设一个 10 分钟后的提醒，中途手动 redeploy，**提醒仍准时到达** |

### 阶段 1 · 提速与容灾重构（覆盖 P1）

| # | 动作 | 修改范围 | 预期效果 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| 1-1 | 超时模型重做：**首字节超时**（建议 4s，判活）与**总体超时**（建议 25s，判完）分离；启用 **SSE 流式**，首 token 到达即视为通道健康，不再中途丢弃长回答 | `lib/model_router.js` | 长回答不再被腰斩，首字延迟可感知下降 | 400 字中文任务成功率从当前抽样水平提升到 ≥ 95%，且不再出现"模型请求超时" |
| 1-2 | 按**实测数据**重排容灾链：一层 `agnes-2.5-flash`(双 Key) → 二层 `agnes-2.5-pro` / `agnes-2.5-pro-beta` → 三层 luoying `gemini-3.6-flash` / `deepseek-v4-flash-vision-exp` / `dots3-note-prev`；**移除全部 403/404/1010 死模型**；xkiro 整站降级为"探活后才启用" | `lib/model_router.js` | 每次失败少烧 6 次无效往返，真实具备 3 层 | 断掉 Agnes 两把 Key 后仍能出答案；`stats` 中 failovers 显著下降 |
| 1-3 | 增加**通道健康度熔断器**：连续失败 N 次的 provider/model 进入冷却（指数退避），冷却期直接跳过；探活成功自动恢复 | `lib/model_router.js` | 死通道不再拖慢每一次请求 | 死模型在首次失败后不再被重复尝试 |
| 1-4 | 生图超时从 45s 提到 **90s**；改为**先回执 + 后推送结果**两段式；结果走**官方富媒体通道**（上传拿 `file_info` → `msg_type=7`），并把 `agnes` 的输出域名在机器人管理端报备作为兜底；补齐 `b64_json` 分支（上传 base64 而非静默丢弃） | `lib/tools/image_tool.js`、`lib/qq_bot.js` | 生图**真的能看到图** | 发「画一只猫」，QQ 收到的是**图片消息**而非链接文本 |
| 1-5 | 时间解析重写：支持绝对时刻（今天/明天 + 时:分 + 上午/下午/晚上）、中文数字、"半小时/一刻钟"、跨天推断；**解析置信度低时不静默默认**，回问一次或明确回显解析结果让用户确认 | `lib/tools/timer_tool.js` | 提醒时间准确 | 本文档 P1-5 表格中 7 个用例**全部解析正确**，并新增单元测试固化 |
| 1-6 | Fast-Path 判定重做：意图识别改为**轻量规则 + 极速模型二段确认**（`agnes-2.5-flash` 实测 264ms，成本可忽略）；「提醒我看一下这道题的得分」这类必须落到问答而非定时器 | `lib/qq_bot.js`（抽出 `lib/intent.js`） | 误判归零，同时保住直达速度 | 构造 20 条边界语料的回归用例，误判率 0 |

### 阶段 2 · 体验增强（覆盖 P3，把 400MB 余量花掉）

| # | 动作 | 修改范围 | 预期效果 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| 2-1 | **多轮会话记忆**：按 openid 维度维护滚动窗口（建议 6 轮 / 4000 token，LRU + TTL 30 分钟），内存占用可控在 20MB 内 | 新增 `lib/session_store.js` | 支持追问、指代、上下文延续 | 连续三轮对话，第三轮正确理解"它"指代前文对象 |
| 2-2 | **三级缓存**：① 检索结果缓存（TTL 10 分钟）② 网页正文缓存（TTL 1 小时）③ 高频问答精确缓存（TTL 5 分钟）。全部带内存水位上限与 LRU 淘汰 | 新增 `lib/cache.js` | 重复/相似请求近乎瞬时 | 同一问题第二次响应时间下降 > 70%；RSS 峰值 < 300MB |
| 2-3 | **渐进式反馈**：把「已收到 → 正在检索 X → 正在综合」压缩进配额允许的段数内，长任务不再让用户干等 | `lib/qq_bot.js` | 等待期有明确进度 | 复杂调研任务过程中至少收到一次中间进度 |
| 2-4 | **token 预算分级**：短问答 512 / 常规 1024 / 深度调研 2048，由意图分类决定 | `lib/agent_engine.js` | 短问答首字更快、成本更低 | 简单问答端到端 < 1.5s（缓存未命中） |
| 2-5 | 新增 `/api/selftest`（需鉴权）：逐项探活模型通道、搜索、Jina、生图、QQ token、内存水位，返回结构化报告 | `server.js` + 新增 `lib/selftest.js` | 故障 5 秒定位，不再靠外部黑盒反推 | 人为断掉某通道，selftest 精确指出是哪一项 |

### 阶段 3 · 韧性与工程卫生（覆盖 P2）

| # | 动作 | 修改范围 | 预期效果 | 验收标准 |
| :--- | :--- | :--- | :--- | :--- |
| 3-1 | HTTP 管理面加鉴权：`/api/dispatch`、`/api/tasks`、`/api/selftest` 统一走 `ADMIN_TOKEN` 请求头校验 + 简单速率限制；`/health` 保持公开但**移除敏感统计明细**（保活探针只需 200） | `server.js` | 关闭公网刷额度与对话内容泄漏两个口子 | 无 token 访问返回 401；保活探针仍正常 |
| 3-2 | 全局兜底：`unhandledRejection` / `uncaughtException` 记录后优雅处理；心跳 `ws.send` 包 try/catch 并在异常时主动触发重连 | `server.js`、`lib/qq_bot.js` | 单点异常不再拖垮进程 | 人为触发 CLOSING 状态下发心跳，进程存活并完成重连 |
| 3-3 | WS 连接管理重写：`isConnecting` 单例守卫 + 旧 socket 强制销毁 + **指数退避 + 抖动**（1s→2s→4s…上限 60s）+ 实现 **op 6 Resume**（用已存的 `sessionId`/`lastSeq`）+ op 7/9 正确处理 | `lib/qq_bot.js` | 断线不丢消息、不重复回复、不被限频 | 强制断开网关后自动 Resume，断线期间的消息补收成功 |
| 3-4 | 发信队列升级：**有界队列**（超限拒绝并告知）+ 双优先级（主动提醒优先）+ **令牌桶限速**对齐官方 qps/qpm 配额 | `lib/qq_bot.js` | 不再被限频，不再无界堆积 | 压测 50 条突发消息，无一条因限频丢失 |
| 3-5 | 依赖与构建收敛：删除 `mysql2` / `basic-ftp`；`voice_tool.js` 与 `msedge-tts` **要么接入语音消息、要么一并删除**（待主人决策）；生成并提交 `package-lock.json`，Dockerfile 改 `npm ci --omit=dev` | `package.json`、`Dockerfile`、`lib/tools/voice_tool.js` | 构建可复现、镜像更小更快 | `npm ci` 成功；镜像层缩小；`docker build` 两次产出一致 |
| 3-6 | 显式内存护栏：Render 环境变量加 `NODE_OPTIONS=--max-old-space-size=384`；`/health` 增加内存水位告警阈值；删除无效的 `MASTER_OPENID` | Render 控制台 + `server.js` | 杜绝 cgroup OOM | 压测下 RSS 峰值 < 450MB，无 OOM 重启记录 |
| 3-7 | 清理 `render.yaml`（与 docker 部署不符，改为注释说明或删除）；README 与实现对齐（当前 README 宣称的 HelioHost 关系库、InfinityFree 仓储、语音 TTS 均未接线） | `render.yaml`、`README.md` | 文档不再误导 | README 每一条特性都能在代码里指到实现 |
| 3-8 | **轮换 GitHub PAT**，`git remote` 改为不含凭据的纯 URL，推送统一走 `D:\Tools\git-askpass.py` | `.git/config` + 凭据库 | 消除明文凭据落盘 | `git remote -v` 输出不含任何 token；推送仍成功 |

---

## 四、需要主人拍板的四个岔路口

这四项存在多条截然不同的技术路线，且会改变架构走向，**动工前请主人明确选择**：

### 决策 1 · 保活主通道选谁？

| 方案 | 优点 | 代价 |
| :--- | :--- | :--- |
| **A. Cloudflare Workers Cron**（推荐） | 主人已有凭据；免费额度足；分钟级可靠触发 | 需新建一个 Worker |
| B. Alwaysdata 容器 crontab | 主人已有 Linux 容器，最直白 | 与"该容器本身也要活着"耦合 |
| C. 把 cloud-heartbeat 改为 public 仓库 | 改一个开关，零代码 | 仍是 GitHub best-effort，只是概率变好；仓库内容公开 |
| D. 升级 Render 付费实例 | 一劳永逸，无休眠 | 要花钱 |

### 决策 2 · 定时器持久化落在哪？

Cloudflare KV（最轻，最终一致）／ HelioHost MySQL（强一致，主人已有）／ Cloudflare D1（SQLite 语义）。
**建议 Cloudflare KV**：定时提醒的数据量与一致性要求都很低，KV 足够且延迟最低。

### 决策 3 · `voice_tool` 接线还是删除？

现状是**完全的死代码**（`msedge-tts` 依赖只为它而装，而它没人调用）。
接线 = 需实现 QQ 语音富媒体上传（`msg_type=7` + silk/amr 编码，工作量不小）；
删除 = 立刻省掉一个依赖。**建议先删，等真的要语音回复时再按官方富媒体通道正经实现。**

### 决策 4 · 落樱 / xkiro 两条已死通道怎么处理？

实测两家的**配置模型全军覆没**（403/404/503/524/1010）。三个选项：
① 只保留实测可用的替代模型（luoying 的 `gemini-3.6-flash` 等），xkiro 整站移除；
② 保留占位但加熔断，等主人去两家后台重新开通模型/充值后自动恢复；
③ 引入第四家新通道补齐真实三层容灾。
**建议 ① + ②组合**：立即换成实测可用模型，并保留熔断式探活，主人后台一开通就自动接回。

---

## 五、明确不做的事（避免过度工程）

- **不引入**任何本地无头浏览器（遵循云端优先与零本地负担原则，检索一律走云端管道）。
- **不引入**重型框架（NestJS / LangChain 之类）：512MB 容器下，现有轻量分层已足够，换框架只会吃内存。
- **不恢复**任何认主/白名单拦截（主人已明确要求 QQ 侧 100% 开放；阶段 3-1 只给 HTTP 管理面加锁，不影响 QQ）。
- **不做**流式逐 token 推送给 QQ：官方限频（单聊 60 分钟 4 次）根本不允许，只能做"分段进度"。
- **不动** Render 账号 1 的任何资产（严格物理隔离；本次已核实账号 2 下仅 `openclaw-agent` 一个服务）。

---

## 六、附：本次审查的实测证据索引

| 证据文件 | 内容 |
| :--- | :--- |
| `docs/audit-evidence/render_out.txt` | Render 服务真实配置（runtime=docker、9 个环境变量键名、部署历史） |
| `docs/audit-evidence/agnes_out.txt` | Agnes 模型清单、生图端点真实耗时 44.0s / 46.9s |
| `docs/audit-evidence/latency_out.txt` | 容灾链 12 个配置模型 + 7 个候补模型的长负载实测矩阵 |
| `docs/audit-evidence/repro_out.txt` | 直接加载线上同一份 `model_router` / `agent_engine` 的端到端复现 |
| `docs/audit-evidence/tools_out.txt` | `searchWeb` 编造兜底、`readUrlContent` 正常、`parseTimeOffset` 10 组用例 |
| `docs/audit-evidence/pulse_out.txt` | 保活脉冲 99 段间隔完整清单与统计（平均 95.4 分 / 84% 超时） |
| `docs/audit-evidence/gh_out.txt` | 两个仓库可见性与 workflow run 记录 |

### 外部权威来源清单

| 来源 | URL | 支撑了哪条结论 |
| :--- | :--- | :--- |
| 腾讯 QQ 机器人官方文档 · 消息收发概述 | `https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html` | P0-1（msg_seq 去重规则）、被动回复配额（单聊 60 分钟 4 次 / 群聊 5 分钟 5 次）、主动消息频控、富媒体 `msg_type=7` 通道 |
| 腾讯官方 SDK botpy 源码 | `https://raw.githubusercontent.com/tencent-connect/botpy/master/botpy/api.py`（第 1390/1413/1436/1459 行） | P0-1（官方实现确实带 `msg_seq: int = 1`） |
| 腾讯 QQ 机器人官方文档 · 消息模板 | `https://bot.q.qq.com/wiki/develop/gosdk/api/message/message_template.html` | P1-4（消息含链接需在管理端「消息 URL 配置」报备） |
| Render 官方文档 · Deploy for Free | `https://render.com/docs/free` | P0-4（free 服务 15 分钟无**入站**流量即 spin down） |
| Stack Overflow · prevent render server from sleeping | `https://stackoverflow.com/questions/75340700/prevent-render-server-from-sleeping` | P0-4 补充（750 免费实例小时 / 月，30×24=720h 卡线） |
| Stack Overflow · Reliability issues with GitHub actions cron | `https://stackoverflow.com/questions/79534419/reliability-issues-with-github-actions-with-cron-based-schedule` | P0-4（官方说明 schedule 在高负载期会被延迟，队列任务可能被丢弃） |
| GitHub Community Discussion #201472 | `https://github.com/orgs/community/discussions/201472` | P0-4（私有仓库 scheduled workflow 不可靠的社区实证） |
| opencode-qq-bot DESIGN.md | `https://github.com/gbwssve/opencode-qq-bot/blob/master/DESIGN.md`（第 213-226、392-402 行） | P0-1 与 P2-10 的第三方实现佐证（每段回复都带递增 msg_seq） |

---

## 七、请主人审核

以上计划**尚未执行任何代码修改**（除安装 `node_modules` 以便本地复现验证、
以及归档 `docs/audit-evidence/` 原始证据外，业务源码一行未动）。

请主人：
1. 确认阶段划分与优先级是否符合预期；
2. 就第四节四个岔路口给出选择；
3. 批准后我从**阶段 0 止血**开始逐项落地，每完成一项都给出可复核的验证输出。
