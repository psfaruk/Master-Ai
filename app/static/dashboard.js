// Master-Ai dashboard client — simple, mobile-first, 4 tabs.
//
// Tabs: Home / Signals / History / Settings. Navigation is a small hash
// router (#/home, #/signals, #/signals/pair/<pair>, #/history, ...) so any
// view — including a single pair's detail — can be opened in its own new
// browser window on mobile.
//
// Settings persist to localStorage; the server is stateless.

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ====== i18n ======
// Static chrome only. Trading vocabulary (CALL/PUT, OTC, 3-agree) and live
// operational readouts stay in English on purpose.
const TRANSLATIONS = {
  en: {
    nav_home: "Home", nav_signals: "Signals", nav_history: "History", nav_settings: "Settings",
    topbar_subtitle: "Quotex signal aggregator",
    clock_local: "Local",
    health_alert_title: "Source app issue detected",
    hero_3agree_label: "3-Bot Agree", hero_2agree_label: "2-Bot Agree",
    hero_conflict_label: "Conflicts", hero_single_label: "Single Only",
    home_live_feed: "Live Signal Feed", home_live_tag: "real-time",
    home_consensus_accuracy: "Consensus Accuracy (last 6 hours)",
    loading_feed: "Loading feed…", placeholder_run_backtest_home: "Waiting for the first backtest…",
    panel_pair_switcher: "Pair Switcher", placeholder_loading: "Loading…",
    panel_live_wr_title: "Live Win Rate",
    panel_sig_history_title: "Live Signal History",
    panel_overall_title: "Overall Win Rate",
    opt_all_markets: "All markets", opt_real: "Real",
    opt_all_levels: "All levels", lvl_conflict: "Conflict", lvl_single: "Single",
    ph_search_pair: "Search pair…",
    th_pair: "Pair", filter_candle_utc: "Candle (UTC)", th_final: "Final", th_agree: "Agree",
    th_winrate60: "WR 60m", loading_ellipsis: "Loading…",
    th_time: "Time", th_apps: "Apps", th_prediction: "Prediction", th_result: "Result",
    th_wl: "W/L", th_winrate: "Win Rate",
    opt_dir_both: "Both directions", opt_60m: "Last 60 min", opt_180m: "Last 3 h", opt_360m: "Last 6 h",
    wr_overall: "Overall",
    hist_empty: "No signals here yet.",
    sig_count: "signals",
    folder_general_title: "General",
    lbl_theme: "Theme", opt_theme_dark: "Dark (default)", opt_theme_light: "Light",
    lbl_language: "Language",
    lbl_clock_display: "Clock display", opt_tz_utc: "UTC only", opt_tz_local: "Local only", opt_tz_both: "Both UTC + Local",
    lbl_sound: "Sound on 3-agree",
    folder_sources_title: "Signal Sources",
    hint_sources_intro: "Paste each app's new Railway URL after a redeploy, then Save & Reconnect — no code change needed.",
    btn_sources_save: "Save & Reconnect", btn_sources_reset: "Reset to defaults", btn_sources_test: "Test",
    src_chip_default: "default", src_chip_env: "env", src_chip_custom: "custom",
    src_testing: "Testing…", src_saving: "Saving…",
    src_test_ok: "OK", src_test_fail: "FAIL",
    src_saved_ok: "Saved — live data now flows from the new URLs.",
    src_saved_unreachable: "Saved, but some apps did not answer — check the results and test again.",
    src_no_change: "No URL changed — nothing to save.",
    src_confirm_reset: "Reset ALL source URLs back to the defaults?",
    src_load_fail: "Could not load source config",
    src_reached: "reachable", src_unreachable: "not reachable",
    folder_about_title: "About",
    btn_clear_cache: "Clear local cache", btn_reset_settings: "Reset settings",
    drawer_fav_add: "☆ Favorite", drawer_fav_remove: "★ Favorite",
    no_favorites_note: "No favorites yet.",
  },
  bn: {
    nav_home: "হোম", nav_signals: "সিগন্যাল", nav_history: "হিস্ট্রি", nav_settings: "সেটিংস",
    topbar_subtitle: "Quotex সিগন্যাল অ্যাগ্রিগেটর",
    clock_local: "স্থানীয়",
    health_alert_title: "সোর্স অ্যাপে সমস্যা সনাক্ত হয়েছে",
    hero_3agree_label: "৩-বট একমত", hero_2agree_label: "২-বট একমত",
    hero_conflict_label: "দ্বন্দ্ব", hero_single_label: "শুধু একক",
    home_live_feed: "লাইভ সিগন্যাল ফিড", home_live_tag: "রিয়েল-টাইম",
    home_consensus_accuracy: "কনসেনসাস নির্ভুলতা (গত ৬ ঘণ্টা)",
    loading_feed: "ফিড লোড হচ্ছে…", placeholder_run_backtest_home: "প্রথম ব্যাকটেস্টের অপেক্ষায়…",
    panel_pair_switcher: "পেয়ার সুইচার", placeholder_loading: "লোড হচ্ছে…",
    panel_live_wr_title: "লাইভ উইন রেট",
    panel_sig_history_title: "লাইভ সিগন্যাল হিস্ট্রি",
    panel_overall_title: "সর্বমোট জয়ের হার",
    opt_all_markets: "সব মার্কেট", opt_real: "রিয়েল",
    opt_all_levels: "সব লেভেল", lvl_conflict: "দ্বন্দ্ব", lvl_single: "একক",
    ph_search_pair: "পেয়ার খুঁজুন…",
    th_pair: "পেয়ার", filter_candle_utc: "ক্যান্ডেল (UTC)", th_final: "চূড়ান্ত", th_agree: "একমত",
    th_winrate60: "জয়ের হার ৬০মি", loading_ellipsis: "লোড হচ্ছে…",
    th_time: "সময়", th_apps: "অ্যাপ", th_prediction: "প্রেডিকশন", th_result: "ফলাফল",
    th_wl: "জয়/হার", th_winrate: "জয়ের হার",
    opt_dir_both: "উভয় দিক", opt_60m: "গত ৬০ মিনিট", opt_180m: "গত ৩ ঘণ্টা", opt_360m: "গত ৬ ঘণ্টা",
    wr_overall: "সর্বমোট",
    hist_empty: "এখনও এখানে কোনো সিগন্যাল নেই।",
    sig_count: "সিগন্যাল",
    folder_general_title: "সাধারণ",
    lbl_theme: "থিম", opt_theme_dark: "ডার্ক (ডিফল্ট)", opt_theme_light: "লাইট",
    lbl_language: "ভাষা",
    lbl_clock_display: "ঘড়ি প্রদর্শন", opt_tz_utc: "শুধু UTC", opt_tz_local: "শুধু স্থানীয়", opt_tz_both: "UTC + স্থানীয় উভয়ই",
    lbl_sound: "৩-একমতে সাউন্ড",
    folder_sources_title: "সিগন্যাল সোর্স",
    hint_sources_intro: "রিডিপ্লয়ের পর প্রতিটি অ্যাপের নতুন Railway URL পেস্ট করে Save & Reconnect চাপুন — কোনো কোড লাগবে না।",
    btn_sources_save: "সেভ ও রিকানেক্ট", btn_sources_reset: "ডিফল্টে ফিরিয়ে আনুন", btn_sources_test: "টেস্ট",
    src_chip_default: "ডিফল্ট", src_chip_env: "এনভ", src_chip_custom: "কাস্টম",
    src_testing: "টেস্ট হচ্ছে…", src_saving: "সেভ হচ্ছে…",
    src_test_ok: "ঠিক আছে", src_test_fail: "ব্যর্থ",
    src_saved_ok: "সেভ হয়েছে — নতুন URL থেকে লাইভ ডেটা আসা শুরু করেছে।",
    src_saved_unreachable: "সেভ হয়েছে, কিন্তু কিছু অ্যাপ সাড়া দেয়নি — ফলাফল দেখে আবার টেস্ট করুন।",
    src_no_change: "কোনো URL পরিবর্তন হয়নি — সেভ করার কিছু নেই।",
    src_confirm_reset: "সব সোর্স URL কি ডিফল্টে ফিরিয়ে আনা হবে?",
    src_load_fail: "সোর্স কনফিগ লোড করা যায়নি",
    src_reached: "সংযোগ হয়েছে", src_unreachable: "সংযোগ হয়নি",
    folder_about_title: "সম্পর্কে",
    btn_clear_cache: "লোকাল ক্যাশ মুছুন", btn_reset_settings: "সেটিংস রিসেট করুন",
    drawer_fav_add: "☆ ফেভারিট", drawer_fav_remove: "★ ফেভারিট",
    no_favorites_note: "এখনও কোনো ফেভারিট নেই।",
  },
};

