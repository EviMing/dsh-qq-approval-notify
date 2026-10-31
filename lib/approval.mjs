/**
 * Turns an `approval/request` event into the owner-facing text:
 *
 *   【申请{XX}权限】申请原因
 *
 * `XX` describes the behavior (沙箱, 执行命令, 修改文件, 联网, ...). The reason is
 * the host-provided display reason when present, so the message matches what the
 * approval dialog would have shown.
 */

const SANDBOX_REASON = /^escalate sandbox to ([a-z][a-z-]*):\s*([\s\S]*)$/i;

const RULES = [
  [/^(ops_)?bash$|^shell$|^powershell$|^exec$|^command$|^run$/i, '执行命令'],
  [/^run_code$/i, '执行代码'],
  [/write|edit|patch|mkdir|delete|remove|move|rename|copy|chmod|chown/i, '修改文件'],
  [/read|list|glob|grep|inspect|stat/i, '读取文件'],
  [/web|fetch|search|http|browser|download|upload/i, '联网'],
  [/plugin|bundle|install|uninstall/i, '安装插件'],
  [/ask_user|question/i, '向你提问'],
  [/skill/i, '加载技能'],
  [/subagent|workflow/i, '召唤子代理'],
  [/mcp|connection/i, '调用 MCP'],
  [/notebook|todo/i, '更新计划'],
  [/present|deliverable/i, '交付文件'],
];

function oneLine(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text;
}

function truncate(text, max = 600) {
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('')}…`;
}

function localizedReason(request) {
  const display = request?.displayReason;
  if (display !== null && typeof display === 'object') {
    if (typeof display.zh === 'string' && display.zh.trim()) return display.zh;
    if (typeof display.en === 'string' && display.en.trim()) return display.en;
  }
  return '';
}

function anyReason(request) {
  return localizedReason(request)
    || (typeof request?.reason === 'string' ? request.reason : '');
}

function labelFor(toolName) {
  for (const [pattern, label] of RULES) {
    if (pattern.test(toolName)) return label;
  }
  return `调用 ${toolName}`;
}

/**
 * @param {object} request - the `approval/request` event payload.
 * @returns {{label: string, detail: string, message: string, isSandbox: boolean}}
 */
export function describeApproval(request) {
  const toolName = typeof request?.toolName === 'string' && request.toolName.trim()
    ? request.toolName.trim()
    : '未知工具';
  const reason = typeof request?.reason === 'string' ? request.reason : '';
  const sandbox = SANDBOX_REASON.exec(reason);

  if (sandbox !== null) {
    const mode = sandbox[1].trim();
    const justification = oneLine(sandbox[2]);
    const provided = localizedReason(request).trim();
    const detail = provided
      || `允许本次操作使用 ${mode} 权限${justification ? `：${justification}` : ''}`;
    return finish('沙箱', detail, true);
  }

  const provided = anyReason(request).trim();
  const detail = provided || `DSH 需要你批准这次 ${toolName} 调用。`;
  return finish(labelFor(toolName), detail, false);
}

function finish(label, detail, isSandbox) {
  const clean = truncate(oneLine(detail)) || 'DSH 正在等待你的批准。';
  const spacer = /[A-Za-z0-9_]$/.test(label) ? ' ' : '';
  return {
    label,
    detail: clean,
    message: `【申请${label}${spacer}权限】${clean}`,
    isSandbox,
  };
}
