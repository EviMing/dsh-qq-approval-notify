/**
 * Host half of the qq-approval-notify bundle.
 *
 * Every `approval/request` is observed and reported, never answered: the plugin
 * always calls `next()` so the normal approval dialog keeps its behavior. The
 * notification is fire-and-forget, and no failure here can fail the approval.
 */
import { describeApproval } from './lib/approval.mjs';
import { loadConfig, resolveConfigPath } from './lib/config.mjs';
import { OneBotClient } from './lib/onebot.mjs';
import { showWindowsNotification } from './lib/windows-toast.mjs';

export const name = 'qq-approval-notify';

const TAG = '[qq-approval-notify]';

export function apply(ctx, pluginConfig = {}) {
  const logger = ctx.logger ?? console;
  const log = (level, message) => {
    try {
      const target = logger ?? console;
      const method = typeof target?.[level] === 'function' ? target[level] : console[level];
      (method ?? console.log).call(target, `${TAG} ${message}`);
    } catch {
      /* logging must never break the approval hook */
    }
  };

  const options = pluginConfig !== null && typeof pluginConfig === 'object' ? pluginConfig : {};
  if (options.enabled === false) {
    log('info', '已在插件配置中禁用');
    return;
  }

  const configPath = resolveConfigPath(options.configFile);
  const state = { client: null, clientKey: '', recent: new Map() };
  log('info', `已启用，配置文件：${configPath}`);

  async function windowsFallback(message, config, why) {
    if (config !== null && config.windowsNotification.enabled === false) {
      log('warn', `${why}；Windows 通知已禁用，放弃本次权限通知`);
      return false;
    }
    const result = await showWindowsNotification({
      title: 'DSH 需要权限',
      body: message,
      timeoutMs: config?.windowsNotification.timeoutMs ?? 12000,
      appId: config?.windowsNotification.appId,
    });
    if (result.ok) {
      log('info', `${why}；已改用 Windows 通知（${result.via}）`);
      return true;
    }
    log('warn', `${why}；Windows 通知也失败（${result.detail}），放弃本次权限通知`);
    return false;
  }

  async function deliver(request) {
    const approval = describeApproval(request);

    let config;
    try {
      config = await loadConfig(configPath);
    } catch (error) {
      log('warn', `读取配置失败：${error.message}`);
      await windowsFallback(approval.message, null, '无法读取 QQ 通知配置');
      return;
    }

    const missing = [
      config.selfQQ === undefined ? 'selfQQ' : '',
      config.ownerQQ === undefined ? 'ownerQQ' : '',
    ].filter(Boolean);
    if (missing.length > 0) {
      log('warn', `配置缺少有效的 ${missing.join('、')}，拒绝猜测 NapCat 或收件人`);
      await windowsFallback(approval.message, config, `配置缺少 ${missing.join('、')}`);
      return;
    }

    if (config.dedupeMs > 0) {
      const now = Date.now();
      for (const [key, at] of state.recent) {
        if (now - at > config.dedupeMs) state.recent.delete(key);
      }
      if (state.recent.has(approval.message)) {
        log('debug', `跳过重复申请：${approval.message}`);
        return;
      }
      state.recent.set(approval.message, now);
      if (state.recent.size > 200) state.recent.clear();
    }

    if (config.debug) {
      log('debug', `审批请求：tool=${typeof request?.toolName === 'string' ? request.toolName : '?'} sandbox=${approval.isSandbox}`);
      log('debug', `待发送消息：${approval.message}`);
    }

    const clientKey = JSON.stringify([
      config.selfQQ,
      config.ownerQQ,
      config.napcat.endpoints,
      config.napcat.ports,
      config.napcat.token,
      config.napcat.timeoutMs,
      config.napcat.cacheMs,
    ]);
    if (state.client === null || state.clientKey !== clientKey) {
      state.client = new OneBotClient({ ...config.napcat, selfQQ: config.selfQQ });
      state.clientKey = clientKey;
    }

    try {
      const result = await state.client.sendPrivate(config.ownerQQ, approval.message);
      log('info', `已通知主人 ${config.ownerQQ}（${result.endpoint}${result.messageId === undefined ? '' : `，消息 ${result.messageId}`}）`);
      return;
    } catch (error) {
      log('warn', `QQ 通知失败：${error?.message ?? error}`);
      await windowsFallback(approval.message, config, 'QQ 通知失败');
    }
  }

  // Prepend so this observer runs before the answerer that ends the waterfall
  // (the Web client's approval listener, or ACP's). The hook still returns
  // `next()` immediately, so the real approval dialog is unaffected.
  ctx.on('approval/request', (request, next) => {
    try {
      void deliver(request).catch((error) => log('warn', `通知流程异常：${error?.message ?? error}`));
    } catch (error) {
      log('warn', `通知流程异常：${error?.message ?? error}`);
    }
    return next();
  }, { prepend: true });
}
