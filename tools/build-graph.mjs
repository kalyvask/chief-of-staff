#!/usr/bin/env node
// Build data/graph.json as a derived view over the Markdown context library.
// Markdown stays the source of truth; this regenerates on demand or as part of /retro.
//
// Usage:
//   node tools/build-graph.mjs
//   node tools/build-graph.mjs --verbose
//   node tools/build-graph.mjs --out data/graph.json

import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { loadQueue } from './queue.mjs';
import { extractFromEntity } from './entities.mjs';

const __filename = url.fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function read(rel) {
  const full = path.join(repoRoot, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

// Read a tracked .md template plus an optional gitignored .local.md sibling,
// parse both, and merge by id (local overrides template on collision). This is
// how personal data (relationships, meetings) stays out of the public repo
// while the graph still sees everything.
function parseMergedFiles(relPath, parser) {
  const localPath = relPath.replace(/\.md$/, '.local.md');
  const entries = [];
  const main = read(relPath);
  const local = read(localPath);
  if (main) entries.push(...parser(main));
  if (local) entries.push(...parser(local));
  const byId = new Map();
  for (const e of entries) byId.set(e.id, e);
  return Array.from(byId.values());
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function isPlaceholder(value) {
  if (!value) return true;
  const raw = String(value).trim();
  if (raw === '' || /^_+$/.test(raw)) return true;
  const unwrapped = raw.replace(/^_+/, '').replace(/_+$/, '').trim();
  return /^to (fill in|confirm)\b/i.test(unwrapped) || unwrapped === '';
}

function canonicalBucket(name) {
  const lower = String(name).toLowerCase();
  if (/^this quarter\b/.test(lower)) return 'this-quarter';
  if (/^this month\b/.test(lower)) return 'this-month';
  if (/^this week\b/.test(lower)) return 'this-week';
  if (/^on hold\b/.test(lower) || /^deferred\b/.test(lower)) return 'on-hold';
  if (/anti-?priorit/.test(lower)) return 'anti-priorities';
  if (/^reference\b/.test(lower)) return 'reference';
  return slug(name);
}

// Parse a file shaped as:
//   ## Category
//   ### Entity Name
//   **Field:** value
//   (free text)
//   ### Another Entity
function parseSectionedEntities(text) {
  const lines = text.split(/\r?\n/);
  const entities = [];
  let category = null;
  let current = null;
  let buffer = [];

  const flushBuffer = () => {
    if (buffer.length && current) {
      const remaining = buffer.join('\n').trim();
      if (remaining) current.notes = (current.notes ? current.notes + '\n' : '') + remaining;
    }
    buffer = [];
  };

  const flushEntity = () => {
    if (current) {
      flushBuffer();
      entities.push(current);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const h3 = line.match(/^###\s+(.+?)\s*$/);
    const field = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);

    if (h2) {
      flushEntity();
      category = h2[1].trim();
    } else if (h3) {
      flushEntity();
      const name = h3[1].trim();
      current = {
        id: slug(name),
        name,
        category,
        fields: {},
        line: i + 1,
      };
    } else if (field && current) {
      flushBuffer();
      current.fields[field[1].trim()] = {
        value: field[2].trim(),
        placeholder: isPlaceholder(field[2]),
      };
    } else if (current && line.trim()) {
      buffer.push(line);
    }
  }
  flushEntity();
  return entities;
}

// Decisions: `## YYYY-MM-DD: <one-line>` with bold-label fields.
function parseDecisions(text) {
  const lines = text.split(/\r?\n/);
  const decisions = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+(\d{4}-\d{2}-\d{2}):\s+(.+?)\s*$/);
    const field = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);

    if (h2) {
      if (current) decisions.push(current);
      current = {
        id: `decision-${h2[1]}-${slug(h2[2].slice(0, 40))}`,
        date: h2[1],
        decision: h2[2].trim(),
        fields: {},
        line: i + 1,
      };
    } else if (field && current) {
      const key = field[1].trim();
      const value = field[2].trim();
      current.fields[key] = value;
      if (/^stakeholders$/i.test(key)) {
        current.stakeholders = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      }
    }
  }
  if (current) decisions.push(current);
  return decisions;
}

// Relationships: per-person entries shaped as `## <Name> (<role>)` with
// bold-label fields. Distinct from stakeholders.md which uses H2-as-category
// plus H3-as-entity. The id strips any parenthetical role suffix so the entry
// can match a stakeholders.md id by short name (e.g. "Sarah (Acme)" → "sarah").
function parseRelationships(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let current = null;

  const flushCurrent = () => {
    if (current) entries.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const field = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);

    if (h2) {
      flushCurrent();
      const name = h2[1].trim();
      const cleanName = name.replace(/\s*\([^)]*\)\s*$/, '').trim();
      current = {
        id: slug(cleanName),
        name,
        fields: {},
        line: i + 1,
      };
    } else if (field && current) {
      current.fields[field[1].trim()] = {
        value: field[2].trim(),
        placeholder: isPlaceholder(field[2]),
      };
    }
  }
  flushCurrent();
  return entries;
}

