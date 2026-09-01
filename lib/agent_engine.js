// lib/agent_engine.js
const router = require('./model_router');
const { searchWeb } = require('./tools/search_tool');
const { readUrlContent } = require('./tools/reader_tool');

class AgentEngine {
  constructor() {
    this.tasks = [];
    this.history = [];
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
      // 1. 制定行动计划
      const planPrompt = [
        {
          role: 'system',
          content: '你是 OpenClaw 分布式 AI Agent 核心中枢。你的任务是自主拆解目标、规划工具调用并得出详实结论。'
        },
        {
          role: 'user',
          content: `请分析并执行以下目标："${goalDescription}"。如果你需要搜索网页或获取信息，请以 JSON 格式输出规划。格式：{"thought": "思考过程", "action": "search" | "read" | "finish", "param": "关键词或URL"}`
        }
      ];

      const planRes = await router.executeWithFailover(planPrompt);
      taskRecord.steps.push({ step: 'Plan & Reason', detail: planRes.content, model: planRes.model });

      let currentContext = planRes.content;
      let finalAnswer = planRes.content;

      // 2. 判断是否包含搜索意图
      if (goalDescription.includes('搜索') || goalDescription.includes('查') || goalDescription.includes('最新') || goalDescription.includes('http')) {
        const query = goalDescription.replace(/搜索|查一下|请问|帮我/g, '').trim();
        taskRecord.steps.push({ step: 'Action: WebSearch', param: query });
        const searchResults = await searchWeb(query, 3);
        taskRecord.steps.push({ step: 'Observation: SearchResults', data: searchResults });

        // 综合生成终极解答
        const synthPrompt = [
          {
            role: 'system',
            content: '你是一个高效务实的 AI Agent。请根据检索事实与上下文，输出完整、专业、有理有据的最终回答。'
          },
          {
            role: 'user',
            content: `用户目标：${goalDescription}\n\n检索到的参考事实：${JSON.stringify(searchResults, null, 2)}\n\n请给出最终执行报告：`
          }
        ];
        const finalRes = await router.executeWithFailover(synthPrompt);
        finalAnswer = finalRes.content;
        taskRecord.steps.push({ step: 'Synthesize & Finish', model: finalRes.model });
      }

      taskRecord.status = 'COMPLETED';
      taskRecord.result = finalAnswer;
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
