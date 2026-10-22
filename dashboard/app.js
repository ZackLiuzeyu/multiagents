// =============================================================================
// multiagents Web Control Center — frontend
// =============================================================================
// Layout: sessions + file explorer (left) · team chat and panels (center) ·
// file preview + team roster (right). State arrives over the WebSocket; every
// action goes through POST /api/*, which answers { ok, result } or
// { ok: false, error }. Actions capture the session id when they start, so
// switching sessions mid-way cannot redirect them.
// =============================================================================

"use strict";

let state = null;
let activeTab = "chat";
let ws = null;
let wsAttempt = 0;
let wsKeepalive = null;

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
};

// --- Theme: system / light / dark ---

const THEME_ICONS = {
  system: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="9" rx="1.5"/><path d="M5.5 14h5M8 11.5V14"/></svg>',
  light: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="3"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1"/></svg>',
  dark: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M13.5 9.5A6 6 0 0 1 6.5 2.5a6 6 0 1 0 7 7z"/></svg>',
};
const THEME_LABEL = { system: "Follow system", light: "Light", dark: "Dark" };
const darkQuery = window.matchMedia ? matchMedia("(prefers-color-scheme: dark)") : null;

function themePref() {
  try { return localStorage.getItem("ma-theme") || "system"; } catch { return "system"; }
}

function applyTheme() {
  const pref = themePref();
  const dark = pref === "dark" || (pref === "system" && !!darkQuery?.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("theme-btn").innerHTML = THEME_ICONS[pref] ?? THEME_ICONS.system;
  $("theme-btn").title = `Theme: ${THEME_LABEL[pref] ?? pref}`;
}

darkQuery?.addEventListener?.("change", applyTheme);
$("theme-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pref = themePref();
  openMenu($("theme-btn"), ["system", "light", "dark"].map((t) => ({
    label: THEME_LABEL[t], checked: t === pref,
    onClick: () => { try { localStorage.setItem("ma-theme", t); } catch {} applyTheme(); },
  })));
});

// --- Layout: collapsible, resizable side panes ---

const narrowQuery = matchMedia("(max-width: 1100px)");
const workspace = $("workspace");

function isNarrow() { return narrowQuery.matches; }
// Drawers belong to narrow screens only
narrowQuery.addEventListener("change", () => workspace.classList.remove("left-open", "right-open"));

function applyLayout() {
  const layout = store.get("ma-layout", {});
  if (layout.leftW) workspace.style.setProperty("--left-w", `${layout.leftW}px`);
  if (layout.rightW) workspace.style.setProperty("--right-w", `${layout.rightW}px`);
  workspace.classList.toggle("left-collapsed", !!layout.leftCollapsed);
  workspace.classList.toggle("right-collapsed", !!layout.rightCollapsed);
  for (const id of layout.collapsedSections ?? []) $(id)?.classList.add("collapsed");
}

function saveLayout(patch) { store.set("ma-layout", { ...store.get("ma-layout", {}), ...patch }); }

function togglePane(side, open) {
  if (isNarrow()) {
    const cls = `${side}-open`;
    const next = open ?? !workspace.classList.contains(cls);
    workspace.classList.remove("left-open", "right-open");
    workspace.classList.toggle(cls, next);
    return;
  }
  const cls = `${side}-collapsed`;
  const collapsed = open === undefined ? !workspace.classList.contains(cls) : !open;
  workspace.classList.toggle(cls, collapsed);
  saveLayout({ [`${side}Collapsed`]: collapsed });
}

$("left-toggle").addEventListener("click", () => togglePane("left"));
$("right-toggle").addEventListener("click", () => togglePane("right"));
$("left-drawer-btn").addEventListener("click", () => togglePane("left"));
$("right-close").addEventListener("click", () => togglePane("right", false));

document.querySelectorAll("[data-resize]").forEach((handle) => {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const side = handle.dataset.resize;
    const startX = e.clientX;
    const pane = side === "left" ? $("left-pane") : $("right-pane");
    const startW = pane.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const move = (ev) => {
      const delta = side === "left" ? ev.clientX - startX : startX - ev.clientX;
      const w = Math.round(Math.max(side === "left" ? 190 : 300, Math.min(side === "left" ? 560 : 1000, startW + delta)));
      workspace.style.setProperty(side === "left" ? "--left-w" : "--right-w", `${w}px`);
      saveLayout({ [side === "left" ? "leftW" : "rightW"]: w });
    };
    const up = () => {
      handle.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  });
});

document.querySelectorAll("[data-collapse]").forEach((el) => {
  el.addEventListener("click", () => {
    const section = $(el.dataset.collapse);
    section.classList.toggle("collapsed");
    saveLayout({ collapsedSections: [...document.querySelectorAll(".side-section.collapsed")].map((s) => s.id) });
  });
});

// --- WebSocket ---

function connectWs() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws.onopen = () => {
    wsAttempt = 0;
    $("ws-status").textContent = "live";
    $("ws-status").style.color = "var(--green)";
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === "state") {
        const prevSid = state?.sessionId;
        state = msg.data;
        if (prevSid !== state.sessionId) onSessionChanged();
        render();
      }
    } catch {}
  };
  ws.onclose = () => {
    $("ws-status").textContent = "reconnecting…";
    $("ws-status").style.color = "var(--yellow)";
    const delay = Math.min(500 * Math.pow(2, wsAttempt) + Math.random() * 1000, 30000);
    wsAttempt++;
    setTimeout(connectWs, delay);
  };
  ws.onerror = () => ws.close();
  if (!wsKeepalive) wsKeepalive = setInterval(() => { if (ws?.readyState === 1) ws.send("ping"); }, 30000);
}

// --- API ---

async function api(action, body) {
  const opts = body === undefined
    ? {}
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  let res, data;
  try {
    res = await fetch(`/api/${action}`, opts);
  } catch {
    throw new Error("Dashboard server unreachable");
  }
  try { data = await res.json(); } catch { data = { ok: false, error: `HTTP ${res.status}` }; }
  if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result;
}

function fsUrl(op, sid, params) {
  const q = new URLSearchParams({ session_id: sid });
  for (const [k, v] of Object.entries(params ?? {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v !== undefined && v !== null) q.set(k, String(v));
  }
  return `/api/fs/${op}?${q}`;
}

/** Run an action with a busy button; report the broker's answer, never a guessed success. */
async function run(btn, label, fn) {
  if (btn) btn.classList.add("busy");
  try {
    const result = await fn();
    toast(result?.message ?? `${label}: done`, result?.warning ? "warn" : "ok");
    return result ?? true;
  } catch (e) {
    toast(`${label} failed: ${e.message}`, "error");
    return null;
  } finally {
    if (btn) btn.classList.remove("busy");
  }
}

function toast(text, kind = "info") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("toasts").appendChild(el);
  setTimeout(() => el.remove(), kind === "error" ? 9000 : 4500);
}

/** The session the user is looking at; actions need one. */
function currentSid() {
  if (state?.sessionId == null || !state.session) {
    toast("No session selected — pick one on the left or start a New Team", "warn");
    return null;
  }
  return state.sessionId;
}

function onSessionChanged() {
  lastChatSignature = "";
  fileRefCache.clear();
  expandedMessages.clear();
  resetKnowledgeForm();
  closePreview();
  explorerReset();
}

// --- Tabs ---

const TABS = ["chat", "agents", "plan", "knowledge", "files", "stats"];

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll("#tab-bar .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tab));
  for (const t of TABS) $(`panel-${t}`).classList.toggle("hidden", t !== tab);
  store.set("ma-tab", tab);
  if (state) render(true);
  if (tab === "chat") $("composer-text").focus();
}

$("tab-bar").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (tab) switchTab(tab.dataset.tab);
});

function switchRightTab(tab) {
  document.querySelectorAll("#right-tabs .tab").forEach((t) => t.classList.toggle("active", t.dataset.rtab === tab));
  $("rpanel-preview").classList.toggle("hidden", tab !== "preview");
  $("rpanel-preview").style.display = tab === "preview" ? "flex" : "none";
  $("rpanel-team").classList.toggle("hidden", tab !== "team");
  store.set("ma-rtab", tab);
  if (tab === "team" && state) renderRoster();
}

$("right-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest("[data-rtab]");
  if (tab) switchRightTab(tab.dataset.rtab);
});

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePicker(); closeMenu(); closeModal(); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "b" || e.key === "B")) { e.preventDefault(); togglePane("left"); return; }
  if ((e.ctrlKey || e.metaKey) && (e.key === "j" || e.key === "J")) { e.preventDefault(); togglePane("right"); return; }
  if (isTyping() || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($("modal-overlay").classList.contains("open")) return;
  const num = parseInt(e.key);
  if (num >= 1 && num <= TABS.length) switchTab(TABS[num - 1]);
});

// --- Rendering ---

/** Skip re-rendering a region the user is typing in (state pushes arrive every few seconds). */
function busyRegion(el) {
  return el && isTyping() && el.contains(document.activeElement);
}

function render(force = false) {
  if (!state) return;
  renderHeader();
  renderSidebar();
  renderSessionBar();
  renderGateBanner();
  renderBadges();
  refreshAgentSelects();
  renderRoster();
  explorerSync();

  switch (activeTab) {
    case "chat": renderChat(force); break;
    case "agents": renderAgents(); break;
    case "plan": renderPlan(); break;
    case "knowledge": renderKnowledge(); break;
    case "files": renderFiles(); break;
    case "stats": renderStats(); break;
  }
}

function isSessionComplete() {
  if (!state || !state.slots.length) return false;
  if (!state.slots.every((s) => s.status === "disconnected")) return false;
  return state.slots.every((s) => s.task_state === "approved" || s.task_state === "released" || s.task_state === "done_pending_review");
}

function slotName(slot) { return slot?.display_name ?? (slot ? `Slot ${slot.id}` : "?"); }
function slotById(id) { return state?.slots.find((s) => s.id === id) ?? null; }
function liveSlots() { return (state?.slots ?? []).filter((s) => s.task_state !== "released"); }
function isPaused(slot) { return slot.paused === true || slot.paused === 1; }

function renderHeader() {
  const dot = $("conn-dot");
  const status = state.session?.status;
  dot.className = "dot " + (!state.brokerAlive ? "red" : status === "paused" ? "yellow" : status === "archived" || isSessionComplete() ? "" : state.session ? "green" : "");
  $("session-name-text").textContent = state.session?.name ?? state.sessionId ?? "No session";

  const b = sessionBadge();
  const badge = $("session-status-badge");
  badge.classList.toggle("hidden", !b);
  if (b) { badge.textContent = b.text; badge.className = `badge ${b.cls}`; }

  const connected = state.slots.filter((s) => s.status === "connected").length;
  $("agent-count").textContent = state.session ? `${connected}/${state.slots.length} agents online` : "";

  if (state.session?.created_at) {
    let endTime = Date.now();
    if (isSessionComplete() || status === "archived") {
      const candidates = [state.session.last_active_at || 0];
      const last = state.messages[state.messages.length - 1];
      if (last?.sent_at) candidates.push(new Date(last.sent_at).getTime());
      for (const slot of state.slots) if (slot.last_disconnected) candidates.push(slot.last_disconnected);
      endTime = Math.max(state.session.created_at, ...candidates);
    }
    $("uptime").textContent = fmtDuration(endTime - state.session.created_at);
  } else {
    $("uptime").textContent = "";
  }

  $("broker-dot").className = `dot ${state.brokerAlive ? "green" : "red"}`;
  $("broker-label").textContent = state.brokerAlive
    ? `Broker · ${state.sessions?.length ?? 0} sessions · ${state.peerCount ?? 0} peers`
    : "Broker down";
}

function sessionBadge() {
  if (!state.session) return null;
  if (state.session.status === "archived") return { text: "archived", cls: "badge-released" };
  if (state.awaitingHuman) return { text: "waiting for you", cls: "badge-review" };
  if (state.session.status === "paused") return { text: "paused", cls: "badge-paused" };
  if (isSessionComplete()) return { text: "completed", cls: "badge-approved" };
  return { text: "active", cls: "badge-connected" };
}

function renderBadges() {
  $("badge-chat").textContent = state.messages.filter((m) => !isSystemMessage(m)).length;
  $("badge-agents").textContent = state.slots.filter((s) => s.status === "connected").length;
  $("badge-plan").textContent = state.plan?.plan ? `${state.plan.completion}%` : "-";
  $("badge-knowledge").textContent = state.knowledge?.length ?? 0;
  $("badge-files").textContent = state.fileLocks.length + state.fileOwnership.length;
  $("badge-team").textContent = liveSlots().length;
  const warnings = state.guardrails.filter((g) => g.usage?.status === "warning" || g.usage?.status === "triggered").length;
  $("badge-stats").textContent = warnings > 0 ? `${warnings}!` : "";
}

// --- Sessions (left) ---

function sortedSessions(list) {
  const order = { active: 0, paused: 1, archived: 2 };
  return [...(list ?? [])].sort((a, b) => {
    const so = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    if (so !== 0) return so;
    return (b.last_active_at ?? b.created_at ?? 0) - (a.last_active_at ?? a.created_at ?? 0);
  });
}

