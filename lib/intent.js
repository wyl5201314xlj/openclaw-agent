// lib/intent.js
// 意图识别（阶段 1-6）。
//
// 旧实现的闸门是 `含"提醒" && 含(后|分|秒|点)`，实测把「提醒我看一下这道题的得分」
// 误判成定时任务；生图分支则是 startsWith('画') 与 includes('画一只') 的拼凑，
// 导致「帮我画个猫」进不了生图分支，行为不一致。
//
// 新规则只做"高置信度直达"：
//   · 定时提醒必须**真的解析出时间**（复用 lib/time_parse 的 17 条测试），否则不算；
//   · 生图必须命中明确的"动词 + 图类名词"结构；
//   · 其余全部交给 ReAct 智能体——它自己也能调 timer/draw 工具，不会漏能力。
// 这样既保住直达速度，又把误判压到规则可证的范围内。

const { parseSchedule } = require('./time_parse');

// 提醒类动词：光有时间不算提醒（「3点开会」是陈述，「3点提醒我开会」才是提醒）
const REMIND_VERB = /(提醒|叫我|喊我|记得|别忘|提示我|call\s*me|remind)/i;

// 客套前缀，可重复出现
const DRAW_LEAD = /^(?:请|帮我|帮忙|给我|麻烦|能不能|可以|想要|我要|需要|来)+\s*/;
// 绘图动词 + 可选量词
const DRAW_HEAD_VERB = /^(?:生成图片|生成|生图|绘制|作画|画出|画)(?:一)?(?:张|幅|只|个|副|条)?/;
// 图类名词
const IMAGE_NOUN = /(?:图片|图|画|海报|插画|壁纸)/;
// 句尾的「……的图/图片」这类结构
const DRAW_TAIL = new RegExp(`的${IMAGE_NOUN.source}\\s*[。!！~]*$`);
// 强特征词：出现即可判定，不依赖位置
const DRAW_STRONG = /(生图|作画|生成图片|画一张|画一幅|画一只|画个|画张|来张图|来一张图)/;

/** 判断去掉客套前缀后的句子是否是一个绘图请求 */
function isDrawRequest(afterLead, raw) {
  if (DRAW_STRONG.test(raw)) return true;
  const verbMatch = afterLead.match(DRAW_HEAD_VERB);
  if (!verbMatch) return false;
  const rest = afterLead.slice(verbMatch[0].length);
  // 动词后紧跟图类名词：「生成图片」「画一张图」
  if (new RegExp(`^${IMAGE_NOUN.source}`).test(rest)) return true;
  // 句尾是「……的图」：「生成一张赛博朋克城市的图」
  if (DRAW_TAIL.test(afterLead)) return true;
  // 「画/绘制/作画」本身就是明确的绘图动词，后面直接跟内容即可：「画一只猫」
  if (/^(?:画|绘制|作画|画出|生图)/.test(afterLead)) return true;
  return false;
}

/** 剥掉客套话与绘图动词，得到真正的画面描述 */
function extractDrawPrompt(text) {
  let out = String(text || '');
  out = out.replace(DRAW_LEAD, '');
  out = out.replace(DRAW_HEAD_VERB, '');
  // 动词后紧跟的图类名词属于句式成分，不是画面内容
  out = out.replace(new RegExp(`^${IMAGE_NOUN.source}\\s*[,，:：的]?\\s*`), '');
  out = out.replace(/^[\s,，。:：、~\-—]+/, '');
  // 只在有「的」连接时剥句尾图类名词，避免把「架构示意图」削成「架构示意」
  out = out.replace(DRAW_TAIL, '');
  out = out.replace(/[\s。!！~]+$/, '');
  return out.trim();
}

/**
 * 判定一句话的意图。
 * @param {string} text 用户原话（已剥掉 @ 提及）
 * @param {number} [nowMs] 便于测试注入固定"现在"
 * @returns {{intent:'timer'|'draw'|'chat', param?:string, schedule?:object, reason:string}}
 */
function classify(text, nowMs = Date.now()) {
  const raw = String(text || '').trim();
  if (!raw) return { intent: 'chat', reason: '空内容' };

  // 1) 定时提醒：必须同时有提醒动词 + 能真正解析出的时间
  if (REMIND_VERB.test(raw)) {
    const schedule = parseSchedule(raw, nowMs);
    if (schedule.ok) {
      return {
        intent: 'timer',
        param: raw,
        schedule,
        reason: `命中提醒动词且解析出${schedule.kind === 'relative' ? '相对时长' : '绝对时刻'}`,
      };
    }
    // 有提醒动词但没有可解析时间：交给智能体去问，而不是硬设一个默认值
    return {
      intent: 'chat',
      reason: `有提醒动词但时间无法解析（${schedule.reason}），交给智能体处理`,
    };
  }

  // 2) 生图
  const afterLead = raw.replace(DRAW_LEAD, '');
  if (isDrawRequest(afterLead, raw)) {
    return { intent: 'draw', param: extractDrawPrompt(raw), reason: '命中绘图动词结构' };
  }

  return { intent: 'chat', reason: '未命中任何直达规则' };
}

module.exports = {
  classify,
  extractDrawPrompt,
  _internal: { REMIND_VERB, DRAW_HEAD_VERB, DRAW_STRONG, DRAW_TAIL, isDrawRequest },
};
