#!/usr/bin/env node
// Chief of Staff: demo mode seed.
//
// Seeds 8 sample queue items, one sample project, and a few conform audit
// entries so a new user can `npm run cos:demo` and see the substrate UI
// populated without setting up MCP / OAuth / SMTP. The chat endpoint will
// return a stub message ("demo mode active") under COS_DEMO=1.
//
// All demo items carry a `demo:true` flag in their provenance so cleanup
// can find them without affecting real data.
//
// Usage:
//   node tools/demo.mjs            # seed
//   node tools/demo.mjs --cleanup  # close all demo items, remove demo project

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addItem, loadOpen, closeItem, getItem } from './queue.mjs';
import { audit } from './conform.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const DEMO_PROJECT = 'demo-product-launch';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

function todayPlus(days) {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
}

const SAMPLES = [
  {
    bucket: 'Yours', priority: 'high', due: todayPlus(2),
    summary: 'Decide pricing tiers for v1 launch',
    sender: 'Maya Chen <maya@example.com>',
    project: DEMO_PROJECT,
    proposed_action: 'Review the three pricing options Maya sent. Pick one or ask for a fourth.',
    source: 'gmail', sourceId: 'thread:demo-pricing',
  },
  {
    bucket: 'Prep', priority: 'high', due: todayPlus(1),
    summary: 'Draft reply to investor about Q3 metrics',
    sender: 'Daniel Mercer <daniel@example.com>',
    project: DEMO_PROJECT,
    proposed_action: 'Acknowledge the question, confirm Q3 ARR, ask if he wants the cohort breakdown.',
    source: 'gmail', sourceId: 'thread:demo-investor',
    direction: 'out', counterparty: 'Daniel Mercer',
  },
  {
    bucket: 'Prep', priority: 'med', due: todayPlus(3),
    summary: 'Prep one-pager for Thursday board meeting',
    project: DEMO_PROJECT,
    proposed_action: 'Pull last quarters numbers; draft the three-slide deck.',
    source: 'calendar', sourceId: 'event:demo-board',
  },
  {
    bucket: 'Dispatch', priority: 'low',
    summary: 'Archive Stripe + AWS billing newsletters from this week',
    sender: 'noreply@stripe.com',
    proposed_action: 'Archive after a 10-second scan; auto-OK.',
    source: 'gmail', sourceId: 'thread:demo-newsletter',
  },
  {
    bucket: 'Yours', priority: 'med', due: todayPlus(-1), // overdue!
    summary: 'Reply to Anthropic recruiter about onsite timing',
    sender: 'Recruiter <recruiter@example.com>',
    proposed_action: 'Confirm next Tuesday or push to the following week.',
    source: 'gmail', sourceId: 'thread:demo-recruiter',
    direction: 'in', counterparty: 'Anthropic recruiter',
  },
  {
    bucket: 'Skip', priority: 'low',
    summary: 'Internal panel invite that does not move the needle',
    sender: 'Events <events@example.com>',
    proposed_action: 'Decline politely; offer to introduce someone else.',
    source: 'gmail', sourceId: 'thread:demo-panel',
  },
  {
    bucket: 'Prep', priority: 'med', due: todayPlus(5),
    summary: 'Followup with Elena on intro to design lead',
    sender: 'Elena Costa <elena@example.com>',
    project: DEMO_PROJECT,
    proposed_action: 'Send the one-liner Elena asked for so she can forward.',
    source: 'manual', sourceId: 'note:demo-followup',
    direction: 'out', counterparty: 'Elena Costa',
  },
  {
    bucket: 'Yours', priority: 'high', due: todayPlus(4),
    summary: 'Decide whether to take the Stanford speaking slot',
    sender: 'Prof. Lee <plee@example.edu>',
    proposed_action: 'Conflicts with launch week. Probably decline. Surface for confirmation.',
    source: 'gmail', sourceId: 'thread:demo-stanford',
  },
];

