#!/usr/bin/env node
// Chief of Staff: eval harness.
//
// Regression suite for the deterministic substrate: conformance rules,
// permission engine, queue lifecycle, graph ingestion. Each case is a small
// synchronous fixture with explicit expectations. The harness exits 0 if all
// pass, 1 if any fail. Prints a one-line summary plus per-case detail on
// failures.
//
// Scope today: pure-function tests on the deterministic pieces. Agent-driven
// tests (triage classification, draft quality) need the Anthropic SDK and an
// API key; scaffolded as TODOs but not run.
//
// Usage:
//   node evals/run.mjs                      # run all
//   node evals/run.mjs --only conform       # filter by suite name
//   node evals/run.mjs --json               # machine-readable output

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { audit, summarize, checkVoice, checkEmailDraft } from '../tools/conform.mjs';
import { permit } from '../tools/permit.mjs';
import { addItem, updateItem, undoItem, loadHistory, closeItem, getItem, loadOpen, compact } from '../tools/queue.mjs';
import { buildIndex, search } from '../tools/retrieval.mjs';
import { buildPrompt, parseAnswer } from '../tools/think.mjs';
import { extractFromText, extractFromEntity } from '../tools/entities.mjs';
import { findContradictions, summarize as summarizeContradictions } from '../tools/contradictions.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.resolve(REPO_ROOT, 'data', 'queue.jsonl');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const results = [];
function record(suite, name, ok, detail) {
  results.push({ suite, name, ok, detail });
}

function assertEq(suite, name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(suite, name, ok, ok ? null : { actual, expected });
}

function assertTruthy(suite, name, value, detail = null) {
  record(suite, name, !!value, value ? null : (detail ?? { value }));
}

// --- Conformance suite ----------------------------------------------------
function suiteConform() {
  // Clean email passes.
  {
    const r = checkEmailDraft("Peter, Tuesday 3pm works. I will bring the v2 outline.", { skipAudit: true });
    assertEq('conform', 'clean email passes', r.ok, true);
  }
  // Polluted email catches every category.
  {
    const r = checkEmailDraft(
      "Hope this finds you well. Just wanted to leverage our synergy to unlock the next phase. Great question.",
      { skipAudit: true },
    );
    assertEq('conform', 'polluted email fails', r.ok, false);
    const ruleHits = r.violations.map((v) => v.rule);
    assertTruthy('conform', 'polluted email has voice.ai-tell', ruleHits.includes('voice.ai-tell'));
    assertTruthy('conform', 'polluted email has voice.flattery', ruleHits.includes('voice.flattery'));
    assertTruthy('conform', 'polluted email has email.banned-phrase', ruleHits.includes('email.banned-phrase'));
  }
  // Em dash detected.
  {
    const r = checkVoice("We decide quickly — the deadline is Friday.");
    assertEq('conform', 'em dash detected', r.ok, false);
    assertTruthy(
      'conform',
      'em dash rule labeled',
      r.violations.some((v) => v.rule === 'voice.em-dash'),
    );
  }
  // Sources footer missing when provenance present.
  {
    const r = checkEmailDraft("Reply text without a sources block.", {
      item: { id: 'q_test', provenance: [{ type: 'gmail.thread', ref: 'abc' }] },
      skipAudit: true,
    });
    assertTruthy(
      'conform',
      'missing sources footer flagged',
      r.violations.some((v) => v.rule === 'email.sources-footer'),
    );
  }
  // Sources footer present passes that check.
  {
    const r = checkEmailDraft(
      "Reply text.\n\nSources:\n- gmail.thread:abc [queue:q_test]",
      {
        item: { id: 'q_test', provenance: [{ type: 'gmail.thread', ref: 'abc' }] },
        skipAudit: true,
      },
    );
    assertTruthy(
      'conform',
      'sources footer present not flagged',
      !r.violations.some((v) => v.rule === 'email.sources-footer'),
    );
  }
  // summarize() classifies counts correctly.
  {
    const r = audit('voice', "leverage", { skipAudit: true });
    const sum = summarize(r.violations);
    assertTruthy('conform', 'summarize counts non-empty', sum.summary.includes('violation'));
  }
}

