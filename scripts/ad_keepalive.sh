#!/usr/bin/env bash
# OpenClaw 保活 + 提醒调度循环（Alwaysdata 容器常驻版）
#
# 两件事：
#   1. 每 5 分钟打点 Render 网关 /health 与 /（free 实例 15 分钟无入站流量即休眠，
#      QQ WebSocket 是出站连接不算入站，必须外部喂流量）；
#   2. 每 60 秒 tick 一次提醒调度器（qq_reminder.py）与热点推送（qq_push_hotnews.py），
#      两者都自判到点、未到点秒退。提醒要分钟级精度，故节拍取 60 秒而非 5 分钟。
#
# Alwaysdata 禁用 crontab，故用常驻循环（手册推荐的挂机用法）。
# 资源占用：bash + curl + 短命 python < 10MB（容器限额 256MB）。
#
# 互斥用 flock 而非 PID 文件：PID 文件有两个真实踩过的坑——写锁与判锁之间有竞态，
# 且进程被杀后会留下陈旧锁（或锁被误删而进程仍在跑，导致重复起循环、提醒推两遍）。
# flock 由内核持有，进程无论怎么退出锁都自动释放，不存在陈旧锁。
LOCK="$HOME/.openclaw_keepalive.lock"
LOG="$HOME/openclaw_keepalive.log"
PUSH_DIR="$HOME/qq_push"
GW="https://openclaw-qq-gateway.onrender.com"

# 用自身文件描述符 9 抢排他锁；抢不到说明已有实例在跑，直接退出
exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "$(date -u '+%F %T') 已有实例持锁运行，本实例退出" >> "$LOG"
  exit 0
fi
# 记录 PID 仅用于人工排查，互斥不依赖它
echo $$ >&9

trap 'exit 0' TERM INT

tick=0
while true; do
  # 提醒与热点：每轮（60 秒）都跑，脚本各自判定到点与去重
  python3 "$PUSH_DIR/qq_reminder.py" tick >/dev/null 2>&1 || true
  python3 "$PUSH_DIR/qq_push_hotnews.py" >/dev/null 2>&1 || true

  # 保活打点：每 5 轮（约 5 分钟）一次，避免无谓请求
  if [ $((tick % 5)) -eq 0 ]; then
    ts=$(date +%s)
    h=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
        "${GW}/health?_t=${ts}&_src=alwaysdata")
    r=$(curl -s -o /dev/null -w '%{http_code}' -m 20 \
        "${GW}/?_t=${ts}&_src=alwaysdata")
    echo "$(date -u '+%F %T') health=${h} root=${r}" >> "$LOG"

    # 日志超 500KB 只留最后 200 行，防磁盘膨胀（配额 100MB）
    if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 500000 ]; then
      tail -200 "$LOG" > "${LOG}.tmp" && mv "${LOG}.tmp" "$LOG"
    fi
  fi

  tick=$(((tick + 1) % 60))
  sleep 60
done
