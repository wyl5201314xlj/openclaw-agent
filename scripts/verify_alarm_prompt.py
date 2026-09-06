# -*- coding: utf-8 -*-
"""验证注入给 agent 的闹钟规则（单次 cron 调用版）对模型的实际约束力。

用途：线上 QQ 链路无法由本地代发消息（网关 WS 给空 scope、/v1/* 未注册、
/tools/invoke 要求可信运行实例），故在模型层复现真实条件做回归：
  - system prompt 用线上实际注入的 AGENTS.md 原文；
  - 工具清单按线上 tools.deny 之后的实际可见集合（含 cron 与 qqbot_remind，
    外加若干填充工具拟真"工具很多"的干扰场景）；
  - 判定标准不只看"调了 cron"，而是逐字段校验 job 参数是否可真正落地。

凭据只经 D:\\Tools\\creds.py 从机器级密钥库读取，不落任何字面量。
外呼目标固定白名单 + 解析后 IP 边界校验 + 禁重定向。
"""
import ipaddress
import json
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, r'D:\Tools')
import creds  # noqa: E402

API_URL = 'https://api.agnes-ai.cn/v1/chat/completions'
ALLOWED_HOSTS = {'api.agnes-ai.cn'}
# 本机代理常把域名解析成 fake-IP 段，属正常，不视为内网穿透
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')

AGENTS_MD_PATH = Path(r'D:\ai\openclaw-gateway-tmp\wsp6\AGENTS.md')
ROUNDS = 6
MODELS = ('agnes-2.5-flash', 'agnes-2.5-pro')
BJ = timezone(timedelta(hours=8))


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


def _tool(name, desc, props, required=None):
    schema = {'type': 'object', 'properties': props}
    if required:
        schema['required'] = required
    return {'type': 'function',
            'function': {'name': name, 'description': desc, 'parameters': schema}}


CRON_TOOL = _tool(
    'cron',
    'Schedule automations (reminders/alarms). Jobs persist in the gateway scheduler.',
    {'action': {'type': 'string', 'enum': ['add', 'list', 'remove']},
     'job': {'type': 'object', 'properties': {
         'name': {'type': 'string'},
         'schedule': {'type': 'object'},
         'sessionTarget': {'type': 'string'},
         'wakeMode': {'type': 'string'},
         'deleteAfterRun': {'type': 'boolean'},
         'payload': {'type': 'object'},
         'delivery': {'type': 'object'}}},
     'jobId': {'type': 'string'}},
    ['action'])

# 旧的两步链路里的第一步：保留在工具表中，用来检验模型是否还会被它带偏
REMIND_TOOL = _tool(
    'qqbot_remind',
    'QQBot reminder helper: returns cronParams that must then be passed to the cron tool.',
    {'action': {'type': 'string'}, 'content': {'type': 'string'},
     'time': {'type': 'string'}, 'to': {'type': 'string'}},
    ['action'])

FILLER_NAMES = ('web_search', 'web_fetch', 'memory_search', 'memory_get', 'message',
                'session_status', 'sessions_list', 'qqbot_platform_api', 'get_goal',
                'create_goal', 'update_goal', 'progress_card', 'ask_user',
                'skill_workshop', 'image')
TOOLS = [CRON_TOOL, REMIND_TOOL] + [
    _tool(n, n, {'q': {'type': 'string'}}) for n in FILLER_NAMES]


def call_model(messages, model, api_key):
    _assert_safe(API_URL)
    body = {'model': model, 'messages': messages, 'tools': TOOLS, 'temperature': 0.3}
    req = urllib.request.Request(
        API_URL, data=json.dumps(body).encode('utf-8'), method='POST',
        headers={'Authorization': 'Bearer ' + api_key,
                 'Content-Type': 'application/json'})
    with _OPENER.open(req, timeout=90) as resp:
        return json.loads(resp.read().decode('utf-8', 'replace'))


def _as_obj(v):
    """模型有时把嵌套对象序列化成 JSON 字符串再塞进参数，这里统一还原成 dict。"""
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except (ValueError, TypeError):
            return {}
    return v if isinstance(v, dict) else {}


def _resolve_at_ms(sch):
    """把 schedule 的时间字段统一解析成毫秒时间戳。

    官方 schema 的正式字段是 at（ISO-8601 字符串），atMs 是兼容入口、内部会被
    转成 at。两者都接受，解析不出来返回 None（视为该轮失败）。
    """
    raw_at = sch.get('at')
    if isinstance(raw_at, str) and raw_at.strip():
        try:
            return int(datetime.fromisoformat(raw_at.strip()).timestamp() * 1000)
        except ValueError:
            return None
    raw_ms = sch.get('atMs')
    if isinstance(raw_ms, (int, float)) and not isinstance(raw_ms, bool):
        return int(raw_ms)
    if isinstance(raw_ms, str):
        try:
            return int(float(raw_ms.strip()))
        except ValueError:
            return None
    return None


