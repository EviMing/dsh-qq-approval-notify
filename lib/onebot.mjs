/**
 * Minimal OneBot 11 client + NapCat discovery.
 *
 * Discovery order:
 *   1. endpoints from the config file (the documented, fastest path);
 *   2. LISTENING TCP ports owned by NapCat/QQ/node-like processes;
 *   3. well-known ports 3000/3001.
 *
 * Every candidate is verified with `get_login_info`, and only an instance whose
 * `user_id` equals the configured `selfQQ` is accepted. That check is what keeps
 * the plugin from talking to a different QQ/NapCat process on the same machine.
 */
import { spawn } from 'node:child_process';

const PROCESS_HINT = /napcat|onebot|qq|node|electron|lagrange/i;
const PROBE_CONCURRENCY = 4;
const MAX_RESPONSE_TEXT = 160;

export class NapCatUnavailableError extends Error {
  constructor(message, code = 'napcat-unavailable') {
    super(message);
    this.name = 'NapCatUnavailableError';
    this.code = code;
  }
}

function cleanDetail(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_RESPONSE_TEXT);
}

function runCommand(file, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(reject, new Error(`${file} 超时`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0) finish(resolve, stdout);
      else finish(reject, new Error(`${file} 退出码 ${code}${stderr.trim() ? `：${cleanDetail(stderr)}` : ''}`));
    });
  });
}

function isLocalAddress(host) {
  if (typeof host !== 'string') return false;
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  return bare === '::' || bare === '::1' || bare === '0.0.0.0'
    || bare === 'localhost' || bare.startsWith('127.');
}

function processPriority(name) {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('napcat')) return 0;
  if (lower.includes('onebot')) return 1;
  if (lower.includes('qq')) return 2;
  if (lower.includes('node') || lower.includes('electron')) return 3;
  return 4;
}

