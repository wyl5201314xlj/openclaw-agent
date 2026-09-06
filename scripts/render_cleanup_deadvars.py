# -*- coding: utf-8 -*-
"""梯子下线后清理 Render 死配置：移除 SUB_TOKENS / MASTER_OPENID（代码已不引用）。

安全约束：仅 https + api.render.com 白名单 + IP 边界校验 + 禁重定向；凭据走 creds.py。
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


DEAD_KEYS = {'SUB_TOKENS', 'MASTER_OPENID'}

st, existing = api('/services/{}/env-vars?limit=100'.format(SERVICE_ID))
if st != 200:
    raise SystemExit('读取环境变量失败 HTTP {}'.format(st))

kept = []
removed = []
for e in existing:
    ev = e.get('envVar', e)
    k = ev['key']
    if k in DEAD_KEYS:
        removed.append(k)
    else:
        kept.append({'key': k, 'value': ev.get('value', '')})

print('将移除死配置:', removed or '无')
st, resp = api('/services/{}/env-vars'.format(SERVICE_ID), 'PUT', sorted(kept, key=lambda x: x['key']))
print('写入 -> HTTP', st)

st, after = api('/services/{}/env-vars?limit=100'.format(SERVICE_ID))
keys = sorted((e.get('envVar', e))['key'] for e in after)
print('清理后键:', keys)
print('SUB_TOKENS 已清除:', 'SUB_TOKENS' not in keys)
print('MASTER_OPENID 已清除:', 'MASTER_OPENID' not in keys)
