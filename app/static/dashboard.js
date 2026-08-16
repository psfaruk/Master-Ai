// Master-Ai dashboard client — mobile-first, real-time, bottom-nav.
//
// Adaptive polling mirrors the server's snapshot_poller:
//   - burst (1s) for the first 12s of each candle (new signals arriving)
//   - idle  (3s) for the rest of the minute
// The user can override this in Settings.
//
// Settings are persisted to localStorage. The server is stateless — all
// preferences live client-side.

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ====== Default settings (must come before `state` because `loadSettings()`
// ====== is called from inside `state`'s initializer — JS const TDZ would
// ====== otherwise throw "Cannot access DEFAULT_SETTINGS before initialization".)
const DEFAULT_SETTINGS = {
  theme: "dark",
  lang: "en",
  tz: "both",
  timeFmt: "24",
  poll: "adaptive",
  feedSize: "50",
  sound: false,
  notify: false,
  minWr: "0",
  onlyFresh: "0",
  hideConflicts: false,
  app1Offset: "0",
  app2Offset: "0",
  app3Offset: "0",
};

function loadSettings() {
  try {
    const raw = localStorage.getItem("master-ai:settings");
    return Object.assign({}, DEFAULT_SETTINGS, raw ? JSON.parse(raw) : {});
  } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}

function loadFavorites() {
  try {
    const raw = localStorage.getItem("master-ai:favorites");
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (e) { return new Set(); }
}

// ====== State ======
const state = {
  activeTab: "home",
  activeHistorySubtab: "backtest",
  snapshot: null,
  snapshotAt: 0,
  backtestStatus: null,
  pairDetailCache: new Map(),  // pair → { fetchedAt, data }
  signalFeedIds: new Set(),    // for "new" highlight
  favorites: loadFavorites(),
  settings: loadSettings(),
  clockTimer: null,
  lastPollAt: 0,
  drawerPair: null,
  healthAlertDismissed: false,
};

const FEED_LIMIT = () => parseInt(state.settings.feedSize, 10) || 50;

// ====== Settings persistence (DEFAULT_SETTINGS / loadSettings / loadFavorites
// ====== declared above, before `state`, to avoid JS const TDZ). ======

function saveSettings() {
  try { localStorage.setItem("master-ai:settings", JSON.stringify(state.settings)); } catch (e) {}
}

function saveFavorites() {
  try { localStorage.setItem("master-ai:favorites", JSON.stringify(Array.from(state.favorites))); } catch (e) {}
}

// ====== Apply settings to DOM ======
function applySettings() {
  document.body.dataset.theme = state.settings.theme;
  document.body.dataset.tz = state.settings.tz;
  document.body.dataset.lang = state.settings.lang;
  // Show/hide clock blocks
  const showUtc = state.settings.tz === "utc" || state.settings.tz === "both";
  const showLocal = state.settings.tz === "local" || state.settings.tz === "both";
  $("clock-utc").style.display = showUtc ? "" : "none";
  $("clock-local").style.display = showLocal ? "" : "none";
  // Populate settings inputs
  $("set-theme").value = state.settings.theme;
  $("set-lang").value = state.settings.lang;
  $("set-tz").value = state.settings.tz;
  $("set-timefmt").value = state.settings.timeFmt;
  $("set-poll").value = state.settings.poll;
  $("set-feed-size").value = state.settings.feedSize;
  $("set-sound").checked = state.settings.sound;
  $("set-notify").checked = state.settings.notify;
  $("set-min-wr").value = state.settings.minWr;
  $("set-only-fresh").value = state.settings.onlyFresh;
  $("set-hide-conflicts").checked = state.settings.hideConflicts;
  $("set-off1").value = state.settings.app1Offset;
  $("set-off2").value = state.settings.app2Offset;
  $("set-off3").value = state.settings.app3Offset;
  renderFavorites();
}

// ====== Bottom nav + tab switching ======
$$(".bottomnav__item").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});
// Top bar brand — click to go Home. Uses querySelector (class selector)
// because $() is an ID shortcut.
const brandEl = document.querySelector(".topbar__brand");
if (brandEl) {
  brandEl.addEventListener("click", () => switchTab("home"));
  brandEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); switchTab("home"); }
  });
}

function switchTab(name) {
  state.activeTab = name;
  $$(".bottomnav__item").forEach((b) => b.classList.toggle("bottomnav__item--active", b.dataset.tab === name));
  $$(".tab-panel").forEach((p) => p.classList.toggle("tab-panel--active", p.id === `tab-${name}`));
  if (name === "signals") renderPairTable();
  if (name === "home") refreshBacktestStatus();
  if (name === "history") {
    resetFolderView("history-folder-grid", "history-folder-detail");
    populateHistoryPairSelector();
    renderPerPairTable();
    refreshBacktestStatus();
  }
  if (name === "settings") resetFolderView("settings-folder-grid", "settings-folder-detail");
  window.scrollTo(0, 0);
}

// ====== Folder-menu navigation (History / Settings) ======
// Each section shows a grid of tappable "folder" cards; tapping one opens
// its detail view (hiding the grid) and a back button returns to the grid.
function resetFolderView(gridId, detailId) {
  const grid = $(gridId);
  const detail = $(detailId);
  if (grid) grid.hidden = false;
  if (detail) detail.hidden = true;
}

$$("#history-folder-grid .folder-card").forEach((card) => {
  card.addEventListener("click", () => {
    $("history-folder-grid").hidden = true;
    $("history-folder-detail").hidden = false;
    switchHistorySubtab(card.dataset.folder);
    window.scrollTo(0, 0);
  });
});
$("history-folder-back")?.addEventListener("click", () => {
  resetFolderView("history-folder-grid", "history-folder-detail");
  window.scrollTo(0, 0);
});

function switchHistorySubtab(name) {
  state.activeHistorySubtab = name;
  $$(".history-panel").forEach((p) => p.classList.toggle("history-panel--active", p.id === `history-${name}`));
  if (name === "perpair") renderPerPairTable();
  if (name === "apppair") renderAppPairLeaders();
  if (name === "drilldown") populateHistoryPairSelector();
}

$$("#settings-folder-grid .folder-card").forEach((card) => {
  card.addEventListener("click", () => {
    $("settings-folder-grid").hidden = true;
    $("settings-folder-detail").hidden = false;
    $$(".settings-panel").forEach((p) => p.classList.toggle("settings-panel--active", p.id === `settings-${card.dataset.folder}`));
    window.scrollTo(0, 0);
  });
});
$("settings-folder-back")?.addEventListener("click", () => {
  resetFolderView("settings-folder-grid", "settings-folder-detail");
  window.scrollTo(0, 0);
});

// ====== Dropdowns ======
function wireDropdown(triggerId, menuId, labelId, onSelect) {
  const trigger = $(triggerId);
  const menu = $(menuId);
  const label = $(labelId);
  if (!trigger || !menu) return;
  trigger.addEventListener("click", (e) => {
    e.stopPropagation();
    $$(".dropdown__menu").forEach((m) => { if (m !== menu) m.classList.remove("dropdown__menu--open"); });
    menu.classList.toggle("dropdown__menu--open");
  });
  menu.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    const value = li.dataset.value;
    if (label) label.textContent = li.textContent.trim();
    menu.querySelectorAll("li").forEach((l) => l.classList.toggle("is-selected", l === li));
    menu.classList.remove("dropdown__menu--open");
    onSelect(value);
  });
}
document.addEventListener("click", () => {
  $$(".dropdown__menu").forEach((m) => m.classList.remove("dropdown__menu--open"));
});

const filters = {
  category: "",
  level: "",
  direction: "",
  agreeCount: 0,
  app1Dir: "",
  app2Dir: "",
  app3Dir: "",
  wr60Min: 0,
  freshSec: 0,
  search: "",
  favoritesOnly: false,
};

// Sort state for the signals table (column → 'asc' | 'desc')
const signalsSort = { column: "agree", dir: "desc" };