function statusDot(status) {
  return `<span class="dot ${status === "active" ? "green" : status === "paused" ? "yellow" : ""}"></span>`;
}

function renderSidebar() {
  const list = $("sidebar-list");
  const sessions = sortedSessions(state.sessions);
  if (!sessions.length) {
    list.innerHTML = `<div class="tree-empty">${state.brokerAlive ? "No sessions yet — use + to start a team." : "Broker is not running."}</div>`;
    return;
  }
  let html = "", last = "";
  for (const s of sessions) {
    if (s.status !== last) {
      last = s.status;
      html += `<div class="side-group">${esc(s.status)}</div>`;
    }
    html += `<div class="session-row${s.id === state.sessionId ? " current" : ""}" data-sid="${esc(s.id)}" title="${esc(s.id)}\n${esc(s.project_dir)}">
      ${statusDot(s.status)}
      <span class="name">${esc(s.name || s.id)}</span>
      <span class="time">${timeSince(s.last_active_at ?? s.created_at)}</span>
      <button class="icon-btn" data-session-menu="${esc(s.id)}" title="Session actions">&#8943;</button>
    </div>`;
  }
  list.innerHTML = html;
}

$("sidebar-list").addEventListener("click", (e) => {
  const menuBtn = e.target.closest("[data-session-menu]");
  if (menuBtn) {
    e.stopPropagation();
    const s = state.sessions.find((x) => x.id === menuBtn.dataset.sessionMenu);
    if (s) openMenu(menuBtn, sessionMenuItems(s));
    return;
  }
  const row = e.target.closest(".session-row");
  if (row) {
    selectSession(row.dataset.sid);
    if (isNarrow()) togglePane("left", false);
  }
});

// --- Explorer (left) ---

const explorer = { sid: null, root: "", children: new Map(), expanded: new Set(), error: null };

function explorerReset() {
  explorer.sid = null;
  explorer.children.clear();
  explorer.error = null;
}

function explorerKey(sid) { return `ma-exp:${sid}`; }

/** Load the tree of the current session's project on first sight of the session. */
function explorerSync() {
  const sid = state.session ? state.sessionId : null;
  if (sid === explorer.sid) return;
  explorer.sid = sid;
  explorer.children.clear();
  explorer.error = null;
  explorer.expanded = new Set(store.get(sid == null ? "" : explorerKey(sid), []));
  explorer.expanded.add("");
  $("explorer-root").textContent = state.session ? baseName(state.session.project_dir) : "";
  $("explorer-root").title = state.session?.project_dir ?? "";
  if (sid == null) { renderTree(); return; }
  reloadExplorer();
}

