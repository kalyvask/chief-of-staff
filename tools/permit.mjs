// Chief of Staff: permissions engine.
//
// Wraps every side-effect action the agent or a subagent is about to take.
// Read the action class, the actor (the subagent name), and an optional
// queue item id, and return {allowed, rule, requiredTier, actorTier, reason}.
// Every call is appended to data/permit-audit.jsonl so I can see exactly
// what the agent tried to do and what was allowed.
//
// Config:
//   data/tiers.json -- tier descriptions, action -> required tier, actor -> current tier.
//
// Public API:
//   permit({action, actor, itemId?, note?, dryRun?}) -> decision
//   raiseActor(actor, tier, {reason, actorWriter})   -> persists actor tier change to tiers.json
//   listActions()                                    -> action catalog
//   tierFor(actor)                                   -> integer
//
// Enforcement is contract-level: the agent prompts instruct each subagent to
// call permit() before any side-effect tool. The audit file is the ground
// truth on what was attempted, so a missed permit() call shows up as a tool
// invocation with no preceding allow entry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getItem } from './queue.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TIERS_PATH = path.resolve(REPO_ROOT, 'data', 'tiers.json');
const AUDIT_PATH = path.resolve(REPO_ROOT, 'data', 'permit-audit.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function ensureAuditFile() {
  const dir = path.dirname(AUDIT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(AUDIT_PATH)) fs.writeFileSync(AUDIT_PATH, '');
}

export function loadTiers() {
  if (!fs.existsSync(TIERS_PATH)) {
    throw new Error(`tiers config missing at ${TIERS_PATH}`);
  }
  return JSON.parse(fs.readFileSync(TIERS_PATH, 'utf8'));
}

export function listActions() {
  return loadTiers().actions;
}

export function tierFor(actor) {
  const cfg = loadTiers();
  return cfg.actors[actor] ?? 0;
}

function writeAudit(entry) {
  ensureAuditFile();
  fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

// Routine modes (Town pattern). Each slash command declares a mode in its
// frontmatter; the agent passes that mode through every permit check inside
// that routine. The mode caps the actor's effective tier and tightens the
// approval gate. It can only restrict, never expand.
//
//   read-only          -> ceiling 0. Only T0 actions allowed regardless of actor tier.
//   approval-required  -> ceiling 2. T2+ actions require an approved queue item (same gate T3 always has).
//   autonomous         -> no cap. Actor tier applies as usual.
//
// Undefined / null is treated as autonomous (backward compatible).
const ROUTINE_CEILING = {
  'read-only': 0,
  'approval-required': 2,
  'autonomous': Infinity,
};

export function permit({ action, actor, itemId = null, note = null, routineMode = null, dryRun = false }) {
  const cfg = loadTiers();
  const def = cfg.actions[action];
  const at = nowIso();
  const base = { at, action, actor, itemId, note, routineMode };

  if (!def) {
    const result = { ...base, allowed: false, reason: `unknown action: ${action}` };
    if (!dryRun) writeAudit(result);
    return result;
  }

  const actorTier = cfg.actors[actor] ?? 0;
  const requiredTier = def.required_tier;

  if (routineMode && !(routineMode in ROUTINE_CEILING)) {
    const result = { ...base, allowed: false, requiredTier, actorTier, rule: def.id, reason: `unknown routineMode: ${routineMode}` };
    if (!dryRun) writeAudit(result);
    return result;
  }
  const ceiling = routineMode ? ROUTINE_CEILING[routineMode] : Infinity;
  const effectiveTier = Math.min(actorTier, ceiling);

  // Approval gate: tier-3 always requires an approved queue item.
  // approval-required mode extends the same gate down to tier-2.
  const approvalThreshold = routineMode === 'approval-required' ? 2 : 3;
  if (requiredTier >= approvalThreshold) {
    if (!itemId) {
      const result = { ...base, allowed: false, requiredTier, actorTier, effectiveTier, rule: def.id, reason: `action requires itemId under ${routineMode ?? 'tier-3'} gate` };
      if (!dryRun) writeAudit(result);
      return result;
    }
    const item = getItem(itemId);
    if (!item) {
      const result = { ...base, allowed: false, requiredTier, actorTier, effectiveTier, rule: def.id, reason: `queue item ${itemId} not found` };
      if (!dryRun) writeAudit(result);
      return result;
    }
    if (item.approval_state !== 'approved') {
      const result = { ...base, allowed: false, requiredTier, actorTier, effectiveTier, rule: def.id, reason: `item ${itemId} approval_state=${item.approval_state}` };
      if (!dryRun) writeAudit(result);
      return result;
    }
    if ((item.required_tier ?? 0) > requiredTier) {
      const result = { ...base, allowed: false, requiredTier, actorTier, effectiveTier, rule: def.id, reason: `item ${itemId} required_tier=${item.required_tier} exceeds ${requiredTier}` };
      if (!dryRun) writeAudit(result);
      return result;
    }
  }

  if (effectiveTier < requiredTier) {
    const reason = routineMode
      ? `routine mode ${routineMode} caps tier at ${ceiling === Infinity ? actorTier : ceiling}; action ${action} requires tier ${requiredTier}`
      : `actor ${actor} at tier ${actorTier}; action ${action} requires tier ${requiredTier}`;
    const result = { ...base, allowed: false, requiredTier, actorTier, effectiveTier, rule: def.id, reason };
    if (!dryRun) writeAudit(result);
    return result;
  }

  const result = { ...base, allowed: true, requiredTier, actorTier, effectiveTier, rule: def.id, scope: def.scope ?? null };
  if (!dryRun) writeAudit(result);
  return result;
}

export function raiseActor(actor, tier, { reason, actorWriter = 'user' } = {}) {
  if (actorWriter !== 'user') {
    throw new Error('raiseActor: only the user can change actor tiers');
  }
  if (![0, 1, 2, 3].includes(tier)) throw new Error(`tier must be 0..3, got ${tier}`);
  const cfg = loadTiers();
  const prev = cfg.actors[actor] ?? 0;
  cfg.actors[actor] = tier;
  fs.writeFileSync(TIERS_PATH, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  writeAudit({
    at: nowIso(),
    action: 'actor.tier.raised',
    actor: actorWriter,
    target: actor,
    previousTier: prev,
    newTier: tier,
    reason: reason ?? null,
  });
  return { actor, previousTier: prev, newTier: tier };
}

export const PATHS = { TIERS_PATH, AUDIT_PATH };