function t(key) {
  const dict = TRANSLATIONS[state.settings.lang] || TRANSLATIONS.en;
  return dict[key] ?? TRANSLATIONS.en[key] ?? key;
}

function applyTranslations() {
  document.documentElement.lang = state.settings.lang === "bn" ? "bn" : "en";
  $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$("[data-i18n-placeholder]").forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
}

// ====== Settings + state ======
const DEFAULT_SETTINGS = { theme: "dark", lang: "en", tz: "both", sound: false };

function loadSettings() {
  try {
    return Object.assign({}, DEFAULT_SETTINGS, JSON.parse(localStorage.getItem("master-ai:settings") || "{}"));
  } catch (e) { return Object.assign({}, DEFAULT_SETTINGS); }
}

function loadFavorites() {
  try { return new Set(JSON.parse(localStorage.getItem("master-ai:favorites") || "[]")); }
  catch (e) { return new Set(); }
}

function saveSettings() {
  try { localStorage.setItem("master-ai:settings", JSON.stringify(state.settings)); } catch (e) {}
}

function saveFavorites() {
  try { localStorage.setItem("master-ai:favorites", JSON.stringify(Array.from(state.favorites))); } catch (e) {}
}

const state = {
  activeTab: "home",
  snapshot: null,
  signalFeedIds: new Set(),
  _signalFeedPrimed: false,
  _feedHtml: "",
  favorites: loadFavorites(),
  settings: loadSettings(),
  // Live win-rate payload (shared by Signals panel + History overall cards).
  liveWinRate: null,
  _liveWrAt: 0,
  // Signals-tab live history panel.
  spHistoryFilter: "all",
  _spHistoryData: null,
  _spHistoryAt: 0,
  // History-tab list.
  histFilter: "all",
  _histAt: 0,
  // Pair drawer.
  drawerPair: null,
  drawerTab: "all",
  drawerData: null,
  drawerReturnHash: "#/signals",
  // Expanded per-candle detail rows ("list:pair|ts" / "drawer:pair|ts").
  expandedRows: new Set(),
  healthAlertDismissed: false,
  healthAlertDismissedApps: new Set(),
};

// Out-of-order async-render guard: the latest request wins, stale
// responses are dropped instead of painting over the newer view.
const _tickets = {};
function nextTicket(slot) { _tickets[slot] = (_tickets[slot] || 0) + 1; return _tickets[slot]; }
function ticketCurrent(slot, n) { return _tickets[slot] === n; }

// ====== Small helpers ======
function escHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}
const escAttr = escHtml;

function fmtHmUtc(unixSec) {
  if (!unixSec) return "—";
  const d = new Date(unixSec * 1000);
  return String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0");
}

// Win-rate → colour class. App-wide thresholds: ≥60 good, ≥45 mid, else bad.
function wrClass(wr) {
  if (wr == null) return "none";
  if (wr >= 60) return "good";
  if (wr >= 45) return "mid";
  return "bad";
}

function fmtWr(wr) {
  return wr == null ? "—" : `${Number(wr).toFixed(1)}%`;
}

function oppositeDir(dir) {
  if (dir === "CALL") return "PUT";
  if (dir === "PUT") return "CALL";
  return null;
}

const APP_LABELS = { app1: "App 1", app2: "App 2", app3: "App 3" };

// ====== Hash router ======
// Routes:
//   #/home                      Home
//   #/signals                   Signals
//   #/signals/history/<filter>  Signals → history panel, one tab
//   #/signals/pair/<PAIR>       Pair drawer
//   #/signals/pair/<PAIR>/<SUBSET>  Drawer pre-scoped to a combination
//   #/history                   History
//   #/history/<filter>          History list, one tab
//   #/settings                  Settings
function nav(hash) {
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

function switchTab(name) {
  state.activeTab = name;
  $$(".bottomnav__item, .sidenav__item").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("bottomnav__item--active", on && b.classList.contains("bottomnav__item"));
    b.classList.toggle("sidenav__item--active", on && b.classList.contains("sidenav__item"));
  });
  $$(".tab").forEach((p) => p.classList.toggle("tab--active", p.id === `tab-${name}`));
  if (name === "signals") {
    renderPairTable();
    renderPairStrip();
    fetchLiveWinRate();
    renderSpHistoryPanel();
  }
  if (name === "history") {
    fetchLiveWinRate();
    renderOverallWinRate();
    renderHistoryPanel();
  }
  window.scrollTo(0, 0);
}

function applyRoute() {
  const parts = (location.hash || "#/home").replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const head = parts[0] || "home";
  const isPairRoute = head === "signals" && parts[1] === "pair";

  // Any non-pair route is the drawer's "return to" point — so closing a
  // drawer opened from History returns to History, not to Signals.
  if (!isPairRoute) state.drawerReturnHash = location.hash || "#/home";

  // A non-pair route must also dismiss an open pair drawer — otherwise
  // switching tabs from the bottom nav while a drawer is up leaves the
  // drawer stuck on screen over the new tab.
  if (!isPairRoute && state.drawerPair) closePairDrawer({ silent: true });

  if (head === "signals") {
    switchTab("signals");
    if (isPairRoute && parts[2]) {
      openPairDrawer(parts[2], { subset: parts[3] || null, fromRoute: true });
    } else {
      closePairDrawer({ silent: true });
      if (parts[1] === "history" && parts[2]) setSpHistoryFilter(parts[2]);
    }
    return;
  }
  if (head === "history") {
    switchTab("history");
    if (parts[1]) setHistFilter(parts[1]);
    return;
  }
  if (head === "settings") { switchTab("settings"); return; }
  switchTab("home");
}

window.addEventListener("hashchange", applyRoute);

// Main navigation — the mobile bottom tab bar and the desktop side rail.
// Taps route through the hash router (#/home, #/signals, …) so the URL,
// the active highlight and any open drawer all stay in sync. This block
// is what makes the tabs respond to touch — it must always stay wired.
$$(".bottomnav__item, .sidenav__item").forEach((btn) => {
  btn.addEventListener("click", () => nav(`#/${btn.dataset.tab}`));
});

// ====== Polling ======
const POLL_BURST_WINDOW_SEC = 12;
const POLL_BURST_INTERVAL_MS = 1000;
const POLL_IDLE_INTERVAL_MS = 3000;

function nextPollGapMs() {
  const secIntoCandle = Math.floor(Date.now() / 1000) % 60;
  return secIntoCandle < POLL_BURST_WINDOW_SEC ? POLL_BURST_INTERVAL_MS : POLL_IDLE_INTERVAL_MS;
}

function setStatus(kind, text) {
  const pill = $("status-pill");
  if (!pill) return;
  pill.classList.remove("is-down", "is-stale");
  if (kind === "down") pill.classList.add("is-down");
  else if (kind === "stale") pill.classList.add("is-stale");
  $("status-text").textContent = text;
}

async function pollSnapshot() {
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (res.status === 503) { setStatus("stale", "first poll running…"); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.snapshot = data;
    setStatus("ok", `updated ${Math.max(0, Math.round((data.ageMs || 0) / 1000))}s ago`);
    render();
    if (state.activeTab === "signals") fetchLiveWinRate();
  } catch (e) {
    setStatus("down", `error: ${e.message}`);
  }
}

