// lib/agent_engine.js
// 阶段 0-5 / 2-4 重写。
//
// 旧实现的问题（线上均已复现，见 docs/OPTIMIZATION_PLAN.md）：
//   1. 名为 ReAct 实为固定两步：执行一次工具后就把第二轮输出当最终答案，
//      第二轮如果又吐 JSON 就原样发给用户（线上真实样本已抓到）；
//   2. 一次搜不到就永远没机会补救；
//   3. JSON 抽取用贪婪正则，失败后被空 catch 吞掉；
//   4. max_tokens 固定 1500，短问答也按长文成本走。
//
// 新实现：最多 N 轮真闭环；每轮都解析动作；终稿强制剥离残留 JSON；
// token 预算按复杂度分级；工具失败如实回传"失败"而非编造。

const router = require('./model_router');
const searchTool = require('./tools/search_tool');
const readerTool = require('./tools/reader_tool');
const imageTool = require('./tools/image_tool');
const timerTool = require('./tools/timer_tool');
const sessionStore = require('./session_store');
const { config } = require('./config');
const { createLogger } = require('./logger');
const { extractAction, stripThoughtJson } = require('./json_extract');
const { LruTtlCache } = require('./cache');

const log = createLogger('AgentEngine');

const answerCache = new LruTtlCache({
  name: 'answer',
  maxEntries: config.cache.answerMax,
  ttlMs: config.cache.answerTtlMs,
  maxBytes: 8 * 1024 * 1024,
});

const SYSTEM_PROMPT = `你是 OpenClaw —— 主人专属的 7x24 小时云端 AI 助理。回答一律使用简体中文。

你可以调用以下工具，**需要调用时只输出一个 JSON 对象，不要输出其它任何内容**：
{"thought":"你的推理","action":"search","param":"检索关键词"}      联网检索事实与最新动态
{"thought":"...","action":"read","param":"完整网页URL"}            抓取指定网页正文
{"thought":"...","action":"draw","param":"绘图提示词"}             生成图片
{"thought":"...","action":"finish","param":"最终回答"}             收尾并给出最终答案

【铁律】
1. 无需调用工具就能回答时，**直接输出自然语言答案**，不要输出任何 JSON。
2. 工具返回"失败"或"无有效资料"时，**必须如实告知主人检索/抓取失败**，
   严禁凭空编造事实、数字、版本号或链接。
3. 检索结果不够精确时，可以换更精准的关键词再检索一次（最多 ${config.agent.maxToolRounds} 轮）。
4. 引用检索结论时带上来源 URL。
5. 最终回答面向 QQ 聊天窗口：简洁分点，不要 Markdown 表格，不要输出思考过程。`;

/** 按问题复杂度选 token 预算（阶段 2-4）：短问答不该按长文成本走 */
function pickTokenBudget(goal, hasToolResult) {
  const text = String(goal || '');
  const len = text.length;
  const deepMarkers = /(调研|研究|对比|分析|方案|报告|详细|全面|综述|规划|教程|怎么做)/;
  if (deepMarkers.test(text) || len > 80) return config.agent.tokens.deep;
  if (hasToolResult || len > 25) return config.agent.tokens.normal;
  return config.agent.tokens.short;
}

class AgentEngine {
  constructor() {
    this.tasks = [];
  }

  /**
   * 处理一个目标。
   * @param {string} goalDescription
   * @param {{sessionScope?:string, targetOpenid?:string, isGroup?:boolean,
   *          onProgress?:(text:string)=>void, useCache?:boolean, useSession?:boolean}} [context]
   */
  async processGoal(goalDescription, context = {}) {
    const goal = String(goalDescription || '').trim();
    const taskId = `task-${Date.now().toString(36)}`;
    const task = {
      id: taskId,
      goal,
      status: 'RUNNING',
      steps: [],
      createdAt: new Date().toISOString(),
      result: null,
      elapsedMs: 0,
    };
    this.tasks.unshift(task);
    while (this.tasks.length > config.agent.maxTaskRecords) this.tasks.pop();

    const started = Date.now();
    const cacheKey = `${context.sessionScope || 'anon'}::${goal}`;
    if (context.useCache !== false) {
      const hit = answerCache.get(cacheKey);
      if (hit) {
        task.status = 'COMPLETED';
        task.result = hit;
        task.cached = true;
        task.elapsedMs = Date.now() - started;
        log.info('命中回答缓存', { taskId, elapsedMs: task.elapsedMs });
        return task;
      }
    }

    const history = context.useSession === false ? [] : sessionStore.getHistory(context.sessionScope);
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history,
      { role: 'user', content: goal },
    ];

