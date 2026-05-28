// Chief of Staff: contradiction detection.
//
// Scans the derived state for conflicts between:
//
//   - a decision in memory/decisions.md vs the outcome of a closed queue
//     item that points the other way ("decided to ship X" then closed
//     q_... with outcome "abandoned X")
//   - two decisions about the same project or stakeholder that point
//     opposite directions (antonym verb pairs)
//   - context/priorities.md "this-week" items that have not moved in
//     more than 14 days (stale priority claim)
//   - context/priorities.md "this-month" items older than 35 days
//   - a stakeholder whose memory/relationships.md entry claims a recent
//     interaction but no logged interaction edge in the graph
//   - an open queue item whose direction=in (owed to me) but counterparty
//     also has a more recent closed item with the opposite direction
//
// Heuristic, not LLM. Findings can be false positives; severity reflects
// confidence. Output mirrors tools/conform.mjs shape so the same UX works
// (each finding has rule, severity, message, evidence, suggest).
//
// Public API:
//   findContradictions({today, windowDays})  -> finding[]
//   summarize(findings)                      -> {ok, summary, counts}

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGraph } from './graph-query.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.resolve(REPO_ROOT, 'data', 'queue.jsonl');

const ANTONYMS = [
  ['ship', 'kill'],
  ['ship', 'pull'],
  ['ship', 'abandon'],
  ['continue', 'kill'],
  ['continue', 'pause'],
  ['hire', 'pass'],
  ['hire', 'reject'],
  ['accept', 'decline'],
  ['accept', 'reject'],
  ['adopt', 'drop'],
  ['adopt', 'reject'],
  ['go with', 'switch'],
  ['proceed', 'pause'],
  ['proceed', 'cancel'],
  ['launch', 'cancel'],
  ['expand', 'shrink'],
  ['raise', 'lower'],
  ['onboard', 'offboard'],
];

function hasVerb(text, verb) {
  const re = new RegExp(`\\b${verb.replace(/\s+/g, '\\s+')}\\b`, 'i');
  return re.test(text);
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) return null;
  return Math.floor((db - da) / 86400000);
}

function readQueue() {
  if (!fs.existsSync(QUEUE_PATH)) return [];
  const lines = fs.readFileSync(QUEUE_PATH, 'utf8').split(/\r?\n/).filter(Boolean);
  const byId = new Map();
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item?.id) byId.set(item.id, item);
    } catch {}
  }
  return Array.from(byId.values());
}

// 1) Decision vs closed queue outcome: same project, opposite verbs.
function decisionVsOutcome(graph, queue) {
  const findings = [];
  for (const d of graph.decisions ?? []) {
    const project = d.fields?.Project;
    if (!project || project === 'unscoped') continue;
    const decisionText = d.decision.toLowerCase();
    for (const [a, b] of ANTONYMS) {
      const decisionHasA = hasVerb(decisionText, a);
      const decisionHasB = hasVerb(decisionText, b);
      if (!decisionHasA && !decisionHasB) continue;
      const decisionPole = decisionHasA ? a : b;
      const oppositePole = decisionHasA ? b : a;
      // Find closed queue items in the same project whose outcome contains
      // the opposite verb and were closed after the decision date.
      for (const q of queue) {
        if (q.project !== project) continue;
        if (q.status !== 'done' && q.status !== 'dropped') continue;
        const outcome = String(q.outcome ?? '').toLowerCase();
        if (!outcome) continue;
        if (!hasVerb(outcome, oppositePole)) continue;
        const dDate = d.date;
        const qDate = q.closed_at || q.updated_at;
        const gap = daysBetween(dDate, qDate);
        if (gap === null || gap < 0) continue;
        findings.push({
          rule: 'decision-vs-outcome',
          severity: 'high',
          message: `decision "${d.decision}" (${dDate}) is contradicted by queue ${q.id} outcome "${q.outcome}" closed ${qDate}`,
          evidence: { decision_id: d.id, queue_id: q.id, decision_pole: decisionPole, opposite_pole: oppositePole, gap_days: gap },
          suggest: 'reconcile in memory/decisions.md: either supersede the earlier decision or annotate the queue outcome',
        });
      }
    }
  }
  return findings;
}