function chunksOf(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

export class OneBotClient {
  constructor(options = {}) {
    this.endpoints = Array.isArray(options.endpoints) ? options.endpoints.filter(Boolean) : [];
    this.ports = Array.isArray(options.ports) ? options.ports.filter(Number.isInteger) : [];
    this.token = typeof options.token === 'string' ? options.token : '';
    this.selfQQ = typeof options.selfQQ === 'string' ? options.selfQQ : String(options.selfQQ ?? '');
    this.timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 1200;
    this.cacheMs = Number.isInteger(options.cacheMs) ? options.cacheMs : 60000;
    this.cached = null;
    this.portCache = null;
  }

  async postJson(base, action, payload) {
    const url = `${base.replace(/\/+$/, '')}/${action}`;
    const headers = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = error?.name === 'TimeoutError' ? '请求超时' : (error?.cause?.code ?? error?.code ?? '网络错误');
      throw new Error(`${base} 不可达（${name}）`);
    }
    const text = await response.text().catch(() => '');
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (json === null) throw new Error(`${base} 返回了非 JSON 响应（HTTP ${response.status}）`);
    return json;
  }

  async call(base, action, payload) {
    return this.postJson(base, action, payload);
  }

  /** @returns {Promise<boolean>} whether `base` is NapCat logged in as selfQQ. */
  async probeEndpoint(base) {
    try {
      const info = await this.call(base, 'get_login_info', {});
      const id = String(info?.data?.user_id ?? '');
      if (id !== this.selfQQ) return false;
      if (info.retcode !== undefined && info.retcode !== 0) return false;
      if (info.status !== undefined && info.status !== 'ok') return false;
      return true;
    } catch {
      return false;
    }
  }

  async candidates() {
    const list = [];
    const seen = new Set();
    const add = (base) => {
      const normalized = String(base).replace(/\/+$/, '');
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      list.push(normalized);
    };
    for (const endpoint of this.endpoints) add(endpoint);
    let processPorts = [];
    try { processPorts = await this.processPorts(); } catch { processPorts = []; }
    for (const port of processPorts) add(`http://127.0.0.1:${port}`);
    for (const port of this.ports) add(`http://127.0.0.1:${port}`);
    return list;
  }

  /** LISTENING ports whose owning process looks like NapCat/QQ/node. */
  async processPorts() {
    if (this.portCache !== null && Date.now() - this.portCache.at < 10000) return this.portCache.ports;
    const output = await runCommand('netstat', ['-ano', '-p', 'tcp'], 4000);
    const rows = [];
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
      if (match === null) continue;
      const [, host, portText, pidText] = match;
      const port = Number(portText);
      const pid = Number(pidText);
      if (!isLocalAddress(host) || !Number.isInteger(port) || port <= 0 || !Number.isInteger(pid) || pid <= 0) continue;
      rows.push({ port, pid });
    }
    let names = new Map();
    try { names = await this.processNames(); } catch { names = new Map(); }
    const ports = [];
    const relevant = rows
      .filter((row) => PROCESS_HINT.test(names.get(row.pid) ?? ''))
      .sort((left, right) => processPriority(names.get(left.pid)) - processPriority(names.get(right.pid))
        || left.port - right.port);
    for (const row of relevant) {
      if (!ports.includes(row.port)) ports.push(row.port);
    }
    this.portCache = { at: Date.now(), ports };
    return ports;
  }

  async processNames() {
    const output = await runCommand('tasklist', ['/FO', 'CSV', '/NH'], 4000);
    const names = new Map();
    for (const line of output.split(/\r?\n/)) {
      const match = /^"([^"]+)","(\d+)"/.exec(line.trim());
      if (match === null) continue;
      names.set(Number(match[2]), match[1]);
    }
    return names;
  }

  /**
   * Find the verified endpoint, using the last good one while its TTL lasts.
   * @param {boolean} force - ignore the cached endpoint.
   */
  async discover(force = false) {
    if (!force && this.cached !== null && Date.now() - this.cached.at < this.cacheMs) return this.cached.base;
    const candidates = await this.candidates();
    for (const batch of chunksOf(candidates, PROBE_CONCURRENCY)) {
      const results = await Promise.all(batch.map((base) => this.probeEndpoint(base)));
      const hit = batch[results.indexOf(true)];
      if (hit !== undefined) {
        this.cached = { base: hit, at: Date.now() };
        return hit;
      }
    }
    throw new NapCatUnavailableError(
      `没有找到登录为 ${this.selfQQ} 的 NapCat（已探测 ${candidates.length} 个地址）`,
      'napcat-not-found',
    );
  }

  /**
   * Send a private text message, rediscovering once if the cached endpoint died.
   * @returns {Promise<{endpoint: string, messageId: number|undefined}>}
   */
  async sendPrivate(userQQ, text) {
    const target = String(userQQ ?? '');
    if (!/^\d{5,12}$/.test(target)) throw new Error(`主人的 QQ 号无效：${target}`);
    const body = {
      user_id: Number(target),
      message: [{ type: 'text', data: { text } }],
      auto_escape: false,
    };

    let base;
    try {
      base = await this.discover();
    } catch (error) {
      throw error instanceof NapCatUnavailableError
        ? error
        : new NapCatUnavailableError(`查找 NapCat 失败：${error.message}`, 'napcat-discovery');
    }

    try {
      return await this.sendAt(base, body);
    } catch (firstError) {
      this.cached = null;
      this.portCache = null;
      try {
        base = await this.discover(true);
      } catch {
        throw firstError;
      }
      return this.sendAt(base, body);
    }
  }

  async sendAt(base, body) {
    const result = await this.call(base, 'send_private_msg', body);
    if (result?.status === 'ok' || result?.retcode === 0) {
      return { endpoint: base, messageId: result?.data?.message_id };
    }
    const reason = result?.wording ?? result?.msg ?? result?.message ?? result?.status ?? '未知错误';
    throw new Error(`NapCat 拒绝发送消息：${cleanDetail(reason)}`);
  }
}
