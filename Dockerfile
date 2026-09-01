FROM node:22-alpine

WORKDIR /app

# 512MB cgroup 下必须给 V8 老生代显式封顶，否则 V8 会按宿主可见内存把堆设得过大而 OOM。
# 线上实测基线 RSS 约 73MB，384MB 老生代 + 运行时开销仍留有余量。
ENV NODE_ENV=production \
    NODE_OPTIONS=--max-old-space-size=384 \
    PORT=10000

# 先只拷依赖清单以利用 Docker 层缓存；npm ci 严格按 lock 安装，保证构建可复现
# （旧版用 npm install --legacy-peer-deps 且没有 lock 文件，每次部署都会重新解析 semver 范围）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

EXPOSE 10000

# 容器内自带健康检查，与 Render 探针形成双重保障
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||10000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
