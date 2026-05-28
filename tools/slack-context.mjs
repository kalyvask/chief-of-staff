// Chief of Staff: Slack reply context loader.
//
// Pre-renders Alex's current "what matters today" state into a single Markdown
// block that the Slack reply endpoint drops into its system prompt. The block
// is intentionally deterministic (sorted, no per-call timestamps) so prompt
// caching at Anthropic's API hits across requests when the underlying state
// is stable.
//
// What's in it:
//   - Stakeholders (context/stakeholders.md + .local.md)
//   - Active priorities (context/priorities.md + .local.md)
//   - Top open queue items (bucket Yours or Prep), one-line render
//   - Last N decisions (memory/decisions.md + .local.md)
//   - One-line status of each active project (projects/<slug>/status.md, skipping _template*)
//
// What's deliberately NOT in it (reachable from the laptop, would bloat the
// prompt for marginal Slack value):
//   - career_thesis.md, operating_principles.md, research_arc.md
//   - Full project notes / decisions / contacts
//   - Closed queue items
//   - Audit logs
//
// Public API:
//   loadSlackContext({maxQueueItems = 10, decisionCount = 5}) ->
//     {context: string, fingerprint: string, sections: {...counts}}
//   SLACK_REPLY_SYSTEM_BASE -> string (the voice + scope prompt for Slack
//     replies; shared between server.mjs and the eval runner so they cannot
//     drift)

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadOpen } from './queue.mjs';

export const SLACK_REPLY_SYSTEM_BASE = `You are Alex's chief-of-staff agent responding via Slack. You have access to a live context block (below the base instructions) with Alex's current stakeholders, priorities, open queue items, recent decisions, and active projects. Use it.

VOICE (hard, audited by tools/conform.mjs):
- Never use em dashes. Use commas, periods, parentheses, or restructure.
- Never use AI tells: "delve", "navigate the landscape", "unlock", "leverage" as a verb, "in the world of", "not just X also Y".
- Never use flattery: no "great question", "happy to help", "absolutely", "I hope this finds you well", "just wanted to circle back".
- First-person Alex voice. Direct. Tight. Match the formality of the message you received.

CITING THE CONTEXT (hard):
- When the user asks about something covered in the context, cite specific items by name (queue id like q_2026-05-26_005, stakeholder name, project slug, decision date). Generic answers when the context has specifics are worse than no answer.
- Never invent stakeholders, queue items, projects, or decisions that are not in the context block. If the user asks about something not there, say so explicitly: "I do not have <X> in your current state."
- For ambiguous queries ("what's important?", "thoughts?"), summarize the top 2-3 items from the queue and ask which to drill into.

SCOPE:
- Keep responses under 120 words unless explicitly asked for more.
- For requests that need the full agent (deep queue review, drafting actual emails, project planning): sketch the answer here and add "for the full version run /am-sweep or /prep at the laptop".
- For requests that need external action (send email, schedule, mutate memory files): say Alex needs to confirm at the laptop. Do not pretend to have taken action.
- For simple queries (next item, brainstorm a reply, summarize, sanity-check a thought): answer directly using the context block.

Output ONLY the message body. No "Sure!" or "Here's my response:" preamble. Plain text, no markdown headers.`;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function readFileOr(relPath, fallback = '') {
  const full = path.resolve(REPO_ROOT, relPath);
  if (!fs.existsSync(full)) return fallback;
  try {
    return fs.readFileSync(full, 'utf8');
  } catch {
    return fallback;
  }
}

function readWithLocal(relPath) {
  const tracked = readFileOr(relPath, '');
  const local = readFileOr(relPath.replace(/\.md$/, '.local.md'), '');
  if (!tracked && !local) return '';
  if (!local) return tracked;
  if (!tracked) return local;
  return tracked + '\n\n---\n\n' + local;
}

