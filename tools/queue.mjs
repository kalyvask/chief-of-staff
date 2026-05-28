// Chief of Staff: work queue.
//
// JSONL-backed item store. Each line in data/queue.jsonl is a full snapshot of
// one item; the latest snapshot per id wins on load. Append-only writes are
// crash-safe and tail-friendly. Compaction is a periodic rewrite via the CLI.
//
// Each item carries source, sender, due date, bucket, priority, confidence,
// proposed action, required tier, approval state, status, project, provenance,
// and audit. Provenance is an array of {type, ref, captured_at}. Audit is an
// array of {at, action, actor, rule}.
//
// Public API:
//   loadQueue()                        -> Map<id, item>
//   loadOpen()                         -> item[] (status === 'open')
//   getItem(id)                        -> item | null
//   addItem(partial, {actor, rule})    -> item (id assigned, audit started)
//   updateItem(id, patch, {actor, rule, action}) -> item
//   closeItem(id, outcome, {actor, rule})        -> item
//   queryOverdue(asOfISO)              -> item[]
//   queryByProject(slug)               -> item[]
//   queryByBucket(bucket)              -> item[]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const QUEUE_PATH = path.resolve(REPO_ROOT, 'data', 'queue.jsonl');

const BUCKETS = new Set(['Dispatch', 'Prep', 'Yours', 'Skip']);
const STATUSES = new Set(['open', 'in-flight', 'drafted', 'done', 'dropped']);
const APPROVAL_STATES = new Set(['pending', 'approved', 'denied']);
const PRIORITIES = new Set(['high', 'med', 'low']);

function ensureQueueFile() {
  const dir = path.dirname(QUEUE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(QUEUE_PATH)) fs.writeFileSync(QUEUE_PATH, '');
}

function nowIso() {
  return new Date().toISOString();
}

function readLines() {
  ensureQueueFile();
  const raw = fs.readFileSync(QUEUE_PATH, 'utf8');
  return raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
}

export function loadQueue() {
  const out = new Map();
  for (const line of readLines()) {
    try {
      const item = JSON.parse(line);
      if (item && item.id) out.set(item.id, item);
    } catch {
      // skip malformed line, keep going
    }
  }
  return out;
}

export function loadOpen() {
  const all = loadQueue();
  const open = [];
  for (const item of all.values()) {
    if (item.status === 'open' || item.status === 'in-flight') open.push(item);
  }
  open.sort((a, b) => {
    const dueA = a.due_date || '9999-12-31';
    const dueB = b.due_date || '9999-12-31';
    if (dueA !== dueB) return dueA.localeCompare(dueB);
    const order = { high: 0, med: 1, low: 2 };
    return (order[a.priority] ?? 1) - (order[b.priority] ?? 1);
  });
  return open;
}

export function getItem(id) {
  const all = loadQueue();
  return all.get(id) ?? null;
}

function newId(existing) {
  const today = new Date().toISOString().slice(0, 10);
  let n = 1;
  for (const id of existing.keys()) {
    if (id.startsWith(`q_${today}_`)) {
      const tail = parseInt(id.split('_')[2], 10);
      if (Number.isFinite(tail) && tail >= n) n = tail + 1;
    }
  }
  return `q_${today}_${String(n).padStart(3, '0')}`;
}

function validate(item) {
  if (item.bucket && !BUCKETS.has(item.bucket)) throw new Error(`bad bucket: ${item.bucket}`);
  if (item.status && !STATUSES.has(item.status)) throw new Error(`bad status: ${item.status}`);
  if (item.approval_state && !APPROVAL_STATES.has(item.approval_state)) throw new Error(`bad approval_state: ${item.approval_state}`);
  if (item.priority && !PRIORITIES.has(item.priority)) throw new Error(`bad priority: ${item.priority}`);
  if (typeof item.confidence === 'number' && (item.confidence < 0 || item.confidence > 1)) {
    throw new Error(`confidence must be in [0,1]`);
  }
  if (item.due_date && !/^\d{4}-\d{2}-\d{2}$/.test(item.due_date)) {
    throw new Error(`due_date must be YYYY-MM-DD: ${item.due_date}`);
  }
}

function writeSnapshot(item) {
  ensureQueueFile();
  fs.appendFileSync(QUEUE_PATH, JSON.stringify(item) + '\n', 'utf8');
}

export function addItem(partial, meta = {}) {
  const all = loadQueue();
  const id = partial.id || newId(all);
  if (all.has(id)) throw new Error(`item ${id} already exists; use updateItem`);

  const now = nowIso();
  const item = {
    id,
    created_at: now,
    updated_at: now,
    source: partial.source ?? 'manual',
    source_id: partial.source_id ?? null,
    sender: partial.sender ?? null,
    subject: partial.subject ?? null,
    summary: partial.summary ?? '',
    bucket: partial.bucket ?? 'Prep',
    priority: partial.priority ?? 'med',
    confidence: typeof partial.confidence === 'number' ? partial.confidence : null,
    due_date: partial.due_date ?? null,
    project: partial.project ?? null,
    proposed_action: partial.proposed_action ?? null,
    required_tier: typeof partial.required_tier === 'number' ? partial.required_tier : 0,
    approval_state: partial.approval_state ?? 'pending',
    status: partial.status ?? 'open',
    direction: partial.direction ?? null, // 'out' (I owe) | 'in' (owed to me) | null
    counterparty: partial.counterparty ?? null,
    provenance: Array.isArray(partial.provenance) ? partial.provenance.slice() : [],
    audit: [
      {
        at: now,
        action: 'created',
        actor: meta.actor ?? 'unknown',
        rule: meta.rule ?? null,
      },
    ],
  };
  validate(item);
  writeSnapshot(item);
  return item;
}

