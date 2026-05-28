#!/usr/bin/env node
// Chief of Staff: first-run wizard.
//
// Asks 6 questions, then writes initial CLAUDE.md, AGENTS.md,
// context/stakeholders.md, context/priorities.md, context/career_thesis.md,
// and context/operating_principles.md with the user's content in place of
// the bracketed template placeholders.
//
// Files with non-template content are not overwritten unless --force is
// passed. The wizard prints diffs of what would change and confirms before
// writing.
//
// Usage:
//   node tools/init-wizard.mjs                       # interactive
//   node tools/init-wizard.mjs --from-json answers.json  # non-interactive (from JSON file)
//   node tools/init-wizard.mjs --force               # overwrite files with custom content too

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

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

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function ask(rl, q, fallback = '') {
  const answer = (await rl.question(q + '\n> ')).trim();
  return answer || fallback;
}

async function askMulti(rl, q, limit) {
  process.stdout.write(`${q}\n(one per line, blank to stop${limit ? `, max ${limit}` : ''})\n`);
  const lines = [];
  for (let i = 0; ; i++) {
    if (limit && i >= limit) break;
    const a = (await rl.question('  - ')).trim();
    if (!a) break;
    lines.push(a);
  }
  return lines;
}

function lookedTouched(text) {
  // A file is "template" if it still has bracketed placeholders or "<YYYY-MM-DD>".
  if (!text || !text.trim()) return false;
  if (/<YYYY-MM-DD>/.test(text)) return false;
  if (/_To fill in/i.test(text)) return false;
  if (/<One paragraph:/i.test(text)) return false;
  if (/^\s*<.+>\s*$/m.test(text)) return false;
  return true;
}

