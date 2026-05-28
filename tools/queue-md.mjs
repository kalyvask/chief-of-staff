#!/usr/bin/env node
// Chief of Staff: queue Markdown view.
//
// Renders the current open queue as Markdown to data/queue.md, grouped by
// bucket (Yours / Prep / Dispatch / Skip). Read-only artifact; the canonical
// store is data/queue.jsonl. Run after each /am-sweep or whenever the queue
// changes, or expose a regenerate button in the web UI.
//
// Usage: node tools/queue-md.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpen, queryOverdue, queryByDirection } from './queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.resolve(__dirname, '..', 'data', 'queue.md');

const BUCKET_ORDER = ['Yours', 'Prep', 'Dispatch', 'Skip'];
const BUCKET_HEAD = {
  Yours: '## Yours (Red): surface only, my call',
  Prep: '## Prep (Yellow): draft to 80% with my approval',
  Dispatch: '## Dispatch (Green): autonomous within tier',
  Skip: '## Skip (Gray): deferred',
};

function fmtItem(item) {
  const due = item.due_date ? ` due ${item.due_date}` : '';
  const proj = item.project ? ` [${item.project}]` : '';
  const tier = item.required_tier ? ` T${item.required_tier}` : '';
  const conf = typeof item.confidence === 'number' ? ` conf ${item.confidence.toFixed(2)}` : '';
  const sender = item.sender ? ` from ${item.sender}` : '';
  const action = item.proposed_action ? `\n  Proposed: ${item.proposed_action}` : '';
  const prov = (item.provenance ?? []).map((p) => `${p.type}:${p.ref}`).join(', ');
  const provLine = prov ? `\n  Source: ${prov}` : '';
  return `- **${item.id}**${proj} ${item.priority}${tier}${conf}${due}${sender}\n  ${item.summary}${action}${provLine}`;
}

function render() {
  const open = loadOpen();
  const overdue = queryOverdue();
  const out = [];
  const today = new Date().toISOString().slice(0, 10);

  out.push(`# Work queue`);
  out.push(``);
  out.push(`Generated ${new Date().toISOString()}. Canonical store at \`data/queue.jsonl\`.`);
  out.push(``);
  out.push(`Open items: ${open.length}. Overdue: ${overdue.length}.`);
  out.push(``);

  if (overdue.length) {
    out.push(`## Overdue`);
    out.push(``);
    for (const item of overdue) out.push(fmtItem(item));
    out.push(``);
  }

  const commitOut = queryByDirection('out');
  const commitIn = queryByDirection('in');
  if (commitOut.length || commitIn.length) {
    out.push(`## Commitments`);
    out.push(``);
    if (commitOut.length) {
      out.push(`### Out (I owe)`);
      for (const item of commitOut) {
        const cp = item.counterparty ? ` to ${item.counterparty}` : '';
        out.push(`- ${item.id}${cp} due ${item.due_date ?? 'no date'}: ${item.summary}`);
      }
      out.push(``);
    }
    if (commitIn.length) {
      out.push(`### In (owed to me)`);
      for (const item of commitIn) {
        const cp = item.counterparty ? ` from ${item.counterparty}` : '';
        out.push(`- ${item.id}${cp} due ${item.due_date ?? 'no date'}: ${item.summary}`);
      }
      out.push(``);
    }
  }

  const byBucket = new Map(BUCKET_ORDER.map((b) => [b, []]));
  for (const item of open) {
    if (byBucket.has(item.bucket)) byBucket.get(item.bucket).push(item);
  }
  for (const bucket of BUCKET_ORDER) {
    const items = byBucket.get(bucket);
    if (!items.length) continue;
    out.push(BUCKET_HEAD[bucket]);
    out.push(``);
    for (const item of items) out.push(fmtItem(item));
    out.push(``);
  }

  fs.writeFileSync(OUT_PATH, out.join('\n'), 'utf8');
  process.stdout.write(JSON.stringify({ ok: true, path: OUT_PATH, items: open.length, overdue: overdue.length, today }) + '\n');
}

render();
