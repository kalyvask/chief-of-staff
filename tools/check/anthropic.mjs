// Smoke-test the Anthropic API key. Sends the smallest possible request
// (1 input token, max_tokens: 1) and reports pass/fail + latency. Costs
// approximately $0.000003 per run.

import { loadDotEnv, ok, fail, withTimeout, jprint } from './common.mjs';

loadDotEnv();

export async function checkAnthropic() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return fail('anthropic', 'ANTHROPIC_API_KEY not set in .env');
  if (!key.startsWith('sk-ant-')) {
    return fail('anthropic', 'ANTHROPIC_API_KEY does not look right (expected sk-ant- prefix)');
  }
  const started = Date.now();
  try {
    const res = await withTimeout(
      fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ok' }],
        }),
      }),
      10000,
      'anthropic',
    );
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return fail('anthropic', `HTTP ${res.status}`, text.slice(0, 200));
    }
    const data = await res.json();
    return ok('anthropic', `model: ${data.model ?? 'unknown'}`, latencyMs);
  } catch (err) {
    return fail('anthropic', err);
  }
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('anthropic.mjs')) {
  const result = await checkAnthropic();
  jprint(result);
  process.exit(result.ok ? 0 : 1);
}