async function pollSignalFeed() {
  try {
    const res = await fetch("/api/signal-feed?limit=50", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    renderSignalFeed(data.items || []);
  } catch (e) { /* keep last good feed */ }
}

let pollTimer = null;
function schedulePoll() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollSnapshot();
    await pollSignalFeed();
    schedulePoll();
  }, nextPollGapMs());
}

function startPolling() {
  pollSnapshot();
  pollSignalFeed();
  schedulePoll();
  setInterval(tickClock, 1000);
  tickClock();
}

// ====== Master render (every snapshot poll) ======
function render() {
  if (!state.snapshot) return;
  renderHealthAlert(state.snapshot.apps);
  renderHeroStats(state.snapshot.summary);
  renderAppCards(state.snapshot.apps);
  renderPairStrip();
  renderPairTable();
  if (state.drawerPair && state.drawerData) refreshDrawerLiveBits();
}

// ====== Health alert ======
function _isAppUnhealthy(a) {
  const h = a.health || "unknown";
  return h === "token_expired" || h === "disconnected" || h === "down";
}

function renderHealthAlert(apps) {
  const alertEl = $("app-health-alert");
  const msgEl = $("app-health-msg");
  if (!alertEl || !msgEl) return;
  const badApps = apps.filter(_isAppUnhealthy);
  if (state.healthAlertDismissed) {
    const dismissed = state.healthAlertDismissedApps;
    const hasNewBad = badApps.some((a) => !dismissed.has(a.id ?? a.name));
    if (badApps.length === 0 || !hasNewBad) {
      alertEl.hidden = true;
      if (badApps.length === 0) state.healthAlertDismissed = false;
      return;
    }
    state.healthAlertDismissed = false;
  }
  if (badApps.length === 0) {
    alertEl.hidden = true;
    state.healthAlertDismissed = false;
    return;
  }
  msgEl.innerHTML = badApps.map((a) =>
    `<span class="alert-app-name">${escHtml(a.name)}</span> <span class="outcome--loss">${escHtml((a.health || "down").replace("_", " "))}</span>`
  ).join(" · ");
  alertEl.hidden = false;
}

// ====== Home ======
function renderHeroStats(summary) {
  if (!summary) return;
  $("stat-3agree").textContent = String(summary.threeBotAgree.length);
  $("stat-2agree").textContent = String(summary.twoBotAgree.length);
  $("stat-conflict").textContent = String(summary.conflicts.length);
  $("stat-single").textContent = String(summary.singleOnly.length);
}

// Hero cards jump to the Signals tab with that level pre-selected.
$$("[data-hero-level]").forEach((btn) => {
  btn.addEventListener("click", () => {
    $("filter-level").value = btn.dataset.heroLevel;
    nav("#/signals");
  });
});

function _healthDot(a) {
  const h = a.health || "unknown";
  if (h === "ok") return a.live ? "dot--live" : "dot--ok";
  if (h === "down" || h === "disconnected" || h === "token_expired") return "dot--bad";
  if (h === "degraded") return "dot--warn";
  return "dot--unknown";
}

function renderAppCards(apps) {
  const container = $("app-cards");
  if (!container || !apps) return;
  container.innerHTML = apps.map((a) => `
    <div class="app-card">
      <div class="app-card__top">
        <span class="app-card__name">${escHtml(a.name)}</span>
        <span class="dot ${_healthDot(a)}"></span>
      </div>
      <div class="app-card__count">${a.signalCount} <span>${escHtml(t("sig_count"))}</span></div>
      <div class="app-card__detail">${escHtml(a.detail || a.health || "—")}</div>
    </div>
  `).join("");
}

// ---- Live signal feed ----
let _beepCtx = null;
function playBeep() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!_beepCtx) _beepCtx = new Ctor();
    if (_beepCtx.state === "suspended") _beepCtx.resume().catch(() => {});
    const osc = _beepCtx.createOscillator();
    const gain = _beepCtx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.15, _beepCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, _beepCtx.currentTime + 0.3);
    osc.connect(gain).connect(_beepCtx.destination);
    osc.start();
    osc.stop(_beepCtx.currentTime + 0.3);
  } catch (e) {}
}

function renderSignalFeed(items) {
  const primed = state._signalFeedPrimed;
  const newIds = new Set();
  (items || []).forEach((it) => {
    const id = `${it.pair}|${it.source}|${it.emittedAt}`;
    if (!state.signalFeedIds.has(id)) newIds.add(id);
  });
  state.signalFeedIds = new Set((items || []).map((it) => `${it.pair}|${it.source}|${it.emittedAt}`));
  if (!primed) {
    state._signalFeedPrimed = true;
  } else if (newIds.size > 0 && state.settings.sound) {
    const isNewThreeAgree = (it) => newIds.has(`${it.pair}|${it.source}|${it.emittedAt}`) && it.consensusLevel === "3-agree";
    if (items.some(isNewThreeAgree)) playBeep();
  }

  const container = $("home-signal-feed");
  if (!container) return;
  if (!items.length) {
    container.innerHTML = `<p class="placeholder">${escHtml(t("hist_empty"))}</p>`;
    return;
  }
  const html = items.map((it) => {
    const dir = it.direction || "—";
    return `
      <div class="feed-item" data-pair="${escAttr(it.pair)}">
        <span class="feed-item__time">${escHtml(it.emittedUtc || "—")}</span>
        <div>
          <div class="feed-item__pair">${escHtml(it.displayPair)}</div>
          <div class="feed-item__meta">${escHtml(it.source)} · ${escHtml(it.consensusLevel || "—")}</div>
        </div>
        <span class="dir dir--${escAttr(dir)}">${escHtml(dir)}</span>
      </div>`;
  }).join("");
  if (state._feedHtml === html) return;
  state._feedHtml = html;
  container.innerHTML = html;
  $$(".feed-item", container).forEach((el) => {
    el.addEventListener("click", () => openPairDrawer(el.dataset.pair));
  });
}

