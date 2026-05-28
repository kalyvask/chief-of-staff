// Chief of Staff: client-side controller.

// If the server was started with COS_API_TOKEN set (only needed when you bind
// it to a non-loopback HOST), the /api surface requires that token. Attach it
// to every API request and prompt once on the first 401. When no token is set
// server-side, this wrapper is inert.
(function installAuth() {
  const KEY = "cos_token";
  const nativeFetch = window.fetch.bind(window);
  const withToken = (init = {}) => {
    const token = localStorage.getItem(KEY);
    if (!token) return init;
    const headers = new Headers(init.headers || {});
    headers.set("X-COS-Token", token);
    return { ...init, headers };
  };
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    const isApi = url.startsWith("/api") || url.includes(`${location.origin}/api`);
    if (!isApi) return nativeFetch(input, init);
    let res = await nativeFetch(input, withToken(init));
    if (res.status === 401) {
      const token = window.prompt("This Chief of Staff server requires an access token (COS_API_TOKEN):");
      if (token) {
        localStorage.setItem(KEY, token);
        res = await nativeFetch(input, withToken(init));
      }
    }
    return res;
  };
})();

const $ = (id) => document.getElementById(id);
const $messages = $("messages");
const $form = $("composer");
const $prompt = $("prompt");
const $send = $form.querySelector(".send");
const $status = $("status");
const $contextList = $("contextList");
const $memoryList = $("memoryList");
const $systemList = $("systemList");
const $maintList = $("maintList");
const $maintCount = $("maintCount");
const $tasksList = $("tasksList");
const $recentList = $("recentList");
const $queueList = $("queueList");
const $queueCount = $("queueCount");
const $projectsList = $("projectsList");
const $projectsCount = $("projectsCount");
const $auditCard = $("auditCard");

const CONTEXT_PATHS = [
  "context/stakeholders.md",
  "context/priorities.md",
  "context/research_arc.md",
  "context/career_thesis.md",
  "context/operating_principles.md",
];
const MEMORY_PATHS = [
  "memory/decisions.md",
  "memory/relationships.md",
  "memory/learnings.md",
];
const SYSTEM_PATHS = ["CLAUDE.md", "tasks.md"];

let recent = [];
let contextSnapshot = {};