export function updateItem(id, patch, meta = {}) {
  const item = getItem(id);
  if (!item) throw new Error(`item ${id} not found`);
  const next = { ...item, ...patch, id };
  next.updated_at = nowIso();
  next.audit = (item.audit ?? []).concat([
    {
      at: next.updated_at,
      action: meta.action ?? 'updated',
      actor: meta.actor ?? 'unknown',
      rule: meta.rule ?? null,
      patch_keys: Object.keys(patch),
    },
  ]);
  validate(next);
  writeSnapshot(next);
  return next;
}

export function closeItem(id, outcome, meta = {}) {
  return updateItem(
    id,
    {
      status: outcome === 'dropped' ? 'dropped' : 'done',
      approval_state: meta.approval_state ?? 'approved',
      outcome: outcome ?? 'done',
    },
    { ...meta, action: 'closed' },
  );
}

export function addProvenance(id, entry, meta = {}) {
  const item = getItem(id);
  if (!item) throw new Error(`item ${id} not found`);
  const captured_at = entry.captured_at ?? nowIso();
  const provenance = (item.provenance ?? []).concat([{ ...entry, captured_at }]);
  return updateItem(id, { provenance }, { ...meta, action: 'provenance.added' });
}

// Inter-agent state: claim an open item for work. Atomic enough for our
// single-writer pattern: the JSONL is append-only, latest snapshot wins,
// and the audit trail makes contention visible. The contract:
//
//   claim(id, actor)
//     - If item is open + unclaimed: transition to in-flight, set assigned_to=actor.
//     - If item is in-flight by the same actor: idempotent.
//     - If item is in-flight by a different actor: throw with reason.
//     - If item is closed: throw with reason.
//
// This is the substrate for LLM-OS-style IPC: subagents coordinate by
// reading and writing each other's queue items, not by re-prompting from
// scratch. The router (chief-of-staff) reads claims to know which
// subagent is on what.
export function claimItem(id, actor, meta = {}) {
  const item = getItem(id);
  if (!item) throw new Error(`item ${id} not found`);
  if (item.status === 'done' || item.status === 'dropped') {
    throw new Error(`item ${id} is ${item.status}; cannot claim`);
  }
  if (item.status === 'in-flight' && item.assigned_to && item.assigned_to !== actor) {
    throw new Error(`item ${id} already claimed by ${item.assigned_to}`);
  }
  return updateItem(
    id,
    { status: 'in-flight', assigned_to: actor, claimed_at: nowIso() },
    { actor, rule: meta.rule ?? 'queue.claim', action: 'claimed' },
  );
}

export function releaseItem(id, actor, meta = {}) {
  const item = getItem(id);
  if (!item) throw new Error(`item ${id} not found`);
  if (item.assigned_to && item.assigned_to !== actor) {
    throw new Error(`item ${id} is claimed by ${item.assigned_to}, not ${actor}`);
  }
  return updateItem(
    id,
    { status: 'open', assigned_to: null },
    { actor, rule: meta.rule ?? 'queue.release', action: 'released' },
  );
}

// Load the full history of snapshots for one id. The JSONL is append-only,
// so this is just every line where the id matches, in file order.
export function loadHistory(id) {
  const out = [];
  for (const line of readLines()) {
    try {
      const item = JSON.parse(line);
      if (item.id === id) out.push(item);
    } catch {
      // skip bad line
    }
  }
  return out;
}

// Undo: write a new snapshot that restores the second-to-last state. The
// audit trail accumulates: the undone state stays in history, the new
// snapshot records the restore. There is no destructive delete.
export function undoItem(id, meta = {}) {
  const history = loadHistory(id);
  if (history.length < 2) {
    throw new Error(`item ${id} has no prior snapshot to restore`);
  }
  const previous = history[history.length - 2];
  const latest = history[history.length - 1];
  const now = nowIso();
  const next = { ...previous, updated_at: now };
  next.audit = (latest.audit ?? []).concat([
    {
      at: now,
      action: 'undone',
      actor: meta.actor ?? 'unknown',
      rule: meta.rule ?? 'queue.undo',
      restored_from: previous.updated_at,
      reverted_action: (latest.audit ?? []).slice(-1)[0]?.action ?? null,
    },
  ]);
  // We trust prior validity. Snapshot back.
  writeSnapshot(next);
  return next;
}

export function queryOverdue(asOfIso) {
  const asOf = (asOfIso ?? nowIso()).slice(0, 10);
  return loadOpen().filter((i) => i.due_date && i.due_date < asOf);
}

export function queryByProject(slug) {
  return loadOpen().filter((i) => i.project === slug);
}

export function queryByBucket(bucket) {
  return loadOpen().filter((i) => i.bucket === bucket);
}

export function queryByDirection(direction) {
  return loadOpen().filter((i) => i.direction === direction);
}

export function compact() {
  const all = loadQueue();
  const ordered = Array.from(all.values()).sort((a, b) =>
    (a.created_at || '').localeCompare(b.created_at || ''),
  );
  ensureQueueFile();
  const body = ordered.map((i) => JSON.stringify(i)).join('\n') + (ordered.length ? '\n' : '');
  fs.writeFileSync(QUEUE_PATH, body, 'utf8');
  return ordered.length;
}

export const PATHS = { QUEUE_PATH };
export const SCHEMA = { BUCKETS, STATUSES, APPROVAL_STATES, PRIORITIES };
