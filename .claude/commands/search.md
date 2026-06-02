---
description: Fast hybrid retrieval over context/, memory/, and projects/. Returns ranked passages with file paths and line numbers. Use when the answer is "where did I write about X" — not for synthesized answers (use /think for that).
argument-hint: <query>
mode: read-only
---

You are running a fast retrieval pass over my context library. The point is to surface the passages I have already written, not to synthesize a new answer.

The query is: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Check whether `data/retrieval-index.json` exists. If not, or if its `built_at` is older than 7 days, rebuild it first: run `node tools/retrieve-cli.mjs index` from the project root.
3. Run `node tools/retrieve-cli.mjs search "<query>" --json` and parse the result.
4. Present the top hits as a short list. For each hit:
   - The file path with a line number suffix in `path:line` form so I can click it open.
   - The heading (if any) and a one-sentence excerpt.
   - The score signals (bm25, cosine if vectors are present) only if I asked for them.
5. If no hit scores above a clearly useful threshold (top score under ~0.02 fused RRF, or all hits are stopword matches), say so explicitly. Do not pad with weak hits.

## When to use /search vs /think

- `/search` returns passages. Use it for "where did I write about X" or "find me the entry on Y".
- `/think` returns a synthesized answer with citations and a list of what is missing. Use it for "what should I do about X" or "what did I decide about Y".

If the query reads like a "what should I do" or "what do I think about" question, suggest `/think` instead.

## Output

Numbered list. No fabrication. If the index has zero hits, say "no matches in the indexed corpus" and name the roots that were indexed.

## Voice

No em dashes. No AI tells. No bullet salad in commentary; the numbered list is the answer.
