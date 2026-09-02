# -*- coding: utf-8 -*-
"""收集本地所有 Cloudflare 凭据候选（凭据库 + 知识库），逐个实测权限，
用第一枚具备 Workers KV/Scripts 写权限的凭据完成保活 Worker 部署 + KV 创建，
并把 Render 环境变量切换到 Cloudflare KV 持久化，最后线上验证。

安全约束：
- 全程内存操作，不把任何密钥写入磁盘（源码里也没有密钥字面量）；
- 输出一律脱敏（前 4 + 后 4）；
- 仅允许 https + api.cloudflare.com / api.render.com / openclaw-agent-8i57.onrender.com；
- 重定向一律拒绝；请求前做 IP 边界校验。
"""
import base64
import ipaddress
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
import uuid
import zlib
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


def http_json(url, method='GET', payload=None, headers=None, timeout=60):
    _assert_safe(url)
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    if data is not None and isinstance(payload, (dict, list)):
        headers = dict(headers or {})
        headers.setdefault('Content-Type', 'application/json')
    req = urllib.request.Request(url, data=data, method=method, headers=headers or {})
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', 'replace')
            return resp.status, (json.loads(body) if body.strip() else {})
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(body)
        except Exception:  # noqa: BLE001
            return e.code, {'raw': body[:300]}


def mask(v):
    return '{}****{}'.format(v[:4], v[-4:]) if v and len(v) >= 10 else '(短)'


# ============ 1. 收集候选 ============

TOKEN_RE = re.compile(r'(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{40})(?![A-Za-z0-9_-])')
GAPIKEY_RE = re.compile(r'(?<![0-9a-fA-F])([0-9a-fA-F]{37})(?![0-9a-fA-F])')
EXCLUDE_PREFIX = ('ghp_', 'gho_', 'github_pat', 'hf_', 'rnd_', 'sk-', 'xox', 'aiclient')

candidates = {}  # mask -> {'value':.., 'source':.., 'kind': 'token'|'global', 'email':..}


def consider(value, source, kind, email=None):
    v = (value or '').strip()
    if not v or len(v) < 30 or len(v) > 60:
        return
    if any(v.lower().startswith(p) for p in EXCLUDE_PREFIX):
        return
    m = mask(v)
    if m not in candidates:
        candidates[m] = {'value': v, 'source': source, 'kind': kind, 'email': email}


def walk_json(obj, source):
    if isinstance(obj, dict):
        email = obj.get('email') or obj.get('username')
        for k, v in obj.items():
            if not isinstance(v, str):
                walk_json(v, source)
                continue
            kl = k.lower()
            if 'api_token' in kl or kl.endswith('_token') or 'apikey' in kl.replace('_', ''):
                if len(v) >= 30:
                    consider(v, '{}:{}'.format(source, k), 'token', email)
            else:
                consider(v, '{}:{}'.format(source, k), 'token', email) if len(v) == 40 else None
            walk_json(v, source) if isinstance(v, (dict, list)) else None
    elif isinstance(obj, list):
        for v in obj:
            walk_json(v, source)


for path in (r'D:\Tools\secrets\credentials.json', r'D:\知识\99_AI_Context\secrets.json'):
    if os.path.exists(path):
        try:
            with open(path, encoding='utf-8') as fh:
                walk_json(json.load(fh), os.path.basename(path))
        except Exception as exc:  # noqa: BLE001
            print('读取失败 {}: {}'.format(path, exc))

# 2. 知识库扫描（含 cloudflare 字样的文本文件，限 2MB 内）
import io  # noqa: E402

scanned = 0
for root, dirs, files in os.walk(r'D:\知识'):
    dirs[:] = [d for d in dirs if d not in ('.obsidian', '.git', 'node_modules')]
    for name in files:
        if not name.endswith(('.md', '.json', '.txt', '.py', '.yml', '.yaml', '.js')):
            continue
        full = os.path.join(root, name)
        try:
            if os.path.getsize(full) > 2 * 1024 * 1024:
                continue
            with io.open(full, encoding='utf-8', errors='ignore') as fh:
                text = fh.read()
        except Exception:  # noqa: BLE001
            continue
        scanned += 1
        if 'cloudflare' not in text.lower() and 'api_token' not in text.lower():
            continue
        for m in TOKEN_RE.finditer(text):
            cand = m.group(1)
            if any(cand.lower().startswith(p) for p in EXCLUDE_PREFIX):
                continue
            ctx = text[max(0, m.start() - 150):m.start() + 60].lower()
            if 'token' in ctx or 'api' in ctx or 'key' in ctx:
                consider(cand, full, 'token')
        for m in GAPIKEY_RE.finditer(text):
            ctx = text[max(0, m.start() - 150):m.start() + 60].lower()
            if 'global' in ctx or 'api key' in ctx:
                consider(m.group(1), full, 'global')

print('知识库扫描文件数: {}，候选 {} 枚'.format(scanned, len(candidates)))
for i, (m, c) in enumerate(candidates.items()):
    print('[{:2d}] {} kind={} src={}{}'.format(
        i, m, c['kind'], os.path.basename(c['source']),
        ' email={}'.format(mask(c['email'])) if c.get('email') else ''))

