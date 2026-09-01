// lib/qq_bot.js
const axios = require('axios');
const WebSocket = require('ws');
const agent = require('./agent_engine');

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
      console.log('[QQ-Bot] 获取 AccessToken 成功！');
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
    if (!this.appId || !this.appSecret) {
      console.log('[QQ-Bot] 未配置 QQ_APP_ID 或 QQ_APP_SECRET，跳过机器人启动。');
      return;
    }

    try {
      const gatewayUrl = await this.getGatewayUrl();
      console.log(`[QQ-Bot] 正在连接腾讯 WebSocket 网关: ${gatewayUrl}`);
      this.ws = new WebSocket(gatewayUrl);

      this.ws.on('open', () => {
        console.log('[QQ-Bot] WebSocket 握手建立，正在鉴权...');
      });

      this.ws.on('message', async (raw) => {
        try {
          const payload = JSON.parse(raw.toString());
          await this.handlePayload(payload);
        } catch (e) {
          console.error('[QQ-Bot] 解析消息异常:', e);
        }
      });

      this.ws.on('close', (code, reason) => {
        console.warn(`[QQ-Bot] 连接断开 (code: ${code})，3秒后自动重连...`);
        this.cleanup();
        setTimeout(() => this.connect(), 3000);
      });

      this.ws.on('error', (err) => {
        console.error('[QQ-Bot] WebSocket 报错:', err.message);
      });
    } catch (err) {
      console.error('[QQ-Bot] 连接初始化失败:', err.message);
      setTimeout(() => this.connect(), 5000);
    }
  }

  cleanup() {
    this.isConnected = false;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  async handlePayload(payload) {
    const { op, d, s, t } = payload;
    if (s) this.lastSeq = s;

    // Opcode 10: Hello 握手
    if (op === 10) {
      const heartbeatInterval = d.heartbeat_interval;
      this.startHeartbeat(heartbeatInterval);
      await this.sendIdentify();
    }
    // Opcode 11: Heartbeat ACK
    else if (op === 11) {
      // 心跳确认
    }
    // Opcode 0: 事件分发
    else if (op === 0) {
      if (t === 'READY') {
        this.isConnected = true;
        this.sessionId = d.session_id;
        console.log(`[QQ-Bot] ✅ 官方机器人鉴权上线成功！Bot: ${d.user?.username || this.appId}`);
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
    // 监听私聊与群聊 @ 事件: (1 << 25) | (1 << 30) | (1 << 1)
    const intents = (1 << 25) | (1 << 30) | (1 << 1);
    const identifyPayload = {
      op: 2,
      d: {
        token: `QQBot ${token}`,
        intents: intents,
        shard: [0, 1]
      }
    };
    this.ws.send(JSON.stringify(identifyPayload));
  }

  async onUserMessage(eventType, data) {
    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const senderId = data.author?.member_openid || data.author?.user_openid || data.author?.id;
    let content = (data.content || '').trim();

    // 过滤掉 @机器人 标签
    content = content.replace(/<@!?[^>]+>/g, '').trim();
    if (!content) return;

    console.log(`[QQ-Bot] 收到消息 (From: ${senderId}): ${content}`);

    // 1. 认主与私有权限校验
    const isMaster = senderId === this.masterOpenId || content.includes('认主') || content.includes('绑定主人');
    if (!isMaster) {
      // 非主人，专属私有机器人拒绝服务
      await this.sendMessage(eventType, data, '🔒 我是主人的专属私有 OpenClaw 智能体中枢，仅为唯一主人服务哦~');
      return;
    }

    // 2. 触发认主绑定
    if (content.includes('认主') || content.includes('绑定主人')) {
      this.masterOpenId = senderId;
      process.env.MASTER_OPENID = senderId;
      await this.sendMessage(eventType, data, '👑 报告主人！专属 OpenClaw 智能体已完成认主绑定，随时听候主人差遣！');
      return;
    }

    // 3. 触发云端 Agent 规划与执行
    await this.sendMessage(eventType, data, `🧠 收到主人指令，正在云端 7x24h 环境启动规划与工具调用...\n【目标】: ${content}`);

    try {
      const taskRecord = await agent.processGoal(content);
      const resultText = taskRecord.result || '执行完毕，无文本返回。';
      
      // 智能分段发送（防止超过腾讯 1500 字符限制）
      if (resultText.length > 900) {
        const p1 = resultText.slice(0, 900);
        const p2 = resultText.slice(900);
        await this.sendMessage(eventType, data, `📋 [执行报告 1/2]:\n${p1}`);
        await new Promise(r => setTimeout(r, 300));
        await this.sendMessage(eventType, data, `📋 [执行报告 2/2]:\n${p2}`);
      } else {
        await this.sendMessage(eventType, data, `📋 报告主人，任务执行完成！\n${resultText}`);
      }
    } catch (err) {
      await this.sendMessage(eventType, data, `❌ 任务执行异常: ${err.message}`);
    }
  }

  async sendMessage(eventType, originalData, text) {
    const isGroup = eventType === 'GROUP_AT_MESSAGE_CREATE';
    const token = await this.getAccessToken();
    const msgId = originalData.id;

    try {
      let targetUrl = '';
      if (isGroup) {
        const groupOpenId = originalData.group_openid;
        targetUrl = `https://api.sgroup.qq.com/v2/groups/${groupOpenId}/messages`;
      } else {
        const userOpenId = originalData.author?.user_openid || originalData.author?.id;
        targetUrl = `https://api.sgroup.qq.com/v2/users/${userOpenId}/messages`;
      }

      await axios.post(targetUrl, {
        content: text,
        msg_type: 0,
        msg_id: msgId
      }, {
        headers: {
          'Authorization': `QQBot ${token}`,
          'Content-Type': 'application/json'
        },
        timeout: 8000
      });
    } catch (err) {
      console.error('[QQ-Bot] 发信失败:', err.response?.data || err.message);
    }
  }
}

module.exports = new QQBotGateway();
