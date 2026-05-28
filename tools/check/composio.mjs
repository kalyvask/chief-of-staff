// Smoke-test Composio: API key valid, lists toolkits, reports which
// Composio-managed Gmail/Calendar connections are active for the user.
// Soft-pass if COMPOSIO_API_KEY is not set (Composio is optional).

import { Composio } from '@composio/core';
import { loadDotEnv, ok, fail, withTimeout, jprint } from './common.mjs';

loadDotEnv();

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function deriveUserId() {
  if (process.env.COMPOSIO_USER_ID) return process.env.COMPOSIO_USER_ID;
  if (process.env.SELF_EMAIL) return slugify(process.env.SELF_EMAIL);
  return 'cos-user';
}

export async function checkComposio() {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) return ok('composio', 'COMPOSIO_API_KEY not set (managed MCP path optional)');

  const started = Date.now();
  const composio = new Composio({ apiKey: key });
  const userId = deriveUserId();

  try {
    const items = (await withTimeout(
      composio.connectedAccounts.list({ userIds: [userId], limit: 50 }),
      10000,
      'composio',
    ))?.items ?? [];
    const gmail = items.find((c) => (c.toolkit?.slug || c.toolkit || '').toLowerCase() === 'gmail');
    const cal = items.find((c) => (c.toolkit?.slug || c.toolkit || '').toLowerCase() === 'googlecalendar');
    const gmailOk = gmail && ['ACTIVE', 'CONNECTED'].includes((gmail.status || '').toUpperCase());
    const calOk = cal && ['ACTIVE', 'CONNECTED'].includes((cal.status || '').toUpperCase());
    const latencyMs = Date.now() - started;

    if (gmailOk && calOk) {
      return ok('composio', `connected as ${userId}: gmail ok, googlecalendar ok`, latencyMs);
    }
    const missing = [];
    if (!gmailOk) missing.push('gmail');
    if (!calOk) missing.push('googlecalendar');
    return {
      ok: false,
      service: 'composio',
      error: `not connected: ${missing.join(', ')}. Run: node tools/composio-connect.mjs`,
      detail: `userId=${userId}`,
      latencyMs,
    };
  } catch (err) {
    return fail('composio', err);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('composio.mjs')) {
  const result = await checkComposio();
  jprint(result);
  process.exit(result.ok ? 0 : 1);
}