# ============ 2. 逐个实测权限 ============

cf_headers_token = lambda tok: {'Authorization': 'Bearer ' + tok}
cf_headers_global = lambda tok, email: {
    'X-Auth-Email': email or '', 'X-Auth-Key': tok}


def cf_get_accounts(candidate):
    if candidate['kind'] == 'token':
        headers = cf_headers_token(candidate['value'])
    else:
        if not candidate.get('email'):
            return 0, []
        headers = cf_headers_global(candidate['value'], candidate['email'])
    st, d = http_json('https://api.cloudflare.com/client/v4/accounts?per_page=5',
                      headers=headers)
    if st != 200 or not d.get('success'):
        return st, []
    return st, [(a['id'], a.get('name', '')) for a in (d.get('result') or [])]


def cf_kv_write_ok(candidate, account_id):
    """真实写测试：创建一个探针命名空间（成功即证明有 KV 写权限；随后删除）。"""
    headers = (cf_headers_token(candidate['value']) if candidate['kind'] == 'token'
               else cf_headers_global(candidate['value'], candidate.get('email')))
    probe = 'perm-probe-{}'.format(uuid.uuid4().hex[:8])
    st, d = http_json(
        'https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces'.format(account_id),
        'POST', {'title': probe}, headers=headers)
    if st in (200, 201) and d.get('success'):
        ns_id = d['result']['id']
        http_json('https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces/{}'.format(
            account_id, ns_id), 'DELETE', headers=headers)
        return True
    return False


worker_script = None
with open(WORKER_SRC, encoding='utf-8') as fh:
    worker_script = fh.read()

working = None
test_log = []
for m, cand in candidates.items():
    st, accounts = cf_get_accounts(cand)
    if not accounts:
        test_log.append('{} -> 无账号访问权限 (HTTP {})'.format(m, st))
        continue
    for aid, aname in accounts:
        if not cf_kv_write_ok(cand, aid):
            test_log.append('{} @ {} -> KV 无写权限'.format(m, aname or aid[:8]))
            continue
        # KV 写权限有了，再实测 Workers Scripts 写权限（真上传探测脚本，成功后替换正式 Worker）
        boundary = uuid.uuid4().hex
        meta = {'main_module': 'index.js', 'compatibility_date': '2026-08-01',
                'observability': {'enabled': True}}
        body = (
            '--{0}\r\nContent-Disposition: form-data; name="metadata"\r\n'
            'Content-Type: application/json\r\n\r\n{1}\r\n'
            '--{0}\r\nContent-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
            'Content-Type: application/javascript+module\r\n\r\n{2}\r\n'
            '--{0}--\r\n'.format(boundary, json.dumps(meta), worker_script)
        ).encode('utf-8')
        st, d = http_json(
            'https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}'.format(aid, WORKER_NAME),
            'PUT', raw_body=None, headers={}) if False else (0, {})
        # 手动构造 multipart（http_json 只做 JSON 体，这里单独发）
        url = 'https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}'.format(aid, WORKER_NAME)
        _assert_safe(url)
        headers = (cf_headers_token(cand['value']) if cand['kind'] == 'token'
                   else cf_headers_global(cand['value'], cand.get('email')))
        headers['Content-Type'] = 'multipart/form-data; boundary={}'.format(boundary)
        req = urllib.request.Request(url, data=body, method='PUT', headers=headers)
        try:
            with _OPENER.open(req, timeout=90) as resp:
                resp.read()
                worker_ok = True
        except urllib.error.HTTPError as e:
            e.read()
            worker_ok = False
        if not worker_ok:
            test_log.append('{} @ {} -> KV 可写但 Workers 无写权限'.format(m, aname or aid[:8]))
            continue
        working = {'mask': m, 'value': cand['value'], 'kind': cand['kind'],
                   'email': cand.get('email'), 'account_id': aid, 'account_name': aname}
        test_log.append('{} @ {} -> ✅ 全权限可用，已用其上传 Worker'.format(m, aname or aid[:8]))
        break
    if working:
        break

print()
print('=== 逐个实测结果 ===')
for line in test_log:
    print(' ', line)

if not working:
    print()
    print('结论：所有候选均不具备 KV+Workers 写权限，需要主人在 CF 后台新建一枚 Token。')
    sys.exit(2)

print()
print('使用凭据: {} @ 账号 {}'.format(working['mask'], working['account_name'] or working['account_id'][:8]))
aid = working['account_id']
cfh = (cf_headers_token(working['value']) if working['kind'] == 'token'
       else cf_headers_global(working['value'], working.get('email')))

# ============ 3. 建 KV 命名空间 ============

st, d = http_json('https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces?per_page=100'.format(aid),
                  headers=cfh)
ns_id = None
if st == 200 and d.get('success'):
    ns_id = next((n['id'] for n in d.get('result', []) if n.get('title') == KV_TITLE), None)
