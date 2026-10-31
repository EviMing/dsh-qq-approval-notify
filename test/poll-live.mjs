// Polls NapCat history for a fresh notification message sent by the bot.
// Used only for the live end-to-end check of qq-approval-notify.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const configPath = 'C:/Users/ASUS/.dsh/qq-approval-notify.json';
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const base = config.napcat.endpoints[0];
const token = config.napcat.token;
const owner = String(config.ownerQQ);

const logPath = resolve(import.meta.dirname, '../dist/live-check.log');
mkdirSync(dirname(logPath), { recursive: true });

const startedAt = Math.floor(Date.now() / 1000);
const seen = new Set();
const deadline = Date.now() + 600_000;

async function history() {
  const response = await fetch(`${base}/get_friend_msg_history`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ user_id: owner, count: 20 }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  return body?.data?.messages ?? [];
}

while (Date.now() < deadline) {
  try {
    for (const message of await history()) {
      const text = typeof message.raw_message === 'string' ? message.raw_message : '';
      if (!text.includes('【申请') && !text.includes('【需要你回答')) continue;
      if (typeof message.time === 'number' && message.time < startedAt - 10) continue;
      if (seen.has(message.message_id)) continue;
      seen.add(message.message_id);
      const line = `${new Date().toISOString()}\t${message.message_id}\t${text}\n`;
      appendFileSync(logPath, line, 'utf8');
      console.log(`FOUND ${message.message_id}\t${text}`);
      process.exit(0);
    }
  } catch (error) {
    console.error(`poll error: ${error.message}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

console.log('TIMEOUT no fresh notification message');
process.exit(3);
