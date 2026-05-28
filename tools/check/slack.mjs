// Smoke-test the Slack bot token. Calls auth.test and reports the
// team / bot identity. If only SLACK_WEBHOOK_URL is set (no bot token),
// reports webhook-only mode (acceptable but limited).

import { loadDotEnv, ok, fail, withTimeout, jprint } from './common.mjs';

loadDotEnv();

export async function checkSlack() {
  const token = process.env.SLACK_BOT_TOKEN;
  const webhook = process.env.SLACK_WEBHOOK_URL;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;

  if (!token && !webhook) {
    return fail('slack', 'neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL set (Slack surface optional)');
  }

  if (token) {
    if (!token.startsWith('xoxb-')) {
      return fail('slack', 'SLACK_BOT_TOKEN does not look right (expected xoxb- prefix)');
    }
    const started = Date.now();
    try {
      const res = await withTimeout(
        fetch('https://slack.com/api/auth.test', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        }),
        10000,
        'slack',
      );
      const data = await res.json();
      const latencyMs = Date.now() - started;
      if (!data.ok) return fail('slack', `auth.test failed: ${data.error}`);
      const detail = `team: ${data.team ?? '?'}, bot: ${data.user ?? '?'}` + (signingSecret ? '' : ', SIGNING_SECRET not set (endpoint soft-mode)');
      return ok('slack', detail, latencyMs);
    } catch (err) {
      return fail('slack', err);
    }
  }

  // Webhook-only mode is acceptable but limited (no thread replies).
  return ok('slack', 'webhook-only mode (no thread support; bot token recommended)');
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('slack.mjs')) {
  const result = await checkSlack();
  jprint(result);
  process.exit(result.ok ? 0 : 1);
}