function safeWrite(rel, content, opts = {}) {
  const abs = path.resolve(REPO_ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (fs.existsSync(abs) && lookedTouched(fs.readFileSync(abs, 'utf8')) && !opts.force) {
    process.stderr.write(`init-wizard: skipping ${rel} (already has non-template content; rerun with --force to overwrite)\n`);
    return { rel, written: false, reason: 'non-template content present' };
  }
  fs.writeFileSync(abs, content, 'utf8');
  return { rel, written: true };
}

function renderClaudeMd(a) {
  const stakeholderList = a.stakeholders.length
    ? a.stakeholders.map((s) => `- ${s}`).join('\n')
    : '_To fill in._';
  const prioritiesList = a.priorities.length
    ? a.priorities.map((p) => `- ${p}`).join('\n')
    : '_To fill in._';
  const bannedList = a.banned_phrases.length
    ? a.banned_phrases.map((p) => `"${p}"`).join(', ')
    : 'add patterns over time as you notice the agent drifting';

  return `# Chief of Staff: Identity

Last updated: ${todayIso()}

## Who I am

${a.who_i_am}

${a.optional_paragraph ? a.optional_paragraph + '\n' : ''}
## How I want you to communicate

Write in clean, direct prose. First-person analytical voice when you are writing on my behalf. Default to paragraph form. Only use lists when I explicitly ask for them, or when the content is genuinely a list (steps, names, file paths). Be concise but not clipped. Tell me what you actually think, including when you disagree with me or when an external AI output you are evaluating is weaker than I assumed.

When I ask you to draft something external, show me the draft first. Do not send anything on my behalf without my explicit approval on that specific draft.

## Hard rules

Never use em dashes. Use commas, periods, parentheses, or restructure the sentence. This is non-negotiable. Never use AI-sounding constructions like "delve into," "navigate the landscape," "it is not just X, it is Y," "in the world of," "unlock," "leverage" as a verb when "use" works, or any cadence that screams ChatGPT. Never flatter me. No "great question," no "excellent point." Always tell me what I am not seeing, including risks I am underweighting, people I am not thinking about, and decisions I am about to make on autopilot. Never send anything externally on my behalf without showing me the draft first and getting explicit approval. Critically evaluate external AI outputs rather than deferring to them. If another model says something wrong or weak, say so.

Additional patterns to strip: ${bannedList}.

## Triage taxonomy

When responding to anything that could lead to action, classify the action into one of four buckets. Default to involving me on anything ambiguous.

**Dispatch (Green).** Full autonomous handling. Routine scheduling confirmations, calendar housekeeping, archiving newsletters, filing notes, data gathering that is not sensitive. Subagents may execute these directly within their permissions.

**Prep (Yellow).** Get to roughly 80% complete and present options. Complex email replies, research summaries, meeting agendas, draft proposals. The bias here is to draft, not to send.

**Yours (Red).** Surface with supporting context, do not act. Strategy decisions, pricing, sensitive communications, anything that affects a relationship I care about, anything that conflicts with \`context/operating_principles.md\` or \`memory/decisions.md\`. Assemble the inputs; I make the call.

**Skip (Gray).** Defer with a reason. Blocked, low priority, or needs more information. Name what is missing.

Default Yellow over Green when uncertain. Default Red over Yellow on anything that touches a person or a commitment.

## What to read first

Before responding to any non-trivial request, read the context library at \`context/\` in this directory. The five files there are the canonical source of truth for who I am, who I work with, what I am working on, and how I make decisions. Specifically:

- \`context/stakeholders.md\` for who is in my orbit and how they relate to me
- \`context/priorities.md\` for what I am actively working on right now
- \`context/research_arc.md\` for my published and in-progress work (rename or remove if not applicable)
- \`context/career_thesis.md\` for what I am optimizing for over the next 6-12 months
- \`context/operating_principles.md\` for how I make decisions and run my week

Also check \`memory/decisions.md\` for prior commitments and \`memory/relationships.md\` for the most recent interaction notes per person before drafting anything that touches another human.

If the request names or implies a project, also read \`projects/<slug>/status.md\`, \`commitments.md\`, \`decisions.md\`, and \`notes.md\`. The \`projects/\` tree holds per-initiative working state so you do not reconstruct it every time.

## The work queue is the substrate

The canonical store of everything in flight is \`data/queue.jsonl\`. Open queue items survive across mornings; \`/am-sweep\` reads it first, before any inbox or calendar pull. Every queue item must cite its upstream signal in \`provenance\`. When you draft anything that derives from queue items, include a \`Sources:\` footer.

## Permission gate

Side-effect actions require a passing check from \`node tools/permit-cli.mjs check\` before they run. Action classes and required tiers live in \`data/tiers.json\`. Defaults are tier 0; higher tiers are opt-in by me. Every permit decision is appended to \`data/permit-audit.jsonl\`. If a check denies an action, stop. Do not try a workaround.

Slash commands declare a \`mode\` (\`read-only\`, \`approval-required\`, \`autonomous\`) in their frontmatter that caps the actor's effective tier for that command. Read the mode and pass it to every permit check via \`--routine-mode\`.

Initial stakeholders to remember (full entries live in \`context/stakeholders.md\`):
${stakeholderList}

Current priorities (full entries live in \`context/priorities.md\`):
${prioritiesList}
`;
}

function renderAgentsMd(a) {
  return `# Chief of Staff: Identity

Last updated: ${todayIso()}

This file is the identity pointer for non-Claude tooling (Codex, generic agents) that reads \`AGENTS.md\` by convention. Claude Code reads \`CLAUDE.md\` instead. Keep the two files in rough sync, or have one be a pointer to the other.

## Who I am

${a.who_i_am}
${a.optional_paragraph ? '\n' + a.optional_paragraph + '\n' : ''}
## How I want you to communicate

Write in clean, direct prose. First-person analytical voice when writing on my behalf. Default to paragraph form. Only use lists when I explicitly ask for them, or when the content is genuinely a list (steps, names, file paths). Be concise but not clipped. Tell me what you actually think.

When I ask you to draft something external, show me the draft first. Do not send anything on my behalf without my explicit approval on that specific draft.

## Hard rules

- Never use em dashes. Replace with commas, periods, parentheses, or restructure.
- Strip AI-sounding constructions ("delve," "navigate the landscape," "it is not just X, it is Y," "in the world of," "unlock," "leverage" as a verb, and similar).
- No flattery ("great question," "excellent point").
- Always surface what I am not seeing, including risks I am underweighting.
- Never send anything externally on my behalf without explicit approval on a specific draft.
- Critically evaluate pasted AI outputs rather than deferring to them.

## Triage taxonomy

- **Dispatch (Green):** routine, low-stakes, fully handleable.
- **Prep (Yellow):** subagent gets it 80% ready; I make the call.
- **Yours (Red):** surface only, do not act.
- **Skip (Gray):** defer with a reason.
`;
}

function renderStakeholdersMd(a) {
  if (!a.stakeholders.length) {
    return `# Stakeholders

Last updated: ${todayIso()}

_To fill in._ Add one entry per person who shows up in your week.

## Example

### Name

**Role:** _Their role and company._
**Relationship to me:** _How we know each other._
**What they care about:** _What matters to them in our interactions._
**What I want from this relationship over 6-12 months:** _Specific outcome._
**Cadence:** _Monthly check-in, quarterly coffee, ad-hoc._
`;
  }
  const entries = a.stakeholders
    .map((s) => `### ${s}\n\n**Role:** _To fill in._\n**Relationship to me:** _To fill in._\n**What they care about:** _To fill in._\n**What I want from this relationship over 6-12 months:** _To fill in._\n**Cadence:** _To fill in._\n`)
    .join('\n');
  return `# Stakeholders

Last updated: ${todayIso()}

One entry per person who shows up in your week. The wizard seeded the names you gave it; fill in the per-person fields over time.

## Active

${entries}
`;
}

function renderPrioritiesMd(a) {
  if (!a.priorities.length) {
    return `# Priorities

Last updated: ${todayIso()}

_To fill in._ The 3-7 things actively on your plate right now.

## This week

- _To fill in._
`;
  }
  return `# Priorities

Last updated: ${todayIso()}

The 3-7 things actively on your plate right now. Update this immediately when priorities shift. Stale priorities make briefs lie.

## This week

${a.priorities.map((p) => `- ${p}`).join('\n')}

## This month

_To fill in._

## On hold

_To fill in._
`;
}

function renderCareerThesisMd(a) {
  const thesis = a.career_thesis || '_To fill in._ What are you optimizing for over the next 6-12 months? Be specific: "PM roles at frontier AI companies" beats "AI roles."';
  return `# Career thesis

Last updated: ${todayIso()}

## What I am optimizing for

${thesis}

## What "obviously wrong" looks like

_To fill in._ Name the offer or move you should refuse. Highest-leverage line in the thesis: if you can name what to say no to, the yeses get sharper.

## Constraints I will not compromise on

_To fill in._ Geography, comp floor, scope, manager profile, family obligations. List them so the agent can flag offers that conflict.
`;
}

function renderOperatingPrinciplesMd(a) {
  const principles = a.operating_principles.length
    ? a.operating_principles.map((p) => `- ${p}`).join('\n')
    : '- _To fill in._ One line per principle. Make them specific enough to flag a violation, not generic enough to feel like a mission statement.';
  return `# Operating principles

Last updated: ${todayIso()}

How I make decisions and run my week. The agent reads these before drafting anything that touches a decision or a relationship.

## Decision principles

${principles}

## Weekly cadence

_To fill in._ Morning sweep when, deep work blocks where, weekly retro when. Helps the agent know what to push and what to defer.
`;
}

function previewWrite(plan) {
  for (const { rel, written, reason } of plan) {
    if (written) {
      process.stdout.write(`  write   ${rel}\n`);
    } else {
      process.stdout.write(`  skip    ${rel} (${reason})\n`);
    }
  }
}

async function gatherInteractive() {
  const rl = readline.createInterface({ input, output });
  process.stdout.write('\nChief of Staff first-run wizard. 6 questions. Ctrl-C to cancel.\n\n');
  const who_i_am = await ask(rl, '1) One paragraph: your name, current role, what you are working on, what you are optimizing for. Three to six sentences.');
  const optional_paragraph = await ask(rl, '2) Optional second paragraph: ongoing public-facing work, mentors who matter, active pipeline threads. Press enter to skip.');
  const stakeholders = await askMulti(rl, '3) Top 3-5 stakeholders by name. The people who show up most in your week.', 5);
  const priorities = await askMulti(rl, '4) Top 3-5 priorities right now. Concrete, this-week or this-month items.', 5);
  const banned_phrases = await askMulti(rl, '5) Voice patterns to strip beyond the defaults. Examples: "circle back", "deep dive", "stakeholder alignment".', 8);
  const career_thesis = await ask(rl, '6) What are you optimizing for over the next 6-12 months? One paragraph.');
  const operating_principles = await askMulti(rl, '7) Three to five operating principles. How you make decisions, what you will not compromise on.', 6);
  rl.close();
  return { who_i_am, optional_paragraph, stakeholders, priorities, banned_phrases, career_thesis, operating_principles };
}

function gatherFromJson(jsonPath) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const a = JSON.parse(raw);
  return {
    who_i_am: a.who_i_am ?? '',
    optional_paragraph: a.optional_paragraph ?? '',
    stakeholders: Array.isArray(a.stakeholders) ? a.stakeholders : [],
    priorities: Array.isArray(a.priorities) ? a.priorities : [],
    banned_phrases: Array.isArray(a.banned_phrases) ? a.banned_phrases : [],
    career_thesis: a.career_thesis ?? '',
    operating_principles: Array.isArray(a.operating_principles) ? a.operating_principles : [],
  };
}

async function main() {
  const answers = args['from-json']
    ? gatherFromJson(args['from-json'])
    : await gatherInteractive();

  const opts = { force: !!args.force };
  const plan = [];
  plan.push(safeWrite('CLAUDE.md', renderClaudeMd(answers), opts));
  plan.push(safeWrite('AGENTS.md', renderAgentsMd(answers), opts));
  plan.push(safeWrite('context/stakeholders.md', renderStakeholdersMd(answers), opts));
  plan.push(safeWrite('context/priorities.md', renderPrioritiesMd(answers), opts));
  plan.push(safeWrite('context/career_thesis.md', renderCareerThesisMd(answers), opts));
  plan.push(safeWrite('context/operating_principles.md', renderOperatingPrinciplesMd(answers), opts));

  process.stdout.write('\nResult:\n');
  previewWrite(plan);

  const wroteAny = plan.some((p) => p.written);
  process.stdout.write(`\n${wroteAny ? 'Wizard wrote initial files. Edit them by hand as needed.' : 'Nothing written. Pass --force to overwrite non-template content.'}\n`);
}

main().catch((err) => {
  process.stderr.write(`init-wizard: ${err.message}\n`);
  process.exit(1);
});
