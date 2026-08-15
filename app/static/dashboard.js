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
  pollTimer: null,
  feedPollTimer: null,
  clockTimer: null,
  lastPollAt: 0,
  drawerPair: null,
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
  if (name === "history") {
    populateHistoryPairSelector();
    renderPerPairTable();
    refreshBacktestStatus();
  }
  window.scrollTo(0, 0);
}

// ====== History sub-tabs ======
$$(".history-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchHistorySubtab(btn.dataset.subtab));
});

function switchHistorySubtab(name) {
  state.activeHistorySubtab = name;
  $$(".history-tab").forEach((b) => b.classList.toggle("history-tab--active", b.dataset.subtab === name));
  $$(".history-panel").forEach((p) => p.classList.toggle("history-panel--active", p.id === `history-${name}`));
  if (name === "perpair") renderPerPairTable();
  if (name === "drilldown") populateHistoryPairSelector();
}

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

const filters = { category: "", level: "", direction: "", search: "", favoritesOnly: false, threeAgreeOnly: false };

wireDropdown("cat-trigger", "cat-menu", "cat-label", (v) => { filters.category = v; renderPairTable(); renderPerPairTable(); });
wireDropdown("level-trigger", "level-menu", "level-label", (v) => { filters.level = v; renderPairTable(); });
wireDropdown("dir-trigger", "dir-menu", "dir-label", (v) => { filters.direction = v; renderPairTable(); });

$("search-input").addEventListener("input", (e) => { filters.search = e.target.value; renderPairTable(); });
$("favorites-only").addEventListener("change", (e) => { filters.favoritesOnly = e.target.checked; renderPairTable(); });
$("three-agree-only").addEventListener("change", (e) => { filters.threeAgreeOnly = e.target.checked; renderPairTable(); });

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
  renderHeroStats(state.snapshot.summary);
  renderAppCards(state.snapshot.apps);
  renderConsensusHighlights(state.snapshot.pairs);
  renderPairTable();
  renderBacktestStatus();
  // Signal feed is polled separately for finer cadence.
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

