# 稳定梯子：缺口分析与分阶段执行计划

> 编写日期 2026-09-03。最终目的：主人手机上有一个**长期稳定、不断线**的梯子。
> 本计划只写核实过的事实，每条结论后附验证方式。

---

## 一、现状核实（2026-09-03 实测）

| 项目 | 状态 |
| :--- | :--- |
| Render 服务 | 在线，内存 42.5MB/512MB，uptime 9.4 小时连续 |
| 保活（Alwaysdata 常驻循环） | 正常，每 5 分钟打点 |
| 节点池 | 20 个 vmess，全部 TCP 可连（抽查 10/10 通） |
| 订阅端点 `/sub/clash` | 有鉴权（无 token 返回 403），YAML 可生成（约 6.8KB） |
| 凭据库 | heliohost / alwaysdata / infinityfree / cloudflare 字段齐全 |

## 二、为打出稳定梯子，还缺的 6 样东西

### 缺 1：节点池里 19/20 个节点没有 TLS，国内会被运营商识别和干扰

实测分布：`network` 为 http 的 18 个、tcp 的 1 个、ws 的 1 个；`tls:true` 只有 1 个。
vmess + http + 无 TLS 的组合，在国内骨干网下特征明显，刷视频时 QoS 限速和间歇性 RST 是常态。
**这就是"TCP 通但刷推特卡"的直接原因。**

### 缺 2：订阅端点鉴权里硬编码了两枚真实密钥

`server.js` 第 187-188 行与 232-233 行写死了 Render API Key 与 ADMIN_TOKEN 明文。
仓库是 public，任何人 clone 下来就能拿到可完全控制 Render 服务的 Key。
**必须先清掉，否则越推广订阅、暴露面越大。**

### 缺 3：调度器里硬编码了主人 QQ 号

`node_scheduler.js` 第 82 行默认参数是主人真实 QQ 号明文，同样在 public 仓库里。

### 缺 4：没有真实带宽验证，TCP 通 ≠ 能跑视频

TCP 握手只证明端口开着。20 个节点延迟全显示 0ms（探活代码写 latency 的时机在连接回调里，
但 0ms 说明计时或写入有问题）。缺一个"下载测速定级"环节。

### 缺 5：规则只有 MATCH 全局代理，国内流量白白走节点

国内 App（微信、支付宝、银行、B 站）流量也绕海外，又慢又浪费节点寿命。
需要 DIRECT/PROXY/REJECT 三段式分流。

### 缺 6：没有独享保底，全靠免费池

免费池节点平均寿命以天计。今天 20 个全通，下周可能一半失效。
长期稳定必须有一条自己完全控制的链路。

---

## 三、分阶段执行计划

### 阶段 A：止血（今天可做，不花钱，约 1 小时）

| # | 做什么 | 改哪里 | 验证 |
|---|--------|--------|------|
| A1 | 删 server.js 两处硬编码密钥，改从环境变量 `SUB_TOKENS` 读取（逗号分隔多 token） | server.js 185-189、230-234 | 无 token 403，有 token 200；源码 grep 无密钥 |
| A2 | 删 scheduler 默认参数里的 QQ 号，改从环境变量 `MASTER_OPENID` 读，无配置则跳过推送不崩 | node_scheduler.js 82 | 未配置时早报跳过且进程不崩 |
| A3 | 早报字段补齐（regionStats/residential/minLatency/avgLatency），修每天 08:30 必崩 | node_store.js getSummaryStats | 本地调 generateCleanMorningDigest 不抛错 |
| A4 | 把 active_nodes.json 的 uuid 视为已泄漏：该文件不动（删了用户断连），但新版节点入库后覆盖旧 uuid | 无需动作，B2 覆盖 | — |
| A5 | 部署验证 + 全量测试 48 项通过 | — | npm test 全过，线上 /sub/clash 可用 |

### 阶段 B：质量（本周，不花钱，约 2-3 小时）

| # | 做什么 | 改哪里 | 验证 |
|---|--------|--------|------|
| B1 | 带宽定级：对 TCP 存活节点做 5MB 文件下载测速（8 秒超时），按实测下行排序，只留前 20 | node_prober.js 新增 speedTier | /sub/stats 返回每个节点 speedMbps |
| B2 | 延迟字段修复：latency 写真实握手毫秒数，不再是 0 | node_prober.js | 订阅 YAML 里延迟为真实值 |
| B3 | 评分记忆：server:port 维度记 successStreak/failStreak/ewma，连续失败 3 次冷冻 24h | node_store.js | 失效节点 24h 内不参选 |
| B4 | 分流规则：GEOIP,CN 直连 + 常用国内域名直连 + MATCH 走代理，附 dns 段 | node_store.js generateClashConfig | 下发的 YAML 含 rules/dns 段，手机验证国内 App 直连 |
| B5 | 部署验证 | — | 线上订阅更新，主人手机刷新订阅可用 |

### 阶段 C：独享保底（本月，花小钱，一劳永逸）

**为什么必须做**：免费池再怎么优化，单节点寿命也就几天。4K 稳定需要一条自己控制的链路。

| # | 做什么 | 说明 |
|---|--------|------|
| C1 | 主人买一台香港/日本小鸡（年付约 30-60 美元，1 核 1G 足够，只跑中转） | 需要主人付款，我给具体配置单（系统/带宽/商家避坑） |
| C2 | Agent 自动部署 VLESS+Reality（ssh 上去一键脚本，约 10 分钟） | Agent 用 alwaysdata 同款 ssh 方式操作 |
| C3 | 独享节点 pin 到订阅最前 + 单独分组"主力"，免费池降级为"备用"分组 | node_store.js 加 pinnedNodes |
| C4 | 月检任务：Reality 指纹与 SNI 存活检查，异常 QQ 通知 | node_scheduler.js 加月检 |

**备选零花钱方案**：如果暂时不想买 VPS，先用 HelioHost（主人已有，有公网 IP）做 WebSocket 中转测试，
免费但带宽小，只能保底不断线、保不了 4K。

---

## 四、可行性自审（2026-09-03 已逐项验证）

| 风险 | 验证方式与结果 |
| :--- | :--- |
| B1 测速打爆 512MB | ✅ 实测：5MB 下载 RSS 增量 12.3MB（<20MB 安全线） |
| 现有 YAML 是否合法 | ✅ 实测：yaml 回读 20 proxies 无缺字段、name 唯一 |
| A1 部署顺序 | ✅ 线上 ADMIN_TOKEN 已配，SUB_TOKENS 未配——部署时必须先配 SUB_TOKENS 再推代码，否则主人自己 403 |
| B4 GEOIP 文件 | 客户端自带 mmdb，服务端只下发规则文本，无需服务端存量 |
| C1 需主人付款 | 唯一需花钱步骤（约 30-60 美元/年），无替代；备选 HelioHost 免费但只能保不断线 |
| 密钥已泄漏无法收回 | Render Key 与 ADMIN_TOKEN 必须去后台轮换，只删源码不够（git 历史里还有） |
| 整体回滚 | 每个阶段独立提交，Render 自动部署，出问题回滚到上一个 deploy 即可 |

**结论：A+B 可独立把免费池体验推到上限（不断线、国内 App 快、刷视频不转圈）；C 是稳定 4K 的唯一解。**
