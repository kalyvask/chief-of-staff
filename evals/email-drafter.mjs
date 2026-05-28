#!/usr/bin/env node
// chief-of-staff: email-drafter eval.
//
// Tests the drafting quality of the email-drafter subagent on a fixed set of
// inbound-thread + context fixtures. For each fixture, calls Claude with a
// stripped-down drafter system prompt, then grades the produced draft on a
// set of deterministic properties:
//
//   - Conform pass: checkEmailDraft() returns no high-severity violations
//   - Sources footer present (when provenance supplied)
//   - Each fact in expected.must_cite_facts appears in the body
//   - Recipient pattern in expected.must_address_recipient appears
//   - None of expected.must_not_contain appears
//   - Each placeholder in expected.must_have_placeholders appears (bracketed)
//
// Per-fixture pass = all checks pass. Overall pass rate must be >= threshold
// (default 0.80) or exit 1.
//
// Requires ANTHROPIC_API_KEY. Skipped gracefully when not set.
//
// Usage:
//   node evals/email-drafter.mjs
//   node evals/email-drafter.mjs --model claude-sonnet-4-6
//   node evals/email-drafter.mjs --threshold 0.85
//   node evals/email-drafter.mjs --json
//   npm run eval:drafter

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEmailDraft } from '../tools/conform.mjs';
import { tracedFetch } from '../tools/telemetry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures', 'email-drafter.jsonl');

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
  const skip = { skipped: true, reason: 'ANTHROPIC_API_KEY not set' };
  if (asJson) console.log(JSON.stringify(skip));
  else console.log('email-drafter: skipped (ANTHROPIC_API_KEY not set)');
  process.exit(0);
}

if (!fs.existsSync(FIXTURES)) {
  console.error(`email-drafter: fixtures missing at ${FIXTURES}`);
  process.exit(1);
}

const fixtures = fs
  .readFileSync(FIXTURES, 'utf-8')
  .split('\n')
  .filter((l) => l.trim().length > 0)
  .map((l) => JSON.parse(l));

const SYSTEM = `You are drafting a reply email for Alex Kalyvas. Your output will be audited by a deterministic conformance checker. Produce ONLY the email body. No greetings to me ("Here's a draft"). No commentary. Just the body.

VOICE RULES (hard, audited by tools/conform.mjs):
- Never use em dashes. Use commas, periods, parentheses, or restructure the sentence.
- Never use AI tells: "delve", "navigate the landscape", "unlock", "leverage" as a verb when "use" works, "in the world of", "not just X also Y".
- Never use flattery: no "great question", "happy to help", "thanks for the great email", "I hope this finds you well", "just wanted to circle back".
- First-person Alex voice. Direct. Tight. Match the formality of the sender's last message.

CONTENT RULES (hard):
- Never invent facts, numbers, dates, prices, or commitments that are not in the provided context.
- If you need information you do not have, leave a [placeholder in square brackets] in the body.
- If you used any placeholders, append a separate final line starting with "PLACEHOLDERS:" listing each one.

OUTPUT FORMAT:
- Body of the email
- Blank line
- "Sources:" line
- One bullet per provenance ref in the format "- <type>:<ref> [queue:<queue_id>]"
- (Optional) "PLACEHOLDERS:" line listing bracketed items

Output the draft now.`;

async function draftReply(input, ctx = {}) {
  const userMessage = [
    'CONTEXT FOR DRAFTING',
    '',
    `Queue item id: ${input.queue_item.id}`,
    `Queue item summary: ${input.queue_item.summary}`,
    `Bucket: ${input.queue_item.bucket}`,
    `Provenance: ${JSON.stringify(input.queue_item.provenance)}`,
    '',
    'INBOUND THREAD (most recent at bottom):',
    input.thread,
    '',
    'STAKEHOLDER ENTRY:',
    input.stakeholder_entry || '(no entry on file)',
    '',
    'RECENT RELATIONSHIP NOTES:',
    input.relationship_notes || '(no notes)',
    '',
    'Draft the reply body now. Append the Sources: footer and any PLACEHOLDERS: line.',
  ].join('\n');
  const resp = await tracedFetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 800,
      system: SYSTEM,
      messages: [{ role: 'user', content: userMessage }],
    }),
  }, ctx);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`API ${resp.status}: ${JSON.stringify(data).slice(0, 200)}`);
  const text = data.content?.[0]?.text ?? '';
  return text;
}