async function loadDir(sid, rel) {
  const res = await fetch(fsUrl("list", sid, { path: rel }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data.result.entries;
}

async function reloadExplorer() {
  const sid = explorer.sid;
  if (sid == null) return;
  const dirs = [...explorer.expanded];
  const results = await Promise.all(dirs.map((d) => loadDir(sid, d).then((e) => [d, e], (err) => [d, null, err])));
  if (sid !== explorer.sid) return;
  let changed = false;
  for (const [dir, entries, err] of results) {
    if (!entries) {
      if (dir === "") explorer.error = err.message;
      explorer.expanded.delete(dir);
      changed = true;
      continue;
    }
    if (dir === "") explorer.error = null;
    const prev = explorer.children.get(dir);
    if (JSON.stringify(prev) !== JSON.stringify(entries)) { explorer.children.set(dir, entries); changed = true; }
  }
  if (changed || !$("explorer-tree").innerHTML) renderTree();
}

const FILE_ICONS = {
  pdf: ["PDF", "#d1242f"], doc: ["W", "#2b5fd9"], docx: ["W", "#2b5fd9"], odt: ["W", "#2b5fd9"], rtf: ["W", "#2b5fd9"],
  xls: ["X", "#1a7f37"], xlsx: ["X", "#1a7f37"], csv: ["CSV", "#1a7f37"], tsv: ["TSV", "#1a7f37"],
  ppt: ["P", "#c2410c"], pptx: ["P", "#c2410c"],
  md: ["M", "#6e7781"], markdown: ["M", "#6e7781"], txt: ["T", "#6e7781"], log: ["L", "#6e7781"],
  ts: ["TS", "#3178c6"], tsx: ["TS", "#3178c6"], js: ["JS", "#b08800"], jsx: ["JS", "#b08800"], mjs: ["JS", "#b08800"],
  json: ["{}", "#b08800"], py: ["PY", "#3572a5"], ipynb: ["NB", "#da5b0b"], r: ["R", "#276dc3"], rmd: ["R", "#276dc3"],
  html: ["<>", "#e34c26"], htm: ["<>", "#e34c26"], css: ["#", "#563d7c"], sh: ["$", "#4e5a65"], go: ["GO", "#00add8"], rs: ["RS", "#a0522d"],
  java: ["J", "#b07219"], c: ["C", "#555"], cpp: ["C+", "#f34b7d"], yaml: ["Y", "#cb171e"], yml: ["Y", "#cb171e"], toml: ["T", "#9c4221"],
  tex: ["TX", "#3d6117"], bib: ["BIB", "#3d6117"], zip: ["ZIP", "#8250df"], gz: ["GZ", "#8250df"],
};
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"]);
const FOLDER_SVG = '<svg viewBox="0 0 16 16"><path fill="#d4a72c" d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.4 1.5h6a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z"/></svg>';
const FOLDER_OPEN_SVG = '<svg viewBox="0 0 16 16"><path fill="#d4a72c" d="M1.5 3.5A1 1 0 0 1 2.5 2.5h3.6l1.4 1.5h5a1 1 0 0 1 1 1V6H4.2a1 1 0 0 0-.95.68L1.5 12z"/><path fill="#e8c35a" d="M3.3 6.7A1 1 0 0 1 4.2 6h10.3a.5.5 0 0 1 .47.68l-2.2 5.65a1 1 0 0 1-.93.67H1.9z"/></svg>';
const FILE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="var(--text-muted)" stroke-width="1.2"><path d="M4 1.5h5l3.5 3.5v9a.5.5 0 0 1-.5.5H4a.5.5 0 0 1-.5-.5V2a.5.5 0 0 1 .5-.5z"/><path d="M9 1.5V5h3.5"/></svg>';
const IMAGE_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="#8250df" stroke-width="1.3"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="M14.5 11l-4-4-6.5 6.5"/></svg>';

function extOf(name) {
  const m = /\.([^./]+)$/.exec(name);
  return m ? m[1].toLowerCase() : "";
}

function fileIcon(name, isDir, open) {
  if (isDir) return `<span class="ficon">${open ? FOLDER_OPEN_SVG : FOLDER_SVG}</span>`;
  const ext = extOf(name);
  if (IMAGE_EXT.has(ext)) return `<span class="ficon">${IMAGE_SVG}</span>`;
  const icon = FILE_ICONS[ext];
  if (!icon) return `<span class="ficon">${FILE_SVG}</span>`;
  const [label, color] = icon;
  return `<span class="ficon" style="color:${color};font-size:${label.length > 2 ? 7 : 9}px">${esc(label)}</span>`;
}

function renderTree() {
  const el = $("explorer-tree");
  if (explorer.sid == null) {
    el.innerHTML = '<div class="tree-empty">Select a session to browse its project.</div>';
    return;
  }
  if (explorer.error) {
    el.innerHTML = `<div class="tree-empty">${esc(explorer.error)}</div>`;
    return;
  }
  const root = explorer.children.get("");
  if (!root) { el.innerHTML = '<div class="tree-empty">Loading…</div>'; return; }
  if (!root.length) { el.innerHTML = '<div class="tree-empty">The project directory is empty.</div>'; return; }
  const locked = new Set((state?.fileLocks ?? []).map((l) => l.file_path.replace(/^\.\//, "")));
  const rows = [];
  const walk = (dir, depth) => {
    for (const entry of explorer.children.get(dir) ?? []) {
      const open = entry.type === "dir" && explorer.expanded.has(entry.path);
      const selected = entry.type === "file" && preview.path === entry.path;
      const dim = entry.name.startsWith(".") || entry.name === "node_modules";
      rows.push(`<div class="tree-row${open || entry.type === "file" ? "" : " closed"}${selected ? " selected" : ""}${dim ? " dim" : ""}"
          data-path="${esc(entry.path)}" data-type="${entry.type}" style="padding-left:${8 + depth * 14}px"
          title="${esc(entry.path)}${entry.type === "file" ? ` · ${fmtBytes(entry.size)} · ${timeSince(entry.mtime)}` : ""}">
        <span class="chev">${entry.type === "dir" ? "&#9662;" : ""}</span>
        ${fileIcon(entry.name, entry.type === "dir", open)}
        <span class="tree-name">${esc(entry.name)}</span>
        ${locked.has(entry.path) ? '<span class="lock" title="Locked by an agent">&#128274;</span>' : ""}
        ${entry.type === "file" ? '<span class="tree-actions"><button class="icon-btn" data-mention title="Mention in chat">@</button></span>' : ""}
      </div>`);
      if (open) {
        if (explorer.children.has(entry.path)) walk(entry.path, depth + 1);
        else rows.push(`<div class="tree-empty" style="padding-left:${30 + depth * 14}px">Loading…</div>`);
      }
    }
  };
  walk("", 0);
  el.innerHTML = rows.join("");
}

$("explorer-tree").addEventListener("click", async (e) => {
  const row = e.target.closest(".tree-row");
  if (!row) return;
  const p = row.dataset.path;
  if (e.target.closest("[data-mention]")) { mentionFile(p); return; }
  if (row.dataset.type === "file") { openPreview(p); return; }
  const sid = explorer.sid;
  if (explorer.expanded.has(p)) {
    explorer.expanded.delete(p);
  } else {
    explorer.expanded.add(p);
    renderTree();
    try {
      explorer.children.set(p, await loadDir(sid, p));
    } catch (err) {
      explorer.expanded.delete(p);
      toast(`Cannot open ${p}: ${err.message}`, "error");
    }
  }
  if (sid !== explorer.sid) return;
  store.set(explorerKey(sid), [...explorer.expanded].filter(Boolean));
  renderTree();
});

$("explorer-refresh").addEventListener("click", () => { explorer.children.clear(); renderTree(); reloadExplorer(); });
$("explorer-collapse").addEventListener("click", () => {
  explorer.expanded = new Set([""]);
  if (explorer.sid != null) store.set(explorerKey(explorer.sid), []);
  renderTree();
});

// Agents create and edit files while you watch: refresh what is open
setInterval(() => {
  if (document.hidden || explorer.sid == null) return;
  if (!isNarrow() && workspace.classList.contains("left-collapsed")) return;
  reloadExplorer().catch(() => {});
}, 6000);

// --- Preview (right) ---

const preview = { sid: null, path: null, line: null, mtime: null, size: null, mode: null, wrap: false };

const PREVIEW_KIND = (ext) =>
  IMAGE_EXT.has(ext) ? "image"
  : ext === "pdf" ? "pdf"
  : ext === "docx" ? "docx"
  : ext === "md" || ext === "markdown" || ext === "mdx" ? "markdown"
  : ext === "csv" || ext === "tsv" ? "csv"
  : ext === "html" || ext === "htm" ? "html"
  : ["mp3", "wav", "ogg", "m4a", "flac", "aac"].includes(ext) ? "audio"
  : ["mp4", "webm", "mov", "m4v", "ogv"].includes(ext) ? "video"
  : ["doc", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "pages", "key", "numbers", "zip", "gz", "tgz", "tar", "7z", "rar", "exe", "dmg", "bin", "rds", "rdata", "h5", "hdf5", "parquet", "bam", "sqlite", "db"].includes(ext) ? "binary"
  : "text";

const TEXT_LIMIT = 2_000_000;

async function openPreview(rel, line) {
  const sid = currentSid();
  if (sid == null) return;
  let info;
  try {
    info = await api(`fs/resolve?session_id=${encodeURIComponent(sid)}&path=${encodeURIComponent(rel)}`);
  } catch (e) {
    toast(`Cannot open ${rel}: ${e.message}`, "error");
    return;
  }
  Object.assign(preview, { sid, path: info.path, line: line ?? null, mtime: info.mtime, size: info.size, mode: null });
  if (isNarrow()) togglePane("right", true);
  else if (workspace.classList.contains("right-collapsed")) togglePane("right", true);
  switchRightTab("preview");
  renderTree();
  await renderPreview();
}

function closePreview() {
  Object.assign(preview, { sid: null, path: null, line: null, mtime: null, size: null, mode: null });
  $("preview-head").classList.add("hidden");
  const body = $("preview-body");
  body.className = "preview-body";
  body.innerHTML = `<div class="preview-empty"><div class="big">&#128196;</div>
    <div><b>No file open</b></div>
    <div style="font-size:12.5px">Click a file in the explorer, or a file name an agent mentions in the chat.</div></div>`;
  if (explorer.children.size) renderTree();
}

function rawUrl(params = {}) {
  return fsUrl("raw", preview.sid, { path: preview.path, v: preview.mtime, ...params });
}

async function renderPreview(keepScroll = false) {
  if (!preview.path) return closePreview();
  const body = $("preview-body");
  const scrollTop = body.scrollTop;
  const ext = extOf(preview.path);
  const kind = PREVIEW_KIND(ext);
  const parts = preview.path.split("/");
  const name = parts.pop();
  $("preview-head").classList.remove("hidden");
  $("preview-path").innerHTML = `<bdi>${parts.length ? esc(parts.join("/")) + "/" : ""}<b>${esc(name)}</b></bdi>`;
  $("preview-path").title = `${preview.path} · ${fmtBytes(preview.size ?? 0)}`;
  $("preview-open").href = rawUrl();
  $("preview-download").href = rawUrl({ download: 1 });
  $("preview-mode").innerHTML = "";
  body.className = "preview-body";

  const seg = (options, current, onPick) => {
    const el = document.createElement("span");
    el.className = "seg";
    el.innerHTML = options.map(([v, l]) => `<button data-v="${v}" class="${v === current ? "on" : ""}">${l}</button>`).join("");
    el.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) onPick(b.dataset.v); });
    $("preview-mode").appendChild(el);
  };

  const fetchText = async () => {
    const res = await fetch(rawUrl());
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const slice = new Uint8Array(buf, 0, Math.min(buf.byteLength, TEXT_LIMIT));
    if (slice.subarray(0, 4096).includes(0)) return { binary: true };
    return { text: new TextDecoder().decode(slice), truncated: buf.byteLength > TEXT_LIMIT };
  };

  try {
    switch (kind) {
      case "image":
        body.innerHTML = `<div class="preview-img"><img src="${rawUrl()}" alt="${esc(name)}"></div>`;
        break;
      case "pdf":
        if (navigator.pdfViewerEnabled === false) { body.innerHTML = noPreview(name, "This browser cannot show PDFs inline."); break; }
        body.className = "preview-body fill";
        body.innerHTML = `<iframe class="pdf" src="${rawUrl()}#view=FitH" title="${esc(name)}"></iframe>`;
        break;
      case "audio":
        body.innerHTML = `<div class="preview-media"><audio controls src="${rawUrl()}"></audio></div>`;
        break;
      case "video":
        body.innerHTML = `<div class="preview-media"><video controls src="${rawUrl()}"></video></div>`;
        break;
      case "docx": {
        const r = await api(`fs/docx?session_id=${encodeURIComponent(preview.sid)}&path=${encodeURIComponent(preview.path)}`);
        body.innerHTML = `<div class="doc-view doc-page">${r.html || '<p class="dim">The document has no text.</p>'}</div>`;
        break;
      }
      case "html": {
        const mode = preview.mode ?? "render";
        seg([["render", "Render"], ["source", "Source"]], mode, (v) => { preview.mode = v; renderPreview(); });
        if (mode === "render") {
          body.className = "preview-body fill";
          body.innerHTML = `<iframe sandbox="" src="${rawUrl()}" title="${esc(name)}"></iframe>`;
        } else {
          const t = await fetchText();
          body.innerHTML = codeView(t.text ?? "", t.truncated);
        }
        break;
      }
      case "markdown": {
        const mode = preview.mode ?? "preview";
        seg([["preview", "Preview"], ["source", "Source"]], mode, (v) => { preview.mode = v; renderPreview(); });
        const t = await fetchText();
        body.innerHTML = mode === "preview"
          ? `${t.truncated ? '<div class="preview-notice">Large file — showing the first 2 MB.</div>' : ""}<div class="doc-view">${renderMarkdown(t.text ?? "", { baseDir: parts.join("/") })}</div>`
          : codeView(t.text ?? "", t.truncated);
        hydrateFileRefs(body);
        break;
      }
      case "csv": {
        const mode = preview.mode ?? "table";
        seg([["table", "Table"], ["source", "Source"]], mode, (v) => { preview.mode = v; renderPreview(); });
        const t = await fetchText();
        body.innerHTML = mode === "table" ? csvView(t.text ?? "", ext === "tsv" ? "\t" : ",") : codeView(t.text ?? "", t.truncated);
        break;
      }
      case "binary":
        body.innerHTML = noPreview(name, "This file type has no inline preview.");
        break;
      default: {
        seg([["nowrap", "No wrap"], ["wrap", "Wrap"]], preview.wrap ? "wrap" : "nowrap", (v) => { preview.wrap = v === "wrap"; renderPreview(true); });
        const t = await fetchText();
        body.innerHTML = t.binary ? noPreview(name, "This looks like a binary file.") : codeView(t.text, t.truncated);
      }
    }
  } catch (e) {
    body.innerHTML = noPreview(name, `Preview failed: ${e.message}`);
  }

  if (keepScroll) body.scrollTop = scrollTop;
  else if (preview.line) {
    const lineEl = body.querySelector(`[data-line="${preview.line}"]`);
    if (lineEl) { lineEl.classList.add("hl"); lineEl.scrollIntoView({ block: "center" }); }
  } else body.scrollTop = 0;
}

function noPreview(name, why) {
  return `<div class="preview-empty"><div class="big">&#128230;</div><div><b>${esc(name)}</b></div><div style="font-size:12.5px">${esc(why)}</div>
    <div class="flex gap-2" style="margin-top:8px"><a class="btn" href="${rawUrl({ download: 1 })}">Download</a><a class="btn" href="${rawUrl()}" target="_blank" rel="noopener">Open in browser</a></div></div>`;
}

function codeView(text, truncated) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const shown = lines.slice(0, 20000);
  return `${truncated || lines.length > shown.length ? '<div class="preview-notice">Large file — showing the beginning only.</div>' : ""}
    <div class="code-view mono${preview.wrap ? " code-wrap" : ""}">${shown.map((l, i) => `<div class="code-line" data-line="${i + 1}"><span class="ln">${i + 1}</span><span>${esc(l) || " "}</span></div>`).join("")}</div>`;
}

function parseCsv(text, sep) {
  const rows = [];
  let row = [], cell = "", quoted = false;
  for (let i = 0; i < text.length && rows.length < 1001; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function csvView(text, sep) {
  const rows = parseCsv(text, sep);
  if (!rows.length) return '<div class="preview-empty">Empty file</div>';
  const [head, ...rest] = rows;
  return `<div class="csv-view"><table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rest.slice(0, 1000).map((r) => `<tr>${r.map((c) => `<td title="${esc(c)}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>
    ${rows.length > 1000 ? '<div class="field-hint" style="margin-top:6px">Showing the first 1000 rows.</div>' : ""}</div>`;
}

$("preview-reload").addEventListener("click", () => preview.path && openPreview(preview.path, preview.line));
$("preview-close").addEventListener("click", closePreview);
$("preview-mention").addEventListener("click", () => preview.path && mentionFile(preview.path));

// Follow an open file while agents edit it
setInterval(async () => {
  if (!preview.path || document.hidden) return;
  if (!isNarrow() && workspace.classList.contains("right-collapsed")) return;
  if ($("rpanel-preview").classList.contains("hidden")) return;
  const sid = preview.sid, p = preview.path;
  try {
    const info = await api(`fs/resolve?session_id=${encodeURIComponent(sid)}&path=${encodeURIComponent(p)}`);
    if (preview.path === p && preview.sid === sid && info.mtime !== preview.mtime) {
      preview.mtime = info.mtime;
      preview.size = info.size;
      renderPreview(true);
    }
  } catch { /* deleted or session gone — keep what is shown */ }
}, 4000);

function mentionFile(p) {
  switchTab("chat");
  const ta = $("composer-text");
  const ins = `\`${p}\` `;
  const pos = ta.selectionStart ?? ta.value.length;
  ta.value = ta.value.slice(0, pos) + (pos && !/\s$/.test(ta.value.slice(0, pos)) ? " " : "") + ins + ta.value.slice(pos);
  autosize();
  ta.focus();
}

// --- Rich text: markdown-lite with file references ---

const FILE_EXTS = "md|markdown|mdx|txt|rst|pdf|docx?|odt|rtf|xlsx?|ods|pptx?|odp|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|xml|html?|css|scss|less|js|mjs|cjs|jsx|ts|tsx|vue|svelte|py|ipynb|r|rmd|qmd|jl|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|ps1|sql|lua|dart|scala|tex|bib|log|png|jpe?g|gif|webp|svg|bmp|avif|tiff?|mp3|wav|ogg|m4a|flac|mp4|webm|mov|zip|gz|tgz|tar|lock|env|fa|fasta|fastq|gff|gtf|bed|vcf|sam|rds|parquet";
const FILE_RE_SRC = String.raw`(?<![\p{L}\p{N}_/.@\-])((?:~\/|\.{1,2}\/|\/)?(?:[\p{L}\p{N}_@.\-]+\/)*[\p{L}\p{N}_@\-][\p{L}\p{N}_@.\-]*\.(?:${FILE_EXTS}))(?::(\d+))?(?![\p{L}\p{N}_\/\-])`;
const INLINE_RE = new RegExp(String.raw`(!?\[[^\]\n]*\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"）。，])|` + FILE_RE_SRC, "giu");
const FILE_ONLY_RE = new RegExp("^" + FILE_RE_SRC + "$", "iu");

function emph(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?![*\w])/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+?)~~/g, "<del>$1</del>");
}

function fileRef(ref, line) {
  return `<span class="file-ref" data-ref="${esc(ref)}"${line ? ` data-line="${esc(line)}"` : ""}>${esc(ref)}${line ? `:${esc(line)}` : ""}</span>`;
}

function inlineText(s, ctx) {
  let out = "", last = 0;
  for (const m of s.matchAll(INLINE_RE)) {
    out += emph(esc(s.slice(last, m.index)));
    last = m.index + m[0].length;
    if (m[1]) {
      const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(m[1]);
      const [, bang, label, href] = link;
      if (/^https?:\/\//i.test(href)) {
        out += bang ? `<img src="${esc(href)}" alt="${esc(label)}" style="max-width:100%">` : `<a href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`;
      } else {
        const target = ctx?.baseDir && !href.startsWith("/") ? `${ctx.baseDir}/${href}` : href;
        if (bang && preview.sid != null) out += `<img src="${fsUrl("raw", preview.sid, { path: normPath(target) })}" alt="${esc(label)}" style="max-width:100%">`;
        else out += `<span class="file-ref" data-ref="${esc(normPath(target))}">${esc(label || href)}</span>`;
      }
    } else if (m[2]) {
      out += `<a href="${esc(m[2])}" target="_blank" rel="noopener">${esc(m[2])}</a>`;
    } else {
      out += fileRef(m[3], m[4]);
    }
  }
  return out + emph(esc(s.slice(last)));
}

function inline(s, ctx) {
  return s.split(/(`[^`\n]+`)/).map((part) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      const code = part.slice(1, -1);
      const fm = FILE_ONLY_RE.exec(code);
      return `<code>${fm ? fileRef(fm[1], fm[2]) : esc(code)}</code>`;
    }
    return inlineText(part, ctx);
  }).join("");
}

function normPath(p) {
  const out = [];
  for (const seg of p.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

/** Markdown for chat bubbles and .md previews: escape first, then a safe subset. */
function renderMarkdown(text, ctx = {}) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const html = [];
  let para = [];
  const flush = () => {
    if (para.length) html.push(`<p>${para.map((l) => inline(l, ctx)).join(ctx.chat ? "<br>" : " ")}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body = [];
      while (++i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i]);
      html.push(`<pre><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flush(); html.push(`<h${h[1].length}>${inline(h[2], ctx)}</h${h[1].length}>`); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html.push("<hr>"); continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, ""));
      i--;
      html.push(`<blockquote>${renderMarkdown(quote.join("\n"), ctx)}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      flush();
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i++;
      const rows = [];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) rows.push(cells(lines[++i]));
      html.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, ctx)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join("")}</tr>`).join("")}</tbody></table>`);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) items.push(m[3].replace(/^\[( |x)\]\s/i, (_, x) => (x.trim() ? "☑ " : "☐ ")));
        else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) items[items.length - 1] += " " + lines[i].trim();
        else break;
        i++;
      }
      i--;
      html.push(`<${ordered ? "ol" : "ul"}>${items.map((t) => `<li>${inline(t, ctx)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    para.push(line);
  }
  flush();
  return html.join("");
}

// File references become links once the server confirms the file exists in the project
const fileRefCache = new Map(); // ref → { path, at } | { path: null, at }
let refCheckTimer = null;
const pendingRefs = new Set();

function hydrateFileRefs(root) {
  if (state?.sessionId == null) return;
  for (const el of root.querySelectorAll(".file-ref")) {
    const ref = el.dataset.ref;
    const hit = fileRefCache.get(ref);
    if (hit && (hit.path || Date.now() - hit.at < 30_000)) {
      if (hit.path) { el.classList.add("file-link"); el.dataset.path = hit.path; el.title = `Open ${hit.path}`; }
    } else pendingRefs.add(ref);
  }
  if (pendingRefs.size && !refCheckTimer) refCheckTimer = setTimeout(checkPendingRefs, 150);
}

