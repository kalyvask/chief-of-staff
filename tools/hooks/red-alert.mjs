// Hook: red alert.
//
// Scans the open queue for high-priority Yours items (Red, the highest-
// stakes class), and DMs each one to Slack so Alex sees it on his phone even
// when he is not at the laptop. Dedups via provenance: once an item has a
// `hook.red-alert` provenance entry it is never re-alerted, even if the hook
// runs again on the same item.
//
// Targeting:
//   - SLACK_ALERT_CHANNEL env var: a channel id (Cxxx) or user DM id (Dxxx).
//   - If SLACK_BOT_TOKEN is set, posts via chat.postMessage to that channel.
//   - If only SLACK_WEBHOOK_URL is set, posts via the webhook (channel-pinned).
//   - If neither is set, returns gracefully (no alerts, no errors).
//
// Side effects:
//   - One Slack post per new Red item.
//   - One addProvenance() write per successfully alerted item, to dedup.
//
// Throttling: a single run only alerts on items that became Red within the
// last RECENT_WINDOW_HOURS (default 24). Older Red items are assumed to have
// already been handled or are stale.

import { loadOpen, addProvenance } from '../queue.mjs';
import { postSlack } from '../slack-respond.mjs';

const RECENT_WINDOW_HOURS = 24;

function summaryFor(item, alertedAt) {
  const created = item.created_at ? item.created_at.slice(0, 16).replace('T', ' ') : 'unknown time';
  const lines = [
    `🔴 Red item: ${item.summary || '(no summary)'}`,
    `  id: ${item.id}`,
    `  source: ${item.source ?? 'unknown'}` + (item.sender ? `, from ${item.sender}` : ''),
    `  created: ${created} UTC`,
  ];
  if (item.proposed_action) lines.push(`  next: ${item.proposed_action}`);
  if (item.project) lines.push(`  project: ${item.project}`);
  return lines.join('\n');
}

export default async function run({ now = null, channel = null, dryRun = false } = {}) {
  const nowMs = now ? new Date(now).getTime() : Date.now();
  const windowMs = RECENT_WINDOW_HOURS * 3600 * 1000;

  const alertChannel = channel ?? process.env.SLACK_ALERT_CHANNEL ?? null;
  const hasBotToken = !!process.env.SLACK_BOT_TOKEN;
  const hasWebhook = !!process.env.SLACK_WEBHOOK_URL;

  if (!hasBotToken && !hasWebhook) {
    return {
      hook: 'red-alert',
      skipped: 'no Slack credentials configured (SLACK_BOT_TOKEN or SLACK_WEBHOOK_URL)',
      alerts: [],
    };
  }
  // If bot token is set without a channel, fall back to webhook when available.
  // Only skip when neither path can deliver.
  if (hasBotToken && !alertChannel && !hasWebhook) {
    return {
      hook: 'red-alert',
      skipped: 'SLACK_BOT_TOKEN set but SLACK_ALERT_CHANNEL not configured and no SLACK_WEBHOOK_URL fallback; set SLACK_ALERT_CHANNEL (Cxxx for a channel, Dxxx for a DM) or keep the webhook configured',
      alerts: [],
    };
  }

  const open = loadOpen();
  const candidates = open.filter((item) => {
    if (item.bucket !== 'Yours') return false;
    if (item.priority !== 'high') return false;
    const createdMs = item.created_at ? new Date(item.created_at).getTime() : 0;
    if (nowMs - createdMs > windowMs) return false;
    // dedup: skip if already alerted
    const alreadyAlerted = (item.provenance ?? []).some((p) => p.type === 'hook.red-alert');
    if (alreadyAlerted) return false;
    return true;
  });

  if (candidates.length === 0) {
    return { hook: 'red-alert', alerts: [], reason: 'no new Red items in window', window_hours: RECENT_WINDOW_HOURS };
  }

  const alertedAt = new Date(nowMs).toISOString();
  const alerts = [];
  const errors = [];

  for (const item of candidates) {
    const text = summaryFor(item, alertedAt);
    if (dryRun) {
      alerts.push({ item_id: item.id, dry_run: true, text });
      continue;
    }
    try {
      const result = await postSlack({ channel: alertChannel, text });
      addProvenance(
        item.id,
        { type: 'hook.red-alert', ref: alertedAt, note: `slack post (${result.mode})` },
        { actor: 'hooks-runner', rule: 'hook.red-alert' },
      );
      alerts.push({ item_id: item.id, slack_mode: result.mode, slack_ts: result.ts ?? null });
    } catch (err) {
      errors.push({ item_id: item.id, error: err.message });
    }
  }

  return {
    hook: 'red-alert',
    channel: alertChannel,
    alerted: alerts.length,
    failed: errors.length,
    alerts,
    errors,
  };
}
