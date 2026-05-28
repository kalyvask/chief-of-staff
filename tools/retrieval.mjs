// Chief of Staff: hybrid retrieval over the context library.
//
// As context/, memory/, projects/, and logs/ grow, file-path reads stop
// scaling. This module indexes the corpus into chunks, scores them with
// BM25 (always on) and optional Voyage embeddings (when VOYAGE_API_KEY is
// set), fuses the rankings with reciprocal rank fusion, and optionally
// reranks the top-K with Claude.
//
// Substrate is JSON on disk, not a database, so it matches the queue
// and graph patterns already in this repo.
//
// Public API:
//   buildIndex({roots, includeLogs, embed})  -> {chunks, bm25, embeddings?, stats}
//   saveIndex(index)                         -> writes data/retrieval-index.json
//   loadIndex()                              -> reads data/retrieval-index.json
//   search(index, query, {topK, useVector, rerank}) -> ranked [{chunk, score, signals}]
//   formatHits(hits, {showSnippet})          -> string for CLI output
//
// Index storage (data/retrieval-index.json):
//   {
//     built_at, roots, stats,
//     chunks: [{id, path, heading, line_start, line_end, text}],
//     bm25:   {N, avgDocLen, docLen[], df: {term: count}, postings: {term: [docId,...]}},
//     embeddings?: {model, dim, vectors: [[...]]}  // float arrays, one per chunk
//   }

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const INDEX_PATH = path.resolve(REPO_ROOT, 'data', 'retrieval-index.json');

const DEFAULT_ROOTS = ['context', 'memory', 'projects'];

// English stopwords. Small list; the point is to keep the BM25 vocab honest
// without dragging in a dependency.
const STOPWORDS = new Set([
  'a','an','and','are','as','at','be','but','by','for','from','has','have',
  'he','her','him','his','i','in','is','it','its','me','my','of','on','or',
  'our','she','so','that','the','their','them','they','this','to','was','we',
  'were','will','with','you','your','yours','if','do','did','does','not',
  'no','yes','than','then','there','these','those','also','can','could',
  'should','would','about','into','out','up','down','over','under','here',
]);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}

// Walk a directory recursively, returning absolute paths to .md and .jsonl files.
// Skips dotfiles, node_modules, and the data/ derived state.
function walkCorpus(roots, { includeLogs = false } = {}) {
  const files = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'logs' && !includeLogs) continue;
        visit(full);
      } else if (e.isFile()) {
        if (/\.(md|markdown|jsonl|txt)$/i.test(e.name)) files.push(full);
      }
    }
  };
  for (const root of roots) {
    const full = path.isAbsolute(root) ? root : path.join(REPO_ROOT, root);
    if (fs.existsSync(full)) visit(full);
  }
  if (includeLogs) {
    const logsDir = path.join(REPO_ROOT, 'logs');
    if (fs.existsSync(logsDir)) visit(logsDir);
  }
  return files;
}

// Chunk markdown: split at H1/H2/H3 boundaries; if a section is over
// CHUNK_MAX chars, fall back to paragraph-level splits with overlap.
const CHUNK_MAX = 1200;
const CHUNK_OVERLAP = 120;

function chunkMarkdown(filePath, text) {
  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const lines = text.split(/\r?\n/);
  const sections = [];
  let cur = { heading: null, lineStart: 1, body: [] };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^(#{1,3})\s+(.+?)\s*$/);
    if (h) {
      if (cur.body.join('\n').trim()) sections.push({ ...cur, lineEnd: i });
      cur = { heading: h[2].trim(), lineStart: i + 1, body: [] };
    }
    cur.body.push(line);
  }
  if (cur.body.join('\n').trim()) sections.push({ ...cur, lineEnd: lines.length });

  const chunks = [];
  let chunkIdx = 0;
  for (const sec of sections) {
    const body = sec.body.join('\n').trim();
    if (!body) continue;
    if (body.length <= CHUNK_MAX) {
      chunks.push({
        id: `${rel}#${chunkIdx++}`,
        path: rel,
        heading: sec.heading,
        line_start: sec.lineStart,
        line_end: sec.lineEnd,
        text: body,
      });
      continue;
    }
    // Long section: window with overlap.
    let pos = 0;
    while (pos < body.length) {
      const piece = body.slice(pos, pos + CHUNK_MAX);
      chunks.push({
        id: `${rel}#${chunkIdx++}`,
        path: rel,
        heading: sec.heading,
        line_start: sec.lineStart,
        line_end: sec.lineEnd,
        text: piece,
      });
      if (pos + CHUNK_MAX >= body.length) break;
      pos += CHUNK_MAX - CHUNK_OVERLAP;
    }
  }
  return chunks;
}

