#!/usr/bin/env node
// Chief of Staff: weekly compaction.
//
// Folds closed queue items, old decisions, and dormant relationships into a
// short narrative the agent reads at the top of /am-sweep. The working set
// stays light without losing context. Source data is not deleted; Markdown
// stays canonical and the JSONL queue is append-only. The digest is a
// derived view, regeneratable from source.
//
// Usage:
//   node tools/compact.mjs                     # write memory/digest-YYYY-WW.md for this week
//   node tools/compact.mjs --window-days 14    # how far back to count "this week's" closes
//   node tools/compact.mjs --dry-run           # print to stdout, do not write
//
// Each digest is one Markdown file per ISO week (digest-2026-W21.md). On
// rerun, the file is overwritten in place; older weeks are left alone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadQueue } from './queue.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ISO week number (1-53) and ISO week year. JS does not ship this; this is
// the canonical algorithm.
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return { year: d.getUTCFullYear(), week };
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400000).toISOString();
}

function parseDecisionsMd(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  let current = null;
  for (const line of lines) {
    const h2 = line.match(/^##\s+(\d{4}-\d{2}-\d{2}):\s+(.+?)\s*$/);
    const field = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);
    if (h2) {
      if (current) out.push(current);
      current = { date: h2[1], decision: h2[2].trim(), fields: {} };
    } else if (field && current) {
      current.fields[field[1].trim()] = field[2].trim();
    }
  }
  if (current) out.push(current);
  return out;
}

function topN(map, n = 5) {
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, n);
}

const args = parseArgs(process.argv);
const windowDays = Number(args['window-days'] ?? 7);
const dryRun = !!args['dry-run'];
const today = new Date();
const todayIso = today.toISOString().slice(0, 10);
const { year, week } = isoWeek(today);
const cutoffIso = daysAgoIso(windowDays);

const queueItems = Array.from(loadQueue().values());
const closedInWindow = queueItems.filter(
  (i) => (i.status === 'done' || i.status === 'dropped') && (i.updated_at ?? '') >= cutoffIso,
);
const openItems = queueItems.filter((i) => i.status === 'open' || i.status === 'in-flight');
const overdueItems = openItems.filter((i) => i.due_date && i.due_date < todayIso);

const decisionsRaw = fs.existsSync(path.join(REPO_ROOT, 'memory', 'decisions.md'))
  ? fs.readFileSync(path.join(REPO_ROOT, 'memory', 'decisions.md'), 'utf8')
  : '';
const decisions = parseDecisionsMd(decisionsRaw);
const decisionsInWindow = decisions.filter((d) => d.date >= cutoffIso.slice(0, 10));

const projectsByClosed = new Map();
const counterpartyByClosed = new Map();
for (const i of closedInWindow) {
  if (i.project) projectsByClosed.set(i.project, (projectsByClosed.get(i.project) ?? 0) + 1);
  const cp = i.counterparty || i.sender;
  if (cp) counterpartyByClosed.set(cp, (counterpartyByClosed.get(cp) ?? 0) + 1);
}

const lines = [];
lines.push(`# Weekly digest: ${year}-W${String(week).padStart(2, '0')}`);
lines.push('');
lines.push(`Generated ${today.toISOString()}.`);
lines.push('');
lines.push(`Window: closes since ${cutoffIso.slice(0, 10)} (${windowDays} days). Decisions since ${cutoffIso.slice(0, 10)}.`);
lines.push('');

lines.push(`## What I shipped`);
lines.push('');
if (closedInWindow.length === 0) {
  lines.push('Nothing closed in the window. Either I am not closing items or the queue is not being used.');
} else {
  lines.push(`${closedInWindow.length} queue items closed in the window.`);
  lines.push('');
  if (projectsByClosed.size) {
    lines.push('By project:');
    for (const [slug, n] of topN(projectsByClosed)) {
      lines.push(`- ${slug}: ${n}`);
    }
    lines.push('');
  }
  if (counterpartyByClosed.size) {
    lines.push('Top counterparties touched:');
    for (const [name, n] of topN(counterpartyByClosed)) {
      lines.push(`- ${name}: ${n}`);
    }
    lines.push('');
  }
}

lines.push(`## What stayed open`);
lines.push('');
if (openItems.length === 0) {
  lines.push('Queue is empty. Either the week was quiet or I have not run /am-sweep recently.');
} else {
  lines.push(`${openItems.length} open items as of today. ${overdueItems.length} overdue.`);
  if (overdueItems.length) {
    lines.push('');
    lines.push('Overdue:');
    for (const i of overdueItems) {
      const cp = i.counterparty ? ` (${i.counterparty})` : '';
      lines.push(`- ${i.due_date} ${i.id}${cp}: ${i.summary}`);
    }
  }
}
lines.push('');

lines.push(`## Decisions made`);
lines.push('');
if (decisionsInWindow.length === 0) {
  lines.push('No decisions logged in the window. If the week had real calls, run /commit.');
} else {
  lines.push(`${decisionsInWindow.length} decisions logged in the window.`);
  lines.push('');
  for (const d of decisionsInWindow.slice(0, 10)) {
    const proj = d.fields.Project ? ` [${d.fields.Project}]` : '';
    lines.push(`- ${d.date}${proj}: ${d.decision}`);
  }
}
lines.push('');

lines.push(`## Patterns to watch`);
lines.push('');
const patterns = [];
const oldOverdue = overdueItems.filter((i) => {
  const ageDays = Math.floor((today.getTime() - new Date(i.due_date).getTime()) / 86400000);
  return ageDays > 14;
});
if (oldOverdue.length) patterns.push(`${oldOverdue.length} items overdue by more than 14 days. Close, defer, or extend on purpose.`);
const noOwnerProjects = closedInWindow.filter((i) => !i.project).length;
if (noOwnerProjects > 3) patterns.push(`${noOwnerProjects} closed items had no project tag. The router is not routing.`);
if (patterns.length === 0) patterns.push('Nothing stands out.');
for (const p of patterns) lines.push(`- ${p}`);
lines.push('');

const body = lines.join('\n');
const outPath = path.join(REPO_ROOT, 'memory', `digest-${year}-W${String(week).padStart(2, '0')}.md`);

if (dryRun) {
  process.stdout.write(body);
} else {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, body, 'utf8');
  process.stdout.write(JSON.stringify({
    ok: true,
    path: outPath,
    closed_in_window: closedInWindow.length,
    open: openItems.length,
    overdue: overdueItems.length,
    decisions_in_window: decisionsInWindow.length,
  }) + '\n');
}
