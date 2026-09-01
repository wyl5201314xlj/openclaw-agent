# -*- coding: utf-8 -*-
"""Render 环境变量配置（优化计划 3-1 / 3-6 / 0-7 的上线动作）。

写入的键：
  ADMIN_TOKEN         —— HTTP 管理面令牌（不存在时随机生成）
  NODE_OPTIONS        —— 512MB 容器的 V8 老生代护栏
  LOG_LEVEL           —— 结构化日志级别
  GH_STATE_TOKEN/REPO —— 定时提醒持久化（GitHub 私有仓库后端，实测可用）
  移除 MASTER_OPENID  —— 认主已取消，代码从不读取，属无效变量

安全：仅 https + api.render.com 白名单 + IP 边界校验 + 禁重定向；
凭据从 D:\\Tools\\creds.py 读取；令牌只写入仓库外的固定白名单目录，输出一律脱敏。
"""
import ipaddress
import json
import secrets
import socket
import sys
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, r'D:\Tools')
import creds  # noqa: E402

KEY = creds.get('render_openclaw', 'api_key') or creds.get('render', 'api_key')
if not KEY:
    raise SystemExit('未取到 Render API Key')

ALLOWED_HOST = 'api.render.com'
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')
SERVICE_NAME = 'openclaw-agent'

# 令牌落盘目录白名单：仓库外的机器级密钥目录，且只允许这一个固定文件名
SECRET_DIR = Path(r'D:\Tools\secrets').resolve()
SECRET_FILE_NAME = 'openclaw_admin_token.txt'


def secret_file_path():
    """构造并校验落盘路径，确保始终落在白名单目录内（禁止穿越）。"""
    target = (SECRET_DIR / SECRET_FILE_NAME).resolve()
    if target.parent != SECRET_DIR:
        raise ValueError('拒绝写入白名单目录之外的路径: {}'.format(target))
    return target


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
        body = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(body)
        except Exception:  # noqa: BLE001
            return e.code, {'raw': body[:400]}


st, services = api('/services?limit=20')
if st != 200:
    raise SystemExit('列举服务失败 HTTP {}: {}'.format(st, json.dumps(services)[:300]))
svc = None
for item in services:
    s = item.get('service', item)
    if s.get('name') == SERVICE_NAME:
        svc = s
        break
if not svc:
    raise SystemExit('未找到服务 {}'.format(SERVICE_NAME))
sid = svc['id']
print('服务: {} id={} runtime={}'.format(
    svc['name'], sid, (svc.get('serviceDetails') or {}).get('runtime')))

st, existing = api('/services/{}/env-vars?limit=100'.format(sid))
if st != 200:
    raise SystemExit('读取环境变量失败 HTTP {}'.format(st))
current = {}
for e in existing:
    ev = e.get('envVar', e)
    current[ev['key']] = ev.get('value', '')
print('现有环境变量键: {}'.format(sorted(current)))

admin_token = current.get('ADMIN_TOKEN') or secrets.token_urlsafe(32)
gh_pool = creds.github_tokens() if hasattr(creds, 'github_tokens') else []
gh_token = (gh_pool[0] if gh_pool else creds.get('github', 'personal_access_token')) or ''
if not gh_token:
    raise SystemExit('未取到 GitHub Token，无法配置持久化后端')

desired = dict(current)
desired['ADMIN_TOKEN'] = admin_token
desired['NODE_OPTIONS'] = '--max-old-space-size=384'
desired['LOG_LEVEL'] = 'info'
desired['GH_STATE_TOKEN'] = gh_token
desired['GH_STATE_REPO'] = 'wyl5201314xlj/openclaw-state'
desired['GH_STATE_DIR'] = 'state'
desired['NODE_ENV'] = 'production'
desired['PORT'] = current.get('PORT') or '10000'
desired.pop('MASTER_OPENID', None)

payload = [{'key': k, 'value': v} for k, v in sorted(desired.items())]
st, resp = api('/services/{}/env-vars'.format(sid), 'PUT', payload)
print('\n写入环境变量 -> HTTP {}'.format(st))
if st not in (200, 201):
    print('  详情: {}'.format(json.dumps(resp, ensure_ascii=False)[:400]))
    raise SystemExit('环境变量写入失败（Token 可能是只读的）')

st, after = api('/services/{}/env-vars?limit=100'.format(sid))
print('写入后键: {}'.format(sorted((e.get('envVar', e))['key'] for e in after)))

target = secret_file_path()
target.write_text(admin_token, encoding='utf-8')
print('\nADMIN_TOKEN 长度 {} 字符，脱敏 {}***{}'.format(
    len(admin_token), admin_token[:4], admin_token[-4:]))
print('完整值已写入仓库外的 {}'.format(target))
