/**
 * Reads and normalizes the plugin configuration file.
 *
 * The file deliberately lives outside this package: the profile may be
 * reinstalled or the package may be shared, while the owner/bot QQ numbers and
 * the NapCat token belong to this machine only.
 */
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_WINDOWS_APP_ID =
  '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';

const DEFAULT_ENDPOINTS = ['http://127.0.0.1:3000'];
const DEFAULT_PORTS = [3000, 3001];
const QQ_PATTERN = /^\d{5,12}$/;

export class ConfigError extends Error {
  constructor(message, code = 'config-invalid') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/** Absolute path of the config file, honoring the plugin row and the environment. */
export function resolveConfigPath(explicit) {
  const fromPlugin = typeof explicit === 'string' ? explicit.trim() : '';
  if (fromPlugin) return fromPlugin;
  const fromEnv = typeof process.env.DSH_QQ_APPROVAL_CONFIG === 'string'
    ? process.env.DSH_QQ_APPROVAL_CONFIG.trim()
    : '';
  if (fromEnv) return fromEnv;
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh');
  return join(dshHome, 'qq-approval-notify.json');
}

/** Normalize a QQ number given as a string or a safe integer. */
export function normalizeQQ(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  if (typeof value !== 'string') return undefined;
  const digits = value.trim().replace(/\s+/g, '');
  return QQ_PATTERN.test(digits) ? digits : undefined;
}

function normalizeBaseUrl(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text) return undefined;
  const withScheme = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return undefined;
  }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function clampInt(value, fallback, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function normalizePorts(value) {
  const ports = [];
  for (const item of asArray(value)) {
    const port = typeof item === 'number' ? item : Number(item);
    if (Number.isInteger(port) && port > 0 && port < 65536 && !ports.includes(port)) ports.push(port);
  }
  return ports;
}

/**
 * Turn raw JSON into the shape the rest of the plugin consumes.
 * Unknown keys are ignored so the file can carry future options harmlessly.
 */
export function normalizeConfig(raw, source = '') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('配置文件根节点必须是 JSON 对象');
  }

  const ownerQQ = normalizeQQ(raw.ownerQQ);
  const selfQQ = normalizeQQ(raw.selfQQ);
  const napcat = raw.napcat !== null && typeof raw.napcat === 'object' && !Array.isArray(raw.napcat)
    ? raw.napcat
    : {};

  const endpoints = [];
  for (const item of asArray(napcat.endpoints ?? raw.endpoints)) {
    const endpoint = normalizeBaseUrl(item);
    if (endpoint !== undefined && !endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  if (endpoints.length === 0) endpoints.push(...DEFAULT_ENDPOINTS);

  const ports = normalizePorts(napcat.ports ?? raw.ports);
  const windowsRaw = raw.windowsNotification;
  const windowsObject = windowsRaw !== null && typeof windowsRaw === 'object' && !Array.isArray(windowsRaw)
    ? windowsRaw
    : {};
  const windowsEnabled = windowsRaw === false ? false : windowsObject.enabled !== false;

  return {
    source,
    ownerQQ,
    selfQQ,
    napcat: {
      endpoints,
      ports: ports.length > 0 ? ports : DEFAULT_PORTS,
      token: typeof napcat.token === 'string' ? napcat.token.trim() : '',
      timeoutMs: clampInt(napcat.timeoutMs ?? raw.requestTimeoutMs, 1200, 300, 5000),
      cacheMs: clampInt(napcat.discoveryCacheMs ?? raw.discoveryCacheMs, 60000, 1000, 600000),
    },
    windowsNotification: {
      enabled: windowsEnabled,
      timeoutMs: clampInt(windowsObject.timeoutMs, 12000, 3000, 30000),
      appId: typeof windowsObject.appId === 'string' && windowsObject.appId.trim()
        ? windowsObject.appId.trim()
        : DEFAULT_WINDOWS_APP_ID,
    },
    dedupeMs: clampInt(raw.dedupeMs, 20000, 0, 600000),
    debug: raw.debug === true,
  };
}

let cached = null;

/**
 * Read the config, reusing the parsed copy until the file's mtime/size change.
 * A missing or malformed file is an error rather than a silent default: sending
 * a permission request to a guessed QQ number would be worse than not sending.
 */
export async function loadConfig(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    throw new ConfigError(`找不到配置文件 ${path}（${error.code ?? error.message}）`, 'config-missing');
  }

  if (cached !== null && cached.path === path && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
    return cached.config;
  }

  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError(`无法读取配置文件 ${path}（${error.code ?? error.message}）`, 'config-unreadable');
  }

  let raw;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new ConfigError(`配置文件不是合法 JSON：${error.message}`, 'config-json');
  }

  const config = normalizeConfig(raw, path);
  cached = { path, mtimeMs: info.mtimeMs, size: info.size, config };
  return config;
}
