// Hook: newsletter digest.
//
// Newsletters arrive every day and rarely need individual attention. /am-sweep
// writes a queue item per unread email, so when 20 newsletters land overnight
// they each become an item I have to triage. This hook rolls them up.
//
// Heuristic: open queue items where source is gmail (or hook with gmail
// provenance) and the sender or summary matches a newsletter pattern. If
// three or more match in the lookback window, create a single Prep item
// summarizing them and close the originals with outcome `rolled into digest`.
//
// Dedupe key: hook.newsletter-digest.<isoweek>. Only one digest per ISO week.

import { loadOpen, addItem, closeItem, loadQueue } from '../queue.mjs';

const NEWSLETTER_SENDERS = [
  /newsletter/i,
  /no-?reply/i,
  /@substack\.com/i,
  /@beehiiv\.com/i,
  /@convertkit\.com/i,
  /@mailchimp\.com/i,
  /@mailerlite\.com/i,
  /@ghost\.io/i,
  /@buttondown\./i,
];

const NEWSLETTER_SUMMARIES = [
  /\b(newsletter|digest|weekly|daily brief|the morning|the download)\b/i,
];

function looksLikeNewsletter(item) {
  if (item.source !== 'gmail' && !(item.source === 'hook' && (item.provenance ?? []).some((p) => p.type?.startsWith('gmail')))) {
    return false;
  }
  if (item.sender && NEWSLETTER_SENDERS.some((re) => re.test(item.sender))) return true;
  if (item.summary && NEWSLETTER_SUMMARIES.some((re) => re.test(item.summary))) return true;
  if (item.category === 'newsletter') return true;
  return false;
}

function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil((((d - start) / 86400000) + 1) / 7)).padStart(2, '0')}`;
}

export default function run({ minToRoll = 3 } = {}) {
  const todayWeek = isoWeek(new Date());

  // Dedupe: have we already produced a digest for this week?
  for (const item of loadQueue().values()) {
    for (const p of item.provenance ?? []) {
      if (p.type === 'hook.newsletter-digest' && p.ref === todayWeek) {
        return { hook: 'newsletter-digest', skipped: `already rolled for ${todayWeek}`, surfaced: 0, created: [] };
      }
    }
  }

  const candidates = loadOpen().filter(looksLikeNewsletter);
  if (candidates.length < minToRoll) {
    return { hook: 'newsletter-digest', week: todayWeek, candidates: candidates.length, threshold: minToRoll, surfaced: 0, created: [] };
  }

  const senders = [...new Set(candidates.map((c) => c.sender).filter(Boolean))];
  const summaryHead = candidates.slice(0, 5).map((c) => `- ${c.sender ? c.sender + ': ' : ''}${c.summary}`).join('\n');
  const summary = `Newsletter digest (${todayWeek}): ${candidates.length} items rolled. Read or archive in one pass.`;

  const provenance = [
    { type: 'hook.newsletter-digest', ref: todayWeek, note: `${candidates.length} items, ${senders.length} senders` },
    ...candidates.map((c) => ({ type: 'queue.item', ref: c.id })),
  ];

  const proposedAction = `Open the digest, skim, archive all originals. Senders: ${senders.slice(0, 8).join(', ')}${senders.length > 8 ? '...' : ''}\n\nFirst 5 lines:\n${summaryHead}`;

  const newItem = addItem(
    {
      bucket: 'Prep',
      priority: 'low',
      summary,
      source: 'hook',
      source_id: `hook.newsletter-digest.${todayWeek}`,
      proposed_action: proposedAction,
      provenance,
      required_tier: 0,
    },
    { actor: 'hooks-runner', rule: 'hook.newsletter-digest' },
  );

  for (const c of candidates) {
    closeItem(c.id, `rolled into digest ${newItem.id}`, {
      actor: 'hooks-runner',
      rule: 'hook.newsletter-digest.roll',
    });
  }

  return {
    hook: 'newsletter-digest',
    week: todayWeek,
    candidates: candidates.length,
    surfaced: 1,
    created: [{ digest: newItem.id, rolled: candidates.length, senders: senders.length }],
  };
}
