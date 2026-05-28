#!/usr/bin/env node
// chief-of-staff: voice-priors CLI.
//
// Manage the voice-priors store: list, add, dump.
//
// Usage:
//   npm run voice-priors -- list
//   npm run voice-priors -- list --tag decline
//   npm run voice-priors -- list --type anti_pattern
//   npm run voice-priors -- list --n 20
//   npm run voice-priors -- add --context "..." --exemplar "..." [--why "..."] [--tags decline,recruiter] [--type anti_pattern]
//   npm run voice-priors -- dump          # all entries as JSON
//   npm run voice-priors -- stats         # counts by type, tag, source

import { addPrior, loadPriors, recentExemplars, recentAntiPatterns } from './voice-priors.mjs';

const args = process.argv.slice(2);
const sub = args[0];

function arg(name, fallback) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = args[i + 1];
  return v && !v.startsWith('--') ? v : fallback;
}

function fail(msg, code = 1) {
  console.error(`voice-priors: ${msg}`);
  process.exit(code);
}

if (!sub || sub === '--help' || sub === '-h') {
  console.log('Subcommands: list | add | dump | stats');
  console.log('  list  [--type voice_exemplar|anti_pattern] [--tag <t>] [--n 10]');
  console.log('  add   --context <c> --exemplar <e> [--why <w>] [--tags a,b,c] [--type voice_exemplar|anti_pattern] [--source <s>]');
  console.log('  dump  (full JSON of all entries)');
  console.log('  stats (counts by type, tag, source)');
  process.exit(0);
}

if (sub === 'add') {
  const context = arg('context', null);
  const exemplar = arg('exemplar', null);
  if (!context) fail('add: --context is required');
  if (!exemplar) fail('add: --exemplar is required');
  const tagsRaw = arg('tags', '');
  const tags = tagsRaw ? tagsRaw.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const entry = addPrior({
    source: arg('source', 'manual'),
    pattern_type: arg('type', 'voice_exemplar'),
    context,
    exemplar_text: exemplar,
    why: arg('why', null),
    tags,
    added_by: arg('added-by', 'cli'),
  });
  console.log('added:', JSON.stringify(entry, null, 2));
  process.exit(0);
}

if (sub === 'list') {
  const type = arg('type', 'voice_exemplar');
  const n = parseInt(arg('n', '10'), 10);
  const tagFilter = arg('tag', null);
  const tags = tagFilter ? [tagFilter] : [];
  const entries = type === 'anti_pattern' ? recentAntiPatterns(n, tags) : recentExemplars(n, tags);
  if (entries.length === 0) {
    console.log(`(no entries of type ${type}${tagFilter ? ` with tag "${tagFilter}"` : ''})`);
    process.exit(0);
  }
  for (const e of entries) {
    const date = (e.at ?? '').slice(0, 10);
    const tagStr = (e.tags ?? []).join(', ');
    console.log(`[${date}] ${e.context}${tagStr ? `  (${tagStr})` : ''}`);
    console.log(`  exemplar: ${e.exemplar_text}`);
    if (e.why) console.log(`  why: ${e.why}`);
    console.log(`  source: ${e.source}, added_by: ${e.added_by}`);
    console.log('');
  }
  process.exit(0);
}

if (sub === 'dump') {
  const all = loadPriors();
  console.log(JSON.stringify(all, null, 2));
  process.exit(0);
}

if (sub === 'stats') {
  const all = loadPriors();
  if (all.length === 0) {
    console.log('(empty store)');
    process.exit(0);
  }
  const byType = {};
  const byTag = {};
  const bySource = {};
  for (const e of all) {
    byType[e.pattern_type] = (byType[e.pattern_type] ?? 0) + 1;
    bySource[e.source] = (bySource[e.source] ?? 0) + 1;
    for (const t of e.tags ?? []) byTag[t] = (byTag[t] ?? 0) + 1;
  }
  console.log(`total: ${all.length} entries\n`);
  console.log('by type:');
  for (const [k, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log('\nby source:');
  for (const [k, v] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  console.log('\nby tag:');
  for (const [k, v] of Object.entries(byTag).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(20)} ${v}`);
  process.exit(0);
}

fail(`unknown subcommand "${sub}". Try --help.`);
