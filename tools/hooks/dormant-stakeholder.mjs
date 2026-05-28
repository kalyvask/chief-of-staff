// Hook: dormant warm-list stakeholders.
//
// Uses the typed graph (data/graph.json) to find stakeholders whose category
// suggests they belong to the "keep warm" set and whose last logged
// interaction is older than N days. Emits a Prep queue item suggesting a
// touchpoint. Dedupe key: hook.dormant-stakeholder.<stakeholder-id>.
//
// "Warm" categories are configurable: defaults to anything matching
// /mentor|investor|recruit|founder/i. Skip the hook entirely if the graph
// is missing.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addItem, loadQueue } from '../queue.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GRAPH_PATH = path.resolve(__dirname, '..', '..', 'data', 'graph.json');

const WARM_CATEGORY = /mentor|investor|recruit|founder|stakeholder|peer|hiring/i;

export default function run({ daysThreshold = 60 } = {}) {
  if (!fs.existsSync(GRAPH_PATH)) {
    return { hook: 'dormant-stakeholder', skipped: 'graph missing; run build-graph first' };
  }
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, 'utf8'));
  const todayIso = new Date().toISOString().slice(0, 10);
  const cutoffIso = new Date(Date.now() - daysThreshold * 86400000).toISOString().slice(0, 10);

  // Last-interaction map from edges.
  const lastInteraction = new Map();
  for (const e of graph.edges ?? []) {
    if (e.type === 'last_interaction_at' && e.when) lastInteraction.set(e.from, e.when);
  }

  // Dedupe: only emit one Prep per stakeholder per day.
  const recent = new Set();
  for (const item of loadQueue().values()) {
    if (item.created_at && item.created_at.slice(0, 10) === todayIso) {
      for (const p of item.provenance ?? []) {
        if (p.type === 'hook.dormant-stakeholder') recent.add(p.ref);
      }
    }
  }

  const created = [];
  let checked = 0;
  for (const s of graph.stakeholders ?? []) {
    if (!s.category || !WARM_CATEGORY.test(s.category)) continue;
    checked++;
    if (recent.has(s.id)) continue;
    const when = lastInteraction.get(s.id);
    let ageDays = null;
    if (when) {
      ageDays = Math.floor(
        (Date.now() - new Date(when).getTime()) / 86400000,
      );
      if (ageDays <= daysThreshold) continue;
    } else {
      ageDays = null; // never logged
    }
    const ageLabel = ageDays === null ? 'never logged' : `${ageDays}d`;
    const newItem = addItem(
      {
        bucket: 'Prep',
        priority: ageDays === null || ageDays > 120 ? 'high' : 'med',
        summary: `Warm list dormant: ${s.name} (${ageLabel}). Schedule a touchpoint or downgrade the category.`,
        source: 'hook',
        source_id: 'hook.dormant-stakeholder',
        proposed_action: `Open memory/relationships.md. Either log a recent touch I forgot to record, or schedule a 15-min note for this week.`,
        counterparty: s.name,
        provenance: [{ type: 'hook.dormant-stakeholder', ref: s.id, note: `last interaction: ${when ?? 'never'}` }],
        required_tier: 0,
      },
      { actor: 'hooks-runner', rule: 'hook.dormant-stakeholder' },
    );
    created.push({ stakeholder: s.id, name: s.name, ageDays, new: newItem.id });
  }
  return { hook: 'dormant-stakeholder', checked, surfaced: created.length, created };
}
