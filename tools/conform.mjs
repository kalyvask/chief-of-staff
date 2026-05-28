// Chief of Staff: conformance audits.
//
// The voice and structural rules in CLAUDE.md are aspirational until they
// run as code. This module encodes them as checks that flag violations on
// every draft. Each check returns {ok, violations: [{rule, severity, span,
// message, suggest}]}.
//
// Public API:
//   checkVoice(text)                     -> violations from voice rules (em dashes, AI tells, flattery)
//   checkEmailDraft(text, {item})        -> voice + sources footer + length + email-specific bans
//   checkBrief(text)                     -> voice + bullet pattern (Alex forbids bullet-heavy briefs)
//   checkCommitEntry(entry)              -> required fields present
//   audit(kind, text, ctx)               -> dispatches to the right checker
//   summarize(violations)                -> a one-line summary plus a per-rule count
//
// Severity:
//   high  -> hard violation, must be fixed before sending
//   med   -> probable violation, agent should re-check
//   low   -> stylistic nudge, not blocking
//
// Rule library lives in data/conform-rules.json (ships with the repo).
// Personal overrides go in data/conform-rules.local.json (gitignored).
// The .local file is merged on top: arrays append, thresholds override.
// Every audit() call appends a JSONL line to data/conform-audit.jsonl so
// the dashboard can show drift over time.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const RULES_PATH = path.resolve(REPO_ROOT, 'data', 'conform-rules.json');
const LOCAL_RULES_PATH = path.resolve(REPO_ROOT, 'data', 'conform-rules.local.json');
const AUDIT_PATH = path.resolve(REPO_ROOT, 'data', 'conform-audit.jsonl');

const EM_DASH = /[–—]/g; // en-dash, em-dash

function compileEntries(list) {
  return list.map((e) => ({
    pattern: new RegExp(e.pattern, e.flags ?? 'i'),
    label: e.label,
  }));
}

let cachedRules = null;
let cachedRulesMtime = 0;

function loadRules() {
  const mtime = (() => {
    try {
      const m = fs.statSync(RULES_PATH).mtimeMs;
      const l = fs.existsSync(LOCAL_RULES_PATH) ? fs.statSync(LOCAL_RULES_PATH).mtimeMs : 0;
      return Math.max(m, l);
    } catch {
      return Date.now();
    }
  })();
  if (cachedRules && mtime === cachedRulesMtime) return cachedRules;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RULES_PATH, 'utf8'));
  } catch (e) {
    throw new Error(`conform: failed to load ${RULES_PATH}: ${e.message}`);
  }
  if (fs.existsSync(LOCAL_RULES_PATH)) {
    try {
      const local = JSON.parse(fs.readFileSync(LOCAL_RULES_PATH, 'utf8'));
      // Arrays append, thresholds override.
      for (const key of ['ai_tells', 'flattery', 'email_bans']) {
        if (Array.isArray(local[key])) raw[key] = (raw[key] ?? []).concat(local[key]);
      }
      if (local.thresholds && typeof local.thresholds === 'object') {
        raw.thresholds = { ...(raw.thresholds ?? {}), ...local.thresholds };
      }
    } catch (e) {
      // Bad local config: warn, continue with shipped rules.
      process.stderr.write(`conform: local rules invalid (${e.message}); ignoring\n`);
    }
  }

  cachedRules = {
    ai_tells: compileEntries(raw.ai_tells ?? []),
    flattery: compileEntries(raw.flattery ?? []),
    email_bans: compileEntries(raw.email_bans ?? []),
    thresholds: raw.thresholds ?? {},
  };
  cachedRulesMtime = mtime;
  return cachedRules;
}

function appendAudit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Audit failure should not block the check. Surface elsewhere.
  }
}

function scanList(text, list, severity, ruleId) {
  const out = [];
  for (const entry of list) {
    const m = text.match(entry.pattern);
    if (m) {
      out.push({
        rule: ruleId,
        severity,
        label: entry.label,
        span: m[0],
        message: `${ruleId}: matched "${entry.label}" -> "${m[0]}"`,
        suggest: 'rewrite without this phrase',
      });
    }
  }
  return out;
}

export function checkVoice(text) {
  const rules = loadRules();
  const violations = [];
  // Em dashes are non-negotiable per CLAUDE.md.
  const dashHits = [...text.matchAll(EM_DASH)];
  if (dashHits.length) {
    violations.push({
      rule: 'voice.em-dash',
      severity: 'high',
      label: 'em dash',
      span: dashHits[0][0],
      message: `voice.em-dash: ${dashHits.length} em or en dash${dashHits.length === 1 ? '' : 'es'} present`,
      suggest: 'replace with commas, periods, parentheses, or restructure',
    });
  }
  violations.push(...scanList(text, rules.ai_tells, 'high', 'voice.ai-tell'));
  violations.push(...scanList(text, rules.flattery, 'high', 'voice.flattery'));
  return { ok: violations.length === 0, violations };
}

