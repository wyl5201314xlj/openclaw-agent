# -*- coding: utf-8 -*-
"""阶段一 1-4：配置 Render 环境变量 SUB_TOKENS + MASTER_OPENID。

安全约束：仅 https + api.render.com 白名单 + IP 边界校验 + 禁重定向；
凭据从 creds.py 读取；SUB_TOKENS 复用 ADMIN_TOKEN（主人手机订阅用同一个 token 即可）。
MASTER_OPENID 从凭据库 qq_bot_openclaw.master_openid 读取。
"""
import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from pathlib import Path

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


admin_token = Path(r'D:\Tools\secrets\openclaw_admin_token.txt').read_text(encoding='utf-8').strip()
master_openid = creds.get('qq_bot_openclaw', 'master_openid') or ''
print('MASTER_OPENID 已取到:', '是' if master_openid else '否（将只配 SUB_TOKENS）')

st, existing = api('/services/{}/env-vars?limit=100'.format(SERVICE_ID))
current = {}
for e in (existing if st == 200 else []):
    ev = e.get('envVar', e)
    current[ev['key']] = ev.get('value', '')

current['SUB_TOKENS'] = admin_token
if master_openid:
    current['MASTER_OPENID'] = master_openid

payload = [{'key': k, 'value': v} for k, v in sorted(current.items())]
st, resp = api('/services/{}/env-vars'.format(SERVICE_ID), 'PUT', payload)
print('写入环境变量 -> HTTP', st)
if st not in (200, 201):
    print(json.dumps(resp, ensure_ascii=False)[:300])
    raise SystemExit(1)

st, after = api('/services/{}/env-vars?limit=100'.format(SERVICE_ID))
keys = sorted((e.get('envVar', e))['key'] for e in after)
print('SUB_TOKENS 已配置:', 'SUB_TOKENS' in keys)
print('MASTER_OPENID 已配置:', 'MASTER_OPENID' in keys)
