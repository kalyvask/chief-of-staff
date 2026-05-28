// Smoke-test SMTP. Opens a connection, EHLO, AUTH, then QUIT. Does not
// send any email. Confirms the credentials, the host, and TLS work, which
// is what send-to-self.mjs needs.

import nodemailer from 'nodemailer';
import { loadDotEnv, ok, fail, withTimeout, jprint } from './common.mjs';

loadDotEnv();

function readCfg() {
  const env = process.env;
  return {
    host: env.SMTP_HOST || env.ROLE_RADAR_SMTP_HOST,
    port: parseInt(env.SMTP_PORT || env.ROLE_RADAR_SMTP_PORT || '587', 10),
    username: env.SMTP_USERNAME || env.ROLE_RADAR_SMTP_USERNAME,
    password: env.SMTP_PASSWORD || env.ROLE_RADAR_SMTP_PASSWORD,
    from: env.SMTP_FROM || env.ROLE_RADAR_EMAIL_FROM || env.SELF_EMAIL,
    selfEmail: env.SELF_EMAIL,
  };
}

export async function checkSmtp() {
  const cfg = readCfg();
  const missing = [];
  if (!cfg.selfEmail) missing.push('SELF_EMAIL');
  if (!cfg.host) missing.push('SMTP_HOST');
  if (!cfg.username) missing.push('SMTP_USERNAME');
  if (!cfg.password) missing.push('SMTP_PASSWORD');
  if (missing.length) return fail('smtp', `missing env vars: ${missing.join(', ')}`);

  const started = Date.now();
  const transport = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.username, pass: cfg.password },
  });
  try {
    await withTimeout(transport.verify(), 10000, 'smtp');
    const latencyMs = Date.now() - started;
    return ok('smtp', `connected to ${cfg.host}:${cfg.port} as ${cfg.username}`, latencyMs);
  } catch (err) {
    return fail('smtp', err);
  } finally {
    transport.close?.();
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('smtp.mjs')) {
  const result = await checkSmtp();
  jprint(result);
  process.exit(result.ok ? 0 : 1);
}
