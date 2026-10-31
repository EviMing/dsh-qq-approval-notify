/**
 * Offline + live self-checks for qq-approval-notify.
 *
 *   node test/check.mjs
 *
 * Offline checks use a fake OneBot server. The live checks only probe the real
 * NapCat (`get_login_info`); they never send a QQ message. Set
 * DSH_QQ_LIVE_SEND=1 to also send one clearly-labelled test message to the owner.
 */
import { createServer } from 'node:http';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeApproval } from '../lib/approval.mjs';
import { loadConfig, normalizeConfig, normalizeQQ } from '../lib/config.mjs';
import { NapCatUnavailableError, OneBotClient } from '../lib/onebot.mjs';
import { showWindowsNotification } from '../lib/windows-toast.mjs';
import { apply as applyPlugin } from '../index.js';

let passed = 0;
let failed = 0;

function ok(condition, name, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failed += 1;
    console.error(`FAIL ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

function equal(actual, expected, name) {
  ok(actual === expected, name, `expected: ${JSON.stringify(expected)}\n     actual:   ${JSON.stringify(actual)}`);
}

async function expectReject(promise, name) {
  try {
    await promise;
    ok(false, name, 'expected rejection, got success');
  } catch {
    ok(true, name);
  }
}

function makeFakeOneBot({ selfQQ = '111222333', token = 'secret-token' } = {}) {
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const url = new URL(request.url, 'http://127.0.0.1');
      const auth = request.headers.authorization ?? '';
      const expectedAuth = token ? `Bearer ${token}` : '';
      if (auth !== expectedAuth) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'failed', retcode: 1403, message: 'bad token' }));
        return;
      }
      if (url.pathname === '/get_login_info') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: Number(selfQQ), nickname: 'fake' } }));
        return;
      }
      if (url.pathname === '/send_private_msg') {
        const parsed = JSON.parse(body || '{}');
        received.push(parsed);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 42 } }));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ status: 'failed', retcode: 404 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        base: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

async function tempConfig(raw) {
  const dir = await mkdtemp(join(tmpdir(), 'qq-approval-notify-'));
  const file = join(dir, 'config.json');
  await writeFile(file, JSON.stringify(raw), 'utf8');
  return file;
}

console.log('— 消息格式 —');
{
  const sandbox = describeApproval({
    toolName: 'ops_bash',
    reason: 'escalate sandbox to workspace-write: 需要写入 D:\\DSH_WorkArea\\out.txt',
    displayReason: { en: 'Allow workspace-write: ...', zh: '允许本次操作使用 workspace-write 权限：需要写入 D:\\DSH_WorkArea\\out.txt' },
  });
  equal(sandbox.label, '沙箱', '沙箱请求识别为“沙箱”');
  equal(
    sandbox.message,
    '【申请沙箱权限】允许本次操作使用 workspace-write 权限：需要写入 D:\\DSH_WorkArea\\out.txt',
    '沙箱请求完整消息',
  );

  const bash = describeApproval({
    toolName: 'bash',
    reason: 'tool "bash" requires approval',
    displayReason: { en: 'Run command', zh: '执行命令：npm test' },
  });
  equal(bash.message, '【申请执行命令权限】执行命令：npm test', '执行命令消息');

  const write = describeApproval({ toolName: 'write', reason: 'needs approval' });
  equal(write.label, '修改文件', 'write 映射为“修改文件”');
  ok(write.message.startsWith('【申请修改文件权限】'), 'write 消息格式', write.message);

  const unknown = describeApproval({ toolName: 'mystery_tool' });
  equal(unknown.message, '【申请调用 mystery_tool 权限】DSH 需要你批准这次 mystery_tool 调用。', '未知工具兜底');

  const multiline = describeApproval({
    toolName: 'ops_bash',
    reason: 'escalate sandbox to danger-full-access: line1\nline2\n\nline3',
  });
  equal(multiline.message, '【申请沙箱权限】允许本次操作使用 danger-full-access 权限：line1 line2 line3', '多行原因压成一行');
}

console.log('— 配置解析 —');
{
  equal(normalizeQQ(2368199809), '2368199809', '数字 QQ 转字符串');
  equal(normalizeQQ(' 3641194452 '), '3641194452', '字符串 QQ 去空白');
  equal(normalizeQQ('123'), undefined, '过短 QQ 拒绝');
  equal(normalizeQQ('abc'), undefined, '非数字 QQ 拒绝');

  const config = normalizeConfig({
    ownerQQ: 2368199809,
    selfQQ: '3641194452',
    napcat: { endpoints: ['127.0.0.1:3000/', 'http://127.0.0.1:3000'], token: ' t ', ports: [3000, 3000, 70000] },
    dedupeMs: -5,
  });
  equal(config.ownerQQ, '2368199809', 'ownerQQ 规范化');
  equal(config.napcat.endpoints.length, 1, 'endpoint 去重并补协议');
  equal(config.napcat.endpoints[0], 'http://127.0.0.1:3000', 'endpoint 去尾斜杠');
  equal(config.napcat.token, 't', 'token 去空白');
  equal(config.dedupeMs, 0, 'dedupeMs 下限');
  equal(config.windowsNotification.enabled, true, '默认启用 Windows 通知');

  const file = await tempConfig({ ownerQQ: '2368199809', selfQQ: '3641194452', napcat: { token: 'x' } });
  const loaded = await loadConfig(file);
  equal(loaded.selfQQ, '3641194452', '从文件加载配置');
}

console.log('— 假 OneBot —');
{
  const fake = await makeFakeOneBot();
  const client = new OneBotClient({
    endpoints: [fake.base],
    ports: [],
    token: 'secret-token',
    selfQQ: '111222333',
    timeoutMs: 1500,
    cacheMs: 60000,
  });
  const endpoint = await client.discover();
  equal(endpoint, fake.base, '探测到正确登录的假 NapCat');
  const sent = await client.sendPrivate('999888777', '【申请沙箱权限】测试');
  equal(sent.messageId, 42, '发送返回 message_id');
  equal(fake.received.length, 1, '假 NapCat 收到一条消息');
  equal(fake.received[0].user_id, 999888777, '收件人是主人 QQ');
  equal(fake.received[0].message[0].data.text, '【申请沙箱权限】测试', '消息文本一致');

  const wrong = new OneBotClient({
    endpoints: [fake.base],
    ports: [1],
    token: 'secret-token',
    selfQQ: '111222334',
    timeoutMs: 600,
    cacheMs: 0,
  });
  await expectReject(wrong.discover(), '登录 QQ 不匹配时拒绝使用该 NapCat');

  const noToken = new OneBotClient({
    endpoints: [fake.base],
    ports: [],
    token: 'wrong-token',
    selfQQ: '111222333',
    timeoutMs: 600,
    cacheMs: 0,
  });
  await expectReject(noToken.discover(), 'token 错误时探测失败');
  await fake.close();
}

console.log('— 插件端到端（假 NapCat） —');
{
  const fake = await makeFakeOneBot({ selfQQ: '111222333', token: 'tok' });
  const configFile = await tempConfig({
    ownerQQ: '999888777',
    selfQQ: '111222333',
    napcat: { endpoints: [fake.base], ports: [], token: 'tok', timeoutMs: 1000, discoveryCacheMs: 60000 },
    windowsNotification: { enabled: false },
    dedupeMs: 60000,
  });

  const handlers = new Map();
  const ctx = {
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
    on: (name, handler) => { handlers.set(name, handler); },
  };
  applyPlugin(ctx, { configFile });
  const handler = handlers.get('approval/request');
  ok(typeof handler === 'function', '插件注册了 approval/request 监听');

  let nextCalls = 0;
  const request = {
    toolName: 'ops_bash',
    reason: 'escalate sandbox to workspace-write: 写测试文件',
    displayReason: { zh: '允许本次操作使用 workspace-write 权限：写测试文件' },
  };
  const outcome = await handler(request, () => { nextCalls += 1; return Promise.resolve('unavailable'); });
  equal(outcome, 'unavailable', '插件把 next() 的结果原样返回');
  equal(nextCalls, 1, '插件调用了 next()');

  const deadline = Date.now() + 3000;
  while (fake.received.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  equal(fake.received.length, 1, '真实审批事件触发一条 QQ 消息');
  equal(fake.received[0]?.user_id, 999888777, '消息发给了配置的主人');
  equal(fake.received[0]?.message?.[0]?.data?.text, '【申请沙箱权限】允许本次操作使用 workspace-write 权限：写测试文件', '端到端消息格式');

  await handler(request, () => Promise.resolve('unavailable'));
  await new Promise((resolve) => setTimeout(resolve, 350));
  equal(fake.received.length, 1, '相同申请在去重窗口内不重复发送');
  await fake.close();
}

console.log('— 真实 NapCat 探测（只读） —');
{
  try {
    const config = await loadConfig('C:\\Users\\ASUS\\.dsh\\qq-approval-notify.json');
    const client = new OneBotClient({ ...config.napcat, selfQQ: config.selfQQ });
    const endpoint = await client.discover(true);
    ok(true, `找到登录为 ${config.selfQQ} 的 NapCat：${endpoint}`);
    if (process.env.DSH_QQ_LIVE_SEND === '1') {
      const result = await client.sendPrivate(
        config.ownerQQ,
        '【申请测试权限】QQ 权限通知插件自检，收到说明通道正常，无需处理。',
      );
      ok(result.messageId !== undefined || result.endpoint !== '', `已向主人 ${config.ownerQQ} 发送自检消息`, JSON.stringify(result));
    } else {
      console.log('skip 真实发送（设置 DSH_QQ_LIVE_SEND=1 可发送一条自检消息）');
    }
  } catch (error) {
    if (error instanceof NapCatUnavailableError) {
      failed += 1;
      console.error(`FAIL 真实 NapCat 探测\n     ${error.message}`);
    } else {
      failed += 1;
      console.error(`FAIL 真实 NapCat 探测\n     ${error.stack ?? error.message}`);
    }
  }
}

console.log('— Windows 通知 —');
{
  const result = await showWindowsNotification({
    title: 'DSH 权限通知插件',
    body: '【申请测试权限】Windows 通知自检，无需处理。',
    timeoutMs: 15000,
  });
  if (!result.ok && /EPERM|sandbox|denied/i.test(String(result.detail))) {
    console.log(`skip Windows 通知（当前沙箱不允许启动 PowerShell：${result.detail}）`);
  } else {
    ok(result.ok, `Windows 通知可用（${result.via}）`, result.detail);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