// 2) Two decisions on same project with antonym verbs.
function decisionVsDecision(graph) {
  const findings = [];
  const byProject = new Map();
  for (const d of graph.decisions ?? []) {
    const p = d.fields?.Project;
    if (!p || p === 'unscoped') continue;
    if (!byProject.has(p)) byProject.set(p, []);
    byProject.get(p).push(d);
  }
  for (const [project, decisions] of byProject.entries()) {
    if (decisions.length < 2) continue;
    decisions.sort((x, y) => String(x.date).localeCompare(String(y.date)));
    for (let i = 0; i < decisions.length; i++) {
      for (let j = i + 1; j < decisions.length; j++) {
        const a = decisions[i], b = decisions[j];
        const ta = a.decision.toLowerCase();
        const tb = b.decision.toLowerCase();
        for (const [v1, v2] of ANTONYMS) {
          const aHasV1 = hasVerb(ta, v1) && !hasVerb(ta, v2);
          const aHasV2 = hasVerb(ta, v2) && !hasVerb(ta, v1);
          const bHasV1 = hasVerb(tb, v1) && !hasVerb(tb, v2);
          const bHasV2 = hasVerb(tb, v2) && !hasVerb(tb, v1);
          if ((aHasV1 && bHasV2) || (aHasV2 && bHasV1)) {
            findings.push({
              rule: 'decision-vs-decision',
              severity: 'med',
              message: `project "${project}" has antonym decisions: "${a.decision}" (${a.date}) and "${b.decision}" (${b.date})`,
              evidence: { project, earlier: a.id, later: b.id, pole: [v1, v2] },
              suggest: 'if the later decision supersedes the earlier, mark the earlier "Superseded by:" in memory/decisions.md',
            });
          }
        }
      }
    }
  }
  return findings;
}

// 3) Stale priority claims: this-week items older than 14 days,
//    this-month items older than 35 days.
function stalePriorities(graph, today) {
  const findings = [];
  const buckets = graph.priorities ?? {};
  const checks = [
    ['this-week', 14],
    ['this-month', 35],
  ];
  // Priorities.md doesn't carry a per-item timestamp. Heuristic: compare the
  // graph build time against today. If graph is fresh but items still sit in
  // this-week through multiple rebuilds, we can't tell from one snapshot
  // alone. Fall back to flagging items that contain an explicit older date
  // (e.g. "due 2026-04-30") past the bucket window.
  for (const [bucket, windowDays] of checks) {
    const block = buckets[bucket];
    if (!block?.items) continue;
    for (const item of block.items) {
      const m = String(item).match(/(\d{4}-\d{2}-\d{2})/);
      if (!m) continue;
      const itemDate = m[1];
      const age = daysBetween(itemDate, today);
      if (age === null) continue;
      if (age > windowDays) {
        findings.push({
          rule: `stale-priority.${bucket}`,
          severity: 'med',
          message: `priority "${item}" is in "${bucket}" but its embedded date ${itemDate} is ${age} days old (window: ${windowDays})`,
          evidence: { bucket, item, item_date: itemDate, age_days: age, window_days: windowDays },
          suggest: `move to a later bucket in context/priorities.md or update the date if still active`,
        });
      }
    }
  }
  return findings;
}

