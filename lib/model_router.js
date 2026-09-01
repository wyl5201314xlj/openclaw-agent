// lib/model_router.js
const axios = require('axios');

class ModelRouter {
  constructor() {
    this.providers = [
      {
        name: 'agnes-key1',
        baseUrl: process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1',
        apiKey: process.env.AGNES_API_KEY || '',
        models: ['agnes-2.5-flash', 'agnes-2.0-flash', 'agnes-2.5-pro'], // 238ms 极速置顶
        maxConcurrent: 2,
        running: 0
      },
      {
        name: 'agnes-key2',
        baseUrl: process.env.AGNES_BASE_URL || 'https://api.agnes-ai.cn/v1',
        apiKey: process.env.AGNES_API_KEY_2 || '',
        models: ['agnes-2.5-flash', 'agnes-2.0-flash'],
        maxConcurrent: 2,
        running: 0
      },
      {
        name: 'luoying',
        baseUrl: process.env.LUOYING_BASE_URL || 'https://apiserver.luoying.work/v1',
        apiKey: process.env.LUOYING_API_KEY || '',
        models: ['minimax-m3', 'deepseek-v4-flash-0731', 'qwen-3.8', 'deepseek-v4', 'gpt-5.4'],
        maxConcurrent: 4,
        running: 0
      },
      {
        name: 'xkiro',
        baseUrl: process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1',
        apiKey: process.env.XKIRO_API_KEY || '',
        models: ['minimax-m2.7', 'gpt-5.4'],
        maxConcurrent: 3,
        running: 0
      }
    ];
    this.stats = { totalRequests: 0, successes: 0, failovers: 0 };
  }

  async executeWithFailover(messages, options = {}) {
    this.stats.totalRequests++;
    const startTime = Date.now();
    const maxTimeoutMs = options.timeoutMs || 25000;

    let lastError = null;

    for (let round = 1; round <= 2; round++) {
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
                temperature: options.temperature || 0.6,
                max_tokens: options.max_tokens || 1500
              },
              {
                headers: {
                  'Authorization': `Bearer ${provider.apiKey}`,
                  'Content-Type': 'application/json'
                },
                timeout: 6000 // 6秒快速熔断，绝不卡死
              }
            );

            provider.running--;
            this.stats.successes++;
            return {
              content: resp.data.choices[0].message.content,
              model: model,
              provider: provider.name,
              latencyMs: Date.now() - startTime,
              round: round
            };
          } catch (err) {
            provider.running--;
            this.stats.failovers++;
            lastError = err;
          }
        }
      }
      await new Promise(r => setTimeout(r, 500));
    }

    throw new Error(`模型请求超时: ${lastError ? lastError.message : '所有通道无响应'}`);
  }
}

module.exports = new ModelRouter();
