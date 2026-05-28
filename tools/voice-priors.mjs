// Chief of Staff: voice priors store.
//
// Append-only JSONL of voice exemplars and anti-patterns. Two consumers today:
//
//   1. meeting-coach appends voice_exemplar entries when reviewing Granola
//      transcripts and noticing phrasing that captures Alex's voice cleanly.
//   2. email-drafter loads the top-N most recent exemplars (optionally filtered
//      by tag) and includes them as positive few-shot examples in its system
//      prompt. This is the positive-side complement to tools/conform.mjs, which
//      only enforces negatively (strips bad patterns).
//
// Entry shape:
//   {
//     at: ISO timestamp,
//     source: "meeting-coach" | "manual" | "email-drafter-debrief",
//     pattern_type: "voice_exemplar" | "anti_pattern",
//     context: short description of the situation,
//     exemplar_text: the actual phrasing,
//     why: one-sentence reason this is useful,
//     added_by: actor name,
//     tags: array of strings
//   }
//
// Public API:
//   addPrior(entry)              -> entry (with at + defaults filled)
//   loadPriors()                 -> array, all entries
//   recentExemplars(n, tags)     -> array, top-N most recent voice_exemplar
//                                    entries; if tags supplied, restrict to
//                                    entries whose tags intersect.
//   recentAntiPatterns(n, tags)  -> same shape but for anti_pattern entries.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PRIORS_PATH = path.resolve(REPO_ROOT, 'data', 'voice-priors.jsonl');

function ensureFile() {
  const dir = path.dirname(PRIORS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(PRIORS_PATH)) fs.writeFileSync(PRIORS_PATH, '');
}

export function addPrior(partial) {
  if (!partial || !partial.exemplar_text) {
    throw new Error('addPrior: exemplar_text is required');
  }
  if (!partial.context) {
    throw new Error('addPrior: context is required');
  }
  const entry = {
    at: partial.at ?? new Date().toISOString(),
    source: partial.source ?? 'manual',
    pattern_type: partial.pattern_type ?? 'voice_exemplar',
    context: partial.context,
    exemplar_text: partial.exemplar_text,
    why: partial.why ?? null,
    added_by: partial.added_by ?? 'unknown',
    tags: Array.isArray(partial.tags) ? partial.tags : [],
  };
  if (!['voice_exemplar', 'anti_pattern'].includes(entry.pattern_type)) {
    throw new Error(`addPrior: invalid pattern_type "${entry.pattern_type}"`);
  }
  ensureFile();
  fs.appendFileSync(PRIORS_PATH, JSON.stringify(entry) + '\n', 'utf8');
  return entry;
}

export function loadPriors() {
  if (!fs.existsSync(PRIORS_PATH)) return [];
  return fs
    .readFileSync(PRIORS_PATH, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function recentMatching(type, n, tags) {
  const all = loadPriors().filter((p) => p.pattern_type === type);
  const filtered = (tags && tags.length)
    ? all.filter((p) => (p.tags ?? []).some((t) => tags.includes(t)))
    : all;
  filtered.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  return filtered.slice(0, n);
}

export function recentExemplars(n = 10, tags = []) {
  return recentMatching('voice_exemplar', n, tags);
}

export function recentAntiPatterns(n = 10, tags = []) {
  return recentMatching('anti_pattern', n, tags);
}
