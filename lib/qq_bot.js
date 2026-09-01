// lib/qq_bot.js
const axios = require('axios');
const WebSocket = require('ws');
const agent = require('./agent_engine');
const timerTool = require('./tools/timer_tool');
const imageTool = require('./tools/image_tool');

class QQBotGateway {
  constructor() {
    this.appId = process.env.QQ_APP_ID || '';
    this.appSecret = process.env.QQ_APP_SECRET || '';
    this.masterOpenId = process.env.MASTER_OPENID || '7663E909FE7CBCC25A780161CE3EB2DF';
    this.accessToken = '';
    this.tokenExpiresAt = 0;
    this.ws = null;
    this.heartbeatTimer = null;
    this.sessionId = '';
    this.lastSeq = 0;
    this.isConnected = false;
    this.sendQueue = [];
    this.isProcessingQueue = false;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60000) {
      return this.accessToken;
    }
    try {
      const resp = await axios.post('https://bots.qq.com/app/getAppAccessToken', {
        appId: this.appId,
        clientSecret: this.appSecret
      }, { timeout: 10000 });
      this.accessToken = resp.data.access_token;
      this.tokenExpiresAt = Date.now() + (resp.data.expires_in || 7200) * 1000;
      return this.accessToken;
    } catch (err) {
      console.error('[QQ-Bot] 获取 AccessToken 失败:', err.message);
      throw err;
    }
  }

  async getGatewayUrl() {
    const token = await this.getAccessToken();
    const resp = await axios.get('https://api.sgroup.qq.com/gateway', {
      headers: { 'Authorization': `QQBot ${token}` },
      timeout: 10000
    });
    return resp.data.url;
  }

  async connect() {
    if (!this.appId || !this.appSecret) return;

    try {
      const gatewayUrl = await this.getGatewayUrl();
      this.ws = new WebSocket(gatewayUrl);

      this.ws.on('open', () => console.log('[QQ-Bot] WebSocket 连接建立，正在鉴权...'));
      this.ws.on('message', async (raw) => {
        try {
          const payload = JSON.parse(raw.toString());
          await this.handlePayload(payload);
        } catch (e) {}
      });
      this.ws.on('close', (code) => {
        this.cleanup();
        setTimeout(() => this.connect(), 3000);
      });
      this.ws.on('error', (err) => console.error('[QQ-Bot] WS 报错:', err.message));
    } catch (err) {
      setTimeout(() => this.connect(), 5000);
    }
  }

  cleanup() {
    this.isConnected = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  async handlePayload(payload) {
    const { op, d, s, t } = payload;
    if (s) this.lastSeq = s;

    if (op === 10) {
      this.startHeartbeat(d.heartbeat_interval);
      await this.sendIdentify();
    } else if (op === 0) {
      if (t === 'READY') {
        this.isConnected = true;
        this.sessionId = d.session_id;
        console.log(`[QQ-Bot] ✅ 官方机器人鉴权上线成功！AppID: ${this.appId}`);
      } else if (t === 'C2C_MESSAGE_CREATE' || t === 'GROUP_AT_MESSAGE_CREATE') {
        await this.onUserMessage(t, d);
      }
    }
  }

  startHeartbeat(interval) {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
      }
    }, interval);
  }

  async sendIdentify() {
    const token = await this.getAccessToken();
    const intents = (1 << 25) | (1 << 30) | (1 << 1);
    this.ws.send(JSON.stringify({
      op: 2,
      d: { token: `QQBot ${token}`, intents, shard: [0, 1] }
    }));
  }

  async onUserMessage(eventType, data) {
    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const senderId = data.author?.member_openid || data.author?.user_openid || data.author?.id;
    let content = (data.content || '').trim().replace(/<@!?[^>]+>/g, '').trim();
    if (!content) return;

    console.log(`[QQ-Bot] 收到主人消息: ${content}`);

    // 1. 认主与鉴权
    const isMaster = senderId === this.masterOpenId || content.includes('认主') || content.includes('绑定主人');
    if (!isMaster) {
      await this.sendSmartReply(eventType, data, '🔒 我是主人的专属私有 OpenClaw 智能管家，仅为唯一主人服务~');
      return;
    }

    if (content.includes('认主') || content.includes('绑定主人')) {
      this.masterOpenId = senderId;
      process.env.MASTER_OPENID = senderId;
      await this.sendSmartReply(eventType, data, '👑 报告主人！专属 OpenClaw 智能管家已完成认主，随时候命！');
      return;
    }

    // 2. 意图 A: 定时提醒 (如 "X分钟后提醒我...")
    if (content.includes('提醒') && (content.includes('后') || content.includes('分') || content.includes('秒') || content.includes('点'))) {
      const seconds = timerTool.parseTimeOffset(content);
      const remindText = content.replace(/.*(?:后|在)/, '').replace(/提醒我?/, '').trim() || '您设定的提醒事项';

      timerTool.scheduleReminder(seconds, remindText, senderId, isGroup, async (target, groupMode, msg) => {
        await this.sendProactiveMessage(target, groupMode, msg);
      });

      await this.sendSmartReply(eventType, data, `⏰ 收到主人指令！已为您设定定时器：将在 ${seconds} 秒后准时向您主动推送提醒：\n👉 "${remindText}"`);
      return;
    }

    // 3. 意图 B: 生图 (如 "画...", "生成图片...")
    if (content.startsWith('画') || content.startsWith('生成图片') || content.includes('生图') || content.includes('画一只') || content.includes('画一张')) {
      const drawPrompt = content.replace(/^(?:画|生成图片|生图|帮我画|画一只|画一张)/, '').trim() || '美轮美奂的奇幻风景';
      await this.sendSmartReply(eventType, data, `🎨 收到主人绘画需求，正在调用 Agnes 顶级画师云端渲染中...\n【画面】: ${drawPrompt}`);

      try {
        const imgResult = await imageTool.generateImage(drawPrompt);
        if (imgResult.url) {
          await this.sendSmartReply(eventType, data, `🖼️ 报告主人，画作已完成！\n高清直链: ${imgResult.url}`);
        } else {
          await this.sendSmartReply(eventType, data, `🖼️ 报告主人，画作渲染成功！`);
        }
      } catch (err) {
        await this.sendSmartReply(eventType, data, `❌ 生图异常: ${err.message}`);
      }
      return;
    }

    // 4. 意图 C: 通用 Agent 任务与深度问答
    await this.sendSmartReply(eventType, data, `🧠 正在云端 7x24h 容器启动 ReAct 闭环规划与工具调用...\n【任务】: ${content}`);

    try {
      const taskRecord = await agent.processGoal(content);
      const resultText = taskRecord.result || '执行完毕。';

      if (resultText.length > 900) {
        await this.sendSmartReply(eventType, data, `📋 [报告 1/2]:\n${resultText.slice(0, 900)}`);
        await new Promise(r => setTimeout(r, 300));
        await this.sendSmartReply(eventType, data, `📋 [报告 2/2]:\n${resultText.slice(900)}`);
      } else {
        await this.sendSmartReply(eventType, data, `📋 报告主人：\n${resultText}`);
      }
    } catch (err) {
      await this.sendSmartReply(eventType, data, `❌ 任务执行异常: ${err.message}`);
    }
  }

  // 被动回复（带 msg_id）
  async sendSmartReply(eventType, originalData, text) {
    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const target = isGroup ? originalData.group_openid : (originalData.author?.user_openid || originalData.author?.id);
    const msgId = originalData.id;
    await this.enqueueMessage(target, isGroup, text, msgId);
  }

  // 主动推送（无需 msg_id，用于定时提醒）
  async sendProactiveMessage(targetOpenid, isGroup, text) {
    await this.enqueueMessage(targetOpenid, isGroup, text, null);
  }

  async enqueueMessage(target, isGroup, text, msgId) {
    this.sendQueue.push({ target, isGroup, text, msgId });
    if (!this.isProcessingQueue) {
      this.processQueue();
    }
  }

  async processQueue() {
    this.isProcessingQueue = true;
    while (this.sendQueue.length > 0) {
      const task = this.sendQueue.shift();
      try {
        await this.sendDirect(task.target, task.isGroup, task.text, task.msgId);
      } catch (e) {}
      await new Promise(r => setTimeout(r, 250)); // 250ms 平滑发信防频控
    }
    this.isProcessingQueue = false;
  }

  async sendDirect(target, isGroup, text, msgId) {
    const token = await this.getAccessToken();
    const url = isGroup 
      ? `https://api.sgroup.qq.com/v2/groups/${target}/messages`
      : `https://api.sgroup.qq.com/v2/users/${target}/messages`;

    const body = { content: text, msg_type: 0 };
    if (msgId) body.msg_id = msgId;

    try {
      await axios.post(url, body, {
        headers: {
          'Authorization': `QQBot ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });
    } catch (err) {
      // 若带 msg_id 报超时过期，自动降级为免 msg_id 主动发信
      if (msgId && err.response?.status === 400) {
        try {
          delete body.msg_id;
          await axios.post(url, body, {
            headers: { 'Authorization': `QQBot ${token}`, 'Content-Type': 'application/json' },
            timeout: 8000
          });
        } catch (_) {}
      }
    }
  }
}

module.exports = new QQBotGateway();
