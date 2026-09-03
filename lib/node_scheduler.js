// lib/node_scheduler.js
// 15分钟动态心跳探活与每天早晨 QQ 脱敏晨报定时调度器

const nodeFetcher = require('./tools/node_fetcher');
const nodeProber = require('./tools/node_prober');
const nodeStore = require('./node_store');
const qqBot = require('./qq_bot');

class NodeScheduler {
  constructor() {
    this.isRefreshing = false;
    this.intervalHandle = null;
    this.morningCronHandle = null;
    this.quickCheckHandle = null;
  }

  /**
   * 3-4 快检：只洗池内现有节点的 TCP，不踢人。
   * 失败的 failStreak+1（记到内存评分，下次全量轮参与冷冻判定），成功则清零。
   */
  async runQuickCheck() {
    const nodes = nodeStore.activeNodes;
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    const now = Date.now();
    let okCount = 0;
    const pool = [];
    let active = 0;
    for (const n of nodes) {
      const p = (async () => {
        while (active >= 5) await new Promise(r => setTimeout(r, 40));
        active++;
        try {
          const { alive, latency } = await nodeProber.probeTcpLatency(n.server, n.port, 1500);
          if (alive) {
            okCount++;
            n.failStreak = 0;
            n.successStreak = (Number(n.successStreak) || 0) + 1;
            if (Number.isFinite(latency) && latency > 0) {
              n.ewmaLatency = Number.isFinite(Number(n.ewmaLatency))
                ? Math.round(Number(n.ewmaLatency) * 0.6 + latency * 0.4) : latency;
              n.latency = latency;
            }
          } else {
            n.failStreak = (Number(n.failStreak) || 0) + 1;
          }
          n.scoreSeenAt = now;
        } catch (_) {
          n.failStreak = (Number(n.failStreak) || 0) + 1;
        } finally {
          active--;
        }
      })();
      pool.push(p);
    }
    await Promise.all(pool);
    nodeStore.saveToDisk();
    console.log(`[NodeScheduler] 快检完成：${okCount}/${nodes.length} 存活（失败只记分不踢人）`);
  }

  /**
   * 执行全链路全量刷新：抓取 -> 握手探活 -> 住宅属性加权 -> 存入活跃池
   */
  async runFullRefreshCycle() {
    if (this.isRefreshing) {
      console.log('[NodeScheduler] 上一轮刷新任务仍在进行中，跳过本次触发');
      return;
    }
    this.isRefreshing = true;
    console.log('[NodeScheduler] 🚀 启动全链路节点刷新与探活测速流程...');

    try {
      // 1. 抓取候选节点 (限制 60 个，防止 512MB 内存超载)
      const candidates = await nodeFetcher.fetchAllCandidateNodes(60);
      if (candidates.length === 0) {
        console.warn('[NodeScheduler] 未获取到可用候选节点，保留现有节点池');
        return;
      }

      // 2. 底层轻量探活与住宅宽带加权排序 (并发 3, 筛选 Top 20)
      const rankedNodes = await nodeProber.probeAndRankNodes(candidates, 3, 20);
      if (rankedNodes.length > 0) {
        // 3. 存入活跃池与本地持久化
        nodeStore.updateActiveNodes(rankedNodes);
        console.log(`[NodeScheduler] ✅ 节点池更新成功！活跃保留: ${rankedNodes.length} 个 (家宽: ${nodeStore.getResidentialCount()})`);
      }
    } catch (err) {
      console.error('[NodeScheduler] 节点刷新流程异常:', err.message);
    } finally {
      this.isRefreshing = false;
    }
  }

  /**
   * 生成完全脱敏的早报文本 (严禁出现任何违规字符)
   */
  generateCleanMorningDigest() {
    const stats = nodeStore.getSummaryStats();
    const regionNames = {
      'US': '美国家宽',
      'HK': '香港家宽',
      'JP': '日本家宽',
      'SG': '新加坡家宽',
      'TW': '台湾家宽',
      'Global': '其他'
    };

    const regionSummary = Object.entries(stats.regionStats)
      .map(([code, count]) => `${regionNames[code] || code} (${count}个)`)
      .slice(0, 4)
      .join(' · ');

    return [
      '🌤️ 主人早安！今日网络通道健康巡检已完成：',
      '-----------------------------------------',
      `📊 优选节点：${stats.total} 个 ｜ 认证原生家宽：${stats.residential} 个`,
      `🏠 住宅分布：${regionSummary || '亚太/美洲高速覆盖'}`,
      `⚡ 最佳延迟：${stats.minLatency}ms ｜ 平均延迟：${stats.avgLatency}ms`,
      '-----------------------------------------',
      '🚀 您的专属小火箭订阅已在云端自动更新就绪。打开手机小火箭即可直接连接使用！'
    ].join('\n');
  }

  /**
   * 发送每日早报到手机 QQ
   */
  async sendMorningDigestToMaster(targetOpenid = process.env.MASTER_OPENID || '') {
    if (!targetOpenid) {
      console.log('[NodeScheduler] 未配置 MASTER_OPENID，跳过早报推送');
      return;
    }
    const text = this.generateCleanMorningDigest();
    console.log(`[NodeScheduler] 准备发送每日早报至: ${targetOpenid}...`);
    try {
      await qqBot.sendProactiveMessage(targetOpenid, false, text);
      console.log('[NodeScheduler] 每日早报已成功推送到主人手机 QQ！');
    } catch (err) {
      console.error('[NodeScheduler] 发送每日早报异常:', err.message);
    }
  }

  /**
   * 启动调度器后台工作
   */
  start() {
    // 1. 服务刚启动时，延迟 10 秒先异步跑一次初始刷新
    setTimeout(() => {
      this.runFullRefreshCycle();
    }, 10000);

    // 2. 每 15 分钟全量刷新一次 (与 15 分钟保活心跳对齐)
    this.intervalHandle = setInterval(() => {
      this.runFullRefreshCycle();
    }, 15 * 60 * 1000);

    // 3-4. 每 5 分钟快检一次池内节点（只记分不踢人，淘汰由全量轮执行）
    this.quickCheckHandle = setInterval(() => {
      this.runQuickCheck().catch(err => console.error('[NodeScheduler] 快检异常:', err.message));
    }, 5 * 60 * 1000);

    // 3. 每天早晨 08:30 自动推送早报检查
    this.morningCronHandle = setInterval(() => {
      const now = new Date();
      // 获取东八区当前时间 (UTC+8)
      const bjHours = (now.getUTCHours() + 8) % 24;
      const bjMinutes = now.getUTCMinutes();

      // 在每天 08:30 ~ 08:31 之间触发
      if (bjHours === 8 && bjMinutes === 30) {
        this.sendMorningDigestToMaster();
      }
    }, 60 * 1000);

    console.log('[NodeScheduler] 定时调度器已启动：每 15 分钟探活保活，每天 08:30 推送 QQ 纯净早报');
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    if (this.morningCronHandle) clearInterval(this.morningCronHandle);
    if (this.quickCheckHandle) clearInterval(this.quickCheckHandle);
  }
}

module.exports = new NodeScheduler();