def grade(call_args, now_ms):
    """逐字段校验 job 是否能真正落地（缺一项到点就不会响）。"""
    job = _as_obj(call_args.get('job'))
    sch = _as_obj(job.get('schedule'))
    payload = _as_obj(job.get('payload'))
    delivery = _as_obj(job.get('delivery'))
    at_ms = _resolve_at_ms(sch)
    return {
        'action=add': call_args.get('action') == 'add',
        'schedule.kind=at': sch.get('kind') == 'at',
        '时间可解析为绝对时刻': at_ms is not None and at_ms > now_ms,
        '时刻≈3分钟后': at_ms is not None and abs(at_ms - (now_ms + 180000)) < 90000,
        'payload.kind=agentTurn': payload.get('kind') == 'agentTurn',
        'delivery.mode=announce': delivery.get('mode') == 'announce',
        'delivery.channel=qqbot': delivery.get('channel') == 'qqbot',
        'delivery.to非空': bool(delivery.get('to')),
    }


def main():
    api_key = creds.get('agnes', 'api_key')
    if not api_key:
        raise SystemExit('凭据库缺少 agnes.api_key')
    if not AGENTS_MD_PATH.exists():
        raise SystemExit('缺少渲染出的 AGENTS.md: {}'.format(AGENTS_MD_PATH))

    agents_md = AGENTS_MD_PATH.read_text(encoding='utf-8')
    now_ms = int(time.time() * 1000)
    # 与线上网关的实际注入形态保持一致：session_status 实测输出的是人类可读的
    # 北京时间（"Current time: ... 8:10 PM (Asia/Shanghai)"），不是毫秒时间戳。
    # 早前版本在这里注入毫秒数，反而诱导模型去做 "时间戳 + 180000" 的算术，
    # 那正是线上闹钟静默失效的根因，故测试条件必须与线上一致才有意义。
    bj_now = datetime.fromtimestamp(now_ms / 1000, tz=timezone(timedelta(hours=8)))
    system_prompt = (agents_md + '\n\n当前时间（北京时间 UTC+8）: {}\n'
                     '当前用户 openid: TESTOPENID123\n'.format(
                         bj_now.strftime('%Y-%m-%d %H:%M:%S')))

    summary = {}
    for model in MODELS:
        print('=' * 24, model)
        passed = 0
        for i in range(ROUNDS):
            messages = [{'role': 'system', 'content': system_prompt},
                        {'role': 'user', 'content': '3分钟后提醒我喝水'}]
            try:
                started = time.time()
                data = call_model(messages, model, api_key)
                elapsed = time.time() - started
            except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError,
                    OSError, ValueError, RuntimeError) as err:
                print('  #{} 请求异常: {}'.format(i + 1, str(err)[:90]))
                continue

            message = (data.get('choices') or [{}])[0].get('message') or {}
            calls = message.get('tool_calls') or []
            if not calls:
                print('  #{} [失败] 未调工具，只回了话 | {:.1f}s'.format(i + 1, elapsed))
                continue

            names = [c.get('function', {}).get('name') for c in calls]
            if names[0] != 'cron':
                print('  #{} [偏离] 首调 {} 而非 cron | {:.1f}s'.format(
                    i + 1, names[0], elapsed))
                continue

            try:
                args = json.loads(calls[0]['function'].get('arguments') or '{}')
            except json.JSONDecodeError:
                print('  #{} [失败] cron 参数不是合法 JSON | {:.1f}s'.format(i + 1, elapsed))
                continue

            checks = grade(args, now_ms)
            bad = [k for k, v in checks.items() if not v]
            if bad:
                print('  #{} [参数缺陷] {} | {:.1f}s'.format(i + 1, bad, elapsed))
            else:
                passed += 1
                print('  #{} [通过] 一次 cron 调用且 8 项参数全对 | {:.1f}s'.format(
                    i + 1, elapsed))
        summary[model] = (passed, ROUNDS)
        print('  -> {}/{} 可真正落地'.format(passed, ROUNDS))

    print('\n=== 汇总 ===')
    for model, (passed, total) in summary.items():
        print('  {}: {}/{}'.format(model, passed, total))


if __name__ == '__main__':
    main()
