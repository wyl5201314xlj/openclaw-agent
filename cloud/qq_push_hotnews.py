#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""QQ 每日热点推送（Alwaysdata 常驻版，纯标准库）。

由 keepalive.sh 每轮调用；自判北京时间 >= 08:30 且当日未推才真正发送，
未到点秒退。链路：GoogleNews 中文热点 RSS（备源 HN）-> 标题去重 -> 纯文本
摘要（不含 URL，QQ 会过滤未报备外链）-> QQ 官方 REST 主动消息（不依赖
WebSocket，与官方 OpenClaw 网关的 WS 互不冲突）。

安全约束：https + 出站域名白名单 + 解析 IP 边界校验（阻断私网/环回/链路
本地/保留段）+ 禁重定向；本地文件全部限制在本脚本目录内（启动时校验）。
用法：python3 qq_push_hotnews.py [--force]
配置：同目录 qq_config.json（appId/clientSecret/masterOpenid，chmod 600）
"""
import ipaddress
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parent
TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
SEND_URL = 'https://api.sgroup.qq.com/v2/users/{openid}/messages'
RSS_URL = 'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans'
HN_URL = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=10'
ALLOWED_HOSTS = frozenset(('bots.qq.com', 'api.sgroup.qq.com', 'news.google.com', 'hn.algolia.com'))
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')
MAX_ITEMS = 8
TITLE_MAX = 48
PUSH_HOUR, PUSH_MIN = 8, 30
CONFIG_PATH = BASE / 'qq_config.json'
STATE_PATH = BASE / 'state.json'
LOG_PATH = BASE / 'qq_push.log'
LOG_MAX_LINES = 400
LOG_KEEP_LINES = 300


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('reject redirect')


_OPENER = urllib.request.build_opener(_NoRedirect)

# 启动即锁定本地文件边界：三个文件必须落在本脚本目录内，拒绝任何逃逸
for _p in (CONFIG_PATH, STATE_PATH, LOG_PATH):
    if BASE not in _p.resolve().parents and _p.resolve() != BASE:
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


def http_text(url, timeout=25):
    _assert_safe(url)
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (qq-hotnews-push)'})
    with _OPENER.open(req, timeout=timeout) as r:
        return r.read().decode('utf-8', 'replace')


def beijing_now():
    return time.gmtime(time.time() + 8 * 3600)


def load_state():
    try:
        s = json.loads(STATE_PATH.read_text(encoding='utf-8'))
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(s):
    STATE_PATH.write_text(json.dumps(s, ensure_ascii=False), encoding='utf-8')


def _assert_safe(url):
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in ALLOWED_HOSTS:
        raise ValueError('target not in whitelist: %s' % url)
    for info in socket.getaddrinfo(parts.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip in _FAKE_IP:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError('resolved to non-public address, blocked: %s' % ip)
    return url


def fetch_google_news():
    text = http_text(RSS_URL)
    items = []
    for raw in re.findall(r'<item>[\s\S]*?</item>', text):
        m = re.search(r'<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?</title>', raw)
        if not m:
            continue
        title = re.sub(r'\s+-\s+[^-]{2,20}$', '', m.group(1)).strip()
        src = re.search(r'<source[^>]*>([\s\S]*?)</source>', raw)
        source = (src.group(1).strip() if src else '') or '新闻'
        if title:
            items.append({'title': title, 'source': source})
        if len(items) >= MAX_ITEMS:
            break
    return items


def fetch_hn():
    data = json.loads(http_text(HN_URL))
    return [{'title': h['title'].strip(), 'source': 'HackerNews'}
            for h in data.get('hits', []) if h.get('title')][:MAX_ITEMS]


def fetch_top_news():
    for fetcher, name in ((fetch_google_news, 'GoogleNews'), (fetch_hn, 'HN')):
        try:
            items = fetcher()
            if items:
                return items
            log('source %s returned 0 items' % name)
        except Exception as e:  # noqa: BLE001
            log('source %s failed: %s' % (name, e))
    return []


def build_digest(items, label):
    lines = ['📰 今日热点速览（%s）' % label, '———————————']
    for i, it in enumerate(items, 1):
        t = it['title'] if len(it['title']) <= TITLE_MAX else it['title'][:TITLE_MAX] + '…'
        lines.append('%d. %s（%s）' % (i, t, it['source']))
    lines.append('———————————')
    lines.append('💬 想聊哪条热点？直接发消息告诉我~')
    return '\n'.join(lines)


def get_token(cfg):
    body = json.dumps({'appId': cfg['appId'], 'clientSecret': cfg['clientSecret']}).encode()
    _assert_safe(TOKEN_URL)
    req = urllib.request.Request(TOKEN_URL, data=body, method='POST',
                                 headers={'Content-Type': 'application/json'})
    with _OPENER.open(req, timeout=25) as r:
        data = json.loads(r.read().decode('utf-8', 'replace'))
    if not data.get('access_token'):
        raise RuntimeError('bad token response: %s' % json.dumps(data)[:160])
    return data['access_token']


def send_text(cfg, token, text):
    url = SEND_URL.format(openid=urllib.parse.quote(cfg['masterOpenid'], safe=''))
    _assert_safe(url)
    body = json.dumps({'content': text, 'msg_type': 0}, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(url, data=body, method='POST', headers={
        'Authorization': 'QQBot ' + token, 'Content-Type': 'application/json'})
    with _OPENER.open(req, timeout=25) as r:
        return json.loads(r.read().decode('utf-8', 'replace'))


def main():
    force = '--force' in sys.argv
    now = beijing_now()
    today = time.strftime('%Y-%m-%d', now)
    state = load_state()
    if not force:
        if (now.tm_hour, now.tm_min) < (PUSH_HOUR, PUSH_MIN):
            return
        if state.get('date') == today:
            return
    cfg = json.loads(CONFIG_PATH.read_text(encoding='utf-8'))
    items = fetch_top_news()
    if not items:
        log('%s no news source available, skip' % today)
        return
    seen = set(state.get('titles', [])) if not force else set()
    fresh = [it for it in items if it['title'] not in seen]
    picked = (fresh if len(fresh) >= 3 else items)[:MAX_ITEMS]
    text = build_digest(picked, '%d月%d日' % (now.tm_mon, now.tm_mday))
    token = get_token(cfg)
    resp = send_text(cfg, token, text)
    save_state({'date': today, 'titles': [it['title'] for it in picked]})
    log('pushed %d items, resp=%s' % (len(picked), json.dumps(resp, ensure_ascii=False)[:120]))


if __name__ == '__main__':
    main()
