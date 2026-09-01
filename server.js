// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const agent = require('./lib/agent_engine');
const router = require('./lib/model_router');
const qqBot = require('./lib/qq_bot');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. 保活心跳健康探针
app.get('/health', (req, res) => {
  res.json({
    status: 'HEALTHY',
    service: 'OpenClaw Agent Orchestrator',
    qqBotConnected: qqBot.isConnected,
    timestamp: new Date().toISOString(),
    memoryUsageMB: (process.memoryUsage().rss / 1024 / 1024).toFixed(2),
    stats: router.stats
  });
});

// 2. 获取任务清单
app.get('/api/tasks', (req, res) => {
  res.json({ tasks: agent.getTasks() });
});

// 3. 下发任务接口
app.post('/api/dispatch', async (req, res) => {
  const { goal } = req.body;
  if (!goal) return res.status(400).json({ error: 'goal is required' });
  
  agent.processGoal(goal);
  res.json({ message: 'Task dispatched successfully', timestamp: Date.now() });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[OpenClaw] Agent Server is running on port ${PORT}`);
  console.log(`[OpenClaw] Health Check endpoint: http://0.0.0.0:${PORT}/health`);
  
  // 启动专属 QQ 机器人长连接网关
  qqBot.connect();
});
