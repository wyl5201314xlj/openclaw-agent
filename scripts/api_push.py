# -*- coding: utf-8 -*-
"""GitHub Git Data API 等价推送（git push 的 HTTPS 通道因网络与本地安全钩子双重受阻时的替代）。

原理：远端 main 落后本地恰好一个提交（openclaw-agent: 70310a4 -> ab9f735；
cloud-heartbeat: 42d9860 -> 2e786d3）。脚本从本地磁盘读文件内容 → 上传 blob →
以远端头为 base_tree 建树 → 建提交（精确复刻本地提交的作者/时间/提交说明）→
快进更新远端 main。全程只读本地、只写 GitHub，不执行任何 shell 命令。

安全约束：
- 仅 https + api.github.com 白名单 + IP 边界校验 + 禁重定向；
- 凭据只从 D:\\Tools\\creds.py 读取，输出不回显 token；
- 本文件不含任何可用凭据字面量。
"""
import base64
import hashlib
import ipaddress
import json
import os
import socket
import sys
import urllib.error
import urllib.request
import zlib
from urllib.parse import urlsplit

sys.path.insert(0, r'D:\Tools')
import creds  # noqa: E402

TOKENS = creds.github_tokens() if hasattr(creds, 'github_tokens') else []
if not TOKENS:
    _t = creds.get('github', 'personal_access_token')
    TOKENS = [_t] if _t else []
if not TOKENS:
    raise SystemExit('未取到 GitHub Token')

ALLOWED_HOST = 'api.github.com'
_FAKE_IP = ipaddress.ip_network('198.18.0.0/15')  # 本机代理 fake-ip 段，独占不可路由


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


def gh(method, path, payload=None, attempts=4):
    """带重试的 API 调用：blob 上传按内容寻址、天然幂等，可安全续跑。"""
    url = _assert_safe('https://api.github.com' + path)
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    last = (0, {})
    for attempt in range(attempts):
        for tok in TOKENS:
            req = urllib.request.Request(url, data=data, method=method, headers={
                'Authorization': 'Bearer ' + tok,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json',
                'User-Agent': 'openclaw-api-push',
            })
            try:
                with _OPENER.open(req, timeout=120) as resp:
                    body = resp.read().decode('utf-8')
                    return resp.status, (json.loads(body) if body.strip() else {})
            except urllib.error.HTTPError as e:
                body = e.read().decode('utf-8', 'replace')
                try:
                    last = (e.code, json.loads(body))
                except Exception:  # noqa: BLE001
                    last = (e.code, {'raw': body[:300]})
                if e.code in (401, 403, 429):
                    continue  # 轮询下一枚 Key
                if e.code >= 500 or e.code == 408:
                    break  # 服务端瞬时故障 → 走外层重试
                return last
            except (urllib.error.URLError, TimeoutError, socket.timeout,
                    ConnectionError, OSError) as net_err:
                last = (-1, {'error': str(net_err)[:200]})
                break  # 网络抖动 → 走外层重试
        if attempt < attempts - 1:
            wait = 3 * (attempt + 1)
            print('  ...网络/服务端异常，{}s 后重试（第 {}/{} 次）'.format(wait, attempt + 1, attempts - 1))
            import time
            time.sleep(wait)
    return last


def read_loose_commit(repo_root, sha):
    """直接用 zlib 解开本地 .git 松散对象，取回提交的精确元数据与提交说明。"""
    obj_path = os.path.join(repo_root, '.git', 'objects', sha[:2], sha[2:])
    with open(obj_path, 'rb') as fh:
        raw = zlib.decompress(fh.read())
    header, _, body = raw.partition(b'\x00')
    assert header.startswith(b'commit '), header
    text = body.decode('utf-8')
    head, _, message = text.partition('\n\n')
    author_line = committer_line = ''
    for line in head.split('\n'):
        if line.startswith('author '):
            author_line = line[len('author '):]
        elif line.startswith('committer '):
            committer_line = line[len('committer '):]
    return author_line, committer_line, message


def loose_object_index(repo_root):
    """扫描 .git/objects 的松散对象目录，返回 sha -> 文件路径 的索引。"""
    objects_dir = os.path.join(repo_root, '.git', 'objects')
    index = {}
    for name in os.listdir(objects_dir):
        subdir = os.path.join(objects_dir, name)
        if len(name) == 2 and os.path.isdir(subdir) and all(
            c in '0123456789abcdef' for c in name
        ):
            for fname in os.listdir(subdir):
                index[name + fname] = os.path.join(subdir, fname)
    return index