async function checkPendingRefs() {
  refCheckTimer = null;
  const sid = state?.sessionId;
  const refs = [...pendingRefs];
  pendingRefs.clear();
  if (sid == null || !state.session) return;
  for (let i = 0; i < refs.length; i += 40) {
    const batch = refs.slice(i, i + 40);
    try {
      const res = await fetch(fsUrl("check", sid, { ref: batch }));
      const data = await res.json();
      if (!data.ok || sid !== state?.sessionId) return;
      for (const ref of batch) fileRefCache.set(ref, { path: data.result[ref] ?? null, at: Date.now() });
    } catch { return; }
  }
  for (const root of [$("msg-feed"), $("preview-body"), $("panel-knowledge"), $("panel-agents"), $("rpanel-team")]) hydrateFileRefs(root);
}

document.addEventListener("click", (e) => {
  const link = e.target.closest(".file-link");
  if (!link) return;
  e.preventDefault();
  const line = link.dataset.line ? parseInt(link.dataset.line, 10) : undefined;
  openPreview(link.dataset.path, line);
});

// --- Chat ---

let lastChatSignature = "";
const expandedMessages = new Set();
const SYSTEMISH = new Set(["system", "control", "team_change", "role_assignment", "rename", "release"]);
const PALETTE = ["#2f6fde", "#8250df", "#1a7f37", "#c2410c", "#0e7f86", "#bf3989", "#9a6700", "#6639ba", "#0969da", "#cf222e"];

function isSystemMessage(m) { return SYSTEMISH.has(m.msg_type); }

function initials(name) {
  const n = String(name ?? "?").trim();
  if (!n) return "?";
  if (/^[㐀-鿿가-힯぀-ヿ]/.test(n)) return n[0];
  const words = n.split(/[\s_\-]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : n.slice(0, 2)).toUpperCase();
}

function slotColor(id) { return PALETTE[Math.abs(Number(id) || 0) % PALETTE.length]; }

const PERSON_SVG = '<svg viewBox="0 0 16 16" width="17" height="17" fill="currentColor"><circle cx="8" cy="5" r="3"/><path d="M2.5 14c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5z"/></svg>';

function avatar(name, color, extra = "", me = false) {
  return `<div class="avatar" style="background:${color}">${me ? PERSON_SVG : esc(initials(name))}${extra}</div>`;
}

function senderOf(m) {
  if (m.from_id === "human") return { key: "human", name: "You", me: true, color: "var(--accent)" };
  if (m.from_id === "orchestrator" || m.from_id === "__orchestrator__") return { key: "orchestrator", name: "Orchestrator", color: "#6e7781", role: "system" };
  if (m.from_id === "cli") return { key: "cli", name: "CLI", color: "#6e7781" };
  const slot = (m.from_slot_id != null ? slotById(m.from_slot_id) : null) ?? state.slots.find((s) => s.peer_id === m.from_id);
  if (slot) return { key: `slot:${slot.id}`, name: slotName(slot), role: slot.role, color: slotColor(slot.id) };
  return { key: `peer:${m.from_id}`, name: m.from_display_name ?? m.from_id ?? "?", color: "#6e7781" };
}

function recipientOf(m) {
  if (m.to_slot_id != null) { const s = slotById(m.to_slot_id); if (s) return slotName(s); }
  if (m.to_id === "human") return "You";
  if (m.to_id === "orchestrator" || m.to_id === "__orchestrator__") return "Orchestrator";
  return m.to_display_name ?? m.to_id ?? "?";
}

function systemText(m) {
  const t = m.text ?? "";
  try {
    const j = JSON.parse(t);
    if (m.msg_type === "control" && j.action) return `${j.action}${j.reason ? ` — ${j.reason}` : ""}`;
    if (m.msg_type === "role_assignment" && j.role) return `role set to ${j.role}`;
    if (m.msg_type === "rename" && j.display_name) return `renamed to ${j.display_name}`;
  } catch { /* plain text */ }
  return t.replace(/\s+/g, " ");
}

/** Messages in display order, with one-to-many sends (broadcasts, done notices) folded into one item. */
function chatItems() {
  const showSystem = $("msg-show-system").checked;
  const filter = $("msg-filter-agent").value;
  let msgs = state.messages;
  if (!showSystem) msgs = msgs.filter((m) => !isSystemMessage(m));
  if (filter) {
    const id = parseInt(filter, 10);
    const peer = slotById(id)?.peer_id;
    msgs = msgs.filter((m) => m.from_slot_id === id || m.to_slot_id === id || (peer && (m.from_id === peer || m.to_id === peer)));
  }
  const items = [];
  for (const m of msgs) {
    const t = new Date(m.sent_at).getTime();
    const prev = items[items.length - 1];
    if (prev && prev.m.from_id === m.from_id && prev.m.text === m.text && prev.m.msg_type === m.msg_type && Math.abs(t - prev.t) < 5000) {
      prev.to.add(recipientOf(m));
      continue;
    }
    items.push({ m, t, to: new Set([recipientOf(m)]) });
  }
  return items;
}

function renderChat(force) {
  const feed = $("msg-feed");
  const sig = [state.sessionId, state.messages.length, state.messages.at(-1)?.id, $("msg-show-system").checked, $("msg-filter-agent").value,
    state.slots.map((s) => `${s.id}:${s.display_name}:${s.role}`).join(","), document.documentElement.dataset.theme].join("|");
  if (!force && sig === lastChatSignature) return;
  const firstRender = !lastChatSignature;
  lastChatSignature = sig;

  if (!state.session) {
    feed.innerHTML = `<div class="chat-empty">${state.brokerAlive ? "No session selected.<br><button class=\"btn primary\" data-action=\"new-team\" style=\"margin-top:12px\">+ New Team</button>" : "Broker is not running."}</div>`;
    $("chat-count").textContent = "";
    return;
  }
  const items = chatItems();
  $("chat-count").textContent = `${items.length} message${items.length === 1 ? "" : "s"}`;
  if (!items.length) {
    feed.innerHTML = '<div class="chat-empty">No messages yet. Say something to the team below.</div>';
    return;
  }

  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const prevHeight = feed.scrollHeight;
  let html = "", lastDay = "", lastSender = null, lastTime = 0;
  for (const { m, t, to } of items) {
    const day = new Date(t).toDateString();
    if (day !== lastDay) {
      lastDay = day;
      html += `<div class="day-sep"><span>${esc(fmtDay(t))}</span></div>`;
      lastSender = null;
    }
    const sender = senderOf(m);
    if (isSystemMessage(m)) {
      const target = to.size > 1 ? "everyone" : [...to][0];
      html += `<div class="sys-note"><span title="${esc(fmtTime(m.sent_at))} · ${esc(m.msg_type)}">${esc(sender.name)} &rarr; ${esc(target)}: ${esc(systemText(m))}</span></div>`;
      lastSender = null;
      continue;
    }
    const cont = lastSender === sender.key && t - lastTime < 3 * 60_000 && to.size === 1;
    lastSender = sender.key;
    lastTime = t;
    const toLabel = m.msg_type === "broadcast" || to.size > 2 ? "everyone" : [...to].join(", ");
    const text = m.text ?? "";
    const long = !expandedMessages.has(m.id) && (text.length > 1500 || text.split("\n").length > 24);
    const kind = m.msg_type !== "chat" ? m.msg_type : "";
    html += `<div class="msg${sender.me ? " me" : ""}${cont ? " cont" : ""}">
      ${avatar(sender.name, sender.color, "", sender.me)}
      <div class="msg-body">
        <div class="msg-head">
          <span class="msg-name">${esc(sender.name)}</span>
          ${sender.role ? `<span class="msg-role">${esc(sender.role)}</span>` : ""}
          <span class="msg-to">&rarr; ${esc(toLabel)}</span>
          ${kind ? `<span class="kind-tag ${esc(kind)}">${esc(kind.replace(/_/g, " "))}</span>` : ""}
          <span class="msg-time">${esc(fmtTime(m.sent_at))}</span>
        </div>
        <div class="bubble rich${kind ? ` kind-${esc(kind)}` : ""}${long ? " collapsed" : ""}" data-mid="${m.id}" title="${cont ? esc(fmtTime(m.sent_at)) : ""}">${renderMarkdown(text, { chat: true })}</div>
      </div>
    </div>`;
  }
  feed.innerHTML = html;
  hydrateFileRefs(feed);

  if (atBottom || force || firstRender) {
    feed.scrollTop = feed.scrollHeight;
    $("jump-new").classList.add("hidden");
  } else if (feed.scrollHeight > prevHeight) {
    $("jump-new").classList.remove("hidden");
  }
}

$("msg-feed").addEventListener("click", (e) => {
  const b = e.target.closest(".bubble.collapsed");
  if (b && !e.target.closest(".file-link, a")) { expandedMessages.add(Number(b.dataset.mid)); b.classList.remove("collapsed"); }
  const note = e.target.closest(".sys-note > span");
  if (note) note.classList.toggle("open");
});
$("msg-feed").addEventListener("scroll", () => {
  const feed = $("msg-feed");
  if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80) $("jump-new").classList.add("hidden");
});
$("jump-new").addEventListener("click", () => { const f = $("msg-feed"); f.scrollTop = f.scrollHeight; $("jump-new").classList.add("hidden"); });
$("msg-show-system").addEventListener("change", () => { store.set("ma-show-system", $("msg-show-system").checked); render(true); });
$("msg-filter-agent").addEventListener("change", () => render(true));

/** Keep the agent dropdowns in sync with the session's slots (preserving the selection). */
function refreshAgentSelects() {
  const live = liveSlots();
  const opts = (list) => list.map((s) => `<option value="${s.id}">${esc(slotName(s))}${s.role ? ` · ${esc(s.role)}` : ""}</option>`).join("");
  fillSelect("composer-to", `<option value="all">Everyone</option>` + opts(live));
  fillSelect("msg-filter-agent", `<option value="">everyone</option>` + opts(state.slots));
  fillSelect("plan-add-assignee", `<option value="">unassigned</option>` + opts(live));
  fillSelect("lock-agent", opts(live));
  fillSelect("own-agent", opts(live));
  const to = $("composer-to").value;
  const slot = to === "all" ? null : slotById(parseInt(to, 10));
  $("composer-target-hint").textContent = slot
    ? `${TASK_LABEL[slot.task_state] ?? slot.task_state}${isPaused(slot) ? " · paused (held until resume)" : ""}`
    : `${live.filter((s) => s.status === "connected" && !isPaused(s)).length} online`;
  $("composer-send").disabled = !state.session || state.session.status === "archived";
}

function fillSelect(id, html) {
  const el = $(id);
  if (!el || el.dataset.html === html || document.activeElement === el) return;
  const prev = el.value;
  el.innerHTML = html;
  el.dataset.html = html;
  if ([...el.options].some((o) => o.value === prev)) el.value = prev;
}

function autosize() {
  const ta = $("composer-text");
  ta.style.height = "auto";
  ta.style.height = `${Math.min(220, ta.scrollHeight)}px`;
}

async function sendComposer() {
  const sid = currentSid();
  if (sid == null) return;
  const ta = $("composer-text");
  const text = ta.value.trim();
  if (!text) return;
  const to = $("composer-to").value;
  const r = await run($("composer-send"), "Send", () => api("messages/send", { session_id: sid, slot_id: to === "all" ? "all" : parseInt(to, 10), text }));
  if (r) {
    ta.value = "";
    autosize();
    const f = $("msg-feed");
    f.scrollTop = f.scrollHeight;
  }
}

$("composer-send").addEventListener("click", sendComposer);
$("composer-text").addEventListener("input", autosize);
$("composer-text").addEventListener("keydown", (e) => {
  // Enter sends; Shift+Enter is a new line; an IME composition (Chinese/Japanese input) is never cut off
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendComposer(); }
});
$("composer-to").addEventListener("change", refreshAgentSelects);
$("composer-presets").addEventListener("click", (e) => {
  e.stopPropagation();
  openMenu($("composer-presets"), PRESETS.map((t) => ({ label: t, onClick: () => { $("composer-text").value = t; autosize(); $("composer-text").focus(); } })));
});

const PRESETS = [
  "Stop editing files and explain your current reasoning.",
  "Do not proceed until human approval.",
  "Summarize your progress and what is left.",
  "List the files you changed and why.",
];

// --- Session bar & gate ---

