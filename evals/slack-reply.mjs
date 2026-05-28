#!/usr/bin/env node
// chief-of-staff: slack-reply quality eval.
//
// Tests the LLM-backed Slack DM/mention reply path in server.mjs against
// synthetic Alex-state contexts. Each fixture supplies a context block and a
// user message; the runner calls Anthropic with the same prompt shape as
// production (shared SLACK_REPLY_SYSTEM_BASE) and grades the reply on
// deterministic properties:
//
//   - conform.no-high-severity (em-dashes, AI tells, flattery)
//   - must_cite_queue_ids: each id appears in the reply
//   - must_mention: each substring (stakeholder name, project slug, decision date) appears
//   - must_not_contain: none of these regex/substrings appear (hallucinations, banned phrases)
//   - must_acknowledge_unknown: at least one of these substrings appears (e.g. "I do not have")
//   - must_defer_to_laptop: at least one of these substrings appears
//   - max_chars: reply length is under N characters
//
// Per-fixture pass = all configured checks pass. Overall pass rate must be
// >= threshold (default 0.80) or exit 1.
//
// Requires ANTHROPIC_API_KEY. Skipped gracefully when not set.
//
// Usage:
//   node evals/slack-reply.mjs
//   node evals/slack-reply.mjs --threshold 0.85
//   node evals/slack-reply.mjs --json
//   npm run eval:slack-reply

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVoice } from '../tools/conform.mjs';
import { SLACK_REPLY_SYSTEM_BASE } from '../tools/slack-context.mjs';
import { tracedFetch } from '../tools/telemetry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES = path.join(__dirname, 'fixtures', 'slack-reply.jsonl');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const MODEL = arg('model', 'claude-sonnet-4-6');
const THRESHOLD = parseFloat(arg('threshold', '0.80'));
const asJson = args.includes('--json');

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  if (asJson) console.log(JSON.stringify({ skipped: true, reason: 'ANTHROPIC_API_KEY not set' }));
  else console.log('slack-reply: skipped (ANTHROPIC_API_KEY not set)');
  process.exit(0);
}

if (!fs.existsSync(FIXTURES)) {
  console.error(`slack-reply: fixtures missing at ${FIXTURES}`);
  process.exit(1);
}

const fixtures = fs
  .readFileSync(FIXTURES, 'utf-8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

async function callApi(userMessage, contextBlock, ctx) {
  const system = [
    { type: 'text', text: SLACK_REPLY_SYSTEM_BASE },
    { type: 'text', text: contextBlock, cache_control: { type: 'ephemeral' } },
  ];
  const resp = await tracedFetch(
    'https://api.anthropic.com/v1/messages',
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 500,
        system,
        messages: [{ role: 'user', content: `Source: DM\nUser message: ${userMessage}` }],
      }),
    },
    ctx,
  );
  const data = await resp.json();
  if (!resp.ok) throw new Error(`API ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  return data?.content?.[0]?.text ?? '';
}

function grade(reply, expected) {
  const checks = [];

  // 1. Voice (no high-severity conform violations)
  const conformResult = checkVoice(reply, { skipAudit: true });
  const highSev = conformResult.violations.filter((v) => v.severity === 'high');
  checks.push({
    name: 'conform.voice',
    ok: highSev.length === 0,
    detail: highSev.length ? highSev.map((v) => v.rule).join(', ') : null,
  });

  // 2. Must cite specific queue ids
  for (const id of expected.must_cite_queue_ids ?? []) {
    const present = reply.includes(id);
    checks.push({
      name: `must-cite[${id}]`,
      ok: present,
      detail: present ? null : `missing queue id ${id}`,
    });
  }

  // 3. Must mention specific things (stakeholder names, project slugs, decision dates)
  for (const s of expected.must_mention ?? []) {
    const present = reply.toLowerCase().includes(s.toLowerCase());
    checks.push({
      name: `must-mention[${s.slice(0, 30)}]`,
      ok: present,
      detail: present ? null : `missing required mention`,
    });
  }

  // 4. Must NOT contain (hallucinations, banned phrases)
  for (const banned of expected.must_not_contain ?? []) {
    const re = new RegExp(banned, 'i');
    const present = re.test(reply);
    checks.push({
      name: `must-not[${banned.slice(0, 30)}]`,
      ok: !present,
      detail: present ? `contains banned pattern: ${banned}` : null,
    });
  }

  // 5. Must acknowledge unknown (at least ONE of these substrings appears)
  if (expected.must_acknowledge_unknown && expected.must_acknowledge_unknown.length) {
    const anyPresent = expected.must_acknowledge_unknown.some((s) =>
      reply.toLowerCase().includes(s.toLowerCase()),
    );
    checks.push({
      name: 'must-acknowledge-unknown',
      ok: anyPresent,
      detail: anyPresent ? null : `none of ${JSON.stringify(expected.must_acknowledge_unknown)} appeared`,
    });
  }

  // 6. Must defer to laptop (at least ONE of these substrings appears)
  if (expected.must_defer_to_laptop && expected.must_defer_to_laptop.length) {
    const anyPresent = expected.must_defer_to_laptop.some((s) =>
      reply.toLowerCase().includes(s.toLowerCase()),
    );
    checks.push({
      name: 'must-defer-to-laptop',
      ok: anyPresent,
      detail: anyPresent ? null : `none of ${JSON.stringify(expected.must_defer_to_laptop)} appeared`,
    });
  }

  // 7. Max chars
  if (typeof expected.max_chars === 'number') {
    const ok = reply.length <= expected.max_chars;
    checks.push({
      name: `max-chars[<=${expected.max_chars}]`,
      ok,
      detail: ok ? null : `reply was ${reply.length} chars`,
    });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

const results = [];
for (const fix of fixtures) {
  try {
    const reply = await callApi(fix.input.user_message, fix.input.context_block, {
      command: 'eval:slack-reply',
      actor: 'slack-reply',
      fixture: fix.id,
    });
    const graded = grade(reply, fix.expected);
    results.push({
      id: fix.id,
      ok: graded.ok,
      reply_excerpt: reply.slice(0, 200),
      checks: graded.checks,
    });
  } catch (e) {
    results.push({ id: fix.id, ok: false, error: e.message, checks: [] });
  }
}

const passed = results.filter((r) => r.ok).length;
const rate = results.length ? passed / results.length : 0;

if (asJson) {
  console.log(
    JSON.stringify(
      { model: MODEL, threshold: THRESHOLD, passed, total: results.length, rate, results },
      null,
      2,
    ),
  );
} else {
  for (const r of results) {
    if (r.ok) {
      console.log(`ok    ${r.id}  (${r.checks.length} checks)`);
    } else if (r.error) {
      console.log(`FAIL  ${r.id}  ERROR: ${r.error}`);
    } else {
      const fails = r.checks.filter((c) => !c.ok);
      console.log(`FAIL  ${r.id}  ${fails.length}/${r.checks.length} checks failed`);
      for (const c of fails) console.log(`        - ${c.name}: ${c.detail ?? '(no detail)'}`);
    }
  }
  console.log('');
  console.log(
    `slack-reply: ${passed}/${results.length} passed (${(rate * 100).toFixed(0)}%), threshold ${(THRESHOLD * 100).toFixed(0)}%, model ${MODEL}`,
  );
}

process.exit(rate >= THRESHOLD ? 0 : 1);
