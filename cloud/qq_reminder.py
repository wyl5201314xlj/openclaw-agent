#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QQ 定时提醒（Alwaysdata 常驻版，纯标准库）——不依赖模型自觉的兜底通道。

背景：官方 OpenClaw 网关的 cron 工具要求"可信 agent 运行时身份"
（dist/gateway 里 trusted operational run instance 守卫），只有真实 agent
回合能注册，外部无法代注册、也无法代验证。故本脚本提供一条完全独立的提醒
链路：本地 JSON 存任务 + 每轮 tick 自判到点 + QQ 官方 REST 主动消息推送。
不占用 WebSocket，与网关互不冲突。

链路与安全约束沿用同目录 qq_push_hotnews.py 的成熟形态：
  https + 出站域名白名单 + 解析后 IP 边界校验（阻断私网/环回/链路本地/
  保留段）+ 禁重定向；本地文件全部限制在本脚本目录内（启动时校验）。

用法：
  python3 qq_reminder.py add --in 3m --text "喝水"      # 相对时间一次性
  python3 qq_reminder.py add --daily 08:30 --text "打卡"  # 每天固定时刻
  python3 qq_reminder.py list
  python3 qq_reminder.py remove <id>
  python3 qq_reminder.py tick                           # 由常驻循环调用
