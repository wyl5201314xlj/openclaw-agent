# OpenClaw 官方网关 × QQ 机器人（Render 部署）
#
# 结构：
#   - openclaw@2026.9.2 官方网关（全局安装）
#   - QQ 频道官方插件 @tencent-connect/openclaw-qqbot（build 期装进扩展目录）
#   - entrypoint.cjs 启动时从环境变量渲染 openclaw.json（凭据不进镜像）
#
# 环境变量（Render 控制台配置）：
#   QQ_APP_ID / QQ_CLIENT_SECRET  机器人凭据
#   AGNES_API_KEY                 Agnes 大模型 Key（OpenAI 兼容）
#   AGNES_BASE_URL                默认 https://api.agnes-ai.cn/v1
#   AGNES_MODEL_ID                默认 agnes-2.5-flash
#   GATEWAY_TOKEN                 网关控制台访问令牌（未设则每次启动随机生成并打印）
FROM node:22-bookworm-slim

# 路径约定：配置/状态在 /var/lib/openclaw，扩展随 OPENCLAW_HOME 落在 /var/lib/openclaw/.openclaw/extensions
ENV OPENCLAW_HOME=/var/lib/openclaw \
    OPENCLAW_STATE_DIR=/var/lib/openclaw \
    OPENCLAW_CONFIG_PATH=/var/lib/openclaw/openclaw.json \
    AGNES_BASE_URL=https://api.agnes-ai.cn/v1 \
    AGNES_MODEL_ID=agnes-2.5-flash

WORKDIR /var/lib/openclaw

# 先落一份最小配置再装插件（插件安装不需要 QQ 凭据，凭据只在运行时由 entrypoint 注入）
RUN mkdir -p /var/lib/openclaw && \
    printf '{"gateway":{"mode":"local"}}\n' > /var/lib/openclaw/openclaw.json && \
    npm install -g openclaw@2026.9.2 --no-audit --no-fund && \
    openclaw plugins install @tencent-connect/openclaw-qqbot@latest --accept-capabilities --force && \
    npm cache clean --force

COPY entrypoint.cjs /usr/local/bin/openclaw-entrypoint.cjs

ENV PORT=3000
EXPOSE 3000

# 官方网关的健康端点是 /health，/healthz 实测 404（曾导致 Render 健康检查判定失败）
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.OPENCLAW_GATEWAY_PORT||process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "/usr/local/bin/openclaw-entrypoint.cjs"]
