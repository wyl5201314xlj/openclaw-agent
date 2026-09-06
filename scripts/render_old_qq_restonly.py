# -*- coding: utf-8 -*-
"""旧服务切换为「推送专用」模式：恢复 QQ 凭据（REST 主动推送所需）+ QQ_WS_DISABLED=1。

- 同一机器人仅允许一条 WebSocket，交互已割接到官方 OpenClaw 网关；
- 旧服务保留 08:30 热点推送 / 定时提醒，走 REST 队列，不再连 WS；
- QQ_APP_SECRET 复用 qq_bot_openclaw.app_secret（官方网关同 appid 已实测有效）。
安全约束：仅 https + api.render.com 白名单 + IP 边界校验 + 禁重定向；密钥不落日志。
"""
import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit

sys.path.insert(0, r'D:\Tools')
import creds  # noqa: E402

KEY = creds.get('render_openclaw', 'api_key') or creds.get('render', 'api_key')
SERVICE_ID = 'srv-dab7hass728c739r9oq0'
ALLOWED_HOST = 'api.render.com'
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('拒绝重定向')


_OPENER = urllib.request.build_opener(_NoRedirect)


def _assert_safe(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname != ALLOWED_HOST:
        raise ValueError('目标不在白名单')
    for info in socket.getaddrinfo(parts.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip in _FAKE_IP:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError('解析到非公网地址，已阻断')
    return url


def api(path, method='GET', payload=None):
    url = _assert_safe('https://api.render.com/v1' + path)
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + KEY,
        'Accept': 'application/json', 'Content-Type': 'application/json'})
    try:
        with _OPENER.open(req, timeout=60) as resp:
            body = resp.read().decode('utf-8', 'replace')
            return resp.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, {'raw': e.read().decode('utf-8', 'replace')[:200]}


app_id = creds.get('qq_bot_openclaw', 'app_id') or '1905540663'
app_secret = creds.get('qq_bot_openclaw', 'app_secret')
if not app_secret:
    raise SystemExit('凭据库缺少 qq_bot_openclaw.app_secret')

ADD = {
    'QQ_APP_ID': app_id,
    'QQ_APP_SECRET': app_secret,
    'QQ_WS_DISABLED': '1',
}

st, existing = api('/services/{}/env-vars?limit=100'.format(SERVICE_ID))
if st != 200:
    raise SystemExit('读取环境变量失败 HTTP {}'.format(st))

merged = {}
for e in existing:
    ev = e.get('envVar', e)
    merged[ev['key']] = ev.get('value', '')
merged.update(ADD)

payload = [{'key': k, 'value': v} for k, v in sorted(merged.items())]
st, resp = api('/services/{}/env-vars'.format(SERVICE_ID), 'PUT', payload)
print('写入环境变量 -> HTTP', st)

st, after = api('/services/{}/env-vars?limit=100'.format(SERVICE_ID))
keys = sorted((e.get('envVar', e))['key'] for e in after)
print('QQ_APP_ID 存在:', 'QQ_APP_ID' in keys)
print('QQ_APP_SECRET 存在:', 'QQ_APP_SECRET' in keys)
print('QQ_WS_DISABLED 存在:', 'QQ_WS_DISABLED' in keys)
print('MASTER_OPENID 存在:', 'MASTER_OPENID' in keys)

st, d = api('/services/{}/deploys'.format(SERVICE_ID), 'POST', {'clearCache': 'do_not_clear'})
print('触发重部署 -> HTTP', st, d.get('id', '')[:14])