配置：同目录 qq_config.json（appId/clientSecret/masterOpenid，chmod 600）
"""
import argparse
import ipaddress
import json
import re
import secrets
import socket
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

BASE = Path(__file__).resolve().parent
TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
SEND_URL = 'https://api.sgroup.qq.com/v2/users/{openid}/messages'
ALLOWED_HOSTS = frozenset(('bots.qq.com', 'api.sgroup.qq.com'))
# 本机/容器代理常把域名解析进 fake-IP 段，属正常，不视为内网穿透
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')

CONFIG_PATH = BASE / 'qq_config.json'
JOBS_PATH = BASE / 'reminders.json'
LOG_PATH = BASE / 'reminder.log'
LOG_MAX_LINES = 400
LOG_KEEP_LINES = 300
# 到点后允许的最大补发窗口：容器重启或循环卡顿时仍补发，超期则丢弃不打扰
CATCHUP_LIMIT_SEC = 3600
MAX_JOBS = 50
TEXT_MAX = 200

_DUR_RE = re.compile(r'^(\d{1,4})([smhd])$')
_HHMM_RE = re.compile(r'^([01]?\d|2[0-3]):([0-5]\d)$')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('reject redirect')


_OPENER = urllib.request.build_opener(_NoRedirect)

# 启动即锁定本地文件边界：三个文件必须落在本脚本目录内，拒绝任何路径逃逸
for _p in (CONFIG_PATH, JOBS_PATH, LOG_PATH):
    if _p.resolve().parent != BASE:
        raise SystemExit('local file escapes base dir: %s' % _p)


def log(msg):
    line = time.strftime('%F %T', time.gmtime()) + 'Z ' + msg
    print(line)
    try:
        old = LOG_PATH.read_text(encoding='utf-8') if LOG_PATH.exists() else ''
        lines = (old + line + '\n').splitlines(keepends=True)
        if len(lines) > LOG_MAX_LINES:
            lines = lines[-LOG_KEEP_LINES:]
        LOG_PATH.write_text(''.join(lines), encoding='utf-8')
    except OSError:
        pass


def _assert_safe(url):
    """出站前置校验：协议 + 域名白名单 + 解析后 IP 边界，阻断 SSRF 与 DNS 重绑。"""
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in ALLOWED_HOSTS:
        raise ValueError('host not allowed: %s' % url)
    for info in socket.getaddrinfo(parts.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip in _FAKE_IP:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError('resolved to non-public address: %s' % ip)
    return url


def http_json(url, payload=None, headers=None, timeout=25):
    _assert_safe(url)
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    hdrs = {'Content-Type': 'application/json', 'User-Agent': 'qq-reminder/1.0'}
    hdrs.update(headers or {})
    req = urllib.request.Request(url, data=data, method='POST', headers=hdrs)
    with _OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8', 'replace') or '{}')


def load_config():
    """凭据只从同目录 600 权限的配置文件读取，脚本内不含任何字面量。"""
    cfg = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
    for key in ('appId', 'clientSecret', 'masterOpenid'):
        if not str(cfg.get(key) or '').strip():
            raise SystemExit('qq_config.json missing %s' % key)
    return cfg


def get_token(cfg):
    data = http_json(TOKEN_URL, {'appId': str(cfg['appId']),
                                 'clientSecret': str(cfg['clientSecret'])})
    token = str(data.get('access_token') or '')
    if not token:
        raise RuntimeError('no access_token in response')
    return token


def send_text(cfg, openid, text):
    token = get_token(cfg)
    url = SEND_URL.format(openid=urllib.parse.quote(openid, safe=''))
    return http_json(url, {'content': text, 'msg_type': 0},
                     headers={'Authorization': 'QQBot ' + token})


def beijing_struct(ts=None):
    return time.gmtime((time.time() if ts is None else ts) + 8 * 3600)


def load_jobs():
    if not JOBS_PATH.exists():
        return []
    try:
        data = json.loads(JOBS_PATH.read_text(encoding='utf-8'))
    except (ValueError, OSError):
        return []
    return data.get('jobs', []) if isinstance(data, dict) else []


def save_jobs(jobs):
    JOBS_PATH.write_text(json.dumps({'jobs': jobs}, ensure_ascii=False, indent=2),
                         encoding='utf-8')


def parse_duration(raw):
    m = _DUR_RE.match(str(raw).strip())
    if not m:
        raise SystemExit('bad --in (use 30s/5m/2h/1d): %s' % raw)
    n, unit = int(m.group(1)), m.group(2)
    if n <= 0:
        raise SystemExit('--in must be positive')
    return n * {'s': 1, 'm': 60, 'h': 3600, 'd': 86400}[unit]


def next_daily_ts(hh, mm, now=None):
    """返回下一个北京时间 hh:mm 对应的 UTC 时间戳。"""
    now = time.time() if now is None else now
    bj = beijing_struct(now)
    midnight_bj = now - (bj.tm_hour * 3600 + bj.tm_min * 60 + bj.tm_sec)
    target = midnight_bj + hh * 3600 + mm * 60
    return target if target > now else target + 86400


def cmd_add(args):
    cfg = load_config()
    text = str(args.text or '').strip()
    if not text:
        raise SystemExit('--text required')
    if len(text) > TEXT_MAX:
        raise SystemExit('--text too long (max %d)' % TEXT_MAX)
    jobs = load_jobs()
    if len(jobs) >= MAX_JOBS:
        raise SystemExit('too many jobs (max %d), remove some first' % MAX_JOBS)

    job = {'id': secrets.token_hex(4), 'text': text,
           'openid': str(args.openid or cfg['masterOpenid']).strip()}
    if args.daily:
        m = _HHMM_RE.match(args.daily.strip())
        if not m:
            raise SystemExit('bad --daily (use HH:MM): %s' % args.daily)
        hh, mm = int(m.group(1)), int(m.group(2))
        job['repeat'] = {'hh': hh, 'mm': mm}
        job['dueTs'] = next_daily_ts(hh, mm)
    elif getattr(args, 'in_'):
        job['repeat'] = None
        job['dueTs'] = time.time() + parse_duration(args.in_)
    else:
        raise SystemExit('need --in or --daily')

    jobs.append(job)
    save_jobs(jobs)
    due = time.strftime('%F %T', beijing_struct(job['dueTs']))
    log('added %s "%s" due %s +08:00%s' % (
        job['id'], text, due, ' (daily)' if job.get('repeat') else ''))
    return 0


def cmd_list(_args):
    jobs = load_jobs()
    if not jobs:
        print('(no reminders)')
        return 0
    for j in sorted(jobs, key=lambda x: x.get('dueTs', 0)):
        due = time.strftime('%F %T', beijing_struct(j.get('dueTs', 0)))
        kind = 'daily %02d:%02d' % (j['repeat']['hh'], j['repeat']['mm']) if j.get('repeat') else 'once'
        print('%s | %s +08:00 | %-13s | %s' % (j.get('id'), due, kind, j.get('text')))
    return 0


def cmd_remove(args):
    jobs = load_jobs()
    kept = [j for j in jobs if j.get('id') != args.job_id]
    if len(kept) == len(jobs):
        print('no such id: %s' % args.job_id)
        return 1
    save_jobs(kept)
    log('removed %s' % args.job_id)
    return 0


def cmd_tick(_args):
    """由常驻循环每轮调用：到点即发，一次性任务发完删除，每日任务顺延次日。"""
    jobs = load_jobs()
    if not jobs:
        return 0
    now = time.time()
    due = [j for j in jobs if float(j.get('dueTs') or 0) <= now]
    if not due:
        return 0

    cfg = load_config()
    remaining, changed = [], False
    for job in jobs:
        if job not in due:
            remaining.append(job)
            continue
        changed = True
        late = now - float(job.get('dueTs') or 0)
        if late > CATCHUP_LIMIT_SEC and not job.get('repeat'):
            log('drop %s (overdue %.0fs > limit)' % (job.get('id'), late))
            continue
        try:
            resp = send_text(cfg, job['openid'], '⏰ 提醒：' + job['text'])
            log('fired %s "%s" late=%.0fs id=%s' % (
                job.get('id'), job['text'], late,
                str(resp.get('id') or '')[:24]))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                OSError, ValueError, RuntimeError) as err:
            # 发送失败：一次性任务顺延 5 分钟重试，避免网络抖动直接丢提醒
            log('FAILED %s: %s' % (job.get('id'), str(err)[:120]))
            job['dueTs'] = now + 300
            remaining.append(job)
            continue
        if job.get('repeat'):
            job['dueTs'] = next_daily_ts(job['repeat']['hh'], job['repeat']['mm'], now)
            remaining.append(job)

    if changed:
        save_jobs(remaining)
    return 0


def main():
    ap = argparse.ArgumentParser(description='QQ 定时提醒（Alwaysdata 兜底通道）')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p_add = sub.add_parser('add', help='新增提醒')
    p_add.add_argument('--in', dest='in_', help='相对时间：30s/5m/2h/1d')
    p_add.add_argument('--daily', help='每天固定时刻：HH:MM（北京时间）')
    p_add.add_argument('--text', required=True, help='提醒内容')
    p_add.add_argument('--openid', help='目标 openid，默认用配置里的 masterOpenid')
    p_add.set_defaults(func=cmd_add)

    sub.add_parser('list', help='列出提醒').set_defaults(func=cmd_list)

    p_rm = sub.add_parser('remove', help='删除提醒')
    p_rm.add_argument('job_id')
    p_rm.set_defaults(func=cmd_remove)

    sub.add_parser('tick', help='检查并触发到点提醒').set_defaults(func=cmd_tick)

    args = ap.parse_args()
    raise SystemExit(args.func(args))


if __name__ == '__main__':
    main()
