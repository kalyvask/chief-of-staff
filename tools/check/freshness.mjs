#!/usr/bin/env node
// chief-of-staff: context freshness check.
//
// Fails if any required context or memory file has not been touched in the
// last N days (default 21). Looks at both the tracked file and its
// .local.md sibling; uses the more-recent mtime of the two.
//
// Intended to run as a preflight before /am-sweep so the agent does not
// silently run against month-old context.
//
// Usage:
//   node tools/check/freshness.mjs
//   node tools/check/freshness.mjs --days 14
//   node tools/check/freshness.mjs --json
//   npm run check:freshness
//
// Exit codes:
//   0 - all required files within window
//   1 - one or more required files stale OR missing

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

const MAX_DAYS = parseInt(arg('days', '21'), 10);
const asJson = args.includes('--json');

const REQUIRED = [
  'context/stakeholders.md',
  'context/priorities.md',
  'context/career_thesis.md',
  'context/operating_principles.md',
  'memory/decisions.md',
  'memory/relationships.md',
];
const OPTIONAL = ['context/research_arc.md'];

function mostRecentMtime(relPath) {
  const tracked = path.join(REPO_ROOT, relPath);
  const local = tracked.replace(/\.md$/, '.local.md');
  const stats = [];
  if (fs.existsSync(tracked)) stats.push(fs.statSync(tracked).mtimeMs);
  if (fs.existsSync(local)) stats.push(fs.statSync(local).mtimeMs);
  return stats.length ? Math.max(...stats) : null;
}

const now = Date.now();
const stale = [];
const missing = [];
const fresh = [];

for (const rel of REQUIRED) {
  const mtime = mostRecentMtime(rel);
  if (mtime === null) {
    missing.push(rel);
    continue;
  }
  const ageDays = Math.floor((now - mtime) / 86400000);
  if (ageDays > MAX_DAYS) stale.push({ file: rel, age_days: ageDays });
  else fresh.push({ file: rel, age_days: ageDays });
}

for (const rel of OPTIONAL) {
  const mtime = mostRecentMtime(rel);
  if (mtime === null) continue; // optional, missing is fine
  const ageDays = Math.floor((now - mtime) / 86400000);
  if (ageDays > MAX_DAYS) stale.push({ file: rel, age_days: ageDays, optional: true });
  else fresh.push({ file: rel, age_days: ageDays, optional: true });
}

// "ok" requires no missing required files and no stale required files.
const requiredStale = stale.filter((s) => !s.optional);
const result = {
  ok: requiredStale.length === 0 && missing.length === 0,
  threshold_days: MAX_DAYS,
  stale,
  missing,
  fresh,
};

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`check:freshness — threshold ${MAX_DAYS} days`);
  if (missing.length) {
    console.log(`\nMISSING (required files not on disk):`);
    for (const f of missing) console.log(`  FAIL  ${f}`);
  }
  if (stale.length) {
    console.log(`\nSTALE (>${MAX_DAYS} days since last edit):`);
    for (const s of stale) {
      const tag = s.optional ? ' (optional)' : '';
      console.log(`  warn  ${s.file.padEnd(40)} ${s.age_days}d${tag}`);
    }
  }
  if (fresh.length) {
    console.log(`\nFresh:`);
    for (const f of fresh) {
      const tag = f.optional ? ' (optional)' : '';
      console.log(`  ok    ${f.file.padEnd(40)} ${f.age_days}d${tag}`);
    }
  }
  console.log('');
  if (result.ok) {
    console.log('check:freshness: ok');
  } else {
    const parts = [];
    if (requiredStale.length) parts.push(`${requiredStale.length} stale`);
    if (missing.length) parts.push(`${missing.length} missing`);
    console.log(`check:freshness: ${parts.join(', ')}`);
  }
}

process.exit(result.ok ? 0 : 1);
