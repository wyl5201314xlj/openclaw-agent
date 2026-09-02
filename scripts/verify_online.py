# -*- coding: utf-8 -*-
"""线上验收脚本：对新版 openclaw-agent 逐项验证（优化计划各验收标准的线上实测）。

只读 + 一次 dispatch（自付一次模型调用）；凭据从 creds.py 与本地令牌文件读取。
"""
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

BASE = 'https://openclaw-agent-8i57.onrender.com'
ALLOWED_HOST = 'openclaw-agent-8i57.onrender.com'
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')
ADMIN_TOKEN = open(r'D:\Tools\secrets\openclaw_admin_token.txt', encoding='utf-8').read().strip()

results = []


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


def call(path, method='GET', payload=None, token=None, timeout=90):
    url = _assert_safe(BASE + path)
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['X-Admin-Token'] = token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    t0 = time.time()
    try:
        with _OPENER.open(req, timeout=timeout) as resp:
            body = resp.read().decode('utf-8', 'replace')
            return resp.status, int((time.time() - t0) * 1000), body
    except urllib.error.HTTPError as e:
        return e.code, int((time.time() - t0) * 1000), e.read().decode('utf-8', 'replace')


def record(name, ok, detail):
    results.append((name, ok, detail))
    print('[{}] {} {}'.format('PASS' if ok else 'FAIL', name, detail))


# 1. /health 新版标记 + QQ 网关已重连
st, ms, body = call('/health')
d = json.loads(body)
record('health 新版标记', st == 200 and d.get('service') == 'OpenClaw Agent',
       'service={} rss={}MB'.format(d.get('service'), d.get('memoryUsageMB')))
record('QQ 网关重连', d.get('qqBotConnected') is True, 'qqBotConnected={}'.format(d.get('qqBotConnected')))

# 2. P2-1 验收：无 token 必须 401，且绝不能再读到任务内容
st1, _, _ = call('/api/tasks')
st2, _, _ = call('/api/status')
st3, _, _ = call('/api/dispatch', 'POST', {'goal': 'test'})
record('无 token 全部 401/403', st1 == 401 and st2 == 401 and st3 == 401,
       'tasks={} status={} dispatch={}'.format(st1, st2, st3))
st4, _, _ = call('/health?x=1')
record('health 保持公开（保活可用）', st4 == 200, 'HTTP {}'.format(st4))

# 3. 正确 token 打开管理面
st, ms, body = call('/api/status', token=ADMIN_TOKEN)
d = json.loads(body)
chain_ok = isinstance(d.get('modelChain', {}).get('chain'), list)
record('status 鉴权通过', st == 200 and chain_ok,
       'rss={}MB 链={}条'.format(d.get('runtime', {}).get('rssMB'), len(d.get('modelChain', {}).get('chain', []))))

# 4. selftest：模型 / 检索 / 抓取 / SSRF / 持久化 / QQ 凭据
st, ms, body = call('/api/selftest', token=ADMIN_TOKEN, timeout=180)
d = json.loads(body)
print('--- selftest {} ({} ms) ---'.format('ok' if d.get('ok') else '存在失败项', d.get('elapsedMs')))
for c in d.get('checks', []):
    print('  [{}] {:18s} {:>6}ms  {}'.format(
        'OK' if c['ok'] else 'FAIL', c['name'], c['ms'],
        (c.get('error') or json.dumps(c.get('detail'), ensure_ascii=False))[:110]))
record('selftest 核心项全过（store 可为降级前例外）',
       all(c['ok'] for c in d.get('checks', []) if c['name'] not in ('store',)) or
       all(c['ok'] for c in d.get('checks', []) if c['name'] in ('model', 'search-e2e', 'reader', 'ssrf-guard', 'qq-credential')),
       json.dumps([c['name'] for c in d.get('checks', []) if not c['ok']]))

# 5. dispatch 端到端（同步返回结果，旧版是浮动 Promise）
st, ms, body = call('/api/dispatch', 'POST', {'goal': '用一句话说明什么是消息队列'}, token=ADMIN_TOKEN, timeout=120)
d = json.loads(body)
record('dispatch 同步返回', st == 200 and d.get('status') == 'COMPLETED',
       '{}ms steps={} cached={}'.format(d.get('elapsedMs'), len(d.get('steps', [])), d.get('cached')))
leak = '"action"' in str(d.get('result', '')) or '"thought"' in str(d.get('result', ''))
record('回答无裸 JSON 泄漏', not leak, str(d.get('result', ''))[:80].replace('\n', ' '))

# 6. timers 列表可读（QQ 侧提醒登记由主人在 QQ 里实测）
st, ms, body = call('/api/timers', token=ADMIN_TOKEN)
d = json.loads(body)
record('timers 接口', st == 200 and 'pending' in d, 'pending={} mode={}'.format(
    len(d.get('pending', [])), d.get('stats', {}).get('storeMode')))

print()
failed = [r for r in results if not r[1]]
print('==== 线上验收: {}/{} 通过 ===='.format(len(results) - len(failed), len(results)))
for name, _, detail in failed:
    print('  失败项:', name, detail)
sys.exit(0 if not failed else 1)
