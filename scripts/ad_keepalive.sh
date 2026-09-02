#!/usr/bin/env bash
# OpenClaw Render 保活循环（Alwaysdata 容器常驻版）
#
# 背景：Render free 实例 15 分钟无入站流量即休眠；QQ WebSocket 是出站连接不算入站。
# 本脚本在 Alwaysdata 7x24 容器里每 5 分钟打点一次 /health 与 /，双保险。
# Alwaysdata 禁用 crontab，故用常驻循环（实测容器 26 天不重启，手册推荐的挂机用法）。
# 资源占用：bash + curl 循环 < 5MB（容器 OOM 线 240MB，限额 256MB）。

LOCK="$HOME/.openclaw_keepalive.lock"
LOG="$HOME/openclaw_keepalive.log"

# 单实例锁：已有实例存活则直接退出，防止重复起循环
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "$(date -u '+%F %T') 已有实例运行 (pid $(cat "$LOCK"))，本实例退出" >> "$LOG"
  exit 0
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"; exit 0' TERM INT

while true; do
  ts=$(date +%s)
  h=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
      "https://openclaw-agent-8i57.onrender.com/health?_t=${ts}&_src=alwaysdata")
  r=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
      "https://openclaw-agent-8i57.onrender.com/?_t=${ts}&_src=alwaysdata")
  echo "$(date -u '+%F %T') health=${h} root=${r}" >> "$LOG"

  # 日志超过 500KB 只保留最后 200 行，防磁盘膨胀（配额 100MB）
  if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 500000 ]; then
    tail -200 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
  fi

  sleep 300
done
