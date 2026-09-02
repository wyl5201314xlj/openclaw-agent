# -*- coding: utf-8 -*-
"""对本地两枚 Cloudflare Token 逐项分权实测（KV 读/写、Workers 写、Cron 写），
按实际拥有的权限尽力完成部署：Workers 可写 -> 部署保活 Worker + Cron；
KV 也可写 -> 再建 KV 命名空间并把 Render 切到 KV 持久化。

全程内存操作不落盘密钥；输出脱敏；仅 https 白名单主机；拒绝重定向。
"""
import base64
import ipaddress
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlsplit

sys.path.insert(0, r'D:\Tools')
import creds  # noqa: E402

WORKER_NAME = 'openclaw-keepalive'
KV_TITLE = 'openclaw-agent'
WORKER_SRC = r'D:\ai\cloud-heartbeat\cloudflare-worker\src\index.js'
RENDER_SERVICE = 'srv-dab7hass728c739r9oq0'
ONLINE_BASE = 'https://openclaw-agent-8i57.onrender.com'
ALLOWED_HOSTS = {'api.cloudflare.com', 'api.render.com', 'openclaw-agent-8i57.onrender.com'}
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError('拒绝重定向')


_OPENER = urllib.request.build_opener(_NoRedirect)


def _assert_safe(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.hostname not in ALLOWED_HOSTS:
        raise ValueError('目标不在白名单: {}'.format(url))
    for info in socket.getaddrinfo(parts.hostname, 443, proto=socket.IPPROTO_TCP):
        ip = ipaddress.ip_address(info[4][0])
        if ip in _FAKE_IP:
            continue
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            raise ValueError('解析到非公网地址，已阻断: {}'.format(ip))
    return url


def http_json(url, method='GET', payload=None, headers=None, timeout=60, raw=None):
    _assert_safe(url)
    data = raw if raw is not None else (
        json.dumps(payload).encode('utf-8') if payload is not None else None)
    if data is not None and raw is None:
        headers = dict(headers or {})
        headers.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    t0 = time.time()
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', 'replace')
            return resp.status, (json.loads(body) if body.strip() else {}), int((time.time() - t0) * 1000)
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(body), int((time.time() - t0) * 1000)
        except Exception:  # noqa: BLE001
            return e.code, {'raw': body[:300]}, int((time.time() - t0) * 1000)


def mask(v):
    return '{}****{}'.format(v[:4], v[-4:]) if v and len(v) >= 10 else '(短)'


with open(WORKER_SRC, encoding='utf-8') as fh:
    worker_script = fh.read()


def upload_worker(headers, aid, name, script):
    boundary = uuid.uuid4().hex
    meta = {'main_module': 'index.js', 'compatibility_date': '2026-08-01',
            'observability': {'enabled': True}}
    body = (
        '--{0}\r\nContent-Disposition: form-data; name="metadata"\r\n'
        'Content-Type: application/json\r\n\r\n{1}\r\n'
        '--{0}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
        'Content-Type: application/javascript+module\r\n\r\n{2}\r\n'
        '--{0}--\r\n'.format(boundary, json.dumps(meta), script)
    ).encode('utf-8')
    url = 'https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}'.format(aid, name)
    _assert_safe(url)
    h = dict(headers)
    h['Content-Type'] = 'multipart/form-data; boundary={}'.format(boundary)
    req = urllib.request.Request(url, data=body, method='PUT', headers=h)
    try:
        with _OPENER.open(req, timeout=90) as resp:
            resp.read()
            return True, resp.status, {}
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', 'replace')
        try:
            return False, e.code, json.loads(detail)
        except Exception:  # noqa: BLE001
            return False, e.code, {'raw': detail[:200]}


# ============ 收集候选 ============

candidates = []
with open(r'D:\Tools\secrets\credentials.json', encoding='utf-8') as fh:
    vault = json.load(fh)
cf = vault.get('cloudflare', {})
for field in sorted(k for k in cf.keys() if 'token' in k.lower()):
    v = str(cf[field]).strip()
    if len(v) >= 30:
        candidates.append({'label': 'cloudflare.{}'.format(field), 'value': v,
                           'mask': mask(v), 'email': cf.get('email') or cf.get('username')})

print('候选 {} 枚'.format(len(candidates)))

# ============ 逐项分权实测 ============

best = None  # {'cand','aid','aname','workers':bool,'kv':bool,'ns_id':..}

for cand in candidates:
    h = {'Authorization': 'Bearer ' + cand['value']}
    print()
    print('#### {} ({})'.format(cand['label'], cand['mask']))

    st, d, _ = http_json('https://api.cloudflare.com/client/v4/user/tokens/verify', headers=h)
    print('  token verify: HTTP {} -> {}'.format(
        st, json.dumps(d.get('result') or d.get('errors'), ensure_ascii=False)[:150]))

    st, d, _ = http_json('https://api.cloudflare.com/client/v4/accounts?per_page=5', headers=h)
    if st != 200 or not d.get('success'):
        print('  账号列举失败: HTTP {}'.format(st))
        continue
    accounts = [(a['id'], a.get('name', '')) for a in d.get('result', [])]
    print('  可访问账号: {}'.format([n or i[:8] for i, n in accounts]))

    for aid, aname in accounts:
        kv_read = kv_write = workers_write = cron_write = False
        ns_id = None

        st, d, _ = http_json(
            'https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces?per_page=100'.format(aid),
            headers=h)
        kv_read = st == 200 and d.get('success') is True
        print('  [{} ] KV 读: {}'.format(aname or aid[:8], 'OK' if kv_read else '无'))

        probe_ns = 'perm-probe-{}'.format(uuid.uuid4().hex[:8])
        st, d, _ = http_json(
            'https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces'.format(aid),
            'POST', {'title': probe_ns}, headers=h)
        kv_write = st in (200, 201) and d.get('success') is True
        if kv_write:
            http_json('https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces/{}'.format(
                aid, d['result']['id']), 'DELETE', headers=h)
        print('  KV 写: {}'.format('OK' if kv_write else '无'))

        ok, st, detail = upload_worker(h, aid, 'perm-probe-keepalive', worker_script)
        workers_write = ok
        if ok:
            # 删除探针脚本（正式部署用正式名字）
            http_json('https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/perm-probe-keepalive'.format(aid),
                      'DELETE', headers=h)
        print('  Workers 写: {}'.format('OK' if workers_write else '无 (HTTP {})'.format(st)))

        if workers_write:
            ok2, st2, detail2 = upload_worker(h, aid, WORKER_NAME, worker_script)
            print('  正式 Worker {} 部署: {}'.format(WORKER_NAME, '成功' if ok2 else '失败 HTTP {}'.format(st2)))
            if ok2:
                st3, d3, _ = http_json(
                    'https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}/schedules'.format(aid, WORKER_NAME),
                    'PUT', [{'cron': '*/5 * * * *'}], headers=h)
                cron_write = st3 == 200 and d3.get('success') is True
                print('  Cron */5: {}'.format('OK' if cron_write else '失败 {}'.format(
                    json.dumps(d3.get('errors') or d3)[:120])))
                st4, d4, _ = http_json(
                    'https://api.cloudflare.com/client/v4/accounts/{}/workers/subdomain'.format(aid), headers=h)
                sub = ((d4.get('result') or {}).get('subdomain'))
                st5, d5, _ = http_json(
                    'https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}/subdomain'.format(aid, WORKER_NAME),
                    'POST', {'enabled': True}, headers=h)
                print('  workers.dev: 子域={} 启用={} (HTTP {})'.format(sub, d5.get('success'), st5))

        if kv_write:
            st6, d6, _ = http_json(
                'https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces?per_page=100'.format(aid),
                headers=h)
            ns_id = next((n['id'] for n in d6.get('result', []) if n.get('title') == KV_TITLE), None)
            if not ns_id:
                st7, d7, _ = http_json(
                    'https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces'.format(aid),
                    'POST', {'title': KV_TITLE}, headers=h)
                if st7 in (200, 201) and d7.get('success'):
                    ns_id = d7['result']['id']
            print('  KV 命名空间 {}: {}'.format(KV_TITLE, ns_id or '未能创建'))

        score = (2 if workers_write else 0) + (1 if kv_write else 0)
        if best is None or score > best['score']:
            best = {'cand': cand, 'aid': aid, 'aname': aname, 'score': score,
                    'workers': workers_write, 'kv': kv_write, 'ns_id': ns_id,
                    'cron': cron_write, 'sub': sub if workers_write else None}

print()
if not best or best['score'] == 0:
    print('结论：两枚 Token 连 Workers/Cron 的写权限都没有，保活主通道仍需主人新建 Token。')
    sys.exit(2)

print('=== 选定凭据: {} (Workers={} KV={} Cron={}) ==='.format(
    best['cand']['mask'], best['workers'], best['kv'], best.get('cron')))

# ============ Render 环境变量 ============

render_key = creds.get('render_openclaw', 'api_key') or creds.get('render', 'api_key')
rh = {'Authorization': 'Bearer ' + render_key, 'Accept': 'application/json',
      'Content-Type': 'application/json'}
st, d, _ = http_json('https://api.render.com/v1/services/{}/env-vars?limit=100'.format(RENDER_SERVICE),
                     headers=rh)
current = {}
for e in (d if st == 200 else []):
    ev = e.get('envVar', e)
    current[ev['key']] = ev.get('value', '')

if best['kv'] and best['ns_id']:
    current['CF_ACCOUNT_ID'] = best['aid']
    current['CF_KV_NAMESPACE_ID'] = best['ns_id']
    current['CF_API_TOKEN'] = best['cand']['value']
    changed = 'CF_KV 持久化已启用'
else:
    current.pop('CF_ACCOUNT_ID', None)
    current.pop('CF_KV_NAMESPACE_ID', None)
    current.pop('CF_API_TOKEN', None)
    changed = 'KV 无写权限，Render 保持 GitHub 仓库持久化（不写入无效变量）'

payload = [{'key': k, 'value': v} for k, v in sorted(current.items())]
st, d, _ = http_json('https://api.render.com/v1/services/{}/env-vars'.format(RENDER_SERVICE), 'PUT',
                     payload, headers=rh)
print('Render 环境变量: HTTP {} -> {}'.format(st, changed))

# ============ 部署 + 线上验证 ============

st, d, _ = http_json('https://api.render.com/v1/services/{}/deploys'.format(RENDER_SERVICE), 'POST',
                     {'clearCache': 'do_not_clear'}, headers=rh)
deploy_id = d.get('id', '')
print('触发部署: {} -> {}'.format(st, deploy_id[:12] if deploy_id else d))

terminal = ('live', 'deactivated', 'build_failed', 'canceled')
last = ''
if deploy_id:
    for _ in range(60):
        st, d, _ = http_json('https://api.render.com/v1/services/{}/deploys/{}'.format(
            RENDER_SERVICE, deploy_id), headers=rh)
        status = d.get('status', '?')
        if status != last:
            print('  deploy -> {}'.format(status))
            last = status
        if status in terminal:
            break
        time.sleep(15)

time.sleep(25)
st, body, _ = http_json(ONLINE_BASE + '/api/selftest', headers={'X-Admin-Token': open(
    r'D:\Tools\secrets\openclaw_admin_token.txt', encoding='utf-8').read().strip()}, timeout=180)
d = json.loads(body)
print()
print('=== 线上 selftest ===')
for c in d.get('checks', []):
    print('  [{}] {:16s} {:>6}ms  {}'.format(
        'OK' if c['ok'] else 'FAIL', c['name'], c['ms'],
        (c.get('error') or json.dumps(c.get('detail'), ensure_ascii=False))[:130]))
store = next((c.get('detail', {}) for c in d.get('checks', []) if c['name'] == 'store'), {})
print()
print('持久化模式: {}'.format(store.get('mode', store)))
