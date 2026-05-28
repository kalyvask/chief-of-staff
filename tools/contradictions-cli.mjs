#!/usr/bin/env node
// CLI for tools/contradictions.mjs.
//
// Usage:
//   node tools/contradictions-cli.mjs                   # scan and print findings
//   node tools/contradictions-cli.mjs --json            # machine-readable
//   node tools/contradictions-cli.mjs --today 2026-05-24   # override "today" for deterministic runs

import { findContradictions, summarize } from './contradictions.mjs';

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) out[key] = true;
      else { out[key] = next; i++; }
    } else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv);
const findings = findContradictions({
  today: typeof args.today === 'string' ? args.today : undefined,
});
const sum = summarize(findings);

if (args.json) {
  process.stdout.write(JSON.stringify({ ...sum, findings }, null, 2) + '\n');
  process.exit(sum.ok ? 0 : 1);
}

if (findings.length === 0) {
  process.stdout.write('no contradictions detected\n');
  process.exit(0);
}

process.stdout.write(`${sum.summary}\n\n`);
for (const f of findings) {
  process.stdout.write(`[${f.severity.toUpperCase()}] ${f.rule}\n  ${f.message}\n  -> ${f.suggest}\n\n`);
}
process.exit(sum.ok ? 0 : 1);
