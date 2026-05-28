// Hook: classification drift.
//
// Compares the rolling RECENT_DAYS distribution of queue-item buckets to the
// preceding PRIOR_DAYS baseline. If any bucket's share shifted by more than
// DRIFT_THRESHOLD (absolute percentage points), surfaces a Yellow queue item
// for the user to decide: tune the classifier, update priorities, or accept
// the new distribution as the new baseline.
//
// Dedup: one fire per ISO-week. Re-runs in the same week are suppressed so
// the queue does not flood.
//
// Side effects: writes one queue item per drift event (T0, allowed by default).

import { loadQueue, addItem } from '../queue.mjs';

const RECENT_DAYS = 7;
const PRIOR_DAYS = 30; // total window; "prior baseline" = days (PRIOR_DAYS .. RECENT_DAYS)
const DRIFT_THRESHOLD = 0.15; // 15 absolute percentage points
const MIN_RECENT = 5;
const MIN_PRIOR = 10;

function isTestItem(item) {
  if (!item) return false;
  const src = item.source ?? '';
  if (src === 'eval') return true;
  if (/^(smoke|demo|ui-test)/.test(src)) return true;
  return false;
}

function distribution(items) {
  const buckets = ['Dispatch', 'Prep', 'Yours', 'Skip'];
  const counts = Object.fromEntries(buckets.map((b) => [b, 0]));
  for (const it of items) {
    if (counts[it.bucket] !== undefined) counts[it.bucket] += 1;
  }
  const total = items.length;
  const dist = {};
  for (const b of buckets) dist[b] = total ? counts[b] / total : 0;
  return { counts, total, dist };
}

function isoWeekKey(d) {
  // YYYY-Www (ISO week, simplified to "year-week ordinal")
  const date = new Date(d.getTime());
  date.setUTCHours(0, 0, 0, 0);
  // Thursday of the current week determines the ISO year
  date.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export default function run({ today = null, threshold = DRIFT_THRESHOLD } = {}) {
  const todayDate = today ? new Date(today + 'T00:00:00Z') : new Date();
  const todayMs = todayDate.getTime();
  const recentStartMs = todayMs - RECENT_DAYS * 86400000;
  const priorStartMs = todayMs - PRIOR_DAYS * 86400000;

  const all = Array.from(loadQueue().values()).filter((i) => !isTestItem(i));
  const dated = all
    .map((i) => ({
      bucket: i.bucket,
      created_at: i.audit?.[0]?.at ?? null,
    }))
    .filter((i) => i.bucket && i.created_at);

  const recent = dated.filter((i) => new Date(i.created_at).getTime() >= recentStartMs);
  const prior = dated.filter((i) => {
    const t = new Date(i.created_at).getTime();
    return t >= priorStartMs && t < recentStartMs;
  });

  if (recent.length < MIN_RECENT || prior.length < MIN_PRIOR) {
    return {
      hook: 'classification-drift',
      reason: 'insufficient data',
      recent_count: recent.length,
      prior_count: prior.length,
      min_recent: MIN_RECENT,
      min_prior: MIN_PRIOR,
    };
  }

  const rDist = distribution(recent).dist;
  const pDist = distribution(prior).dist;

  const shifts = {};
  let worstShift = 0;
  let worstBucket = null;
  for (const b of ['Dispatch', 'Prep', 'Yours', 'Skip']) {
    const r = rDist[b];
    const p = pDist[b];
    const s = r - p;
    shifts[b] = { recent_share: r, prior_share: p, shift: s };
    if (Math.abs(s) > Math.abs(worstShift)) {
      worstShift = s;
      worstBucket = b;
    }
  }

  if (Math.abs(worstShift) < threshold) {
    return {
      hook: 'classification-drift',
      drift_detected: false,
      worst_shift: worstShift,
      worst_bucket: worstBucket,
      shifts,
    };
  }

  // Dedup by ISO week.
  const weekKey = isoWeekKey(todayDate);
  const alreadySurfaced = all.some((item) =>
    (item.provenance ?? []).some(
      (p) => p.type === 'hook.classification-drift' && p.ref === weekKey,
    ),
  );

  if (alreadySurfaced) {
    return {
      hook: 'classification-drift',
      drift_detected: true,
      suppressed: 'already surfaced this ISO week',
      week_key: weekKey,
      shifts,
    };
  }

  const direction = worstShift > 0 ? 'up' : 'down';
  const pp = (Math.abs(worstShift) * 100).toFixed(0);
  const newItem = addItem(
    {
      bucket: 'Yours',
      priority: 'med',
      summary: `Classification drift: ${worstBucket} share ${direction} ${pp}pp vs prior baseline`,
      source: 'hook',
      source_id: 'hook.classification-drift',
      proposed_action: `Last ${RECENT_DAYS}d had ${recent.length} items; prior ${PRIOR_DAYS - RECENT_DAYS}d had ${prior.length}. Bucket ${worstBucket} moved from ${(pDist[worstBucket] * 100).toFixed(0)}% to ${(rDist[worstBucket] * 100).toFixed(0)}%. Decide: (1) inbound mix changed (no action), (2) classifier prompt needs retuning, (3) your priorities changed (update CLAUDE.md). Run "npm run drift" for the full per-bucket breakdown.`,
      provenance: [
        {
          type: 'hook.classification-drift',
          ref: weekKey,
          note: JSON.stringify(shifts),
        },
      ],
      required_tier: 0,
    },
    { actor: 'hooks-runner', rule: 'hook.classification-drift' },
  );

  return {
    hook: 'classification-drift',
    drift_detected: true,
    surfaced: newItem.id,
    week_key: weekKey,
    worst_bucket: worstBucket,
    worst_shift: worstShift,
    shifts,
  };
}