    try {
      let finalText = '';
      let usedTool = false;

      for (let round = 1; round <= config.agent.maxToolRounds; round += 1) {
        const maxTokens = pickTokenBudget(goal, usedTool);
        const res = await router.chat(messages, { maxTokens });
        const raw = String(res.content || '').trim();
        task.steps.push({
          step: `第${round}轮推理`,
          model: `${res.provider}/${res.model}`,
          firstByteMs: res.firstByteMs,
          chars: raw.length,
        });

        const found = extractAction(raw);
        const actionName = found ? String(found.action.action || '').toLowerCase() : '';

        // 没有动作，或动作是 finish → 收尾
        if (!found || actionName === 'finish') {
          finalText = found && found.action.param ? String(found.action.param) : raw;
          break;
        }

        usedTool = true;
        const param = String(found.action.param ?? '').trim();
        if (context.onProgress) {
          context.onProgress(this.describeAction(actionName, param));
        }

        const observation = await this.runTool(actionName, param, context, task);
        messages.push({ role: 'assistant', content: raw });
        messages.push({
          role: 'user',
          content:
            `【工具 ${actionName} 的真实返回】\n${observation}\n\n` +
            `请基于以上真实返回继续。若资料已足够，直接输出面向主人的最终中文回答（不要再输出 JSON）；` +
            `若资料不足且还有轮次，可换更精准的关键词再检索一次。`,
        });

        // 最后一轮还在调工具，就再要一次纯文本收尾
        if (round === config.agent.maxToolRounds) {
          const wrap = await router.chat(
            [
              ...messages,
              {
                role: 'user',
                content: '已达工具调用上限，请立刻用自然语言给出最终回答，禁止再输出 JSON。',
              },
            ],
            { maxTokens: config.agent.tokens.deep }
          );
          finalText = String(wrap.content || '').trim();
          task.steps.push({ step: '收尾总结', model: `${wrap.provider}/${wrap.model}` });
        }
      }

      // 终稿清洗：把任何残留的思考 JSON 整段剥掉（旧版正是在这里把裸 JSON 发给了用户）
      const cleaned = stripThoughtJson(finalText);
      task.result = cleaned || '这次没能生成有效回答，请换个说法再问一次。';
      task.status = 'COMPLETED';
      task.elapsedMs = Date.now() - started;

      if (context.useSession !== false) {
        sessionStore.appendTurn(context.sessionScope, goal, task.result);
      }
      // 只缓存没调工具的纯问答；调过工具的结果时效性强，不适合缓存
      if (!usedTool && context.useCache !== false && task.result.length > 10) {
        answerCache.set(cacheKey, task.result);
      }
      log.info('任务完成', { taskId, elapsedMs: task.elapsedMs, usedTool, steps: task.steps.length });
      return task;
    } catch (err) {
      task.status = 'FAILED';
      task.result = `处理失败：${err.message}`;
      task.elapsedMs = Date.now() - started;
      log.error('任务失败', err);
      return task;
    }
  }

  describeAction(actionName, param) {
    const short = param.length > 40 ? `${param.slice(0, 40)}…` : param;
    const map = {
      search: `正在联网检索「${short}」`,
      read: `正在抓取网页 ${short}`,
      draw: `正在生成图片「${short}」`,
      timer: `正在登记提醒「${short}」`,
    };
    return map[actionName] || `正在执行 ${actionName}`;
  }

  /** 执行一个工具，返回给模型看的观察文本。工具失败一律如实回传"失败"。 */
  async runTool(actionName, param, context, task) {
    if (actionName === 'search') {
      const res = await searchTool.searchWeb(param, { maxResults: 5 });
      task.steps.push({
        step: '工具: 联网检索',
        param,
        ok: res.ok,
        detail: res.ok
          ? res.results.map((r) => ({ title: r.title, url: r.url, source: r.source }))
          : res.reason,
      });
      return searchTool.formatForModel(res);
    }

    if (actionName === 'read') {
      const res = await readerTool.readUrlContent(param);
      task.steps.push({
        step: '工具: 网页抓取',
        param,
        ok: res.ok,
        detail: res.ok ? `${res.via} / ${res.content.length} 字` : res.reason,
      });
      return readerTool.formatForModel(res);
    }

    if (actionName === 'draw') {
      const res = await imageTool.generateImage(param);
      task.steps.push({ step: '工具: 生成图片', param, ok: res.ok, detail: res.ok ? res.via : res.reason });
      if (!res.ok) return `【生图失败】${res.reason}。请如实告知主人生图失败，不要编造图片链接。`;
      task.imageResult = res;
      return `【生图成功】已生成图片（${res.hasBinary ? '二进制数据已就绪' : res.url}）。请用一句话向主人交付这张图，不要输出链接以外的编造内容。`;
    }

    if (actionName === 'timer') {
      if (!context.targetOpenid) {
        return '【登记提醒失败】当前渠道没有可推送的目标（HTTP 调试入口无法登记提醒），请如实告知主人。';
      }
      const parsed = timerTool.parse(param);
      if (!parsed.ok) {
        task.steps.push({ step: '工具: 登记提醒', param, ok: false, detail: parsed.reason });
        return `【登记提醒失败】${parsed.reason}。请把这句原因转达给主人并请他重说一次时间。`;
      }
      const rec = await timerTool.schedule({
        triggerAt: parsed.triggerAt,
        remindText: parsed.remindText,
        targetOpenid: context.targetOpenid,
        isGroup: context.isGroup,
        sourceText: param,
      });
      task.steps.push({ step: '工具: 登记提醒', param, ok: true, detail: parsed.humanTime });
      return `【登记提醒成功】将在 ${parsed.humanTime} 提醒「${parsed.remindText}」（持久化=${rec.persisted}）。`;
    }

    return `【未知工具 ${actionName}】没有这个工具，请改用 search / read / draw / timer，或直接回答。`;
  }

  getTasks(includeDetail = false) {
    return this.tasks.map((t) =>
      includeDetail
        ? t
        : {
            id: t.id,
            status: t.status,
            createdAt: t.createdAt,
            elapsedMs: t.elapsedMs,
            steps: t.steps.length,
            cached: Boolean(t.cached),
          }
    );
  }

  cacheStats() {
    return answerCache.stats();
  }
}

module.exports = new AgentEngine();