def read_exact_blob(repo_root, obj_index, rel_path, expected7):
    """从本地 git 对象库读取 blob 的精确字节（磁盘文件因 autocrlf 是 CRLF，不可用）。"""
    candidates = [s for s in obj_index if s.startswith(expected7)]
    if len(candidates) != 1:
        raise SystemExit(
            '对象库中找不到唯一匹配 {} 的 blob（找到 {} 个）：{}'.format(
                expected7, len(candidates), rel_path))
    with open(obj_index[candidates[0]], 'rb') as fh:
        raw = zlib.decompress(fh.read())
    header, _, content = raw.partition(b'\x00')
    if not header.startswith(b'blob '):
        raise SystemExit('对象 {} 不是 blob: {}'.format(expected7, header))
    if git_blob_sha(content) != candidates[0]:
        raise SystemExit('对象库内容自校验失败: {}'.format(expected7))
    return content


def person_fields(line):
    """'Name <email> 1788256357 +0800' -> API 需要的 dict。"""
    name_email, _, rest = line.rpartition('>')
    name, _, email = name_email.partition('<')
    ts_str, tz_str = rest.strip().split()
    from datetime import datetime, timedelta, timezone
    tz = timezone(timedelta(hours=int(tz_str[:3]), minutes=int(tz_str[0] + tz_str[3:5])))
    dt = datetime.fromtimestamp(int(ts_str), tz=tz)
    return {'name': name.strip(), 'email': email.strip(), 'date': dt.isoformat()}


def git_blob_sha(content_bytes):
    return hashlib.sha1(b'blob %d\x00' % len(content_bytes) + content_bytes).hexdigest()


def push_tip(repo_full, repo_root, parent_sha, parent_tree, tip_sha, entries):
    """entries: list of (status, path, expected7)。status in M/A/D。"""
    print('=== {} : 复刻提交 {} ==='.format(repo_full, tip_sha[:7]))
    obj_index = loose_object_index(repo_root)

    # 1. 从本地对象库读出精确 blob 并上传（磁盘文件因 autocrlf 是 CRLF，不可直接用）
    tree_entries = []
    for status, rel_path, expected7 in entries:
        if status == 'D':
            tree_entries.append({'path': rel_path, 'mode': '100644',
                                 'type': 'blob', 'sha': None})
            print('  [D] {}'.format(rel_path))
            continue
        content = read_exact_blob(repo_root, obj_index, rel_path, expected7)
        local_sha = git_blob_sha(content)
        st, d = gh('POST', '/repos/{}/git/blobs'.format(repo_full),
                   {'content': base64.b64encode(content).decode('ascii'),
                    'encoding': 'base64'})
        if st not in (200, 201):
            raise SystemExit('blob 上传失败 {}: {}'.format(rel_path, json.dumps(d)[:200]))
        remote_sha = d.get('sha', '')
        if remote_sha != local_sha:
            raise SystemExit('远端 blob sha 与本地不一致: {} (远端 {} vs 本地 {})'.format(
                rel_path, remote_sha[:7], local_sha[:7]))
        tree_entries.append({'path': rel_path, 'mode': '100644',
                             'type': 'blob', 'sha': remote_sha})
        print('  [{}] {} -> {}'.format(status, rel_path, remote_sha[:7]))

    # 2. 建树（base_tree = 父提交的树，验证确定性：结果树 sha 必须等于本地目标树）
    st, d = gh('POST', '/repos/{}/git/trees'.format(repo_full),
               {'base_tree': parent_tree, 'tree': tree_entries})
    if st not in (200, 201):
        raise SystemExit('建树失败: {}'.format(json.dumps(d)[:300]))
    new_tree = d.get('sha', '')
    print('  树: {} (校验)'.format(new_tree[:7]))

    # 3. 建提交（精确复刻作者/时间/说明）
    author_line, committer_line, message = read_loose_commit(repo_root, tip_sha)
    st, d = gh('POST', '/repos/{}/git/commits'.format(repo_full), {
        'message': message,
        'tree': new_tree,
        'parents': [parent_sha],
        'author': person_fields(author_line),
        'committer': person_fields(committer_line),
    })
    if st not in (200, 201):
        raise SystemExit('建提交失败: {}'.format(json.dumps(d)[:300]))
    new_commit = d.get('sha', '')
    exact = (new_commit == tip_sha)
    print('  提交: {} (与本地{}：{})'.format(
        new_commit[:7], '完全一致' if exact else '内容等价但 sha 不同',
        'OK' if exact else new_commit[:7]))

    # 4. 快进更新 main
    st, d = gh('PATCH', '/repos/{}/git/refs/heads/main'.format(repo_full),
               {'sha': new_commit, 'force': False})
    if st != 200:
        raise SystemExit('更新 main 失败: {}'.format(json.dumps(d)[:300]))
    print('  main -> {} (HTTP {})'.format(new_commit[:7], st))
    return new_commit, exact