// ====== Per-pair table (Signals tab) ======
function renderPairTable() {
  if (!state.snapshot) return;
  const body = $("pair-table-body");
  let pairs = state.snapshot.pairs || [];

  if (filters.category) pairs = pairs.filter((p) => p.category === filters.category);
  if (filters.level) pairs = pairs.filter((p) => p.consensus.level === filters.level);
  if (filters.direction) pairs = pairs.filter((p) => (p.consensus.direction || "") === filters.direction);
  if (filters.search) pairs = pairs.filter((p) => p.displayPair.toLowerCase().includes(filters.search.toLowerCase()));
  if (filters.favoritesOnly) pairs = pairs.filter((p) => state.favorites.has(p.pair));
  if (filters.threeAgreeOnly) pairs = pairs.filter((p) => p.consensus.level === "3-agree");
  if (state.settings.hideConflicts) pairs = pairs.filter((p) => p.consensus.level !== "conflict");
  const minWr = parseFloat(state.settings.minWr) || 0;
  if (minWr > 0) pairs = pairs.filter((p) => p.winRate != null && p.winRate >= minWr);
  const onlyFresh = parseInt(state.settings.onlyFresh, 10) || 0;
  if (onlyFresh > 0) {
    const now = Math.floor(Date.now() / 1000);
    pairs = pairs.filter((p) => p.latestCandle && (now - p.latestCandle.candleTime) <= onlyFresh);
  }

  if (pairs.length === 0) {
    body.innerHTML = '<tr><td colspan="11" class="placeholder">No pairs match the filter.</td></tr>';
    return;
  }

  // Sort: 3-agree first, then 2-agree, then by win rate desc.
  const levelRank = { "3-agree": 0, "2-agree": 1, "conflict": 2, "1-only": 3, "none": 4 };
  pairs.sort((a, b) => {
    const lr = (levelRank[a.consensus.level] ?? 5) - (levelRank[b.consensus.level] ?? 5);
    if (lr !== 0) return lr;
    const aw = a.winRate ?? -1;
    const bw = b.winRate ?? -1;
    return bw - aw;
  });

  body.innerHTML = pairs.slice(0, 200).map((p) => {
    const dir = p.consensus.direction || "—";
    const dirCls = dir === "—" ? "null" : dir;
    const apps = p.latestCandle ? p.latestCandle.signals.map((s) => s.source).join(", ") : "—";
    const candleUtc = p.latestCandle ? fmtHmUtc(p.latestCandle.candleTime) : "—";
    const sig = p.latestCandle?.signals?.[0];
    const sigUtc = sig?.emittedUtc || "—";
    const lead = sig?.leadSec;
    const leadTxt = lead == null ? "—" : (lead > 0 ? `+${lead}s` : `${lead}s`);
    const leadCls = classifyLead(lead, p.latestCandle?.candleTime);
    const wrCls = p.winRate == null ? "none" : p.winRate >= 60 ? "good" : p.winRate >= 40 ? "mid" : "low";
    const wrTxt = p.winRate == null ? "—" : `${p.winRate.toFixed(0)}%`;
    const isFav = state.favorites.has(p.pair);
    return `
      <tr data-pair="${escAttr(p.pair)}">
        <td class="fav ${isFav ? "is-fav" : ""}" data-fav="${escAttr(p.pair)}">${isFav ? "★" : "☆"}</td>
        <td><strong>${escHtml(p.displayPair)}</strong></td>
        <td><span class="pill pill--${p.category}">${p.category}</span></td>
        <td><span class="pill pill--${p.consensus.level}">${p.consensus.level}</span></td>
        <td><span class="dir dir--${dirCls}">${dir}</span></td>
        <td>${apps}</td>
        <td class="mono">${sigUtc}</td>
        <td class="mono">${candleUtc}</td>
        <td class="lead lead--${leadCls}">${leadTxt}</td>
        <td><span class="wr-bar wr-bar--${wrCls}">${wrTxt}</span></td>
        <td class="mono">${p.gradedTotal || 0}</td>
      </tr>`;
  }).join("");

  // Wire row click + fav click
  $$("#pair-table-body tr[data-pair]").forEach((row) => {
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
  if (state.activeTab === "home") {
    $("bt-cache-age")?.replaceWith();
  }
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

  $("backtest-content").innerHTML = `
    <div class="verdict verdict--${v.kind}">${v.message || "—"}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <h3 style="font-size:12px;">Per-level stats</h3>
      <span class="panel__meta">${bt.totalSignals} signals · ${bt.totalClusters} clusters</span>
    </div>
    <div class="level-stats">${levelStats}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <h3 style="font-size:12px;">Per-source stats</h3>
    </div>
    <div class="level-stats">${sourceStats}</div>
  `;
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
    body.innerHTML = '<tr><td colspan="8" class="placeholder">No pairs.</td></tr>';
    return;
  }
  $("perpair-meta").textContent = `${pairs.length} pairs · cached ${state.snapshot.backtestCacheAgeSec?.toFixed(0) ?? "—"}s`;

  body.innerHTML = pairs.slice(0, 100).map((p) => {
    const ls = p.levelStats || {};
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
        <td class="fav ${isFav ? "is-fav" : ""}" data-fav="${escAttr(p.pair)}">${isFav ? "★" : "☆"}</td>
        <td><strong>${escHtml(p.displayPair)}</strong></td>
        <td><span class="pill pill--${p.category}">${p.category}</span></td>
        <td class="mono">${totalW}/${totalL}</td>
        <td><span class="wr-bar wr-bar--${wrCls}">${wrTxt}</span></td>
        <td class="mono">${fmt("3-agree")}</td>
        <td class="mono">${fmt("2-agree")}</td>
        <td class="mono">${fmt("1-only")}</td>
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
      <table class="pair-table">
        <thead><tr><th>App</th><th>Name</th><th>Dir</th><th>Emitted (UTC)</th><th>Candle (UTC)</th><th>Lead</th><th>Conf</th><th>Strength</th><th>Outcome</th></tr></thead>
        <tbody>${signalRows || '<tr><td colspan="9" class="placeholder">No signals for the latest candle.</td></tr>'}</tbody>
      </table>
    </div>
    <div class="drawer__section">
      <h3>App 2 History (last ${Math.min(30, app2History.length)})</h3>
      <table class="pair-table">
        <thead><tr><th>Candle (UTC)</th><th>Dir</th><th>First Seen (UTC)</th><th>Lead</th><th>Buyers</th><th>Sellers</th></tr></thead>
        <tbody>${app2Rows || '<tr><td colspan="6" class="placeholder">No App 2 history.</td></tr>'}</tbody>
      </table>
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

function renderDiag(d) {
  const apps = (d.apps || []).map((a) => `
    <div class="level-stat">
      <div class="level-stat__title">${a.app}</div>
      <div class="level-stat__row"><span>Health</span><strong>${a.health}</strong></div>
      <div class="level-stat__row"><span>Raw rows</span><span>${a.rawRows}</span></div>
      <div class="level-stat__row"><span>Normalized</span><span>${a.normalizedSignals}</span></div>
      <div class="level-stat__row"><span>Skipped</span><span>${JSON.stringify(a.skipped)}</span></div>
      <div class="level-stat__row"><span>Distinct pairs</span><span>${(a.distinctPairs || []).length}</span></div>
      <div class="level-stat__row"><span>Newest candle lag</span><span>${a.newestCandleLagCandles ?? "—"} candles</span></div>
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
  state.pairDetailCache.clear();
  state.signalFeedIds.clear();
  if (confirm("Clear local cache?")) location.reload();
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
  state.pollTimer = setInterval(pollSnapshot, 5000);  // fallback, will be overridden
  state.clockTimer = setInterval(tickClock, 1000);
  state.feedPollTimer = setInterval(pollSignalFeed, 3000);
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
  if (state.pollTimer) clearInterval(state.pollTimer);
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
applySettings();
startPolling();
refreshBacktestStatus();
