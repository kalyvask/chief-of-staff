#!/usr/bin/env node
// Chief of Staff: queue CLI.
//
// Thin wrapper over tools/queue.mjs so slash commands and humans can drive
// the queue from the shell. All commands print one JSON object per result
// line so output is easy to pipe into other tools.
//
// Commands:
//   add        --bucket Yours --priority high --due 2026-05-22 --summary "..."
//              --source gmail --source-id thread:abc --sender "Daniel <...>"
//              --project anthropic-pm-interview --proposed-action "..."
//              --required-tier 2 --provenance '{"type":"gmail.thread","ref":"abc"}'
//              --direction out|in --counterparty "Daniel Mercer"
//              --actor am-sweep --rule auto.gmail-classifier
//   list       [--bucket Yours] [--project X] [--direction out|in]
//              [--overdue] [--open|--all] [--limit 20]
//   show       <id>
//   update     <id> --bucket ... --priority ... --due ... --summary ...
//              --status open|in-flight|drafted|done|dropped
//              --approval pending|approved|denied
//              --proposed-action "..." --project ... --actor ... --rule ...
//   close      <id> [--outcome "..."] [--actor ...]
//   provenance <id> --type gmail.thread --ref abc123 [--actor ...]
//   overdue    [--as-of YYYY-MM-DD]
//   compact

import {
  addItem, updateItem, closeItem, addProvenance, getItem,
  loadOpen, loadQueue, queryOverdue, queryByProject, queryByBucket,
  queryByDirection, compact, claimItem, releaseItem, undoItem, loadHistory, PATHS,
} from './queue.mjs';

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

function jprint(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function fail(msg, code = 2) {
  process.stderr.write(`queue: ${msg}\n`);
  process.exit(code);
}

function parseProvenanceArg(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    fail(`--provenance must be a JSON object or array: ${e.message}`);
  }
}

function cmdAdd(args) {
  const partial = {
    bucket: args.bucket ?? 'Prep',
    priority: args.priority ?? 'med',
    due_date: args.due ?? null,
    summary: args.summary ?? '',
    source: args.source ?? 'manual',
    source_id: args['source-id'] ?? null,
    sender: args.sender ?? null,
    subject: args.subject ?? null,
    project: args.project ?? null,
    proposed_action: args['proposed-action'] ?? null,
    required_tier: args['required-tier'] !== undefined ? Number(args['required-tier']) : 0,
    approval_state: args.approval ?? 'pending',
    direction: args.direction ?? null,
    counterparty: args.counterparty ?? null,
    confidence: args.confidence !== undefined ? Number(args.confidence) : null,
    provenance: parseProvenanceArg(args.provenance),
  };
  if (typeof args.id === 'string') partial.id = args.id;
  const item = addItem(partial, {
    actor: args.actor ?? 'cli',
    rule: args.rule ?? null,
  });
  jprint(item);
}

function cmdList(args) {
  let items;
  if (args.overdue) {
    items = queryOverdue();
  } else if (args.project) {
    items = queryByProject(args.project);
  } else if (args.bucket) {
    items = queryByBucket(args.bucket);
  } else if (args.direction) {
    items = queryByDirection(args.direction);
  } else if (args.all) {
    items = Array.from(loadQueue().values());
  } else {
    items = loadOpen();
  }
  const limit = args.limit ? Number(args.limit) : items.length;
  for (const item of items.slice(0, limit)) jprint(item);
}

function cmdShow(args) {
  const id = args._[1];
  if (!id) fail('show requires an id');
  const item = getItem(id);
  if (!item) fail(`item ${id} not found`, 3);
  jprint(item);
}

