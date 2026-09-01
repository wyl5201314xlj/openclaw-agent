// lib/store.js
// 持久化适配层（阶段 0-7）：定时提醒不能再纯内存，否则 Render 休眠/重启即全部蒸发。
//
// 后端优先级：
//   1. Cloudflare KV —— 计划里的首选（延迟最低）。**需要一枚带 Workers KV Storage:Edit
//      权限的 Token**；本次实测主人现有的 cloudflare api_token 是只读的
//      （列举命名空间 200，创建命名空间 / 部署 Worker 全部 403 Authentication error），
//      所以这条路暂时走不通，代码保留、配上变量即自动启用。
//   2. GitHub 私有仓库当键值存储 —— **今天就能用**：已实测用现有 PAT 成功创建私有仓库
//      openclaw-state 并完成写入 / 读回 / 删除。延迟约 1 秒，对提醒场景完全够用。
//   3. 进程内存 —— 最后兜底，会在启动日志与 /api/selftest 里明确标红，不假装可用。

const { config } = require('./config');
const { createLogger } = require('./logger');
const { fetchJson, fetchText, safeFetch } = require('./safe_fetch');

const log = createLogger('Store');

const CF_HOST = 'api.cloudflare.com';
const GH_HOST = 'api.github.com';
const KEY_PATTERN = /^[A-Za-z0-9:._-]+$/;

/** 键名 -> 仓库内文件名（冒号在 git 路径里可用但易踩坑，统一换成双下划线） */
function keyToPath(prefixDir, key) {
  return `${prefixDir}/${key.replace(/:/g, '__')}.json`;
}

function pathToKey(prefixDir, filePath) {
  const name = filePath.startsWith(`${prefixDir}/`) ? filePath.slice(prefixDir.length + 1) : filePath;
  return name.replace(/\.json$/, '').replace(/__/g, ':');
}

class Store {
  constructor() {
    const s = config.store;
    this.cfEnabled = Boolean(s.cfAccountId && s.cfKvNamespaceId && s.cfApiToken);
    this.cfBase = this.cfEnabled
      ? `https://${CF_HOST}/client/v4/accounts/${encodeURIComponent(s.cfAccountId)}` +
        `/storage/kv/namespaces/${encodeURIComponent(s.cfKvNamespaceId)}`
      : '';

    this.ghEnabled = Boolean(s.ghToken && s.ghRepo);
    this.ghDir = s.ghDir || 'state';
    this.shaCache = new Map(); // path -> sha，减少一次 GET

    this.memory = new Map();
    this.lastError = null;
  }

  get mode() {
    if (this.cfEnabled) return 'cloudflare-kv';
    if (this.ghEnabled) return 'github-repo';
    return 'memory-fallback';
  }

  assertKey(key) {
    if (!KEY_PATTERN.test(String(key || ''))) {
      throw new Error(`非法的存储键名: ${String(key).slice(0, 60)}`);
    }
  }

  // ---------------- 对外接口 ----------------

  async put(key, value, ttlSeconds) {
    this.assertKey(key);
    const wrapper = {
      value,
      expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : 0,
    };
    const payload = JSON.stringify(wrapper);

    if (this.cfEnabled) {
      try {
        await this.cfPut(key, payload, ttlSeconds);
        return { ok: true, mode: this.mode };
      } catch (err) {
        this.lastError = err.message;
        log.error(`KV 写入失败 key=${key}，回落内存`, err);
      }
    } else if (this.ghEnabled) {
      try {
        await this.ghPut(key, payload);
        return { ok: true, mode: this.mode };
      } catch (err) {
        this.lastError = err.message;
        log.error(`GitHub 写入失败 key=${key}，回落内存`, err);
      }
    }

    this.memory.set(key, payload);
    return { ok: this.mode === 'memory-fallback', mode: 'memory-fallback', error: this.lastError };
  }