// ---- Home backtest summary (per-level accuracy from /api/live-winrate) ----
async function fetchLiveWinRate() {
  const now = Date.now();
  if (state.liveWinRate && now - state._liveWrAt < 30000) return;
  state._liveWrAt = now;
  const ticket = nextTicket("livewr");
  try {
    const res = await fetch("/api/live-winrate", { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    if (!ticketCurrent("livewr", ticket)) return;
    state.liveWinRate = data;
    renderLiveWrPanel();
    renderOverallWinRate();
    renderHomeBacktest();
  } catch (e) { /* keep last good payload */ }
}

const BT_LEVELS = ["3-agree", "2-agree", "conflict", "1-only"];

function renderHomeBacktest() {
  const body = $("home-backtest");
  const meta = $("backtest-status");
  if (!body) return;
  const d = state.liveWinRate;
  if (!d) { body.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_loading"))}</p>`; return; }
  if (meta) {
    meta.textContent = d.cacheAgeSec != null && d.cacheAgeSec >= 0 ? `cache ${d.cacheAgeSec.toFixed(0)}s` : "—";
  }
  if (!d.hasResult) {
    body.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_run_backtest_home"))}</p>`;
    return;
  }
  const levels = d.levels || {};
  body.innerHTML = `
    <div class="bt-levels">
      ${BT_LEVELS.map((lv) => {
        const s = levels[lv] || {};
        const graded = s.win + s.loss;
        const wr = graded ? Math.round((s.win / graded) * 1000) / 10 : null;
        return `
          <div class="wr-card">
            <span class="wr-card__label">${escHtml(lv)}</span>
            <span class="wr-card__wr wr--${wrClass(wr)}">${escHtml(graded ? wr.toFixed(1) + "%" : "—")}</span>
            <span class="wr-card__sub">${s.win || 0}W / ${s.loss || 0}L</span>
          </div>`;
      }).join("")}
    </div>`;
}

// ====== Clock ======
function tickClock() {
  const now = new Date();
  const utcEl = $("clock-utc-time");
  const localEl = $("clock-local-time");
  if (utcEl) utcEl.textContent = fmtClock(now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
  if (localEl) localEl.textContent = fmtClock(now.getHours(), now.getMinutes(), now.getSeconds());
}

function fmtClock(h, m, s) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// ======================================================================
// SIGNALS TAB
// ======================================================================

// ---- Pair switcher strip: one chip per pair. Chips are real hash
// anchors (#/signals/pair/<pair>) so they can be long-pressed to open
// the pair in a NEW browser window on mobile. ----
function renderPairStrip() {
  const strip = $("sp-pair-strip");
  const meta = $("sp-pairstrip-meta");
  if (!strip || !state.snapshot) return;
  const pairs = state.snapshot.pairs || [];
  if (meta) meta.textContent = `${pairs.length} ${t("sig_count")}`;
  if (!pairs.length) {
    strip.innerHTML = `<p class="placeholder">${escHtml(t("hist_empty"))}</p>`;
    return;
  }
  strip.innerHTML = pairs.map((p) => {
    const dir = p.consensus?.direction || "";
    const level = p.consensus?.level || "";
    const agreeN = level === "3-agree" ? 3 : level === "2-agree" ? 2 : 1;
    const active = state.drawerPair === p.pair ? " is-active" : "";
    return `
      <a class="pair-chip${active}" href="#/signals/pair/${encodeURIComponent(p.pair)}">
        <span class="pair-chip__dot pair-chip__dot--${escAttr(p.category || "real")}"></span>
        <span>${escHtml(p.displayPair)}</span>
        ${dir ? `<span class="pair-chip__dir pair-chip__dir--${escAttr(dir)}">${escHtml(dir === "CALL" ? "▲" : "▼")}</span>` : ""}
        <span class="pair-chip__agree">${agreeN}/3</span>
      </a>`;
  }).join("");
}

// ---- Live win-rate cards: one per agreement type ----
function renderLiveWrPanel() {
  const grid = $("sp-live-winrate");
  const meta = $("sp-wr-meta");
  if (!grid) return;
  const d = state.liveWinRate;
  if (!d) { grid.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_loading"))}</p>`; return; }
  if (!d.hasResult) {
    grid.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_run_backtest_home"))}</p>`;
    if (meta) meta.textContent = d.refreshInProgress ? "backtest running…" : "no backtest yet";
    return;
  }
  if (meta) {
    meta.textContent = `${d.cacheAgeSec != null && d.cacheAgeSec >= 0 ? `cache ${d.cacheAgeSec.toFixed(0)}s · ` : ""}${d.overall?.gradedTotal || 0} graded · last 6 h`;
  }
  const levels = d.levels || {};
  const appPair = d.appPair || {};
  const cards = [
    { key: "overall", label: t("wr_overall"), s: d.overall || {} },
    { key: "3-agree", label: "3-agree", s: levels["3-agree"] || {} },
    { key: "2-agree", label: "2-agree", s: levels["2-agree"] || {} },
    { key: "app1+app2", label: "App 1+2", s: appPair["app1+app2"] || {} },
    { key: "app1+app3", label: "App 1+3", s: appPair["app1+app3"] || {} },
    { key: "app2+app3", label: "App 2+3", s: appPair["app2+app3"] || {} },
  ];
  grid.innerHTML = cards.map((c) => {
    const s = c.s;
    const graded = s.gradedTotal != null ? s.gradedTotal : (s.win || 0) + (s.loss || 0);
    const wr = graded ? s.winRate : null;
    const sub = graded ? `${s.win || 0}W / ${s.loss || 0}L` : `${s.total || 0} ${t("sig_count")}`;
    return `
      <button type="button" class="wr-card" data-wrcard="${escAttr(c.key)}">
        <span class="wr-card__label">${escHtml(c.label)}</span>
        <span class="wr-card__wr wr--${wrClass(wr)}">${escHtml(graded ? Number(wr).toFixed(1) + "%" : "—")}</span>
        <span class="wr-card__sub">${escHtml(sub)}</span>
      </button>`;
  }).join("");
  $$("#sp-live-winrate .wr-card").forEach((card) => {
    card.addEventListener("click", () => {
      const key = card.dataset.wrcard;
      if (key === "overall") {
        $("filter-level").value = "";
        renderPairTable();
        window.scrollTo(0, 0);
      } else if (key === "3-agree" || key === "2-agree") {
        $("filter-level").value = key;
        renderPairTable();
        window.scrollTo(0, 0);
      } else {
        nav(`#/history/${encodeURIComponent(key)}`);
      }
    });
  });
}

// ---- Pairs table ----
function renderPairTable() {
  if (!state.snapshot) return;
  const body = $("pair-table-body");
  if (!body) return;
  const market = $("filter-market")?.value || "";
  const level = $("filter-level")?.value || "";
  const search = ($("filter-search")?.value || "").toLowerCase();

  let pairs = state.snapshot.pairs || [];
  if (market) pairs = pairs.filter((p) => p.category === market);
  if (level) pairs = pairs.filter((p) => p.consensus.level === level);
  if (search) pairs = pairs.filter((p) => p.displayPair.toLowerCase().includes(search));

  if (!pairs.length) {
    body.innerHTML = `<tr><td colspan="8" class="placeholder">${escHtml(t("hist_empty"))}</td></tr>`;
    $("sp-table-count").textContent = `0 ${t("sig_count")}`;
    return;
  }

  body.innerHTML = pairs.map((p) => {
    const lc = p.latestCandle;
    const sigByApp = { app1: null, app2: null, app3: null };
    for (const s of (lc?.signals || [])) {
      if (s.source in sigByApp && !sigByApp[s.source]) sigByApp[s.source] = s;
    }
    const cell = (app) => {
      const s = sigByApp[app];
      if (!s || !s.direction) return `<td class="dir">—</td>`;
      return `<td><span class="dir dir--${escAttr(s.direction)}">${escHtml(s.direction)}</span></td>`;
    };
    const finalDir = p.consensus?.direction || null;
    const levelCls = p.consensus?.level || "";
    const wr = p.winRate60Min;
    const graded60 = p.gradedTotal60Min || 0;
    return `
      <tr class="pair-row" data-pair="${escAttr(p.pair)}" tabindex="0" role="button">
        <td><strong>${escHtml(p.displayPair)}</strong> <span class="pill pill--${escAttr(p.category || "real")}">${escHtml((p.category || "").toUpperCase())}</span></td>
        <td class="mono">${escHtml(lc ? fmtHmUtc(lc.candleTime) : "—")}</td>
        ${cell("app1")}${cell("app2")}${cell("app3")}
        <td>${finalDir ? `<span class="dir dir--${escAttr(finalDir)}">${escHtml(finalDir)}</span>` : "—"}</td>
        <td><span class="pill pill--${escAttr(levelCls)}">${escHtml(levelCls || "—")}</span></td>
        <td class="mono wr--${wrClass(graded60 ? wr : null)}">${escHtml(graded60 ? fmtWr(wr) : "—")}</td>
      </tr>`;
  }).join("");
  $("sp-table-count").textContent = `${pairs.length} ${t("sig_count")}`;
  $$("#pair-table-body .pair-row").forEach((tr) => {
    tr.addEventListener("click", () => openPairDrawer(tr.dataset.pair));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPairDrawer(tr.dataset.pair); }
    });
  });
}

["filter-market", "filter-level"].forEach((id) => {
  $(id)?.addEventListener("change", renderPairTable);
});
$("filter-search")?.addEventListener("input", renderPairTable);

// ---- Live Signal History panel (Signals tab) ----
const HIST_FILTERS = [
  { key: "all", level: "all", subset: "" },
  { key: "3-agree", level: "3-agree", subset: "" },
  { key: "2-agree", level: "2-agree", subset: "" },
  { key: "app1+app2", level: "all", subset: "app1+app2" },
  { key: "app1+app3", level: "all", subset: "app1+app3" },
  { key: "app2+app3", level: "all", subset: "app2+app3" },
];

function setSpHistoryFilter(key) {
  if (!HIST_FILTERS.some((f) => f.key === key)) key = "all";
  state.spHistoryFilter = key;
  state.expandedRows.clear();
  renderSpHistoryPanel(true);
}

$$("#sp-history-tabs .seg-tab").forEach((btn) => {
  btn.addEventListener("click", () => nav(`#/signals/history/${encodeURIComponent(btn.dataset.shfilter)}`));
});

async function renderSpHistoryPanel(force = false) {
  const body = $("sp-history-body");
  if (!body) return;
  const def = HIST_FILTERS.find((f) => f.key === state.spHistoryFilter) || HIST_FILTERS[0];
  $$("#sp-history-tabs .seg-tab").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.shfilter === def.key));
  const now = Date.now();
  if (!force && state._spHistoryData && state._spHistoryData.__key === def.key && now - state._spHistoryAt < 30000) {
    paintHistoryTable("sp-history", state._spHistoryData, def);
    return;
  }
  state._spHistoryAt = now;
  const q = new URLSearchParams({
    level: def.level, subset: def.subset, minutes: "60", limit: "60", graded_only: "0",
  });
  const ticket = nextTicket("sphistory");
  try {
    const res = await fetch(`/api/consensus-history?${q}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!ticketCurrent("sphistory", ticket)) return;
    data.__key = def.key;
    state._spHistoryData = data;
    paintHistoryTable("sp-history", data, def);
  } catch (e) {
    if (ticketCurrent("sphistory", ticket)) {
      body.innerHTML = `<tr><td colspan="8" class="placeholder placeholder--error">${escHtml(String(e.message || e))}</td></tr>`;
    }
  }
}

// ======================================================================
// HISTORY TAB
// ======================================================================

function setHistFilter(key) {
  if (!HIST_FILTERS.some((f) => f.key === key)) key = "all";
  state.histFilter = key;
  state.expandedRows.clear();
  renderHistoryPanel(true);
}

$$("#hist-tabs .seg-tab").forEach((btn) => {
  btn.addEventListener("click", () => nav(`#/history/${encodeURIComponent(btn.dataset.hfilter)}`));
});
["hist-direction", "hist-minutes"].forEach((id) => {
  $(id)?.addEventListener("change", () => renderHistoryPanel(true));
});

async function renderHistoryPanel(force = false) {
  const body = $("hist-body");
  if (!body) return;
  const def = HIST_FILTERS.find((f) => f.key === state.histFilter) || HIST_FILTERS[0];
  $$("#hist-tabs .seg-tab").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.hfilter === def.key));
  const now = Date.now();
  if (!force && state._histData && state._histData.__key === def.key && now - state._histAt < 30000) {
    paintHistoryTable("hist", state._histData, def);
    return;
  }
  state._histAt = now;
  const minutes = parseInt($("hist-minutes")?.value || "360", 10) || 360;
  const direction = $("hist-direction")?.value || "";
  const q = new URLSearchParams({
    level: def.level, subset: def.subset, minutes: String(minutes), limit: "200", graded_only: "0",
  });
  if (direction) q.set("direction", direction);
  const ticket = nextTicket("histlist");
  try {
    const res = await fetch(`/api/consensus-history?${q}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!ticketCurrent("histlist", ticket)) return;
    data.__key = def.key;
    state._histData = data;
    paintHistoryTable("hist", data, def);
  } catch (e) {
    if (ticketCurrent("histlist", ticket)) {
      body.innerHTML = `<tr><td colspan="8" class="placeholder placeholder--error">${escHtml(String(e.message || e))}</td></tr>`;
    }
  }
}

// ---- Overall win rate cards (History tab, from /api/live-winrate) ----
const OVERALL_CARDS = [
  { key: "app1", label: "App 1", tap: false },
  { key: "app2", label: "App 2", tap: false },
  { key: "app3", label: "App 3", tap: false },
  { key: "app1+app2", label: "App 1+2", tap: true },
  { key: "app1+app3", label: "App 1+3", tap: true },
  { key: "app2+app3", label: "App 2+3", tap: true },
  { key: "app1+app2+app3", label: "All 3", tap: true },
];

function renderOverallWinRate() {
  const grid = $("overall-content");
  const meta = $("overall-meta");
  if (!grid) return;
  const d = state.liveWinRate;
  if (!d) { grid.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_loading"))}</p>`; return; }
  if (!d.hasResult) {
    grid.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_run_backtest_home"))}</p>`;
    if (meta) meta.textContent = "no backtest yet";
    return;
  }
  if (meta) meta.textContent = `${d.overall?.gradedTotal || 0} graded · last 6 h`;
  const appPair = d.appPair || {};
  grid.innerHTML = OVERALL_CARDS.map((c) => {
    const s = appPair[c.key] || {};
    const graded = s.win + s.loss;
    const wr = graded ? Math.round((s.win / graded) * 1000) / 10 : null;
    return `
      <button type="button" class="wr-card" data-ocard="${escAttr(c.key)}" ${c.tap ? "" : "disabled"}>
        <span class="wr-card__label">${escHtml(c.label)}</span>
        <span class="wr-card__wr wr--${wrClass(wr)}">${escHtml(graded ? wr.toFixed(1) + "%" : "—")}</span>
        <span class="wr-card__sub">${s.win || 0}W / ${s.loss || 0}L · ${s.total || 0} ${t("sig_count")}</span>
      </button>`;
  }).join("");
  $$("#overall-content .wr-card[data-ocard]").forEach((card) => {
    if (card.disabled) return;
    card.addEventListener("click", () => {
      const key = card.dataset.ocard;
      if (HIST_FILTERS.some((f) => f.key === key)) nav(`#/history/${encodeURIComponent(key)}`);
    });
  });
}

