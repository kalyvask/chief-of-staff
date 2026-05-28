// Chief of Staff: provenance rendering helper.
//
// Every queue item carries an array of {type, ref, captured_at, note?} signal
// pointers. Drafts (emails, briefs, project updates) should cite the items
// they were built from so future me can verify, retract, or re-pull.
//
// renderSources([itemIds]) -> a "Sources:" block for a draft footer
// renderSourcesInline([itemIds]) -> a one-line citation tag for short drafts
//
// Usage in the email-drafter:
//   import { renderSources } from '../tools/provenance.mjs';
//   const footer = renderSources([itemId]);
//   const body = draft + '\n\n' + footer;

import { getItem } from './queue.mjs';

export function provenanceFor(itemId) {
  const item = getItem(itemId);
  if (!item) return [];
  return (item.provenance ?? []).map((p) => ({ ...p, queue_item: itemId }));
}

export function renderSources(itemIds) {
  const entries = [];
  for (const id of itemIds) {
    const item = getItem(id);
    if (!item) continue;
    for (const p of item.provenance ?? []) {
      const tag = `${p.type}:${p.ref}`;
      const captured = p.captured_at ? ` (captured ${p.captured_at})` : '';
      const note = p.note ? ` -- ${p.note}` : '';
      entries.push(`- ${tag}${captured}${note} [queue:${id}]`);
    }
    if (!item.provenance?.length) {
      entries.push(`- queue:${id} (no upstream signal recorded)`);
    }
  }
  if (!entries.length) return '';
  return ['Sources:', ...entries].join('\n');
}

export function renderSourcesInline(itemIds) {
  const tags = [];
  for (const id of itemIds) {
    const item = getItem(id);
    if (!item) continue;
    const first = (item.provenance ?? [])[0];
    if (first) tags.push(`${first.type}:${first.ref}`);
    else tags.push(`queue:${id}`);
  }
  return tags.length ? `[sources: ${tags.join(', ')}]` : '';
}
