// lib/tools/reader_tool.js
const axios = require('axios');

async function readUrlContent(targetUrl) {
  try {
    const jinaUrl = `https://r.jina.ai/${targetUrl}`;
    const resp = await axios.get(jinaUrl, {
      headers: {
        'Accept': 'text/markdown',
        'User-Agent': 'OpenClaw-Agent/1.0'
      },
      timeout: 12000
    });
    return typeof resp.data === 'string' ? resp.data.slice(0, 4000) : JSON.stringify(resp.data).slice(0, 4000);
  } catch (err) {
    return `[网页转译错误: ${err.message}]`;
  }
}

module.exports = { readUrlContent };