// ======================================================================
// SHARED consensus-history table painter (Signals panel + History list)
// ======================================================================

function paintHistoryTable(prefix, data, def) {
  const body = $(`${prefix}-body`);
  const meta = $(`${prefix}-meta`);
  const summaryEl = $(`${prefix}-summary`);
  if (!body) return;
  const items = data.items || [];
  const s = data.summary || {};
  if (meta) meta.textContent = `last ${data.minutes} min · ${data.total || 0} ${t("sig_count")}`;
  if (summaryEl) {
    const graded = (s.wins || 0) + (s.losses || 0);
    summaryEl.innerHTML = graded || s.total ? `
      <div class="summary-chip"><span class="summary-chip__label">${escHtml(t("th_wl"))}</span><strong>${s.wins || 0} / ${s.losses || 0}</strong></div>
      <div class="summary-chip"><span class="summary-chip__label">${escHtml(t("th_winrate"))}</span><strong class="wr--${wrClass(graded ? s.winRate : null)}">${escHtml(fmtWr(graded ? s.winRate : null))}</strong></div>
      <div class="summary-chip"><span class="summary-chip__label">CALL/PUT</span><strong>${s.call || 0} / ${s.put || 0}</strong></div>
    ` : "";
  }
  if (!items.length) {
    body.innerHTML = `<tr><td colspan="8" class="placeholder">${escHtml(t("hist_empty"))}</td></tr>`;
    return;
  }
  body.innerHTML = items.map((c) => renderListRow(c)).join("");
  wireListRowToggles(body, items);
}

function listRowKey(c) { return `list:${c.pair}|${c.ts}`; }

