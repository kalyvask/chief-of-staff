#!/usr/bin/env node
// Send a drafted email to yourself via SMTP. Used by the email-drafter subagent
// so that drafts land in your own inbox rather than requiring Gmail OAuth write scopes.
//
// Reads SMTP credentials from one of two .env files, in this order:
//   1. ./.env in this directory (preferred)
//   2. ../role-radar/.env (fallback, since role-radar already has Gmail SMTP wired)
//
// Required env vars (any one set is enough):
//   SMTP_HOST,           SMTP_PORT,           SMTP_USERNAME,           SMTP_PASSWORD,           SMTP_FROM
//   ROLE_RADAR_SMTP_HOST, ROLE_RADAR_SMTP_PORT, ROLE_RADAR_SMTP_USERNAME, ROLE_RADAR_SMTP_PASSWORD, ROLE_RADAR_EMAIL_FROM
// And:
//   SELF_EMAIL  (the only address this script is allowed to send to)
//
// CLI:
//   node send-to-self.mjs --subject "..." --intended-to "..." --body "..."
//   or pipe a JSON payload on stdin:
//   echo '{"subject":"...","intendedTo":"...","body":"...","threadRef":"..."}' | node send-to-self.mjs

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import nodemailer from 'nodemailer';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, 'utf8');
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) out[key] = val;
  }
  return out;
}

const localEnv = loadEnvFile(path.join(__dirname, '.env'));
const roleRadarEnv = loadEnvFile(path.resolve(__dirname, '..', 'role-radar', '.env'));
const env = { ...roleRadarEnv, ...localEnv, ...process.env };

const cfg = {
  host:     env.SMTP_HOST     || env.ROLE_RADAR_SMTP_HOST,
  port:     parseInt(env.SMTP_PORT || env.ROLE_RADAR_SMTP_PORT || '587', 10),
  username: env.SMTP_USERNAME || env.ROLE_RADAR_SMTP_USERNAME,
  password: env.SMTP_PASSWORD || env.ROLE_RADAR_SMTP_PASSWORD,
  from:     env.SMTP_FROM     || env.ROLE_RADAR_EMAIL_FROM || env.SELF_EMAIL,
  selfEmail: env.SELF_EMAIL,
};

function fail(msg) {
  console.error(`send-to-self: ${msg}`);
  process.exit(2);
}

if (!cfg.selfEmail)          fail('SELF_EMAIL is not set. Add it to .env.');
if (!cfg.host || !cfg.port)  fail('SMTP host or port missing. Set SMTP_HOST/SMTP_PORT or ROLE_RADAR_SMTP_HOST/_PORT.');
if (!cfg.username)           fail('SMTP_USERNAME (or ROLE_RADAR_SMTP_USERNAME) is not set.');
if (!cfg.password)           fail('SMTP_PASSWORD (or ROLE_RADAR_SMTP_PASSWORD) is not set.');
if (!cfg.from)               fail('SMTP_FROM (or ROLE_RADAR_EMAIL_FROM) is not set.');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1];
      out[key] = val;
      i++;
    }
  }
  return out;
}

async function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    if (process.stdin.isTTY) return resolve('');
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
  });
}

const args = parseArgs(process.argv);
const stdinText = await readStdin();
let payload;

if (stdinText.trim()) {
  try {
    payload = JSON.parse(stdinText);
  } catch (e) {
    fail(`stdin was not valid JSON: ${e.message}`);
  }
} else {
  payload = {
    subject:     args.subject     || args.s || '',
    body:        args.body        || args.b || '',
    intendedTo:  args['intended-to'] || args.to || '',
    threadRef:   args['thread-ref']  || '',
  };
}

if (!payload.subject || !payload.body) fail('subject and body are required.');

const lockedTo = cfg.selfEmail;
const subject = `[CoS Draft] ${payload.subject}`;
const bodyText = [
  payload.intendedTo ? `Intended recipient: ${payload.intendedTo}` : null,
  payload.threadRef  ? `Thread reference:   ${payload.threadRef}`  : null,
  '',
  '----- Drafted reply below this line -----',
  '',
  payload.body,
].filter((line) => line !== null).join('\n');

const transport = nodemailer.createTransport({
  host: cfg.host,
  port: cfg.port,
  secure: cfg.port === 465,
  auth: { user: cfg.username, pass: cfg.password },
});

try {
  const info = await transport.sendMail({
    from: cfg.from,
    to: lockedTo,
    subject,
    text: bodyText,
  });
  console.log(JSON.stringify({ ok: true, messageId: info.messageId, to: lockedTo, subject }));
} catch (err) {
  fail(`send failed: ${err.message}`);
}