wireDropdown("cat-trigger", "cat-menu", "cat-label", (v) => { filters.category = v; renderPairTable(); renderPerPairTable(); });
wireDropdown("cat-trigger2", "cat-menu2", "cat-label2", (v) => { filters.category = v; renderPairTable(); renderPerPairTable(); renderActiveFilterTags(); });
wireDropdown("level-trigger", "level-menu", "level-label", (v) => { filters.level = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("dir-trigger", "dir-menu", "dir-label", (v) => { filters.direction = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("agree-trigger", "agree-menu", "agree-label", (v) => { filters.agreeCount = parseInt(v, 10) || 0; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("app1-trigger", "app1-menu", "app1-label", (v) => { filters.app1Dir = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("app2-trigger", "app2-menu", "app2-label", (v) => { filters.app2Dir = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("app3-trigger", "app3-menu", "app3-label", (v) => { filters.app3Dir = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("wr60-trigger", "wr60-menu", "wr60-label", (v) => { filters.wr60Min = parseFloat(v) || 0; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("fresh-trigger", "fresh-menu", "fresh-label", (v) => { filters.freshSec = parseInt(v, 10) || 0; renderPairTable(); renderActiveFilterTags(); });

// Signals-tab pair search (separate from top-bar search)
$("filter-pair-sp")?.addEventListener("input", (e) => { filters.search = e.target.value; renderPairTable(); renderActiveFilterTags(); });
// Top-bar search also drives the signals filter (for convenience)
$("search-input").addEventListener("input", (e) => {
  filters.search = e.target.value;
  const sp = $("filter-pair-sp"); if (sp) sp.value = e.target.value;
  renderPairTable(); renderActiveFilterTags();
});
$("favorites-only").addEventListener("change", (e) => { filters.favoritesOnly = e.target.checked; renderPairTable(); renderActiveFilterTags(); });

// Sortable column headers — click to toggle sort
$$(".sp-th.sortable").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.sort;
    if (signalsSort.column === col) {
      signalsSort.dir = signalsSort.dir === "asc" ? "desc" : "asc";
    } else {
      signalsSort.column = col;
      signalsSort.dir = (col === "agree" || col === "wr60") ? "desc" : "asc";
    }
    renderPairTable();
  });
});

// Clear-all-filters button — reset everything and re-render
$("btn-clear-filters")?.addEventListener("click", () => {
  Object.assign(filters, {
    category: "", level: "", direction: "", agreeCount: 0,
    app1Dir: "", app2Dir: "", app3Dir: "", wr60Min: 0, freshSec: 0,
    search: "", favoritesOnly: false,
  });
  // Reset visible labels of all dropdowns
  const resets = [
    ["cat-label2", "All"], ["level-label", "All"],
    ["dir-label", "All"], ["agree-label", "Any"],
    ["app1-label", "All"], ["app2-label", "All"], ["app3-label", "All"],
    ["wr60-label", "Any"], ["fresh-label", "Any"],
  ];
  resets.forEach(([id, txt]) => { const el = $(id); if (el) el.textContent = txt; });
  // Reset search inputs + checkbox
  const sp = $("filter-pair-sp"); if (sp) sp.value = "";
  const searchInput = $("search-input"); if (searchInput) searchInput.value = "";
  const favOnly = $("favorites-only"); if (favOnly) favOnly.checked = false;
  renderPairTable();
  renderActiveFilterTags();
});

// ====== Adaptive polling ======
function nextPollGapMs() {
  if (state.settings.poll !== "adaptive") {
    return parseInt(state.settings.poll, 10) * 1000;
  }
  const secIntoCandle = Math.floor(Date.now() / 1000) % 60;
  return secIntoCandle < 12 ? 1000 : 3000;
}

async function pollSnapshot() {
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (res.status === 503) {
      setStatus("stale", "first poll running…");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.snapshot = data;
    state.snapshotAt = Date.now();
    state.lastPollAt = Date.now();
    setStatus("ok", `updated ${Math.max(0, Math.round(data.ageMs / 1000))}s ago`);
    render();
  } catch (e) {
    setStatus("down", `error: ${e.message}`);
  }
}

async function pollSignalFeed() {
  if (state.activeTab !== "home" && state.activeTab !== "signals") return;
  try {
    const res = await fetch(`/api/signal-feed?limit=${FEED_LIMIT()}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    renderSignalFeed(data.items, state.activeTab === "home" ? "home-signal-feed" : null);
  } catch (e) {}
}

function setStatus(kind, text) {
  const pill = $("status-pill");
  pill.classList.remove("is-down", "is-stale");
  if (kind === "down") pill.classList.add("is-down");
  else if (kind === "stale") pill.classList.add("is-stale");
  $("status-text").textContent = text;
}

// ====== Master render ======
function render() {
  if (!state.snapshot) return;
  renderHealthAlert(state.snapshot.apps);
  renderHeroStats(state.snapshot.summary);
  renderAppCards(state.snapshot.apps);
  renderConsensusHighlights(state.snapshot.pairs);
  renderPairTable();
  renderBacktestStatus();
  // Signal feed is polled separately for finer cadence.
}

// ====== App health alert bar ======
// Shows a prominent warning at the top of the content area when any of the
// 3 source apps is in a bad state (token_expired / disconnected / down).
// Helps the user understand WHY a column might be empty — it's an upstream
// auth/connection issue, not a bug in the dashboard.
function renderHealthAlert(apps) {
  const alertEl = $("app-health-alert");
  const msgEl = $("app-health-msg");
  if (!alertEl || !msgEl) return;

  // If the user dismissed it this session, don't show again until a
  // different app goes bad.
  if (state.healthAlertDismissed) {
    // Re-show only if a NEW app went bad since dismissal.
    const stillBad = apps.some((a) => _isAppUnhealthy(a));
    if (!stillBad) state.healthAlertDismissed = false;
    if (state.healthAlertDismissed) { alertEl.hidden = true; return; }
  }

  const badApps = apps.filter((a) => _isAppUnhealthy(a));
  if (badApps.length === 0) {
    alertEl.hidden = true;
    state.healthAlertDismissed = false;
    return;
  }

  const parts = badApps.map((a) => {
    const status = a.health || "down";
    return `<span class="alert-app-name">${escHtml(a.name)}</span>` +
           `<span class="alert-app-status alert-app-status--${status}">${escHtml(status.replace("_", " "))}</span>` +
           (a.detail ? ` <span style="color:var(--text-dim)">(${escHtml(a.detail)})</span>` : "");
  });
  const fixHints = badApps.map((a) => {
    if (a.health === "token_expired") {
      return `<strong>${escHtml(a.name)}</strong>: Quotex session token has expired. The app is online but NOT connected to Quotex — it can only serve cached history, no live signals. Fix: log in to Quotex in the source app's browser, or set a fresh <code>QUOTEX_SESSION_TOKEN</code> / <code>QUOTEX_USER_TOKEN</code> env var on Railway and redeploy.`;
    }
    if (a.health === "disconnected") {
      return `<strong>${escHtml(a.name)}</strong>: the app is running but not connected to its signal source. Fix: check the source app's logs on Railway — the Quotex WebSocket may have dropped.`;
    }
    if (a.health === "down") {
      return `<strong>${escHtml(a.name)}</strong>: the app is not responding. Fix: check Railway — the service may be sleeping, crashed, or out of memory.`;
    }
    return `<strong>${escHtml(a.name)}</strong>: health = ${escHtml(a.health || "unknown")}.`;
  });

  msgEl.innerHTML = parts.join(" · ") +
    `<span class="alert-fix">${fixHints.join("<br>")}</span>`;
  alertEl.hidden = false;
}

function _isAppUnhealthy(a) {
  const h = a.health || "unknown";
  return h === "token_expired" || h === "disconnected" || h === "down";
}

// ====== Hero stats ======
function renderHeroStats(summary) {
  $("stat-3agree").textContent = summary.threeBotAgree.length;
  $("stat-2agree").textContent = summary.twoBotAgree.length;
  $("stat-conflict").textContent = summary.conflicts.length;
  $("stat-single").textContent = summary.singleOnly.length;
  const now = new Date(state.snapshot.timestamp);
  $("stat-3agree-sub").textContent = fmtTime(now, false);
  $("stat-2agree-sub").textContent = fmtTime(now, false);
}

// ====== App status cards ======
function renderAppCards(apps) {
  const container = $("app-cards");
  container.innerHTML = apps.map((a) => {
    const accent = a.id === "app1" ? "amber" : a.id === "app2" ? "violet" : "emerald";
    const healthCls = a.health ? `card__health--${a.health}` : "card__health--unknown";
    const latency = a.latencyMs != null ? `${a.latencyMs}ms` : "—";
    const uptime = a.uptimeSec != null ? fmtUptime(a.uptimeSec) : null;
    return `
      <div class="card">
        <div class="card__header">
          <span class="card__title">${a.name}</span>
          <span class="card__accent card__accent--${accent}"></span>
        </div>
        <div class="card__metric">${a.signalCount} <span>signals</span></div>
        <div class="card__detail">${a.detail || a.health || "—"}</div>
        <div class="card__latency">latency ${latency}${uptime ? ` · up ${uptime}` : ""}${a.activeStreams != null ? ` · ${a.activeStreams} streams` : ""}</div>
        <div style="margin-top:8px;">
          <span class="card__health ${healthCls}">${a.health || "unknown"}</span>
        </div>
      </div>`;
  }).join("");
}

function fmtUptime(sec) {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return `${Math.floor(sec / 86400)}d`;
}

// ====== Consensus highlights (top signals on Home) ======
function renderConsensusHighlights(pairs) {
  const container = $("consensus-highlights");
  let highlights = pairs.filter((p) => ["3-agree", "2-agree"].includes(p.consensus.level));
  if (state.settings.hideConflicts) highlights = highlights.filter((p) => p.consensus.level !== "conflict");
  highlights = highlights.slice(0, 8);
  if (highlights.length === 0) {
    container.innerHTML = '<p class="placeholder">No 2-bot or 3-bot agreements right now.</p>';
    return;
  }
  container.innerHTML = `<div class="highlight-list">${highlights.map((p) => {
    const dir = p.consensus.direction || "NEUTRAL";
    const wr = p.winRate != null ? `${p.winRate.toFixed(1)}%` : "—";
    const apps = (p.latestCandle?.signals || []).map((s) => s.source).join(", ") || "—";
    return `
      <div class="highlight highlight--${p.consensus.level}" data-pair="${escAttr(p.pair)}">
        <div>
          <div class="highlight__pair">${escHtml(p.displayPair)}</div>
          <div class="highlight__meta">${p.consensus.level} · ${apps}</div>
          <div class="highlight__wr">win rate: ${wr} · ${p.gradedTotal || 0} graded</div>
        </div>
        <span class="highlight__direction highlight__direction--${dir}">${dir}</span>
      </div>`;
  }).join("")}</div>`;
  $$("#consensus-highlights .highlight").forEach((el) => {
    el.addEventListener("click", () => openPairDrawer(el.dataset.pair));
  });
  $("home-meta").textContent = `${pairs.length} pairs · ${fmtTime(new Date(state.snapshot.timestamp), false)}`;
}

// ====== Per-pair table (Signals tab — SignalPro design) ======
// State for which rows are expanded.
const expandedPairs = new Set();

function renderPairTable() {
  if (!state.snapshot) return;
  const body = $("pair-table-body");
  let pairs = state.snapshot.pairs || [];

  // ---- Client-side filters (mirrors backend /api/pairs filters) ----
  if (filters.category) pairs = pairs.filter((p) => p.category === filters.category);
  if (filters.level) pairs = pairs.filter((p) => p.consensus.level === filters.level);
  if (filters.direction) pairs = pairs.filter((p) => (p.consensus.direction || "") === filters.direction);
  if (filters.search) pairs = pairs.filter((p) => p.displayPair.toLowerCase().includes(filters.search.toLowerCase()));
  if (filters.favoritesOnly) pairs = pairs.filter((p) => state.favorites.has(p.pair));
  if (state.settings.hideConflicts) pairs = pairs.filter((p) => p.consensus.level !== "conflict");
  const minWr = parseFloat(state.settings.minWr) || 0;
  if (minWr > 0) pairs = pairs.filter((p) => p.winRate != null && p.winRate >= minWr);
  const onlyFresh = parseInt(state.settings.onlyFresh, 10) || 0;
  if (onlyFresh > 0) {
    const now = Math.floor(Date.now() / 1000);
    pairs = pairs.filter((p) => p.latestCandle && (now - p.latestCandle.candleTime) <= onlyFresh);
  }

  // ---- Per-app prediction extraction ----
  const rows = pairs.map((p) => {
    const lc = p.latestCandle;
    const sigByApp = { app1: null, app2: null, app3: null };
    if (lc) {
      for (const s of lc.signals) {
        if (s.source in sigByApp && sigByApp[s.source] === null) {
          sigByApp[s.source] = s;
        }
      }
    }
    const app1Dir = sigByApp.app1?.direction || null;
    const app2Dir = sigByApp.app2?.direction || null;
    const app3Dir = sigByApp.app3?.direction || null;
    const finalDir = p.consensus.direction || null;
    const agreeCount = finalDir
      ? [app1Dir, app2Dir, app3Dir].filter((d) => d === finalDir).length
      : 0;
    return {
      pair: p,
      lc,
      sigByApp,
      app1Dir, app2Dir, app3Dir,
      finalDir,
      agreeCount,
      candleTime: lc?.candleTime || 0,
      candleUtc: lc ? fmtHmUtc(lc.candleTime) : "—",
      winRate60Min: p.winRate60Min ?? null,
      gradedTotal60Min: p.gradedTotal60Min ?? 0,
      winRate: p.winRate ?? null,
    };
  });

  // ---- agreeCount filter ----
  if (filters.agreeCount > 0) {
    rows.splice(0, rows.length, ...rows.filter((r) => r.agreeCount >= filters.agreeCount));
  }
  // ---- per-app direction filters ----
  const matchApp = (dir, filter) => {
    if (!filter) return true;
    if (filter === "NONE") return dir === null;
    return dir === filter;
  };
  rows.splice(0, rows.length, ...rows.filter((r) =>
    matchApp(r.app1Dir, filters.app1Dir) &&
    matchApp(r.app2Dir, filters.app2Dir) &&
    matchApp(r.app3Dir, filters.app3Dir)
  ));
  // ---- freshness filter ----
  if (filters.freshSec > 0) {
    const now = Math.floor(Date.now() / 1000);
    rows.splice(0, rows.length, ...rows.filter((r) => r.candleTime > 0 && (now - r.candleTime) <= filters.freshSec));
  }
  // ---- 60-min win rate filter ----
  if (filters.wr60Min > 0) {
    rows.splice(0, rows.length, ...rows.filter((r) => r.winRate60Min != null && r.winRate60Min >= filters.wr60Min));
  }

  // ---- Render stat cards (summary of filtered rows) ----
  renderSignalStats(rows);

  // ---- Sort according to signalsSort ----
  const sortVal = (r) => {
    switch (signalsSort.column) {
      case "market": return r.pair.category;
      case "candle": return r.candleTime;
      case "pair": return r.pair.displayPair.toLowerCase();
      case "agree": return r.agreeCount;
      case "wr60": return r.winRate60Min ?? -1;
      default: return r.agreeCount;
    }
  };
  rows.sort((a, b) => {
    const av = sortVal(a);
    const bv = sortVal(b);
    let cmp;
    if (typeof av === "number" && typeof bv === "number") cmp = av - bv;
    else cmp = String(av).localeCompare(String(bv));
    return signalsSort.dir === "asc" ? cmp : -cmp;
  });

  // Update sort indicators on headers
  $$(".sp-th.sortable").forEach((th) => {
    th.classList.toggle("sorted", th.dataset.sort === signalsSort.column);
    const icon = th.querySelector(".sort-icon");
    if (icon) {
      icon.className = "fas sort-icon " + (th.dataset.sort === signalsSort.column
        ? (signalsSort.dir === "asc" ? "fa-sort-up" : "fa-sort-down")
        : "fa-sort");
    }
  });

  if (rows.length === 0) {
    body.innerHTML = `<tr><td colspan="11" class="sp-placeholder"><i class="fas fa-inbox" style="font-size:32px;display:block;margin-bottom:10px;opacity:0.3"></i>No pairs match the filter.</td></tr>`;
    $("sp-table-count").innerHTML = "<strong>0</strong> pairs";
    $("sp-table-meta").textContent = "cache —";
    return;
  }

  $("sp-table-count").innerHTML = `<strong>${rows.length}</strong> pairs`;
  $("sp-table-meta").textContent = `cache ${state.snapshot.backtestCacheAgeSec?.toFixed(0) ?? "—"}s`;

  // ---- Render rows + expandable detail rows ----
  const rowsHtml = rows.slice(0, 200).map((r) => {
    const p = r.pair;
    const isFav = state.favorites.has(p.pair);
    const isExpanded = expandedPairs.has(p.pair);

    // App prediction badges (highlight if matches final)
    const appBadge = (dir) => {
      if (!dir) return '<span class="sp-app-pred sp-app-pred--none">—</span>';
      const agree = dir === r.finalDir && r.agreeCount >= 2 ? " sp-app-pred--agree" : "";
      return `<span class="sp-app-pred sp-app-pred--${dir}${agree}">${dir}</span>`;
    };

    // Agree count — N/3 with colored dot
    const agreeCls = r.agreeCount >= 3 ? "3" : r.agreeCount === 2 ? "2" : r.agreeCount === 1 ? "1" : "0";
    const agreeBadge = `<span class="sp-agree-badge sp-agree-badge--${agreeCls}"><span class="sp-agree-badge__dot"></span>${r.agreeCount}/3</span>`;

    // Final prediction + entry time (combined cell)
    const finalCls = r.finalDir ? r.finalDir : "none";
    const finalIcon = r.finalDir === "CALL" ? '<i class="fas fa-arrow-up"></i>' : r.finalDir === "PUT" ? '<i class="fas fa-arrow-down"></i>' : "";
    const finalBadge = `<span class="sp-final-badge sp-final-badge--${finalCls}">${finalIcon} ${r.finalDir || "—"}</span>`;
    const entryTime = r.candleUtc;
    const finalCell = `<div class="sp-final-cell">${finalBadge}<span class="sp-entry-time"><i class="far fa-clock"></i> ${entryTime}</span></div>`;

    // 60-min win rate bar
    const wr60 = r.winRate60Min;
    const wr60Cls = wr60 == null ? "none" : wr60 >= 60 ? "high" : wr60 >= 45 ? "mid" : "low";
    const wr60Txt = wr60 == null ? "—" : `${wr60.toFixed(0)}%`;
    const wr60Bar = wr60 == null
      ? `<div class="sp-winrate-cell"><span class="sp-winrate-val sp-winrate-val--none">—</span></div>`
      : `<div class="sp-winrate-cell">
           <div class="sp-winrate-bar"><div class="sp-winrate-fill sp-winrate-fill--${wr60Cls}" style="width:${Math.min(100, wr60)}%"></div></div>
           <span class="sp-winrate-val sp-winrate-val--${wr60Cls}">${wr60Txt}</span>
         </div>`;

    const marketBadge = `<span class="sp-badge-market sp-badge-${p.category}">${p.category.toUpperCase()}</span>`;
    const candleBadge = `<span class="sp-badge-candle">${r.candleUtc}</span>`;

    const mainRow = `
      <tr data-pair="${escAttr(p.pair)}" class="${isExpanded ? "is-expanded" : ""}">
        <td class="td-fav fav ${isFav ? "is-fav" : ""}" data-fav="${escAttr(p.pair)}" data-label="★"><i class="fas fa-star"></i></td>
        <td data-label="Market">${marketBadge}</td>
        <td data-label="Candle">${candleBadge}</td>
        <td data-label="Pair"><span class="sp-pair-name">${escHtml(p.displayPair)}</span></td>
        <td data-label="App 1">${appBadge(r.app1Dir)}</td>
        <td data-label="App 2">${appBadge(r.app2Dir)}</td>
        <td data-label="App 3">${appBadge(r.app3Dir)}</td>
        <td data-label="Agree">${agreeBadge}</td>
        <td data-label="Final">${finalCell}</td>
        <td data-label="Win Rate">${wr60Bar}</td>
        <td class="td-expand" data-label="Expand"><span class="sp-row-toggle"><i class="fas fa-chevron-right"></i></span></td>
      </tr>`;

    const detailRow = isExpanded ? renderDetailRow(r) : "";
    return mainRow + detailRow;
  }).join("");

  body.innerHTML = rowsHtml;

  // ---- Wire row expand/collapse + fav click ----
  $$("#pair-table-body tr[data-pair]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".fav")) {
        const pair = e.target.closest(".fav").dataset.fav;
        toggleFavorite(pair);
        const favEl = e.target.closest(".fav");
        favEl.classList.toggle("is-fav");
        e.stopPropagation();
        return;
      }
      const pair = row.dataset.pair;
      if (expandedPairs.has(pair)) expandedPairs.delete(pair);
      else expandedPairs.add(pair);
      renderPairTable();
    });
  });
}

function renderSignalStats(rows) {
  const bar = $("sp-stats-bar");
  if (!bar) return;
  const total = rows.length;
  const threeAgree = rows.filter((r) => r.agreeCount >= 3).length;
  const twoAgree = rows.filter((r) => r.agreeCount === 2).length;
  const conflicts = rows.filter((r) => r.pair.consensus.level === "conflict").length;
  const callCount = rows.filter((r) => r.finalDir === "CALL").length;
  const putCount = rows.filter((r) => r.finalDir === "PUT").length;
  const withWr = rows.filter((r) => r.winRate60Min != null);
  const avgWr = withWr.length > 0
    ? (withWr.reduce((s, r) => s + r.winRate60Min, 0) / withWr.length).toFixed(0)
    : null;
  bar.innerHTML = `
    <div class="sp-stat-card">
      <div class="sp-stat-card__label"><i class="fas fa-layer-group"></i> Total Pairs</div>
      <div class="sp-stat-card__value cyan">${total}</div>
      <div class="sp-stat-card__sub">filtered</div>
    </div>
    <div class="sp-stat-card">
      <div class="sp-stat-card__label"><i class="fas fa-check-circle"></i> 3-Agree</div>
      <div class="sp-stat-card__value green">${threeAgree}</div>
      <div class="sp-stat-card__sub">all apps agree</div>
    </div>
    <div class="sp-stat-card">
      <div class="sp-stat-card__label"><i class="fas fa-check"></i> 2-Agree</div>
      <div class="sp-stat-card__value cyan">${twoAgree}</div>
      <div class="sp-stat-card__sub">two apps agree</div>
    </div>
    <div class="sp-stat-card">
      <div class="sp-stat-card__label"><i class="fas fa-exclamation-triangle"></i> Conflicts</div>
      <div class="sp-stat-card__value red">${conflicts}</div>
      <div class="sp-stat-card__sub">split direction</div>
    </div>
    <div class="sp-stat-card">
      <div class="sp-stat-card__label"><i class="fas fa-arrow-up"></i> CALL Signals</div>
      <div class="sp-stat-card__value green">${callCount}</div>
      <div class="sp-stat-card__sub">final = CALL</div>
    </div>
    <div class="sp-stat-card">
      <div class="sp-stat-card__label"><i class="fas fa-arrow-down"></i> PUT Signals</div>
      <div class="sp-stat-card__value red">${putCount}</div>
      <div class="sp-stat-card__sub">final = PUT</div>
    </div>
    <div class="sp-stat-card">
      <div class="sp-stat-card__label"><i class="fas fa-chart-line"></i> Avg Win Rate 60m</div>
      <div class="sp-stat-card__value ${avgWr == null ? "" : (avgWr >= 60 ? "green" : avgWr >= 45 ? "orange" : "red")}">${avgWr == null ? "—" : avgWr + "%"}</div>
      <div class="sp-stat-card__sub">${withWr.length} graded pairs</div>
    </div>
  `;
}

function renderActiveFilterTags() {
  const container = $("sp-active-filters");
  if (!container) return;
  const tags = [];
  if (filters.category) tags.push({ label: `Market: ${filters.category.toUpperCase()}`, clear: () => { filters.category = ""; const e = $("cat-label2"); if (e) e.textContent = "All"; } });
  if (filters.level) tags.push({ label: `Level: ${filters.level}`, clear: () => { filters.level = ""; const e = $("level-label"); if (e) e.textContent = "All"; } });
  if (filters.direction) tags.push({ label: `Final: ${filters.direction}`, clear: () => { filters.direction = ""; const e = $("dir-label"); if (e) e.textContent = "All"; } });
  if (filters.agreeCount > 0) tags.push({ label: `Agree ≥ ${filters.agreeCount}`, clear: () => { filters.agreeCount = 0; const e = $("agree-label"); if (e) e.textContent = "Any"; } });
  if (filters.app1Dir) tags.push({ label: `App 1: ${filters.app1Dir === "NONE" ? "missing" : filters.app1Dir}`, clear: () => { filters.app1Dir = ""; const e = $("app1-label"); if (e) e.textContent = "All"; } });
  if (filters.app2Dir) tags.push({ label: `App 2: ${filters.app2Dir === "NONE" ? "missing" : filters.app2Dir}`, clear: () => { filters.app2Dir = ""; const e = $("app2-label"); if (e) e.textContent = "All"; } });
  if (filters.app3Dir) tags.push({ label: `App 3: ${filters.app3Dir === "NONE" ? "missing" : filters.app3Dir}`, clear: () => { filters.app3Dir = ""; const e = $("app3-label"); if (e) e.textContent = "All"; } });
  if (filters.wr60Min > 0) tags.push({ label: `60m WR ≥ ${filters.wr60Min}%`, clear: () => { filters.wr60Min = 0; const e = $("wr60-label"); if (e) e.textContent = "Any"; } });
  if (filters.freshSec > 0) tags.push({ label: `Fresh ≤ ${filters.freshSec}s`, clear: () => { filters.freshSec = 0; const e = $("fresh-label"); if (e) e.textContent = "Any"; } });
  if (filters.search) tags.push({ label: `Pair: "${filters.search}"`, clear: () => { filters.search = ""; const a = $("filter-pair-sp"); if (a) a.value = ""; const b = $("search-input"); if (b) b.value = ""; } });
  if (filters.favoritesOnly) tags.push({ label: `★ Favorites only`, clear: () => { filters.favoritesOnly = false; const e = $("favorites-only"); if (e) e.checked = false; } });
  if (tags.length === 0) { container.innerHTML = ""; return; }
  container.innerHTML = tags.map((t, i) =>
    `<span class="sp-active-tag">${escHtml(t.label)} <span class="sp-tag-remove" data-idx="${i}"><i class="fas fa-times"></i></span></span>`
  ).join("");
  $$(".sp-tag-remove", container).forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const idx = parseInt(el.dataset.idx, 10);
      tags[idx].clear();
      renderPairTable();
      renderActiveFilterTags();
    });
  });
}

function renderDetailRow(r) {
  const p = r.pair;
  const signals = ["app1", "app2", "app3"].map((appId) => {
    const s = r.sigByApp[appId];
    if (!s) {
      return `
        <div class="sp-detail-signal">
          <span class="sp-detail-signal__app">${appId}</span>
          <span class="sp-detail-signal__dir">—</span>
          <span class="sp-detail-signal__time">no signal</span>
          <span class="sp-detail-signal__meta"></span>
          <span class="sp-detail-signal__outcome sp-detail-signal__outcome--unknown">—</span>
        </div>`;
    }
    const outcomeTxt = s.outcome == null ? "—" : s.outcome ? "WIN" : "LOSS";
    const outcomeCls = s.outcome == null ? "unknown" : s.outcome ? "WIN" : "LOSS";
    const conf = s.confidence != null ? `${(s.confidence * 100).toFixed(0)}%` : "—";
    return `
      <div class="sp-detail-signal">
        <span class="sp-detail-signal__app">${escHtml(s.sourceName || appId)}</span>
        <span class="sp-detail-signal__dir"><span class="sp-app-pred sp-app-pred--${s.direction || "none"}">${s.direction || "—"}</span></span>
        <span class="sp-detail-signal__time">${s.emittedUtc || "—"}</span>
        <span class="sp-detail-signal__meta">conf ${conf} · ${s.strength || "—"}${s.leadSec != null ? ` · lead ${s.leadSec > 0 ? "+" : ""}${s.leadSec}s` : ""}</span>
        <span class="sp-detail-signal__outcome sp-detail-signal__outcome--${outcomeCls}">${outcomeTxt}</span>
      </div>`;
  }).join("");

  const ls = p.levelStats || {};
  const fmtLevel = (lvl) => {
    const s = ls[lvl];
    if (!s) return "—";
    return `${s.win || 0}/${s.loss || 0} (${s.winRate == null ? "—" : s.winRate.toFixed(0) + "%"})`;
  };

  // ---- Per-app-pair win rate (app1, app2, app3, app1+app2, app1+app3,
  //      app2+app3, app1+app2+app3) — answers "which pair of apps performs
  //      best on THIS pair?". Renders as a 4-column grid of cards.
  const aps = p.appPairStats || {};
  const fmtAppPair = (key, label) => {
    const s = aps[key];
    if (!s || (s.win + s.loss) === 0) {
      return `
        <div class="sp-app-pair-card">
          <div class="sp-app-pair-card__head"><span>${label}</span><span class="sp-app-pair-card__sub">0 graded</span></div>
          <div class="sp-app-pair-card__wr none">—</div>
        </div>`;
    }
    const graded = s.win + s.loss;
    const wr = s.winRate;
    const cls = wr == null ? "none" : wr >= 60 ? "high" : wr < 45 ? "low" : "";
    const wrTxt = wr == null ? "—" : `${wr.toFixed(0)}%`;
    return `
      <div class="sp-app-pair-card">
        <div class="sp-app-pair-card__head"><span>${label}</span><span class="sp-app-pair-card__sub">${graded} graded</span></div>
        <div class="sp-app-pair-card__wr ${cls}">${wrTxt}</div>
        <div class="sp-app-pair-card__sub">${s.win}W / ${s.loss}L${s.draw ? ` · ${s.draw} draw` : ""}</div>
      </div>`;
  };

  const appPairCards = [
    fmtAppPair("app1", "app1 only"),
    fmtAppPair("app2", "app2 only"),
    fmtAppPair("app3", "app3 only"),
    fmtAppPair("app1+app2", "app1 + app2"),
    fmtAppPair("app1+app3", "app1 + app3"),
    fmtAppPair("app2+app3", "app2 + app3"),
    fmtAppPair("app1+app2+app3", "all 3 agree"),
  ].join("");

  return `
    <tr class="sp-detail-row" data-pair-detail="${escAttr(p.pair)}">
      <td colspan="11">
        <div class="sp-detail-inner">
          <div class="sp-detail-section">
            <h4><i class="fas fa-satellite-dish"></i> Per-App Signal Breakdown (candle ${r.candleUtc} UTC)</h4>
            <div class="sp-detail-signals">${signals}</div>
          </div>
          <div class="sp-detail-section">
            <h4><i class="fas fa-chart-bar"></i> Win Rate (last 6 hours)</h4>
            <div class="sp-detail-signals">
              <div class="sp-detail-signal">
                <span class="sp-detail-signal__app">3-agree</span>
                <span class="sp-detail-signal__dir"></span>
                <span class="sp-detail-signal__time"></span>
                <span class="sp-detail-signal__meta">${fmtLevel("3-agree")}</span>
                <span class="sp-detail-signal__outcome sp-detail-signal__outcome--unknown">—</span>
              </div>
              <div class="sp-detail-signal">
                <span class="sp-detail-signal__app">2-agree</span>
                <span class="sp-detail-signal__dir"></span>
                <span class="sp-detail-signal__time"></span>
                <span class="sp-detail-signal__meta">${fmtLevel("2-agree")}</span>
                <span class="sp-detail-signal__outcome sp-detail-signal__outcome--unknown">—</span>
              </div>
              <div class="sp-detail-signal">
                <span class="sp-detail-signal__app">1-only</span>
                <span class="sp-detail-signal__dir"></span>
                <span class="sp-detail-signal__time"></span>
                <span class="sp-detail-signal__meta">${fmtLevel("1-only")}</span>
                <span class="sp-detail-signal__outcome sp-detail-signal__outcome--unknown">—</span>
              </div>
              <div class="sp-detail-signal">
                <span class="sp-detail-signal__app">60-min</span>
                <span class="sp-detail-signal__dir"></span>
                <span class="sp-detail-signal__time"></span>
                <span class="sp-detail-signal__meta">${r.winRate60Min == null ? "—" : r.winRate60Min.toFixed(0) + "%"} · ${r.gradedTotal60Min} graded</span>
                <span class="sp-detail-signal__outcome sp-detail-signal__outcome--unknown">—</span>
              </div>
            </div>
          </div>
          <div class="sp-detail-section">
            <h4><i class="fas fa-users"></i> Win Rate by App Pair (which pair of apps performs best on ${escHtml(p.displayPair)})</h4>
            <div class="sp-app-pair-grid">${appPairCards}</div>
          </div>
        </div>
      </td>
    </tr>`;
}

function classifyLead(leadSec, candleTime) {
  if (leadSec == null) return "live";
  if (leadSec < -65) return "look-ahead";
  if (leadSec > 0) return "prediction";
  const now = Math.floor(Date.now() / 1000);
  if (candleTime && (now - candleTime) > 120) return "stale";
  return "live";
}

// ====== Live signal feed ======
function renderSignalFeed(items, containerId) {
  if (!containerId) return;
  const container = $(containerId);
  if (!items || items.length === 0) {
    container.innerHTML = '<p class="placeholder">No signals yet.</p>';
    return;
  }
  const newIds = new Set();
  items.forEach((it) => {
    const id = `${it.pair}|${it.source}|${it.emittedAt}`;
    if (!state.signalFeedIds.has(id)) newIds.add(id);
  });
  state.signalFeedIds = new Set(items.map((it) => `${it.pair}|${it.source}|${it.emittedAt}`));

  container.innerHTML = `<div class="feed-list">${items.map((it) => {
    const dir = it.direction || "—";
    const dirCls = dir === "—" ? "null" : dir;
    const age = it.ageSec != null ? `${it.ageSec}s` : "—";
    const isNew = newIds.has(`${it.pair}|${it.source}|${it.emittedAt}`);
    return `
      <div class="feed-item feed-item--${dirCls} ${isNew ? "feed-item--new" : ""}" data-pair="${escAttr(it.pair)}">
        <span class="feed__time">${it.emittedUtc || "—"}</span>
        <div>
          <div class="feed__pair">${escHtml(it.displayPair)}</div>
          <div class="feed__source">${it.source} · ${it.consensusLevel}</div>
        </div>
        <span class="feed__dir feed__dir--${dirCls}">${dir}</span>
        <span class="feed__age">${age}</span>
      </div>`;
  }).join("")}</div>`;

  // Auto-play sound on new 3-agree signals
  if (state.settings.sound && newIds.size > 0) {
    const anyNew3agree = items.some((it) =>
      newIds.has(`${it.pair}|${it.source}|${it.emittedAt}`) && it.consensusLevel === "3-agree"
    );
    if (anyNew3agree) playBeep();
  }

  // Browser notifications
  if (state.settings.notify && "Notification" in window && Notification.permission === "granted") {
    items.forEach((it) => {
      const id = `${it.pair}|${it.source}|${it.emittedAt}`;
      if (newIds.has(id) && it.consensusLevel === "3-agree") {
        try {
          new Notification(`${it.displayPair} — 3-bot agree ${it.direction}`, {
            body: `Signal at ${it.emittedUtc} UTC, candle ${it.candleUtc} UTC`,
            silent: true,
          });
        } catch (e) {}
      }
    });
  }

  $$(".feed-item", container).forEach((el) => {
    el.addEventListener("click", () => openPairDrawer(el.dataset.pair));
  });
}

function playBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.3);
  } catch (e) {}
}