function renderSessionBar() {
  const s = state.session;
  $("sb-name").textContent = s ? (s.name || s.id) : (state.sessionId ?? "No session selected");
  const b = s ? sessionBadge() : null;
  $("sb-status").innerHTML = b ? `<span class="badge ${b.cls}">${b.text}</span>` : "";
  $("sb-gate").innerHTML = s
    ? `<span class="badge ${state.humanGate ? "badge-review" : "badge-idle"}" style="cursor:pointer" data-action="toggle-gate" title="Human gate: when on, approved work waits for your release instead of auto-ending">human gate ${state.humanGate ? "on" : "off"}</span>`
    : "";
  $("sb-meta").textContent = s
    ? `${s.project_dir}${state.managed ? " · agents run under this dashboard" : ""}`
    : "Create a team with + New Team, or pick a session on the left.";
  $("sb-meta").title = s ? `${s.id} · ${s.project_dir}` : "";

  const has = !!s, archived = s?.status === "archived", paused = s?.status === "paused";
  const tb = $("session-toolbar");
  tb.querySelector('[data-action="session-pause"]').disabled = !has || archived || paused;
  tb.querySelector('[data-action="session-resume"]').disabled = !has || archived || !paused;
  tb.querySelector('[data-action="add-agent"]').disabled = !has || archived;
  tb.querySelector('[data-action="release-menu"]').disabled = !has;
  tb.querySelector('[data-action="session-menu"]').disabled = !has;
}

function renderGateBanner() {
  const el = $("gate-banner");
  if (!state.awaitingHuman) { el.className = "hidden"; el.innerHTML = ""; return; }
  el.className = "banner";
  el.innerHTML = `<span class="banner-title">&#9888; Waiting for your approval</span>
    <span class="dim">Every agent is approved. Review the work, then release it or send it back.</span>
    <span class="toolbar">
      <button class="btn danger" data-action="gate-sendback">Send back for revision</button>
      <button class="btn primary" data-action="gate-release">Approve &amp; Release</button>
    </span>`;
}

// --- Agents ---

const TASK_LABEL = {
  idle: "idle", working: "working", done_pending_review: "in review",
  addressing_feedback: "addressing feedback", approved: "approved", released: "released",
};
const TASK_CLASS = {
  idle: "badge-idle", working: "badge-working", done_pending_review: "badge-review",
  addressing_feedback: "badge-feedback", approved: "badge-approved", released: "badge-released",
};

function taskBadge(taskState) {
  return `<span class="badge ${TASK_CLASS[taskState] ?? "badge-idle"}" title="task_state: ${esc(taskState)}">${esc(TASK_LABEL[taskState] ?? taskState)}</span>`;
}

function connBadge(status) {
  return status === "connected" ? '<span class="badge badge-connected">online</span>' : '<span class="badge badge-disconnected">offline</span>';
}

function slotSummary(slot) {
  const peer = slot.peer_id ? state.peers.find((p) => p.id === slot.peer_id) : null;
  if (peer?.summary) return peer.summary;
  try { return JSON.parse(slot.context_snapshot ?? "{}")?.last_summary ?? null; } catch { return null; }
}

function renderAgents() {
  const el = $("panel-agents");
  if (busyRegion(el)) return;
  if (!state.session) {
    el.innerHTML = `<div class="empty">${state.brokerAlive ? "No session selected." : "Broker is not running."}<br><button class="btn primary" data-action="new-team">+ New Team</button></div>`;
    return;
  }
  if (!state.slots.length) {
    el.innerHTML = '<div class="empty">No agents in this session<br><button class="btn primary" data-action="add-agent">+ Add Agent</button></div>';
    return;
  }
  const archived = state.session.status === "archived";
  const managed = new Set(state.managedSlots ?? []);
  el.innerHTML = `<div class="agents-grid">${state.slots.map((slot) => {
    const summary = slotSummary(slot);
    const released = slot.task_state === "released";
    const paused = isPaused(slot);
    const reviewable = slot.task_state === "approved" || slot.task_state === "done_pending_review";
    const id = slot.id;
    const tokens = slot.input_tokens || slot.output_tokens ? `<span class="agent-ids">${fmtTokens(slot.input_tokens ?? 0)} in / ${fmtTokens(slot.output_tokens ?? 0)} out</span>` : "";
    const actions = released || archived
      ? `<button class="btn small danger" data-agent="remove" data-slot="${id}" ${archived ? "disabled" : ""}>Remove</button>`
      : `<button class="btn small primary" data-agent="message" data-slot="${id}">Message</button>
        ${paused ? `<button class="btn small success" data-agent="resume" data-slot="${id}">Resume</button>` : `<button class="btn small warn" data-agent="pause" data-slot="${id}">Pause</button>`}
        <button class="btn small" data-agent="role" data-slot="${id}">Role</button>
        <button class="btn small" data-agent="rename" data-slot="${id}">Rename</button>
        ${reviewable ? `<button class="btn small warn" data-agent="sendback" data-slot="${id}">Send Back</button>` : ""}
        <button class="btn small ${slot.task_state === "approved" ? "success" : ""}" data-agent="release" data-slot="${id}">Release</button>
        <button class="btn small danger" data-agent="remove" data-slot="${id}">Remove</button>`;
    return `<div class="agent-card${slot.task_state === "approved" ? " approved" : ""}">
      <div class="agent-head">
        ${avatar(slotName(slot), slotColor(id))}
        <div class="agent-title"><div class="agent-name">${esc(slotName(slot))}</div><div class="agent-role">${esc(slot.role ?? "no role")} · ${esc(slot.agent_type)}</div></div>
        ${connBadge(slot.status)}
      </div>
      <div class="agent-badges">
        ${taskBadge(slot.task_state ?? "idle")}
        ${paused ? '<span class="badge badge-paused">paused</span>' : ""}
        ${managed.has(id) ? '<span class="badge badge-managed" title="This dashboard launched and supervises the agent process">managed here</span>' : ""}
      </div>
      <div class="agent-ids" title="slot id = stable seat in the session; peer id = the running process's registration">slot #${id} · peer ${esc(slot.peer_id ?? "—")}</div>
      ${tokens}
      ${summary ? `<div class="agent-summary rich">${inline(truncate(summary, 260))}</div>` : ""}
      <div class="agent-actions">${actions}</div>
    </div>`;
  }).join("")}</div>`;
  hydrateFileRefs(el);
}

function renderRoster() {
  const el = $("rpanel-team");
  if ($("rpanel-team").classList.contains("hidden") || busyRegion(el)) return;
  if (!state.session) { el.innerHTML = '<div class="empty">No session selected</div>'; return; }
  if (!state.slots.length) { el.innerHTML = '<div class="empty">No agents yet<br><button class="btn primary" data-action="add-agent">+ Add Agent</button></div>'; return; }
  const order = (s) => (s.task_state === "released" ? 2 : s.status === "connected" ? 0 : 1);
  el.innerHTML = [...state.slots].sort((a, b) => order(a) - order(b) || a.id - b.id).map((slot) => {
    const statusColor = isPaused(slot) ? "var(--yellow)" : slot.status === "connected" ? "var(--green)" : "var(--text-muted)";
    const summary = slotSummary(slot);
    return `<div class="roster-item" data-roster="${slot.id}" style="${slot.task_state === "released" ? "opacity:.55" : ""}">
      ${avatar(slotName(slot), slotColor(slot.id), `<span class="status" style="background:${statusColor}"></span>`)}
      <div class="roster-main">
        <div class="roster-name">${esc(slotName(slot))} <span class="muted" style="font-weight:400;font-size:11.5px">${esc(slot.role ?? "")}</span></div>
        <div class="roster-sub">${esc(TASK_LABEL[slot.task_state] ?? slot.task_state)}${isPaused(slot) ? " · paused" : ""}${summary ? ` · ${esc(truncate(summary, 80))}` : ""}</div>
      </div>
      <button class="icon-btn" data-roster-menu="${slot.id}" title="Actions">&#8943;</button>
    </div>`;
  }).join("");
}

$("rpanel-team").addEventListener("click", (e) => {
  const menuBtn = e.target.closest("[data-roster-menu]");
  const slot = slotById(parseInt(e.target.closest("[data-roster]")?.dataset.roster, 10));
  if (!slot) return;
  if (menuBtn) {
    e.stopPropagation();
    const released = slot.task_state === "released";
    const items = [
      { label: "Message", disabled: released, onClick: () => agentAction("message", slot) },
      isPaused(slot) ? { label: "Resume", disabled: released, onClick: () => agentAction("resume", slot) } : { label: "Pause", disabled: released, onClick: () => agentAction("pause", slot) },
      { label: "Change role", disabled: released, onClick: () => agentAction("role", slot) },
      { label: "Rename", disabled: released, onClick: () => agentAction("rename", slot) },
      { label: "Send back for revision", disabled: released, onClick: () => agentAction("sendback", slot) },
      { sep: true },
      { label: "Release", disabled: released, onClick: () => agentAction("release", slot) },
      { label: "Remove", danger: true, onClick: () => agentAction("remove", slot) },
    ];
    openMenu(menuBtn, items);
    return;
  }
  // A click on a teammate addresses the composer to them
  if (slot.task_state !== "released") {
    switchTab("chat");
    $("composer-to").value = String(slot.id);
    refreshAgentSelects();
    $("composer-text").focus();
  }
});

$("panel-agents").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-agent]");
  if (!btn) return;
  const slot = slotById(parseInt(btn.dataset.slot, 10));
  if (slot) agentAction(btn.dataset.agent, slot, btn);
});

async function agentAction(kind, slot, btn) {
  const sid = currentSid();
  if (sid == null) return;
  const name = slotName(slot);
  switch (kind) {
    case "message":
      switchTab("chat");
      $("composer-to").value = String(slot.id);
      refreshAgentSelects();
      $("composer-text").focus();
      return;
    case "pause":
      return run(btn, "Pause", () => api("agents/control", { session_id: sid, slot_id: slot.id, action: "pause" }));
    case "resume":
      return run(btn, "Resume", () => api("agents/control", { session_id: sid, slot_id: slot.id, action: "resume" }));
    case "rename": {
      const v = await promptDialog({ title: `Rename ${name}`, sid, label: "Display name", value: slot.display_name ?? "" });
      if (v) return run(null, "Rename", () => api("agents/rename", { session_id: sid, slot_id: slot.id, display_name: v }));
      return;
    }
    case "role": return roleModal(sid, slot);
    case "sendback": return sendBackModal(sid, slot.id);
    case "release": {
      const notApproved = slot.task_state !== "approved";
      const ok = await confirmDialog({
        title: `Release ${name}?`, sid,
        message: `<p>Releasing tells ${esc(name)} its work is complete; it disconnects once idle.</p>` +
          (notApproved ? `<p style="color:var(--yellow)">&#9888; ${esc(name)} is <b>${esc(TASK_LABEL[slot.task_state] ?? slot.task_state)}</b>, not approved.</p>` : ""),
        confirmLabel: "Release", danger: notApproved,
      });
      if (ok) return run(btn, "Release", () => api("agents/release", { session_id: sid, slot_id: slot.id }));
      return;
    }
    case "remove": {
      const ok = await confirmDialog({
        title: `Remove ${name}?`, sid,
        message: "<p>Remove stops the agent now (if this dashboard runs it), marks it released and tells the team it left. Unlike <b>Release</b>, it does not wait for the agent to finish.</p>",
        confirmLabel: "Remove", danger: true,
      });
      if (ok) return run(btn, "Remove", () => api("agents/remove", { session_id: sid, slot_id: slot.id }));
      return;
    }
  }
}

// --- Plan ---

const PLAN_ICON = { done: "&#10003;", in_progress: "&#9654;", blocked: "&#10007;", pending: "&#9675;" };

function renderPlan() {
  const el = $("plan-list");
  if (busyRegion(el)) return;
  if (!state.plan?.plan) {
    el.innerHTML = `<div class="empty">${state.session ? "No plan yet — add the first task above." : "No session selected"}</div>`;
    return;
  }
  const { plan, items, completion } = state.plan;
  const itemsHtml = items.map((item) => {
    const assigneeOpts = `<option value="">unassigned</option>` + state.slots
      .filter((s) => s.task_state !== "released" || s.id === item.assigned_to_slot)
      .map((s) => `<option value="${s.id}" ${s.id === item.assigned_to_slot ? "selected" : ""}>${esc(slotName(s))}</option>`).join("");
    const statusOpts = ["pending", "in_progress", "blocked", "done"]
      .map((st) => `<option value="${st}" ${st === item.status ? "selected" : ""}>${st.replace("_", " ")}</option>`).join("");
    return `<div class="plan-item ${esc(item.status)}" data-item="${item.id}">
      <span class="plan-check ${esc(item.status)}">${PLAN_ICON[item.status] ?? PLAN_ICON.pending}</span>
      <span class="plan-label" data-plan="edit" title="Click to edit">${esc(item.label)}</span>
      <select data-plan="status">${statusOpts}</select>
      <select data-plan="assignee">${assigneeOpts}</select>
      <button class="icon-btn" data-plan="delete" title="Delete task">&#10005;</button>
    </div>`;
  }).join("");
  el.innerHTML = `<div class="card">
    <div class="card-header"><div class="plan-header">
      <span class="plan-title">${esc(plan.title)}</span>
      <div class="progress-bar"><div class="progress-fill" style="width:${completion}%"></div></div>
      <span class="plan-pct">${completion}%</span>
    </div></div>
    <div style="padding:4px 14px">${itemsHtml || '<div class="empty">No tasks</div>'}</div>
  </div>`;
}