function seed() {
  const created = [];
  for (const s of SAMPLES) {
    const item = addItem(
      {
        bucket: s.bucket,
        priority: s.priority,
        due_date: s.due ?? null,
        summary: s.summary,
        source: s.source,
        source_id: s.sourceId,
        sender: s.sender ?? null,
        project: s.project ?? null,
        proposed_action: s.proposed_action,
        direction: s.direction ?? null,
        counterparty: s.counterparty ?? null,
        required_tier: 0,
        provenance: [{ type: 'demo', ref: s.sourceId, note: 'seeded by tools/demo.mjs' }],
      },
      { actor: 'demo-seed', rule: 'demo.seed' },
    );
    created.push(item.id);
  }

  // Create the demo project folder.
  const projDir = path.join(REPO_ROOT, 'projects', DEMO_PROJECT);
  if (!fs.existsSync(projDir)) {
    fs.mkdirSync(projDir, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(
      path.join(projDir, 'status.md'),
      `# Demo: product launch\n\nLast updated: ${today}\n\n**Slug:** ${DEMO_PROJECT}\n**Type:** generic\n**Confidence:** M\n**Owner:** me\n**Active since:** ${today}\n**Target close / decision date:** ${todayPlus(14)}\n\n## What this project is\n\nA seeded demo project that ships with chief-of-staff. Delete the folder when you no longer need it (or run \`npm run cos:demo:cleanup\`).\n\n## Where we are right now\n\n- Pricing not yet decided (queue item open).\n- Investor update drafted, awaiting send.\n- Board prep underway.\n\n## Next concrete step\n\nDecide the pricing tier this week.\n\n## Open risks\n\n- Conflicting Stanford speaking slot collides with launch week.\n- Recruiter follow-up overdue; might cost the Tuesday onsite slot.\n`,
    );
    fs.writeFileSync(path.join(projDir, 'decisions.md'), `# Decisions: Demo product launch\n\nLast updated: ${today}\n\nNothing logged yet. Use \`/commit ${DEMO_PROJECT}: ...\` after a real call.\n`);
    fs.writeFileSync(path.join(projDir, 'commitments.md'), `# Commitments: Demo product launch\n\nLast updated: ${today}\n\n## Out (I owe)\n\n## In (owed to me)\n\n## Closed (last 30 days)\n`);
    fs.writeFileSync(path.join(projDir, 'notes.md'), `# Notes: Demo product launch\n\nLast updated: ${today}\n\n## Background\n\nDemo project seeded by \`npm run cos:demo\`. Delete me when done.\n`);
  }

  // Trigger a few conform audit entries so the dashboard has signal.
  audit('voice', 'Lets keep this short.', { skipAudit: false, actor: 'demo-seed' });
  audit('email', 'Hi Daniel, confirming Tuesday. I will bring the v2 draft.', { skipAudit: false, actor: 'demo-seed' });
  audit('email', 'I hope this finds you well. Just wanted to check in.', { skipAudit: false, actor: 'demo-seed' });

  process.stdout.write(JSON.stringify({
    ok: true,
    seeded: created.length,
    project: DEMO_PROJECT,
    project_path: path.relative(REPO_ROOT, projDir),
    next: 'Run `npm run ui` (or `npm run cos:demo:server` to skip the API key check). Open http://localhost:3030',
  }, null, 2) + '\n');
}

function cleanup() {
  const open = loadOpen();
  const demo = open.filter((i) => (i.provenance ?? []).some((p) => p.type === 'demo'));
  for (const it of demo) {
    closeItem(it.id, 'demo cleanup', { actor: 'demo-seed', rule: 'demo.cleanup' });
  }
  const projDir = path.join(REPO_ROOT, 'projects', DEMO_PROJECT);
  let projectRemoved = false;
  if (fs.existsSync(projDir)) {
    fs.rmSync(projDir, { recursive: true, force: true });
    projectRemoved = true;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    closed: demo.length,
    project_removed: projectRemoved,
    note: 'Run `npm run queue:compact` to keep the JSONL file lean.',
  }, null, 2) + '\n');
}

// Spawn server.mjs with COS_DEMO=1. Cross-platform: no cross-env dep, no
// shell tricks. The demo script blocks on the child so Ctrl-C in the
// terminal still stops the server cleanly.
async function startDemoServer() {
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, COS_DEMO: '1' },
  });
  child.on('close', (code) => process.exit(code ?? 0));
}

const args = parseArgs(process.argv);
if (args.cleanup) {
  cleanup();
} else {
  seed();
  if (args['start-server']) {
    process.stdout.write('\nStarting server with COS_DEMO=1...\n');
    await startDemoServer();
  }
}
