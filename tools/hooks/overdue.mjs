// Hook: overdue queue items.
//
// Reads the queue, finds any open item past its due_date, and emits a Yours
// item (high priority) for each one that has not yet been surfaced. The
// dedup key is `hook.overdue.<original-id>` so re-runs do not flood.
//
// Side effects: writes new queue items (T0 action, allowed by default).

import { loadOpen, addItem, loadQueue } from '../queue.mjs';

export default function run() {
  const todayIso = new Date().toISOString().slice(0, 10);
  const overdue = loadOpen().filter((i) => i.due_date && i.due_date < todayIso);
  const all = Array.from(loadQueue().values());
  const surfaced = new Set();
  for (const item of all) {
    for (const p of item.provenance ?? []) {
      if (p.type === 'hook.overdue') surfaced.add(p.ref);
    }
  }

  const created = [];
  for (const item of overdue) {
    if (surfaced.has(item.id)) continue;
    const ageDays = Math.floor(
      (Date.now() - new Date(item.due_date).getTime()) / 86400000,
    );
    if (ageDays < 1) continue;
    const newItem = addItem(
      {
        bucket: 'Yours',
        priority: ageDays > 7 ? 'high' : 'med',
        summary: `Overdue ${ageDays}d: ${item.summary}`,
        source: 'hook',
        source_id: 'hook.overdue',
        proposed_action: `Close, defer with a new due date, or escalate. Original item: ${item.id}.`,
        project: item.project ?? null,
        provenance: [{ type: 'hook.overdue', ref: item.id, note: `overdue since ${item.due_date}` }],
        required_tier: 0,
      },
      { actor: 'hooks-runner', rule: 'hook.overdue' },
    );
    created.push({ original: item.id, new: newItem.id, ageDays });
  }

  return { hook: 'overdue', overdue_count: overdue.length, surfaced: created.length, created };
}
