#!/usr/bin/env node
// Chief of Staff: context budget guard.
//
// A command's quality degrades sharply once the working set it loads fills too
// much of the model's context window -- well before the window is "full". The
// usable ceiling sits around 40% of the window, independent of how large that
// window is. Past it, the agent starts losing the middle of what it read.
//
// This tool measures the token footprint of the files a command pulls (plus an
// --extra-tokens allowance for runtime pulls like calendar or Gmail that are
// not on disk), compares it to that 40% budget, and when over, names the
// largest compressible contributors and the exact command to offload them:
//   - memory/*       -> the weekly digest (npm run digest), not the raw files
//   - context/*      -> just-in-time retrieval (npm run retrieve:search), not whole files
//   - data/queue.md  -> queue-cli list / overdue, not the full dump
//   - logs/*         -> today's only, skip the backlog
//
// It estimates; it does not tokenize exactly. The point is a guardrail that is
// cheap to run in a command preflight, the same way /am-sweep runs freshness.
//
// Public API:
//   estimateTokens(chars, charsPerToken?)        -> integer
//   buildReport({entries, extraTokens, window, threshold}) -> report
//   measurePreset(name, {extraTokens, ...})      -> report   (reads real files)
//
// CLI:
//   node tools/context-budget.mjs check --files CLAUDE.md,memory/relationships.md [--extra-tokens 4000]
//   node tools/context-budget.mjs preset am-sweep [--extra-tokens 6000]
//   node tools/context-budget.mjs presets
//   node tools/context-budget.mjs self-test
//
// Exit codes for check/preset: 0 = ok or warn (proceed), 2 = over budget (offload first).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Defaults. Claude's window is ~200k tokens; the usable budget is 40% of it.
const DEFAULT_WINDOW = 200000;
const DEFAULT_THRESHOLD = 0.40;
const DEFAULT_CHARS_PER_TOKEN = 4;
// Approaching band: warn (not block) once within this fraction of the budget.
const WARN_AT = 0.9;

// Working sets per command, mirroring what each command's instructions load.
// A ":latest" suffix on a glob keeps only the most recent match (lexical sort,
// which matches our dated / ISO-week filenames).
const PRESETS = {
  'am-sweep': [
    'CLAUDE.md',
    'memory/digest-*.md:latest',
    'data/queue.md',
    'context/priorities.md',
    'memory/relationships.md',
    'logs/email-triage-*.md:latest',
    'logs/calendar-prep-*.md:latest',
  ],
  'weekly-plan': [
    'CLAUDE.md',
    'context/priorities.md',
    'context/operating_principles.md',
    'memory/relationships.md',
    'data/queue.md',
  ],
  'cal-shape': [
    'CLAUDE.md',
    'context/priorities.md',
    'memory/relationships.md',
    'memory/decisions.md',
  ],
  'calendar-prep': [
    'CLAUDE.md',
    'context/stakeholders.md',
    'memory/relationships.md',
  ],
};

export function estimateTokens(chars, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const c = Math.max(0, Number(chars) || 0);
  const cpt = Number(charsPerToken) > 0 ? Number(charsPerToken) : DEFAULT_CHARS_PER_TOKEN;
  return Math.ceil(c / cpt);
}

// Classify a path into an offload action, or null if it is not compressible
// (e.g. CLAUDE.md, which the agent always needs in full).
function offloadFor(relPath) {
  const p = relPath.replace(/\\/g, '/');
  if (/(^|\/)data\/queue\.md$/.test(p) || /(^|\/)queue\.md$/.test(p)) {
    return { kind: 'queue', advice: `query it (node tools/queue-cli.mjs list / overdue) instead of loading ${p}` };
  }
  if (p.startsWith('memory/')) {
    return { kind: 'digest', advice: `read the weekly digest instead of ${p}: run \`npm run digest\` then read memory/digest-<week>.md` };
  }
  if (p.startsWith('logs/')) {
    return { kind: 'logs', advice: `read only today's log; skip the backlog under ${path.posix.dirname(p)}/` };
  }
  if (p.startsWith('context/')) {
    return { kind: 'retrieval', advice: `pull only the needed fact from ${p} via \`npm run retrieve:search -- "<topic>"\` instead of loading it whole` };
  }
  return null;
}

