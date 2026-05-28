// Chief of Staff: zero-LLM entity extraction.
//
// Runs a small set of deterministic regex extractors over free-text fields
// (stakeholder notes, relationship field values, decision narratives,
// meeting topics) and emits typed edges that get merged into
// data/graph.json by tools/build-graph.mjs.
//
// The point is to enrich the graph without spending an LLM call per page,
// which keeps the deterministic substrate intact and the edges debuggable.
//
// Public API:
//   extractFromText(text, ctx)       -> edge[]
//   extractFromEntity(entity, kind)  -> edge[]   (walks fields and notes)
//   COMPANY_SUFFIX_RE                -> the regex used for company tokens
//
// Edge shape (all extracted edges set source = 'entities'):
//   { type, from, to?, raw?, evidence, source: 'entities', source_file?, source_line? }
//
// Types emitted today:
//   works_at         from a stakeholder to a company token ("PM at Snowflake", "Senior Engineer @ Stripe")
//   founded          from a stakeholder to a company ("co-founded Resolve AI", "founder of X")
//   invested_in      from a stakeholder to a company ("invested in X", "LP at X", "led the seed in X")
//   advises          ("advisor to X", "advises X", "board member at X")
//   mentions_email   raw email captured from any text body
//   mentions_url     raw URL captured from any text body
//   mentions_company company token captured but not yet linked to a relation verb
//
// Conservative by default: ambiguous matches get tagged as `mentions_*` rather
// than asserted as a relation. The graph reader can promote those later.

const COMPANY_SUFFIX_RE = /\b([A-Z][A-Za-z0-9&+\-.'/ ]{1,40}?\s+(?:Inc|LLC|Ltd|GmbH|AG|SA|SARL|Corp|Co|Pte|Plc|Pty|S\.A\.|N\.V\.|B\.V\.|K\.K\.|Holdings|Group|Partners|Capital|Ventures|Labs))\b/g;

// Proper-noun company token: a 1-3 word run starting with a capital letter,
// each word is also capitalized or all-uppercase (FAANG-style acronyms),
// no trailing lowercase preposition. We deliberately under-match here because
// false positives in the graph are louder than false negatives.
const PROPER_NOUN_TOKEN = '[A-Z][A-Za-z0-9.+]*(?:\\s+(?:[A-Z][A-Za-z0-9.+]*|of|the|and|&)){0,3}\\s*[A-Z][A-Za-z0-9.+]*|[A-Z][A-Za-z0-9.+]{2,}';
// More forgiving (single word OK) for relation-anchored matches.
const SHORT_PN = '[A-Z][A-Za-z0-9.+&\\-]{2,}(?:\\s+[A-Z][A-Za-z0-9.+&\\-]+){0,3}';

// Note: no `i` flag. The character class [A-Z] in SHORT_PN must stay
// case-sensitive so it does not pull in trailing lowercase prepositions
// ("Snowflake on the data clean room"). Relation verbs are matched
// literally; chief-of-staff notes are typically well-formatted.
const RE_WORKS_AT = new RegExp(`\\b(?:PM|Product Manager|Engineer|Partner|Director|VP|Founder|Co-?founder|Head|Lead|Principal|Advisor|Investor|Associate|Analyst|Chief\\s+\\w+|CTO|CEO|CPO|COO|CFO)\\s+(?:at|@)\\s+(${SHORT_PN})`, 'g');
const RE_AT_COMPANY = new RegExp(`\\bat\\s+(${SHORT_PN})(?=\\s*(?:[,.;:)]|$|\\s+(?:where|whose|which|who)))`, 'g');
const RE_FOUNDED = new RegExp(`\\b(?:[Cc]o-?founded|[Ff]ounded|[Ff]ounder of|[Cc]o-?founder of)\\s+(${SHORT_PN})`, 'g');
const RE_INVESTED = new RegExp(`\\b(?:[Ii]nvested in|[Ll]ed (?:the )?(?:seed|Series\\s+[A-Z])\\s+in|LP (?:at|in)|[Bb]acker of|[Bb]acked)\\s+(${SHORT_PN})`, 'g');
const RE_ADVISES = new RegExp(`\\b(?:[Aa]dvisor to|[Aa]dvises|[Bb]oard (?:member|seat) (?:at|on)|on the board of)\\s+(${SHORT_PN})`, 'g');

const RE_EMAIL = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const RE_URL = /\bhttps?:\/\/[^\s)\]]+/g;

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeCompany(raw) {
  let s = String(raw).replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '');
  // Strip trailing prepositions and conjunctions the relation regex may have
  // greedily included ("Resolve AI in 2024" -> "Resolve AI").
  s = s.replace(/\s+(?:in|on|at|of|to|from|for|with|by|and|or|the|a|an)\s*$/i, '').trim();
  return s;
}

// Common tokens that are not companies; suppress false positives.
const NOT_A_COMPANY = new Set([
  'i','the','a','an','and','or','but','so','at','to','of','for','with','from','into',
  'on','off','out','up','down','over','under','near','here','there','this','that',
  'his','her','their','its','my','your','our','ours','yours','theirs',
  'gsb','mba','phd','cs','llm','ai','ui','ux','api','sql','sdk','io',
  'one','two','three','four','five','six','seven','eight','nine','ten',
  'mon','tue','wed','thu','fri','sat','sun',
  'jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
  'tbd','tba','wip','n/a',
]);