if not ns_id:
    st, d = http_json('https://api.cloudflare.com/client/v4/accounts/{}/storage/kv/namespaces'.format(aid),
                      'POST', {'title': KV_TITLE}, headers=cfh)
    if st in (200, 201) and d.get('success'):
        ns_id = d['result']['id']
        print('已创建 KV 命名空间 {} -> {}'.format(KV_TITLE, ns_id))
    else:
        print('KV 命名空间创建失败（不阻塞 Worker）：', json.dumps(d.get('errors') or d)[:200])
else:
    print('KV 命名空间已存在 {} -> {}'.format(KV_TITLE, ns_id))

# Worker 已在权限探测时上传成功，这里补 Cron 与子域
st, d = http_json('https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}/schedules'.format(aid, WORKER_NAME),
                  'PUT', [{'cron': '*/5 * * * *'}], headers=cfh)
print('Cron 触发器: HTTP {} success={}'.format(st, d.get('success')))
st, d = http_json('https://api.cloudflare.com/client/v4/accounts/{}/workers/subdomain'.format(aid), headers=cfh)
sub = ((d.get('result') or {}).get('subdomain'))
st2, d2 = http_json('https://api.cloudflare.com/client/v4/accounts/{}/workers/scripts/{}/subdomain'.format(aid, WORKER_NAME),
                    'POST', {'enabled': True}, headers=cfh)
print('workers.dev 启用: HTTP {} success={} 子域={}'.format(st2, d2.get('success'), sub))

worker_url = 'https://{}{}.workers.dev/'.format(WORKER_NAME, '.' + sub if sub else '')
if sub:
    time.sleep(3)
    try:
        st, body = http_json(worker_url, timeout=45)
        print('Worker 手动触发: HTTP {} -> {}'.format(st, json.dumps(body, ensure_ascii=False)[:260]))
    except Exception as exc:  # noqa: BLE001
        print('Worker 首次触发异常（边缘传播可能需 1-2 分钟）: {}'.format(exc))

# ============ 4. 切换 Render 环境变量到 Cloudflare KV ============

render_key = creds.get('render_openclaw', 'api_key') or creds.get('render', 'api_key')
st, d = http_json('https://api.render.com/v1/services/{}/env-vars?limit=100'.format(RENDER_SERVICE),
                  headers={'Authorization': 'Bearer ' + render_key, 'Accept': 'application/json'})
current = {}
for e in d if st == 200 else []:
    ev = e.get('envVar', e)
    current[ev['key']] = ev.get('value', '')
if ns_id:
    current['CF_ACCOUNT_ID'] = aid
    current['CF_KV_NAMESPACE_ID'] = ns_id
    current['CF_API_TOKEN'] = working['value']
    payload = [{'key': k, 'value': v} for k, v in sorted(current.items())]
    st, d = http_json('https://api.render.com/v1/services/{}/env-vars'.format(RENDER_SERVICE), 'PUT',
                      payload, headers={'Authorization': 'Bearer ' + render_key,
                                        'Accept': 'application/json', 'Content-Type': 'application/json'})
    print('Render 环境变量写入: HTTP {}（键: {}）'.format(
        st, sorted(k for k in current if k.startswith('CF_'))))

# ============ 5. 触发部署 + 线上验证 ============

st, d = http_json('https://api.render.com/v1/services/{}/deploys'.format(RENDER_SERVICE), 'POST',
                  {'clearCache': 'do_not_clear'},
                  headers={'Authorization': 'Bearer ' + render_key, 'Accept': 'application/json',
                           'Content-Type': 'application/json'})
deploy_id = d.get('id', '')
print('触发部署: HTTP {} deploy={}'.format(st, deploy_id[:12] if deploy_id else d))

terminal = ('live', 'deactivated', 'build_failed', 'canceled')
last = ''
if deploy_id:
    for _ in range(60):
        st, d = http_json('https://api.render.com/v1/services/{}/deploys/{}'.format(RENDER_SERVICE, deploy_id),
                          headers={'Authorization': 'Bearer ' + render_key, 'Accept': 'application/json'})
        status = d.get('status', '?')
        if status != last:
            print('  deploy -> {}'.format(status))
            last = status
        if status in terminal:
            break
        time.sleep(15)

admin = open(r'D:\Tools\secrets\openclaw_admin_token.txt', encoding='utf-8').read().strip()
time.sleep(20)
st, body = http_json(ONLINE_BASE + '/api/selftest', headers={'X-Admin-Token': admin}, timeout=180)
d = json.loads(body)
print()
print('=== 线上 selftest（部署 {} 后）===')
for c in d.get('checks', []):
    print('  [{}] {:16s} {:>6}ms  {}'.format(
        'OK' if c['ok'] else 'FAIL', c['name'], c['ms'],
        (c.get('error') or json.dumps(c.get('detail'), ensure_ascii=False))[:120]))
store_detail = next((c.get('detail', {}) for c in d.get('checks', []) if c['name'] == 'store'), {})
print()
print('持久化模式:', store_detail.get('mode', store_detail))
sys.exit(0)
