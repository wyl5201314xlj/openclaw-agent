# -*- coding: utf-8 -*-
"""本地验证脚本：从机器级凭据库注入 Key 到子进程环境后运行指定的 node 脚本。

不落盘、不回显任何凭据；子进程以完全字面量的参数列表启动（shell=False，无任何拼接）。
用法：python run_with_creds.py [router|agent|image|server]
"""
import os
import subprocess
import sys

sys.path.insert(0, r'D:\Tools')
import creds  # noqa: E402

env = os.environ.copy()
env['AGNES_API_KEY'] = creds.get('agnes', 'api_key') or ''
env['AGNES_API_KEY_2'] = creds.get('agnes', 'api_key_2') or ''
env['LUOYING_API_KEY'] = creds.get('luoying', 'api_key') or ''
env['XKIRO_API_KEY'] = creds.get('xkiro', 'api_key') or ''
env['QQ_APP_ID'] = creds.get('qq_bot_openclaw', 'app_id') or ''
env['QQ_APP_SECRET'] = creds.get('qq_bot_openclaw', 'app_secret') or ''
# 定时提醒持久化：GitHub 私有仓库后端（现有 PAT 实测可写）
_gh_pool = creds.github_tokens() if hasattr(creds, 'github_tokens') else []
env['GH_STATE_TOKEN'] = (_gh_pool[0] if _gh_pool else creds.get('github', 'personal_access_token')) or ''
env['GH_STATE_REPO'] = 'wyl5201314xlj/openclaw-state'
# Cloudflare KV 后端（实测现有 token 只读，配齐后自动切换为首选）
env['CF_ACCOUNT_ID'] = creds.get('cloudflare', 'account_id') or ''
env['CF_KV_NAMESPACE_ID'] = os.environ.get('CF_KV_NAMESPACE_ID', '')
env['CF_API_TOKEN'] = creds.get('cloudflare', 'api_token') or ''
env.setdefault('LOG_LEVEL', 'info')
env.setdefault('ADMIN_TOKEN', 'local-dev-only-token')

NAMES = ('AGNES_API_KEY', 'AGNES_API_KEY_2', 'LUOYING_API_KEY', 'XKIRO_API_KEY',
         'QQ_APP_ID', 'QQ_APP_SECRET', 'GH_STATE_TOKEN')
print('已注入 {}/{} 项，缺失: {}'.format(
    sum(1 for n in NAMES if env.get(n)), len(NAMES),
    [n for n in NAMES if not env.get(n)] or '无'))
sys.stdout.flush()

target = sys.argv[1] if len(sys.argv) > 1 else 'router'

# server-http：只启 HTTP 面，不连 QQ 网关。
# 原因：腾讯官方网关同一分片只允许一条连接，本地连上会把线上实例挤下来，
# 所以本地验证 HTTP 接口时必须清空 QQ 凭据，避免影响生产会话。
if target == 'server-http':
    env['QQ_APP_ID'] = ''
    env['QQ_APP_SECRET'] = ''

# 每个分支的命令都是完全字面量，杜绝任何外部输入进入进程参数
if target == 'router':
    proc = subprocess.run(
        [r'D:\Tools\Node\node.exe', r'D:\ai\openclaw-agent\scripts\verify_router.js'],
        env=env, shell=False)
elif target == 'agent':
    proc = subprocess.run(
        [r'D:\Tools\Node\node.exe', r'D:\ai\openclaw-agent\scripts\verify_agent.js'],
        env=env, shell=False)
elif target == 'image':
    proc = subprocess.run(
        [r'D:\Tools\Node\node.exe', r'D:\ai\openclaw-agent\scripts\verify_image.js'],
        env=env, shell=False)
elif target == 'store':
    proc = subprocess.run(
        [r'D:\Tools\Node\node.exe', r'D:\ai\openclaw-agent\scripts\verify_store.js'],
        env=env, shell=False)
elif target in ('server', 'server-http'):
    proc = subprocess.run(
        [r'D:\Tools\Node\node.exe', r'D:\ai\openclaw-agent\server.js'],
        env=env, shell=False)
else:
    raise SystemExit(
        '未知目标: {}（可选 router / agent / image / store / server / server-http）'.format(target))

print('node 真实退出码: {}'.format(proc.returncode))
sys.exit(proc.returncode)
