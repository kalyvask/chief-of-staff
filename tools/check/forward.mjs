// Smoke-test the forwarding-address inbound channel. Verifies that:
//   1. FORWARD_SECRET is set (otherwise the endpoint runs in soft mode)
//   2. The /api/forward endpoint is reachable on the local server
//   3. A test payload with the secret produces a queue item
//   4. The same payload without the secret is rejected
//
// Expects the server to be running on http://localhost:3030 (or
// process.env.COS_BASE_URL). Skips if the server is not reachable.

import { loadDotEnv, ok, fail, withTimeout, jprint } from './common.mjs';
import { getItem } from '../queue.mjs';

loadDotEnv();

const BASE = process.env.COS_BASE_URL || 'http://localhost:3030';

export async function checkForward() {
  const secret = process.env.FORWARD_SECRET;
  if (!secret) {
    return ok('forward', 'FORWARD_SECRET not set (soft mode; only safe locally)');
  }

  // Reachability.
  try {
    await withTimeout(fetch(`${BASE}/api/queue`), 3000, 'forward reachability');
  } catch (err) {
    return fail('forward', `server not reachable at ${BASE}`, err.message);
  }

  // Reject without secret.
  let rejected;
  try {
    const res = await fetch(`${BASE}/api/forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: 'test', subject: 'check', body: 'check' }),
    });
    rejected = res.status === 401;
  } catch (err) {
    return fail('forward', 'unable to test rejection path', err.message);
  }
  if (!rejected) return fail('forward', 'endpoint accepted a request without the secret');

  // Accept with secret + clean up.
  let payload;
  try {
    const res = await fetch(`${BASE}/api/forward`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forward-secret': secret },
      body: JSON.stringify({
        from: 'forward-check@local',
        subject: 'check: forward smoke test',
        body: 'forward smoke test body',
        message_id: `<forward-check-${Date.now()}@local>`,
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return fail('forward', `endpoint returned ${res.status}`, text.slice(0, 200));
    }
    payload = await res.json();
  } catch (err) {
    return fail('forward', err);
  }

  // Verify the item landed in the queue.
  if (!payload?.item?.id) return fail('forward', 'response missing item.id');
  const item = getItem(payload.item.id);
  if (!item) return fail('forward', 'item not found in queue.jsonl after POST');

  return ok('forward', `endpoint reachable, secret enforced, item ${payload.item.id} created`, null);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('forward.mjs')) {
  const result = await checkForward();
  jprint(result);
  process.exit(result.ok ? 0 : 1);
}
