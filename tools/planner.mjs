#!/usr/bin/env node
// Chief of Staff: weekly-planner rule engine.
//
// Pure, testable helpers behind the /weekly-plan command. The command
// (commands/weekly-plan.md) does the orchestration -- reads the queue, pulls
// the calendar via the gcal MCP, talks to me -- and calls these functions to
// make the two decisions that must be deterministic and reviewable:
//
//   1. skipDecision()  -- the cadence-floor rule for "can I skip this recurring
//                         1:1 this week?" Distilled from the EA pattern: skip one
//                         instance only when a recent base of contact exists, and
//                         never when the relationship has gone cold.
//   2. timeDeficit()   -- hours the week's primary goal needs vs. hours actually
//                         free on the calendar.
//
// Keeping the rules here (not in prose) means the behavior is inspectable and
// `node tools/planner.mjs self-test` proves it still holds.
//
// Public API:
//   skipDecision({intervalDays, lastHeldISO, recentHeldCount, asOf?, otherInitiated?, hasAgenda?, personal?})
//       -> {decision: 'skip'|'keep'|'prioritize', reason, days_since_last}
//   timeDeficit({neededHours, freeHours}) -> {needed, free, deficit, surplus}
//   weekOf(dateISO)  -> Monday (YYYY-MM-DD) of that date's week
//
// CLI:
//   node tools/planner.mjs skip-decision --interval 7 --last 2026-05-28 --recent 3
//   node tools/planner.mjs deficit --needed 8 --free 5
//   node tools/planner.mjs week-of 2026-06-02
//   node tools/planner.mjs self-test

// Default: a relationship with no contact in this many days is "cold" -- never
// auto-skip, surface it to reconnect instead.
const COLD_DAYS = 182;
// Need at least this many *held* occurrences in the recent window before one
// instance is safe to skip ("you've created a base").
const RECENT_BASE_MIN = 3;
// Skip only if the last real contact is within this multiple of the cadence.
// Beyond it the rhythm has already slipped; keep the meeting.
const RECENCY_SLACK = 1.5;

