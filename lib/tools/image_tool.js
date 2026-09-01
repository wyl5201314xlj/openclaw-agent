// lib/tools/image_tool.js
const axios = require('axios');

class ImageTool {
  constructor() {
    this.accounts = [
      { name: 'Agnes-Key1', apiKey: process.env.AGNES_API_KEY || '' },
      { name: 'Agnes-Key2', apiKey: process.env.AGNES_API_KEY_2 || '' }
    ];
    this.cursor = 0;
  }

  async generateImage(prompt, size = '1024x1024') {
    let lastError = null;
    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (this.cursor + i) % this.accounts.length;
      const account = this.accounts[idx];
      if (!account.apiKey) continue;

      try {
        console.log(`[ImageTool] 正在调用 ${account.name} 生成画作: "${prompt}"...`);
        const resp = await axios.post('https://api.agnes-ai.cn/v1/images/generations', {
          model: 'agnes-image-2.1-flash',
          prompt: prompt,
          n: 1,
          size: size
        }, {
          headers: {
            'Authorization': `Bearer ${account.apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 45000
        });

        this.cursor = (idx + 1) % this.accounts.length;
        const imgData = resp.data.data?.[0];
        if (imgData?.url) return { url: imgData.url, prompt: prompt };
        if (imgData?.b64_json) return { b64: imgData.b64_json, prompt: prompt };
        throw new Error('未返回有效图片数据');
      } catch (err) {
        console.warn(`[ImageTool] ${account.name} 生图失败: ${err.message}，尝试下一账号...`);
        lastError = err;
      }
    }
    throw lastError || new Error('所有生图通道均不可用');
  }
}

module.exports = new ImageTool();