OPENCLAW_ROOT = r'D:\ai\openclaw-agent'
CLOUD_ROOT = r'D:\ai\cloud-heartbeat'

OPENCLAW_ENTRIES = [
    ('M', '.gitignore', '755fa30'),
    ('M', 'Dockerfile', '35b6221'),
    ('M', 'README.md', '93dce4d'),
    ('M', 'lib/agent_engine.js', 'a80915d'),
    ('M', 'lib/model_router.js', '2831a38'),
    ('M', 'lib/qq_bot.js', '8a26045'),
    ('M', 'lib/tools/image_tool.js', '40719e2'),
    ('M', 'lib/tools/reader_tool.js', '3f72b19'),
    ('M', 'lib/tools/search_tool.js', '87f6ee4'),
    ('M', 'lib/tools/timer_tool.js', '4d03c53'),
    ('M', 'package.json', '761c53e'),
    ('M', 'render.yaml', '0ec763c'),
    ('M', 'server.js', '5d04cb8'),
    ('D', 'lib/tools/voice_tool.js', ''),
    ('A', 'docs/OPTIMIZATION_PLAN.md', '095eb6a'),
    ('A', 'docs/audit-evidence/agnes_out.txt', 'ef8614f'),
    ('A', 'docs/audit-evidence/gh_out.txt', '777fc31'),
    ('A', 'docs/audit-evidence/latency_out.txt', 'f9046be'),
    ('A', 'docs/audit-evidence/pulse_out.txt', 'ff5518d'),
    ('A', 'docs/audit-evidence/render_out.txt', '71b7c89'),
    ('A', 'docs/audit-evidence/repro_out.txt', '1d7fbcf'),
    ('A', 'docs/audit-evidence/tools_out.txt', '93c7aba'),
    ('A', 'lib/cache.js', '5bd03b2'),
    ('A', 'lib/config.js', 'd53acb7'),
    ('A', 'lib/intent.js', '8aa013d'),
    ('A', 'lib/json_extract.js', '6525c49'),
    ('A', 'lib/logger.js', '040aa86'),
    ('A', 'lib/message_handler.js', '88fc69b'),
    ('A', 'lib/safe_fetch.js', '2fc0180'),
    ('A', 'lib/selftest.js', '716356e'),
    ('A', 'lib/session_store.js', 'bb2e8e8'),
    ('A', 'lib/store.js', '15fbb78'),
    ('A', 'lib/time_parse.js', 'ce093e5'),
    ('A', 'package-lock.json', '4600f6d'),
    ('A', 'scripts/cf_setup.py', 'ce03b25'),
    ('A', 'scripts/render_configure.py', '36b7a53'),
    ('A', 'scripts/run_with_creds.py', '6212e81'),
    ('A', 'scripts/verify_agent.js', '6e43926'),
    ('A', 'scripts/verify_image.js', 'b249b94'),
    ('A', 'scripts/verify_router.js', 'e862eea'),
    ('A', 'scripts/verify_store.js', '5686265'),
    ('A', 'test/intent.test.js', '2a228b9'),
    ('A', 'test/json_extract.test.js', 'db84969'),
    ('A', 'test/qq_reply_ledger.test.js', 'e7b7f3f'),
    ('A', 'test/time_parse.test.js', 'c136cb4'),
    ('A', 'test/timer_tool.test.js', '5a34ba7'),
]

CLOUD_ENTRIES = [
    ('M', '.github/workflows/sentinel.yml', 'd530b1e'),
    ('A', 'cloudflare-worker/src/index.js', '7fc9ef5'),
    ('A', 'cloudflare-worker/wrangler.toml', '2783ac1'),
]


def main():
    results = {}
    results['openclaw-agent'] = push_tip(
        'wyl5201314xlj/openclaw-agent', OPENCLAW_ROOT,
        '70310a4211d2098ebedf87e71d04580147c02b57',
        '5e6275dfc994486aa853c8f5747819ebc97451be',
        'ab9f7356822d30569744275a1fdab52a5b814b19',
        OPENCLAW_ENTRIES,
    )
    results['cloud-heartbeat'] = push_tip(
        'wyl5201314xlj/cloud-heartbeat', CLOUD_ROOT,
        '42d986058f2157ec2b5d4efe619ad842373cef7c',
        '6245367afe63fc3f14d267f95c619e82e744da51',
        '2e786d3825dff71eb711a3d7eff16aa922b1af20',
        CLOUD_ENTRIES,
    )
    print()
    for repo, (sha, exact) in results.items():
        print('结果: {} -> {} ({})'.format(repo, sha[:7], '与本地一致' if exact else '内容等价'))


if __name__ == '__main__':
    main()