// --- Permit suite ---------------------------------------------------------
function suitePermit() {
  // T0 action always allowed at default tier.
  {
    const r = permit({ action: 'queue.add', actor: 'chief-of-staff', dryRun: true });
    assertEq('permit', 'T0 queue.add allowed', r.allowed, true);
  }
  // T1 action denied at default tier 0.
  {
    const r = permit({ action: 'email.archive', actor: 'chief-of-staff', dryRun: true });
    assertEq('permit', 'T1 email.archive denied at T0', r.allowed, false);
  }
  // Routine mode read-only caps effective tier.
  {
    const r = permit({ action: 'email.archive', actor: 'user', routineMode: 'read-only', dryRun: true });
    assertEq('permit', 'read-only caps user (T3) for T1 action', r.allowed, false);
  }
  // approval-required gate fires for T2 without itemId.
  {
    const r = permit({ action: 'email.send-ack', actor: 'user', routineMode: 'approval-required', dryRun: true });
    assertEq('permit', 'approval-required denies T2 without itemId', r.allowed, false);
  }
  // T3 always requires itemId.
  {
    const r = permit({ action: 'email.send-external', actor: 'user', dryRun: true });
    assertEq('permit', 'T3 denied without itemId', r.allowed, false);
  }
  // Unknown action denied.
  {
    const r = permit({ action: 'made.up.action', actor: 'user', dryRun: true });
    assertEq('permit', 'unknown action denied', r.allowed, false);
  }
  // Unknown routine mode denied.
  {
    const r = permit({ action: 'queue.add', actor: 'user', routineMode: 'turbo', dryRun: true });
    assertEq('permit', 'unknown routine mode denied', r.allowed, false);
  }
}

// --- Queue suite ----------------------------------------------------------
// Uses real queue.jsonl. Items it creates are closed and compacted at the end
// so we leave the file in roughly the state we found it.
function suiteQueue() {
  const created = [];
  try {
    // add + show.
    const a = addItem(
      { bucket: 'Yours', priority: 'high', summary: 'eval queue test', source: 'eval', provenance: [{ type: 'eval.test', ref: 'a' }] },
      { actor: 'eval' },
    );
    created.push(a.id);
    assertEq('queue', 'add returns id', !!a.id, true);
    assertEq('queue', 'getItem returns same', getItem(a.id)?.id, a.id);

    // update.
    const u = updateItem(a.id, { bucket: 'Prep', priority: 'low' }, { actor: 'eval' });
    assertEq('queue', 'update changes bucket', u.bucket, 'Prep');
    assertEq('queue', 'update appends audit', u.audit.length > a.audit.length, true);

    // undo.
    const restored = undoItem(a.id, { actor: 'eval' });
    assertEq('queue', 'undo restores bucket', restored.bucket, 'Yours');
    assertEq('queue', 'undo restores priority', restored.priority, 'high');

    // history.
    const hist = loadHistory(a.id);
    assertTruthy('queue', 'history has at least 3 snapshots', hist.length >= 3);

    // close.
    const c = closeItem(a.id, 'eval done', { actor: 'eval' });
    assertEq('queue', 'close sets status done', c.status, 'done');

    // loadOpen excludes closed.
    const open = loadOpen();
    assertEq('queue', 'closed item not in loadOpen', open.some((i) => i.id === a.id), false);
  } finally {
    for (const id of created) {
      try { closeItem(id, 'eval cleanup', { actor: 'eval' }); } catch {}
    }
    try { compact(); } catch {}
  }
}