  async get(key) {
    this.assertKey(key);
    let payload = null;
    if (this.cfEnabled) {
      try {
        payload = await this.cfGet(key);
      } catch (err) {
        this.lastError = err.message;
        log.warn(`KV 读取失败 key=${key}，回落内存`, err);
      }
    } else if (this.ghEnabled) {
      try {
        payload = await this.ghGet(key);
      } catch (err) {
        this.lastError = err.message;
        log.warn(`GitHub 读取失败 key=${key}，回落内存`, err);
      }
    }
    if (payload === null) payload = this.memory.get(key) ?? null;
    if (payload === null) return null;

    let wrapper;
    try {
      wrapper = JSON.parse(payload);
    } catch {
      return null;
    }
    // 兼容早期未包装的记录
    if (wrapper && typeof wrapper === 'object' && 'value' in wrapper && 'expireAt' in wrapper) {
      if (wrapper.expireAt && Date.now() > wrapper.expireAt) {
        await this.delete(key);
        return null;
      }
      return wrapper.value;
    }
    return wrapper;
  }

  async delete(key) {
    this.assertKey(key);
    this.memory.delete(key);
    if (this.cfEnabled) {
      try {
        await this.cfDelete(key);
      } catch (err) {
        this.lastError = err.message;
        log.warn(`KV 删除失败 key=${key}`, err);
        return { ok: false, error: err.message };
      }
    } else if (this.ghEnabled) {
      try {
        await this.ghDelete(key);
      } catch (err) {
        this.lastError = err.message;
        log.warn(`GitHub 删除失败 key=${key}`, err);
        return { ok: false, error: err.message };
      }
    }
    return { ok: true };
  }

  async listKeys(prefix) {
    if (this.cfEnabled) {
      try {
        return await this.cfList(prefix);
      } catch (err) {
        this.lastError = err.message;
        log.warn(`KV 列举失败 prefix=${prefix}`, err);
      }
    } else if (this.ghEnabled) {
      try {
        return await this.ghList(prefix);
      } catch (err) {
        this.lastError = err.message;
        log.warn(`GitHub 列举失败 prefix=${prefix}`, err);
      }
    }
    return [...this.memory.keys()].filter((k) => k.startsWith(prefix));
  }

  /** 供 /api/selftest：写入-读回-删除跑一轮，确认后端真的可用 */
  async healthCheck() {
    if (this.mode === 'memory-fallback') {
      return {
        ok: false,
        mode: this.mode,
        detail:
          '未配置任何持久化后端：请配 CF_ACCOUNT_ID/CF_KV_NAMESPACE_ID/CF_API_TOKEN ' +
          '或 GH_STATE_TOKEN/GH_STATE_REPO，否则重启会丢失定时提醒',
      };
    }
    const key = `__healthcheck__${Date.now().toString(36)}`;
    const put = await this.put(key, { probe: true }, 300);
    if (!put.ok) return { ok: false, mode: this.mode, detail: put.error || '写入失败' };
    const read = await this.get(key);
    await this.delete(key);
    return {
      ok: Boolean(read && read.probe === true),
      mode: this.mode,
      detail: read ? '写入-读回-删除全链路通过' : '写入成功但读回失败',
    };
  }

  // ---------------- 后端一：Cloudflare KV ----------------

  cfHeaders() {
    return { Authorization: `Bearer ${config.store.cfApiToken}` };
  }

  async cfPut(key, payload, ttlSeconds) {
    // KV 的 expiration_ttl 下限是 60 秒；更短的由 wrapper 里的 expireAt 兜住
    const query = ttlSeconds && ttlSeconds >= 60 ? `?expiration_ttl=${Math.floor(ttlSeconds)}` : '';
    const form = new FormData();
    form.append('value', payload);
    form.append('metadata', '{}');
    await fetchJson(`${this.cfBase}/values/${encodeURIComponent(key)}${query}`, {
      method: 'PUT',
      headers: this.cfHeaders(),
      body: form,
      timeoutMs: 10000,
      allowHosts: [CF_HOST],
    });
  }

