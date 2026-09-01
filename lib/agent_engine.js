// lib/agent_engine.js
const router = require('./model_router');
const { searchWeb } = require('./tools/search_tool');
const { readUrlContent } = require('./tools/reader_tool');

class AgentEngine {
  constructor() {
    this.tasks = [];
  }

  async processGoal(goalDescription) {
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
你具备调用外部工具的能力。当前可用工具：
1. Action: search | Param: <搜索关键词> (用于全网实时检索权威事实)
2. Action: read | Param: <网页完整URL> (用于抓取并转译网页内容)
3. Action: finish | Param: <最终回答> (当你已有足够信息回答主人时)

【决策规范】：
- 如果需要查询实时数据、外部事实或未掌握的信息，请第一步输出 JSON：
{"thought": "思考说明", "action": "search", "param": "精确关键词"}
- 如果你无需检索即可直接精准回答，请直接输出最终中文回答，不要输出 JSON。`
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
        }

        // 第二轮：综合工具观察结果，生成终极回答
        messages.push({ role: 'assistant', content: responseText });
        messages.push({
          role: 'user',
          content: `【外部工具执行返回事实数据】：\n${toolResult}\n\n请结合上述事实数据与思考，为主人输出完整、专业、有条理的最终执行报告（请直接输出自然语言报告，不要再输出 JSON）：`
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