/**
 * Core, pure report builder. entries: [{path, tokens, exists?}].
 */
export function buildReport({ entries = [], extraTokens = 0, window = DEFAULT_WINDOW, threshold = DEFAULT_THRESHOLD } = {}) {
  const win = Number(window) > 0 ? Number(window) : DEFAULT_WINDOW;
  const thr = Number(threshold) > 0 ? Number(threshold) : DEFAULT_THRESHOLD;
  const budget = Math.floor(win * thr);
  const extra = Math.max(0, Number(extraTokens) || 0);

  const fileTokens = entries.reduce((s, e) => s + (Number(e.tokens) || 0), 0);
  const total = fileTokens + extra;
  const pct = win > 0 ? total / win : 0;

  let status = 'ok';
  if (total > budget) status = 'over';
  else if (total >= budget * WARN_AT) status = 'warn';

  const contributors = [...entries]
    .map((e) => ({ ...e, offload: offloadFor(e.path) }))
    .sort((a, b) => (b.tokens || 0) - (a.tokens || 0));

  // When over budget, greedily offload the largest compressible contributors
  // until projected total drops under budget. Report what to drop and the win.
  const recommendations = [];
  if (status === 'over') {
    let projected = total;
    for (const c of contributors) {
      if (projected <= budget) break;
      if (!c.offload) continue;
      recommendations.push({ path: c.path, tokens: c.tokens, kind: c.offload.kind, advice: c.offload.advice });
      projected -= c.tokens;
    }
    if (projected > budget) {
      recommendations.push({
        path: null,
        advice: `still ${projected - budget} tokens over after offloading the compressible files; trim the working set further or split the command`,
      });
    }
  }

  return {
    window: win,
    threshold: thr,
    budget,
    file_tokens: fileTokens,
    extra_tokens: extra,
    total,
    pct: Math.round(pct * 1000) / 1000,
    status,
    over_by: Math.max(0, total - budget),
    contributors: contributors.map((c) => ({ path: c.path, tokens: c.tokens, exists: c.exists !== false, offloadable: !!c.offload })),
    recommendations,
  };
}

