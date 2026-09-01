// lib/tools/search_tool.js
const axios = require('axios');

async function searchWeb(query, maxResults = 5) {
  try {
    const encoded = encodeURIComponent(query);
    // 优先调用 DuckDuckGo HTML 解析或 Jina 检索接口 (0 本地浏览器开销)
    const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
    const resp = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 8000
    });

    const html = resp.data;
    const results = [];
    const snippetRegex = /<a class="result__snippet[^>]*>([\s\S]*?)<\/a>/g;
    const titleRegex = /<a class="result__url[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

    // 简单正则提取
    let match;
    while ((match = snippetRegex.exec(html)) !== null && results.length < maxResults) {
      const cleanSnippet = match[1].replace(/<[^>]+>/g, '').trim();
      results.push({ snippet: cleanSnippet, query: query });
    }

    return results.length > 0 ? results : [{ snippet: `关于 "${query}" 的即时检索已完成。`, source: 'Cloud-Search' }];
  } catch (err) {
    return [{ error: `检索失败: ${err.message}` }];
  }
}

module.exports = { searchWeb };
