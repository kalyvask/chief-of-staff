---
description: Synthesized answer with citations and a gap list over the indexed context library. Use for "what did I decide about X" or "what should I do about Y". Returns prose with [path:line] citations and an explicit list of what is missing from the corpus.
argument-hint: <question>
mode: read-only
---

You are answering a question by synthesizing across passages in my context library. Distinct from `/search`: that returns ranked passages, you return a written answer with citations and a gap list.

The question is: $ARGUMENTS

## Steps

1. Read `CLAUDE.md` for voice rules.
2. Check that `data/retrieval-index.json` exists and is fresh (less than 7 days old). If not, run `node tools/retrieve-cli.mjs index` first.
3. Run `node tools/think.mjs "<question>" --json` and read the result.
4. Present the answer back in this exact shape:
   - The synthesized answer in prose. Every non-trivial claim cites a passage as `[path:line]`.
   - A `Sources:` section listing each cited passage and what it contributed.
   - A `Gaps:` section listing what would help that is not in the corpus. If nothing material is missing, write `- none material`.
5. Never restate the question. Never add filler at the top.

## When the corpus has no real answer

If the top retrieval signals are weak (think.mjs reports thin hits), say "the corpus does not contain a direct answer" and list what would need to be written down to answer it. Do not pad with adjacent passages.

## When to use /think vs /search

- `/search` — fast, returns passages, no LLM call beyond the optional rerank. Use it when you know what you want to find.
- `/think` — slower, synthesizes an answer, makes one LLM call. Use it for "what should I do" or "what does the corpus say about X".

## Voice

No em dashes. No AI tells. No flattery. The `Sources:` and `Gaps:` sections are lists; the rest is prose.