  async cfGet(key) {
    try {
      return await fetchText(`${this.cfBase}/values/${encodeURIComponent(key)}`, {
        headers: this.cfHeaders(),
        timeoutMs: 10000,
        allowHosts: [CF_HOST],
      });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async cfDelete(key) {
    try {
      await fetchJson(`${this.cfBase}/values/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: this.cfHeaders(),
        timeoutMs: 10000,
        allowHosts: [CF_HOST],
      });
    } catch (err) {
      if (err.status !== 404) throw err;
    }
  }

  async cfList(prefix) {
    const data = await fetchJson(
      `${this.cfBase}/keys?prefix=${encodeURIComponent(prefix)}&limit=1000`,
      { headers: this.cfHeaders(), timeoutMs: 10000, allowHosts: [CF_HOST] }
    );
    return (data.result || []).map((r) => r.name);
  }

  // ---------------- 后端二：GitHub 私有仓库当键值存储 ----------------

  ghHeaders() {
    return {
      Authorization: `Bearer ${config.store.ghToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'openclaw-agent',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  ghContentsUrl(filePath) {
    return `https://${GH_HOST}/repos/${config.store.ghRepo}/contents/${filePath}`;
  }

  async ghPut(key, payload) {
    const filePath = keyToPath(this.ghDir, key);
    const body = {
      message: `state: put ${key}`,
      content: Buffer.from(payload, 'utf8').toString('base64'),
    };
    const cachedSha = this.shaCache.get(filePath);
    if (cachedSha) body.sha = cachedSha;

    try {
      const data = await fetchJson(this.ghContentsUrl(filePath), {
        method: 'PUT',
        headers: this.ghHeaders(),
        body: JSON.stringify(body),
        timeoutMs: 15000,
        allowHosts: [GH_HOST],
      });
      const sha = data?.content?.sha;
      if (sha) this.shaCache.set(filePath, sha);
      return;
    } catch (err) {
      // 409/422 = sha 不匹配或缺失：重新取一次 sha 再写
      if (err.status !== 409 && err.status !== 422) throw err;
    }
    const current = await this.ghStat(filePath);
    if (current?.sha) body.sha = current.sha;
    const data = await fetchJson(this.ghContentsUrl(filePath), {
      method: 'PUT',
      headers: this.ghHeaders(),
      body: JSON.stringify(body),
      timeoutMs: 15000,
      allowHosts: [GH_HOST],
    });
    const sha = data?.content?.sha;
    if (sha) this.shaCache.set(filePath, sha);
  }

  async ghStat(filePath) {
    try {
      return await fetchJson(this.ghContentsUrl(filePath), {
        headers: this.ghHeaders(),
        timeoutMs: 15000,
        allowHosts: [GH_HOST],
      });
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  async ghGet(key) {
    const filePath = keyToPath(this.ghDir, key);
    const data = await this.ghStat(filePath);
    if (!data || !data.content) return null;
    this.shaCache.set(filePath, data.sha);
    return Buffer.from(data.content, 'base64').toString('utf8');
  }

  async ghDelete(key) {
    const filePath = keyToPath(this.ghDir, key);
    let sha = this.shaCache.get(filePath);
    if (!sha) {
      const data = await this.ghStat(filePath);
      if (!data) return;
      sha = data.sha;
    }
    try {
      await fetchJson(this.ghContentsUrl(filePath), {
        method: 'DELETE',
        headers: this.ghHeaders(),
        body: JSON.stringify({ message: `state: delete ${key}`, sha }),
        timeoutMs: 15000,
        allowHosts: [GH_HOST],
      });
    } catch (err) {
      if (err.status !== 404) throw err;
    } finally {
      this.shaCache.delete(filePath);
    }
  }

  async ghList(prefix) {
    let items;
    try {
      items = await fetchJson(this.ghContentsUrl(this.ghDir), {
        headers: this.ghHeaders(),
        timeoutMs: 15000,
        allowHosts: [GH_HOST],
      });
    } catch (err) {
      if (err.status === 404) return []; // 目录还不存在
      throw err;
    }
    if (!Array.isArray(items)) return [];
    return items
      .filter((it) => it.type === 'file' && it.name.endsWith('.json'))
      .map((it) => pathToKey(this.ghDir, it.path))
      .filter((k) => k.startsWith(prefix));
  }
}

module.exports = new Store();
module.exports._Store = Store;
module.exports._helpers = { keyToPath, pathToKey };