$("plan-add-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const label = $("plan-add-label").value.trim();
  if (!label) return;
  const assignee = $("plan-add-assignee").value;
  const r = await run(e.submitter, "Add task", () => api("plan/add", { session_id: sid, label, slot_id: assignee ? parseInt(assignee, 10) : null }).then(() => ({ message: "Task added" })));
  if (r) $("plan-add-label").value = "";
});

$("plan-list").addEventListener("change", (e) => {
  const sel = e.target.closest("select[data-plan]");
  if (!sel) return;
  const sid = currentSid();
  if (sid == null) return;
  const body = { session_id: sid, item_id: parseInt(sel.closest("[data-item]").dataset.item, 10) };
  if (sel.dataset.plan === "status") body.status = sel.value;
  else body.slot_id = sel.value ? parseInt(sel.value, 10) : null;
  sel.blur();
  run(null, "Update task", () => api("plan/edit", body).then(() => ({ message: "Task updated" })));
});

$("plan-list").addEventListener("click", async (e) => {
  const t = e.target.closest("[data-plan]");
  if (!t || t.tagName === "SELECT") return;
  const sid = currentSid();
  if (sid == null) return;
  const itemId = parseInt(t.closest("[data-item]").dataset.item, 10);
  const item = state.plan?.items.find((i) => i.id === itemId);
  if (!item) return;
  if (t.dataset.plan === "edit") {
    const v = await promptDialog({ title: "Edit task", sid, label: "Task", value: item.label, multiline: true });
    if (v) run(null, "Edit task", () => api("plan/edit", { session_id: sid, item_id: itemId, label: v }).then(() => ({ message: "Task updated" })));
  } else if (t.dataset.plan === "delete") {
    const ok = await confirmDialog({ title: "Delete task?", sid, message: `<p>${esc(item.label)}</p>`, confirmLabel: "Delete", danger: true });
    if (ok) run(null, "Delete task", () => api("plan/delete", { session_id: sid, item_id: itemId }).then(() => ({ message: "Task deleted" })));
  }
});

// --- Knowledge ---

let editingKnowledgeKey = null;

function renderKnowledge() {
  const el = $("knowledge-list");
  if (busyRegion(el)) return;
  const entries = state.knowledge ?? [];
  if (!entries.length) {
    el.innerHTML = `<div class="empty">${state.session ? "No knowledge entries. Agents store decisions and discoveries here." : "No session selected"}</div>`;
    return;
  }
  el.innerHTML = `<div class="card"><div class="card-header">Shared Knowledge <span>${entries.length}</span></div>${entries.map((e) => {
    const by = e.created_by_name ? `by ${esc(e.created_by_name)}` : "";
    const ago = timeSince(e.updated_at);
    return `<div class="knowledge-item" data-key="${esc(e.key)}">
      <div class="knowledge-main">
        <div><span class="knowledge-key">${esc(e.key)}</span><span class="knowledge-cat">${esc(e.category)}</span></div>
        <div class="knowledge-value rich">${renderMarkdown(e.value, { chat: true })}</div>
        <div class="knowledge-meta">${by}${by && ago ? " · " : ""}${ago}</div>
      </div>
      <div class="flex gap-2" style="align-items:flex-start">
        <button class="btn small" data-kn="edit">Edit</button>
        <button class="btn small danger" data-kn="delete">Delete</button>
      </div>
    </div>`;
  }).join("")}</div>`;
  hydrateFileRefs(el);
}

function resetKnowledgeForm() {
  editingKnowledgeKey = null;
  $("knowledge-form").reset();
  $("kn-key").readOnly = false;
  $("knowledge-form-title").textContent = "Add knowledge";
}

$("kn-cancel").addEventListener("click", resetKnowledgeForm);

$("knowledge-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const body = { session_id: sid, key: $("kn-key").value.trim(), value: $("kn-value").value, category: $("kn-category").value };
  const r = await run(e.submitter, "Save knowledge", () => api("knowledge/put", body).then(() => ({ message: `Saved "${body.key}"` })));
  if (r) resetKnowledgeForm();
});

$("knowledge-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-kn]");
  if (!btn) return;
  const sid = currentSid();
  if (sid == null) return;
  const key = btn.closest("[data-key]").dataset.key;
  const entry = state.knowledge.find((k) => k.key === key);
  if (!entry) return;
  if (btn.dataset.kn === "edit") {
    editingKnowledgeKey = key;
    $("kn-key").value = entry.key;
    $("kn-key").readOnly = true;
    $("kn-value").value = entry.value;
    $("kn-category").value = entry.category;
    $("knowledge-form-title").textContent = `Edit "${key}"`;
    $("kn-value").focus();
  } else {
    const ok = await confirmDialog({ title: `Delete "${key}"?`, sid, message: `<p>${esc(truncate(entry.value, 300))}</p>`, confirmLabel: "Delete", danger: true });
    if (ok) {
      await run(btn, "Delete knowledge", () => api("knowledge/delete", { session_id: sid, key }).then(() => ({ message: `Deleted "${key}"` })));
      if (editingKnowledgeKey === key) resetKnowledgeForm();
    }
  }
});

// --- Locks ---

function renderFiles() {
  const el = $("files-list");
  if (busyRegion(el)) return;
  const lockRows = state.fileLocks.map((l) => {
    const holder = slotById(l.held_by_slot);
    const left = l.expires_at - Date.now();
    return `<tr>
      <td><span class="file-ref mono" data-ref="${esc(l.file_path)}">${esc(l.file_path)}</span></td>
      <td>${esc(holder ? slotName(holder) : `Slot ${l.held_by_slot}`)}</td>
      <td class="dim">${esc(l.purpose ?? "")}</td>
      <td class="dim">${timeSince(l.acquired_at)}</td>
      <td style="color:${left < 60000 ? "var(--yellow)" : "var(--text-dim)"}">${left > 0 ? "in " + fmtDuration(left) : "expired"}</td>
      <td><button class="btn small danger" data-lock-release="${l.id}">Force unlock</button></td>
    </tr>`;
  }).join("");
  const ownRows = state.fileOwnership.map((o) => {
    const owner = slotById(o.slot_id);
    return `<tr><td class="mono">${esc(o.path_pattern)}</td><td>${esc(owner ? slotName(owner) : `Slot ${o.slot_id}`)}</td><td class="dim">${esc(o.assigned_by ?? "")}</td><td class="dim">${timeSince(o.assigned_at)}</td></tr>`;
  }).join("");
  el.innerHTML = `<div class="card"><div class="card-header">Active Locks <span>${state.fileLocks.length}</span></div>
      ${state.fileLocks.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>File</th><th>Held By</th><th>Purpose</th><th>Acquired</th><th>Expires</th><th></th></tr></thead><tbody>${lockRows}</tbody></table></div>` : '<div class="empty" style="padding:16px">No active locks</div>'}</div>
    <div class="card"><div class="card-header">Ownership Zones <span>${state.fileOwnership.length}</span></div>
      ${state.fileOwnership.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Pattern</th><th>Owner</th><th>Assigned By</th><th>When</th></tr></thead><tbody>${ownRows}</tbody></table></div>` : '<div class="empty" style="padding:16px">No ownership zones</div>'}</div>`;
  hydrateFileRefs(el);
}

$("files-list").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-lock-release]");
  if (!btn) return;
  const sid = currentSid();
  if (sid == null) return;
  const lock = state.fileLocks.find((l) => l.id === parseInt(btn.dataset.lockRelease, 10));
  if (!lock) return;
  const holder = slotById(lock.held_by_slot);
  const ok = await confirmDialog({
    title: "Force unlock?", sid,
    message: `<p><span class="mono">${esc(lock.file_path)}</span> is held by <b>${esc(holder ? slotName(holder) : `slot ${lock.held_by_slot}`)}</b>. Unlocking lets other agents edit it while the holder may still be writing.</p>`,
    confirmLabel: "Force unlock", danger: true,
  });
  if (ok) run(btn, "Unlock", () => api("files/release", { session_id: sid, lock_id: lock.id }));
});

$("lock-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const slot = $("lock-agent").value;
  if (!slot) return toast("Pick an agent", "warn");
  const r = await run(e.submitter, "Acquire lock", () => api("files/acquire", {
    session_id: sid, slot_id: parseInt(slot, 10), file_path: $("lock-path").value.trim(),
    minutes: Number($("lock-minutes").value), purpose: $("lock-purpose").value.trim(),
  }));
  if (r) { $("lock-path").value = ""; $("lock-purpose").value = ""; }
});

$("ownership-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const sid = currentSid();
  if (sid == null) return;
  const slot = $("own-agent").value;
  if (!slot) return toast("Pick an agent", "warn");
  const patterns = $("own-patterns").value.split(",").map((p) => p.trim()).filter(Boolean);
  const r = await run(e.submitter, "Assign ownership", () => api("files/ownership", { session_id: sid, slot_id: parseInt(slot, 10), patterns }));
  if (r) $("own-patterns").value = "";
});

// --- Stats ---

function renderStats() {
  const el = $("panel-stats");
  if (busyRegion(el)) return;
  if (!state.session) { el.innerHTML = '<div class="empty">No session selected</div>'; return; }
  const totalIn = state.slots.reduce((a, s) => a + (s.input_tokens ?? 0), 0);
  const totalOut = state.slots.reduce((a, s) => a + (s.output_tokens ?? 0), 0);
  const cards = [
    { value: state.slots.filter((s) => s.status === "connected").length, label: "Online agents", color: "var(--green)" },
    { value: state.slots.filter((s) => s.task_state === "working").length, label: "Working", color: "var(--accent)" },
    { value: state.slots.filter((s) => s.task_state === "approved").length, label: "Approved (not released)", color: "var(--green)" },
    { value: state.slots.filter((s) => s.task_state === "released").length, label: "Released", color: "var(--text-dim)" },
    { value: state.messages.length, label: "Messages", color: "var(--cyan)" },
    { value: fmtTokens(totalIn), label: "Input tokens", color: "var(--purple)" },
    { value: fmtTokens(totalOut), label: "Output tokens", color: "var(--purple)" },
  ];
  for (const g of state.guardrails.filter((g) => g.action === "monitor")) {
    cards.push({ value: g.usage?.current ?? 0, label: `${g.label} (${g.unit})`, color: "var(--text)" });
  }
  const enforced = state.guardrails.filter((g) => g.action !== "monitor");
  const guardrails = enforced.length ? `<div class="card"><div class="card-header">Guardrails <span style="text-transform:none;letter-spacing:0;font-weight:400">changes are logged as "Adjusted via web dashboard"</span></div>
    <div class="card-body">${enforced.map((g) => {
      const u = g.usage ?? { current: 0, limit: g.current_value, percent: 0, status: "ok" };
      const color = u.status === "triggered" ? "var(--red)" : u.status === "warning" ? "var(--yellow)" : "var(--green)";
      const pct = Math.min(100, Math.round((u.percent ?? 0) * 100)); // broker reports a 0..1 ratio
      return `<div class="guardrail-row" data-guardrail="${esc(g.id)}">
        <div class="guardrail-info">
          <div class="guardrail-label">${esc(g.label)} ${g.is_overridden ? '<span class="badge badge-review">overridden</span>' : ""}</div>
          <div class="guardrail-desc">${esc(g.description ?? "")} · default ${g.default_value} ${esc(g.unit)} · action: ${esc(g.action)}</div>
          <div class="progress-bar" style="margin-top:4px;max-width:260px"><div class="progress-fill" style="width:${pct}%;background:${color}"></div></div>
          <div class="guardrail-desc" style="color:${color}">usage ${u.current}/${u.limit}</div>
        </div>
        ${g.adjustable ? `<div class="stepper">
          <button class="btn small" data-step="-1">&minus;</button>
          <input type="number" min="0" value="${g.current_value}" data-input>
          <button class="btn small" data-step="1">+</button>
          <button class="btn small primary" data-set>Set</button>
          ${(g.suggested_increases ?? []).map((v) => `<button class="btn small" data-suggest="${v}">${v}</button>`).join("")}
        </div>` : '<span class="dim" style="font-size:12px">fixed</span>'}
      </div>`;
    }).join("")}</div></div>` : "";
  el.innerHTML = `<div class="stats-grid">${cards.map((s) => `<div class="stat-card"><div class="stat-value" style="color:${s.color}">${s.value}</div><div class="stat-label">${esc(s.label)}</div></div>`).join("")}</div>${guardrails}`;
}

$("panel-stats").addEventListener("click", (e) => {
  const row = e.target.closest("[data-guardrail]");
  if (!row) return;
  const input = row.querySelector("[data-input]");
  const step = e.target.closest("[data-step]");
  if (step) { input.value = Math.max(0, Number(input.value) + Number(step.dataset.step)); input.focus(); return; }
  const suggest = e.target.closest("[data-suggest]");
  if (suggest) input.value = suggest.dataset.suggest;
  if (suggest || e.target.closest("[data-set]")) {
    const sid = currentSid();
    if (sid == null) return;
    const value = Number(input.value);
    const id = row.dataset.guardrail;
    input.blur();
    run(e.target, "Guardrail", () => api("guardrail", { session_id: sid, guardrail_id: id, value, reason: "Adjusted via web dashboard" })
      .then((g) => ({ message: `${g?.label ?? id} set to ${g?.current_value ?? value} ${g?.unit ?? ""}` })));
  }
});

