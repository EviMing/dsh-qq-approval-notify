/**
 * Turns a `user-questions/request` event into the owner-facing text.
 *
 * `ask_user_question` blocks until the human answers in the DSH UI, so the
 * notification must say what the agent is waiting for, in one glance:
 *
 *   【需要你回答】<header>：<question>（单选：A / B）
 */

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(text, max) {
  const characters = [...text];
  return characters.length <= max ? text : `${characters.slice(0, max - 1).join('')}…`;
}

/**
 * @param {object} request - the `user-questions/request` event payload.
 * @returns {{text: string, count: number}}
 */
export function describeQuestion(request) {
  const questions = Array.isArray(request?.questions) ? request.questions.filter(Boolean) : [];
  const lines = questions.map((question, index) => {
    const header = oneLine(question.header);
    const text = oneLine(question.question) || '(没有题目文字)';
    const options = (Array.isArray(question.options) ? question.options : [])
      .map((option) => oneLine(option?.label))
      .filter(Boolean);
    const suffix = options.length > 0
      ? `（${question.multiSelect === true ? '可多选' : '单选'}：${options.join(' / ')}）`
      : '';
    const detail = oneLine(question.detail);
    const extra = detail && detail !== text
      ? `〔${truncate(detail, 240)}〕`
      : '';
    const body = `${header ? `${header}：` : ''}${text}${suffix}${extra}`;
    return `${index === 0 ? '【需要你回答】' : '- '}${body}`;
  });

  if (lines.length === 0) {
    return { text: '【需要你回答】DSH 正在等待你在界面上输入。', count: 0 };
  }
  return { text: lines.join('\n'), count: lines.length };
}