// Meetings: `## YYYY-MM-DD: <title>` with bold-label fields.
// Format intended to match decisions.md. Written by /debrief and
// /bootstrap-relationships; the graph reads it for meeting nodes and the
// derived attended / commitment_from / decision_from / last_meeting_at edges.
function parseMeetings(text) {
  const lines = text.split(/\r?\n/);
  const meetings = [];
  let current = null;

  const flushCurrent = () => {
    if (current) meetings.push(current);
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h2 = line.match(/^##\s+(\d{4}-\d{2}-\d{2}):\s+(.+?)\s*$/);
    const field = line.match(/^\*\*([^:*]+):\*\*\s*(.*)$/);

    if (h2) {
      flushCurrent();
      const date = h2[1];
      const title = h2[2].trim();
      current = {
        id: `meeting-${date}-${slug(title.slice(0, 40))}`,
        date,
        title,
        fields: {},
        attendees: [],
        commitments: [],
        decision_refs: [],
        granola_id: null,
        project: null,
        topic: null,
        debrief: null,
        line: i + 1,
      };
    } else if (field && current) {
      const key = field[1].trim();
      const value = field[2].trim();
      current.fields[key] = value;
      if (/^attendees$/i.test(key)) {
        current.attendees = value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      } else if (/^commitments$/i.test(key)) {
        current.commitments = value === 'none' || !value
          ? []
          : value.split(/[,;\s]+/).map((s) => s.trim()).filter((s) => /^q_/.test(s));
      } else if (/^decisions$/i.test(key)) {
        current.decision_refs = value === 'none' || !value
          ? []
          : value.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
      } else if (/^granola id$/i.test(key)) {
        current.granola_id = value === 'none' || !value ? null : value;
      } else if (/^project$/i.test(key)) {
        current.project = (value === 'unscoped' || value === 'none' || !value) ? null : value;
      } else if (/^topic$/i.test(key)) {
        current.topic = value || null;
      } else if (/^debrief$/i.test(key)) {
        current.debrief = (value === 'none' || !value) ? null : value;
      }
    }
  }
  flushCurrent();
  return meetings;
}

// Priorities: H2 buckets, mix of list items and prose.
function parsePriorities(text) {
  const lines = text.split(/\r?\n/);
  const buckets = {};
  let bucket = null;
  let items = [];
  let prose = [];

  const flush = () => {
    if (bucket) {
      buckets[bucket] = {
        items,
        prose: prose.join('\n').trim(),
      };
    }
    items = [];
    prose = [];
  };

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    const listItem = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);

    if (h2) {
      flush();
      bucket = canonicalBucket(h2[1]);
    } else if (listItem && bucket) {
      items.push(listItem[1].trim());
    } else if (bucket && line.trim() && !line.startsWith('|') && !line.startsWith('---')) {
      prose.push(line.trim());
    }
  }
  flush();
  return buckets;
}