// JSONL: one chunk per line. Best-effort summary using common fields.
function chunkJsonl(filePath, text) {
  const rel = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const out = [];
  let idx = 0;
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let summary = line;
    try {
      const obj = JSON.parse(line);
      const parts = [];
      for (const k of ['summary', 'decision', 'outcome', 'rule', 'sender', 'counterparty', 'project', 'bucket']) {
        if (obj[k]) parts.push(`${k}: ${obj[k]}`);
      }
      if (parts.length) summary = parts.join('\n');
    } catch {
      // keep raw line
    }
    out.push({
      id: `${rel}#${idx++}`,
      path: rel,
      heading: null,
      line_start: i + 1,
      line_end: i + 1,
      text: summary,
    });
  }
  return out;
}

export function chunkFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (/\.jsonl$/i.test(filePath)) return chunkJsonl(filePath, text);
  return chunkMarkdown(filePath, text);
}

// BM25 index: standard formulation with k1=1.5, b=0.75.
const BM25_K1 = 1.5;
const BM25_B = 0.75;

function buildBM25(chunks) {
  const N = chunks.length;
  const docLen = new Array(N).fill(0);
  const df = Object.create(null);
  const postings = Object.create(null);

  for (let i = 0; i < N; i++) {
    const tokens = tokenize(chunks[i].text);
    docLen[i] = tokens.length;
    const tf = Object.create(null);
    for (const t of tokens) tf[t] = (tf[t] ?? 0) + 1;
    for (const [term, count] of Object.entries(tf)) {
      df[term] = (df[term] ?? 0) + 1;
      if (!postings[term]) postings[term] = [];
      postings[term].push([i, count]);
    }
  }
  const avgDocLen = docLen.reduce((a, b) => a + b, 0) / Math.max(N, 1);
  return { N, avgDocLen, docLen, df, postings };
}

function bm25Score(bm25, query) {
  const { N, avgDocLen, docLen, df, postings } = bm25;
  const terms = tokenize(query);
  const scores = new Map();
  for (const t of terms) {
    const post = postings[t];
    if (!post) continue;
    const idf = Math.log(1 + (N - (df[t] ?? 0) + 0.5) / ((df[t] ?? 0) + 0.5));
    for (const [docId, tf] of post) {
      const dl = docLen[docId] || 1;
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / Math.max(avgDocLen, 1)));
      const s = idf * ((tf * (BM25_K1 + 1)) / denom);
      scores.set(docId, (scores.get(docId) ?? 0) + s);
    }
  }
  return scores;
}

// Reciprocal rank fusion across multiple ranked lists.
// k=60 is the canonical setting.
function rrfFuse(rankedLists, k = 60) {
  const fused = new Map();
  for (const ranking of rankedLists) {
    ranking.forEach((docId, rank) => {
      fused.set(docId, (fused.get(docId) ?? 0) + 1 / (k + rank + 1));
    });
  }
  return fused;
}

function topRanking(scoresMap, limit) {
  return Array.from(scoresMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([docId]) => docId);
}