// ====== Backtest (cached + manual) ======
async function refreshBacktestStatus() {
  try {
    const res = await fetch("/api/backtest/status", { cache: "no-store" });
    const data = await res.json();
    state.backtestStatus = data;
    renderBacktestStatus();
    // Auto-render the cached backtest on the History tab if available.
    if (data.hasResult && state.activeTab === "history" && state.activeHistorySubtab === "backtest") {
      const cached = await fetch("/api/backtest", { cache: "no-store" });
      if (cached.ok) {
        const bt = await cached.json();
        renderBacktest(bt);
      }
    }
  } catch (e) {}
}

function renderBacktestStatus() {
  if (!state.backtestStatus) return;
  const s = state.backtestStatus;
  const age = s.cacheAgeSec >= 0 ? `cache ${s.cacheAgeSec.toFixed(0)}s old` : "no cache";
  $("backtest-status").textContent = `${age} · ${s.totalSignals || 0} signals · ${s.totalClusters || 0} clusters · ${s.perPairCount || 0} pairs`;
  const cacheAgeEl = $("bt-cache-age");
  if (cacheAgeEl) cacheAgeEl.textContent = age;
  renderHomeBacktestSummary(s);
}

// Populates the "Consensus Accuracy (last 6 hours)" panel on the Home tab.
function renderHomeBacktestSummary(s) {
  const el = $("home-backtest");
  if (!el) return;
  if (!s.hasResult) {
    el.innerHTML = '<p class="placeholder">Run a backtest to see per-level accuracy.</p>';
    return;
  }
  const v = s.verdict || {};
  el.innerHTML = `
    <div class="verdict verdict--${v.kind || "insufficient"}">${escHtml(v.message || "—")}</div>
    <p class="placeholder" style="margin-top:8px;font-size:11px;">
      ${s.totalSignals || 0} signals · ${s.totalClusters || 0} clusters · ${s.perPairCount || 0} pairs — see History → Backtest for the full breakdown.
    </p>`;
}