// Try to extract a YYYY-MM-DD from any string.
function extractDate(value) {
  if (!value) return null;
  const m = String(value).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

// Parse projects/<slug>/status.md headers for each live project folder.
// Live projects are folders that do not start with `_` (so `_template/` is
// skipped). Returns [{slug, last_updated, confidence, owner, target, line}].
function parseProjectsDir() {
  const projectsRoot = path.join(repoRoot, 'projects');
  if (!fs.existsSync(projectsRoot)) return [];
  const out = [];
  for (const name of fs.readdirSync(projectsRoot)) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const dir = path.join(projectsRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const statusPath = path.join(dir, 'status.md');
    let last_updated = null, confidence = null, owner = null, target = null;
    if (fs.existsSync(statusPath)) {
      const text = fs.readFileSync(statusPath, 'utf8');
      const u = text.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/);
      if (u) last_updated = u[1];
      const c = text.match(/Confidence:\*\*\s*([HMLhml])/);
      if (c) confidence = c[1].toUpperCase();
      const o = text.match(/Owner:\*\*\s*(.+)/);
      if (o) owner = o[1].trim();
      const t = text.match(/Target close \/ decision date:\*\*\s*(.+)/);
      if (t) target = t[1].trim();
    }
    out.push({
      id: `project:${name}`,
      slug: name,
      last_updated,
      confidence,
      owner,
      target,
    });
  }
  return out;
}

// Resolve a counterparty / sender string (which may include "Name <email>"
// or just an email) to a stakeholder id by name match. Returns null if not
// found.
function resolveCounterparty(raw, nameMap) {
  if (!raw) return null;
  // Strip <email> portion and Reply-To noise.
  const cleaned = String(raw).replace(/<[^>]*>/g, '').replace(/[(].*?[)]/g, '').trim();
  if (!cleaned) return null;
  const lower = cleaned.toLowerCase();
  if (nameMap[lower]) return nameMap[lower];
  // Try first name match (best-effort).
  const first = lower.split(/\s+/)[0];
  for (const [name, id] of Object.entries(nameMap)) {
    if (name.split(/\s+/)[0] === first) return id;
  }
  return null;
}

// Main
const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const outIdx = argv.indexOf('--out');
const outPath = outIdx >= 0 ? argv[outIdx + 1] : 'data/graph.json';

const stakeholders = (read('context/stakeholders.md') ? parseSectionedEntities(read('context/stakeholders.md')) : []);
const relationships = parseMergedFiles('memory/relationships.md', parseRelationships);
const decisions = parseMergedFiles('memory/decisions.md', parseDecisions);
const priorities = (read('context/priorities.md') ? parsePriorities(read('context/priorities.md')) : {});
const projects = parseProjectsDir();
const meetings = parseMergedFiles('memory/meetings.md', parseMeetings);
const queueItemsMap = loadQueue();
const queueItems = Array.from(queueItemsMap.values()).map((item) => ({
  id: `queue:${item.id}`,
  queue_id: item.id,
  bucket: item.bucket,
  priority: item.priority,
  status: item.status,
  approval_state: item.approval_state,
  required_tier: item.required_tier,
  due_date: item.due_date,
  project: item.project,
  direction: item.direction,
  counterparty: item.counterparty,
  sender: item.sender,
  summary: item.summary,
  source: item.source,
  source_id: item.source_id,
  provenance: item.provenance ?? [],
  created_at: item.created_at,
  updated_at: item.updated_at,
}));

// Build typed edges.
const edges = [];
const nameMap = Object.fromEntries(stakeholders.map((s) => [s.name.toLowerCase(), s.id]));

// member_of: stakeholder -> category
for (const s of stakeholders) {
  if (s.category) edges.push({ type: 'member_of', from: s.id, to: slug(s.category) });
}

// last_interaction_at: stakeholder -> date, sourced from relationships.md
const relMap = Object.fromEntries(relationships.map((r) => [r.id, r]));
for (const s of stakeholders) {
  const rel = relMap[s.id];
  if (!rel) continue;
  const lastKey = Object.keys(rel.fields).find((k) => /last interaction/i.test(k));
  if (lastKey && !rel.fields[lastKey].placeholder) {
    edges.push({
      type: 'last_interaction_at',
      from: s.id,
      when: extractDate(rel.fields[lastKey].value),
      details: rel.fields[lastKey].value,
    });
  }
}

