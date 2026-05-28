#!/usr/bin/env node
// Chief of Staff: hooks runner.
//
// Karpathy's LLM-OS framing has the agent wake on signals, not just on
// schedule. Each hook in tools/hooks/*.mjs checks a single condition and,
// if true, writes a Yellow or Yours queue item with provenance. The runner
// imports each hook module and calls its default export.
//
// The runner is intended to be scheduled (cron / Task Scheduler) once an
// hour or once a morning. Hooks are responsible for their own dedup so
// repeat runs do not flood the queue. The current substrate makes this
// easy: each hook tags its provenance with a stable ref, and the dedup
// check is one pass over the existing queue.
//
// Usage:
//   node tools/hooks-runner.mjs                 # run all hooks once
//   node tools/hooks-runner.mjs --only overdue  # run a single hook
//   node tools/hooks-runner.mjs --dry-run       # do not write queue items (passed through to hooks that respect it)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HOOKS_DIR = path.resolve(__dirname, 'hooks');

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

async function main() {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(HOOKS_DIR)) {
    process.stderr.write(`hooks-runner: no hooks directory at ${HOOKS_DIR}\n`);
    process.exit(1);
  }
  const files = fs.readdirSync(HOOKS_DIR).filter((f) => f.endsWith('.mjs'));
  const results = [];
  for (const file of files) {
    const name = file.replace(/\.mjs$/, '');
    if (args.only && args.only !== name) continue;
    try {
      const mod = await import(pathToFileURL(path.join(HOOKS_DIR, file)).href);
      if (typeof mod.default !== 'function') {
        results.push({ hook: name, error: 'no default export function' });
        continue;
      }
      const result = await mod.default({ dryRun: !!args['dry-run'] });
      results.push(result);
    } catch (err) {
      results.push({ hook: name, error: String(err.message || err) });
    }
  }
  process.stdout.write(JSON.stringify({ ran_at: new Date().toISOString(), results }, null, 2) + '\n');
}

main().catch((err) => {
  process.stderr.write(`hooks-runner: ${err.message}\n`);
  process.exit(1);
});
