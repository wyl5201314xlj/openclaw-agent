# 免费梯子工厂：完整执行计划书

> 目标：把已 7×24 在线的机器人变成全自动免费梯子工厂——自己捞节点、每 15 分钟漂洗、测出最快的自动同步到订阅，主人手机零操作。
> 现状基线（2026-09-04 实测）：Render 在线（42MB/512MB）、保活正常、上游 1577 节点可抓（1.7 秒/66MB）、池 20 节点全 TCP 通。
> 约束：零花钱、512MB 内存红线、Render 无公网 IPv4。

---

## 第一部分：之前找出的全部问题清单（共 11 项）

| # | 问题 | 严重度 | 现状 |
|---|------|--------|------|
| 1 | server.js 硬编码 Render API Key + ADMIN_TOKEN，public 仓库可见 | P0 安全 | 未修 |
| 2 | scheduler 默认参数硬编码主人 QQ 号 | P0 安全 | 未修 |
| 3 | 早报读 regionStats/residential/minLatency/avgLatency，全是 undefined，每天 08:30 必崩 | P0 功能 | 未修，已复现 |
| 4 | TCP 通≠可用：5 个 TCP 存活节点做 TLS 握手只过 1 个，无协议层验证 | P0 功能 | 未修 |
| 5 | 延迟全显示 0ms，订阅里看不出快慢 | P1 功能 | 未修 |
| 6 | 无真实带宽验证，刷视频卡不卡全凭运气 | P1 功能 | 未修 |
| 7 | 无评分记忆，每轮重抓重测，刚失效的节点下轮又进来 | P1 功能 | 未修 |
| 8 | 规则只有 MATCH 全局代理，国内流量白走节点 | P1 体验 | 未修 |
| 9 | isp_classifier 写完没接线，家宽识别不存在（池内 isResidential 字段 0 个） | P1 功能 | 未修 |
| 10 | rateLimit 的 Map 整表 clear 式限速，可被刷掉 | P2 安全 | 未修 |
| 11 | data/active_nodes.json 含真实 uuid 已进 public 仓库历史 | P2 安全 | 已泄漏，只能轮换+不再新增 |

---

## 第二部分：执行计划（分 4 个阶段，共 14 项）

### 阶段一：止血（约 1 小时，修 P0 安全+崩溃）

| # | 做什么 | 改哪里 | 怎么做 | 验证 |
|---|--------|--------|--------|------|
| 1-1 | 删 server.js 两处硬编码密钥 | server.js 185-189、230-234 | 改从环境变量 `SUB_TOKENS`（逗号分隔）读取；为空时订阅端点返回 503 而不是放行 | 源码 grep 无密钥；无 token 403，有 token 200 |
| 1-2 | 删 scheduler 默认 QQ 号 | node_scheduler.js 82 | 改从环境变量 `MASTER_OPENID` 读；未配置则跳过推送并记日志，不抛错 | 未配置时进程不崩 |
| 1-3 | 早报字段补齐 | node_store.js getSummaryStats | 返回 total/residential/regionStats/minLatency/avgLatency，按真实池数据计算 | 本地调 generateCleanMorningDigest 不抛错 |
| 1-4 | Render 配 SUB_TOKENS + MASTER_OPENID | Render 控制台（API 写） | 先配环境变量，再推代码（顺序反了主人自己也 403） | 线上订阅可用 |
| 1-5 | 部署 + 全量测试通过 | — | npm test 全过（现有 48 项） | 测试 48/48，线上 /health 正常 |

### 阶段二：真测速（约 2 小时，TCP→TLS→带宽三级）

| # | 做什么 | 改哪里 | 怎么做 | 验证 |
|---|--------|--------|--------|------|
| 2-1 | L2 协议握手：tls 节点做真实 TLS ClientHello（Node 原生 tls 模块，约 30 行） | node_prober.js | 握手失败的节点直接淘汰，不进池 | 存活节点 TLS 通过率可观测 |
| 2-2 | 延迟字段修复：写真实握手毫秒数 | node_prober.js | finish 时 latency 取 Date.now()-startTime（已有计时，只需确认写入） | 订阅 YAML 延迟为真实值 |
| 2-3 | L3 带宽定级：对 L2 通过的前 8 个节点下 5MB 文件测速（单并发、8 秒超时） | node_prober.js 新增 | 内存增量已实测 12.3MB，安全；结果记 speedMbps | /sub/stats 返回每个节点速度 |
| 2-4 | 部署验证 | — | 线上 refresh 一轮，确认 activeCount≥3 且带速度 | 线上实测 |

