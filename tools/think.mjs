#!/usr/bin/env node
// Chief of Staff: think mode.
//
// Builds on tools/retrieval.mjs. Given a question, retrieves the top-K
// passages from the indexed context library, then asks Claude to:
//   1. Answer the question using only the retrieved passages
//   2. Cite each claim with a {path, line} reference taken from the chunks
//   3. List the gaps: what would help answer this that the corpus does not contain
//
// This is the "synthesis" complement to /search. /search returns passages;
// /think returns a written answer with explicit citations and a gap list.
//
// Public API:
//   buildPrompt(question, hits)          -> {system, user}  (pure, no API call)
//   parseAnswer(rawText)                 -> {answer, sources, gaps}
//   think(question, {topK, useVector, rerank, dryRun}) -> {answer, sources, gaps, hits}
//
// CLI:
//   node tools/think.mjs "what did I commit to on Anthropic prep this week"
//   node tools/think.mjs "..." --top 6 --rerank
//   node tools/think.mjs "..." --json
//   node tools/think.mjs "..." --dry-run   # build prompt only, no API call

import { loadIndex, search } from './retrieval.mjs';

const SYSTEM_PROMPT = `You answer questions over a chief-of-staff's personal context library (markdown files in context/, memory/, projects/). You are given the top-ranked passages from the library and must answer using only what they contain.

Rules:
- Never invent facts. If the passages do not answer the question, say so plainly.
- Cite every non-trivial claim with [path:line] using the path and line_start the passages carry.
- Distinguish "this is what the corpus says" from "this is what I think is missing".
- Write in clean prose. No em dashes. No "delve", "navigate", "leverage" as a verb, "unlock", "in the world of", "not just X also Y". No flattery.
- Default to paragraph form. Use a list only for genuine lists (names, steps, file paths).
- End with two sections in this exact format:
  Sources:
  - [path:line] short note on what it contributed
  - [path:line] ...
  Gaps:
  - what would help that the corpus does not contain (one bullet per gap)
  - if there are no real gaps, write a single bullet: "none material"
`;

export function buildPrompt(question, hits) {
  const passages = hits.map((h, i) => {
    const header = `[${i + 1}] ${h.chunk.path}:${h.chunk.line_start}${h.chunk.heading ? ' :: ' + h.chunk.heading : ''}`;
    return `${header}\n${h.chunk.text}`;
  }).join('\n\n---\n\n');
  const user = `Question: ${question}\n\nRetrieved passages (ranked by relevance):\n\n${passages}\n\nAnswer the question using only these passages, with citations and a gaps list per the system rules.`;
  return { system: SYSTEM_PROMPT, user };
}

// Parse the model's output. Looks for "Sources:" and "Gaps:" sections.
// Returns {answer, sources: [{ref, note}], gaps: string[]} with a best-effort
// fallback if the model deviates from the format.
export function parseAnswer(rawText) {
  const text = String(rawText);
  const sourcesIdx = text.search(/^\s*Sources:\s*$/m);
  const gapsIdx = text.search(/^\s*Gaps:\s*$/m);

  let answer = text;
  let sourcesBlock = '';
  let gapsBlock = '';
  if (sourcesIdx >= 0) {
    answer = text.slice(0, sourcesIdx).trim();
    if (gapsIdx > sourcesIdx) {
      sourcesBlock = text.slice(sourcesIdx, gapsIdx);
      gapsBlock = text.slice(gapsIdx);
    } else {
      sourcesBlock = text.slice(sourcesIdx);
    }
  } else if (gapsIdx >= 0) {
    answer = text.slice(0, gapsIdx).trim();
    gapsBlock = text.slice(gapsIdx);
  }

  const sources = [];
  for (const line of sourcesBlock.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) sources.push({ ref: m[1].trim(), note: m[2].trim() });
  }

  const gaps = [];
  for (const line of gapsBlock.split(/\r?\n/)) {
    const m = line.match(/^\s*-\s*(.+?)\s*$/);
    if (m && !/^Gaps:$/i.test(m[1])) gaps.push(m[1].trim());
  }

  return { answer, sources, gaps };
}

async function callClaude({ system, user, model }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('think: ANTHROPIC_API_KEY not set');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: model || process.env.ANTHROPIC_THINK_MODEL || 'claude-sonnet-4-6',
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`anthropic: ${res.status} ${res.statusText}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? '';
}

export async function think(question, { topK = 8, useVector = true, rerank = false, dryRun = false, model } = {}) {
  const index = loadIndex();
  const hits = await search(index, question, { topK, useVector, rerank });
  const { system, user } = buildPrompt(question, hits);
  if (dryRun) {
    return { dry_run: true, hits, system, user };
  }
  const raw = await callClaude({ system, user, model });
  const parsed = parseAnswer(raw);
  return { ...parsed, hits, raw };
}

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

async function main() {
  const args = parseArgs(process.argv);
  const question = args._.join(' ').trim();
  if (!question) {
    process.stderr.write('usage: think.mjs "<question>" [--top N] [--no-vector] [--rerank] [--dry-run] [--json]\n');
    process.exit(2);
  }
  const result = await think(question, {
    topK: args.top ? parseInt(args.top, 10) : 8,
    useVector: !args['no-vector'],
    rerank: !!args.rerank,
    dryRun: !!args['dry-run'],
    model: typeof args.model === 'string' ? args.model : undefined,
  });
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (result.dry_run) {
    process.stdout.write('--- SYSTEM ---\n' + result.system + '\n\n--- USER ---\n' + result.user + '\n');
    return;
  }
  process.stdout.write(result.answer + '\n\n');
  process.stdout.write('Sources:\n');
  for (const s of result.sources) process.stdout.write(`- [${s.ref}] ${s.note}\n`);
  process.stdout.write('\nGaps:\n');
  for (const g of result.gaps) process.stdout.write(`- ${g}\n`);
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1].endsWith('think.mjs')) {
  main().catch((e) => {
    process.stderr.write(`think: ${e.message}\n`);
    process.exit(1);
  });
}