function grade(draft, expected, queue_item) {
  const checks = [];

  // 1. Conform pass (no high-severity violations)
  const conformResult = checkEmailDraft(draft, { item: queue_item, skipAudit: true });
  const highSev = conformResult.violations.filter((v) => v.severity === 'high');
  checks.push({
    name: 'conform.no-high-severity',
    ok: highSev.length === 0,
    detail: highSev.length ? highSev.map((v) => v.rule).join(', ') : null,
  });

  // 2. Sources footer present (when provenance supplied)
  if (expected.must_have_sources_footer !== false) {
    const hasSources = /\bSources:\s*\n/i.test(draft) || /\nSources:\s*$/i.test(draft) || /\nSources:\s/i.test(draft);
    checks.push({
      name: 'sources-footer',
      ok: hasSources,
      detail: hasSources ? null : 'missing "Sources:" block',
    });
  }

  // 3. Must-cite facts
  for (const fact of expected.must_cite_facts ?? []) {
    const present = draft.toLowerCase().includes(fact.toLowerCase());
    checks.push({
      name: `must-cite[${fact.slice(0, 30)}]`,
      ok: present,
      detail: present ? null : `missing required fact`,
    });
  }

  // 4. Must address recipient (regex)
  if (expected.must_address_recipient) {
    const re = new RegExp(expected.must_address_recipient, 'i');
    const ok = re.test(draft);
    checks.push({
      name: `addresses-recipient[/${expected.must_address_recipient}/]`,
      ok,
      detail: ok ? null : 'recipient pattern not found',
    });
  }

  // 5. Must NOT contain (e.g. hallucinated commitments)
  for (const banned of expected.must_not_contain ?? []) {
    const present = new RegExp(banned, 'i').test(draft);
    checks.push({
      name: `must-not[${banned.slice(0, 30)}]`,
      ok: !present,
      detail: present ? `contains banned pattern: ${banned}` : null,
    });
  }

  // 6. Must have placeholders (square-bracket pattern)
  for (const placeholder of expected.must_have_placeholders ?? []) {
    const re = new RegExp(`\\[[^\\]]*${placeholder}[^\\]]*\\]`, 'i');
    const ok = re.test(draft);
    checks.push({
      name: `placeholder[${placeholder.slice(0, 30)}]`,
      ok,
      detail: ok ? null : `missing bracketed placeholder for: ${placeholder}`,
    });
  }

  const allOk = checks.every((c) => c.ok);
  return { ok: allOk, checks, conformViolations: conformResult.violations };
}

const results = [];
for (const fix of fixtures) {
  try {
    const draft = await draftReply(fix.input, {
      command: 'eval:drafter',
      actor: 'email-drafter',
      fixture: fix.id,
    });
    const graded = grade(draft, fix.expected, fix.input.queue_item);
    results.push({
      id: fix.id,
      ok: graded.ok,
      draft_excerpt: draft.slice(0, 200),
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
    const mark = r.ok ? 'ok  ' : 'FAIL';
    if (r.ok) {
      console.log(`${mark}  ${r.id}  (${r.checks.length} checks)`);
    } else if (r.error) {
      console.log(`${mark}  ${r.id}  ERROR: ${r.error}`);
    } else {
      const fails = r.checks.filter((c) => !c.ok);
      console.log(`${mark}  ${r.id}  ${fails.length}/${r.checks.length} checks failed`);
      for (const c of fails) {
        console.log(`        - ${c.name}: ${c.detail ?? '(no detail)'}`);
      }
    }
  }
  console.log('');
  console.log(
    `email-drafter: ${passed}/${results.length} passed (${(rate * 100).toFixed(0)}%), threshold ${(THRESHOLD * 100).toFixed(0)}%, model ${MODEL}`,
  );
}

process.exit(rate >= THRESHOLD ? 0 : 1);