function looksLikeCompany(s) {
  const trimmed = String(s).trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (NOT_A_COMPANY.has(lower)) return false;
  if (lower.length < 2) return false;
  // Reject sentence fragments: anything ending with a sentence-final verb tail.
  if (/\b(?:is|was|are|were|has|have|had|will|would|should|could)\b$/i.test(trimmed)) return false;
  return /^[A-Z]/.test(trimmed);
}

function pushEdge(out, edge, ctx) {
  const enriched = { ...edge, source: 'entities' };
  if (ctx?.source_file) enriched.source_file = ctx.source_file;
  if (ctx?.source_line) enriched.source_line = ctx.source_line;
  if (ctx?.from) enriched.from = enriched.from ?? ctx.from;
  out.push(enriched);
}

function dedupe(edges) {
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    const key = `${e.type}|${e.from ?? ''}|${e.to ?? ''}|${e.raw ?? ''}|${e.source_file ?? ''}|${e.source_line ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

export function extractFromText(text, ctx = {}) {
  if (!text || typeof text !== 'string') return [];
  const out = [];

  const runRelation = (re, type) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      const target = normalizeCompany(m[1]);
      if (!looksLikeCompany(target)) continue;
      pushEdge(out, {
        type,
        to: slug(target),
        raw: target,
        evidence: m[0],
      }, ctx);
    }
  };

  runRelation(RE_WORKS_AT, 'works_at');
  runRelation(RE_FOUNDED, 'founded');
  runRelation(RE_INVESTED, 'invested_in');
  runRelation(RE_ADVISES, 'advises');

  // RE_AT_COMPANY is broader; emit as works_at only if no founded/invested
  // already captured the same target (the more-specific relations win).
  const alreadyTargeted = new Set(out.map((e) => e.to));
  RE_AT_COMPANY.lastIndex = 0;
  let m;
  while ((m = RE_AT_COMPANY.exec(text)) !== null) {
    const target = normalizeCompany(m[1]);
    if (!looksLikeCompany(target)) continue;
    const id = slug(target);
    if (alreadyTargeted.has(id)) continue;
    pushEdge(out, { type: 'works_at', to: id, raw: target, evidence: m[0] }, ctx);
    alreadyTargeted.add(id);
  }

  // Inc/LLC/etc tokens are nearly always real companies; capture them as
  // mentions_company even if no relation verb is nearby.
  COMPANY_SUFFIX_RE.lastIndex = 0;
  while ((m = COMPANY_SUFFIX_RE.exec(text)) !== null) {
    const target = normalizeCompany(m[1]);
    const id = slug(target);
    if (alreadyTargeted.has(id)) continue;
    pushEdge(out, { type: 'mentions_company', to: id, raw: target, evidence: m[0] }, ctx);
  }

  // Emails and URLs: capture as mentions_*. Useful for "who emailed me from X".
  RE_EMAIL.lastIndex = 0;
  while ((m = RE_EMAIL.exec(text)) !== null) {
    pushEdge(out, { type: 'mentions_email', to: m[0].toLowerCase(), raw: m[0], evidence: m[0] }, ctx);
  }
  RE_URL.lastIndex = 0;
  while ((m = RE_URL.exec(text)) !== null) {
    pushEdge(out, { type: 'mentions_url', to: m[0], raw: m[0], evidence: m[0] }, ctx);
  }

  return dedupe(out);
}

// Walk every text-carrying surface of a parsed graph entity (stakeholders,
// relationships, decisions, meetings) and aggregate edges. The entity carries
// its id and source-line; we pass those through so the graph reader can
// surface the file:line evidence.
export function extractFromEntity(entity, kind) {
  const edges = [];
  const sourceFile = ({
    stakeholder: 'context/stakeholders.md',
    relationship: 'memory/relationships.md',
    decision: 'memory/decisions.md',
    meeting: 'memory/meetings.md',
  })[kind] ?? null;
  const ctx = {
    from: entity.id,
    source_file: sourceFile,
    source_line: entity.line ?? null,
  };

  // Notes / free text body (stakeholders carry this on .notes).
  if (entity.notes) {
    for (const e of extractFromText(entity.notes, ctx)) edges.push(e);
  }
  // Fields are {key: {value, placeholder}} for stakeholders/relationships,
  // or {key: value} for decisions/meetings. Handle both.
  if (entity.fields && typeof entity.fields === 'object') {
    for (const [, fv] of Object.entries(entity.fields)) {
      const value = typeof fv === 'object' && fv ? fv.value : fv;
      if (typeof value === 'string' && value.length) {
        for (const e of extractFromText(value, ctx)) edges.push(e);
      }
    }
  }
  // Decision narrative.
  if (entity.decision) {
    for (const e of extractFromText(entity.decision, ctx)) edges.push(e);
  }
  // Meeting title and topic.
  if (entity.title) {
    for (const e of extractFromText(entity.title, ctx)) edges.push(e);
  }
  if (entity.topic) {
    for (const e of extractFromText(entity.topic, ctx)) edges.push(e);
  }

  return dedupe(edges);
}

export { COMPANY_SUFFIX_RE };
