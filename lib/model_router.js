// lib/model_router.js
const axios = require('axios');

class ModelRouter {
  constructor() {
    this.providers = [
      {
        name: 'luoying',
        baseUrl: process.env.LUOYING_BASE_URL || 'https://apiserver.luoying.work/v1',
        apiKey: process.env.LUOYING_API_KEY || '',
        models: [
          'minimax-m3',
          'deepseek-v4-flash-0731',
          'qwen-3.8',
          'deepseek-v4',
          'gpt-5.4',
          'minimax-m2.7',
          'gpt-5.6-luna',
          'claude-3-7-sonnet'
        ],
        maxConcurrent: 4,
        running: 0
      },
      {
        name: 'agnes-key1',
        baseUrl: process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1',
        apiKey: process.env.AGNES_API_KEY || '',
        models: [
          'agnes-2.5-flash',
          'agnes-2.0-flash',
          'agnes-2.5-pro',
          'agnes-2.5-pro-beta',
          'agnes-2.5-pro-alpha'
        ],
        maxConcurrent: 2,
        running: 0
      },
      {
        name: 'agnes-key2',
        baseUrl: process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1',
        apiKey: process.env.AGNES_API_KEY_2 || '',
        models: [
          'agnes-2.5-flash',
          'agnes-2.0-flash'
        ],
        maxConcurrent: 2,
        running: 0
      },
      {
        name: 'xkiro',
        baseUrl: process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1',
        apiKey: process.env.XKIRO_API_KEY || '',
        models: [
          'minimax-m2.7',
          'gpt-5.4',
          'qwen/qwen3-vl-plus:free'
        ],
        maxConcurrent: 3,
        running: 0
      }
    ];
    this.stats = { totalRequests: 0, successes: 0, failovers: 0 };
  }

  async executeWithFailover(messages, options = {}) {
    this.stats.totalRequests++;
    const startTime = Date.now();
    const maxTimeoutMs = options.timeoutMs || 60000;
    const taskType = options.taskType || 'general';

    let lastError = null;

    for (let round = 1; round <= 3; round++) {
      if (Date.now() - startTime > maxTimeoutMs) break;

      for (const provider of this.providers) {
        if (!provider.apiKey) continue;
        if (provider.running >= provider.maxConcurrent) continue;

        for (const model of provider.models) {
          if (Date.now() - startTime > maxTimeoutMs) break;

          provider.running++;
          try {
            const resp = await axios.post(
              `${provider.baseUrl}/chat/completions`,
              {
                model: model,
                messages: messages,
                temperature: options.temperature || 0.7,
                max_tokens: options.max_tokens || 2048,
                ...(options.tools ? { tools: options.tools, tool_choice: 'auto' } : {})
              },
              {
                headers: {
                  'Authorization': `Bearer ${provider.apiKey}`,
                  'Content-Type': 'application/json'
                },
                timeout: 8000
              }
            );

            provider.running--;
            this.stats.successes++;
            return {
              content: resp.data.choices[0].message.content,
              tool_calls: resp.data.choices[0].message.tool_calls || null,
              model: model,
              provider: provider.name,
              latencyMs: Date.now() - startTime,
              round: round
            };
          } catch (err) {
            provider.running--;
            this.stats.failovers++;
            lastError = err;
            console.warn(`[Failover] Provider ${provider.name} (${model}) failed: ${err.message}. Switching...`);
          }
        }
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    throw new Error(`All models failed within 60s hard timeout: ${lastError ? lastError.message : 'Unknown'}`);
  }
}

module.exports = new ModelRouter();