// mentions: decision -> stakeholder (resolved by name match)
for (const d of decisions) {
  if (!d.stakeholders) continue;
  for (const sn of d.stakeholders) {
    const id = nameMap[sn.toLowerCase()];
    if (id) edges.push({ type: 'mentions', from: d.id, to: id });
    else edges.push({ type: 'mentions_unresolved', from: d.id, raw_name: sn });
  }
}

// Stale-relationship hint: anyone in stakeholders with no last_interaction_at edge.
const haveInteraction = new Set(edges.filter((e) => e.type === 'last_interaction_at').map((e) => e.from));
for (const s of stakeholders) {
  if (!haveInteraction.has(s.id)) {
    edges.push({ type: 'no_logged_interaction', from: s.id });
  }
}

// Project membership: queue item belongs to a project.
const projectIds = new Set(projects.map((p) => p.slug));
for (const item of queueItems) {
  if (item.project && projectIds.has(item.project)) {
    edges.push({ type: 'item_in_project', from: item.id, to: `project:${item.project}` });
  }
}

// Open item count by project: for fast surface in /am-sweep and dashboards.
const openByProject = {};
for (const item of queueItems) {
  if (!item.project) continue;
  if (item.status === 'open' || item.status === 'in-flight') {
    openByProject[item.project] = (openByProject[item.project] ?? 0) + 1;
  }
}
for (const [slug, count] of Object.entries(openByProject)) {
  if (projectIds.has(slug)) {
    edges.push({ type: 'project_open_item_count', from: `project:${slug}`, count });
  }
}

// Queue counterparty: link items to stakeholders by name match on counterparty
// or sender. Unresolved names become a backfill signal.
for (const item of queueItems) {
  const cpRaw = item.counterparty || item.sender;
  if (!cpRaw) continue;
  const sid = resolveCounterparty(cpRaw, nameMap);
  if (sid) {
    if (item.direction === 'out') {
      edges.push({ type: 'i_owe', from: item.id, to: sid, due: item.due_date ?? null });
    } else if (item.direction === 'in') {
      edges.push({ type: 'owed_to_me', from: item.id, to: sid, due: item.due_date ?? null });
    } else {
      edges.push({ type: 'item_with', from: item.id, to: sid });
    }
  } else {
    edges.push({ type: 'item_with_unresolved', from: item.id, raw_name: cpRaw });
  }
}

// Decision-to-project: resolve from the decision's "Project:" field (set by /commit).
for (const d of decisions) {
  const projField = d.fields && d.fields['Project'];
  if (projField && projField !== 'unscoped' && projectIds.has(projField)) {
    edges.push({ type: 'decision_in_project', from: d.id, to: `project:${projField}` });
  }
}

// Project status freshness: flag stale projects (status.md > 21 days).
const today = new Date();
for (const p of projects) {
  if (!p.last_updated) {
    edges.push({ type: 'project_status_missing', from: `project:${p.slug}` });
    continue;
  }
  const ageDays = Math.floor((today.getTime() - new Date(p.last_updated).getTime()) / 86400000);
  if (ageDays > 21) {
    edges.push({ type: 'project_status_stale', from: `project:${p.slug}`, age_days: ageDays });
  }
}

// Provenance edges from queue items to upstream signals (gmail/calendar/manual).
for (const item of queueItems) {
  for (const p of item.provenance ?? []) {
    edges.push({ type: 'provenance_of', from: item.id, signal_type: p.type, signal_ref: p.ref });
  }
}

// --- Meeting edges -------------------------------------------------------
// Meeting -> attendee. Resolves the attendee name against stakeholders.md.
// Unresolved names become attended_unresolved (signal for the backfill).
for (const m of meetings) {
  for (const a of m.attendees) {
    const sid = nameMap[a.toLowerCase()] ?? resolveCounterparty(a, nameMap);
    if (sid) {
      edges.push({ type: 'attended', from: sid, to: m.id, date: m.date });
    } else {
      edges.push({ type: 'attended_unresolved', from: m.id, raw_name: a, date: m.date });
    }
  }
}

// Meeting -> queue commitment.
for (const m of meetings) {
  for (const cid of m.commitments) {
    edges.push({ type: 'commitment_from', from: m.id, to: `queue:${cid}` });
  }
}