// --- Graph suite ----------------------------------------------------------
// Verifies the graph file produced by tools/build-graph.mjs has the expected
// top-level shape. Does not regenerate; tests the contract of whatever the
// latest build left behind.
function suiteGraph() {
  const graphPath = path.resolve(REPO_ROOT, 'data', 'graph.json');
  if (!fs.existsSync(graphPath)) {
    record('graph', 'graph.json present', false, { detail: `${graphPath} not found; run: node tools/build-graph.mjs` });
    return;
  }
  const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  for (const key of ['stakeholders', 'relationships', 'decisions', 'priorities', 'projects', 'queue_items', 'edges', 'stats']) {
    assertTruthy('graph', `top-level key ${key} present`, key in g);
  }
  for (const stat of ['stakeholder_count', 'queue_item_count', 'edge_count', 'open_queue_count']) {
    assertTruthy('graph', `stat ${stat} present`, stat in (g.stats ?? {}));
  }
  // Every edge has a type and a from field.
  const malformed = (g.edges ?? []).filter((e) => !e.type || !e.from);
  assertEq('graph', 'all edges have type + from', malformed.length, 0);
}

// --- Retrieval suite -----------------------------------------------------
// Builds a tiny in-memory index over a fixed corpus root (the repo's own
// docs/ directory) and asserts BM25 returns sensible top hits. Does not
// touch the persisted data/retrieval-index.json so this test is hermetic.
async function suiteRetrieval() {
  const repoDocs = path.resolve(REPO_ROOT, 'docs');
  if (!fs.existsSync(repoDocs)) {
    record('retrieval', 'docs/ root present', false, { detail: 'docs/ not found' });
    return;
  }
  const index = await buildIndex({ roots: ['docs'], includeLogs: false, embed: false });
  assertTruthy('retrieval', 'index has chunks', index.stats.chunk_count > 0);
  assertTruthy('retrieval', 'BM25 vocab non-empty', index.stats.vocab_size > 0);
  // Pick a term that should exist in the docs (the words "queue" and "graph"
  // appear in docs/architecture.md and the sample outputs).
  const hits = await search(index, 'queue', { topK: 3, useVector: false });
  assertTruthy('retrieval', 'search returns hits for "queue"', hits.length > 0);
  if (hits.length > 0) {
    assertTruthy('retrieval', 'top hit has chunk.path', !!hits[0].chunk?.path);
    assertTruthy('retrieval', 'top hit score positive', hits[0].score > 0);
  }
}

// --- Think suite (pure prompt-builder + parser) --------------------------
// The end-to-end think() call needs ANTHROPIC_API_KEY; not exercised here.
// We test the deterministic pieces: prompt assembly and answer parsing.
function suiteThink() {
  const fakeHits = [
    {
      chunk: { path: 'context/stakeholders.md', heading: 'Anthropic', line_start: 39, text: 'Active interview prep.' },
      score: 0.1, signals: {},
    },
    {
      chunk: { path: 'memory/decisions.md', heading: null, line_start: 12, text: 'Decided to focus on Anthropic.' },
      score: 0.09, signals: {},
    },
  ];
  const prompt = buildPrompt('What is on my plate?', fakeHits);
  assertTruthy('think', 'system prompt contains rules', /Never invent facts/.test(prompt.system));
  assertTruthy('think', 'user prompt contains passages', /Active interview prep/.test(prompt.user));
  assertTruthy('think', 'user prompt cites line numbers', /context\/stakeholders\.md:39/.test(prompt.user));

  const fakeAnswer = `The plate is full. [context/stakeholders.md:39] Anthropic is active.

Sources:
- [context/stakeholders.md:39] confirms active prep
- [memory/decisions.md:12] gives the focus call

Gaps:
- no recent decision on tradeoff with Stripe path
`;
  const parsed = parseAnswer(fakeAnswer);
  assertTruthy('think', 'parses answer body', /plate is full/.test(parsed.answer));
  assertEq('think', 'parses two sources', parsed.sources.length, 2);
  assertEq('think', 'parses one gap', parsed.gaps.length, 1);
  assertEq('think', 'source ref is full path:line', parsed.sources[0].ref, 'context/stakeholders.md:39');
}

