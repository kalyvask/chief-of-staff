#!/usr/bin/env node
// Chief of Staff: permissions CLI.
//
// Wrapper around tools/permit.mjs so slash commands and subagents can ask
// permission from the shell:
//
//   node tools/permit-cli.mjs check --action email.archive --actor email-drafter
//   node tools/permit-cli.mjs check --action email.send-external --actor email-drafter --item q_2026-05-19_007
//   node tools/permit-cli.mjs raise --actor email-drafter --tier 1 --reason "trust earned on archive class"
//   node tools/permit-cli.mjs list
//   node tools/permit-cli.mjs actors
//
// Output is a single JSON line per result. Exit code 0 if allowed, 1 if denied
// (or for raise/list/actors, 0 on success).

import { permit, raiseActor, listActions, loadTiers } from './permit.mjs';

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

const args = parseArgs(process.argv);
const cmd = args._[0];

function jprint(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

switch (cmd) {
  case 'check': {
    if (!args.action || !args.actor) {
      process.stderr.write('permit check requires --action and --actor\n');
      process.exit(2);
    }
    const result = permit({
      action: args.action,
      actor: args.actor,
      itemId: args.item ?? null,
      note: args.note ?? null,
      routineMode: args['routine-mode'] ?? null,
    });
    jprint(result);
    process.exit(result.allowed ? 0 : 1);
  }
  case 'raise': {
    if (!args.actor || args.tier === undefined) {
      process.stderr.write('permit raise requires --actor and --tier\n');
      process.exit(2);
    }
    const result = raiseActor(args.actor, Number(args.tier), {
      reason: args.reason ?? null,
      actorWriter: 'user',
    });
    jprint(result);
    process.exit(0);
  }
  case 'list': {
    jprint(listActions());
    process.exit(0);
  }
  case 'actors': {
    jprint(loadTiers().actors);
    process.exit(0);
  }
  default:
    process.stdout.write('usage: node tools/permit-cli.mjs <check|raise|list|actors> [...args]\n');
    process.exit(cmd ? 2 : 0);
}