function daysBetween(fromISO, toISO) {
  const a = new Date(`${fromISO}T00:00:00Z`).getTime();
  const b = new Date(`${toISO}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The cadence-floor skip rule. Defaults bias hard toward KEEP: any missing
 * signal, any ambiguity, and we keep the meeting and ask.
 */
export function skipDecision({
  intervalDays,
  lastHeldISO = null,
  recentHeldCount = 0,
  asOf = todayISO(),
  otherInitiated = false,
  hasAgenda = false,
  personal = false,
} = {}) {
  // The other person owns it, or there is a live agenda/decision: not ours to skip.
  if (otherInitiated) {
    return { decision: 'keep', reason: 'other party initiated this meeting', days_since_last: null };
  }
  if (hasAgenda) {
    return { decision: 'keep', reason: 'has an agenda or pending decision', days_since_last: null };
  }
  // Personal / family / health recurring events: never proposed for skip by the rule.
  if (personal) {
    return { decision: 'keep', reason: 'personal event; out of scope for auto-skip', days_since_last: null };
  }
  // No held history we can trust -> keep and ask.
  if (!lastHeldISO) {
    return { decision: 'keep', reason: 'no held history on record; defaulting to keep', days_since_last: null };
  }

  const daysSince = daysBetween(lastHeldISO, asOf);
  if (daysSince === null || daysSince < 0) {
    return { decision: 'keep', reason: 'unparseable or future last-held date; defaulting to keep', days_since_last: daysSince };
  }

  // Gone cold: do not skip, prioritize reconnecting.
  if (daysSince > COLD_DAYS) {
    return {
      decision: 'prioritize',
      reason: `no contact in ${daysSince} days; reconnect rather than skip`,
      days_since_last: daysSince,
    };
  }

  const interval = Number(intervalDays) > 0 ? Number(intervalDays) : null;
  const recencyOk = interval ? daysSince <= interval * RECENCY_SLACK : false;
  const baseOk = Number(recentHeldCount) >= RECENT_BASE_MIN;

  if (baseOk && recencyOk) {
    return {
      decision: 'skip',
      reason: `met ${recentHeldCount}x recently, last ${daysSince}d ago; one instance is safe to skip`,
      days_since_last: daysSince,
    };
  }

  const why = !baseOk
    ? `only ${recentHeldCount} recent meetings (need ${RECENT_BASE_MIN}); no base yet`
    : `last contact ${daysSince}d ago exceeds ${RECENCY_SLACK}x the ${interval ?? '?'}d cadence`;
  return { decision: 'keep', reason: why, days_since_last: daysSince };
}

/**
 * Hours the primary goal needs vs. hours actually free this week.
 */
export function timeDeficit({ neededHours, freeHours } = {}) {
  const needed = Math.max(0, Number(neededHours) || 0);
  const free = Math.max(0, Number(freeHours) || 0);
  const deficit = Math.max(0, needed - free);
  return { needed, free, deficit, surplus: Math.max(0, free - needed) };
}

/**
 * Monday (ISO, YYYY-MM-DD) of the week containing dateISO. Used for the
 * planning-brief filename so re-runs in the same week overwrite cleanly.
 */
export function weekOf(dateISO = todayISO()) {
  const d = new Date(`${dateISO}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateISO;
  const dow = d.getUTCDay(); // 0 Sun .. 6 Sat
  const back = dow === 0 ? 6 : dow - 1; // days back to Monday
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- self-test
function selfTest() {
  const cases = [];
  const ok = (name, cond) => cases.push({ name, pass: !!cond });
  const asOf = '2026-06-02';

  // weekly 1:1, met 4x, last week -> skip
  ok('weekly+base+recent -> skip',
    skipDecision({ intervalDays: 7, lastHeldISO: '2026-05-28', recentHeldCount: 4, asOf }).decision === 'skip');
  // weekly 1:1 but only met once -> keep (no base)
  ok('weekly+no base -> keep',
    skipDecision({ intervalDays: 7, lastHeldISO: '2026-05-28', recentHeldCount: 1, asOf }).decision === 'keep');
  // base exists but last contact 30d ago on a 7d cadence -> keep (rhythm slipped)
  ok('stale recency -> keep',
    skipDecision({ intervalDays: 7, lastHeldISO: '2026-05-03', recentHeldCount: 4, asOf }).decision === 'keep');
  // no contact in 200 days -> prioritize
  ok('cold -> prioritize',
    skipDecision({ intervalDays: 7, lastHeldISO: '2025-11-10', recentHeldCount: 5, asOf }).decision === 'prioritize');
  // no held history -> keep
  ok('no history -> keep',
    skipDecision({ intervalDays: 7, lastHeldISO: null, recentHeldCount: 0, asOf }).decision === 'keep');
  // other party initiated -> keep regardless
  ok('other-initiated -> keep',
    skipDecision({ intervalDays: 7, lastHeldISO: '2026-05-28', recentHeldCount: 9, asOf, otherInitiated: true }).decision === 'keep');
  // has agenda -> keep
  ok('agenda -> keep',
    skipDecision({ intervalDays: 7, lastHeldISO: '2026-05-28', recentHeldCount: 9, asOf, hasAgenda: true }).decision === 'keep');
  // personal -> keep
  ok('personal -> keep',
    skipDecision({ intervalDays: 7, lastHeldISO: '2026-05-28', recentHeldCount: 9, asOf, personal: true }).decision === 'keep');
  // biweekly cadence, met 3x, last 10d ago (<= 14*1.5) -> skip
  ok('biweekly+base -> skip',
    skipDecision({ intervalDays: 14, lastHeldISO: '2026-05-23', recentHeldCount: 3, asOf }).decision === 'skip');
  // deficit math
  ok('deficit 8 vs 5 -> 3',
    timeDeficit({ neededHours: 8, freeHours: 5 }).deficit === 3);
  ok('deficit 4 vs 6 -> 0 + surplus 2',
    timeDeficit({ neededHours: 4, freeHours: 6 }).deficit === 0 && timeDeficit({ neededHours: 4, freeHours: 6 }).surplus === 2);
  // weekOf
  ok('weekOf Tue 2026-06-02 -> Mon 2026-06-01',
    weekOf('2026-06-02') === '2026-06-01');
  ok('weekOf Sun 2026-06-07 -> Mon 2026-06-01',
    weekOf('2026-06-07') === '2026-06-01');

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

const cmd = process.argv[2];
const args = parseArgs(process.argv);

switch (cmd) {
  case 'skip-decision':
    jprint(skipDecision({
      intervalDays: args.interval !== undefined ? Number(args.interval) : undefined,
      lastHeldISO: args.last ?? null,
      recentHeldCount: args.recent !== undefined ? Number(args.recent) : 0,
      asOf: args['as-of'] ?? undefined,
      otherInitiated: !!args['other-initiated'],
      hasAgenda: !!args['has-agenda'],
      personal: !!args.personal,
    }));
    break;
  case 'deficit':
    jprint(timeDeficit({ neededHours: Number(args.needed), freeHours: Number(args.free) }));
    break;
  case 'week-of':
    process.stdout.write(`${weekOf(args._[0] ?? args['as-of'])}\n`);
    break;
  case 'self-test':
    selfTest();
    break;
  default:
    process.stdout.write(
      'usage: node tools/planner.mjs <skip-decision|deficit|week-of|self-test> [...args]\n'
      + '  skip-decision --interval <days> --last <YYYY-MM-DD> --recent <n> [--as-of <YYYY-MM-DD>] [--other-initiated] [--has-agenda] [--personal]\n'
      + '  deficit --needed <h> --free <h>\n'
      + '  week-of <YYYY-MM-DD>\n',
    );
    process.exit(cmd ? 2 : 0);
}