$("btn-run-backtest")?.addEventListener("click", runBacktest);

async function runBacktest() {
  const btn = $("btn-run-backtest");
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = "Running…";
  $("backtest-content").innerHTML = '<p class="placeholder">Fetching and grading signals across all 3 source apps…</p>';
  try {
    const res = await fetch("/api/backtest", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bt = await res.json();
    renderBacktest(bt);
    refreshBacktestStatus();
  } catch (e) {
    $("backtest-content").innerHTML = `<p class="placeholder">Backtest failed: ${e.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run fresh backtest";
  }
}

function renderBacktest(bt) {
  // Cache the result so the App Pair Leaders sub-tab can render from it
  // without an extra round-trip to /api/backtest.
  state.cachedBacktest = bt;

  const v = bt.verdict || {};
  const levelStats = Object.entries(bt.levels || {}).map(([level, s]) => {
    const total = s.win + s.loss;
    const winRate = total > 0 ? ((s.win / total) * 100).toFixed(1) : "—";
    const wrBarCls = winRate === "—" ? "none" : parseFloat(winRate) >= 60 ? "good" : parseFloat(winRate) >= 40 ? "mid" : "low";
    return `
      <div class="level-stat">
        <div class="level-stat__title">${level}</div>
        <div class="level-stat__row"><span>Total</span><strong>${s.total}</strong></div>
        <div class="level-stat__row"><span>Win / Loss</span><strong>${s.win} / ${s.loss}</strong></div>
        <div class="level-stat__row loss"><span>Win rate</span><span class="wr-bar wr-bar--${wrBarCls}">${winRate}%</span></div>
        <div class="level-stat__row"><span>Unknown</span><span>${s.unknown}</span></div>
        <div class="level-stat__row"><span>Draw</span><span>${s.draw}</span></div>
        <div class="level-stat__row"><span>CALL W/L</span><span>${s.callWin}/${s.callLoss}</span></div>
        <div class="level-stat__row"><span>PUT W/L</span><span>${s.putWin}/${s.putLoss}</span></div>
      </div>`;
  }).join("");

  const sourceStats = Object.entries(bt.sources || {}).map(([src, s]) => {
    const total = s.win + s.loss;
    const wr = total > 0 ? ((s.win / total) * 100).toFixed(1) : "—";
    return `
      <div class="level-stat">
        <div class="level-stat__title">${src}</div>
        <div class="level-stat__row"><span>Total</span><strong>${s.total}</strong></div>
        <div class="level-stat__row"><span>Win</span><strong>${s.win}</strong></div>
        <div class="level-stat__row loss"><span>Loss</span><strong>${s.loss}</strong></div>
        <div class="level-stat__row"><span>Win rate</span><span>${wr}%</span></div>
        <div class="level-stat__row"><span>Unknown</span><span>${s.unknown}</span></div>
        <div class="level-stat__row"><span>Draw</span><span>${s.draw}</span></div>
      </div>`;
  }).join("");

  // ---- App-pair global stats (the user's main "2 different win rates
  //      per pair of apps" view) — global aggregate per app subset, with
  //      a button to dive into the per-pair leaderboard sub-tab.
  const appPairGlobal = _aggregateAppPairGlobal(bt.perPair || []);
  const APP_SUBSET_LABELS = [
    { key: "app1", label: "App 1 only" },
    { key: "app2", label: "App 2 only" },
    { key: "app3", label: "App 3 only" },
    { key: "app1+app2", label: "App 1 + App 2" },
    { key: "app1+app3", label: "App 1 + App 3" },
    { key: "app2+app3", label: "App 2 + App 3" },
    { key: "app1+app2+app3", label: "All 3 agree" },
  ];
  const appPairCards = APP_SUBSET_LABELS.map(({ key, label }) => {
    const g = appPairGlobal[key] || { win: 0, loss: 0, gradedTotal: 0, winRate: null, draw: 0 };
    const wr = g.winRate;
    const wrCls = wr == null ? "none" : wr >= 60 ? "high" : wr < 45 ? "low" : "";
    const wrTxt = wr == null ? "—" : `${wr.toFixed(0)}%`;
    return `
      <div class="sp-app-pair-card">
        <div class="sp-app-pair-card__head"><span>${escHtml(label)}</span><span class="sp-app-pair-card__sub">${g.gradedTotal} graded</span></div>
        <div class="sp-app-pair-card__wr ${wrCls}">${wrTxt}</div>
        <div class="sp-app-pair-card__sub">${g.win}W / ${g.loss}L${g.draw ? ` · ${g.draw} draw` : ""}</div>
      </div>`;
  }).join("");

  $("backtest-content").innerHTML = `
    <div class="verdict verdict--${v.kind}">${v.message || "—"}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <h3 style="font-size:12px;">Per-level stats</h3>
      <span class="panel__meta">${bt.totalSignals} signals · ${bt.totalClusters} clusters</span>
    </div>
    <div class="level-stats">${levelStats}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;margin-top:18px;">
      <h3 style="font-size:12px;">Win rate by app pair (global)</h3>
      <span class="panel__meta"><button class="btn btn--ghost" id="btn-goto-apppair" style="padding:4px 10px;font-size:11px;">View per-pair leaders →</button></span>
    </div>
    <div class="sp-app-pair-grid">${appPairCards}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;margin-top:18px;">
      <h3 style="font-size:12px;">Per-source stats</h3>
    </div>
    <div class="level-stats">${sourceStats}</div>
  `;

  // Wire the "View per-pair leaders" button → switch to the App Pair Leaders sub-tab.
  $("btn-goto-apppair")?.addEventListener("click", () => {
    switchHistorySubtab("apppair");
  });
}

// ====== Per-pair table (History → Per-Pair Stats) ======
function renderPerPairTable() {
  if (!state.snapshot) return;
  const body = $("perpair-table-body");
  let pairs = state.snapshot.pairs || [];
  if (filters.category) pairs = pairs.filter((p) => p.category === filters.category);
  if (filters.search) pairs = pairs.filter((p) => p.displayPair.toLowerCase().includes(filters.search.toLowerCase()));

  pairs.sort((a, b) => (b.winRate ?? -1) - (a.winRate ?? -1));

  if (pairs.length === 0) {
    body.innerHTML = '<tr><td colspan="9" class="placeholder">No pairs.</td></tr>';
    return;
  }
  $("perpair-meta").textContent = `${pairs.length} pairs · cached ${state.snapshot.backtestCacheAgeSec?.toFixed(0) ?? "—"}s`;

  body.innerHTML = pairs.slice(0, 100).map((p) => {
    const ls = p.levelStats || {};
    const aps = p.appPairStats || {};
    // Format a per-app-pair stat cell: shows win/loss and a tiny win-rate badge.
    const fmtAP = (key) => {
      const s = aps[key];
      if (!s || (s.win + s.loss) === 0) return '<span class="mono" style="color:var(--text-muted)">—</span>';
      const wr = s.winRate;
      const wrCls = wr == null ? "none" : wr >= 60 ? "good" : wr >= 45 ? "mid" : "low";
      const wrTxt = wr == null ? "?" : `${wr.toFixed(0)}%`;
      return `<span class="mono"><strong>${s.win}/${s.loss}</strong> <span class="wr-bar wr-bar--${wrCls}" style="font-size:10px;padding:1px 5px">${wrTxt}</span></span>`;
    };
    const fmt = (lvl) => {
      const s = ls[lvl];
      if (!s) return "—";
      return `${s.win}/${s.loss}`;
    };
    const wr = p.winRate;
    const wrCls = wr == null ? "none" : wr >= 60 ? "good" : wr >= 40 ? "mid" : "low";
    const wrTxt = wr == null ? "—" : `${wr.toFixed(0)}%`;
    const totalW = (ls["3-agree"]?.win || 0) + (ls["2-agree"]?.win || 0) + (ls["1-only"]?.win || 0);
    const totalL = (ls["3-agree"]?.loss || 0) + (ls["2-agree"]?.loss || 0) + (ls["1-only"]?.loss || 0);
    const isFav = state.favorites.has(p.pair);
    return `
      <tr data-pair="${escAttr(p.pair)}">
        <td class="fav ${isFav ? "is-fav" : ""}" data-fav="${escAttr(p.pair)}" data-label="★">${isFav ? "★" : "☆"}</td>
        <td data-label="Pair"><strong>${escHtml(p.displayPair)}</strong></td>
        <td data-label="Cat"><span class="pill pill--${p.category}">${p.category}</span></td>
        <td data-label="Overall W/L" class="mono">${totalW}/${totalL}</td>
        <td data-label="Win %"><span class="wr-bar wr-bar--${wrCls}">${wrTxt}</span></td>
        <td data-label="app1+app2">${fmtAP("app1+app2")}</td>
        <td data-label="app1+app3">${fmtAP("app1+app3")}</td>
        <td data-label="app2+app3">${fmtAP("app2+app3")}</td>
        <td data-label="all-3">${fmtAP("app1+app2+app3")}</td>
      </tr>`;
  }).join("");

  $$("#perpair-table-body tr[data-pair]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.classList.contains("fav")) {
        const pair = e.target.dataset.fav;
        toggleFavorite(pair);
        e.target.classList.toggle("is-fav");
        e.target.textContent = state.favorites.has(pair) ? "★" : "☆";
        e.stopPropagation();
        return;
      }
      openPairDrawer(row.dataset.pair);
    });
  });
}

// ====== App Pair Leaders (History → App Pair Leaders sub-tab) ======
// For each canonical app-subset (singletons + 3 two-app pairs + all-3-agree),
// show the global aggregate win rate AND the top N pairs by win rate.
// Answers both:
//   - "Which pair of apps performs best globally?"
//   - "For each pair of apps, which pairs are they best on?"
async function renderAppPairLeaders() {
  const meta = $("apppair-meta");
  const content = $("apppair-content");
  if (!content) return;

  // Try to read from cached backtest first; fall back to fetching the
  // dedicated /api/app-pair-leaders endpoint if no cache.
  let payload = null;
  const cached = state.cachedBacktest;
  if (cached && cached.appPairLeaders) {
    payload = {
      appPairLeaders: cached.appPairLeaders,
      appPairGlobal: _aggregateAppPairGlobal(cached.perPair || []),
      cacheAgeSec: state.snapshot?.backtestCacheAgeSec ?? null,
      verdict: cached.verdict,
    };
  }
  if (!payload) {
    try {
      if (meta) meta.textContent = "loading…";
      const res = await fetch("/api/app-pair-leaders", { cache: "no-store" });
      if (res.ok) payload = await res.json();
    } catch (e) {
      console.warn("[app-pair-leaders] fetch failed", e);
    }
  }

  if (!payload) {
    content.innerHTML = '<p class="placeholder">No backtest data yet. Click "Run fresh backtest" on the Backtest sub-tab first.</p>';
    if (meta) meta.textContent = "—";
    return;
  }

  const leaders = payload.appPairLeaders || {};
  const global = payload.appPairGlobal || {};
  const verdict = payload.verdict;
  const ageSec = payload.cacheAgeSec;

  if (meta) {
    const verdictTxt = verdict ? `${verdict.kind}` : "—";
    meta.textContent = `cache ${ageSec != null ? ageSec.toFixed(0) + "s" : "—"} · verdict: ${verdictTxt}`;
  }

  const APP_SUBSET_LABELS = [
    { key: "app1", label: "App 1 only" },
    { key: "app2", label: "App 2 only" },
    { key: "app3", label: "App 3 only" },
    { key: "app1+app2", label: "App 1 + App 2" },
    { key: "app1+app3", label: "App 1 + App 3" },
    { key: "app2+app3", label: "App 2 + App 3" },
    { key: "app1+app2+app3", label: "All 3 agree" },
  ];

  const renderLeaderCol = ({ key, label }) => {
    const g = global[key] || { total: 0, win: 0, loss: 0, gradedTotal: 0, winRate: null };
    const wr = g.winRate;
    const wrCls = wr == null ? "" : wr >= 60 ? "high" : wr < 45 ? "low" : "";
    const wrTxt = wr == null ? "—" : `${wr.toFixed(0)}%`;
    const list = leaders[key] || [];
    const rows = list.length === 0
      ? '<div class="sp-app-pair-leader-row"><span class="sp-app-pair-leader-row__pair" style="color:var(--text-muted)">No qualified pairs yet (need ≥3 graded samples)</span></div>'
      : list.map((r) => {
          const rwr = r.winRate;
          const rwrCls = rwr == null ? "low" : rwr >= 60 ? "" : rwr >= 45 ? "mid" : "low";
          return `
            <div class="sp-app-pair-leader-row" data-pair="${escAttr(r.pair)}" data-display="${escAttr(r.displayPair)}">
              <span class="sp-app-pair-leader-row__pair">${escHtml(r.displayPair)}</span>
              <span class="sp-app-pair-leader-row__wr ${rwrCls}">${rwr == null ? "—" : rwr.toFixed(0) + "%"}</span>
              <span class="sp-app-pair-leader-row__meta">${r.wins}/${r.losses} · ${r.gradedTotal} graded</span>
            </div>`;
        }).join("");
    return `
      <div class="sp-app-pair-leader-col">
        <div class="sp-app-pair-leader-col__head">
          <span>${escHtml(label)}</span>
          <span class="sp-app-pair-leader-col__wr ${wrCls}">${wrTxt}</span>
        </div>
        <div class="sp-app-pair-leader-col__sub" style="font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',ui-monospace,monospace">
          ${g.win}W / ${g.loss}L · ${g.gradedTotal} graded${g.draw ? ` · ${g.draw} draw` : ""}
        </div>
        ${rows}
      </div>`;
  };

  content.innerHTML = `
    <div class="sp-app-pair-leaderboard">
      ${APP_SUBSET_LABELS.map(renderLeaderCol).join("")}
    </div>
    <p class="placeholder" style="margin-top:14px;font-size:11px">
      <i class="fas fa-info-circle"></i>
      Each column shows the top pairs by graded win rate for that app subset.
      A pair appears only when it has ≥3 graded signals in the backtest window.
      Tap a pair row to open the drilldown.
    </p>
  `;

  $$("#apppair-content .sp-app-pair-leader-row[data-pair]").forEach((row) => {
    row.addEventListener("click", () => {
      openPairDrawer(row.dataset.pair);
    });
    row.style.cursor = "pointer";
  });
}

// Helper: build the global aggregate per app-subset from perPair[].appPairStats.
// Used when we render from the cached snapshot instead of fetching the
// dedicated /api/app-pair-leaders endpoint.
function _aggregateAppPairGlobal(perPair) {
  const APP_SUBSET_KEYS = ["app1", "app2", "app3", "app1+app2", "app1+app3", "app2+app3", "app1+app2+app3"];
  const out = {};
  for (const key of APP_SUBSET_KEYS) {
    out[key] = { total: 0, win: 0, loss: 0, unknown: 0, draw: 0, gradedTotal: 0, winRate: null };
  }
  for (const p of perPair) {
    const aps = p.appPairStats || {};
    for (const key of Object.keys(aps)) {
      if (!out[key]) out[key] = { total: 0, win: 0, loss: 0, unknown: 0, draw: 0, gradedTotal: 0, winRate: null };
      const agg = out[key];
      const s = aps[key];
      agg.total += s.total || 0;
      agg.win += s.win || 0;
      agg.loss += s.loss || 0;
      agg.unknown += s.unknown || 0;
      agg.draw += s.draw || 0;
    }
  }
  for (const key of Object.keys(out)) {
    const agg = out[key];
    agg.gradedTotal = agg.win + agg.loss;
    agg.winRate = agg.gradedTotal > 0 ? Math.round((agg.win / agg.gradedTotal) * 1000) / 10 : null;
  }
  return out;
}

// ====== Pair drilldown (History → Pair Drilldown) ======
function populateHistoryPairSelector() {
  if (!state.snapshot) return;
  const sel = $("drilldown-pair");
  const current = sel.value;
  const pairs = (state.snapshot.pairs || []).slice(0, 100);
  sel.innerHTML = '<option value="">Select a pair…</option>' + pairs.map((p) => `<option value="${escAttr(p.pair)}">${escHtml(p.displayPair)}</option>`).join("");
  if (current && pairs.some((p) => p.pair === current)) sel.value = current;
}

$("drilldown-pair").addEventListener("change", async (e) => {
  const pair = e.target.value;
  if (!pair) return;
  await openPairDrawer(pair, "drilldown-content");
});

// ====== Pair drawer (Signals tab row-tap) ======
const drawerOverlay = $("drawer-overlay");
const drawerClose = $("drawer-close");
drawerClose.addEventListener("click", closePairDrawer);
drawerOverlay.addEventListener("click", (e) => {
  if (e.target === drawerOverlay) closePairDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !drawerOverlay.hidden) closePairDrawer();
});

async function openPairDrawer(pair, targetId = null) {
  state.drawerPair = pair;
  drawerOverlay.hidden = false;
  document.body.style.overflow = "hidden";
  $("drawer-body").innerHTML = '<p class="placeholder">Loading…</p>';
  $("drawer-title").textContent = "Loading…";
  $("drawer-sub").textContent = pair;
  try {
    const res = await fetch(`/api/pair/${encodeURIComponent(pair)}?candle_limit=60`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPairDrawer(data);
    if (targetId) {
      const alt = $(targetId);
      if (alt) alt.innerHTML = renderPairDetailHtml(data);
    }
  } catch (e) {
    $("drawer-body").innerHTML = `<p class="placeholder">Failed: ${e.message}</p>`;
  }
}

function closePairDrawer() {
  drawerOverlay.hidden = true;
  document.body.style.overflow = "";
  state.drawerPair = null;
}

function renderPairDrawer(data) {
  $("drawer-title").textContent = data.displayPair;
  const cat = `<span class="pill pill--${data.category}">${data.category}</span>`;
  const cons = data.consensus ? `<span class="pill pill--${data.consensus.level}">${data.consensus.level}</span>` : "";
  $("drawer-sub").innerHTML = `${cat} ${cons} · ${data.signals?.length || 0} signals · win rate ${data.winRate == null ? "—" : data.winRate.toFixed(1) + "%"}`;
  $("drawer-body").innerHTML = renderPairDetailHtml(data);
}

function renderPairDetailHtml(data) {
  const signals = data.signals || [];
  const candles = data.candles || [];
  const app2History = data.app2History || [];

  const candleChart = candles.length
    ? `<div class="candle-chart">${candles.slice(0, 60).reverse().map((c) => {
        const diff = c.diff;
        const cls = diff == null ? "flat" : diff > 0 ? "up" : diff < 0 ? "down" : "flat";
        const h = Math.min(80, Math.max(4, Math.abs(diff || 0) * 200));
        return `<div class="candle-bar" title="${c.candleUtc} · O:${c.open} C:${c.close}"><div class="candle-bar__body candle-bar__body--${cls}" style="height:${h}px"></div></div>`;
      }).join("")}</div>`
    : '<p class="placeholder">No candle history.</p>';

  const signalRows = signals.map((s) => {
    const lead = s.leadSec;
    const leadTxt = lead == null ? "—" : (lead > 0 ? `+${lead}s` : `${lead}s`);
    const leadCls = classifyLead(lead, s.candleTime);
    return `<tr>
      <td>${s.source}</td>
      <td>${s.sourceName}</td>
      <td><span class="dir dir--${s.direction || "null"}">${s.direction || "—"}</span></td>
      <td class="mono">${s.emittedUtc || "—"}</td>
      <td class="mono">${s.candleUtc || "—"}</td>
      <td class="lead lead--${leadCls}">${leadTxt}</td>
      <td>${s.confidence == null ? "—" : (s.confidence * 100).toFixed(0) + "%"}</td>
      <td>${s.strength || "—"}</td>
      <td>${s.outcome == null ? "—" : s.outcome ? "WIN" : "LOSS"}</td>
    </tr>`;
  }).join("");

  const app2Rows = app2History.slice(0, 30).map((c) => {
    const lead = c.leadSec;
    const leadTxt = lead == null ? "—" : (lead > 0 ? `+${lead}s` : `${lead}s`);
    return `<tr>
      <td class="mono">${c.candleUtc}</td>
      <td><span class="dir dir--${c.direction || "null"}">${c.direction || "—"}</span></td>
      <td class="mono">${c.firstSeenUtc || "—"}</td>
      <td>${leadTxt}</td>
      <td>${c.buyerPct == null ? "—" : (c.buyerPct * 100).toFixed(0) + "% buy"}</td>
      <td>${c.sellerPct == null ? "—" : (c.sellerPct * 100).toFixed(0) + "% sell"}</td>
    </tr>`;
  }).join("");

  const levels = data.levelStats || {};
  const levelSummary = Object.entries(levels).map(([lvl, s]) => {
    const total = (s.win || 0) + (s.loss || 0);
    const wr = total > 0 ? ((s.win / total) * 100).toFixed(1) : "—";
    return `<div class="level-stat">
      <div class="level-stat__title">${lvl}</div>
      <div class="level-stat__row"><span>Win / Loss</span><strong>${s.win || 0} / ${s.loss || 0}</strong></div>
      <div class="level-stat__row"><span>Win rate</span><span>${wr}%</span></div>
      <div class="level-stat__row"><span>Total</span><span>${s.total || 0}</span></div>
    </div>`;
  }).join("");

  const favBtn = state.favorites.has(data.pair)
    ? `<button class="btn btn--ghost" id="drawer-unfav">★ Unfavorite</button>`
    : `<button class="btn btn--ghost" id="drawer-fav">☆ Add to favorites</button>`;

  return `
    <div class="drawer__section">
      <h3>Win Rate</h3>
      <div class="level-stats">${levelSummary || '<p class="placeholder">No graded history yet.</p>'}</div>
    </div>
    <div class="drawer__section">
      <h3>Candle History (last ${candles.length})</h3>
      ${candleChart}
    </div>
    <div class="drawer__section">
      <h3>Per-App Signals (latest candle)</h3>
      <div class="table-scroll">
        <table class="pair-table">
          <thead><tr><th>App</th><th>Name</th><th>Dir</th><th>Emitted (UTC)</th><th>Candle (UTC)</th><th>Lead</th><th>Conf</th><th>Strength</th><th>Outcome</th></tr></thead>
          <tbody>${signalRows || '<tr><td colspan="9" class="placeholder">No signals for the latest candle.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <div class="drawer__section">
      <h3>App 2 History (last ${Math.min(30, app2History.length)})</h3>
      <div class="table-scroll">
        <table class="pair-table">
          <thead><tr><th>Candle (UTC)</th><th>Dir</th><th>First Seen (UTC)</th><th>Lead</th><th>Buyers</th><th>Sellers</th></tr></thead>
          <tbody>${app2Rows || '<tr><td colspan="6" class="placeholder">No App 2 history.</td></tr>'}</tbody>
        </table>
      </div>
    </div>
    <div class="drawer__section">
      ${favBtn}
    </div>
  `;
}

// Delegate fav button in drawer
document.addEventListener("click", (e) => {
  if (e.target.id === "drawer-fav" || e.target.id === "drawer-unfav") {
    if (state.drawerPair) {
      toggleFavorite(state.drawerPair);
      // Re-render drawer
      openPairDrawer(state.drawerPair);
      renderFavorites();
      renderPairTable();
    }
  }
});

// ====== Favorites ======
function toggleFavorite(pair) {
  if (state.favorites.has(pair)) state.favorites.delete(pair);
  else state.favorites.add(pair);
  saveFavorites();
  renderFavorites();
}

function renderFavorites() {
  const container = $("favorites-list");
  if (!container) return;
  if (state.favorites.size === 0) {
    container.innerHTML = '<span class="placeholder">No favorites yet — tap ★ next to a pair.</span>';
    return;
  }
  container.innerHTML = Array.from(state.favorites).map((pair) => {
    const dp = state.snapshot?.pairs?.find((p) => p.pair === pair)?.displayPair || pair;
    return `<span class="fav-chip" data-pair="${escAttr(pair)}">${escHtml(dp)} <span>✕</span></span>`;
  }).join("");
  $$(".fav-chip", container).forEach((chip) => {
    chip.addEventListener("click", () => {
      toggleFavorite(chip.dataset.pair);
      renderFavorites();
      renderPairTable();
    });
  });
}

// ====== Diagnostics (Settings → Diagnostics) ======
$("btn-refresh-diag").addEventListener("click", fetchDiag);

async function fetchDiag() {
  $("diag-content").innerHTML = '<p class="placeholder">Loading diagnostics…</p>';
  try {
    const res = await fetch("/api/diag?poll=1", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    renderDiag(d);
  } catch (e) {
    $("diag-content").innerHTML = `<p class="placeholder">Failed: ${e.message}</p>`;
  }
}

// Freshness is the headline signal for "is this app actually alive right
// now" — a stable/flat raw-row count does NOT mean stale data (some
// upstreams return a fixed-size sliding window, so the count plateaus
// while the content keeps rotating underneath). Candle lag is the metric
// that actually answers "is new data arriving", so it's shown big and
// color-coded first; raw/normalized counts are secondary detail below it.
function _freshnessBadge(a, nowSec) {
  const lag = a.newestCandleLagCandles;
  const ageSec = a.newestCandle != null ? Math.max(0, nowSec - a.newestCandle) : null;
  let cls, label;
  if (lag == null) { cls = "stale"; label = "NO DATA"; }
  else if (lag <= 0) { cls = "fresh"; label = "FRESH"; }
  else if (lag === 1) { cls = "warn"; label = "1 CANDLE BEHIND"; }
  else { cls = "stale"; label = `${lag} CANDLES BEHIND`; }
  const ageTxt = ageSec != null ? `updated ${ageSec}s ago` : "no signal yet";
  return `<div class="diag-freshness diag-freshness--${cls}"><span class="diag-freshness__label">${label}</span><span class="diag-freshness__age">${ageTxt}</span></div>`;
}

function renderDiag(d) {
  const nowSec = d.now?.unixSec ?? Math.floor(Date.now() / 1000);
  const apps = (d.apps || []).map((a) => `
    <div class="level-stat">
      <div class="level-stat__title">${a.app} <span style="color:var(--text-muted);font-weight:400;text-transform:none;">(health: ${a.health})</span></div>
      ${_freshnessBadge(a, nowSec)}
      <div class="level-stat__row" style="margin-top:8px;"><span>Raw rows</span><span>${a.rawRows}</span></div>
      <div class="level-stat__row"><span>Normalized</span><span>${a.normalizedSignals}</span></div>
      <div class="level-stat__row"><span>Skipped</span><span>${JSON.stringify(a.skipped)}</span></div>
      <div class="level-stat__row"><span>Distinct pairs</span><span>${(a.distinctPairs || []).length}</span></div>
      <div class="level-stat__row"><span>Valid for own candle</span><span>${a.validForOwnCandle} / ${a.invalidForOwnCandle}</span></div>
    </div>`).join("");

  const offsets = (d.offsets || []).map((o) => `
    <div class="level-stat">
      <div class="level-stat__title">${o.apps}</div>
      <div class="level-stat__row"><span>Modal offset</span><strong>${o.modalOffsetCandles ?? "—"} candles</strong></div>
      <div class="level-stat__row"><span>Confidence</span><span>${(o.confidence * 100).toFixed(0)}%</span></div>
      <div class="level-stat__row"><span>Samples</span><span>${o.samples}</span></div>
      <div class="level-stat__row" style="font-size:11px;color:var(--text-dim);">${o.hint}</div>
    </div>`).join("");

  const coverage = d.candleCoverageLast30Candles || {};

  $("diag-content").innerHTML = `
    <div class="verdict verdict--insufficient">
      Current candle: ${new Date(d.now.currentCandle * 1000).toISOString()} · Coverage (last 30 candles):
      1-app=${coverage.oneApp} · 2-apps=${coverage.twoApps} · 3-apps=${coverage.threeApps}
    </div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <h3 style="font-size:12px;">Per-app status</h3>
    </div>
    <div class="level-stats">${apps}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <h3 style="font-size:12px;">Candle offsets</h3>
    </div>
    <div class="level-stats">${offsets}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <h3 style="font-size:12px;">Notes</h3>
    </div>
    <ul style="color:var(--text-dim);font-size:12px;padding-left:20px;">
      ${(d.notes || []).map((n) => `<li style="margin-bottom:6px;">${n}</li>`).join("")}
    </ul>
  `;
}

// ====== Settings handlers ======
const settingsInputs = [
  ["set-theme", "theme"],
  ["set-lang", "lang"],
  ["set-tz", "tz"],
  ["set-timefmt", "timeFmt"],
  ["set-poll", "poll"],
  ["set-feed-size", "feedSize"],
  ["set-sound", "sound", "checkbox"],
  ["set-notify", "notify", "checkbox"],
  ["set-min-wr", "minWr"],
  ["set-only-fresh", "onlyFresh"],
  ["set-hide-conflicts", "hideConflicts", "checkbox"],
  ["set-off1", "app1Offset"],
  ["set-off2", "app2Offset"],
  ["set-off3", "app3Offset"],
];
settingsInputs.forEach(([id, key, kind]) => {
  const el = $(id);
  if (!el) return;
  el.addEventListener("change", () => {
    state.settings[key] = kind === "checkbox" ? el.checked : el.value;
    saveSettings();
    applySettings();
    if (key === "poll") restartPolling();
    if (key === "notify" && el.checked && "Notification" in window && Notification.permission !== "granted") {
      Notification.requestPermission().then(() => {});
    }
  });
});

$("btn-clear-cache").addEventListener("click", () => {
  if (!confirm("Clear local cache?")) return;
  state.pairDetailCache.clear();
  state.signalFeedIds.clear();
  location.reload();
});
$("btn-reset-settings").addEventListener("click", () => {
  if (!confirm("Reset all settings to defaults?")) return;
  state.settings = Object.assign({}, DEFAULT_SETTINGS);
  saveSettings();
  applySettings();
  restartPolling();
});

// ====== Clock tick (every 1s) ======
function tickClock() {
  const now = new Date();
  $("clock-utc-time").textContent = fmtTime(now, true);
  $("clock-local-time").textContent = fmtLocalTime(now);
}
function fmtTime(date, withSec) {
  const h = state.settings.timeFmt === "12" ? date.getUTCHours() % 12 || 12 : date.getUTCHours();
  const hs = String(h).padStart(2, "0");
  const ms = String(date.getUTCMinutes()).padStart(2, "0");
  const ss = String(date.getUTCSeconds()).padStart(2, "0");
  let s = `${hs}:${ms}`;
  if (withSec) s += `:${ss}`;
  if (state.settings.timeFmt === "12") s += date.getUTCHours() >= 12 ? " PM" : " AM";
  return s;
}
function fmtLocalTime(date) {
  const h = state.settings.timeFmt === "12" ? date.getHours() % 12 || 12 : date.getHours();
  const hs = String(h).padStart(2, "0");
  const ms = String(date.getMinutes()).padStart(2, "0");
  let s = `${hs}:${ms}`;
  if (state.settings.timeFmt === "12") s += date.getHours() >= 12 ? " PM" : " AM";
  return s;
}
function fmtHmUtc(unixSec) {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}

// ====== Polling loop ======
function startPolling() {
  pollSnapshot();
  state.clockTimer = setInterval(tickClock, 1000);
  tickClock();
  scheduleAdaptivePoll();
}

let adaptiveTimer = null;
function scheduleAdaptivePoll() {
  if (adaptiveTimer) clearTimeout(adaptiveTimer);
  const gap = nextPollGapMs();
  adaptiveTimer = setTimeout(async () => {
    await pollSnapshot();
    await pollSignalFeed();
    scheduleAdaptivePoll();
  }, gap);
}

function restartPolling() {
  if (adaptiveTimer) clearTimeout(adaptiveTimer);
  scheduleAdaptivePoll();
}

// ====== Helpers ======
function escHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
function escAttr(s) {
  return escHtml(s);
}

// ====== Boot ======
// Wire the health-alert dismiss button — hides the bar until an app
// transitions from bad→good→bad again.
$("health-alert-close")?.addEventListener("click", () => {
  $("app-health-alert").hidden = true;
  state.healthAlertDismissed = true;
});

applySettings();
startPolling();
refreshBacktestStatus();