function trimSection(text, maxLines = 200) {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n\n[... ${lines.length - maxLines} more lines truncated; read at the laptop for full content ...]`;
}

function renderQueueItem(item) {
  const parts = [
    `[${item.id}]`,
    `${item.bucket}/${item.priority}`,
    item.summary || '(no summary)',
  ];
  if (item.due_date) parts.push(`(due ${item.due_date})`);
  if (item.project) parts.push(`{${item.project}}`);
  return '- ' + parts.join(' ');
}

function loadProjects() {
  const projectsDir = path.resolve(REPO_ROOT, 'projects');
  if (!fs.existsSync(projectsDir)) return [];
  const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  const projects = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('_template')) continue;
    if (entry.name.startsWith('.')) continue;
    const statusPath = path.join(projectsDir, entry.name, 'status.md');
    if (!fs.existsSync(statusPath)) continue;
    let text = '';
    try { text = fs.readFileSync(statusPath, 'utf8'); } catch { continue; }
    // First non-empty, non-heading paragraph as the one-liner.
    const firstPara = text
      .split(/\r?\n\s*\r?\n/)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#')) ?? '(no status)';
    projects.push({ slug: entry.name, status: firstPara.replace(/\s+/g, ' ').slice(0, 240) });
  }
  projects.sort((a, b) => a.slug.localeCompare(b.slug));
  return projects;
}

function loadRecentDecisions(n) {
  const text = readWithLocal('memory/decisions.md');
  if (!text) return [];
  // Decisions file convention: "## YYYY-MM-DD: <one-line decision>"
  const blocks = text.split(/\n(?=## \d{4}-\d{2}-\d{2})/);
  const entries = blocks
    .map((b) => b.trim())
    .filter((b) => /^## \d{4}-\d{2}-\d{2}/.test(b));
  // Newest first if the file uses "append at top". The convention is newest-at-top
  // per MOBILE.md, so the first N blocks are the most recent.
  return entries.slice(0, n).map((b) => {
    // Compact: first two lines max
    const lines = b.split(/\r?\n/).filter((l) => l.trim());
    return lines.slice(0, 3).join('\n');
  });
}

export function loadSlackContext({ maxQueueItems = 10, decisionCount = 5 } = {}) {
  const stakeholders = trimSection(readWithLocal('context/stakeholders.md'), 250);
  const priorities = trimSection(readWithLocal('context/priorities.md'), 100);

  const open = loadOpen()
    .filter((i) => i.bucket === 'Yours' || i.bucket === 'Prep')
    .filter((i) => i.source !== 'eval'); // skip test items

  // Priority order: high > med > low, then bucket (Yours before Prep).
  const priorityRank = { high: 0, med: 1, low: 2 };
  const bucketRank = { Yours: 0, Prep: 1 };
  open.sort((a, b) => {
    const p = (priorityRank[a.priority] ?? 1) - (priorityRank[b.priority] ?? 1);
    if (p !== 0) return p;
    return (bucketRank[a.bucket] ?? 9) - (bucketRank[b.bucket] ?? 9);
  });
  const topQueue = open.slice(0, maxQueueItems);

  const decisions = loadRecentDecisions(decisionCount);
  const projects = loadProjects();

  const sections = {
    stakeholders_chars: stakeholders.length,
    priorities_chars: priorities.length,
    queue_items: topQueue.length,
    decisions: decisions.length,
    projects: projects.length,
  };

  const blocks = [];

  blocks.push('## Alex\'s current state');
  blocks.push('Live context synced from disk. Cite specific queue ids, stakeholder names, project slugs, and decision dates when relevant. Never invent items not listed here.');

  blocks.push('\n### Stakeholders');
  blocks.push(stakeholders || '(no stakeholders on file)');

  blocks.push('\n### Active priorities');
  blocks.push(priorities || '(no priorities on file)');

  blocks.push('\n### Top open queue items (Yours + Prep, sorted by priority)');
  if (topQueue.length === 0) {
    blocks.push('(none open)');
  } else {
    for (const item of topQueue) blocks.push(renderQueueItem(item));
  }

  blocks.push('\n### Recent decisions');
  if (decisions.length === 0) {
    blocks.push('(none on file)');
  } else {
    for (const d of decisions) blocks.push(d);
  }

  blocks.push('\n### Active projects (one-line status)');
  if (projects.length === 0) {
    blocks.push('(none)');
  } else {
    for (const p of projects) blocks.push(`- **${p.slug}**: ${p.status}`);
  }

  const context = blocks.join('\n');
  const fingerprint = crypto.createHash('sha256').update(context).digest('hex').slice(0, 16);

  return { context, fingerprint, sections };
}
