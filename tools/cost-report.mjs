#!/usr/bin/env node
// chief-of-staff: cost + latency report from telemetry.jsonl.
//
// Reads data/telemetry.jsonl (populated by tools/telemetry.mjs::tracedFetch)
// and aggregates by command + actor + model. Reports call count, total
// tokens, total cost in USD, P50/P95 latency, and error rate.
//
// Pricing is hard-coded approximate Anthropic public pricing (per million
// tokens) at the top of this file. Edit if prices change. Models not in the
// table show "n/a" for cost.
//
// Usage:
//   node tools/cost-report.mjs                # last 30 days
//   node tools/cost-report.mjs --days 7
//   node tools/cost-report.mjs --by command   # group by command (default)
//   node tools/cost-report.mjs --by actor
//   node tools/cost-report.mjs --by model
//   node tools/cost-report.mjs --json
//   npm run cost-report

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TELEMETRY_PATH = path.resolve(REPO_ROOT, 'data', 'telemetry.jsonl');

// USD per million tokens. Edit to match current Anthropic pricing.
// Cache-read is typically 10% of input. Cache-write is typically 125% of input.
const PRICING = {
  'claude-opus-4-7': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-opus-4-6': { input: 15.0, output: 75.0, cache_read: 1.5, cache_write: 18.75 },
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-sonnet-4-5': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0, cache_read: 0.1, cache_write: 1.25 },
};

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const DAYS = parseInt(arg('days', '30'), 10);
const GROUP_BY = arg('by', 'command');
const asJson = args.includes('--json');

if (!['command', 'actor', 'model'].includes(GROUP_BY)) {
  console.error(`cost-report: --by must be one of command|actor|model (got "${GROUP_BY}")`);
  process.exit(1);
}

if (!fs.existsSync(TELEMETRY_PATH)) {
  if (asJson) console.log(JSON.stringify({ empty: true, reason: 'no telemetry recorded yet' }));
  else console.log('cost-report: no telemetry recorded yet. Run an eval to generate data.');
  process.exit(0);
}

const cutoffMs = Date.now() - DAYS * 86400000;
const entries = fs
  .readFileSync(TELEMETRY_PATH, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim().length > 0)
  .map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter((e) => e && e.at && new Date(e.at).getTime() >= cutoffMs);

if (entries.length === 0) {
  if (asJson) console.log(JSON.stringify({ empty: true, days: DAYS, reason: 'no entries in window' }));
  else console.log(`cost-report: no telemetry in the last ${DAYS} days.`);
  process.exit(0);
}

function costOfEntry(e) {
  const p = PRICING[e.model];
  if (!p) return null;
  const inT = e.input_tokens ?? 0;
  const outT = e.output_tokens ?? 0;
  const crT = e.cache_read_tokens ?? 0;
  const cwT = e.cache_creation_tokens ?? 0;
  return (inT * p.input + outT * p.output + crT * p.cache_read + cwT * p.cache_write) / 1e6;
}

function percentile(sortedNums, p) {
  if (sortedNums.length === 0) return null;
  const idx = Math.min(sortedNums.length - 1, Math.floor((p / 100) * sortedNums.length));
  return sortedNums[idx];
}

const groups = new Map();
for (const e of entries) {
  const key = e[GROUP_BY] ?? '(unknown)';
  if (!groups.has(key)) {
    groups.set(key, {
      count: 0,
      errors: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latencies: [],
      cost_usd: 0,
      cost_missing_pricing: 0,
      models: new Set(),
    });
  }
  const g = groups.get(key);
  g.count += 1;
  if (e.error) g.errors += 1;
  g.input_tokens += e.input_tokens ?? 0;
  g.output_tokens += e.output_tokens ?? 0;
  g.cache_read_tokens += e.cache_read_tokens ?? 0;
  g.cache_creation_tokens += e.cache_creation_tokens ?? 0;
  if (typeof e.latency_ms === 'number') g.latencies.push(e.latency_ms);
  if (e.model) g.models.add(e.model);
  const c = costOfEntry(e);
  if (c === null) g.cost_missing_pricing += 1;
  else g.cost_usd += c;
}

const rows = [];
let totalCost = 0;
let totalCalls = 0;
for (const [key, g] of groups) {
  g.latencies.sort((a, b) => a - b);
  const p50 = percentile(g.latencies, 50);
  const p95 = percentile(g.latencies, 95);
  rows.push({
    [GROUP_BY]: key,
    calls: g.count,
    errors: g.errors,
    error_rate: g.count ? g.errors / g.count : 0,
    input_tokens: g.input_tokens,
    output_tokens: g.output_tokens,
    cache_read_tokens: g.cache_read_tokens,
    cache_creation_tokens: g.cache_creation_tokens,
    cost_usd: g.cost_usd,
    cost_missing_pricing: g.cost_missing_pricing,
    p50_latency_ms: p50,
    p95_latency_ms: p95,
    models: [...g.models],
  });
  totalCost += g.cost_usd;
  totalCalls += g.count;
}

rows.sort((a, b) => b.cost_usd - a.cost_usd);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        days: DAYS,
        group_by: GROUP_BY,
        total_calls: totalCalls,
        total_cost_usd: totalCost,
        rows,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`cost-report: last ${DAYS}d, grouped by ${GROUP_BY}`);
  console.log(`total: ${totalCalls} calls, $${totalCost.toFixed(4)}\n`);
  const header = [
    GROUP_BY.padEnd(28),
    'calls'.padStart(6),
    'err'.padStart(4),
    'in-tok'.padStart(8),
    'out-tok'.padStart(8),
    'cache-r'.padStart(8),
    'cost USD'.padStart(10),
    'p50 ms'.padStart(7),
    'p95 ms'.padStart(7),
  ].join('  ');
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        String(r[GROUP_BY]).padEnd(28),
        String(r.calls).padStart(6),
        String(r.errors).padStart(4),
        String(r.input_tokens).padStart(8),
        String(r.output_tokens).padStart(8),
        String(r.cache_read_tokens).padStart(8),
        `$${r.cost_usd.toFixed(4)}`.padStart(10),
        (r.p50_latency_ms ?? '-').toString().padStart(7),
        (r.p95_latency_ms ?? '-').toString().padStart(7),
      ].join('  '),
    );
    if (r.cost_missing_pricing > 0) {
      console.log(`  (${r.cost_missing_pricing} calls had unknown model pricing; check tools/cost-report.mjs PRICING table)`);
    }
  }
}
