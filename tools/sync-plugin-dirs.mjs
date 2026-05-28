#!/usr/bin/env node
// Chief of Staff: sync .claude/{commands,agents} and root {commands,agents}.
//
// The same Markdown files have to live in two places:
//   - .claude/commands/ and .claude/agents/  (loaded when Claude Code opens this repo as a project)
//   - commands/ and agents/                  (loaded when the repo is installed as a plugin)
//
// This script keeps them in sync. It writes both sides from whichever side
// is newer per-file, so editing either location works. Conflicts (both
// changed) are reported and skipped.
//
// Usage:
//   node tools/sync-plugin-dirs.mjs                # bidirectional sync, newest wins per file
//   node tools/sync-plugin-dirs.mjs --check        # report drift, exit 1 if any
//   node tools/sync-plugin-dirs.mjs --from-claude  # force .claude/* -> root
//   node tools/sync-plugin-dirs.mjs --from-root    # force root -> .claude/*

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const PAIRS = [
  { left: path.join(REPO_ROOT, '.claude', 'commands'), right: path.join(REPO_ROOT, 'commands') },
  { left: path.join(REPO_ROOT, '.claude', 'agents'), right: path.join(REPO_ROOT, 'agents') },
];

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = true;
    else out._.push(a);
  }
  return out;
}

function listMarkdown(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
}

function fileMtime(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return null; }
}

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

const args = parseArgs(process.argv);
const mode = args.check ? 'check'
  : args['from-claude'] ? 'from-claude'
  : args['from-root'] ? 'from-root'
  : 'sync';

const events = [];
let drift = 0;

for (const { left, right } of PAIRS) {
  const allFiles = new Set([...listMarkdown(left), ...listMarkdown(right)]);
  for (const name of allFiles) {
    const lPath = path.join(left, name);
    const rPath = path.join(right, name);
    const lExists = fs.existsSync(lPath);
    const rExists = fs.existsSync(rPath);
    const lContent = lExists ? fs.readFileSync(lPath, 'utf8') : null;
    const rContent = rExists ? fs.readFileSync(rPath, 'utf8') : null;
    const equal = lExists && rExists && lContent === rContent;

    if (equal) continue;
    drift++;

    if (mode === 'check') {
      events.push({
        file: name,
        left: lExists ? 'present' : 'missing',
        right: rExists ? 'present' : 'missing',
        action: 'would diverge',
      });
      continue;
    }

    if (mode === 'from-claude') {
      if (lExists) { copyFile(lPath, rPath); events.push({ file: name, action: '.claude -> root' }); }
      else { fs.rmSync(rPath, { force: true }); events.push({ file: name, action: 'removed from root (not in .claude)' }); }
      continue;
    }
    if (mode === 'from-root') {
      if (rExists) { copyFile(rPath, lPath); events.push({ file: name, action: 'root -> .claude' }); }
      else { fs.rmSync(lPath, { force: true }); events.push({ file: name, action: 'removed from .claude (not in root)' }); }
      continue;
    }

    // sync: pick the side that exists; if both exist, pick newer mtime.
    if (!lExists && rExists) {
      copyFile(rPath, lPath);
      events.push({ file: name, action: 'root -> .claude (new)' });
    } else if (lExists && !rExists) {
      copyFile(lPath, rPath);
      events.push({ file: name, action: '.claude -> root (new)' });
    } else {
      const lm = fileMtime(lPath);
      const rm = fileMtime(rPath);
      if (lm >= rm) {
        copyFile(lPath, rPath);
        events.push({ file: name, action: '.claude -> root (newer)' });
      } else {
        copyFile(rPath, lPath);
        events.push({ file: name, action: 'root -> .claude (newer)' });
      }
    }
  }
}

for (const e of events) process.stdout.write(`  ${e.action.padEnd(36)} ${e.file}\n`);
process.stdout.write(`\n${drift} drift${drift === 1 ? '' : 's'}, ${events.length} action${events.length === 1 ? '' : 's'} taken (${mode}).\n`);

if (mode === 'check' && drift > 0) process.exit(1);
