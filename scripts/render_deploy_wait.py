# -*- coding: utf-8 -*-
"""触发 Render 部署并轮询到 live（api.render.com 白名单 + 禁重定向 + creds 取凭据）。"""
import ipaddress
import json
import socket
import sys
import time
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
        raise ValueError('目标不在白名单: {}'.format(url))
    for info in socket.getaddrinfo(parts.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip in _FAKE_IP:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError('解析到非公网地址，已阻断: {}'.format(ip))
    return url


def api(path, method='GET', payload=None):
    url = _assert_safe('https://api.render.com/v1' + path)
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + KEY,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
    })
    try:
        with _OPENER.open(req, timeout=60) as resp:
            body = resp.read().decode('utf-8', 'replace')
            return resp.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        return e.code, {'raw': e.read().decode('utf-8', 'replace')[:300]}


print('触发部署...')
st, d = api('/services/{}/deploys'.format(SERVICE_ID), 'POST',
            {'clearCache': 'do_not_clear'})
print('HTTP {} -> deploy id={}'.format(st, (d.get('id') or '?')))
deploy_id = d.get('id')
if not deploy_id:
    print(json.dumps(d)[:300])
    raise SystemExit('未获得 deploy id')

terminal = ('live', 'deactivated', 'build_failed', 'canceled', 'pre_deploy_failed')
last = ''
for i in range(80):  # 最多 20 分钟
    st, d = api('/services/{}/deploys/{}'.format(SERVICE_ID, deploy_id))
    status = d.get('status', '?')
    if status != last:
        print('[{:>3}] {} -> {}'.format(i, time.strftime('%H:%M:%S'), status))
        last = status
    if status in terminal:
        break
    time.sleep(15)

print('最终状态:', d.get('status'))
print('commit:', d.get('commit', {}).get('id', '?'))
sys.exit(0 if d.get('status') == 'live' else 1)
