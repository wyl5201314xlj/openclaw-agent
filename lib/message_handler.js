// lib/message_handler.js
// QQ 消息业务处理器：把意图识别、定时提醒、生图、ReAct 问答串起来。
// 从 qq_bot.js 里抽出来，让网关只负责协议、这里只负责业务，便于单测。
//
// 发信配额是硬约束（单聊 60 分钟 4 次 / 群聊 5 分钟 5 次），因此这里的原则是：
//   · 能一条说完就只发一条（短问答零等待，最省配额）；
//   · 只有真正调用了工具、耗时较长时才补一条进度（阶段 2-3）；
//   · 长回答按段切分，且切分数量受剩余配额约束，绝不超发导致后续全部失败。

const agent = require('./agent_engine');
const timerTool = require('./tools/timer_tool');
const imageTool = require('./tools/image_tool');
const sessionStore = require('./session_store');
const { classify } = require('./intent');
const { createLogger } = require('./logger');

const log = createLogger('Handler');

const CHUNK_CHARS = 1200;

/** 按段落边界切分长文本，尽量不在句子中间断开 */
function splitForChat(text, maxChunks) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_CHARS) return [clean];

  const chunks = [];
  let rest = clean;
  while (rest.length > 0 && chunks.length < maxChunks) {
    if (rest.length <= CHUNK_CHARS) {
      chunks.push(rest);
      break;
    }
    const window = rest.slice(0, CHUNK_CHARS);
    // 优先在段落、句号、逗号处断开
    let cut = Math.max(
      window.lastIndexOf('\n\n'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('。'),
      window.lastIndexOf('！'),
      window.lastIndexOf('？')
    );
    if (cut < CHUNK_CHARS * 0.5) cut = CHUNK_CHARS;
    else cut += 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0 && chunks.length >= maxChunks) {
    // 配额不够全发时如实说明，而不是静默截断
    const last = chunks[chunks.length - 1];
    chunks[chunks.length - 1] = `${last}\n\n（内容较长，受 QQ 单条消息回复次数限制，剩余 ${rest.length} 字未发出，可回复"继续"我再补上）`;
  }
  return chunks;
}

/** 计算这条消息还能被动回复几次 */
function remainingReplies(ctx, gateway) {
  if (!gateway || !gateway.ledger || !ctx.msgId) return 1;
  return gateway.ledger.remaining(ctx.msgId, ctx.isGroup);
}

function createHandler(gateway) {
  /** 处理一条用户消息 */
  return async function handleMessage(content, ctx) {
    const text = String(content || '').trim();
    const intent = classify(text);
    log.info('意图判定', { intent: intent.intent, reason: intent.reason });

    // ---- 分支一：定时提醒 ----
    if (intent.intent === 'timer') {
      const s = intent.schedule;
      const rec = await timerTool.schedule({
        triggerAt: s.triggerAt,
        remindText: s.remindText,
        targetOpenid: ctx.target,
        isGroup: ctx.isGroup,
        sourceText: text,
      });
      const persistNote = rec.persisted
        ? ''
        : '\n（注意：当前未接持久化存储，服务重启会丢失这条提醒）';
      await ctx.reply(
        `好，${s.humanTime} 提醒你「${s.remindText}」。${persistNote}`
      );
      return;
    }

    // ---- 分支二：生图 ----
    if (intent.intent === 'draw') {
      if (!intent.param) {
        await ctx.reply('想画什么？给我一句描述，比如「画一只戴墨镜的橘猫」。');
        return;
      }
      await ctx.reply(`在画「${intent.param}」了，大概要 40 秒左右，画好直接发给你。`);
      const res = await imageTool.generateImage(intent.param);
      if (!res.ok) {
        await ctx.reply(`画失败了：${res.reason}`);
        return;
      }
      const sent = await ctx.replyImage({ url: res.url, b64: res.b64 });
      if (!sent || sent.ok === false) {
        log.warn('图片发送未成功', sent);
      }
      return;
    }

    // ---- 分支三：ReAct 问答 ----
    let progressSent = 0;
    const task = await agent.processGoal(text, {
      sessionScope: ctx.sessionScope,
      targetOpenid: ctx.target,
      isGroup: ctx.isGroup,
      onProgress: (note) => {
        // 只在真的调用工具时补一条进度，且最多一条，省下配额给正文
        if (progressSent > 0) return;
        progressSent += 1;
        ctx.reply(`${note}…`).catch((err) => log.warn('进度消息发送失败', err));
      },
    });

    const budget = Math.max(1, remainingReplies(ctx, gateway));
    const chunks = splitForChat(task.result, budget);
    for (const chunk of chunks) {
      const res = await ctx.reply(chunk);
      if (res && res.ok === false) {
        log.error('正文分段发送失败，停止后续分段', res);
        break;
      }
    }
    log.info('回答已发出', {
      elapsedMs: task.elapsedMs,
      cached: Boolean(task.cached),
      chunks: chunks.length,
      progressSent,
    });
  };
}

module.exports = { createHandler, splitForChat, _internal: { remainingReplies } };