// --- Toolbar / global actions ---

document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn || btn.disabled) return;
  globalAction(btn.dataset.action, btn);
});

async function globalAction(action, btn) {
  if (action === "new-team") return newTeamModal();
  if (action === "new-session") return newSessionModal();
  const sid = currentSid();
  if (sid == null) return;
  switch (action) {
    case "session-pause": {
      const ok = await confirmDialog({ title: "Pause the whole session?", sid, message: "<p>Every connected agent gets a pause signal, its incoming messages are held and its file locks are released. Resume picks up where they stopped.</p>", confirmLabel: "Pause all" });
      if (ok) run(btn, "Pause", () => api("session/control", { session_id: sid, action: "pause" }));
      return;
    }
    case "session-resume": return run(btn, "Resume", () => api("session/control", { session_id: sid, action: "resume" }));
    case "add-agent": return addAgentModal(sid);
    case "release-menu": return openMenu(btn, releaseMenuItems(sid));
    case "session-menu": return openMenu(btn, sessionMenuItems(state.session));
    case "toggle-gate": return run(btn, "Human gate", () => api("session/human-gate", { session_id: sid, enabled: !state.humanGate }));
    case "gate-release": return releaseAll(sid, true, btn);
    case "gate-sendback": return sendBackModal(sid, null);
  }
}

function releaseMenuItems(sid) {
  const approved = state.slots.filter((s) => s.task_state === "approved");
  const releasable = state.slots.filter((s) => s.task_state !== "released" && s.task_state !== "idle");
  return [
    { label: "Release all approved", hint: String(approved.length), disabled: !approved.length, onClick: () => releaseAll(sid, true) },
    { label: "Release all", hint: String(releasable.length), danger: true, disabled: !releasable.length, onClick: () => releaseAll(sid, false) },
  ];
}

async function releaseAll(sid, approvedOnly, btn) {
  const targets = approvedOnly
    ? state.slots.filter((s) => s.task_state === "approved")
    : state.slots.filter((s) => s.task_state !== "released" && s.task_state !== "idle");
  if (!targets.length) return toast("Nothing to release", "warn");
  const notApproved = targets.filter((s) => s.task_state !== "approved");
  const ok = await confirmDialog({
    title: approvedOnly ? "Release all approved agents?" : "Release ALL agents?", sid,
    message: `<p>These agents are told their work is complete and disconnect once idle:</p><ul>${targets.map((s) => `<li>${esc(slotName(s))} — ${esc(TASK_LABEL[s.task_state] ?? s.task_state)}</li>`).join("")}</ul>` +
      (notApproved.length ? `<p style="color:var(--yellow)">&#9888; ${notApproved.length} of them are not approved.</p>` : ""),
    confirmLabel: "Release", danger: !approvedOnly,
  });
  if (ok) run(btn, "Release", () => api("agents/release-all", { session_id: sid, approved_only: approvedOnly }));
}

function sessionMenuItems(s) {
  if (!s) return [];
  const sid = s.id;
  const archived = s.status === "archived";
  return [
    { label: "Open", disabled: sid === state.sessionId, onClick: () => selectSession(sid) },
    { label: "Pause", disabled: s.status !== "active", onClick: async () => {
        if (await confirmDialog({ title: `Pause "${s.name}"?`, sid, message: "<p>Pauses every connected agent of this session.</p>", confirmLabel: "Pause all" }))
          run(null, "Pause", () => api("session/control", { session_id: sid, action: "pause" }));
      } },
    { label: "Resume", disabled: s.status !== "paused", onClick: () => run(null, "Resume", () => api("session/control", { session_id: sid, action: "resume" })) },
    { label: "Relaunch disconnected agents", onClick: async () => {
        if (await confirmDialog({ title: `Relaunch agents of "${s.name}"?`, sid, message: "<p>Respawns every disconnected, unreleased agent with a handoff of its role, plan items and recent messages. They run under this dashboard. Agents another orchestrator still runs are not touched.</p>", confirmLabel: "Relaunch" }))
          run(null, "Relaunch", () => api("session/relaunch", { session_id: sid }));
      } },
    { sep: true },
    { label: "Export JSON", onClick: () => { location.href = `/api/session/export?session_id=${encodeURIComponent(sid)}`; } },
    { label: "Archive", disabled: archived, onClick: async () => {
        if (await confirmDialog({ title: `Archive "${s.name}"?`, sid, message: "<p>Marks the session archived (like <span class=\"mono\">multiagents session archive</span>). Running agents are not stopped — use <b>End session</b> for that.</p>", confirmLabel: "Archive" }))
          run(null, "Archive", () => api("session/archive", { session_id: sid }));
      } },
    { label: "End session", danger: true, disabled: archived, onClick: async () => {
        if (await confirmDialog({ title: `End "${s.name}"?`, sid, message: "<p>Stops the agents this dashboard runs, marks every agent disconnected and archives the session.</p>", confirmLabel: "End session", danger: true }))
          run(null, "End session", () => api("session/end", { session_id: sid }));
      } },
    { label: "Delete…", danger: true, onClick: async () => {
        if (await confirmDialog({ title: `Delete "${s.name}" permanently?`, sid, message: "<p>Stops its agents and deletes all slots, messages, plans and locks. <b>This cannot be undone.</b> Export first if you want a copy. Project files are not touched.</p>", confirmLabel: "Delete forever", danger: true, typeToConfirm: sid }))
          run(null, "Delete", () => api("session/delete", { session_id: sid, confirm: sid }));
      } },
  ];
}

// --- Dropdown menu ---

function openMenu(anchor, items) {
  const menu = $("menu");
  menu.innerHTML = items.map((it, i) => it.sep
    ? '<div class="menu-sep"></div>'
    : `<div class="menu-item${it.danger ? " danger" : ""}${it.disabled ? " disabled" : ""}${it.checked ? " checked" : ""}" data-idx="${i}">${esc(it.label)}${it.hint ? `<span class="menu-hint">${esc(it.hint)}</span>` : ""}</div>`).join("");
  menu.onclick = (e) => {
    const el = e.target.closest(".menu-item");
    if (!el) return;
    closeMenu();
    items[parseInt(el.dataset.idx, 10)]?.onClick?.();
  };
  menu.classList.add("open");
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
  menu.style.top = `${r.bottom + h + 8 > window.innerHeight ? Math.max(8, r.top - h - 4) : r.bottom + 4}px`;
}

function closeMenu() { $("menu").classList.remove("open"); }

// Clicks on the menu or on a button that opens one leave it to that button
document.addEventListener("click", (e) => {
  if (!e.target.closest("#menu, [data-action$='-menu'], [data-session-menu], [data-roster-menu], #theme-btn, #composer-presets")) closeMenu();
});

// --- Modals ---

let modalClose = null;

/** Open a modal. `onSubmit(form)` may throw to keep it open with the error shown; returning closes it. */
function openModal({ title, sub, body, submitLabel = "OK", danger = false, wide = false, onSubmit, onCancel, setup }) {
  closeModal();
  const overlay = $("modal-overlay");
  overlay.innerHTML = `<form class="modal${wide ? " wide" : ""}" novalidate>
    <div class="modal-header"><div><div class="modal-title">${esc(title)}</div>${sub ? `<div class="modal-sub">${esc(sub)}</div>` : ""}</div>
      <button type="button" class="icon-btn" data-close>&#10005;</button></div>
    <div class="modal-body">${body}</div>
    <div class="modal-footer"><span class="modal-error"></span>
      <button type="button" class="btn" data-close>Cancel</button>
      <button type="submit" class="btn ${danger ? "solid-danger" : "primary"}">${esc(submitLabel)}</button></div>
  </form>`;
  overlay.classList.add("open");
  const form = overlay.querySelector("form");
  const errEl = form.querySelector(".modal-error");
  const submitBtn = form.querySelector('[type="submit"]');
  let done = false;
  const finish = (cancelled) => {
    if (done) return;
    done = true;
    overlay.classList.remove("open");
    overlay.innerHTML = "";
    modalClose = null;
    if (cancelled) onCancel?.();
  };
  modalClose = () => finish(true);
  form.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => finish(true)));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    submitBtn.disabled = true;
    submitBtn.classList.add("busy");
    try {
      await onSubmit(form);
      finish(false);
    } catch (err) {
      errEl.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.classList.remove("busy");
    }
  });
  setup?.(form);
  setTimeout(() => form.querySelector("[autofocus], textarea, input:not([type=checkbox]), select")?.focus(), 30);
  return form;
}

function closeModal() { modalClose?.(); }

function sessionSub(sid) {
  const s = state?.sessions?.find((x) => x.id === sid);
  return `Session: ${s?.name && s.name !== sid ? `${s.name} (${sid})` : sid}`;
}

function confirmDialog({ title, message, confirmLabel = "Confirm", danger = false, sid, typeToConfirm }) {
  return new Promise((resolve) => {
    openModal({
      title, sub: sid != null ? sessionSub(sid) : undefined, submitLabel: confirmLabel, danger,
      body: `${message ?? ""}${typeToConfirm ? `<p class="dim" style="margin-top:10px">Type <b class="mono">${esc(typeToConfirm)}</b> to confirm:</p><input type="text" name="confirm" style="width:100%" autocomplete="off">` : ""}`,
      onSubmit: (form) => {
        if (typeToConfirm && form.confirm.value.trim() !== typeToConfirm) throw new Error("The text does not match");
        resolve(true);
      },
      onCancel: () => resolve(false),
    });
  });
}

function promptDialog({ title, label, value = "", multiline = false, sid }) {
  return new Promise((resolve) => {
    openModal({
      title, sub: sid != null ? sessionSub(sid) : undefined, submitLabel: "Save",
      body: `<div class="form-grid"><label>${esc(label)}</label>${multiline ? `<textarea name="v" rows="3">${esc(value)}</textarea>` : `<input type="text" name="v" value="${esc(value)}">`}</div>`,
      onSubmit: (form) => {
        const v = form.v.value.trim();
        if (!v) throw new Error(`${label} is required`);
        resolve(v);
      },
      onCancel: () => resolve(null),
    });
  });
}

function agentOptions(selectedId) {
  return liveSlots().map((s) => `<option value="${s.id}" ${s.id === selectedId ? "selected" : ""}>${esc(slotName(s))}${s.role ? ` · ${esc(s.role)}` : ""} — ${esc(TASK_LABEL[s.task_state] ?? s.task_state)}</option>`).join("");
}

function roleDatalist() {
  return `<datalist id="role-suggestions">${["Software Engineer", "Code Reviewer", "QA Engineer", "UI/UX Designer", "Researcher", "Writer", "Editor", "Tech Lead", "Worker", "Reviewer"]
    .map((r) => `<option value="${r}">`).join("")}</datalist>`;
}

function roleModal(sid, slot) {
  openModal({
    title: `Change role of ${slotName(slot)}`, sub: sessionSub(sid), submitLabel: "Assign role",
    body: `<div class="form-grid">
      <label>Role</label><input type="text" name="role" list="role-suggestions" value="${esc(slot.role ?? "")}" autofocus>
      <label>Description</label><textarea name="desc" rows="4">${esc(slot.role_description ?? "")}</textarea>
    </div><div class="field-hint" style="margin-top:8px">The agent receives a role_assignment message. Roles containing review, QA, test or lead count as reviewers in the approval flow.</div>
    ${roleDatalist()}`,
    onSubmit: async (form) => {
      const r = await api("agents/role", { session_id: sid, slot_id: slot.id, role: form.role.value.trim(), role_description: form.desc.value.trim() });
      toast(r?.message ?? "Role assigned", "ok");
    },
  });
}

function sendBackModal(sid, slotId) {
  const isReviewer = (s) => /qa|review|test|lead/i.test(s.role ?? "");
  const candidates = liveSlots();
  const preferred = slotId ?? (candidates.find((s) => !isReviewer(s))?.id ?? candidates[0]?.id ?? null);
  openModal({
    title: "Send back for revision", sub: sessionSub(sid), submitLabel: "Send back", danger: true,
    body: `<div class="form-grid">
      <label>Worker</label><select name="slot">${agentOptions(preferred)}</select>
      <label>Feedback</label><textarea name="feedback" rows="6" autofocus placeholder="What must change before you approve?"></textarea>
    </div><div class="field-hint" style="margin-top:8px">Delivered as actionable feedback from you; the agent moves to <b>addressing feedback</b> and the review loop runs again.</div>`,
    onSubmit: async (form) => {
      const feedback = form.feedback.value.trim();
      if (!feedback) throw new Error("Write the feedback first");
      const r = await api("agents/feedback", { session_id: sid, slot_id: parseInt(form.slot.value, 10), feedback });
      toast(r?.message ?? "Sent back", "ok");
    },
  });
}

let agentAvailability = null;
async function loadAvailability() {
  if (agentAvailability) return agentAvailability;
  try { agentAvailability = await api("agents/available"); } catch { agentAvailability = {}; }
  return agentAvailability;
}

