/**
 * Host half of the qq-approval-notify bundle.
 *
 * Two kinds of host events are observed and reported, never answered:
 *
 *  - `approval/request` — a permission prompt (sandbox escalation, tool policy)
 *  - `user-questions/request` — `ask_user_question` / plan review waiting for
 *    the human to interact with the DSH UI
 *
 * Both listeners are prepended: the Web client's forwarders register at startup
 * without `prepend` and terminate the waterfall once they have their answer, so
 * an observer registered later never runs. The hooks still return `next()`
 * immediately, and no notification failure can affect the real prompt.
 */
import { describeApproval } from './lib/approval.mjs';
import { describeQuestion } from './lib/question.mjs';
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

  async function windowsFallback(message, config, why, title) {
    if (config !== null && config.windowsNotification.enabled === false) {
      log('warn', `${why}；Windows 通知已禁用，放弃本次通知`);
      return false;
    }
    const result = await showWindowsNotification({
      title,
      body: message,
      timeoutMs: config?.windowsNotification.timeoutMs ?? 12000,
      appId: config?.windowsNotification.appId,
    });
    if (result.ok) {
      log('info', `${why}；已改用 Windows 通知（${result.via}）`);
      return true;
    }
    log('warn', `${why}；Windows 通知也失败（${result.detail}），放弃本次通知`);
    return false;
  }

  async function sendText(text, title) {
    let config;
    try {
      config = await loadConfig(configPath);
    } catch (error) {
      log('warn', `读取配置失败：${error.message}`);
      await windowsFallback(text, null, '无法读取 QQ 通知配置', title);
      return;
    }

    const missing = [
      config.selfQQ === undefined ? 'selfQQ' : '',
      config.ownerQQ === undefined ? 'ownerQQ' : '',
    ].filter(Boolean);
    if (missing.length > 0) {
      log('warn', `配置缺少有效的 ${missing.join('、')}，拒绝猜测 NapCat 或收件人`);
      await windowsFallback(text, config, `配置缺少 ${missing.join('、')}`, title);
      return;
    }

    if (config.dedupeMs > 0) {
      const now = Date.now();
      for (const [key, at] of state.recent) {
        if (now - at > config.dedupeMs) state.recent.delete(key);
      }
      if (state.recent.has(text)) {
        log('debug', `跳过重复通知：${text}`);
        return;
      }
      state.recent.set(text, now);
      if (state.recent.size > 200) state.recent.clear();
    }

    if (config.debug) {
      log('debug', `待发送消息：${text}`);
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
      const result = await state.client.sendPrivate(config.ownerQQ, text);
      log('info', `已通知主人 ${config.ownerQQ}（${result.endpoint}${result.messageId === undefined ? '' : `，消息 ${result.messageId}`}）`);
      return;
    } catch (error) {
      log('warn', `QQ 通知失败：${error?.message ?? error}`);
      await windowsFallback(text, config, 'QQ 通知失败', title);
    }
  }

  async function deliverApproval(request) {
    await sendText(describeApproval(request).message, 'DSH 需要权限');
  }

  async function deliverQuestion(request) {
    const { text } = describeQuestion(request);
    await sendText(text, 'DSH 需要你回答');
  }

  function observe(deliver, kind) {
    return (request, next) => {
      try {
        void deliver(request).catch((error) => log('warn', `${kind}通知流程异常：${error?.message ?? error}`));
      } catch (error) {
        log('warn', `${kind}通知流程异常：${error?.message ?? error}`);
      }
      return next();
    };
  }

  // Prepend so these observers run before the answerer that ends the waterfall
  // (the Web client's forwarded approval/question listener, or ACP's). The hooks
  // still return `next()` immediately, so the real prompt is unaffected.
  ctx.on('approval/request', observe(deliverApproval, '审批'), { prepend: true });
  ctx.on('user-questions/request', observe(deliverQuestion, '提问'), { prepend: true });
}