export function checkEmailDraft(text, { item } = {}) {
  const rules = loadRules();
  const violations = [];
  violations.push(...checkVoice(text).violations);
  violations.push(...scanList(text, rules.email_bans, 'high', 'email.banned-phrase'));

  // Sources footer expected if the draft references a queue item with provenance.
  if (item && Array.isArray(item.provenance) && item.provenance.length > 0) {
    if (!/Sources:\s*\n/i.test(text) && !/\[sources:\s*/i.test(text)) {
      violations.push({
        rule: 'email.sources-footer',
        severity: 'med',
        label: 'missing sources footer',
        message: `email.sources-footer: queue item ${item.id} has provenance but draft has no Sources block`,
        suggest: 'append a Sources: footer via tools/provenance.mjs',
      });
    }
  }

  // Body length guidance: long drafts read as drafty.
  const wordCount = text.trim().split(/\s+/).length;
  const warnAt = rules.thresholds.email_word_count_warn ?? 220;
  const targetAt = rules.thresholds.email_word_count_target ?? 200;
  if (wordCount > warnAt) {
    violations.push({
      rule: 'email.length',
      severity: 'low',
      label: 'long body',
      message: `email.length: ${wordCount} words; default target is under ${targetAt}`,
      suggest: `cut to under ${targetAt} words unless the recipient needs detail`,
    });
  }

  // No bullet salad in email replies.
  const bulletLines = text.split(/\r?\n/).filter((l) => /^\s*[-*]\s+/.test(l)).length;
  const bulletMin = rules.thresholds.email_bullet_salad_min ?? 5;
  if (bulletLines >= bulletMin) {
    violations.push({
      rule: 'email.bullet-salad',
      severity: 'med',
      label: 'bullet-heavy email',
      message: `email.bullet-salad: ${bulletLines} bullet lines; emails should default to prose`,
      suggest: 'collapse bullets into one or two sentences unless the recipient asked for a list',
    });
  }

  return { ok: violations.length === 0, violations };
}

export function checkBrief(text) {
  const rules = loadRules();
  const violations = [];
  violations.push(...checkVoice(text).violations);

  // Briefs should be paragraph form. More than N bullet lines suggests
  // the agent has degenerated into a calendar dump.
  const bulletLines = text.split(/\r?\n/).filter((l) => /^\s*[-*]\s+/.test(l)).length;
  const bulletMin = rules.thresholds.brief_bullet_heavy_min ?? 8;
  if (bulletLines >= bulletMin) {
    violations.push({
      rule: 'brief.bullet-heavy',
      severity: 'med',
      label: 'bullet-heavy brief',
      message: `brief.bullet-heavy: ${bulletLines} bullet lines; brief should default to paragraph form`,
      suggest: 'rewrite the bullets as 2-3 short paragraphs',
    });
  }

  // Briefs should not look like reports. A brief over the warn threshold is usually drift.
  const wordCount = text.trim().split(/\s+/).length;
  const warnAt = rules.thresholds.brief_word_count_warn ?? 350;
  const targetAt = rules.thresholds.brief_word_count_target ?? 300;
  if (wordCount > warnAt) {
    violations.push({
      rule: 'brief.length',
      severity: 'low',
      label: 'long brief',
      message: `brief.length: ${wordCount} words; brief target is under ${targetAt}`,
      suggest: 'cut anything that is not "what matters today" or "what is slipping"',
    });
  }

  return { ok: violations.length === 0, violations };
}

export function checkCommitEntry(entry) {
  const required = ['date', 'decision', 'stakeholders', 'alternatives'];
  const violations = [];
  for (const key of required) {
    if (!entry[key] || String(entry[key]).trim() === '') {
      violations.push({
        rule: `commit.missing-field.${key}`,
        severity: 'high',
        label: `missing ${key}`,
        message: `commit.missing-field: ${key} is empty`,
        suggest: `ask me before writing the entry`,
      });
    }
  }
  if (entry.alternatives && /^no alternatives$/i.test(entry.alternatives.trim())) {
    // "no alternatives" alone is suspicious; prefer the explicit "no real alternatives".
    violations.push({
      rule: 'commit.alternatives-thin',
      severity: 'low',
      label: 'thin alternatives',
      message: 'commit.alternatives-thin: "no alternatives" reads like avoidance; prefer "no real alternatives" verbatim if that is true',
      suggest: 'use the literal phrase "no real alternatives" when there were none',
    });
  }
  return { ok: violations.length === 0, violations };
}

export function audit(kind, text, ctx = {}) {
  let result;
  switch (kind) {
    case 'voice':  result = checkVoice(text); break;
    case 'email':  result = checkEmailDraft(text, ctx); break;
    case 'brief':  result = checkBrief(text); break;
    case 'commit': result = checkCommitEntry(text); break;
    default:       throw new Error(`unknown audit kind: ${kind}`);
  }
  // Append a row to the audit log so observability can chart drift over time.
  // Skip writing for the commit kind because its "text" is structured.
  if (!ctx.skipAudit && kind !== 'commit') {
    appendAudit({
      at: new Date().toISOString(),
      kind,
      actor: ctx.actor ?? null,
      item_id: ctx.item?.id ?? ctx.itemId ?? null,
      word_count: typeof text === 'string' ? text.trim().split(/\s+/).length : null,
      ok: result.ok,
      violation_count: result.violations.length,
      violation_rules: result.violations.map((v) => v.rule),
    });
  }
  return result;
}

export const PATHS = { RULES_PATH, LOCAL_RULES_PATH, AUDIT_PATH };

export function summarize(violations) {
  if (!violations.length) return { ok: true, summary: 'no violations', counts: {} };
  const counts = {};
  for (const v of violations) counts[v.rule] = (counts[v.rule] ?? 0) + 1;
  const high = violations.filter((v) => v.severity === 'high').length;
  const med = violations.filter((v) => v.severity === 'med').length;
  const low = violations.filter((v) => v.severity === 'low').length;
  const summary = `${violations.length} violation${violations.length === 1 ? '' : 's'}: ${high} high, ${med} med, ${low} low`;
  return { ok: high === 0, summary, counts };
}