// Meeting -> decision.
for (const m of meetings) {
  for (const dref of m.decision_refs) {
    edges.push({ type: 'decision_from', from: m.id, to: dref });
  }
}

// Meeting -> project.
for (const m of meetings) {
  if (m.project && projectIds.has(m.project)) {
    edges.push({ type: 'meeting_in_project', from: m.id, to: `project:${m.project}` });
  }
}

// last_meeting_at: stakeholder -> most recent meeting date derived from attended edges.
// warmListDormant in graph-query.mjs takes the max of last_interaction_at and last_meeting_at.
const stakeholderLastMeeting = new Map();
for (const e of edges) {
  if (e.type !== 'attended' || !e.date) continue;
  const cur = stakeholderLastMeeting.get(e.from);
  if (!cur || e.date > cur) stakeholderLastMeeting.set(e.from, e.date);
}
for (const [sid, when] of stakeholderLastMeeting.entries()) {
  edges.push({ type: 'last_meeting_at', from: sid, when });
}

// Zero-LLM entity extraction: walk every text surface and add typed edges
// (works_at, founded, invested_in, advises, mentions_company, mentions_email,
// mentions_url). See tools/entities.mjs. Conservative by default.
for (const s of stakeholders) {
  for (const e of extractFromEntity(s, 'stakeholder')) edges.push(e);
}
for (const r of relationships) {
  for (const e of extractFromEntity(r, 'relationship')) edges.push(e);
}
for (const d of decisions) {
  for (const e of extractFromEntity(d, 'decision')) edges.push(e);
}
for (const m of meetings) {
  for (const e of extractFromEntity(m, 'meeting')) edges.push(e);
}

const extractedTypeCounts = edges.reduce((acc, e) => {
  if (e.source === 'entities') acc[e.type] = (acc[e.type] ?? 0) + 1;
  return acc;
}, {});

const placeholderCount = stakeholders.reduce((acc, s) =>
  acc + Object.values(s.fields).filter((f) => f.placeholder).length, 0);

const graph = {
  generated_at: new Date().toISOString(),
  source: {
    stakeholders: 'context/stakeholders.md',
    relationships: 'memory/relationships.md',
    decisions: 'memory/decisions.md',
    priorities: 'context/priorities.md',
    projects: 'projects/',
    meetings: 'memory/meetings.md',
    queue: 'data/queue.jsonl',
  },
  stakeholders,
  relationships,
  decisions,
  priorities,
  projects,
  meetings,
  queue_items: queueItems,
  edges,
  stats: {
    stakeholder_count: stakeholders.length,
    relationship_count: relationships.length,
    decision_count: decisions.length,
    priority_buckets: Object.keys(priorities).length,
    project_count: projects.length,
    meeting_count: meetings.length,
    queue_item_count: queueItems.length,
    open_queue_count: queueItems.filter((i) => i.status === 'open' || i.status === 'in-flight').length,
    edge_count: edges.length,
    placeholder_count: placeholderCount,
    stale_relationship_count: edges.filter((e) => e.type === 'no_logged_interaction').length,
    stale_project_count: edges.filter((e) => e.type === 'project_status_stale').length,
    unresolved_counterparty_count: edges.filter((e) => e.type === 'item_with_unresolved').length,
    unresolved_attendee_count: edges.filter((e) => e.type === 'attended_unresolved').length,
    extracted_edge_count: Object.values(extractedTypeCounts).reduce((a, b) => a + b, 0),
    extracted_edge_counts: extractedTypeCounts,
  },
};

const outFull = path.join(repoRoot, outPath);
fs.mkdirSync(path.dirname(outFull), { recursive: true });
fs.writeFileSync(outFull, JSON.stringify(graph, null, 2), 'utf8');

if (verbose) console.log(JSON.stringify(graph.stats, null, 2));
console.log(
  `graph written to ${outPath} (${graph.stats.stakeholder_count} stakeholders, ${graph.stats.decision_count} decisions, ${graph.stats.project_count} projects, ${graph.stats.meeting_count} meetings, ${graph.stats.queue_item_count} queue items, ${graph.stats.edge_count} edges, ${graph.stats.placeholder_count} placeholders)`
);