// 4) Relationship freshness claim vs no logged interaction.
function relationshipFreshness(graph) {
  const findings = [];
  const interactionFor = new Set();
  const lastMeetingFor = new Map();
  for (const e of graph.edges ?? []) {
    if (e.type === 'last_interaction_at') interactionFor.add(e.from);
    if (e.type === 'last_meeting_at') lastMeetingFor.set(e.from, e.when);
  }
  for (const r of graph.relationships ?? []) {
    const fields = r.fields ?? {};
    const cadenceKey = Object.keys(fields).find((k) => /cadence/i.test(k));
    const cadenceValue = cadenceKey ? (fields[cadenceKey]?.value ?? '') : '';
    if (!cadenceValue) continue;
    if (/(weekly|monthly|every (?:week|month)|active|warm|regular)/i.test(cadenceValue)) {
      // Claims an active cadence. If there is no logged interaction AND no
      // meeting in the last 60 days, flag as contradiction.
      const hasInteraction = interactionFor.has(r.id);
      const lastMeeting = lastMeetingFor.get(r.id);
      const meetingAge = lastMeeting ? daysBetween(lastMeeting, new Date().toISOString().slice(0, 10)) : null;
      const meetingFresh = meetingAge !== null && meetingAge <= 60;
      if (!hasInteraction && !meetingFresh) {
        findings.push({
          rule: 'relationship-claim-vs-evidence',
          severity: 'low',
          message: `${r.name} cadence in memory/relationships.md claims "${cadenceValue}" but no recent logged interaction or meeting`,
          evidence: { stakeholder: r.id, cadence_claim: cadenceValue, last_meeting_age_days: meetingAge },
          suggest: 'either log a recent interaction in memory/relationships.md or change the cadence claim to match reality',
        });
      }
    }
  }
  return findings;
}

// 5) Open queue item with direction=in but a more recent closed item from the
//    same counterparty with direction=out. (They owed me, I owed them back,
//    and the original is still open and probably dead.)
function queueDirectionMismatch(queue) {
  const findings = [];
  const byCounterparty = new Map();
  for (const q of queue) {
    if (!q.counterparty) continue;
    if (!byCounterparty.has(q.counterparty)) byCounterparty.set(q.counterparty, []);
    byCounterparty.get(q.counterparty).push(q);
  }
  for (const [cp, items] of byCounterparty.entries()) {
    items.sort((a, b) => String(a.updated_at ?? a.created_at ?? '').localeCompare(String(b.updated_at ?? b.created_at ?? '')));
    const openIn = items.filter((q) => q.direction === 'in' && (q.status === 'open' || q.status === 'in-flight'));
    const closedOutAfter = (openItem) => items.filter((q) =>
      q.direction === 'out'
      && (q.status === 'done' || q.status === 'dropped')
      && String(q.closed_at ?? q.updated_at ?? '').localeCompare(String(openItem.updated_at ?? openItem.created_at ?? '')) > 0,
    );
    for (const openItem of openIn) {
      const later = closedOutAfter(openItem);
      if (later.length > 0) {
        findings.push({
          rule: 'queue-direction-mismatch',
          severity: 'low',
          message: `open inbound queue item ${openItem.id} with ${cp} is older than closed outbound items to the same counterparty; the original ask may be dead`,
          evidence: { open_id: openItem.id, counterparty: cp, later_closed: later.map((x) => x.id) },
          suggest: `close ${openItem.id} with an outcome note or rephrase the open ask`,
        });
      }
    }
  }
  return findings;
}

export function findContradictions({ today = new Date().toISOString().slice(0, 10) } = {}) {
  let graph;
  try { graph = loadGraph(); }
  catch (e) {
    throw new Error(`contradictions: ${e.message}`);
  }
  const queue = readQueue();
  const findings = [
    ...decisionVsOutcome(graph, queue),
    ...decisionVsDecision(graph),
    ...stalePriorities(graph, today),
    ...relationshipFreshness(graph),
    ...queueDirectionMismatch(queue),
  ];
  return findings;
}

export function summarize(findings) {
  if (!findings.length) return { ok: true, summary: 'no contradictions detected', counts: {} };
  const counts = {};
  for (const f of findings) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  const high = findings.filter((f) => f.severity === 'high').length;
  const med = findings.filter((f) => f.severity === 'med').length;
  const low = findings.filter((f) => f.severity === 'low').length;
  return {
    ok: high === 0,
    summary: `${findings.length} contradiction${findings.length === 1 ? '' : 's'}: ${high} high, ${med} med, ${low} low`,
    counts,
  };
}