// Voyage embeddings (optional). Requires VOYAGE_API_KEY in the env.
// Model default: voyage-3-lite (cheap, fast). Override with VOYAGE_MODEL.
async function embedBatch(texts) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) return null;
  const model = process.env.VOYAGE_MODEL || 'voyage-3-lite';
  const out = [];
  // Voyage caps at 128 inputs and 32k tokens per request; chunk conservatively.
  const BATCH = 64;
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const res = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: batch, model }),
    });
    if (!res.ok) {
      throw new Error(`voyage: ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    const data = await res.json();
    for (const row of data.data) out.push(row.embedding);
  }
  return { model, dim: out[0]?.length ?? 0, vectors: out };
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function buildIndex({ roots = DEFAULT_ROOTS, includeLogs = false, embed = false } = {}) {
  const files = walkCorpus(roots, { includeLogs });
  const chunks = [];
  for (const f of files) {
    try {
      chunks.push(...chunkFile(f));
    } catch (e) {
      process.stderr.write(`retrieval: skipping ${f}: ${e.message}\n`);
    }
  }
  const bm25 = buildBM25(chunks);
  let embeddings = null;
  if (embed) {
    if (!process.env.VOYAGE_API_KEY) {
      process.stderr.write('retrieval: --embed requested but VOYAGE_API_KEY not set; skipping vector index\n');
    } else {
      embeddings = await embedBatch(chunks.map((c) => c.text));
    }
  }
  const stats = {
    file_count: files.length,
    chunk_count: chunks.length,
    avg_chunk_len: bm25.avgDocLen,
    vocab_size: Object.keys(bm25.df).length,
    has_vectors: !!embeddings,
  };
  return {
    built_at: new Date().toISOString(),
    roots: [...roots, ...(includeLogs ? ['logs'] : [])],
    stats,
    chunks,
    bm25,
    embeddings,
  };
}

export function saveIndex(index) {
  const dir = path.dirname(INDEX_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(INDEX_PATH, JSON.stringify(index), 'utf8');
  return INDEX_PATH;
}

export function loadIndex() {
  if (!fs.existsSync(INDEX_PATH)) {
    throw new Error(`retrieval: no index at ${INDEX_PATH}. Run: node tools/retrieve-cli.mjs index`);
  }
  return JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
}

// Claude rerank: send top-K candidates with the query; ask for scores.
// Optional, gated behind --rerank or rerank:true. Skipped silently if no key.
async function claudeRerank(query, candidates) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const numbered = candidates.map((c, i) => `[${i}] (${c.chunk.path}${c.chunk.heading ? ' :: ' + c.chunk.heading : ''})\n${c.chunk.text.slice(0, 600)}`).join('\n\n---\n\n');
  const prompt = `You are reranking retrieved passages for a query. Score each passage 0-10 for how directly it answers the query. Return only a JSON array of {index, score} for all passages.

Query: ${query}

Passages:
${numbered}

Return only the JSON array, no prose.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.ANTHROPIC_RERANK_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    process.stderr.write(`retrieval: rerank failed (${res.status}); falling back to RRF order\n`);
    return null;
  }
  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) return null;
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch { return null; }
  return parsed;
}

export async function search(index, query, { topK = 8, useVector = true, rerank = false, candidatePool = 40 } = {}) {
  const bm25Scores = bm25Score(index.bm25, query);
  const bm25Ranking = topRanking(bm25Scores, candidatePool);

  const rankings = [bm25Ranking];
  const signals = new Map();
  for (const id of bm25Ranking) signals.set(id, { bm25: bm25Scores.get(id) });

  if (useVector && index.embeddings?.vectors && process.env.VOYAGE_API_KEY) {
    const qEmbed = await embedBatch([query]);
    if (qEmbed?.vectors?.[0]) {
      const qv = qEmbed.vectors[0];
      const vecScores = new Map();
      for (let i = 0; i < index.embeddings.vectors.length; i++) {
        const s = cosine(qv, index.embeddings.vectors[i]);
        vecScores.set(i, s);
      }
      const vecRanking = topRanking(vecScores, candidatePool);
      rankings.push(vecRanking);
      for (const id of vecRanking) {
        const cur = signals.get(id) ?? {};
        cur.cosine = vecScores.get(id);
        signals.set(id, cur);
      }
    }
  }

  const fused = rrfFuse(rankings);
  let ordered = Array.from(fused.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(topK, candidatePool));
  let hits = ordered.map(([docId, rrfScore]) => ({
    chunk: index.chunks[docId],
    score: rrfScore,
    signals: signals.get(docId) ?? {},
  }));

  if (rerank) {
    const candidates = hits.slice(0, Math.min(20, hits.length));
    const reranked = await claudeRerank(query, candidates);
    if (reranked) {
      const byIdx = new Map(reranked.map((r) => [r.index, r.score]));
      candidates.sort((a, b) => (byIdx.get(candidates.indexOf(b)) ?? 0) - (byIdx.get(candidates.indexOf(a)) ?? 0));
      // Map back: candidates are the first slice of hits, so replace them in order.
      for (let i = 0; i < candidates.length; i++) {
        hits[i] = candidates[i];
        hits[i].signals = { ...hits[i].signals, rerank: reranked.find((r) => r.index === i)?.score };
      }
    }
  }

  return hits.slice(0, topK);
}

export function formatHits(hits, { showSnippet = true, maxSnippet = 240 } = {}) {
  const lines = [];
  hits.forEach((h, i) => {
    const head = h.chunk.heading ? ` :: ${h.chunk.heading}` : '';
    const sig = Object.entries(h.signals)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(3) : v}`)
      .join(' ');
    lines.push(`${i + 1}. ${h.chunk.path}:${h.chunk.line_start}${head}  [score=${h.score.toFixed(4)}${sig ? ' ' + sig : ''}]`);
    if (showSnippet) {
      const snip = h.chunk.text.replace(/\s+/g, ' ').slice(0, maxSnippet);
      lines.push(`   ${snip}${h.chunk.text.length > maxSnippet ? '...' : ''}`);
    }
  });
  return lines.join('\n');
}

export const PATHS = { INDEX_PATH };