// --- Entities suite -----------------------------------------------------
function suiteEntities() {
  // Relation verbs map to typed edges with normalized targets.
  {
    const e = extractFromText('PM at Snowflake on the data clean room');
    const worksAt = e.find((x) => x.type === 'works_at');
    assertTruthy('entities', 'works_at fires on PM at X', !!worksAt);
    assertEq('entities', 'works_at target slug', worksAt?.to, 'snowflake');
  }
  {
    const e = extractFromText('co-founded Resolve AI in 2024');
    const founded = e.find((x) => x.type === 'founded');
    assertTruthy('entities', 'founded fires', !!founded);
    assertEq('entities', 'trailing preposition stripped', founded?.to, 'resolve-ai');
  }
  {
    const e = extractFromText('led the seed in Acme');
    assertTruthy('entities', 'invested_in fires', e.some((x) => x.type === 'invested_in'));
  }
  // Common words must not be tagged as companies.
  {
    const e = extractFromText('She is on the team and out of the office');
    assertEq('entities', 'no false positives on "She/out"', e.filter((x) => x.type === 'works_at' || x.type === 'mentions_company').length, 0);
  }
  // Email and URL captured as mentions_*.
  {
    const e = extractFromText('Email me at alex@example.com or see https://example.com/foo');
    assertTruthy('entities', 'email captured', e.some((x) => x.type === 'mentions_email' && x.to === 'alex@example.com'));
    assertTruthy('entities', 'url captured', e.some((x) => x.type === 'mentions_url' && x.to === 'https://example.com/foo'));
  }
  // extractFromEntity walks fields and notes; source_file gets attached.
  {
    const entity = {
      id: 'alex',
      notes: 'PM at Snowflake.',
      fields: { 'Origin': { value: 'Met at Anthropic Inc.', placeholder: false } },
      line: 42,
    };
    const e = extractFromEntity(entity, 'stakeholder');
    assertTruthy('entities', 'extractFromEntity returns edges', e.length > 0);
    assertTruthy('entities', 'source_file attached', e.every((x) => x.source_file === 'context/stakeholders.md'));
    assertTruthy('entities', 'from id propagated', e.every((x) => x.from === 'alex'));
  }
}

// --- Contradictions suite ------------------------------------------------
function suiteContradictions() {
  // The findContradictions() function needs a graph file; run it and assert
  // the shape, regardless of whether any contradictions exist today.
  let findings;
  try {
    findings = findContradictions({ today: '2026-05-24' });
  } catch (e) {
    record('contradictions', 'scan runs', false, { detail: e.message });
    return;
  }
  assertTruthy('contradictions', 'scan returns array', Array.isArray(findings));
  for (const f of findings) {
    assertTruthy('contradictions', `finding ${f.rule} has rule/severity/message`,
      !!f.rule && !!f.severity && !!f.message);
  }
  // summarize shape contract.
  const sum = summarizeContradictions(findings);
  assertTruthy('contradictions', 'summarize returns summary string', typeof sum.summary === 'string');
  assertTruthy('contradictions', 'summarize returns counts object', typeof sum.counts === 'object');
}

// --- Run ------------------------------------------------------------------
const args = parseArgs(process.argv);
const filter = args.only;

const suites = [
  ['conform', suiteConform],
  ['permit', suitePermit],
  ['queue', suiteQueue],
  ['graph', suiteGraph],
  ['retrieval', suiteRetrieval],
  ['think', suiteThink],
  ['entities', suiteEntities],
  ['contradictions', suiteContradictions],
];

for (const [name, fn] of suites) {
  if (filter && filter !== name) continue;
  try {
    await fn();
  } catch (e) {
    record(name, '<suite crashed>', false, { error: e.message, stack: e.stack });
  }
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok);

if (args.json) {
  process.stdout.write(JSON.stringify({ total: results.length, passed, failed: failed.length, results }, null, 2) + '\n');
} else {
  for (const r of results) {
    const icon = r.ok ? 'ok  ' : 'FAIL';
    process.stdout.write(`${icon}  ${r.suite}/${r.name}\n`);
    if (!r.ok && r.detail) process.stdout.write(`        ${JSON.stringify(r.detail)}\n`);
  }
  process.stdout.write(`\n${passed}/${results.length} passed`);
  if (failed.length) process.stdout.write(`, ${failed.length} failed`);
  process.stdout.write('\n');
}

process.exit(failed.length ? 1 : 0);
