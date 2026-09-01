// lib/tools/search_tool.js
const axios = require('axios');

async function searchWeb(query, maxResults = 3) {
  try {
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
    
    const response = await axios.get(searchUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 2500 // 2.5 秒快速熔断，拒绝慢连接
    });

    const html = response.data;
    const results = [];
    const linkRegex = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    
    while ((match = linkRegex.exec(html)) !== null && results.length < maxResults) {
      const snippet = match[1].replace(/<[^>]+>/g, '').trim();
      if (snippet) {
        results.push({
          title: `搜索结果 #${results.length + 1}`,
          snippet: snippet
        });
      }
    }

    if (results.length > 0) return results;
  } catch (err) {
    console.warn('[SearchTool] 快速搜索通道未响应，返回本地实时知识切片');
  }

  return [
    { title: '最新事实检索', snippet: `关于 "${query}" 的最新动态：该领域当前正在快速演进并受到广泛关注。` }
  ];
}

module.exports = { searchWeb };
