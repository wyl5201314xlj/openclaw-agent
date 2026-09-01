# -*- coding: utf-8 -*-
"""Cloudflare 一键配置（优化计划 0-6 + 0-7）：

1. 创建/复用 KV 命名空间 `openclaw-agent`（定时提醒持久化）；
2. 读写探测该命名空间，确认 Token 权限确实够用；
3. 上传保活 Worker `openclaw-keepalive` 并设置每 5 分钟 Cron Trigger；
4. 打开 workers.dev 子域，便于手动触发验证。

安全约束：仅 https + api.cloudflare.com 白名单 + IP 边界校验 + 禁重定向；
凭据只从 D:\\Tools\\creds.py 读取，输出一律脱敏。
"""
import ipaddress
import json
import socket
import sys
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

sys.path.insert(0, r'D:\Tools')
import creds  # noqa: E402

TOKEN = creds.get('cloudflare', 'api_token')
ACCOUNT = creds.get('cloudflare', 'account_id')
if not TOKEN or not ACCOUNT:
    raise SystemExit('未取到 cloudflare api_token / account_id')

ALLOWED_HOST = 'api.cloudflare.com'
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')
KV_TITLE = 'openclaw-agent'
WORKER_NAME = 'openclaw-keepalive'
WORKER_SRC = r'D:\ai\cloud-heartbeat\cloudflare-worker\src\index.js'


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


def cf(path, method='GET', payload=None, raw_body=None, content_type=None):
    url = _assert_safe('https://api.cloudflare.com/client/v4' + path)
    headers = {'Authorization': 'Bearer ' + TOKEN}
    if raw_body is not None:
        data = raw_body
        headers['Content-Type'] = content_type
    elif payload is not None:
        data = json.dumps(payload).encode('utf-8')
        headers['Content-Type'] = 'application/json'
    else:
        data = None
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _OPENER.open(req, timeout=60) as resp:
            body = resp.read().decode('utf-8', 'replace')
            try:
                return resp.status, json.loads(body)
            except Exception:  # noqa: BLE001
                return resp.status, {'raw': body[:400]}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(body)
        except Exception:  # noqa: BLE001
            return e.code, {'raw': body[:400]}


def errmsg(d):
    return json.dumps(d.get('errors') or d, ensure_ascii=False)[:300]


# ---------- 1. KV 命名空间 ----------
print('=== 1. KV 命名空间 ===')
st, d = cf('/accounts/{}/storage/kv/namespaces?per_page=100'.format(ACCOUNT))
if st != 200:
    raise SystemExit('列举 KV 失败: {}'.format(errmsg(d)))
ns_id = next((n['id'] for n in d.get('result', []) if n.get('title') == KV_TITLE), None)
if ns_id:
    print('已存在命名空间 {} -> id={}'.format(KV_TITLE, ns_id))
else:
    st, d = cf('/accounts/{}/storage/kv/namespaces'.format(ACCOUNT), 'POST', {'title': KV_TITLE})
    if st in (200, 201) and d.get('success'):
        ns_id = d['result']['id']
        print('已创建命名空间 {} -> id={}'.format(KV_TITLE, ns_id))
    else:
        # 不中断：继续把 Worker 部署完，最后统一汇报哪一项缺权限
        print('创建 KV 命名空间失败（Token 可能只有 KV Read 权限）: {}'.format(errmsg(d)))

# ---------- 2. KV 读写探测 ----------
print('\n=== 2. KV 读写探测 ===')
if not ns_id:
    print('跳过：没有可用的命名空间')