function typeOptions(selected, avail) {
  return ["claude", "codex", "gemini"].map((t) =>
    `<option value="${t}" ${t === selected ? "selected" : ""}>${t}${avail && avail[t] === false ? " (not installed)" : ""}</option>`).join("");
}

async function addAgentModal(sid) {
  const avail = await loadAvailability();
  const def = ["claude", "codex", "gemini"].find((t) => avail[t] !== false) ?? "claude";
  openModal({
    title: "Add agent", sub: sessionSub(sid), submitLabel: "Launch Agent",
    body: `<div class="form-grid">
      <label>Agent type</label><select name="type">${typeOptions(def, avail)}</select>
      <label>Name</label><input type="text" name="name" placeholder="e.g. Codex Reviewer" autofocus>
      <label>Role</label><input type="text" name="role" list="role-suggestions" placeholder="e.g. Code Reviewer">
      <label>Role description</label><textarea name="desc" rows="2" placeholder="Expertise, platform, constraints (optional)"></textarea>
      <label>Task / instruction</label><textarea name="task" rows="5" placeholder="What should this agent do first?"></textarea>
      <label>File ownership</label><input type="text" name="own" placeholder="optional: src/api/**, tests/**">
    </div>${roleDatalist()}
    <div class="field-hint" style="margin-top:8px">The agent runs under this dashboard (keep it open). Launching takes 15–60s before it connects.</div>`,
    onSubmit: async (form) => {
      const body = {
        session_id: sid, agent_type: form.type.value, name: form.name.value.trim(), role: form.role.value.trim(),
        role_description: form.desc.value.trim(), initial_task: form.task.value.trim(),
        file_ownership: form.own.value.split(",").map((p) => p.trim()).filter(Boolean),
      };
      if (!body.name || !body.role || !body.initial_task) throw new Error("Name, role and task are required");
      if (avail[body.agent_type] === false) throw new Error(`${body.agent_type} CLI is not installed on this machine`);
      const r = await api("agents/add", body);
      toast(r?.message ?? "Agent launched", "ok");
    },
  });
}

function newSessionModal() {
  openModal({
    title: "New empty session", submitLabel: "Create session",
    body: `<div class="form-grid">
      <label>Session name</label><input type="text" name="name" autofocus>
      <label>Project directory</label><input type="text" name="dir" placeholder="/absolute/path/to/project">
    </div><div class="field-hint" style="margin-top:8px">Like <span class="mono">multiagents session create</span>: writes .multiagents/session.json into the directory. Add agents afterwards, or use <b>New Team</b> to launch a whole team.</div>`,
    onSubmit: async (form) => {
      const r = await api("session/create", { name: form.name.value.trim(), project_dir: form.dir.value.trim() });
      toast(`Session "${r?.id}" created`, "ok");
    },
  });
}

const TEAM_PRESETS = {
  "Worker + Reviewer": [
    { agent_type: "gemini", name: "Gemini Worker", role: "Software Engineer", initial_task: "" },
    { agent_type: "claude", name: "Claude Reviewer", role: "Code Reviewer", initial_task: "" },
  ],
  "Engineer + Reviewer + QA": [
    { agent_type: "claude", name: "Engineer", role: "Software Engineer", initial_task: "" },
    { agent_type: "codex", name: "Reviewer", role: "Code Reviewer", initial_task: "" },
    { agent_type: "gemini", name: "QA", role: "QA Engineer", initial_task: "" },
  ],
};

async function newTeamModal() {
  const avail = await loadAvailability();
  const fallback = ["claude", "codex", "gemini"].find((t) => avail[t] !== false) ?? "claude";
  const pick = (t) => (avail[t] === false ? fallback : t);
  const agentRow = (a) => `<div class="team-agent">
    <div class="team-agent-row">
      <select data-f="agent_type">${typeOptions(pick(a.agent_type), avail)}</select>
      <input type="text" data-f="name" placeholder="Name" value="${esc(a.name)}">
      <input type="text" data-f="role" list="role-suggestions" placeholder="Role" value="${esc(a.role)}">
      <button type="button" class="icon-btn" data-remove-agent title="Remove">&#10005;</button>
    </div>
    <textarea data-f="initial_task" rows="2" placeholder="Agent-specific task (optional — the team goal is shared with everyone)">${esc(a.initial_task)}</textarea>
  </div>`;
  openModal({
    title: "New team", submitLabel: "Start Team", wide: true,
    body: `<div class="section-label">Project</div>
      <div class="form-grid">
        <label>Working directory</label><input type="text" name="dir" placeholder="/absolute/path/to/project (created if missing)" autofocus>
        <label>Session name</label><input type="text" name="name" placeholder="e.g. 食物过敏论文 / Manuscript Revision">
        <label>Team goal / prompt</label><textarea name="goal" rows="4" placeholder="What should the team achieve?"></textarea>
      </div>
      <div class="section-label">Agents ${Object.keys(TEAM_PRESETS).map((p) => `<button type="button" class="btn small" data-preset="${esc(p)}">${esc(p)}</button>`).join("")}</div>
      <div data-agents>${TEAM_PRESETS["Worker + Reviewer"].map(agentRow).join("")}</div>
      <button type="button" class="btn small" data-add-agent>+ Add agent</button>
      <div class="section-label">Plan (optional)</div>
      <textarea name="plan" rows="3" style="width:100%" placeholder="One task per line. Prefix with an agent name and a colon to assign it, e.g. &quot;Claude Reviewer: Review the API&quot;"></textarea>
      <div class="section-label">Workflow</div>
      <label class="checkbox"><input type="checkbox" name="wf_approval" checked><span>Require reviewer approval<small>Work counts as finished only after an explicit approve.</small></span></label>
      <label class="checkbox" style="margin-top:6px"><input type="checkbox" name="wf_feedback" checked><span>Require actionable feedback before revision<small>Reviewers must say concretely what to change.</small></span></label>
      <label class="checkbox" style="margin-top:6px"><input type="checkbox" name="wf_human" checked><span>Pause for human approval before release<small>Human gate: once everything is approved the session waits for you (Approve &amp; Release / Send back) instead of ending itself.</small></span></label>
      ${roleDatalist()}`,
    setup: (form) => {
      const list = form.querySelector("[data-agents]");
      form.querySelector("[data-add-agent]").addEventListener("click", () => list.insertAdjacentHTML("beforeend", agentRow({ agent_type: fallback, name: "", role: "", initial_task: "" })));
      list.addEventListener("click", (e) => { if (e.target.closest("[data-remove-agent]")) e.target.closest(".team-agent").remove(); });
      form.querySelectorAll("[data-preset]").forEach((b) => b.addEventListener("click", () => { list.innerHTML = TEAM_PRESETS[b.dataset.preset].map(agentRow).join(""); }));
    },
    onSubmit: async (form) => {
      const agents = [...form.querySelectorAll(".team-agent")].map((row) => {
        const a = {};
        row.querySelectorAll("[data-f]").forEach((f) => { a[f.dataset.f] = f.value.trim(); });
        return a;
      });
      if (!agents.length) throw new Error("Add at least one agent");
      if (agents.some((a) => !a.name || !a.role)) throw new Error("Every agent needs a name and a role");
      const unavailable = agents.filter((a) => avail[a.agent_type] === false).map((a) => `${a.name} (${a.agent_type})`);
      if (unavailable.length) throw new Error(`Not installed on this machine: ${unavailable.join(", ")}`);
      const names = agents.map((a) => a.name.toLowerCase());
      const plan = form.plan.value.split("\n").map((l) => l.trim()).filter(Boolean).map((line) => {
        const m = line.match(/^([^:：]{1,60})[:：]\s*(.+)$/);
        return m && names.includes(m[1].trim().toLowerCase())
          ? { label: m[2], agent_name: agents[names.indexOf(m[1].trim().toLowerCase())].name }
          : { label: line };
      });
      const body = {
        project_dir: form.dir.value.trim(), session_name: form.name.value.trim(), goal: form.goal.value.trim(), agents, plan,
        workflow: { require_reviewer_approval: form.wf_approval.checked, require_actionable_feedback: form.wf_feedback.checked, human_release: form.wf_human.checked },
      };
      if (!body.project_dir || !body.session_name) throw new Error("Working directory and session name are required");
      toast("Starting team — agents take 15–60s to connect…", "info");
      const r = await api("team/create", body);
      toast(`Team started: ${r?.data?.session_id ?? body.session_name}`, "ok");
    },
  });
}

// --- Broker info ---

$("broker-pill").addEventListener("click", async () => {
  let info;
  try { info = await api("broker"); } catch (e) { return toast(`Broker status failed: ${e.message}`, "error"); }
  openModal({
    title: "Broker", submitLabel: "Close",
    body: `<div class="form-grid">
      <label>Status</label><span>${info.alive ? '<span style="color:var(--green)">&#9679; running</span>' : '<span style="color:var(--red)">&#9679; not running</span>'}</span>
      <label>URL</label><span class="mono">${esc(info.url)}</span>
      <label>Sessions</label><span>${info.sessions} (${info.active_sessions} active)</span>
      <label>Peers</label><span>${info.peers} registered</span>
      <label>Current session</label><span class="mono">${esc(info.current_session ?? "—")}</span>
      <label>This dashboard runs</label><span>${(state?.managedSlots ?? []).length} agent(s) of the current session</span>
    </div><div class="field-hint" style="margin-top:10px">Stop the broker from a terminal with <span class="mono">multiagents kill-broker</span> — it disconnects every agent on the machine.</div>`,
    onSubmit: () => {},
  });
});

// --- Helpers ---

function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + "…" : s; }
function baseName(p) { return String(p ?? "").replace(/\/+$/, "").split("/").pop(); }
function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
function fmtBytes(n) {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}
function fmtDuration(ms) {
  const t = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; }
}
function fmtDay(t) {
  const d = new Date(t), today = new Date();
  const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
}
function timeSince(epoch) {
  if (!epoch) return "";
  const s = Math.round((Date.now() - epoch) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// --- Session picker ---

let pickerFocusIdx = 0;
let pickerFiltered = [];

function openPicker() {
  $("picker-overlay").classList.add("open");
  $("picker-search").value = "";
  $("picker-search").focus();
  renderPicker();
}

function closePicker() { $("picker-overlay").classList.remove("open"); }

function renderPicker() {
  const search = $("picker-search").value.toLowerCase();
  pickerFiltered = sortedSessions(state?.sessions).filter((s) => !search || s.name?.toLowerCase().includes(search) || s.id.toLowerCase().includes(search));
  pickerFocusIdx = Math.min(pickerFocusIdx, Math.max(0, pickerFiltered.length - 1));
  const list = $("picker-list");
  if (!pickerFiltered.length) { list.innerHTML = '<div class="picker-empty">No sessions found</div>'; return; }
  list.innerHTML = pickerFiltered.map((s, i) => `<div class="picker-item${i === pickerFocusIdx ? " focused" : ""}${state?.sessionId === s.id ? " active" : ""}" data-idx="${i}">
      ${statusDot(s.status)}
      <span class="picker-item-name">${esc(s.name || s.id)}</span>
      <span class="picker-item-id">${esc(s.status)}</span>
      <span class="picker-item-time">${timeSince(s.last_active_at ?? s.created_at)}</span>
    </div>`).join("");
  list.querySelector(".focused")?.scrollIntoView({ block: "nearest" });
}

async function selectSession(id) {
  closePicker();
  try {
    const res = await fetch("/api/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: id }) });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
  } catch (e) {
    toast(`Switching session failed: ${e.message}`, "error");
  }
}

$("session-name").addEventListener("click", openPicker);
$("picker-overlay").addEventListener("click", (e) => { if (e.target.id === "picker-overlay") closePicker(); });
$("modal-overlay").addEventListener("mousedown", (e) => { if (e.target.id === "modal-overlay") closeModal(); });
$("picker-search").addEventListener("input", () => { pickerFocusIdx = 0; renderPicker(); });
$("picker-list").addEventListener("click", (e) => {
  const item = e.target.closest(".picker-item");
  if (item) selectSession(pickerFiltered[parseInt(item.dataset.idx, 10)].id);
});
$("picker-search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closePicker(); e.preventDefault(); return; }
  if (e.key === "ArrowDown") { pickerFocusIdx = Math.min(pickerFocusIdx + 1, pickerFiltered.length - 1); renderPicker(); e.preventDefault(); return; }
  if (e.key === "ArrowUp") { pickerFocusIdx = Math.max(pickerFocusIdx - 1, 0); renderPicker(); e.preventDefault(); return; }
  if (e.key === "Enter" && pickerFiltered[pickerFocusIdx] && !e.isComposing) { selectSession(pickerFiltered[pickerFocusIdx].id); e.preventDefault(); }
});

// --- Boot ---

applyTheme();
applyLayout();
$("msg-show-system").checked = store.get("ma-show-system", false);
switchRightTab(store.get("ma-rtab", "preview"));
{ const t = store.get("ma-tab", "chat"); if (TABS.includes(t) && t !== "chat") switchTab(t); }
closePreview();
renderTree();
connectWs();
