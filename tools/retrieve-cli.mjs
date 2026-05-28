#!/usr/bin/env node
// CLI for tools/retrieval.mjs. Two subcommands: index, search.
//
// Build the index over context/, memory/, projects/ (skips logs/ unless --include-logs):
//   node tools/retrieve-cli.mjs index
//   node tools/retrieve-cli.mjs index --embed             # also build vector index (needs VOYAGE_API_KEY)
//   node tools/retrieve-cli.mjs index --include-logs
//   node tools/retrieve-cli.mjs index --roots context,memory
//
// Query:
//   node tools/retrieve-cli.mjs search "who did I commit to on Anthropic prep"
//   node tools/retrieve-cli.mjs search "..." --top 5 --no-vector --rerank
//   node tools/retrieve-cli.mjs search "..." --json

import { buildIndex, saveIndex, loadIndex, search, formatHits } from './retrieval.mjs';

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
  const cmd = args._[0];

  if (cmd === 'index') {
    const roots = args.roots ? String(args.roots).split(',') : undefined;
    const includeLogs = !!args['include-logs'];
    const embed = !!args.embed;
    const index = await buildIndex({ roots, includeLogs, embed });
    const out = saveIndex(index);
    if (args.json) {
      process.stdout.write(JSON.stringify(index.stats, null, 2) + '\n');
    } else {
      process.stdout.write(`indexed ${index.stats.chunk_count} chunks from ${index.stats.file_count} files`);
      process.stdout.write(` (vocab=${index.stats.vocab_size}${index.stats.has_vectors ? `, vectors=${index.embeddings.dim}d` : ''})\n`);
      process.stdout.write(`written to ${out}\n`);
    }
    return;
  }

  if (cmd === 'search') {
    const query = args._.slice(1).join(' ').trim() || (typeof args.q === 'string' ? args.q : null);
    if (!query) {
      process.stderr.write('usage: retrieve-cli.mjs search "<query>" [--top N] [--no-vector] [--rerank] [--json]\n');
      process.exit(2);
    }
    const index = loadIndex();
    const hits = await search(index, query, {
      topK: args.top ? parseInt(args.top, 10) : 8,
      useVector: !args['no-vector'],
      rerank: !!args.rerank,
    });
    if (args.json) {
      process.stdout.write(JSON.stringify({ query, hits }, null, 2) + '\n');
    } else {
      process.stdout.write(formatHits(hits, { showSnippet: !args['no-snippet'] }) + '\n');
    }
    return;
  }

  process.stderr.write('usage: retrieve-cli.mjs <index|search> ...\n');
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`retrieve-cli: ${e.message}\n`);
  process.exit(1);
});