// ---------------------------------------------------------------- file layer
function expandPattern(pattern) {
  let latest = false;
  let pat = pattern;
  if (pat.endsWith(':latest')) { latest = true; pat = pat.slice(0, -':latest'.length); }
  if (!pat.includes('*')) return [pat];

  const absDir = path.resolve(REPO_ROOT, path.dirname(pat));
  const basePat = path.basename(pat);
  const rx = new RegExp(`^${basePat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  let matches = [];
  try { matches = fs.readdirSync(absDir).filter((f) => rx.test(f)); } catch { matches = []; }
  matches.sort();
  if (latest) matches = matches.slice(-1);
  const relDir = path.dirname(pat);
  return matches.map((m) => (relDir === '.' ? m : `${relDir}/${m}`));
}

function measureFiles(patterns, charsPerToken = DEFAULT_CHARS_PER_TOKEN) {
  const out = [];
  const seen = new Set();
  for (const pattern of patterns) {
    for (const rel of expandPattern(pattern)) {
      if (seen.has(rel)) continue;
      seen.add(rel);
      const abs = path.resolve(REPO_ROOT, rel);
      let bytes = 0;
      let exists = false;
      try {
        const st = fs.statSync(abs);
        if (st.isFile()) { bytes = st.size; exists = true; }
      } catch { /* missing */ }
      out.push({ path: rel, tokens: estimateTokens(bytes, charsPerToken), exists });
    }
  }
  return out;
}

export function measurePreset(name, opts = {}) {
  const patterns = PRESETS[name];
  if (!patterns) throw new Error(`unknown preset: ${name}. Known: ${Object.keys(PRESETS).join(', ')}`);
  const entries = measureFiles(patterns, opts.charsPerToken);
  return buildReport({ entries, ...opts });
}

// ---------------------------------------------------------------- self-test
function selfTest() {
  const cases = [];
  const ok = (name, cond) => cases.push({ name, pass: !!cond });

  ok('estimate 0 -> 0', estimateTokens(0) === 0);
  ok('estimate 4000 chars @4 -> 1000', estimateTokens(4000, 4) === 1000);
  ok('estimate rounds up', estimateTokens(5, 4) === 2);

  // window 200k, threshold 0.4 -> budget 80k
  const under = buildReport({ entries: [{ path: 'CLAUDE.md', tokens: 10000 }], window: 200000, threshold: 0.4 });
  ok('under budget -> ok', under.status === 'ok' && under.budget === 80000);

  const warn = buildReport({ entries: [{ path: 'CLAUDE.md', tokens: 75000 }], window: 200000, threshold: 0.4 });
  ok('approaching budget -> warn', warn.status === 'warn');

  const over = buildReport({
    entries: [
      { path: 'CLAUDE.md', tokens: 30000 },           // not offloadable
      { path: 'memory/relationships.md', tokens: 40000 }, // digest
      { path: 'context/priorities.md', tokens: 30000 },   // retrieval
    ],
    window: 200000,
    threshold: 0.4,
  });
  ok('over budget -> over', over.status === 'over' && over.over_by === 20000);
  ok('over -> recommends offloading the compressible ones', over.recommendations.length >= 1);
  ok('recs are only offloadable paths', over.recommendations.every((r) => r.path === null || r.kind));
  ok('CLAUDE.md never recommended for offload', !over.recommendations.some((r) => r.path === 'CLAUDE.md'));

  // extra-tokens (runtime MCP pulls) count toward the total
  const withExtra = buildReport({ entries: [{ path: 'CLAUDE.md', tokens: 50000 }], extraTokens: 40000, window: 200000, threshold: 0.4 });
  ok('extra-tokens pushes over budget', withExtra.status === 'over' && withExtra.total === 90000);

  // offload classification
  ok('memory -> digest', offloadFor('memory/decisions.md').kind === 'digest');
  ok('context -> retrieval', offloadFor('context/priorities.md').kind === 'retrieval');
  ok('queue -> queue', offloadFor('data/queue.md').kind === 'queue');
  ok('logs -> logs', offloadFor('logs/email-triage-2026-06-02.md').kind === 'logs');
  ok('CLAUDE.md -> not offloadable', offloadFor('CLAUDE.md') === null);

  const failed = cases.filter((c) => !c.pass);
  for (const c of cases) process.stdout.write(`${c.pass ? 'ok  ' : 'FAIL'} ${c.name}\n`);
  process.stdout.write(`\n${cases.length - failed.length}/${cases.length} passed\n`);
  process.exit(failed.length ? 1 : 0);
}

// ---------------------------------------------------------------------- CLI
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 3; i < argv.length; i++) {
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

function jprint(obj) { process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`); }

function commonOpts(args) {
  return {
    extraTokens: args['extra-tokens'] !== undefined ? Number(args['extra-tokens']) : 0,
    window: args.window !== undefined ? Number(args.window) : DEFAULT_WINDOW,
    threshold: args.threshold !== undefined ? Number(args.threshold) : DEFAULT_THRESHOLD,
    charsPerToken: args['chars-per-token'] !== undefined ? Number(args['chars-per-token']) : DEFAULT_CHARS_PER_TOKEN,
  };
}

const cmd = process.argv[2];
const args = parseArgs(process.argv);

switch (cmd) {
  case 'check': {
    const opts = commonOpts(args);
    const patterns = typeof args.files === 'string' ? args.files.split(',').map((s) => s.trim()).filter(Boolean) : [];
    const entries = measureFiles(patterns, opts.charsPerToken);
    const report = buildReport({ entries, ...opts });
    jprint(report);
    process.exit(report.status === 'over' ? 2 : 0);
  }
  case 'preset': {
    const name = args._[0];
    if (!name) { process.stderr.write('preset requires a name\n'); process.exit(2); }
    const report = measurePreset(name, commonOpts(args));
    jprint(report);
    process.exit(report.status === 'over' ? 2 : 0);
  }
  case 'presets':
    jprint(PRESETS);
    break;
  case 'self-test':
    selfTest();
    break;
  default:
    process.stdout.write(
      'usage: node tools/context-budget.mjs <check|preset|presets|self-test> [...args]\n'
      + '  check --files a.md,b.md [--extra-tokens N] [--window N] [--threshold 0.4] [--chars-per-token 4]\n'
      + '  preset <am-sweep|weekly-plan|cal-shape|calendar-prep> [--extra-tokens N]\n',
    );
    process.exit(cmd ? 2 : 0);
}
