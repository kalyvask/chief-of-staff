#!/usr/bin/env node
// Chief of Staff: conformance CLI.
//
// Audit a draft against the voice and structural rules in CLAUDE.md.
// Read text from stdin (preferred) or from --text. Optionally pass a queue
// item id with --item so the email check knows what provenance to expect.
//
// Usage:
//   echo "draft text..." | node tools/conform-cli.mjs audit --kind email --item q_2026-05-19_001
//   node tools/conform-cli.mjs audit --kind brief --text "today is light..."
//   node tools/conform-cli.mjs rules
//
// Output is a JSON object: {ok, summary, counts, violations}. Exit code 0
// if no high-severity violations, 1 otherwise.

import fs from 'node:fs';
import { audit, summarize } from './conform.mjs';
import { getItem } from './queue.mjs';

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

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { data += c; });
    process.stdin.on('end', () => resolve(data));
  });
}

function jprint(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

const args = parseArgs(process.argv);
const cmd = args._[0];

if (cmd === 'rules') {
  // Quick reference; the source of truth is tools/conform.mjs.
  jprint({
    kinds: ['voice', 'email', 'brief', 'commit'],
    severities: ['high', 'med', 'low'],
    note: 'Source of truth is tools/conform.mjs. High-severity hits exit non-zero.',
  });
  process.exit(0);
}

if (cmd !== 'audit') {
  process.stdout.write('usage: node tools/conform-cli.mjs <audit|rules> [--kind voice|email|brief|commit] [--text "..."] [--item <queue-id>]\n');
  process.exit(cmd ? 2 : 0);
}

const kind = args.kind ?? 'voice';
let text = args.text;
if (text === undefined || text === true) {
  text = (await readStdin()).toString();
}
if (!text || !text.trim()) {
  process.stderr.write('conform: no text provided. Pipe text on stdin or use --text.\n');
  process.exit(2);
}

let ctx = {};
if (kind === 'email' && args.item) {
  const item = getItem(args.item);
  if (!item) {
    process.stderr.write(`conform: item ${args.item} not found\n`);
    process.exit(2);
  }
  ctx.item = item;
}

const result = audit(kind, text, ctx);
const sum = summarize(result.violations);

jprint({
  kind,
  ok: sum.ok,
  summary: sum.summary,
  counts: sum.counts,
  violations: result.violations,
});

process.exit(sum.ok ? 0 : 1);