function renderListRow(c) {
  const key = listRowKey(c);
  const expanded = state.expandedRows.has(key);
  const dir = c.direction;
  const result = c.marketResult;
  const outcomeCls = c.outcome === 1 ? "win" : c.outcome === 0 ? "loss" : "unknown";
  const apps = (c.agreeing_apps || []).map((a) => APP_LABELS[a] || a).join(" + ") || "—";
  return `
    <tr class="hist-row${expanded ? " hist-row--open" : ""}" data-row="${escAttr(key)}" tabindex="0" role="button" aria-expanded="${expanded}">
      <td class="mono">${escHtml(c.candleUtc || "—")}</td>
      <td>${escHtml(c.displayPair || c.pair || "—")}</td>
      <td class="mono">${escHtml(apps)}</td>
      <td>${dir ? `<span class="dir dir--${escAttr(dir)}">${escHtml(dir)}</span>` : "—"}</td>
      <td>${result ? `<span class="dir dir--${escAttr(result)}">${escHtml(result)}</span>` : "—"}</td>
      <td><span class="outcome outcome--${outcomeCls}">${escHtml(c.outcomeLabel || "—")}</span></td>
      <td class="mono wr--${wrClass(c.runningWinRate)}">${escHtml(fmtWr(c.runningWinRate))}</td>
      <td class="hist-row__chev">${expanded ? "▴" : "▾"}</td>
    </tr>
    ${expanded ? `<tr class="hist-detail-row"><td colspan="8">${renderListDetail(c)}</td></tr>` : ""}`;
}

function renderListDetail(c) {
  const dirs = c.app_directions || {};
  const labels = c.appOutcomeLabels || {};
  const agreeing = new Set(c.agreeing_apps || []);
  const appCards = ["app1", "app2", "app3"].map((app) => {
    const d = dirs[app];
    if (!d) {
      return `<div class="hist-app-card hist-app-card--silent">
        <span class="hist-app-card__name">${APP_LABELS[app]}</span>
        <span>— no signal</span>
      </div>`;
    }
    const lbl = labels[app] || "—";
    const cls = lbl === "WIN" ? "win" : lbl === "LOSS" ? "loss" : "unknown";
    return `<div class="hist-app-card${agreeing.has(app) ? " hist-app-card--agree" : ""}">
      <span class="hist-app-card__name">${APP_LABELS[app]}${agreeing.has(app) ? " ✓" : ""}</span>
      <span class="dir dir--${escAttr(d)}">${escHtml(d)}</span>
      <span class="outcome outcome--${cls}">${escHtml(lbl)}</span>
    </div>`;
  }).join("");
  const verdict = c.outcome === 1 ? "Consensus WON — the candle closed in the predicted direction."
    : c.outcome === 0 ? "Consensus LOST — the candle closed against the prediction."
    : (c.outcomeLabel === "DRAW") ? "DRAW — open and close at the same price."
    : "Not graded yet — waiting for the candle close.";
  return `
    <div class="hist-detail">
      <div class="hist-detail__head">
        <span class="hist-detail__pair">${escHtml(c.displayPair || c.pair)}</span>
        <span class="mono">${escHtml(c.candleUtc || "—")} UTC</span>
        <span class="pill pill--${escAttr(c.level)}">${escHtml(c.level)}</span>
        ${c.app_subset_key ? `<span class="pill">${escHtml(c.app_subset_key)}</span>` : ""}
      </div>
      <div class="app-card-grid">${appCards}</div>
      <p class="hist-detail__verdict hist-detail__verdict--${c.outcome === 1 ? "win" : c.outcome === 0 ? "loss" : "pending"}">${escHtml(verdict)}</p>
      <div class="hist-detail__actions">
        <button class="btn btn--ghost btn--mini" data-open-pair="${escAttr(c.pair)}">Open ${escHtml(c.displayPair || c.pair)} ↗</button>
      </div>
    </div>`;
}

function wireListRowToggles(body, items) {
  const toggle = (key) => {
    if (state.expandedRows.has(key)) state.expandedRows.delete(key);
    else state.expandedRows.add(key);
    body.innerHTML = items.map(renderListRow).join("");
    wireListRowToggles(body, items);
  };
  $$(".hist-row", body).forEach((tr) => {
    tr.addEventListener("click", () => toggle(tr.dataset.row));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(tr.dataset.row); }
    });
  });
  $$("[data-open-pair]", body).forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openPairDrawer(btn.dataset.openPair);
    });
  });
}

// ======================================================================
// PAIR DRAWER
// ======================================================================

// One tab per agreement type; each shows its own win rate + W/L computed
// from the SAME graded history window, so the tabs are directly comparable.
const DRAWER_TABS = [
  { key: "all", label: "All", match: () => true },
  { key: "3-agree", label: "3-agree", match: (c) => c.level === "3-agree" },
  { key: "2-agree", label: "2-agree", match: (c) => c.level === "2-agree" },
  { key: "app1+app2", label: "App 1+2", match: (c) => c.app_subset_key === "app1+app2" },
  { key: "app1+app3", label: "App 1+3", match: (c) => c.app_subset_key === "app1+app3" },
  { key: "app2+app3", label: "App 2+3", match: (c) => c.app_subset_key === "app2+app3" },
];

function drawerTabStats(rows) {
  const st = { total: rows.length, win: 0, loss: 0 };
  for (const c of rows) {
    if (c.outcome === 1) st.win++;
    else if (c.outcome === 0) st.loss++;
  }
  st.graded = st.win + st.loss;
  st.winRate = st.graded ? Math.round((st.win / st.graded) * 1000) / 10 : null;
  return st;
}

async function openPairDrawer(pair, opts = {}) {
  const subset = opts.subset || null;
  if (!opts.fromRoute) {
    const cur = location.hash || "#/signals";
    if (!cur.includes("/pair/")) state.drawerReturnHash = cur;
  }
  state.drawerPair = pair;
  state.drawerTab = DRAWER_TABS.some((tb) => tb.key === subset) ? subset : "all";
  $("drawer-overlay").hidden = false;
  document.body.style.overflow = "hidden";
  $("drawer-body").innerHTML = `<p class="placeholder">${escHtml(t("placeholder_loading"))}</p>`;
  $("drawer-title").textContent = pair;
  const ticket = nextTicket("drawer");
  try {
    const res = await fetch(`/api/pair/${encodeURIComponent(pair)}?candle_limit=60&history_minutes=360`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!ticketCurrent("drawer", ticket) || state.drawerPair !== pair) return;
    state.drawerData = data;
    renderDrawer(data);
  } catch (e) {
    if (!ticketCurrent("drawer", ticket)) return;
    $("drawer-body").innerHTML = `<p class="placeholder placeholder--error">${escHtml(String(e.message || e))}</p>`;
  }
}

function closePairDrawer(opts = {}) {
  $("drawer-overlay").hidden = true;
  document.body.style.overflow = "";
  state.drawerPair = null;
  state.drawerData = null;
  if (!opts.silent) nav(state.drawerReturnHash || "#/signals");
}

function requestCloseDrawer() { closePairDrawer(); }

$("drawer-close")?.addEventListener("click", requestCloseDrawer);
$("drawer-overlay")?.addEventListener("click", (e) => {
  if (e.target === $("drawer-overlay")) requestCloseDrawer();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("drawer-overlay").hidden) requestCloseDrawer();
});

// Pair switcher inside the drawer: ◀ prev / dropdown / ▶ next / ↗ new win.
function drawerPairList() {
  const pairs = (state.snapshot?.pairs || []).slice();
  pairs.sort((a, b) => {
    const ac = a.consensus?.level === "3-agree" ? 3 : a.consensus?.level === "2-agree" ? 2 : 0;
    const bc = b.consensus?.level === "3-agree" ? 3 : b.consensus?.level === "2-agree" ? 2 : 0;
    if (bc !== ac) return bc - ac;
    return a.displayPair.localeCompare(b.displayPair);
  });
  return pairs;
}

function updateDrawerSwitcher(data) {
  const sel = $("drawer-pairselect");
  const newwin = $("drawer-newwin");
  if (!sel || !data) return;
  const list = drawerPairList();
  if (!list.some((p) => p.pair === data.pair)) {
    list.unshift({ pair: data.pair, displayPair: data.displayPair || data.pair });
  }
  const sig = list.map((p) => p.pair).join("\n");
  if (sel.dataset.sig !== sig) {
    sel.innerHTML = list.map((p) => `<option value="${escAttr(p.pair)}">${escHtml(p.displayPair)}</option>`).join("");
    sel.dataset.sig = sig;
  }
  sel.value = data.pair;
  if (newwin) newwin.href = `#/signals/pair/${encodeURIComponent(data.pair)}`;
}