const escapeHtml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const renderProse = (text) =>
  escapeHtml(text)
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, "<br />")}</p>`)
    .join("");

function setStatus(state, text) {
  $status.dataset.state = state;
  $status.textContent = text;
}

function appendMessage({ role, html, classes = "", id } = {}) {
  const el = document.createElement("article");
  el.className = ["message", `message-${role}`, classes].filter(Boolean).join(" ");
  if (id) el.id = id;
  el.innerHTML = html;
  $messages.appendChild(el);
  el.scrollIntoView({ behavior: "smooth", block: "end" });
  return el;
}

// ---------- Modal: editor / guide ----------
const $overlay = $("overlay");
const $modal = $("modal");
const $modalTitle = $("modalTitle");
const $modalEditor = $("modalEditor");
const $modalReadonly = $("modalReadonly");
const $modalSave = $("modalSave");
const $modalCancel = $("modalCancel");
const $modalHint = $("modalHint");
let modalState = { path: null, mode: null };

function openEditor(path) {
  modalState = { path, mode: "edit" };
  fetch(`/api/file?path=${encodeURIComponent(path)}`)
    .then((r) => r.json())
    .then(({ content, readonly }) => {
      $modalTitle.textContent = path;
      if (readonly) {
        $modalEditor.hidden = true;
        $modalReadonly.hidden = false;
        $modalReadonly.innerHTML = simpleMarkdown(content);
        $modalSave.hidden = true;
        $modalHint.textContent = "Read-only";
      } else {
        $modalEditor.hidden = false;
        $modalReadonly.hidden = true;
        $modalEditor.value = content;
        $modalSave.hidden = false;
        $modalSave.disabled = false;
        $modalHint.textContent = "Cmd+S to save · Esc to close";
      }
      $overlay.hidden = false;
      if (!readonly) $modalEditor.focus();
    });
}

function openGuide() {
  modalState = { path: "USAGE.md", mode: "view" };
  fetch(`/api/file?path=USAGE.md`)
    .then((r) => r.json())
    .then(({ content }) => {
      $modalTitle.textContent = "Guide";
      $modalEditor.hidden = true;
      $modalReadonly.hidden = false;
      $modalReadonly.innerHTML = simpleMarkdown(content);
      $modalSave.hidden = true;
      $modalHint.textContent = "Reference";
      $overlay.hidden = false;
    });
}

function closeModal() {
  $overlay.hidden = true;
  modalState = { path: null, mode: null };
}

async function saveModal() {
  if (modalState.mode !== "edit" || !modalState.path) return;
  $modalSave.disabled = true;
  $modalHint.textContent = "Saving…";
  try {
    const res = await fetch("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: modalState.path,
        content: $modalEditor.value,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    $modalHint.textContent = "Saved";
    closeModal();
    await Promise.all([loadContext(), loadMaintenance(), loadTasks()]);
  } catch (err) {
    $modalHint.textContent = `Error: ${err.message || err}`;
    $modalSave.disabled = false;
  }
}

$modalCancel.addEventListener("click", closeModal);
$modalSave.addEventListener("click", saveModal);
$overlay.addEventListener("click", (e) => {
  if (e.target === $overlay) closeModal();
});
document.addEventListener("keydown", (e) => {
  if ($overlay.hidden) return;
  if (e.key === "Escape") closeModal();
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    saveModal();
  }
});

$("guideBtn").addEventListener("click", openGuide);
const $guideInline = $("guideInline");
if ($guideInline) $guideInline.addEventListener("click", openGuide);

$("addTaskBtn").addEventListener("click", () => openEditor("tasks.md"));

// ---------- Tiny markdown renderer (headings, paragraphs, code, lists) ----------
function simpleMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let codeLang = "";

  const flushLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  for (const raw of lines) {
    const line = raw;
    if (line.startsWith("```")) {
      if (!inCode) {
        flushLists();
        codeLang = line.slice(3).trim();
        out.push(`<pre><code class="lang-${escapeHtml(codeLang)}">`);
        inCode = true;
      } else {
        out.push("</code></pre>");
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(line));
      continue;
    }

    if (/^\s*$/.test(line)) {
      flushLists();
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushLists();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      continue;
    }

    const ulMatch = line.match(/^[-*]\s+(.*)$/);
    if (ulMatch) {
      if (!inUl) { flushLists(); out.push("<ul>"); inUl = true; }
      out.push(`<li>${inline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = line.match(/^\d+\.\s+(.*)$/);
    if (olMatch) {
      if (!inOl) { flushLists(); out.push("<ol>"); inOl = true; }
      out.push(`<li>${inline(olMatch[1])}</li>`);
      continue;
    }

    flushLists();
    out.push(`<p>${inline(line)}</p>`);
  }

  flushLists();
  if (inCode) out.push("</code></pre>");
  return out.join("\n");
}

function inline(s) {
  return escapeHtml(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

// ---------- Context list ----------
function renderContextSection($el, paths, snapshot) {
  if (paths.length === 0) {
    $el.innerHTML = `<li class="context-item is-empty">None</li>`;
    return;
  }
  const now = Date.now();
  $el.innerHTML = paths
    .map((path) => {
      const content = snapshot[path] || "";
      const m = content.match(/Last updated:\s*(\d{4}-\d{2}-\d{2})/);
      let stale = false;
      if (m) {
        const ageDays = Math.floor((now - new Date(m[1]).getTime()) / 86400000);
        stale = ageDays > 14;
      }
      const stub = (content.match(/_To fill in[^_]*_/g) || []).length > 0;
      const flags = [];
      if (stale) flags.push(`<span class="context-item-flag is-stale">stale</span>`);
      if (stub) flags.push(`<span class="context-item-flag is-stub">stub</span>`);
      const display = path.split("/").pop();
      return `<li>
        <button class="context-item" data-path="${escapeHtml(path)}">
          <span>${escapeHtml(display)}</span>
          ${flags.join("")}
        </button>
      </li>`;
    })
    .join("");
  $el.querySelectorAll(".context-item[data-path]").forEach((btn) => {
    btn.addEventListener("click", () => openEditor(btn.dataset.path));
  });
}

async function loadContext() {
  try {
    const res = await fetch("/api/context");
    contextSnapshot = await res.json();
    renderContextSection($contextList, CONTEXT_PATHS, contextSnapshot);
    renderContextSection($memoryList, MEMORY_PATHS, contextSnapshot);
    renderContextSection($systemList, SYSTEM_PATHS, contextSnapshot);
  } catch (err) {
    $contextList.innerHTML = `<li class="context-item is-empty">Could not load context.</li>`;
  }
}

// ---------- Maintenance ----------
async function loadMaintenance() {
  try {
    const res = await fetch("/api/maintenance");
    const { items } = await res.json();
    $maintCount.textContent = items.length;
    $maintCount.dataset.count = items.length === 0 ? "0" : "";
    if (items.length === 0) {
      $maintList.innerHTML = `<li class="maint-empty">All clear.</li>`;
      return;
    }
    $maintList.innerHTML = items
      .map(
        (it) => `<li class="maint-item" data-path="${escapeHtml(it.path)}">
          <div class="maint-item-head">
            <span class="maint-item-path">${escapeHtml(it.path.split("/").pop())}</span>
            <span class="maint-item-severity is-${it.severity}">${it.severity}</span>
          </div>
          <div class="maint-item-msg">${escapeHtml(it.message)}</div>
        </li>`,
      )
      .join("");
    $maintList.querySelectorAll(".maint-item[data-path]").forEach((el) => {
      el.addEventListener("click", () => openEditor(el.dataset.path));
    });
  } catch (err) {
    $maintList.innerHTML = `<li class="maint-empty">Could not load maintenance.</li>`;
  }
}

// ---------- Tasks ----------
function parseTasks(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let group = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      group = h[1].trim();
      continue;
    }
    const t = line.match(/^- \[( |x|X)\]\s+(.*)$/);
    if (t) {
      out.push({
        line: i,
        done: t[1].toLowerCase() === "x",
        text: t[2].trim(),
        group,
      });
    }
  }
  return out;
}

async function loadTasks() {
  try {
    const res = await fetch("/api/file?path=tasks.md");
    const { content } = await res.json();
    const tasks = parseTasks(content || "");
    if (tasks.length === 0) {
      $tasksList.innerHTML = `<li class="maint-empty">No tasks yet. Click <button class="inline-link" id="taskOpen">edit</button> to add some.</li>`;
      const $open = $("taskOpen");
      if ($open) $open.addEventListener("click", () => openEditor("tasks.md"));
      return;
    }
    let lastGroup = null;
    const html = [];
    tasks.forEach((t, idx) => {
      if (t.group !== lastGroup) {
        html.push(`<li class="task-group-heading">${escapeHtml(t.group)}</li>`);
        lastGroup = t.group;
      }
      html.push(
        `<li class="task-item ${t.done ? "is-done" : ""}" data-line="${t.line}">
          <input type="checkbox" ${t.done ? "checked" : ""} data-line="${t.line}" />
          <span class="task-text">${escapeHtml(t.text)}</span>
        </li>`,
      );
    });
    $tasksList.innerHTML = html.join("");
    $tasksList.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
      cb.addEventListener("change", () => toggleTask(parseInt(cb.dataset.line, 10), cb.checked));
    });
  } catch (err) {
    $tasksList.innerHTML = `<li class="maint-empty">Could not load tasks.</li>`;
  }
}

async function toggleTask(lineIdx, done) {
  try {
    const res = await fetch("/api/file?path=tasks.md");
    const { content } = await res.json();
    const lines = content.split(/\r?\n/);
    const cur = lines[lineIdx];
    if (!cur) return;
    const replaced = cur.replace(/^- \[( |x|X)\]/, `- [${done ? "x" : " "}]`);
    if (replaced === cur) return;
    lines[lineIdx] = replaced;
    const newContent = lines.join("\n");
    await fetch("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "tasks.md", content: newContent }),
    });
    loadTasks();
  } catch (err) {
    console.error("toggle failed", err);
  }
}

// ---------- Recent ----------
function renderRecent() {
  if (recent.length === 0) {
    $recentList.innerHTML = `<li class="recent-item recent-empty">No runs this session.</li>`;
    return;
  }
  $recentList.innerHTML = recent
    .slice(0, 6)
    .map(
      (r) => `<li class="recent-item">
        <span class="recent-item-prompt">${escapeHtml(r.prompt.slice(0, 80))}${r.prompt.length > 80 ? "…" : ""}</span>
        <span class="recent-item-meta">$${r.cost.toFixed(4)} · ${r.duration}ms</span>
      </li>`,
    )
    .join("");
}

// ---------- Chat ----------
async function send(prompt) {
  if (!prompt.trim()) return;
  $send.disabled = true;
  setStatus("streaming", "streaming");

  appendMessage({
    role: "user",
    html: `<p class="message-meta">You</p>${renderProse(prompt)}`,
  });

  const $assistant = appendMessage({
    role: "assistant",
    classes: "is-streaming",
    html: `<p class="message-meta">Chief of Staff</p><div class="message-body"></div>`,
  });
  const $body = $assistant.querySelector(".message-body");
  let buf = "";
  let cost = 0;
  let duration = 0;

  const t0 = Date.now();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let raw = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      raw += decoder.decode(value, { stream: true });
      const events = raw.split("\n\n");
      raw = events.pop() || "";
      for (const evt of events) {
        const lines = evt.split("\n");
        const type = lines.find((l) => l.startsWith("event: "))?.slice(7);
        const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
        if (!type || !data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        if (type === "text") {
          buf += payload.text;
          $body.innerHTML = renderProse(buf);
          $assistant.scrollIntoView({ behavior: "smooth", block: "end" });
        } else if (type === "tool") {
          appendMessage({ role: "tool", html: `<span>${escapeHtml(payload.name)}</span>` });
        } else if (type === "result") {
          cost = payload.cost_usd;
          duration = payload.duration_ms;
          appendMessage({
            role: "result",
            html: `cost $${cost.toFixed(4)} · ${duration}ms · ${payload.num_turns} turns`,
          });
        } else if (type === "error") {
          appendMessage({
            role: "error",
            html: `<p class="message-meta">Error</p><p>${escapeHtml(payload.message)}</p>`,
          });
        }
      }
    }
  } catch (err) {
    appendMessage({
      role: "error",
      html: `<p class="message-meta">Error</p><p>${escapeHtml(String(err.message || err))}</p>`,
    });
    setStatus("error", "error");
  } finally {
    $assistant.classList.remove("is-streaming");
    $send.disabled = false;
    setStatus("idle", "idle");
    recent.unshift({ prompt, cost, duration: duration || Date.now() - t0 });
    renderRecent();
    $prompt.value = "";
    $prompt.focus();
    // After a chat, re-check maintenance (the agent may have edited files)
    loadContext();
    loadMaintenance();
    loadTasks();
    loadQueue();
    loadProjects();
    loadAudit();
  }
}

$form.addEventListener("submit", (e) => {
  e.preventDefault();
  send($prompt.value);
});

$prompt.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    $form.requestSubmit();
  }
});

document.querySelectorAll(".action").forEach((btn) => {
  btn.addEventListener("click", () => {
    const seed = btn.dataset.prompt || "";
    $prompt.value = seed;
    $prompt.focus();
    if (!seed.endsWith(" ")) $form.requestSubmit();
  });
});

// ---------- Queue ----------
async function loadQueue() {
  try {
    const res = await fetch("/api/queue");
    const { items } = await res.json();
    $queueCount.textContent = items.length;
    $queueCount.dataset.count = items.length === 0 ? "0" : "";
    if (items.length === 0) {
      $queueList.innerHTML = `<li class="maint-empty">Queue is empty.</li>`;
      return;
    }
    const shown = items.slice(0, 8);
    $queueList.innerHTML = shown
      .map((it) => {
        const due = it.due_date ? ` · due ${escapeHtml(it.due_date)}` : "";
        const proj = it.project ? ` · ${escapeHtml(it.project)}` : "";
        const tier = it.required_tier ? ` · T${it.required_tier}` : "";
        return `<li class="queue-item" data-id="${escapeHtml(it.id)}">
          <div class="queue-item-head">
            <span class="queue-item-id">${escapeHtml(it.id)}</span>
            <span class="queue-item-bucket is-${escapeHtml(it.bucket)}">${escapeHtml(it.bucket)}</span>
          </div>
          <div class="queue-item-summary">${escapeHtml(it.summary || "(no summary)")}</div>
          <div class="queue-item-meta">${escapeHtml(it.priority)}${tier}${proj}${due}</div>
        </li>`;
      })
      .join("");
    if (items.length > shown.length) {
      $queueList.innerHTML += `<li class="maint-empty">+ ${items.length - shown.length} more</li>`;
    }
    $queueList.querySelectorAll(".queue-item[data-id]").forEach((el) => {
      el.addEventListener("click", () => openQueueItem(el.dataset.id));
    });
  } catch (err) {
    $queueList.innerHTML = `<li class="maint-empty">Could not load queue.</li>`;
  }
}

function openQueueItem(id) {
  modalState = { path: null, mode: "queue-detail", id };
  fetch(`/api/queue/${encodeURIComponent(id)}`)
    .then((r) => r.json())
    .then(({ item }) => {
      if (!item) throw new Error("not found");
      $modalTitle.textContent = id;
      $modalEditor.hidden = true;
      $modalReadonly.hidden = false;
      const due = item.due_date ?? "no due";
      const proj = item.project ?? "—";
      const cp = item.counterparty ?? item.sender ?? "—";
      const provenance = (item.provenance ?? [])
        .map((p) => `${escapeHtml(p.type)}:${escapeHtml(String(p.ref))}`)
        .join(", ") || "—";
      const lastAudit = (item.audit ?? []).slice(-1)[0];
      const auditCount = (item.audit ?? []).length;
      $modalReadonly.innerHTML = `<div class="modal-detail">
        <dl>
          <dt>Bucket</dt><dd>${escapeHtml(item.bucket)}</dd>
          <dt>Priority</dt><dd>${escapeHtml(item.priority)}</dd>
          <dt>Status</dt><dd>${escapeHtml(item.status)}${item.assigned_to ? ` (assigned to ${escapeHtml(item.assigned_to)})` : ""}</dd>
          <dt>Approval</dt><dd>${escapeHtml(item.approval_state)}</dd>
          <dt>Tier required</dt><dd>${item.required_tier}</dd>
          <dt>Due</dt><dd>${escapeHtml(due)}</dd>
          <dt>Project</dt><dd>${escapeHtml(proj)}</dd>
          <dt>Counterparty</dt><dd>${escapeHtml(cp)}</dd>
          <dt>Source</dt><dd>${escapeHtml(item.source)}${item.source_id ? ` (${escapeHtml(item.source_id)})` : ""}</dd>
          <dt>Provenance</dt><dd>${provenance}</dd>
          <dt>Audit trail</dt><dd>${auditCount} entries${lastAudit ? `, last: ${escapeHtml(lastAudit.action)} by ${escapeHtml(lastAudit.actor)}` : ""}</dd>
        </dl>
        <p><strong>Summary:</strong> ${escapeHtml(item.summary || "(none)")}</p>
        ${item.proposed_action ? `<p><strong>Proposed action:</strong></p><pre>${escapeHtml(item.proposed_action)}</pre>` : ""}
        <div class="undo-action">
          <button class="rail-action" id="modalUndoBtn">Undo last change</button>
          <button class="rail-action" id="modalCloseItemBtn">Close item</button>
        </div>
      </div>`;
      $modalSave.hidden = true;
      $modalHint.textContent = `${item.status} · created ${item.created_at?.slice(0, 10) ?? "?"}`;
      $overlay.hidden = false;
      const undoBtn = $("modalUndoBtn");
      if (undoBtn) {
        undoBtn.addEventListener("click", async () => {
          undoBtn.disabled = true;
          try {
            const r = await fetch(`/api/queue/${encodeURIComponent(id)}/undo`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ actor: "ui" }),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || "undo failed");
            $modalHint.textContent = "Reverted last change.";
            await loadQueue();
            closeModal();
          } catch (err) {
            $modalHint.textContent = `Error: ${err.message}`;
            undoBtn.disabled = false;
          }
        });
      }
      const closeBtn = $("modalCloseItemBtn");
      if (closeBtn) {
        closeBtn.addEventListener("click", async () => {
          closeBtn.disabled = true;
          try {
            const r = await fetch(`/api/queue/${encodeURIComponent(id)}/close`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ outcome: "closed from UI", actor: "ui" }),
            });
            const data = await r.json();
            if (!r.ok) throw new Error(data.error || "close failed");
            $modalHint.textContent = "Closed.";
            await loadQueue();
            closeModal();
          } catch (err) {
            $modalHint.textContent = `Error: ${err.message}`;
            closeBtn.disabled = false;
          }
        });
      }
    })
    .catch((err) => {
      $modalReadonly.innerHTML = `<p>Could not load: ${escapeHtml(err.message || err)}</p>`;
      $overlay.hidden = false;
    });
}

// ---------- Projects ----------
async function loadProjects() {
  try {
    const res = await fetch("/api/projects");
    const { projects } = await res.json();
    $projectsCount.textContent = projects.length;
    $projectsCount.dataset.count = projects.length === 0 ? "0" : "";
    if (projects.length === 0) {
      $projectsList.innerHTML = `<li class="maint-empty">No active projects. <code>cp -r projects/_template projects/&lt;slug&gt;</code></li>`;
      return;
    }
    $projectsList.innerHTML = projects
      .map((p) => {
        const conf = p.confidence ? `${escapeHtml(p.confidence)}` : "—";
        const updated = p.last_updated ?? "no date";
        return `<li class="project-item" data-slug="${escapeHtml(p.slug)}">
          <div class="project-item-head">
            <span class="project-item-name">${escapeHtml(p.slug)}</span>
            <span class="project-item-stamp">${escapeHtml(conf)} · ${escapeHtml(updated)}</span>
          </div>
        </li>`;
      })
      .join("");
    $projectsList.querySelectorAll(".project-item[data-slug]").forEach((el) => {
      el.addEventListener("click", () => openProject(el.dataset.slug));
    });
  } catch (err) {
    $projectsList.innerHTML = `<li class="maint-empty">Could not load projects.</li>`;
  }
}

function openProject(slug) {
  modalState = { path: null, mode: "project-detail", slug };
  fetch(`/api/projects/${encodeURIComponent(slug)}`)
    .then((r) => r.json())
    .then(({ files }) => {
      $modalTitle.textContent = `project: ${slug}`;
      $modalEditor.hidden = true;
      $modalReadonly.hidden = false;
      const status = files["status.md"] || "_(no status)_";
      $modalReadonly.innerHTML = simpleMarkdown(status);
      $modalSave.hidden = true;
      $modalHint.textContent = "Project status (read-only). Edit the file in projects/" + slug + "/";
      $overlay.hidden = false;
    })
    .catch((err) => {
      $modalReadonly.innerHTML = `<p>Could not load: ${escapeHtml(err.message || err)}</p>`;
      $overlay.hidden = false;
    });
}

// ---------- Audit (conform) ----------
let auditDataCache = null;
async function loadAudit() {
  try {
    const res = await fetch("/api/conform/audit?limit=200");
    const data = await res.json();
    auditDataCache = data;
    if (!data.total) {
      $auditCard.innerHTML = `<span class="audit-empty">No audits yet.</span>`;
      return;
    }
    const pct = data.passRate !== null ? Math.round(data.passRate * 100) : null;
    const top = data.topRules?.[0];
    const topLabel = top ? `top hit: ${escapeHtml(top.rule)} (${top.count})` : "no violations recorded";
    const rateClass = pct !== null && pct < 70 ? "audit-pass-rate is-failing" : "audit-pass-rate";
    $auditCard.innerHTML = `
      <div class="${rateClass}">${pct !== null ? `${pct}% pass` : "—"}</div>
      <div class="audit-top-rule">${data.total} audits · ${data.totalViolations} violations · ${topLabel}</div>
    `;
  } catch (err) {
    $auditCard.innerHTML = `<span class="audit-empty">Could not load audit.</span>`;
  }
}

$auditCard.addEventListener("click", () => {
  const data = auditDataCache;
  if (!data || !data.total) return;
  $modalTitle.textContent = "Voice audit log";
  $modalEditor.hidden = true;
  $modalReadonly.hidden = false;
  const rows = (data.entries || [])
    .slice(-30)
    .reverse()
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.at?.slice(11, 19) ?? "?")}</td><td>${escapeHtml(e.kind)}</td><td>${e.ok ? "ok" : "FAIL"}</td><td>${e.violation_count}</td><td>${(e.violation_rules || []).join(", ")}</td></tr>`,
    )
    .join("");
  $modalReadonly.innerHTML = `<div class="modal-detail">
    <p>${data.total} audits, ${data.passes} pass / ${data.fails} fail, ${data.totalViolations} total violations.</p>
    <p><strong>Top rules:</strong> ${(data.topRules || []).map((r) => `${escapeHtml(r.rule)} (${r.count})`).join(", ") || "—"}</p>
    <p><strong>Recent (last 30):</strong></p>
    <table><thead><tr><th>time</th><th>kind</th><th>ok</th><th>n</th><th>rules</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
  $modalSave.hidden = true;
  $modalHint.textContent = "Source: data/conform-audit.jsonl";
  $overlay.hidden = false;
});

// ---------- Init ----------
loadContext();
loadMaintenance();
loadTasks();
loadQueue();
loadProjects();
loadAudit();
