#!/usr/bin/env node
// chief-of-staff: substrate stats.
//
// Computes aggregate stats from the deterministic substrate (queue.jsonl,
// permit-audit.jsonl, conform-audit.jsonl) plus the overnight log directory.
// No agent calls, no LLM. Pure file reads.
//
// Output is two-section:
//   1. Pretty (default): human-readable summary with section headers.
//   2. JSON (--json): machine-readable, suitable for piping into the README
//      Status section via scripts.
//
// Usage:
//   node tools/stats.mjs
//   node tools/stats.mjs --json
//   npm run stats

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const asJson = args.includes('--json');

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf-8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function countBy(arr, keyFn) {
  const out = {};
  for (const item of arr) {
    const k = keyFn(item) ?? '(none)';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function isTestActor(actor) {
  if (!actor) return false;
  return /^(smoke|eval|demo|ui-test|smoke-test)/.test(actor);
}

function isTestItem(item) {
  if (item.source === 'eval') return true;
  if (item.source === 'manual' && /(test|smoke|undo test|eval queue)/i.test(item.summary ?? '')) return true;
  const provType = item.provenance?.[0]?.type ?? '';
  if (/(smoke|eval|demo)/.test(provType)) return true;
  if (/demo cleanup|smoke (test )?cleanup|eval cleanup|integration test pass|final smoke test/i.test(item.outcome ?? '')) return true;
  return false;
}

// --- Queue stats ---
const queue = readJsonl(path.join(REPO_ROOT, 'data', 'queue.jsonl'));
const realItems = queue.filter((q) => !isTestItem(q));
const testItems = queue.filter(isTestItem);

const queueBuckets = countBy(realItems, (q) => q.bucket);
const queueSources = countBy(realItems, (q) => q.source);
const queueStatuses = countBy(realItems, (q) => q.status);
const realDormantHookItems = realItems.filter((q) => q.source === 'hook' && q.source_id === 'hook.dormant-stakeholder');

// --- Permit-audit stats ---
const permit = readJsonl(path.join(REPO_ROOT, 'data', 'permit-audit.jsonl'));
const permitDecisions = permit.filter((p) => p.action && p.action !== 'actor.tier.raised');
const permitDenied = permitDecisions.filter((p) => p.allowed === false);
const permitAllowed = permitDecisions.filter((p) => p.allowed === true);
const denyReasons = countBy(permitDenied, (p) => {
  if (p.reason?.includes('routine mode read-only')) return 'read-only mode caps tier';
  if (p.reason?.includes('tier-3 action requires itemId')) return 'tier-3 requires itemId';
  if (p.reason?.includes('requires tier')) return 'actor below required tier';
  return 'other';
});

// --- Conform-audit stats ---
const conform = readJsonl(path.join(REPO_ROOT, 'data', 'conform-audit.jsonl'));
const conformPass = conform.filter((c) => c.ok === true);
const conformFail = conform.filter((c) => c.ok === false);

// --- Overnight log stats ---
const logsDir = path.join(REPO_ROOT, 'logs');
let realOvernightRuns = 0;
let failModeOvernightRuns = 0;
const overnightDays = new Set();
if (fs.existsSync(logsDir)) {
  for (const file of fs.readdirSync(logsDir)) {
    const m = file.match(/^(email-triage|calendar-prep)-(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    overnightDays.add(m[2]);
    const content = fs.readFileSync(path.join(logsDir, file), 'utf-8');
    const isFailMode = /triage did not run|failure-mode log|not real triage|mcp.*not loading|inbox was never read|never read|was not exposed|was not read this run/i.test(content);
    if (isFailMode) failModeOvernightRuns += 1;
    else realOvernightRuns += 1;
  }
}

// --- Graph stats ---
const graphPath = path.join(REPO_ROOT, 'data', 'graph.json');
let graphStats = null;
if (fs.existsSync(graphPath)) {
  try {
    const g = JSON.parse(fs.readFileSync(graphPath, 'utf-8'));
    graphStats = g.stats ?? null;
  } catch {
    /* ignore */
  }
}

const stats = {
  generated_at: new Date().toISOString(),
  queue: {
    total: queue.length,
    real: realItems.length,
    test_or_smoke: testItems.length,
    by_bucket: queueBuckets,
    by_source: queueSources,
    by_status: queueStatuses,
    dormant_stakeholder_alerts: realDormantHookItems.length,
  },
  permit: {
    decisions: permitDecisions.length,
    allowed: permitAllowed.length,
    denied: permitDenied.length,
    deny_reasons: denyReasons,
  },
  conform: {
    audits: conform.length,
    pass: conformPass.length,
    fail: conformFail.length,
  },
  overnight: {
    days_with_logs: overnightDays.size,
    real_output_files: realOvernightRuns,
    fail_mode_files: failModeOvernightRuns,
  },
  graph: graphStats,
};

if (asJson) {
  console.log(JSON.stringify(stats, null, 2));
  process.exit(0);
}

function render() {
  const lines = [];
  lines.push(`chief-of-staff substrate stats, ${stats.generated_at}`);
  lines.push('');

  lines.push('Queue');
  lines.push(`  total items: ${stats.queue.total}`);
  lines.push(`  real (production): ${stats.queue.real}`);
  lines.push(`  test / smoke / demo seeds: ${stats.queue.test_or_smoke}`);
  if (stats.queue.real > 0) {
    lines.push(`  by bucket: ${JSON.stringify(stats.queue.by_bucket)}`);
    lines.push(`  by source: ${JSON.stringify(stats.queue.by_source)}`);
    lines.push(`  dormant-stakeholder alerts surfaced: ${stats.queue.dormant_stakeholder_alerts}`);
  }
  lines.push('');

  lines.push('Permission engine');
  lines.push(`  decisions logged: ${stats.permit.decisions}`);
  lines.push(`  allowed: ${stats.permit.allowed}`);
  lines.push(`  denied (caught before side-effect): ${stats.permit.denied}`);
  if (stats.permit.denied > 0) {
    for (const [reason, count] of Object.entries(stats.permit.deny_reasons)) {
      lines.push(`    ${reason}: ${count}`);
    }
  }
  lines.push('');

  lines.push('Conformance');
  lines.push(`  audits logged: ${stats.conform.audits}`);
  lines.push(`  pass: ${stats.conform.pass}`);
  lines.push(`  fail (caught before delivery): ${stats.conform.fail}`);
  lines.push('');

  lines.push('Overnight automation');
  lines.push(`  days with overnight logs: ${stats.overnight.days_with_logs}`);
  lines.push(`  real output files: ${stats.overnight.real_output_files}`);
  lines.push(`  fail-safe logs (agent declined to fabricate): ${stats.overnight.fail_mode_files}`);
  lines.push('');

  if (stats.graph) {
    lines.push('Graph');
    for (const [k, v] of Object.entries(stats.graph)) {
      lines.push(`  ${k}: ${v}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

console.log(render());