function stepDrawerPair(dir) {
  const list = drawerPairList();
  if (list.length < 2) return;
  const idx = list.findIndex((p) => p.pair === state.drawerPair);
  const cur = idx === -1 ? 0 : idx;
  const nextIdx = (cur + dir + list.length) % list.length;
  nav(`#/signals/pair/${encodeURIComponent(list[nextIdx].pair)}`);
}

$("drawer-prev")?.addEventListener("click", () => stepDrawerPair(-1));
$("drawer-next")?.addEventListener("click", () => stepDrawerPair(1));
$("drawer-pairselect")?.addEventListener("change", (e) => {
  if (e.target.value) nav(`#/signals/pair/${encodeURIComponent(e.target.value)}`);
});

function renderDrawer(data) {
  $("drawer-title").textContent = data.displayPair;
  const cons = data.consensus;
  $("drawer-sub").innerHTML =
    `<span class="pill pill--${escAttr(data.category || "real")}">${escHtml((data.category || "").toUpperCase())}</span>` +
    (cons ? `<span class="pill pill--${escAttr(cons.level)}">${escHtml(cons.level)}</span>` : "") +
    `<span>${data.signals?.length || 0} ${escHtml(t("sig_count"))}</span>`;
  $("drawer-body").innerHTML = renderDrawerHtml(data);
  updateDrawerSwitcher(data);

  $$("#drawer-body [data-drawer-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.drawerTab = btn.dataset.drawerTab;
      $("drawer-body").innerHTML = renderDrawerHtml(state.drawerData);
      wireDrawerBody();
    });
  });
  $$("#drawer-body [data-drawer-row]").forEach((tr) => {
    tr.addEventListener("click", () => {
      const key = tr.dataset.drawerRow;
      if (state.expandedRows.has(key)) state.expandedRows.delete(key);
      else state.expandedRows.add(key);
      $("drawer-body").innerHTML = renderDrawerHtml(state.drawerData);
      wireDrawerBody();
    });
  });
  $("drawer-fav")?.addEventListener("click", () => {
    if (state.favorites.has(data.pair)) state.favorites.delete(data.pair);
    else state.favorites.add(data.pair);
    saveFavorites();
    $("drawer-body").innerHTML = renderDrawerHtml(state.drawerData);
    wireDrawerBody();
  });
}

function wireDrawerBody() {
  if (!state.drawerData) return;
  renderDrawer(state.drawerData);
}

// Live bits refreshed on every snapshot poll while the drawer is open.
function refreshDrawerLiveBits() {
  updateDrawerSwitcher(state.drawerData);
  renderPairStrip();
}

