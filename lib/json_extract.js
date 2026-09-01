// lib/json_extract.js
// 从模型输出里安全地抽取 JSON 动作块（阶段 0-5）。
//
// 旧实现用 /\{[\s\S]*"action"...[\s\S]*\}/ 这种贪婪正则：会从第一个 { 一直吃到最后一个 }，
// 正文里带花括号或出现两段 JSON 时必然解析失败，然后被空 catch 吞掉。
// 这里改为括号配对扫描（正确处理字符串字面量与转义），逐个候选试解析。

/**
 * 扫描出文本中所有"顶层平衡"的 JSON 对象片段。
 * @param {string} text
 * @returns {Array<{start:number, end:number, raw:string}>}
 */
function findBalancedObjects(text) {
  const src = String(text || '');
  const found = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start >= 0) {
          found.push({ start, end: i + 1, raw: src.slice(start, i + 1) });
          start = -1;
        }
      }
    }
  }
  return found;
}

/**
 * 抽取第一个可解析且含 action 字段的动作对象。
 * @param {string} text
 * @returns {{action:object, span:{start:number,end:number}}|null}
 */
function extractAction(text) {
  for (const candidate of findBalancedObjects(text)) {
    let parsed;
    try {
      parsed = JSON.parse(candidate.raw);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && typeof parsed.action === 'string') {
      return { action: parsed, span: { start: candidate.start, end: candidate.end } };
    }
  }
  return null;
}

/**
 * 把最终回答里残留的思考类 JSON 块整段剥掉。
 * 线上实测过：ReAct 第二轮又输出了 {"thought":...,"action":"search"...}，被原样发给了用户。
 */
function stripThoughtJson(text) {
  let out = String(text || '');
  const blocks = findBalancedObjects(out)
    .filter((b) => {
      try {
        const parsed = JSON.parse(b.raw);
        return (
          parsed &&
          typeof parsed === 'object' &&
          (typeof parsed.action === 'string' || typeof parsed.thought === 'string')
        );
      } catch {
        return false;
      }
    })
    // 从后往前删，避免前面的删除影响后面的下标
    .sort((a, b) => b.start - a.start);

  for (const b of blocks) {
    out = out.slice(0, b.start) + out.slice(b.end);
  }
  return out
    .replace(/```(?:json)?\s*```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

module.exports = { findBalancedObjects, extractAction, stripThoughtJson };