### 阶段三：自动漂洗（约 2 小时，评分记忆+接线分类+分流）

| # | 做什么 | 改哪里 | 怎么做 | 验证 |
|---|--------|--------|--------|------|
| 3-1 | 评分记忆：server:port 维度记 successStreak/failStreak/ewmaLatency，存 active_nodes.json | node_store.js | 连续失败 3 次冷冻 24h；排序先 streak 分档再延迟；历史分按 6h 半衰期打折 | 失效节点 24h 内不参选 |
| 3-2 | isp_classifier 接入探活链路 | node_prober.js probeAndRankNodes | 存活节点调 classify，结果写 isResidential/tag/scoreBonus，加权进排序（+100 分已在代码里预留） | 池内 isResidential>0，早报家宽数非零 |
| 3-3 | 分流规则：GEOIP,CN 直连 + 8 个常用国内域名直连 + MATCH 走代理，附 dns 段（223.5.5.5/8.8.8.8） | node_store.js generateClashConfig | 纯文本规则，零内存成本 | 下发 YAML 含 rules/dns 段 |
| 3-4 | 调度改双轨：5 分钟快检（只洗池内 20 个 TCP）、15 分钟全量（捞新+TL S+测速+补池） | node_scheduler.js | 快检失败的标 failStreak+1 不立即踢，全量轮才淘汰补新 | 日志可见两轨各自行 |
| 3-5 | 部署验证：主人手机刷新订阅 | — | 确认国内 App 直连、刷视频走最快的节点 | 主人实测反馈 |

### 阶段四：加固（约 1 小时）

| # | 做什么 | 改哪里 | 怎么做 | 验证 |
|---|--------|--------|--------|------|
| 4-1 | rateLimit 改固定窗口计数器，不再整表 clear | server.js 71-84 | key 照旧，值改 {count, windowStart}，窗口过期自然重置 | 压测不再被刷掉 |
| 4-2 | 新增回归测试：早报不崩、TLS 分级、评分冷冻、分流规则存在 | test/ 下新增 | 断言 generateCleanMorningDigest 不抛错等 | npm test 全过 |
| 4-3 | 最终部署 + 线上 selftest + 归档证据 | — | 同既有流程 | 线上 9/9 通过口径 |

---

## 第三部分：可行性自审（逐项过一遍，不乐观冒进）

| 检查项 | 结论 |
|--------|------|
| 内存：L3 测速 5MB 单并发 | 已实测 RSS 增量 12.3MB，加上抓取 66MB、基线 42MB，峰值约 120MB，离 512MB 红线远 |
| 耗时：15 分钟全量轮 | 抓取 1.7s + TCP(60×1.5s/3并发≈30s) + TLS(约 10s) + 测速(8×8s/单并发≈64s)，合计约 2 分钟，15 分钟窗口够 |
| 5 分钟快检耗时 | 20 个 TCP 并发 5，约 6 秒，够 |
| 部署顺序死锁 | 阶段一 1-4 先配环境变量再推代码，已在计划内写死顺序；配错了最多主人 403 一次，重新配即可，无不可逆 |
| 上游源挂了怎么办 | fetcher 已有 try/catch 单源失败跳过；两源全挂则保留旧池（scheduler 里有 candidates.length===0 直接 return），不断连 |
| 免费池全灭（activeCount=0） | store 有 127.0.0.1 占位兜底 + 磁盘缓存恢复，订阅不断；且 B 轮 cron 会继续捞，源一恢复自动回血 |
| QQ 推送配额 | 早报每天 1 条，被动回复配额内；实测 msg_seq 链路已通 |
| 回滚 | 每个阶段独立提交，Render 回滚到上一个 deploy；数据文件 active_nodes.json 有 git 历史可恢复 |
| 最坏情况 | 全部免费节点失效时，用户体验退化为"订阅有个本地占位节点"，不断连、不报错，等下一轮自动回血 |

**自审结论：计划真实可行。唯一天花板是免费节点本身的带宽波动（4K 不保证），720P 及以下省心可用。**

---

## 第四部分：需要主人配合的（共 2 件，都是一次性的）

1. **批准动手**：回"动手"，我就从 1-1 开始按顺序执行，每完成一个阶段实测验证后汇报。
2. **阶段三完成后手机验证一次**：刷新 Clash 订阅，刷个视频、打开微信确认国内直连，反馈卡不卡。
