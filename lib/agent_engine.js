// lib/agent_engine.js
const router = require('./model_router');
const { searchWeb } = require('./tools/search_tool');
const { readUrlContent } = require('./tools/reader_tool');
const imageTool = require('./tools/image_tool');
const timerTool = require('./tools/timer_tool');

class AgentEngine {
  constructor() {
    this.tasks = [];
  }

  async processGoal(goalDescription, context = {}) {
    const taskId = 'task-' + Date.now();
    const taskRecord = {
      id: taskId,
      goal: goalDescription,
      status: 'RUNNING',
      steps: [],
      createdAt: new Date().toISOString(),
      result: null
    };
    this.tasks.unshift(taskRecord);
    if (this.tasks.length > 50) this.tasks.pop();

    try {
      const messages = [
        {
          role: 'system',
          content: `你是 OpenClaw 7x24h 分布式自主 AI Agent 智能体中枢。
你拥有真实的外部环境感知与工具调用权限。当前已注册工具：
1. Action: search | Param: <关键词> (用于全网实时检索权威事实与最新动态)
2. Action: read | Param: <完整网页URL> (用于抓取并转译网页正文)
3. Action: draw | Param: <绘图提示词> (用于生成高精度 AI 画作)
4. Action: timer | Param: <时长描述，如'3分钟后提醒吃饭'> (用于注册后台定时提醒)
5. Action: finish | Param: <最终回答> (当你无需调工具即可直接回答时)

【决策执行规范】：
- 若需调用工具，请第一步输出标准 JSON：
{"thought": "详细思考说明", "action": "工具名(search/read/draw/timer)", "param": "参数内容"}
- 若为直接问答，请直接输出专业严谨的 Markdown 自然语言，不要输出 JSON。`
        },
        {
          role: 'user',
          content: goalDescription
        }
      ];

      // 第一轮：规划与思考
      const planRes = await router.executeWithFailover(messages, { timeoutMs: 30000 });
      let responseText = (planRes.content || '').trim();
      taskRecord.steps.push({ step: 'Plan & Reason', detail: responseText, model: planRes.model });

      // 尝试解析是否包含 JSON Action
      let jsonAction = null;
      try {
        const jsonMatch = responseText.match(/\{[\s\S]*"action"\s*:\s*"([a-zA-Z0-9_]+)"[\s\S]*\}/);
        if (jsonMatch) {
          jsonAction = JSON.parse(jsonMatch[0]);
        }
      } catch (e) {}

      // 如果需要执行 Action
      if (jsonAction && jsonAction.action && jsonAction.action !== 'finish') {
        const actionType = jsonAction.action.toLowerCase();
        const actionParam = jsonAction.param || '';
        let toolResult = '';

        if (actionType === 'search') {
          taskRecord.steps.push({ step: 'Action: WebSearch', param: actionParam });
          const searchData = await searchWeb(actionParam, 4);
          toolResult = JSON.stringify(searchData, null, 2);
          taskRecord.steps.push({ step: 'Observation', data: searchData });
        } else if (actionType === 'read') {
          taskRecord.steps.push({ step: 'Action: ReadUrl', param: actionParam });
          toolResult = await readUrlContent(actionParam);
          taskRecord.steps.push({ step: 'Observation', data: toolResult.slice(0, 500) });
        } else if (actionType === 'draw') {
          taskRecord.steps.push({ step: 'Action: DrawImage', param: actionParam });
          const imgRes = await imageTool.generateImage(actionParam);
          toolResult = imgRes.url ? `已生成图片，直链: ${imgRes.url}` : '图片生成成功。';
          taskRecord.steps.push({ step: 'Observation', data: toolResult });
        } else if (actionType === 'timer') {
          taskRecord.steps.push({ step: 'Action: SetTimer', param: actionParam });
          const seconds = timerTool.parseTimeOffset(actionParam);
          toolResult = `已成功注册后台定时器，将在 ${seconds} 秒后准时提醒。`;
          taskRecord.steps.push({ step: 'Observation', data: toolResult });
        }

        // 第二轮：综合工具观察结果，生成终极自然语言回答
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: `【外部工具执行返回事实数据】：\n${toolResult}\n\n请结合上述事实数据与思考，输出完整、专业、有条理的最终执行报告（请直接输出自然语言，不要再输出 JSON）：`
        });

        const finalRes = await router.executeWithFailover(messages, { timeoutMs: 30000 });
        responseText = (finalRes.content || '').trim();
        taskRecord.steps.push({ step: 'Synthesize & Finish', model: finalRes.model });
      }

      taskRecord.status = 'COMPLETED';
      taskRecord.result = responseText;
      return taskRecord;
    } catch (err) {
      taskRecord.status = 'FAILED';
      taskRecord.result = `执行异常: ${err.message}`;
      return taskRecord;
    }
  }

  getTasks() {
    return this.tasks;
  }
}

module.exports = new AgentEngine();
