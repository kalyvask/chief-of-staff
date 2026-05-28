// Hook: dormant project status.
//
// Reads projects/*/status.md, flags any with a Last updated > N days ago,
// and emits a Yours queue item suggesting a status refresh or archive.
// Dedupe key: hook.dormant-project.<slug>.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addItem, loadQueue } from '../queue.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECTS_DIR = path.resolve(__dirname, '..', '..', 'projects');

export default function run({ daysThreshold = 21 } = {}) {
  if (!fs.existsSync(PROJECTS_DIR)) return { hook: 'dormant-project', surfaced: 0, created: [] };
  const now = Date.now();
  const todayIso = new Date().toISOString().slice(0, 10);

  const recent = new Set();
  for (const item of loadQueue().values()) {
    if (item.created_at && item.created_at.slice(0, 10) === todayIso) {
      for (const p of item.provenance ?? []) {
        if (p.type === 'hook.dormant-project') recent.add(p.ref);
      }
    }
  }

  const created = [];
  let checked = 0;
  for (const name of fs.readdirSync(PROJECTS_DIR)) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const dir = path.join(PROJECTS_DIR, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    checked++;
    if (recent.has(name)) continue;
    const statusPath = path.join(dir, 'status.md');
    if (!fs.existsSync(statusPath)) continue;
    const text = fs.readFileSync(statusPath, 'utf8');
    const m = text.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/);
    if (!m) continue;
    const ageDays = Math.floor((now - new Date(m[1]).getTime()) / 86400000);
    if (ageDays <= daysThreshold) continue;
    const newItem = addItem(
      {
        bucket: 'Yours',
        priority: ageDays > 45 ? 'high' : 'med',
        summary: `Project "${name}" dormant ${ageDays} days. Refresh status or archive.`,
        source: 'hook',
        source_id: 'hook.dormant-project',
        proposed_action: `Open projects/${name}/status.md. Either touch Last updated with a real refresh, or move the folder to projects/_archive/${name}.`,
        project: name,
        provenance: [{ type: 'hook.dormant-project', ref: name, note: `status.md last updated ${m[1]}` }],
        required_tier: 0,
      },
      { actor: 'hooks-runner', rule: 'hook.dormant-project' },
    );
    created.push({ slug: name, ageDays, new: newItem.id });
  }
  return { hook: 'dormant-project', checked, surfaced: created.length, created };
}