function cmdUpdate(args) {
  const id = args._[1];
  if (!id) fail('update requires an id');
  const patch = {};
  if (args.bucket) patch.bucket = args.bucket;
  if (args.priority) patch.priority = args.priority;
  if (args.due) patch.due_date = args.due;
  if (args.summary) patch.summary = args.summary;
  if (args.status) patch.status = args.status;
  if (args.approval) patch.approval_state = args.approval;
  if (args['proposed-action']) patch.proposed_action = args['proposed-action'];
  if (args.project) patch.project = args.project;
  if (args.direction) patch.direction = args.direction;
  if (args.counterparty) patch.counterparty = args.counterparty;
  if (args.confidence !== undefined) patch.confidence = Number(args.confidence);
  if (args['required-tier'] !== undefined) patch.required_tier = Number(args['required-tier']);
  if (Object.keys(patch).length === 0) fail('update requires at least one field');
  const item = updateItem(id, patch, {
    actor: args.actor ?? 'cli',
    rule: args.rule ?? null,
    action: args['action-label'] ?? 'updated',
  });
  jprint(item);
}

function cmdClose(args) {
  const id = args._[1];
  if (!id) fail('close requires an id');
  const item = closeItem(id, args.outcome ?? 'done', {
    actor: args.actor ?? 'cli',
    rule: args.rule ?? null,
    approval_state: args.approval ?? 'approved',
  });
  jprint(item);
}

function cmdProvenance(args) {
  const id = args._[1];
  if (!id) fail('provenance requires an id');
  if (!args.type || !args.ref) fail('provenance requires --type and --ref');
  const item = addProvenance(
    id,
    { type: args.type, ref: args.ref, note: args.note ?? null },
    { actor: args.actor ?? 'cli', rule: args.rule ?? null },
  );
  jprint(item);
}

function cmdOverdue(args) {
  for (const item of queryOverdue(args['as-of'])) jprint(item);
}

function cmdCompact() {
  const n = compact();
  jprint({ ok: true, items: n, path: PATHS.QUEUE_PATH });
}

function cmdClaim(args) {
  const id = args._[1];
  if (!id) fail('claim requires an id');
  if (!args.actor) fail('claim requires --actor');
  try {
    const item = claimItem(id, args.actor, { rule: args.rule ?? null });
    jprint(item);
  } catch (e) {
    fail(e.message, 3);
  }
}

function cmdRelease(args) {
  const id = args._[1];
  if (!id) fail('release requires an id');
  if (!args.actor) fail('release requires --actor');
  try {
    const item = releaseItem(id, args.actor, { rule: args.rule ?? null });
    jprint(item);
  } catch (e) {
    fail(e.message, 3);
  }
}

function cmdUndo(args) {
  const id = args._[1];
  if (!id) fail('undo requires an id');
  try {
    const item = undoItem(id, { actor: args.actor ?? 'cli', rule: args.rule ?? null });
    jprint(item);
  } catch (e) {
    fail(e.message, 3);
  }
}

function cmdHistory(args) {
  const id = args._[1];
  if (!id) fail('history requires an id');
  const snapshots = loadHistory(id);
  if (!snapshots.length) fail(`no history for ${id}`, 3);
  for (const snap of snapshots) {
    const last = (snap.audit ?? []).slice(-1)[0];
    jprint({
      id: snap.id,
      updated_at: snap.updated_at,
      status: snap.status,
      approval_state: snap.approval_state,
      bucket: snap.bucket,
      assigned_to: snap.assigned_to ?? null,
      last_action: last?.action ?? null,
      last_actor: last?.actor ?? null,
    });
  }
}

const args = parseArgs(process.argv);
const cmd = args._[0];

switch (cmd) {
  case 'add':        cmdAdd(args); break;
  case 'list':       cmdList(args); break;
  case 'show':       cmdShow(args); break;
  case 'update':     cmdUpdate(args); break;
  case 'close':      cmdClose(args); break;
  case 'provenance': cmdProvenance(args); break;
  case 'overdue':    cmdOverdue(args); break;
  case 'compact':    cmdCompact(); break;
  case 'claim':      cmdClaim(args); break;
  case 'release':    cmdRelease(args); break;
  case 'undo':       cmdUndo(args); break;
  case 'history':    cmdHistory(args); break;
  default:
    process.stdout.write(
      'usage: node tools/queue-cli.mjs <add|list|show|update|close|provenance|overdue|compact|claim|release|undo|history> [...args]\n',
    );
    if (cmd) fail(`unknown command: ${cmd}`);
    process.exit(0);
}
