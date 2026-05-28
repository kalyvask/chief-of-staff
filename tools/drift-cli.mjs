#!/usr/bin/env node
// chief-of-staff: classification drift inspector.
//
// Read-only view of bucket distribution shifts. Use for ad-hoc inspection.
// The hook (tools/hooks/classification-drift.mjs) is what actually surfaces
// drift into the queue. This CLI is for "show me the numbers."
//
// Usage:
//   node tools/drift-cli.mjs
//   node tools/drift-cli.mjs --recent 14 --prior 60
//   node tools/drift-cli.mjs --json
//   npm run drift

import { loadQueue } from './queue.mjs';

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const RECENT_DAYS = parseInt(arg('recent', '7'), 10);
const PRIOR_DAYS = parseInt(arg('prior', '30'), 10);
const asJson = args.includes('--json');

if (PRIOR_DAYS <= RECENT_DAYS) {
  console.error(`drift: --prior (${PRIOR_DAYS}) must exceed --recent (${RECENT_DAYS})`);
  process.exit(1);
}

function isTestItem(item) {
  const src = item.source ?? '';
  return src === 'eval' || /^(smoke|demo|ui-test)/.test(src);
}

const all = Array.from(loadQueue().values())
  .filter((i) => !isTestItem(i))
  .map((i) => ({ bucket: i.bucket, created_at: i.audit?.[0]?.at ?? null }))
  .filter((i) => i.bucket && i.created_at);

const nowMs = Date.now();
const recent = all.filter((i) => new Date(i.created_at).getTime() >= nowMs - RECENT_DAYS * 86400000);
const prior = all.filter((i) => {
  const t = new Date(i.created_at).getTime();
  return t >= nowMs - PRIOR_DAYS * 86400000 && t < nowMs - RECENT_DAYS * 86400000;
});

const BUCKETS = ['Dispatch', 'Prep', 'Yours', 'Skip'];

function tally(items) {
  const c = Object.fromEntries(BUCKETS.map((b) => [b, 0]));
  for (const i of items) if (c[i.bucket] !== undefined) c[i.bucket] += 1;
  const t = items.length;
  const out = {};
  for (const b of BUCKETS) out[b] = { count: c[b], share: t ? c[b] / t : 0 };
  return { total: t, per_bucket: out };
}

const rTally = tally(recent);
const pTally = tally(prior);

if (asJson) {
  const shifts = {};
  for (const b of BUCKETS) {
    shifts[b] = {
      recent_count: rTally.per_bucket[b].count,
      recent_share: rTally.per_bucket[b].share,
      prior_count: pTally.per_bucket[b].count,
      prior_share: pTally.per_bucket[b].share,
      shift: rTally.per_bucket[b].share - pTally.per_bucket[b].share,
    };
  }
  console.log(
    JSON.stringify(
      {
        recent_days: RECENT_DAYS,
        prior_days: PRIOR_DAYS - RECENT_DAYS,
        recent_total: rTally.total,
        prior_total: pTally.total,
        distribution: shifts,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Classification distribution (recent ${RECENT_DAYS}d vs prior ${PRIOR_DAYS - RECENT_DAYS}d)\n`);
  if (rTally.total === 0 && pTally.total === 0) {
    console.log('No queue items dated in either window. Add items via /am-sweep first.');
    process.exit(0);
  }
  console.log(`Recent (${rTally.total} items):`);
  for (const b of BUCKETS) {
    const { count, share } = rTally.per_bucket[b];
    console.log(`  ${b.padEnd(10)} ${String(count).padStart(4)}  ${(share * 100).toFixed(0).padStart(3)}%`);
  }
  console.log(`\nPrior (${pTally.total} items):`);
  for (const b of BUCKETS) {
    const { count, share } = pTally.per_bucket[b];
    console.log(`  ${b.padEnd(10)} ${String(count).padStart(4)}  ${(share * 100).toFixed(0).padStart(3)}%`);
  }
  console.log(`\nShift (recent share minus prior share):`);
  for (const b of BUCKETS) {
    const s = rTally.per_bucket[b].share - pTally.per_bucket[b].share;
    const arrow = Math.abs(s) < 0.005 ? ' ' : s > 0 ? '+' : '-';
    console.log(`  ${b.padEnd(10)} ${arrow}${(Math.abs(s) * 100).toFixed(0).padStart(2)}pp`);
  }
}