function renderDrawerHtml(data) {
  const clusterHistory = data.clusterHistory || [];
  const win = clusterHistory.filter((c) => c.outcome === 1).length;
  const loss = clusterHistory.filter((c) => c.outcome === 0).length;
  const graded = win + loss;
  const overallWr = graded ? Math.round((win / graded) * 1000) / 10 : null;

  const tabsHtml = DRAWER_TABS.map((tb) => {
    const st = drawerTabStats(clusterHistory.filter(tb.match));
    const active = tb.key === state.drawerTab ? " drawer-tab--active" : "";
    const wrTxt = st.graded ? `${st.winRate.toFixed(0)}%` : "—";
    const sub = st.graded ? `${st.win}W/${st.loss}L` : `${st.total}`;
    return `
      <button type="button" class="drawer-tab${active}" data-drawer-tab="${escAttr(tb.key)}" aria-pressed="${tb.key === state.drawerTab}">
        <span class="drawer-tab__name">${escHtml(tb.label)}</span>
        <span class="drawer-tab__wr wr--${wrClass(st.graded ? st.winRate : null)}">${escHtml(wrTxt)}</span>
        <span class="drawer-tab__stats">${escHtml(sub)}</span>
      </button>`;
  }).join("");

  const activeDef = DRAWER_TABS.find((tb) => tb.key === state.drawerTab) || DRAWER_TABS[0];
  const rows = clusterHistory.filter(activeDef.match);
  const st = drawerTabStats(rows);

  // Running win rate, computed oldest → newest over the ACTIVE tab's rows,
  // then flipped back to newest-first for display.
  const chrono = rows.slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let rw = 0; let rl = 0;
  const withRunning = chrono.map((c) => {
    if (c.outcome === 1) rw++;
    else if (c.outcome === 0) rl++;
    const g = rw + rl;
    return { ...c, __runningWr: g ? (rw / g) * 100 : null };
  }).sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const rowsHtml = withRunning.map((c) => {
    const key = `drawer:${data.pair}|${c.ts}`;
    const expanded = state.expandedRows.has(key);
    const prediction = c.direction || null;
    const result = c.outcome === 1 ? prediction : c.outcome === 0 ? oppositeDir(prediction) : null;
    const outcomeCls = c.outcome === 1 ? "win" : c.outcome === 0 ? "loss" : "unknown";
    const apps = (c.agreeing_apps || []).map((a) => APP_LABELS[a] || a).join(" + ") || "—";
    const detail = expanded ? `<tr class="hist-detail-row"><td colspan="7">${renderDrawerDetail(data, c, result)}</td></tr>` : "";
    return `
      <tr class="hist-row${expanded ? " hist-row--open" : ""}" data-drawer-row="${escAttr(key)}" tabindex="0" role="button" aria-expanded="${expanded}">
        <td class="mono">${escHtml(c.candleUtc || "—")}</td>
        <td class="mono">${escHtml(apps)}</td>
        <td>${prediction ? `<span class="dir dir--${escAttr(prediction)}">${escHtml(prediction)}</span>` : "—"}</td>
        <td>${result ? `<span class="dir dir--${escAttr(result)}">${escHtml(result)}</span>` : "—"}</td>
        <td><span class="outcome outcome--${outcomeCls}">${escHtml(c.outcomeLabel || "—")}</span></td>
        <td class="mono wr--${wrClass(c.__runningWr)}">${escHtml(fmtWr(c.__runningWr))}</td>
        <td class="hist-row__chev">${expanded ? "▴" : "▾"}</td>
      </tr>${detail}`;
  }).join("");

  const favBtn = state.favorites.has(data.pair)
    ? `<button class="btn btn--ghost btn--mini" id="drawer-fav">${escHtml(t("drawer_fav_remove"))}</button>`
    : `<button class="btn btn--ghost btn--mini" id="drawer-fav">${escHtml(t("drawer_fav_add"))}</button>`;

  return `
    <div class="drawer__section">
      <h3>${escHtml(t("panel_live_wr_title"))} <span class="drawer__section-count">${graded} graded · last ${data.clusterHistoryMinutes || 360} min · ${escHtml(fmtWr(overallWr))} overall</span></h3>
      <div class="drawer-tabs">${tabsHtml}</div>
    </div>
    <div class="drawer__section">
      <h3>${escHtml(activeDef.label)} <span class="drawer__section-count">${rows.length} · ${st.win}W/${st.loss}L</span></h3>
      <div class="table-wrap">
        <table class="grid-table grid-table--history">
          <thead><tr>
            <th>${escHtml(t("th_time"))}</th>
            <th>${escHtml(t("th_apps"))}</th>
            <th>${escHtml(t("th_prediction"))}</th>
            <th>${escHtml(t("th_result"))}</th>
            <th>${escHtml(t("th_wl"))}</th>
            <th>${escHtml(t("th_winrate"))}</th>
            <th aria-label="expand"></th>
          </tr></thead>
          <tbody>${rowsHtml || `<tr><td colspan="7" class="placeholder">${escHtml(t("hist_empty"))}</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="drawer__section">${favBtn}</div>`;
}

function renderDrawerDetail(data, c, consensusResult) {
  const dirs = c.app_directions || {};
  const labels = c.appOutcomeLabels || {};
  const agreeing = new Set(c.agreeing_apps || []);
  const appCards = ["app1", "app2", "app3"].map((app) => {
    const d = dirs[app];
    if (!d) {
      return `<div class="hist-app-card hist-app-card--silent">
        <span class="hist-app-card__name">${APP_LABELS[app]}</span>
        <span>— no signal</span>
      </div>`;
    }
    const lbl = labels[app] || "—";
    const cls = lbl === "WIN" ? "win" : lbl === "LOSS" ? "loss" : "unknown";
    return `<div class="hist-app-card${agreeing.has(app) ? " hist-app-card--agree" : ""}">
      <span class="hist-app-card__name">${APP_LABELS[app]}${agreeing.has(app) ? " ✓" : ""}</span>
      <span class="dir dir--${escAttr(d)}">${escHtml(d)}</span>
      <span class="outcome outcome--${cls}">${escHtml(lbl)}</span>
    </div>`;
  }).join("");
  return `
    <div class="hist-detail">
      <div class="hist-detail__head">
        <span class="hist-detail__pair">${escHtml(data.displayPair)}</span>
        <span class="mono">${escHtml(c.candleUtc || "—")} UTC</span>
        <span class="pill pill--${escAttr(c.level)}">${escHtml(c.level)}</span>
        ${c.app_subset_key ? `<span class="pill">${escHtml(c.app_subset_key)}</span>` : ""}
      </div>
      <div class="app-card-grid">${appCards}</div>
    </div>`;
}

// ======================================================================
// SETTINGS
// ======================================================================

function applySettings() {
  document.body.dataset.theme = state.settings.theme;
  document.body.dataset.tz = state.settings.tz;
  document.body.dataset.lang = state.settings.lang;
  const showUtc = state.settings.tz === "utc" || state.settings.tz === "both";
  const showLocal = state.settings.tz === "local" || state.settings.tz === "both";
  const clockUtc = $("clock-utc");
  const clockLocal = $("clock-local");
  if (clockUtc) clockUtc.style.display = showUtc ? "" : "none";
  if (clockLocal) clockLocal.style.display = showLocal ? "" : "none";
  const setSel = (id, val) => { const el = $(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = $(id); if (el) el.checked = val; };
  setSel("set-theme", state.settings.theme);
  setSel("set-lang", state.settings.lang);
  setSel("set-tz", state.settings.tz);
  setChk("set-sound", state.settings.sound);
}

const SETTINGS_INPUTS = [
  ["set-theme", "theme"],
  ["set-lang", "lang"],
  ["set-tz", "tz"],
  ["set-sound", "sound", "checkbox"],
];
SETTINGS_INPUTS.forEach(([id, key, kind]) => {
  $(id)?.addEventListener("change", () => {
    state.settings[key] = kind === "checkbox" ? $(id).checked : $(id).value;
    saveSettings();
    applySettings();
    if (key === "lang") applyTranslations();
  });
});

$("btn-clear-cache")?.addEventListener("click", () => {
  if (!confirm("Clear local cache?")) return;
  state.signalFeedIds.clear();
  location.reload();
});

$("btn-reset-settings")?.addEventListener("click", () => {
  if (!confirm("Reset all settings to defaults?")) return;
  state.settings = Object.assign({}, DEFAULT_SETTINGS);
  saveSettings();
  applySettings();
  applyTranslations();
});

// ---- Signal Sources (live URL management) ----
let sourceConfig = null;

async function loadSourcesUI() {
  const list = $("sources-list");
  if (!list) return;
  try {
    const res = await fetch("/api/sources", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    sourceConfig = await res.json();
    renderSources();
  } catch (e) {
    list.innerHTML = `<p class="placeholder placeholder--error">${escHtml(t("src_load_fail"))}: ${escHtml(e.message)}</p>`;
  }
}

function renderSources() {
  const list = $("sources-list");
  if (!list || !sourceConfig) return;
  list.innerHTML = (sourceConfig.apps || []).map((app) => {
    const a = (state.snapshot?.apps || []).find((x) => x.id === app.id);
    let dot = "dot--unknown";
    if (a) {
      if (a.health === "ok") dot = "dot--ok";
      else if (a.health === "down" || a.health === "disconnected") dot = "dot--bad";
      else dot = "dot--warn";
    }
    return `
      <div class="src-row" data-app="${escAttr(app.id)}">
        <span class="src-dot dot ${dot}"></span>
        <span class="src-row__name">${escHtml(app.shortName)}</span>
        <input type="url" inputmode="url" autocomplete="off" spellcheck="false"
               placeholder="https://<new-name>.up.railway.app"
               value="${escAttr(app.baseUrl || "")}" aria-label="${escAttr(app.shortName)} URL">
        <button class="btn btn--ghost btn--mini src-test" type="button">${escHtml(t("btn_sources_test"))}</button>
      </div>`;
  }).join("");
  $$("#sources-list .src-test").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const row = btn.closest(".src-row");
      const appId = row.dataset.app;
      const input = row.querySelector("input");
      btn.disabled = true;
      btn.textContent = "…";
      try {
        const res = await fetch("/api/sources/test", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ app: appId, baseUrl: input.value.trim() }),
        });
        const d = await res.json();
        btn.textContent = d.reachable ? t("src_test_ok") : t("src_test_fail");
      } catch (e) {
        btn.textContent = t("src_test_fail");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

$("btn-sources-save")?.addEventListener("click", async () => {
  const btn = $("btn-sources-save");
  const resultBox = $("sources-result");
  if (!btn || !sourceConfig) return;
  const apps = {};
  let changed = 0;
  $$("#sources-list .src-row").forEach((row) => {
    const id = row.dataset.app;
    const val = row.querySelector("input").value.trim();
    const cur = (sourceConfig.apps || []).find((a) => a.id === id)?.baseUrl || "";
    if (val && val !== cur) { apps[id] = { baseUrl: val }; changed++; }
  });
  if (!changed) {
    resultBox.className = "";
    resultBox.textContent = t("src_no_change");
    return;
  }
  btn.disabled = true;
  resultBox.className = "";
  resultBox.textContent = t("src_saving");
  try {
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apps, purgeCaches: [], probe: true }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || `HTTP ${res.status}`);
    sourceConfig = d.config;
    renderSources();
    const probes = Object.values(d.probes || {});
    const allOk = probes.length > 0 && probes.every((p) => p.reachable);
    resultBox.className = allOk ? "ok" : "err";
    resultBox.textContent = allOk ? t("src_saved_ok") : t("src_saved_unreachable");
    pollSnapshot();
    pollSignalFeed();
  } catch (e) {
    resultBox.className = "err";
    resultBox.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
});

$("btn-sources-reset")?.addEventListener("click", async () => {
  if (!confirm(t("src_confirm_reset"))) return;
  const resultBox = $("sources-result");
  try {
    const res = await fetch("/api/sources/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || `HTTP ${res.status}`);
    sourceConfig = d.config;
    renderSources();
    resultBox.className = "";
    resultBox.textContent = "";
    pollSnapshot();
  } catch (e) {
    resultBox.className = "err";
    resultBox.textContent = e.message;
  }
});

$("health-alert-close")?.addEventListener("click", () => {
  $("app-health-alert").hidden = true;
  state.healthAlertDismissed = true;
  state.healthAlertDismissedApps = new Set(
    (state.snapshot?.apps || []).filter(_isAppUnhealthy).map((a) => a.id ?? a.name)
  );
});

// Top-bar brand → Home.
$("topbar-brand")?.addEventListener("click", () => nav("#/home"));

// ====== Boot ======
applySettings();
applyTranslations();
loadSourcesUI();
startPolling();
// Apply the initial hash route LAST so deep links (#/signals/pair/…)
// land on exactly the view in the URL, even in a freshly opened window.
applyRoute();