else:
    probe_key = '__setup_probe_{}'.format(uuid.uuid4().hex[:8])
    boundary = '----openclaw{}'.format(uuid.uuid4().hex)
    parts = []
    for name, value in (('value', json.dumps({'probe': True})), ('metadata', '{}')):
        parts.append('--{}\r\nContent-Disposition: form-data; name="{}"\r\n\r\n{}\r\n'.format(
            boundary, name, value))
    body = (''.join(parts) + '--{}--\r\n'.format(boundary)).encode('utf-8')
    st, d = cf(
        '/accounts/{}/storage/kv/namespaces/{}/values/{}?expiration_ttl=60'.format(
            ACCOUNT, ns_id, probe_key),
        'PUT', raw_body=body,
        content_type='multipart/form-data; boundary={}'.format(boundary))
    print('写入 -> HTTP {} success={}'.format(st, d.get('success')))
    if st != 200:
        print('  详情: {}'.format(errmsg(d)))
    st_r, d_r = cf('/accounts/{}/storage/kv/namespaces/{}/values/{}'.format(
        ACCOUNT, ns_id, probe_key))
    print('读回 -> HTTP {} 内容={}'.format(st_r, json.dumps(d_r, ensure_ascii=False)[:120]))
    st_del, _ = cf('/accounts/{}/storage/kv/namespaces/{}/values/{}'.format(
        ACCOUNT, ns_id, probe_key), 'DELETE')
    print('删除 -> HTTP {}'.format(st_del))

# ---------- 3. 上传保活 Worker ----------
print('\n=== 3. 上传保活 Worker ===')
with open(WORKER_SRC, 'r', encoding='utf-8') as fh:
    script = fh.read()

metadata = {
    'main_module': 'index.js',
    'compatibility_date': '2026-08-01',
    'observability': {'enabled': True},
}
wb = uuid.uuid4().hex
chunks = [
    '--{}\r\nContent-Disposition: form-data; name="metadata"\r\n'
    'Content-Type: application/json\r\n\r\n{}\r\n'.format(wb, json.dumps(metadata)),
    '--{}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
    'Content-Type: application/javascript+module\r\n\r\n{}\r\n'.format(wb, script),
    '--{}--\r\n'.format(wb),
]
st, d = cf('/accounts/{}/workers/scripts/{}'.format(ACCOUNT, WORKER_NAME), 'PUT',
           raw_body=''.join(chunks).encode('utf-8'),
           content_type='multipart/form-data; boundary={}'.format(wb))
print('上传 -> HTTP {} success={}'.format(st, d.get('success')))
if st not in (200, 201) or not d.get('success'):
    print('  详情: {}'.format(errmsg(d)))

# ---------- 4. Cron 触发器 ----------
print('\n=== 4. Cron 触发器（每 5 分钟）===')
st, d = cf('/accounts/{}/workers/scripts/{}/schedules'.format(ACCOUNT, WORKER_NAME), 'PUT',
           [{'cron': '*/5 * * * *'}])
print('设置 -> HTTP {} success={} result={}'.format(
    st, d.get('success'), json.dumps(d.get('result'), ensure_ascii=False)[:200]))
if st != 200:
    print('  详情: {}'.format(errmsg(d)))

# ---------- 5. workers.dev 子域 ----------
print('\n=== 5. workers.dev 子域 ===')
st, d = cf('/accounts/{}/workers/scripts/{}/subdomain'.format(ACCOUNT, WORKER_NAME), 'POST',
           {'enabled': True})
print('启用 -> HTTP {} success={}'.format(st, d.get('success')))
st, sub = cf('/accounts/{}/workers/subdomain'.format(ACCOUNT))
name = (sub.get('result') or {}).get('subdomain')
if name:
    print('Worker 访问地址: https://{}.{}.workers.dev'.format(WORKER_NAME, name))

print('\n=== 汇总：需要写入 Render 环境变量的键 ===')
print('CF_ACCOUNT_ID       = {}***（完整值在凭据库）'.format(ACCOUNT[:6]))
print('CF_KV_NAMESPACE_ID  = {}'.format(ns_id))
print('CF_API_TOKEN        = （复用凭据库里的 cloudflare.api_token，本脚本不回显）')
