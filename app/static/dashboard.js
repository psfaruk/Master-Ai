// Master-Ai dashboard client — mobile-first, real-time, bottom-nav.
//
// Client adaptive polling: burst (1s) for the first 12s of each candle
// (when new signals are arriving) and idle (3s) for the rest of the minute.
// The SERVER's snapshot poller runs at 0.8s burst / 6s idle — the client
// polls MORE aggressively than the server refreshes, intentionally, so the
// UI stays snappy even if the data is the same snapshot. The "wasted" idle
// polls are a small price (a JSON read from cache, <50ms server-side) for
// sub-second perceived freshness when new signals land.
// The user can override this in Settings.
//
// Settings are persisted to localStorage. The server is stateless — all
// preferences live client-side.

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ====== i18n ======
// Covers the app's static chrome (nav, headers, filter/settings labels,
// buttons, placeholders) — the stuff every screen shows regardless of live
// data. Trading terminology (CALL/PUT, OTC, pair names) and anything a
// render function overwrites on every poll (status pill, live counters,
// timestamps) are deliberately left untranslated: those are either
// universal-in-English trading vocabulary or live operational readouts,
// not chrome a translation would meaningfully improve.
const TRANSLATIONS = {
  en: {
    nav_home: "Home", nav_signals: "Signals", nav_history: "History", nav_settings: "Settings",
    topbar_subtitle: "Quotex signal aggregator",
    opt_all_pairs: "All pairs", opt_otc_only: "OTC only", opt_real_only: "Real only",
    ph_search_pair: "Search pair…",
    health_alert_title: "Source app issue detected",
    hero_3agree_label: "3-Bot Agree", hero_2agree_label: "2-Bot Agree",
    hero_conflict_label: "Conflicts", hero_conflict_sub: "split direction",
    hero_single_label: "Single Only", hero_single_sub: "only one source",
    home_top_signals: "Top Signals", home_live_feed: "Live Signal Feed", home_live_tag: "real-time",
    home_consensus_accuracy: "Consensus Accuracy (last 6 hours)",
    loading_consensus: "Loading consensus…", loading_feed: "Loading feed…",
    placeholder_run_backtest_home: "Run a backtest to see per-level accuracy.",
    filter_market_type: "Market Type", filter_candle_utc: "Candle (UTC)", filter_pair_name: "Pair Name",
    filter_level: "Signal Level",
    filter_final_prediction: "Final Prediction",
    filter_app1_prediction: "App 1 Prediction", filter_app2_prediction: "App 2 Prediction", filter_app3_prediction: "App 3 Prediction",
    filter_agree: "Agree 2/3", filter_winrate60: "Win Rate (60m)", filter_freshness: "Freshness",
    opt_all: "All", opt_real: "Real", opt_missing: "Missing", opt_any: "Any", opt_any_age: "Any age",
    lvl_conflict: "Conflict", lvl_single: "Single",
    lbl_favorites: "Favorites", btn_reset: "Reset", btn_export_csv: "Export CSV",
    th_market: "Market", th_pair: "Pair", th_agree: "Agree", th_final_entry: "Final + Entry", th_winrate60: "Win Rate 60min",
    loading_ellipsis: "Loading…",
    folder_backtest_title: "Backtest", folder_backtest_desc: "Consensus accuracy over the last 6 hours",
    folder_perpair_title: "Per-Pair Stats", folder_perpair_desc: "Win rate per pair, by app combination",
    folder_apppair_title: "App Pair Leaders", folder_apppair_desc: "Which pair of apps performs best, and where",
    folder_drilldown_title: "Pair Drilldown", folder_drilldown_desc: "Candle history + signals for one pair",
    back_to_history: "Back to History",
    back_to: "Back to",
    folder_consensus_title: "Signal History",
    folder_consensus_desc: "Every saved signal, grouped by how many apps agreed — 3 Agree, 2 Agree, Conflict, Single. Tap a row for the full per-app breakdown.",
    folder_open: "Open",
    panel_consensus_title: "Signal History",
    panel_consensus_sub: "Pick an agreement level. Counts cover the last 6 hours of saved signals.",
    placeholder_loading: "Loading…",
    opt_dir_both: "Both directions",
    opt_graded_only: "Graded only",
    th_time: "Time", th_apps: "Apps", th_prediction: "Prediction", th_result: "Result",
    th_winrate: "Win Rate",
    panel_backtest_title: "Consensus Accuracy Backtest",
    placeholder_run_backtest_history: 'Click "Run fresh backtest" to fetch a verdict, or wait for the auto-cached result to appear.',
    panel_perpair_title: "Per-Pair Win Rate", th_cat: "Cat", th_overall_wl: "Overall W/L", th_win_pct: "Win %",
    placeholder_loading_perpair: "Loading per-pair stats…",
    panel_apppair_title: "App Pair Leaders", placeholder_loading_apppair: "Loading app-pair leaderboards…",
    panel_drilldown_title: "Pair Drilldown", opt_select_pair: "Select a pair…",
    placeholder_pick_pair: "Pick a pair to see its candle history + per-app signal breakdown.",
    folder_general_title: "General", folder_general_desc: "Theme, language, clock, time format",
    folder_realtime_title: "Real-time Refresh", folder_realtime_desc: "Polling mode, feed size, sound, notifications",
    folder_filters_title: "Trading Filters", folder_filters_desc: "Min win rate, freshness, conflicts, favorites",
    folder_offsets_title: "App Candle Offsets", folder_offsets_desc: "Per-app candle alignment (advanced)",
    folder_diagnostics_title: "Diagnostics", folder_diagnostics_desc: "Engineer-facing alignment diagnostics",
    folder_about_title: "Data & About", folder_about_desc: "Clear cache, reset settings, version, GitHub",
    back_to_settings: "Back to Settings",
    lbl_theme: "Theme", opt_theme_dark: "Dark (default)", opt_theme_light: "Light",
    lbl_language: "Language",
    lbl_clock_display: "Clock display", opt_tz_utc: "UTC only", opt_tz_local: "Local only", opt_tz_both: "Both UTC + Local",
    lbl_time_format: "Time format", opt_time_24: "24-hour", opt_time_12: "12-hour (AM/PM)",
    lbl_polling_mode: "Polling mode",
    opt_poll_adaptive: "Adaptive (burst 1s, idle 3s)", opt_poll_1: "Every 1 second (aggressive)",
    opt_poll_3: "Every 3 seconds", opt_poll_5: "Every 5 seconds", opt_poll_10: "Every 10 seconds (battery saver)",
    lbl_feed_size: "Signal feed size", opt_feed_20: "20 items", opt_feed_50: "50 items", opt_feed_100: "100 items",
    lbl_sound: "Sound on 3-agree", lbl_notify: "Browser notifications",
    lbl_min_wr: "Min win rate %", lbl_only_fresh: "Hide signals older than (sec)", lbl_hide_conflicts: "Hide conflicts",
    placeholder_no_favorites: "No favorites yet — tap ★ next to a pair.",
    hint_offsets_1: "Per-app candle offset, in whole candles. Set this only if /api/diag reports a consistent non-zero offset between two apps.",
    lbl_off1: "App 1 (Minimum Pair)", lbl_off2: "App 2 (Binary Signal)", lbl_off3: "App 3 (OTC Live)",
    opt_offset_default: "0 (default)",
    hint_offsets_2: "Note: changing offsets here is informational only — to actually apply offsets server-side, set the APP1/2/3_CANDLE_OFFSET environment variables on Railway.",
    hint_diagnostics: "Engineer-facing alignment diagnostics. Hidden from the main navigation but kept here for power users.",
    btn_load_diagnostics: "Load diagnostics",
    btn_clear_cache: "Clear local cache", btn_reset_settings: "Reset settings",
    folder_overall_title: "Overall Win Rate", folder_overall_desc: "Win rate for App 1, App 2, App 3 and every combination (1+2, 1+3, 2+3, all 3) — tap to drill into per-pair breakdown.",
    folder_open: "Open",
    panel_overall_title: "Overall Win Rate",
    placeholder_loading_overall: "Loading overall win rate…",
    th_signals: "Signals", th_wl: "W/L", th_action: "History",
    placeholder_loading_subsetpairs: "Loading…",
    folder_sources_title: "Signal Sources", folder_sources_desc: "Connect redeployed Railway app URLs — live, no code change",
    hint_sources_intro: "Paste each app's new Railway URL after a redeploy, then Save & Reconnect — signals reconnect in seconds, no code change. Any URL shape works: bare host, with https://, or a full endpoint URL.",
    lbl_sources_purge: "Also clear cached history from the previous URLs",
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
  },
  bn: {
    nav_home: "হোম", nav_signals: "সিগন্যাল", nav_history: "হিস্ট্রি", nav_settings: "সেটিংস",
    topbar_subtitle: "Quotex সিগন্যাল অ্যাগ্রিগেটর",
    opt_all_pairs: "সকল পেয়ার", opt_otc_only: "শুধু OTC", opt_real_only: "শুধু রিয়েল",
    ph_search_pair: "পেয়ার খুঁজুন…",
    health_alert_title: "সোর্স অ্যাপে সমস্যা সনাক্ত হয়েছে",
    hero_3agree_label: "৩-বট একমত", hero_2agree_label: "২-বট একমত",
    hero_conflict_label: "দ্বন্দ্ব", hero_conflict_sub: "বিভক্ত দিক",
    hero_single_label: "শুধু একক", hero_single_sub: "শুধু একটি সোর্স",
    home_top_signals: "শীর্ষ সিগন্যাল", home_live_feed: "লাইভ সিগন্যাল ফিড", home_live_tag: "রিয়েল-টাইম",
    home_consensus_accuracy: "কনসেনসাস নির্ভুলতা (গত ৬ ঘণ্টা)",
    loading_consensus: "কনসেনসাস লোড হচ্ছে…", loading_feed: "ফিড লোড হচ্ছে…",
    placeholder_run_backtest_home: "প্রতি-স্তরের নির্ভুলতা দেখতে একটি ব্যাকটেস্ট চালান।",
    filter_market_type: "মার্কেট টাইপ", filter_candle_utc: "ক্যান্ডেল (UTC)", filter_pair_name: "পেয়ারের নাম",
    filter_level: "সিগন্যাল লেভেল",
    filter_final_prediction: "চূড়ান্ত পূর্বাভাস",
    filter_app1_prediction: "অ্যাপ ১ পূর্বাভাস", filter_app2_prediction: "অ্যাপ ২ পূর্বাভাস", filter_app3_prediction: "অ্যাপ ৩ পূর্বাভাস",
    filter_agree: "একমত ২/৩", filter_winrate60: "জয়ের হার (৬০ মি)", filter_freshness: "সতেজতা",
    opt_all: "সব", opt_real: "রিয়েল", opt_missing: "অনুপস্থিত", opt_any: "যেকোনো", opt_any_age: "যেকোনো বয়স",
    lvl_conflict: "দ্বন্দ্ব", lvl_single: "একক",
    lbl_favorites: "ফেভারিট", btn_reset: "রিসেট", btn_export_csv: "CSV এক্সপোর্ট",
    th_market: "মার্কেট", th_pair: "পেয়ার", th_agree: "একমত", th_final_entry: "চূড়ান্ত + এন্ট্রি", th_winrate60: "জয়ের হার ৬০মি",
    loading_ellipsis: "লোড হচ্ছে…",
    folder_backtest_title: "ব্যাকটেস্ট", folder_backtest_desc: "গত ৬ ঘণ্টার কনসেনসাস নির্ভুলতা",
    folder_perpair_title: "প্রতি-পেয়ার পরিসংখ্যান", folder_perpair_desc: "প্রতি পেয়ারে জয়ের হার, অ্যাপ সমন্বয় অনুযায়ী",
    folder_apppair_title: "অ্যাপ পেয়ার লিডার", folder_apppair_desc: "কোন অ্যাপ জোড়া সবচেয়ে ভালো পারফর্ম করে, এবং কোথায়",
    folder_drilldown_title: "পেয়ার ড্রিলডাউন", folder_drilldown_desc: "একটি পেয়ারের ক্যান্ডেল হিস্ট্রি + সিগন্যাল",
    back_to_history: "হিস্ট্রিতে ফিরে যান",
    back_to: "ফিরে যান",
    folder_consensus_title: "সিগন্যাল হিস্ট্রি",
    folder_consensus_desc: "সেভ হওয়া সব সিগন্যাল — কয়টি অ্যাপ একমত হয়েছে সেই অনুযায়ী সাজানো: ৩টি একমত, ২টি একমত, দ্বন্দ্ব, একক। বিস্তারিত দেখতে যেকোনো রো-তে ট্যাপ করুন।",
    folder_open: "খুলুন",
    panel_consensus_title: "সিগন্যাল হিস্ট্রি",
    panel_consensus_sub: "একটি একমত-স্তর বেছে নিন। সংখ্যাগুলো গত ৬ ঘণ্টার সেভ করা সিগন্যাল থেকে।",
    placeholder_loading: "লোড হচ্ছে…",
    opt_dir_both: "উভয় দিক",
    opt_graded_only: "শুধু গ্রেড হওয়া",
    th_time: "সময়", th_apps: "অ্যাপ", th_prediction: "প্রেডিকশন", th_result: "ফলাফল",
    th_winrate: "জয়ের হার",
    panel_backtest_title: "কনসেনসাস নির্ভুলতা ব্যাকটেস্ট",
    placeholder_run_backtest_history: '"Run fresh backtest"-এ ক্লিক করে ফলাফল আনুন, অথবা অটো-ক্যাশড ফলাফলের জন্য অপেক্ষা করুন।',
    panel_perpair_title: "প্রতি-পেয়ার জয়ের হার", th_cat: "ক্যাট", th_overall_wl: "সর্বমোট জয়/হার", th_win_pct: "জয় %",
    placeholder_loading_perpair: "প্রতি-পেয়ার পরিসংখ্যান লোড হচ্ছে…",
    panel_apppair_title: "অ্যাপ পেয়ার লিডার", placeholder_loading_apppair: "অ্যাপ-পেয়ার লিডারবোর্ড লোড হচ্ছে…",
    panel_drilldown_title: "পেয়ার ড্রিলডাউন", opt_select_pair: "একটি পেয়ার বেছে নিন…",
    placeholder_pick_pair: "ক্যান্ডেল হিস্ট্রি ও প্রতি-অ্যাপ সিগন্যাল দেখতে একটি পেয়ার বেছে নিন।",
    folder_general_title: "সাধারণ", folder_general_desc: "থিম, ভাষা, ঘড়ি, সময় ফরম্যাট",
    folder_realtime_title: "রিয়েল-টাইম রিফ্রেশ", folder_realtime_desc: "পোলিং মোড, ফিড সাইজ, সাউন্ড, নোটিফিকেশন",
    folder_filters_title: "ট্রেডিং ফিল্টার", folder_filters_desc: "সর্বনিম্ন জয়ের হার, সতেজতা, দ্বন্দ্ব, ফেভারিট",
    folder_offsets_title: "অ্যাপ ক্যান্ডেল অফসেট", folder_offsets_desc: "প্রতি-অ্যাপ ক্যান্ডেল অ্যালাইনমেন্ট (অ্যাডভান্সড)",
    folder_diagnostics_title: "ডায়াগনস্টিকস", folder_diagnostics_desc: "ইঞ্জিনিয়ার-কেন্দ্রিক অ্যালাইনমেন্ট ডায়াগনস্টিকস",
    folder_about_title: "ডেটা ও সম্পর্কে", folder_about_desc: "ক্যাশ মুছুন, সেটিংস রিসেট করুন, ভার্সন, GitHub",
    back_to_settings: "সেটিংসে ফিরে যান",
    lbl_theme: "থিম", opt_theme_dark: "ডার্ক (ডিফল্ট)", opt_theme_light: "লাইট",
    lbl_language: "ভাষা",
    lbl_clock_display: "ঘড়ি প্রদর্শন", opt_tz_utc: "শুধু UTC", opt_tz_local: "শুধু স্থানীয়", opt_tz_both: "UTC + স্থানীয় উভয়ই",
    lbl_time_format: "সময় ফরম্যাট", opt_time_24: "২৪-ঘণ্টা", opt_time_12: "১২-ঘণ্টা (AM/PM)",
    lbl_polling_mode: "পোলিং মোড",
    opt_poll_adaptive: "অ্যাডাপ্টিভ (বার্স্ট ১সে, আইডল ৩সে)", opt_poll_1: "প্রতি ১ সেকেন্ড (অ্যাগ্রেসিভ)",
    opt_poll_3: "প্রতি ৩ সেকেন্ড", opt_poll_5: "প্রতি ৫ সেকেন্ড", opt_poll_10: "প্রতি ১০ সেকেন্ড (ব্যাটারি সাশ্রয়ী)",
    lbl_feed_size: "সিগন্যাল ফিড সাইজ", opt_feed_20: "২০টি আইটেম", opt_feed_50: "৫০টি আইটেম", opt_feed_100: "১০০টি আইটেম",
    lbl_sound: "৩-একমতে সাউন্ড", lbl_notify: "ব্রাউজার নোটিফিকেশন",
    lbl_min_wr: "সর্বনিম্ন জয়ের হার %", lbl_only_fresh: "কত সেকেন্ডের পুরনো সিগন্যাল লুকাবে", lbl_hide_conflicts: "দ্বন্দ্ব লুকান",
    placeholder_no_favorites: "এখনও কোনো ফেভারিট নেই — একটি পেয়ারের পাশে ★ ট্যাপ করুন।",
    hint_offsets_1: "প্রতি-অ্যাপ ক্যান্ডেল অফসেট, পূর্ণ ক্যান্ডেলে। শুধুমাত্র তখনই সেট করুন যখন /api/diag দুটি অ্যাপের মধ্যে একটি ধারাবাহিক নন-জিরো অফসেট রিপোর্ট করে।",
    lbl_off1: "অ্যাপ ১ (Minimum Pair)", lbl_off2: "অ্যাপ ২ (Binary Signal)", lbl_off3: "অ্যাপ ৩ (OTC Live)",
    opt_offset_default: "০ (ডিফল্ট)",
    hint_offsets_2: "নোট: এখানে অফসেট পরিবর্তন শুধুই তথ্যগত — সার্ভার-সাইডে প্রকৃতপক্ষে অফসেট প্রয়োগ করতে Railway-তে APP1/2/3_CANDLE_OFFSET এনভায়রনমেন্ট ভেরিয়েবল সেট করুন।",
    hint_diagnostics: "ইঞ্জিনিয়ার-কেন্দ্রিক অ্যালাইনমেন্ট ডায়াগনস্টিকস। মূল নেভিগেশন থেকে লুকানো কিন্তু পাওয়ার ইউজারদের জন্য এখানে রাখা হয়েছে।",
    btn_load_diagnostics: "ডায়াগনস্টিকস লোড করুন",
    btn_clear_cache: "লোকাল ক্যাশ মুছুন", btn_reset_settings: "সেটিংস রিসেট করুন",
    folder_overall_title: "সর্বমোট জয়ের হার", folder_overall_desc: "অ্যাপ ১, অ্যাপ ২, অ্যাপ ৩ এবং প্রতিটি সমন্বয়ের (১+২, ১+৩, ২+৩, সব ৩) জয়ের হার — প্রতি-পেয়ার বিস্তারিত দেখতে ট্যাপ করুন।",
    folder_open: "খুলুন",
    panel_overall_title: "সর্বমোট জয়ের হার",
    placeholder_loading_overall: "সর্বমোট জয়ের হার লোড হচ্ছে…",
    th_signals: "সিগন্যাল", th_wl: "জয়/হার", th_action: "হিস্ট্রি",
    placeholder_loading_subsetpairs: "লোড হচ্ছে…",
    folder_sources_title: "সিগন্যাল সোর্স", folder_sources_desc: "রিডিপ্লয় হওয়া Railway অ্যাপের URL যুক্ত করুন — লাইভ, কোড ছাড়াই",
    hint_sources_intro: "রিডিপ্লয়ের পর প্রতিটি অ্যাপের নতুন Railway URL পেস্ট করে Save & Reconnect চাপুন — কয়েক সেকেন্ডেই সিগন্যাল সংযোগ হয়ে যাবে, কোনো কোড লাগবে না। যেকোনো ফরম্যাট চলবে: শুধু হোস্ট, https:// সহ, বা সম্পূর্ণ এন্ডপয়েন্ট URL।",
    lbl_sources_purge: "আগের URL থেকে জমা হওয়া ক্যাশড হিস্ট্রিও মুছে ফেলুন",
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
  activeHistorySubtab: "consensus",
  // Breadcrumb / back-button stack for the History tab tree. Each entry is
  // { name, opts, label }. Back pops one level instead of jumping to the
  // top, and the breadcrumb renders the whole path.
  historyStack: [],
  // Currently-open agreement level on History → Signal History
  // ("3-agree" | "2-agree" | "conflict" | "1-only").
  activeConsensusLevel: "3-agree",
  // Last /api/consensus-history payload, keyed so filter changes can
  // re-render without a refetch when only the client-side view changed.
  consensusHistory: null,
  // Candle keys (`pair|ts`) whose inline detail row is expanded.
  expandedHistoryRows: new Set(),
  // Currently-selected app subset on the History → Overall Win Rate →
  // per-subset pair list view. Set when the user taps a card in the
  // Overall Win Rate grid; read by renderSubsetPairList().
  activeSubset: null,
  // Cached payload from /api/app-pair-leaders so the Overall Win Rate
  // view can re-render without an extra round-trip on every History
  // tab open.
  cachedAppPairLeaders: null,
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
  healthAlertDismissedApps: new Set(), // app ids/names that were bad at dismissal time
};

// ====== Out-of-order async-render guard ======
// Several views fetch data and then paint it into a shared container. Two
// rapid taps (e.g. "3 Agree" then "2 Agree") start two fetches; if the FIRST
// response lands LAST it overwrites the newer view — the title says one
// thing while the rows belong to another. Each guarded view takes a ticket
// when it starts and only paints if its ticket is still the current one.
const _renderTickets = {};
function nextTicket(slot) {
  _renderTickets[slot] = (_renderTickets[slot] || 0) + 1;
  return _renderTickets[slot];
}
function ticketStillCurrent(slot, n) {
  return _renderTickets[slot] === n;
}

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
  // Translations are now triggered explicitly by the lang-change handler
  // in the settingsInputs block — re-translating 153 [data-i18n] elements
  // on every settings change was wasted work. (REVIEW-2 M46.)
  // Show/hide clock blocks
  const showUtc = state.settings.tz === "utc" || state.settings.tz === "both";
  const showLocal = state.settings.tz === "local" || state.settings.tz === "both";
  const clockUtcEl = $("clock-utc"); if (clockUtcEl) clockUtcEl.style.display = showUtc ? "" : "none";
  const clockLocalEl = $("clock-local"); if (clockLocalEl) clockLocalEl.style.display = showLocal ? "" : "none";
  // Populate settings inputs — use ?.() null-safe form so a missing
  // element (HTML edits) doesn't throw and halt the rest of applySettings.
  // (REVIEW-2 M2, partial.)
  const setSel = (id, val) => { const el = $(id); if (el) el.value = val; };
  const setChk = (id, val) => { const el = $(id); if (el) el.checked = val; };
  setSel("set-theme", state.settings.theme);
  setSel("set-lang", state.settings.lang);
  setSel("set-tz", state.settings.tz);
  setSel("set-timefmt", state.settings.timeFmt);
  setSel("set-poll", state.settings.poll);
  setSel("set-feed-size", state.settings.feedSize);
  setChk("set-sound", state.settings.sound);
  setChk("set-notify", state.settings.notify);
  setSel("set-min-wr", state.settings.minWr);
  setSel("set-only-fresh", state.settings.onlyFresh);
  setChk("set-hide-conflicts", state.settings.hideConflicts);
  setSel("set-off1", state.settings.app1Offset);
  setSel("set-off2", state.settings.app2Offset);
  setSel("set-off3", state.settings.app3Offset);
  renderFavorites();
}

// ====== Bottom nav + tab switching ======
// Both navigation rails (mobile bottom nav + desktop sidebar) carry a
// data-tab attribute and are wired through the same handler.
$$(".bottomnav__item, .sidenav__item").forEach((btn) => {
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
  $$(".bottomnav__item, .sidenav__item").forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle("bottomnav__item--active", on && b.classList.contains("bottomnav__item"));
    b.classList.toggle("sidenav__item--active", on && b.classList.contains("sidenav__item"));
  });
  $$(".tab-panel").forEach((p) => p.classList.toggle("tab-panel--active", p.id === `tab-${name}`));
  if (name === "signals") renderPairTable();
  if (name === "home") refreshBacktestStatus();
  if (name === "history") {
    resetFolderView("history-folder-grid", "history-folder-detail");
    state.historyStack = [];
    state.expandedHistoryRows.clear();
    // Re-entering the History tab shows the folder GRID — drop any stale
    // sub-tab so the poller's refreshBacktestStatus() doesn't fire a hidden
    // live backtest fetch (and paint it into a panel nobody is looking at).
    state.activeHistorySubtab = "";
    renderHistoryBreadcrumb();
    populateHistoryPairSelector();
    renderPerPairTable();
    refreshBacktestStatus();
    // Pre-warm the two headline screens so tapping their folder cards
    // shows data immediately instead of a "Loading…" flash.
    renderConsensusLevels();
    renderOverallWinRate();
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
    historyNavReset();
    switchHistorySubtab(card.dataset.folder);
    window.scrollTo(0, 0);
  });
});

// ---- History nav stack ----------------------------------------------------
// The History tab is a tree, not a flat list of sub-tabs:
//
//   History (folder grid)
//     └── Signal History          → level picker (3-agree / 2-agree / ...)
//           └── 3 Agree           → candle list
//                 └── row tap     → inline per-app detail
//     └── Overall Win Rate        → 7 subset cards
//           └── App 1 + App 2     → per-pair list
//
// Previously every view just flipped `history-panel--active` and the single
// back button always jumped straight to the top — so drilling three levels
// deep and pressing Back lost all context ("sequence thik nai"). We now
// keep an explicit stack: Back pops ONE level, and a breadcrumb shows the
// full path.
const HISTORY_LABELS = {
  consensus: "Signal History",
  consensuslist: "Signals",
  overall: "Overall Win Rate",
  subsetpairs: "Pairs",
  backtest: "Backtest",
  perpair: "Per-Pair Stats",
  apppair: "App Pair Leaders",
  drilldown: "Pair Drilldown",
};

function historyNavReset() {
  state.historyStack = [];
  $("history-folder-grid").hidden = true;
  $("history-folder-detail").hidden = false;
}

function historyNavLabel(entry) {
  if (entry.label) return entry.label;
  return HISTORY_LABELS[entry.name] || entry.name;
}

function renderHistoryBreadcrumb() {
  const el = $("history-breadcrumb");
  if (!el) return;
  const stack = state.historyStack || [];
  const crumbs = [{ name: "__root__", label: t("nav_history") }].concat(stack);
  el.innerHTML = crumbs
    .map((c, i) => {
      const last = i === crumbs.length - 1;
      const label = c.name === "__root__" ? c.label : historyNavLabel(c);
      const sep = i === 0 ? "" : '<span class="breadcrumb__sep">/</span>';
      if (last) return `${sep}<span class="breadcrumb__current">${escHtml(label)}</span>`;
      return `${sep}<button type="button" class="breadcrumb__link" data-crumb="${i}">${escHtml(label)}</button>`;
    })
    .join("");
  $$("[data-crumb]", el).forEach((btn) => {
    btn.addEventListener("click", () => historyNavTo(Number(btn.dataset.crumb)));
  });

  // Back button label mirrors the parent crumb so the user knows where
  // Back will land BEFORE pressing it.
  const backLabel = $("history-back-label");
  if (backLabel) {
    const parent = crumbs[crumbs.length - 2];
    backLabel.textContent = parent && parent.name !== "__root__"
      ? `${t("back_to")} ${historyNavLabel(parent)}`
      : t("back_to_history");
  }
}

// Jump to crumb index `i` (0 = the folder grid).
function historyNavTo(i) {
  if (i <= 0) {
    resetFolderView("history-folder-grid", "history-folder-detail");
    state.historyStack = [];
    renderHistoryBreadcrumb();
    window.scrollTo(0, 0);
    return;
  }
  const stack = (state.historyStack || []).slice(0, i);
  const target = stack[stack.length - 1];
  state.historyStack = stack.slice(0, -1);
  switchHistorySubtab(target.name, target.opts || {});
  window.scrollTo(0, 0);
}

function historyNavBack() {
  const stack = state.historyStack || [];
  historyNavTo(stack.length - 1);
}

$("history-folder-back")?.addEventListener("click", historyNavBack);

function switchHistorySubtab(name, opts = {}) {
  state.activeHistorySubtab = name;
  // Push onto the nav stack unless we are re-entering the view we're
  // already on (which happens on re-render / filter change).
  const stack = state.historyStack || (state.historyStack = []);
  const top = stack[stack.length - 1];
  if (!top || top.name !== name || JSON.stringify(top.opts || {}) !== JSON.stringify(opts)) {
    stack.push({ name, opts, label: opts.label });
  }
  $$(".history-panel").forEach((p) => p.classList.toggle("history-panel--active", p.id === `history-${name}`));
  renderHistoryBreadcrumb();
  if (name === "consensus") renderConsensusLevels();
  if (name === "consensuslist") renderConsensusList(opts.level || state.activeConsensusLevel);
  if (name === "overall") renderOverallWinRate();
  if (name === "subsetpairs") renderSubsetPairList(opts.subset || state.activeSubset);
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
// Every wired dropdown registers itself here so labels can be re-synced
// from their menu's selected item — needed after a language switch, when
// applyTranslations() rewrites the <li> texts but the trigger labels would
// otherwise keep showing the old language until the next click.
const _dropdownRegistry = [];

function resyncDropdownLabels() {
  _dropdownRegistry.forEach(({ menuId, labelId }) => {
    const menu = $(menuId);
    if (!menu) return;
    const sel = menu.querySelector("li.is-selected") || menu.querySelector("li");
    const label = $(labelId);
    if (sel && label) label.textContent = sel.textContent.trim();
  });
}

// Reset ONE dropdown filter menu back to its default item and re-read its
// label from the (data-i18n translated) DOM. Used by the active-filter tag
// ✕ buttons — they used to set the label to a hardcoded English "All"/"Any"
// and leave the menu item itself still marked selected, desyncing the
// dropdown from the actual filter state.
function resetMenuSelection(menuId) {
  const menu = $(menuId);
  if (!menu) return;
  const first = menu.querySelector('li[data-value=""]') || menu.querySelector("li");
  if (!first) return;
  menu.querySelectorAll("li").forEach((l) => l.classList.toggle("is-selected", l === first));
  const labelId = menuId.replace("-menu", "-label");
  const lbl = $(labelId);
  if (lbl) lbl.textContent = first.textContent.trim();
}

function wireDropdown(triggerId, menuId, labelId, onSelect) {
  const trigger = $(triggerId);
  const menu = $(menuId);
  const label = $(labelId);
  if (!trigger || !menu) return;
  _dropdownRegistry.push({ menuId, labelId });
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

// ---- Category filter (single source of truth for BOTH dropdowns) ----
// The top bar and the Signals filter grid each have a category dropdown;
// they previously updated their labels independently, so the two controls
// could show different selections for the same filter, and changing the
// top-bar one skipped the active-filter tags. All changes now flow through
// setCategoryFilter() which keeps labels, selection state, the table, the
// per-pair stats, the tags and any open Signal History view in sync.
function syncCategoryLabels() {
  [["cat-menu", "cat-label"], ["cat-menu2", "cat-label2"]].forEach(([menuId, labelId]) => {
    const menu = $(menuId);
    if (!menu) return;
    const match = Array.from(menu.querySelectorAll("li"))
      .find((li) => (li.dataset.value || "") === filters.category)
      || menu.querySelector('li[data-value=""]');
    if (!match) return;
    menu.querySelectorAll("li").forEach((l) => l.classList.toggle("is-selected", l === match));
    const label = $(labelId);
    if (label) label.textContent = match.textContent.trim();
  });
}

function setCategoryFilter(v) {
  filters.category = v;
  syncCategoryLabels();
  renderPairTable();
  renderPerPairTable();
  renderActiveFilterTags();
  // Signal History applies the category filter server-side — refresh
  // whichever history view is open so the filter takes effect there too.
  if (state.activeTab === "history") {
    if (state.activeHistorySubtab === "consensus") renderConsensusLevels();
    else if (state.activeHistorySubtab === "consensuslist") renderConsensusList(state.activeConsensusLevel);
  }
}

wireDropdown("cat-trigger", "cat-menu", "cat-label", setCategoryFilter);
wireDropdown("cat-trigger2", "cat-menu2", "cat-label2", setCategoryFilter);
wireDropdown("level-trigger", "level-menu", "level-label", (v) => { filters.level = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("dir-trigger", "dir-menu", "dir-label", (v) => { filters.direction = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("agree-trigger", "agree-menu", "agree-label", (v) => { filters.agreeCount = parseInt(v, 10) || 0; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("app1-trigger", "app1-menu", "app1-label", (v) => { filters.app1Dir = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("app2-trigger", "app2-menu", "app2-label", (v) => { filters.app2Dir = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("app3-trigger", "app3-menu", "app3-label", (v) => { filters.app3Dir = v; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("wr60-trigger", "wr60-menu", "wr60-label", (v) => { filters.wr60Min = parseFloat(v) || 0; renderPairTable(); renderActiveFilterTags(); });
wireDropdown("fresh-trigger", "fresh-menu", "fresh-label", (v) => { filters.freshSec = parseInt(v, 10) || 0; renderPairTable(); renderActiveFilterTags(); });

// Signals-tab pair search (separate from top-bar search, kept in sync both ways)
$("filter-pair-sp")?.addEventListener("input", (e) => {
  filters.search = e.target.value;
  const si = $("search-input"); if (si) si.value = e.target.value;
  renderPairTable(); renderActiveFilterTags();
});
// Top-bar search also drives the signals filter (for convenience)
$("search-input")?.addEventListener("input", (e) => {
  filters.search = e.target.value;
  const sp = $("filter-pair-sp"); if (sp) sp.value = e.target.value;
  renderPairTable(); renderActiveFilterTags();
});
$("favorites-only")?.addEventListener("change", (e) => { filters.favoritesOnly = e.target.checked; renderPairTable(); renderActiveFilterTags(); });

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
  // Reset visible labels of all dropdowns (category via the shared sync so
  // BOTH category dropdowns — top bar + filter grid — agree again). The
  // other menus get their selection cleared and labels re-read from the
  // menu's default item, so the reset text matches the active language
  // (hardcoded "All"/"Any" used to leak English into the Bengali UI).
  const clearMenuSelection = (menuId) => {
    const menu = $(menuId);
    if (!menu) return;
    const first = menu.querySelector('li[data-value=""]') || menu.querySelector("li");
    menu.querySelectorAll("li").forEach((l) => l.classList.toggle("is-selected", l === first));
  };
  syncCategoryLabels();
  ["level-menu", "dir-menu", "agree-menu", "app1-menu", "app2-menu", "app3-menu", "wr60-menu", "fresh-menu"]
    .forEach(clearMenuSelection);
  resyncDropdownLabels();
  // Reset search inputs + checkbox
  const sp = $("filter-pair-sp"); if (sp) sp.value = "";
  const searchInput = $("search-input"); if (searchInput) searchInput.value = "";
  const favOnly = $("favorites-only"); if (favOnly) favOnly.checked = false;
  renderPairTable();
  renderActiveFilterTags();
});

// Export CSV — dumps exactly the filtered + sorted rows currently on
// screen (the full set, not just the 200-row render cap) so the export
// always matches what the user is looking at.
$("btn-export-csv")?.addEventListener("click", exportSignalsCsv);

function exportSignalsCsv() {
  const rows = state._lastFilteredRows || [];
  if (rows.length === 0) {
    alert("No rows to export — adjust your filters first.");
    return;
  }
  const csvEscape = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const headers = ["Market", "Candle (UTC)", "Pair", "App 1", "App 2", "App 3", "Agree", "Final", "Win Rate 60min (%)", "Graded (60min)"];
  const lines = [headers.map(csvEscape).join(",")];
  rows.forEach((r) => {
    lines.push([
      r.pair.category,
      r.candleUtc,
      r.pair.displayPair,
      r.app1Dir || "",
      r.app2Dir || "",
      r.app3Dir || "",
      `${r.agreeCount}/3`,
      r.finalDir || "",
      r.winRate60Min == null ? "" : r.winRate60Min.toFixed(1),
      r.gradedTotal60Min || 0,
    ].map(csvEscape).join(","));
  });
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `master-ai-signals-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ====== Adaptive polling ======
// Shared constants with the backend's snapshot_poller.py (where applicable).
// The backend ships BURST_WINDOW_SEC=12, BURST_INTERVAL_SEC=0.8,
// IDLE_INTERVAL_SEC=6.0. The client uses 1s/3s — intentionally polling
// more aggressively than the server refreshes for snappy UI (see the
// file header comment). (REVIEW-2 L4 / H1.)
const POLL_BURST_WINDOW_SEC = 12;
const POLL_BURST_INTERVAL_MS = 1000;
const POLL_IDLE_INTERVAL_MS = 3000;

function nextPollGapMs() {
  if (state.settings.poll !== "adaptive") {
    return parseInt(state.settings.poll, 10) * 1000;
  }
  const secIntoCandle = Math.floor(Date.now() / 1000) % 60;
  return secIntoCandle < POLL_BURST_WINDOW_SEC ? POLL_BURST_INTERVAL_MS : POLL_IDLE_INTERVAL_MS;
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
  // Fetches on every tab (not just Home/Signals) — sound/browser-notification
  // settings promise to alert on new 3-agree signals regardless of what the
  // user is looking at; gating this on activeTab silently broke that promise
  // the moment someone opened History or Settings. The endpoint just reads
  // the already-cached snapshot server-side, so polling it from every tab
  // costs nothing extra upstream.
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
  updateSourceDots();
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

  const badApps = apps.filter((a) => _isAppUnhealthy(a));

  // If the user dismissed it this session, don't show again unless a NEW
  // app (one that wasn't already bad at dismissal time) has gone bad.
  if (state.healthAlertDismissed) {
    const dismissedIds = state.healthAlertDismissedApps || new Set();
    const hasNewBadApp = badApps.some((a) => !dismissedIds.has(a.id ?? a.name));
    if (badApps.length === 0 || !hasNewBadApp) {
      alertEl.hidden = true;
      if (badApps.length === 0) state.healthAlertDismissed = false;
      return;
    }
    // A different app is now unhealthy — re-show for it.
    state.healthAlertDismissed = false;
  }

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
// Animate numeric changes (count-up) instead of hard-swapping the text —
// during the candle-open burst the counts can jump by several at once and
// the movement makes the change noticeable without being distracting.
// Respects prefers-reduced-motion.
function animateHeroValue(el, to) {
  const from = parseInt(el.dataset.value || "0", 10) || 0;
  el.dataset.value = String(to);
  const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || from === to) { el.textContent = String(to); return; }
  const dur = 450;
  const t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = String(Math.round(from + (to - from) * eased));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Each hero card jumps to the Signals tab pre-filtered to that agreement
// level — one tap from "how many 3-agree signals are there?" to the list.
const HERO_LEVELS = ["3-agree", "2-agree", "conflict", "1-only"];

function renderHeroStats(summary) {
  animateHeroValue($("stat-3agree"), summary.threeBotAgree.length);
  animateHeroValue($("stat-2agree"), summary.twoBotAgree.length);
  animateHeroValue($("stat-conflict"), summary.conflicts.length);
  animateHeroValue($("stat-single"), summary.singleOnly.length);
  // Don't override the i18n-translatable "across all pairs" sub-text with
  // a timestamp. The timestamp is already surfaced in the Top Signals panel
  // meta + in the topbar clock. Previously this overwrote the data-i18n
  // copy with `fmtTime(now, false)`, making the "across all pairs" text
  // dead and the hero cards' subtitle visually noisy. (REVIEW-2 M3.)
}

function wireHeroCards() {
  $$(".hero").forEach((hero, i) => {
    hero.setAttribute("role", "button");
    hero.setAttribute("tabindex", "0");
    const jump = () => {
      filters.level = HERO_LEVELS[i] || "";
      const menu = $("level-menu");
      if (menu) {
        // Mark the menu item and read its (data-i18n translated) text for
        // the trigger label — the old `lbl.textContent = filters.level || "All"`
        // showed the raw internal value ("conflict", "1-only") and leaked
        // hardcoded English into the Bengali UI.
        const match = Array.from(menu.querySelectorAll("li")).find((l) => (l.dataset.value || "") === filters.level)
          || menu.querySelector('li[data-value=""]');
        menu.querySelectorAll("li").forEach((l) => l.classList.toggle("is-selected", l === match));
        const lbl = $("level-label");
        if (lbl && match) lbl.textContent = match.textContent.trim();
      }
      renderActiveFilterTags();
      switchTab("signals");
    };
    hero.addEventListener("click", jump);
    hero.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); jump(); }
    });
  });
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
          <span class="card__title">${escHtml(a.name)}</span>
          <span class="card__accent card__accent--${accent}"></span>
        </div>
        <div class="card__metric">${a.signalCount} <span>signals</span></div>
        <div class="card__detail">${escHtml(a.detail || a.health || "—")}</div>
        <div class="card__latency">latency ${latency}${uptime ? ` · up ${uptime}` : ""}${a.activeStreams != null ? ` · ${a.activeStreams} streams` : ""}</div>
        <div style="margin-top:8px;">
          <span class="card__health ${healthCls}">${escHtml(a.health || "unknown")}</span>
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
  // `highlights` is already filtered to just 3-agree + 2-agree above, so
  // `p.consensus.level !== "conflict"` is always true here. The hideConflicts
  // setting affects the Signals tab table (renderPairTable), not the Home
  // tab's top-signal strip — drop the dead filter. (REVIEW-2 M4.)
  highlights = highlights.slice(0, 8);
  // Keep the header meta fresh even when there is nothing to highlight —
  // the early return below used to freeze "N pairs · HH:MM" at the last
  // non-empty snapshot (or "—" forever on a cold start).
  $("home-meta").textContent = `${pairs.length} pairs · ${fmtTime(new Date(state.snapshot.timestamp), false)}`;
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

  // Kept for Export CSV — always the full filtered+sorted set, not just the
  // first 200 rows the table itself renders.
  state._lastFilteredRows = rows;

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
    // A Level=Conflict filter combined with the global "Hide conflicts"
    // setting always nets zero rows with no visible explanation — surface
    // the actual cause instead of a generic empty state, and offer a
    // one-tap fix instead of sending the user hunting through Settings.
    const conflictHidden = filters.level === "conflict" && state.settings.hideConflicts;
    body.innerHTML = conflictHidden
      ? `<tr><td colspan="11" class="sp-placeholder"><i class="fas fa-eye-slash" style="font-size:32px;display:block;margin-bottom:10px;opacity:0.3"></i>Level filter is set to "Conflict", but Settings → Trading Filters has "Hide conflicts" turned on — so every conflict row is being filtered out.<br><button class="sp-btn sp-btn-reset" id="btn-show-conflicts-hint" type="button" style="margin-top:10px;">Turn off "Hide conflicts"</button></td></tr>`
      : `<tr><td colspan="11" class="sp-placeholder"><i class="fas fa-inbox" style="font-size:32px;display:block;margin-bottom:10px;opacity:0.3"></i>No pairs match the filter.</td></tr>`;
    if (conflictHidden) {
      $("btn-show-conflicts-hint")?.addEventListener("click", () => {
        state.settings.hideConflicts = false;
        const cb = $("set-hide-conflicts"); if (cb) cb.checked = false;
        saveSettings();
        renderPairTable();
      });
    }
    $("sp-table-count").innerHTML = "<strong>0</strong> pairs";
    $("sp-table-meta").textContent = "cache —";
    // Invalidate the table HTML cache so the NEXT non-empty render path
    // doesn't short-circuit on a stale cache hit. Previously this branch
    // returned without touching `state._pairTableHtml`, so going from
    // "5 rows" → "0 rows" → "5 rows" left the DOM stuck on the empty-state
    // message. (REVIEW-2 C3.)
    state._pairTableHtml = "";
    return;
  }

  $("sp-table-count").innerHTML = `<strong>${rows.length}</strong> pairs`;
  // Format backtest cache age; the backend returns -1 for "never fetched"
  // (cold start), which previously rendered as literal "cache -1s". Treat
  // any non-positive value as "no data yet" and show "—". (REVIEW-2 H2.)
  const _cacheAgeTxt = (ageSec) => {
    if (ageSec == null || ageSec < 0) return "—";
    return `${ageSec.toFixed(0)}s`;
  };
  $("sp-table-meta").textContent = `cache ${_cacheAgeTxt(state.snapshot.backtestCacheAgeSec)}`;

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

  // Adaptive polling re-renders this table as often as once a second during
  // the burst window. Rebuilding the tbody every tick replays every row's
  // entrance animation and thrashes the DOM even when nothing changed —
  // skip the rebuild (and the listener rewiring below) when the markup is
  // byte-for-byte identical to the last render.
  if (state._pairTableHtml === rowsHtml) return;
  state._pairTableHtml = rowsHtml;

  body.innerHTML = rowsHtml;

  // ---- Wire row expand/collapse + fav click ----
  $$("#pair-table-body tr[data-pair]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".fav")) {
        const pair = e.target.closest(".fav").dataset.fav;
        toggleFavorite(pair);
        // Re-render (not just flip the icon class) so "Favorites only" drops
        // an un-favorited row immediately instead of leaving it visible
        // until the next poll tick.
        renderPairTable();
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
  if (filters.category) tags.push({ label: `Market: ${filters.category.toUpperCase()}`, clear: () => { filters.category = ""; syncCategoryLabels(); } });
  if (filters.level) tags.push({ label: `Level: ${filters.level}`, clear: () => { filters.level = ""; resetMenuSelection("level-menu"); } });
  if (filters.direction) tags.push({ label: `Final: ${filters.direction}`, clear: () => { filters.direction = ""; resetMenuSelection("dir-menu"); } });
  if (filters.agreeCount > 0) tags.push({ label: `Agree ≥ ${filters.agreeCount}`, clear: () => { filters.agreeCount = 0; resetMenuSelection("agree-menu"); } });
  if (filters.app1Dir) tags.push({ label: `App 1: ${filters.app1Dir === "NONE" ? "missing" : filters.app1Dir}`, clear: () => { filters.app1Dir = ""; resetMenuSelection("app1-menu"); } });
  if (filters.app2Dir) tags.push({ label: `App 2: ${filters.app2Dir === "NONE" ? "missing" : filters.app2Dir}`, clear: () => { filters.app2Dir = ""; resetMenuSelection("app2-menu"); } });
  if (filters.app3Dir) tags.push({ label: `App 3: ${filters.app3Dir === "NONE" ? "missing" : filters.app3Dir}`, clear: () => { filters.app3Dir = ""; resetMenuSelection("app3-menu"); } });
  if (filters.wr60Min > 0) tags.push({ label: `60m WR ≥ ${filters.wr60Min}%`, clear: () => { filters.wr60Min = 0; resetMenuSelection("wr60-menu"); } });
  if (filters.freshSec > 0) tags.push({ label: `Fresh ≤ ${filters.freshSec}s`, clear: () => { filters.freshSec = 0; resetMenuSelection("fresh-menu"); } });
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
    // Use the new camelCase outcomeLabel ("WIN"|"LOSS"|"DRAW"|"—") if the
    // backend shipped it; fall back to the numeric outcome check for
    // backwards-compat with cached older payloads. Previously this did
    // `s.outcome ? "WIN" : "LOSS"` which mapped every non-null string
    // (incl. "LOSS" / "DRAW" / "CORRECT" / "WRONG") to "WIN".
    // (REVIEW-1 C3 / REVIEW-2 C1.)
    const outcomeTxt = s.outcomeLabel != null ? s.outcomeLabel
      : (s.outcome == null ? "—" : s.outcome ? "WIN" : "LOSS");
    const outcomeCls = outcomeTxt === "WIN" ? "WIN"
      : outcomeTxt === "LOSS" ? "LOSS"
      : outcomeTxt === "DRAW" ? "DRAW"
      : "unknown";
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

// Timing classification — mirrors the backend's `_signal_timing_status`
// in routes.py (lines ~1245-1260). Magic numbers -65 and 120 used to be
// inline; named constants make the cross-file parity obvious and easy
// to keep in sync. (REVIEW-2 H4 / L5 / L6.)
//   - LOOK_AHEAD_THRESHOLD_SEC = -CANDLE_SEC - 5 = -60 - 5 = -65
//     (a signal emitted more than 5s AFTER its candle closed is suspicious)
//   - STALE_LAG_SEC = 120  (candle is well in the past)
const CANDLE_SEC_JS = 60;
const LOOK_AHEAD_THRESHOLD_SEC = -(CANDLE_SEC_JS + 5);
const STALE_LAG_SEC = 120;

function classifyLead(leadSec, candleTime) {
  if (leadSec == null) return "live";
  if (leadSec < LOOK_AHEAD_THRESHOLD_SEC) return "look-ahead";
  if (leadSec > 0) return "prediction";
  const now = Math.floor(Date.now() / 1000);
  if (candleTime && (now - candleTime) > STALE_LAG_SEC) return "stale";
  return "live";
}

// ====== Live signal feed ======
function renderSignalFeed(items, containerId) {
  // Track "new" ids from every fetch, even while the Signals tab (which
  // passes containerId=null) is active — otherwise signalFeedIds only ever
  // updates while on the Home tab, and returning to Home after a while away
  // makes every signal that arrived in the meantime look "new" at once,
  // firing a sound/notification burst for stuff that's minutes old.
  const feedPrimed = state._signalFeedPrimed === true;
  const newIds = new Set();
  (items || []).forEach((it) => {
    const id = `${it.pair}|${it.source}|${it.emittedAt}`;
    if (!state.signalFeedIds.has(id)) newIds.add(id);
  });
  state.signalFeedIds = new Set((items || []).map((it) => `${it.pair}|${it.source}|${it.emittedAt}`));

  // Sound + browser notifications must fire regardless of which tab is
  // active (and even when containerId is null, i.e. the Signals tab) —
  // gating this behind the DOM-render path below meant "Sound on 3-agree"
  // and "Browser notifications" only ever fired while sitting on the Home
  // tab, silently doing nothing the rest of the time despite both settings
  // claiming to alert on new 3-agree signals unconditionally.
  //
  // EXCEPT on the very first fetch after page load: signalFeedIds starts
  // empty, so EVERY feed item looked "new" and a dashboard with any 3-agree
  // signal in the last `feedSize` items beeped + spawned notifications for
  // signals that were minutes old. Prime the ID set silently instead.
  if (!feedPrimed) {
    state._signalFeedPrimed = true;
  } else if (newIds.size > 0) {
    const isNewThreeAgree = (it) =>
      newIds.has(`${it.pair}|${it.source}|${it.emittedAt}`) && it.consensusLevel === "3-agree";
    if (state.settings.sound && items.some(isNewThreeAgree)) playBeep();
    if (state.settings.notify && "Notification" in window && Notification.permission === "granted") {
      items.filter(isNewThreeAgree).forEach((it) => {
        try {
          new Notification(`${it.displayPair} — 3-bot agree ${it.direction}`, {
            body: `Signal at ${it.emittedUtc} UTC, candle ${it.candleUtc} UTC`,
            silent: true,
          });
        } catch (e) {}
      });
    }
  }

  if (!containerId) return;
  const container = $(containerId);
  if (!items || items.length === 0) {
    if (state._feedHtml !== "empty") {
      state._feedHtml = "empty";
      container.innerHTML = '<p class="placeholder">No signals yet.</p>';
    }
    return;
  }

  const feedHtml = `<div class="feed-list">${items.map((it) => {
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

  // Adaptive polling re-fetches the feed as often as once a second during
  // the burst window. Rebuilding the list every tick — even when nothing
  // arrived — replays every item's feedIn slide-in animation and makes
  // already-visible signals appear to flicker continuously. Skip the DOM
  // write (and listener rewiring below) when nothing actually changed,
  // mirroring the same fix already applied to the pair table.
  if (state._feedHtml === feedHtml) return;
  state._feedHtml = feedHtml;
  container.innerHTML = feedHtml;

  $$(".feed-item", container).forEach((el) => {
    el.addEventListener("click", () => openPairDrawer(el.dataset.pair));
  });
}

// One shared AudioContext — creating a fresh context per beep used to hit
// the browser's context limit (Chrome caps ~50 per page) after a long
// session with "Sound on 3-agree" enabled, silently killing the alert.
let _beepCtx = null;
function playBeep() {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!_beepCtx) _beepCtx = new Ctor();
    if (_beepCtx.state === "suspended") { _beepCtx.resume().catch(() => {}); }
    const ctx = _beepCtx;
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
  const age = s.cacheAgeSec != null && s.cacheAgeSec >= 0 ? `cache ${s.cacheAgeSec.toFixed(0)}s old` : "no cache";
  const refreshNote = s.lastRefreshError
    ? ` · ⚠ refresh failing: ${s.lastRefreshError}`
    : (s.refreshInProgress ? " · refreshing…" : "");
  $("backtest-status").textContent = `${age} · ${s.totalSignals || 0} signals · ${s.totalClusters || 0} clusters · ${s.perPairCount || 0} pairs${refreshNote}`;
  const cacheAgeEl = $("bt-cache-age");
  if (cacheAgeEl) cacheAgeEl.textContent = age + (s.lastRefreshError ? ` · ⚠ ${s.lastRefreshError}` : "");
  renderHomeBacktestSummary(s);
}

// Populates the "Consensus Accuracy (last 6 hours)" panel on the Home tab.
function renderHomeBacktestSummary(s) {
  const el = $("home-backtest");
  if (!el) return;
  if (!s.hasResult) {
    // t() — the identical string ships as `placeholder_run_backtest_home`
    // in BOTH translation tables; hardcoding it flipped the panel back to
    // English the moment a Bengali user opened the Home tab.
    el.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_run_backtest_home"))}</p>`;
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
    // escHtml() the error message — `e.message` could be reflected from
    // user-controlled path segment / query param if the backend ever
    // echoes them. Plain innerHTML is an XSS vector. (REVIEW-2 H3.)
    $("backtest-content").innerHTML = `<p class="placeholder">Backtest failed: ${escHtml(e.message)}</p>`;
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
    // Render "—" WITHOUT a trailing "%" — the old `${winRate}%` produced
    // a malformed "—%" cell whenever a bucket had zero graded signals.
    const winRateTxt = total > 0 ? `${((s.win / total) * 100).toFixed(1)}%` : "—";
    const wrBarCls = total > 0 ? wrClass((s.win / total) * 100) : "none";
    return `
      <div class="level-stat">
        <div class="level-stat__title">${level}</div>
        <div class="level-stat__row"><span>Total</span><strong>${s.total}</strong></div>
        <div class="level-stat__row"><span>Win / Loss</span><strong>${s.win} / ${s.loss}</strong></div>
        <div class="level-stat__row loss"><span>Win rate</span><span class="wr-bar wr-bar--${wrBarCls}">${winRateTxt}</span></div>
        <div class="level-stat__row"><span>Unknown</span><span>${s.unknown}</span></div>
        <div class="level-stat__row"><span>Draw</span><span>${s.draw}</span></div>
        <div class="level-stat__row"><span>CALL W/L</span><span>${s.callWin}/${s.callLoss}</span></div>
        <div class="level-stat__row"><span>PUT W/L</span><span>${s.putWin}/${s.putLoss}</span></div>
      </div>`;
  }).join("");

  const sourceStats = Object.entries(bt.sources || {}).map(([src, s]) => {
    const total = s.win + s.loss;
    const wrTxt = total > 0 ? `${((s.win / total) * 100).toFixed(1)}%` : "—";
    return `
      <div class="level-stat">
        <div class="level-stat__title">${src}</div>
        <div class="level-stat__row"><span>Total</span><strong>${s.total}</strong></div>
        <div class="level-stat__row"><span>Win</span><strong>${s.win}</strong></div>
        <div class="level-stat__row loss"><span>Loss</span><strong>${s.loss}</strong></div>
        <div class="level-stat__row"><span>Win rate</span><span>${wrTxt}</span></div>
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
    const g = appPairGlobal[key] || { win: 0, loss: 0, gradedTotal: 0, winRate: null, draw: 0, total: 0 };
    const wr = g.winRate;
    const wrCls = wr == null ? "none" : wr >= 60 ? "high" : wr < 45 ? "low" : "";
    const wrTxt = wr == null ? "—" : `${wr.toFixed(0)}%`;
    // Make each card a button → opens the per-subset pair list view
    // (History → Overall → subsetpairs) filtered to this subset.
    // This is the same destination as tapping the matching card on
    // the Overall Win Rate sub-tab — both surface every pair that has
    // signals in this subset, with per-pair signal count + W/L + WR.
    return `
      <button type="button" class="sp-app-pair-card sp-app-pair-card--link" data-subset-link="${escAttr(key)}" title="View every pair where ${escHtml(label)} produced signals">
        <div class="sp-app-pair-card__head"><span>${escHtml(label)}</span><span class="sp-app-pair-card__sub">${g.total || g.gradedTotal || 0} signals</span></div>
        <div class="sp-app-pair-card__wr ${wrCls}">${wrTxt}</div>
        <div class="sp-app-pair-card__sub">${g.win}W / ${g.loss}L${g.draw ? ` · ${g.draw} draw` : ""}</div>
        <div class="sp-app-pair-card__hint"><i class="fas fa-arrow-right"></i> View pairs</div>
      </button>`;
  }).join("");

  $("backtest-content").innerHTML = `
    <div class="verdict verdict--${escAttr(v.kind || "insufficient")}">${escHtml(v.message || "—")}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;">
      <h3 style="font-size:12px;">Per-level stats</h3>
      <span class="panel__meta">${bt.totalSignals} signals · ${bt.totalClusters} clusters</span>
    </div>
    <div class="level-stats">${levelStats}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;margin-top:18px;">
      <h3 style="font-size:12px;">Win rate by app pair (global)</h3>
      <span class="panel__meta"><button class="btn btn--ghost" id="btn-goto-overall" style="padding:4px 10px;font-size:11px;">View Overall Win Rate →</button></span>
    </div>
    <div class="sp-app-pair-grid">${appPairCards}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:10px;margin-top:18px;">
      <h3 style="font-size:12px;">Per-source stats</h3>
    </div>
    <div class="level-stats">${sourceStats}</div>
  `;

  // Wire the "View Overall Win Rate" button → switch to the Overall Win Rate sub-tab.
  $("btn-goto-overall")?.addEventListener("click", () => {
    switchHistorySubtab("overall");
  });
  // Wire each app-pair card → switch to the per-subset pair list view.
  $$("#backtest-content .sp-app-pair-card[data-subset-link]").forEach((card) => {
    card.addEventListener("click", () => {
      const subset = card.dataset.subsetLink;
      state.activeSubset = subset;
      switchHistorySubtab("subsetpairs", { subset, label: subsetLabel(subset) });
    });
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
  $("perpair-meta").textContent = `${pairs.length} pairs · cached ${(state.snapshot.backtestCacheAgeSec != null && state.snapshot.backtestCacheAgeSec >= 0) ? state.snapshot.backtestCacheAgeSec.toFixed(0) + "s" : "—"}`;

  // Same honesty note the consensus list shows: the header counts ALL
  // matching pairs but the table renders only the first 100.
  const capNote = pairs.length > 100
    ? `<tr class="perpair-cap-note"><td colspan="9" class="placeholder" style="padding:6px 10px;">Showing the top 100 of ${pairs.length} pairs (sorted by win rate).</td></tr>`
    : "";
  body.innerHTML = capNote + pairs.slice(0, 100).map((p) => {
    const ls = p.levelStats || {};
    const aps = p.appPairStats || {};
    // Format a per-app-pair stat cell: shows win/loss and a tiny win-rate badge.
    const fmtAP = (key) => {
      const s = aps[key];
      if (!s || (s.win + s.loss) === 0) return '<span class="mono" style="color:var(--text-muted)">—</span>';
      const wr = s.winRate;
      const wrCls = wr == null ? "none" : wr >= 60 ? "good" : wr >= 45 ? "mid" : "low";
      const wrTxt = wr == null ? "?" : `${wr.toFixed(0)}%`;
      // Wrap the per-subset cell in a clickable button so the user can
      // jump straight from "app1+app2 on EURUSD: 9W/3L (75%)" → the
      // per-pair drawer with the app1+app2 subset chip pre-selected,
      // showing only the EURUSD signals where app1+app2 agreed.
      return `<button type="button" class="cell-link" data-pair-cell="${escAttr(p.pair)}" data-subset-cell="${escAttr(key)}" title="View ${escHtml(p.displayPair)} history for ${escAttr(key)}"><span class="mono"><strong>${s.win}/${s.loss}</strong> <span class="wr-bar wr-bar--${wrCls}" style="font-size:10px;padding:1px 5px">${wrTxt}</span></span></button>`;
    };
    const fmt = (lvl) => {
      const s = ls[lvl];
      if (!s) return "—";
      return `${s.win}/${s.loss}`;
    };
    const wr = p.winRate;
    const wrCls = wrClass(wr);
    const wrTxt = wr == null ? "—" : `${wr.toFixed(0)}%`;
    // Include "conflict" — the backend's headline winRate/gradedTotal counts
    // graded conflict-majority clusters too (backtest_runner.pair_to_dict),
    // so this column used to contradict the Win % cell right next to it
    // (e.g. "3/2" next to a rate computed over 8W/7L).
    const totalW = (ls["3-agree"]?.win || 0) + (ls["2-agree"]?.win || 0) + (ls["conflict"]?.win || 0) + (ls["1-only"]?.win || 0);
    const totalL = (ls["3-agree"]?.loss || 0) + (ls["2-agree"]?.loss || 0) + (ls["conflict"]?.loss || 0) + (ls["1-only"]?.loss || 0);
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
      // Per-subset cell click → open drawer with that subset pre-filtered.
      const cellBtn = e.target.closest("[data-pair-cell]");
      if (cellBtn) {
        e.stopPropagation();
        openPairDrawer(cellBtn.dataset.pairCell, { subset: cellBtn.dataset.subsetCell });
        return;
      }
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
  const ticket = nextTicket("apppair-leaders");
  if (!payload) {
    try {
      if (meta) meta.textContent = "loading…";
      const res = await fetch("/api/app-pair-leaders", { cache: "no-store" });
      if (res.ok) payload = await res.json();
    } catch (e) {
      console.warn("[app-pair-leaders] fetch failed", e);
    }
    // A newer render superseded this one while we were fetching — bail.
    if (!ticketStillCurrent("apppair-leaders", ticket)) return;
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
    // Treat negative cacheAgeSec as "no cache yet" — backend returns -1
    // for "never fetched" on cold start. (REVIEW-2 H2.)
    meta.textContent = `cache ${(ageSec != null && ageSec >= 0) ? ageSec.toFixed(0) + "s" : "—"} · verdict: ${verdictTxt}`;
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

// ====== Signal History (History → Signal History) ==========================
// Two screens:
//   1. renderConsensusLevels() — four sub-folder cards, one per agreement
//      level (3 Agree / 2 Agree / Conflict / Single App), each showing live
//      counts + win rate from /api/consensus-history.
//   2. renderConsensusList()   — that level's candle-by-candle list, where
//      EVERY row expands into a full per-app breakdown.
//
// Before this, agreement-level history had no UI at all: the only history
// table was the per-pair drawer's flat 7-column list, whose rows were inert
// <tr>s with no click handler — hence "history te click korle bistarito
// dekha jai na". The backend was already shipping app_directions /
// app_outcomes / agreeing_apps on every cluster; nothing rendered them.

const CONSENSUS_LEVEL_META = [
  { level: "3-agree", title: "3 Agree", icon: "fa-star", tone: "emerald",
    desc: "All three apps called the same direction — the strongest setup." },
  { level: "2-agree", title: "2 Agree", icon: "fa-star-half-stroke", tone: "blue",
    desc: "Two apps agreed and the third was silent." },
  { level: "conflict", title: "Conflict", icon: "fa-code-branch", tone: "amber",
    desc: "Apps disagreed — the majority direction is graded." },
  { level: "1-only", title: "Single App", icon: "fa-user", tone: "violet",
    desc: "Only one app fired on this candle." },
];

const APP_LABELS = { app1: "App 1", app2: "App 2", app3: "App 3" };

// Win-rate → .wr-bar modifier. MUST match the thresholds and modifier
// names the rest of the dashboard already uses (good / mid / low / none at
// 60 / 45), otherwise the same win rate is coloured green in one panel and
// amber in another. An earlier draft of this file used its own 65/50 split
// and a "bad" modifier that had no CSS rule at all.
function wrClass(wr) {
  if (wr == null) return "none";
  if (wr >= 60) return "good";
  if (wr >= 45) return "mid";
  return "low";
}

function fmtWr(wr) {
  if (wr == null) return "—";
  return `${Number(wr).toFixed(1)}%`;
}

async function fetchConsensusHistory(params = {}) {
  const q = new URLSearchParams({
    level: params.level || "all",
    minutes: String(params.minutes ?? consensusMinutes()),
    direction: params.direction ?? consensusDirection(),
    graded_only: consensusGradedOnly() ? "1" : "0",
    limit: String(params.limit || 300),
  });
  // The category filter lives in `filters` (top bar / Signals grid), NOT in
  // settings — `state.settings.category` never existed, so the Market Type
  // filter was silently dead on every Signal History view.
  if (filters.category) {
    q.set("category", filters.category);
  }
  const res = await fetch(`/api/consensus-history?${q}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function consensusMinutes() { return Number($("consensus-minutes")?.value || 360); }
function consensusDirection() { return $("consensus-direction")?.value || ""; }
function consensusGradedOnly() { return !!$("consensus-graded-only")?.checked; }

// ---- Screen 1: the level picker ----
async function renderConsensusLevels() {
  const grid = $("consensus-level-grid");
  if (!grid) return;
  grid.innerHTML = `<p class="placeholder">${escHtml(t("placeholder_loading"))}</p>`;
  let data;
  try {
    data = await fetchConsensusHistory({ level: "all", limit: 1 });
  } catch (e) {
    grid.innerHTML = `<p class="placeholder placeholder--error">Could not load signal history: ${escHtml(String(e.message || e))}</p>`;
    return;
  }
  const byLevel = data.byLevel || {};
  grid.innerHTML = CONSENSUS_LEVEL_META.map((m) => {
    const s = byLevel[m.level] || {};
    const wr = s.winRate;
    return `
      <button type="button" class="subfolder-card" data-level="${escAttr(m.level)}">
        <span class="subfolder-card__icon subfolder-card__icon--${m.tone}"><i class="fas ${m.icon}"></i></span>
        <span class="subfolder-card__title">${escHtml(m.title)}</span>
        <span class="subfolder-card__desc">${escHtml(m.desc)}</span>
        <span class="subfolder-card__stats">
          <span class="stat"><strong>${s.total || 0}</strong> signals</span>
          <span class="stat"><strong>${s.wins || 0}</strong>W / <strong>${s.losses || 0}</strong>L</span>
          <span class="wr-bar wr-bar--${wrClass(wr)}">${fmtWr(wr)}</span>
        </span>
        ${(s.pending || 0) > 0 ? `<span class="subfolder-card__note">${s.pending} still awaiting a close</span>` : ""}
      </button>`;
  }).join("");

  $$("[data-level]", grid).forEach((btn) => {
    btn.addEventListener("click", () => {
      const level = btn.dataset.level;
      state.activeConsensusLevel = level;
      const meta = CONSENSUS_LEVEL_META.find((m) => m.level === level);
      switchHistorySubtab("consensuslist", { level, label: meta ? meta.title : level });
      window.scrollTo(0, 0);
    });
  });
}

// ---- Screen 2: one level's candle list ----
async function renderConsensusList(level) {
  level = level || state.activeConsensusLevel || "3-agree";
  state.activeConsensusLevel = level;
  const meta = CONSENSUS_LEVEL_META.find((m) => m.level === level);
  const titleEl = $("consensuslist-title");
  if (titleEl) titleEl.textContent = meta ? `${meta.title} — Signal History` : "Signal History";

  const body = $("consensuslist-body");
  const summaryEl = $("consensuslist-summary");
  if (!body) return;
  body.innerHTML = `<tr><td colspan="8" class="placeholder">${escHtml(t("placeholder_loading"))}</td></tr>`;

  // Guard against out-of-order responses: tapping "3 Agree" then quickly
  // "2 Agree" starts two fetches; the slower FIRST one must not overwrite
  // the newer view (and must not revert state.activeConsensusLevel).
  const ticket = nextTicket("consensuslist");
  let data;
  try {
    data = await fetchConsensusHistory({ level });
  } catch (e) {
    if (ticketStillCurrent("consensuslist", ticket)) {
      body.innerHTML = `<tr><td colspan="8" class="placeholder placeholder--error">Could not load: ${escHtml(String(e.message || e))}</td></tr>`;
    }
    return;
  }
  if (!ticketStillCurrent("consensuslist", ticket)) return; // a newer request superseded us
  state.consensusHistory = data;

  const s = data.summary || {};
  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="summary-strip">
        <span class="summary-strip__item"><span class="summary-strip__label">Signals</span><strong>${s.total || 0}</strong></span>
        <span class="summary-strip__item"><span class="summary-strip__label">Graded</span><strong>${s.gradedTotal || 0}</strong></span>
        <span class="summary-strip__item"><span class="summary-strip__label">Win / Loss</span><strong>${s.wins || 0} / ${s.losses || 0}</strong></span>
        <span class="summary-strip__item"><span class="summary-strip__label">Win rate</span><span class="wr-bar wr-bar--${wrClass(s.winRate)}">${fmtWr(s.winRate)}</span></span>
        <span class="summary-strip__item"><span class="summary-strip__label">CALL / PUT</span><strong>${s.call || 0} / ${s.put || 0}</strong></span>
        ${(s.pending || 0) > 0 ? `<span class="summary-strip__item summary-strip__item--muted"><span class="summary-strip__label">Pending</span><strong>${s.pending}</strong></span>` : ""}
      </div>
      ${data.total > data.returned
        ? `<p class="panel__note">Showing the newest ${data.returned} of ${data.total} signals in this window.</p>`
        : ""}`;
  }

  const items = data.items || [];
  if (items.length === 0) {
    body.innerHTML = `<tr><td colspan="8" class="placeholder">No ${escHtml(meta ? meta.title : level)} signals saved in this window.</td></tr>`;
    return;
  }
  body.innerHTML = items.map(renderConsensusRow).join("");
  wireConsensusRowToggles(body, items);
}

// Namespaced so this Set is never shared with the per-pair drawer's history
// table (renderSimpleHistoryRows uses the same pair|ts shape) — without the
// prefix, expanding a row in one view could render the SAME candle
// pre-expanded in the other view the user never actually clicked there.
function rowKey(c) { return `list:${c.pair}|${c.ts}`; }

function renderConsensusRow(c) {
  const key = rowKey(c);
  const expanded = state.expandedHistoryRows.has(key);
  const dir = c.direction;
  const result = c.marketResult;
  const outcomeCls = c.outcome === 1 ? "win" : c.outcome === 0 ? "loss" : "unknown";
  const apps = (c.agreeing_apps || []).map((a) => APP_LABELS[a] || a).join(" + ") || "—";
  return `
    <tr class="hist-row${expanded ? " hist-row--open" : ""}" data-row="${escAttr(key)}" tabindex="0" role="button" aria-expanded="${expanded}">
      <td class="mono">${escHtml(c.candleUtc || "—")}</td>
      <td>${escHtml(c.displayPair || c.pair || "—")} <span class="pill pill--${escAttr(c.category || "real")}">${escHtml((c.category || "").toUpperCase())}</span></td>
      <td class="mono">${escHtml(apps)}</td>
      <td>${dir ? `<span class="dir dir--${escAttr(dir)}">${escHtml(dir)}</span>` : "—"}</td>
      <td>${result ? `<span class="dir dir--${escAttr(result)}">${escHtml(result)}</span>` : "—"}</td>
      <td><span class="outcome outcome--${outcomeCls}">${escHtml(c.outcomeLabel || "—")}</span></td>
      <td class="mono">${fmtWr(c.runningWinRate)}</td>
      <td class="hist-row__chev"><i class="fas fa-chevron-${expanded ? "up" : "down"}"></i></td>
    </tr>
    ${expanded ? `<tr class="hist-detail-row"><td colspan="8">${renderConsensusDetail(c)}</td></tr>` : ""}`;
}

// The detail card the user was missing: for one candle, exactly what each
// app said, whether each app's own bookkeeping agreed with the real candle
// close, and how this row moved the running win rate.
function renderConsensusDetail(c) {
  const dirs = c.app_directions || {};
  const labels = c.appOutcomeLabels || {};
  const agreeing = new Set(c.agreeing_apps || []);
  const appCards = ["app1", "app2", "app3"].map((app) => {
    const d = dirs[app];
    if (!d) {
      return `<div class="app-card app-card--silent">
        <span class="app-card__name">${APP_LABELS[app]}</span>
        <span class="app-card__dir">— no signal</span>
      </div>`;
    }
    const lbl = labels[app] || "—";
    const cls = lbl === "WIN" ? "win" : lbl === "LOSS" ? "loss" : "unknown";
    return `<div class="app-card${agreeing.has(app) ? " app-card--agree" : ""}">
      <span class="app-card__name">${APP_LABELS[app]}${agreeing.has(app) ? ' <i class="fas fa-check" title="agreed with consensus"></i>' : ""}</span>
      <span class="dir dir--${escAttr(d)}">${escHtml(d)}</span>
      <span class="outcome outcome--${cls}">${escHtml(lbl)}</span>
    </div>`;
  }).join("");

  const consensusOutcome = c.outcome === 1 ? "This consensus WON — the candle closed in the predicted direction."
    : c.outcome === 0 ? "This consensus LOST — the candle closed against the prediction."
    : (c.outcomeLabel === "DRAW") ? "DRAW — the candle opened and closed at the same price."
    : "Not graded yet — waiting for the candle close (or no candle data for this minute).";

  return `
    <div class="hist-detail">
      <div class="hist-detail__head">
        <span class="hist-detail__pair">${escHtml(c.displayPair || c.pair)}</span>
        <span class="mono">${escHtml(c.candleUtc || "—")} UTC</span>
        <span class="pill pill--${escAttr(c.level)}">${escHtml(c.level)}</span>
        ${c.app_subset_key ? `<span class="pill">${escHtml(c.app_subset_key)}</span>` : ""}
      </div>
      <div class="app-card-grid">${appCards}</div>
      <p class="hist-detail__verdict hist-detail__verdict--${c.outcome === 1 ? "win" : c.outcome === 0 ? "loss" : "pending"}">${escHtml(consensusOutcome)}</p>
      <div class="hist-detail__meta">
        <span>Running: <strong>${c.runningWins || 0}W / ${c.runningLosses || 0}L</strong> (${fmtWr(c.runningWinRate)})</span>
        <span>Age: <strong>${c.ageSec == null ? "—" : Math.round(c.ageSec / 60) + " min"}</strong></span>
      </div>
      <div class="hist-detail__actions">
        <button class="btn btn--ghost btn--mini" data-open-pair="${escAttr(c.pair)}"><i class="fas fa-magnifying-glass-chart"></i> Open ${escHtml(c.displayPair || c.pair)}</button>
      </div>
    </div>`;
}

function wireConsensusRowToggles(body, items) {
  const byKey = new Map(items.map((c) => [rowKey(c), c]));
  const toggle = (key) => {
    if (state.expandedHistoryRows.has(key)) state.expandedHistoryRows.delete(key);
    else state.expandedHistoryRows.add(key);
    body.innerHTML = items.map(renderConsensusRow).join("");
    wireConsensusRowToggles(body, items);
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
  void byKey;
}

// Filter controls re-fetch (the window / graded-only filters are applied
// server-side so the running win rate stays correct for the filtered set).
["consensus-direction", "consensus-minutes", "consensus-graded-only"].forEach((id) => {
  $(id)?.addEventListener("change", () => {
    state.expandedHistoryRows.clear();
    if (state.activeHistorySubtab === "consensuslist") renderConsensusList(state.activeConsensusLevel);
    else renderConsensusLevels();
  });
});

// ====== Overall Win Rate (History → Overall Win Rate headline folder) ======
// The landing screen for the most important question the user has:
// "Of App 1, App 2, App 3, and every combination (1+2, 1+3, 2+3, all-3),
//  who wins most?".
//
// Layout: a 7-card grid. Each card shows:
//   - subset name (e.g. "App 1 + App 2")
//   - global win rate (large, color-coded by 60%/45% thresholds)
//   - signal count (total signals produced by that subset across all pairs)
//   - W/L / draw breakdown
// Tapping a card switches to the per-subset pair list (renderSubsetPairList)
// which shows EVERY pair that has signals in that subset, with per-pair
// signal count, W/L, win rate, and a "view history" link that opens the
// per-pair drawer with the subset pre-filtered on the Signal History table.
//
// Everything is cross-linked:
//   - Backtest sub-tab → "Win rate by app pair (global)" grid card → here
//   - Per-Pair Stats table → app1+app2 / app1+app3 / app2+app3 / all-3
//     cells → here (filtered to that subset)
//   - App Pair Leaders sub-tab → top-pair row → per-pair drawer
//   - Per-subset pair list → row click → per-pair drawer
const OVERALL_SUBSET_DEFS = [
  { key: "app1", label: "App 1 only", short: "App 1", color: "amber", icon: "fa-1" },
  { key: "app2", label: "App 2 only", short: "App 2", color: "violet", icon: "fa-2" },
  { key: "app3", label: "App 3 only", short: "App 3", color: "emerald", icon: "fa-3" },
  { key: "app1+app2", label: "App 1 + App 2", short: "App 1+2", color: "blue", icon: "fa-link" },
  { key: "app1+app3", label: "App 1 + App 3", short: "App 1+3", color: "violet", icon: "fa-link" },
  { key: "app2+app3", label: "App 2 + App 3", short: "App 2+3", color: "amber", icon: "fa-link" },
  { key: "app1+app2+app3", label: "All 3 agree", short: "All 3", color: "emerald", icon: "fa-star" },
];

// Human label for an app-subset key — used by the History breadcrumb so a
// deep path reads "History / Overall Win Rate / App 1 + App 2" rather than
// "History / overall / app1+app2".
function subsetLabel(key) {
  const def = OVERALL_SUBSET_DEFS.find((d) => d.key === key);
  return def ? def.short : key;
}

async function renderOverallWinRate() {
  const meta = $("overall-meta");
  const content = $("overall-content");
  if (!content) return;

  // Try cached payload first (set whenever this view, /api/app-pair-leaders,
  // or the cached backtest is fetched). Fall back to fetching the leaders
  // endpoint which returns both leaders AND the global aggregates.
  let payload = state.cachedAppPairLeaders;
  if (!payload) {
    // Fall back to the cached backtest, if available — it carries
    // perPair[] which we can aggregate client-side via the same helper
    // the Backtest sub-tab uses.
    const bt = state.cachedBacktest;
    if (bt && (bt.perPair || []).length > 0) {
      payload = {
        appPairGlobal: _aggregateAppPairGlobal(bt.perPair || []),
        appPairLeaders: bt.appPairLeaders || {},
        cacheAgeSec: state.snapshot?.backtestCacheAgeSec ?? null,
        verdict: bt.verdict,
      };
    }
  }
  if (!payload) {
    try {
      if (meta) meta.textContent = "loading…";
      const res = await fetch("/api/app-pair-leaders", { cache: "no-store" });
      if (res.ok) {
        payload = await res.json();
        state.cachedAppPairLeaders = payload;
        state._appPairLeadersFetchedAt = Date.now();
      }
    } catch (e) {
      console.warn("[overall-winrate] fetch failed", e);
    }
  } else {
    // Reuse the cached payload, but refresh it in the background AT MOST
    // once every 30s. Previously EVERY render fired a background fetch and
    // each successful fetch re-rendered this view, which armed the next
    // fetch — so simply sitting on this view generated an endless request
    // loop (one fetch per network round-trip, forever).
    const fetchedAgeMs = Date.now() - (state._appPairLeadersFetchedAt || 0);
    if (fetchedAgeMs > 30000) {
      state._appPairLeadersFetchedAt = Date.now();
      fetch("/api/app-pair-leaders", { cache: "no-store" })
        .then((r) => r.ok ? r.json() : null)
        .then((p) => { if (p) { state.cachedAppPairLeaders = p; /* re-render only if user is still on this view */ if (state.activeTab === "history" && state.activeHistorySubtab === "overall") renderOverallWinRate(); } })
        .catch(() => {});
    }
  }

  if (!payload) {
    content.innerHTML = '<p class="placeholder">No backtest data yet. Tap "Run fresh backtest" on the Backtest folder first, or wait for the auto-cache.</p>';
    if (meta) meta.textContent = "—";
    return;
  }

  const global = payload.appPairGlobal || {};
  const verdict = payload.verdict;
  const ageSec = payload.cacheAgeSec;

  // Headline: global aggregate across ALL subsets (sum of all 7).
  let headTotal = 0, headWin = 0, headLoss = 0, headDraw = 0, headUnknown = 0;
  for (const def of OVERALL_SUBSET_DEFS) {
    const g = global[def.key] || {};
    headTotal += g.total || 0;
    headWin += g.win || 0;
    headLoss += g.loss || 0;
    headDraw += g.draw || 0;
    headUnknown += g.unknown || 0;
  }
  const headGraded = headWin + headLoss;
  const headWr = headGraded > 0 ? Math.round((headWin / headGraded) * 1000) / 10 : null;
  const headWrTxt = headWr == null ? "—" : `${headWr.toFixed(1)}%`;
  const headWrCls = headWr == null ? "" : headWr >= 60 ? "high" : headWr < 45 ? "low" : "mid";

  if (meta) {
    const verdictTxt = verdict ? verdict.kind : "—";
    meta.textContent = `cache ${(ageSec != null && ageSec >= 0) ? ageSec.toFixed(0) + "s" : "—"} · ${headTotal} signals · verdict: ${verdictTxt}`;
  }

  // 7-card grid. Each card is a button → switchHistorySubtab("subsetpairs", { subset }).
  const cards = OVERALL_SUBSET_DEFS.map((def) => {
    const g = global[def.key] || { total: 0, win: 0, loss: 0, draw: 0, unknown: 0, gradedTotal: 0, winRate: null };
    const wr = g.winRate;
    const wrCls = wr == null ? "" : wr >= 60 ? "high" : wr < 45 ? "low" : "mid";
    const wrTxt = wr == null ? "—" : `${wr.toFixed(1)}%`;
    const graded = g.gradedTotal || (g.win + g.loss);
    // Pick the best pair from the leaders list for this subset (if any)
    // to show a "best pair" hint under the headline.
    const leader = (payload.appPairLeaders?.[def.key] || [])[0];
    const leaderTxt = leader
      ? `Best: ${escHtml(leader.displayPair)} ${leader.winRate == null ? "—" : leader.winRate.toFixed(0) + "%"} (${leader.wins}/${leader.losses})`
      : '<span style="color:var(--text-dim)">No qualified pair yet</span>';
    return `
      <button type="button" class="overall-card overall-card--${def.color}" data-subset="${escAttr(def.key)}">
        <div class="overall-card__head">
          <span class="overall-card__label">${escHtml(def.label)}</span>
          <span class="overall-card__signals">${g.total || 0} signals</span>
        </div>
        <div class="overall-card__wr ${wrCls}">${wrTxt}</div>
        <div class="overall-card__wl">${g.win || 0}W / ${g.loss || 0}L${g.draw ? ` · ${g.draw} draw` : ""}${g.unknown ? ` · ${g.unknown}?` : ""}</div>
        <div class="overall-card__best">${leaderTxt}</div>
        <div class="overall-card__hint"><i class="fas fa-arrow-right"></i> <span>View ${graded} graded signals across all pairs</span></div>
      </button>`;
  }).join("");

  content.innerHTML = `
    <div class="overall-headline">
      <div class="overall-headline__label">Overall Win Rate (all apps, all combinations)</div>
      <div class="overall-headline__wr ${headWrCls}">${headWrTxt}</div>
      <div class="overall-headline__sub">${headWin}W / ${headLoss}L${headDraw ? ` · ${headDraw} draw` : ""} · ${headTotal} signals · ${headGraded} graded</div>
    </div>
    <div class="overall-grid">${cards}</div>
    <p class="placeholder" style="margin-top:14px;font-size:11px">
      <i class="fas fa-info-circle"></i>
      Tap any card to see every pair that has signals in that subset, with per-pair signal count, W/L, win rate, and a link to the per-pair signal history (already filtered to that subset).
    </p>
  `;

  $$("#overall-content .overall-card[data-subset]").forEach((card) => {
    card.addEventListener("click", () => {
      const subset = card.dataset.subset;
      state.activeSubset = subset;
      switchHistorySubtab("subsetpairs", { subset, label: subsetLabel(subset) });
      window.scrollTo(0, 0);
    });
  });
}

// ====== Per-Subset Pair List (History → Overall → tap a card) ======
// Shows EVERY pair that has signals for ONE app subset, with per-pair:
//   - Pair (clickable → opens per-pair drawer)
//   - Signal count in this subset
//   - W/L + win rate
//   - "History" link → opens per-pair drawer with the subset chip
//     pre-selected, so the Signal History table starts filtered to
//     just that subset.
async function renderSubsetPairList(subset) {
  const title = $("subsetpairs-title");
  const meta = $("subsetpairs-meta");
  const body = $("subsetpairs-table-body");
  if (!body) return;
  if (!subset) {
    body.innerHTML = '<tr><td colspan="7" class="placeholder">No subset selected. Go back to Overall Win Rate and tap a card.</td></tr>';
    if (meta) meta.textContent = "—";
    if (title) title.textContent = "Subset";
    return;
  }
  state.activeSubset = subset;
  const def = OVERALL_SUBSET_DEFS.find((d) => d.key === subset) || { label: subset };
  if (title) title.innerHTML = `<i class="fas fa-arrow-left" style="cursor:pointer;margin-right:8px" id="subsetpairs-back"></i> ${escHtml(def.label)}`;
  // Wire the inline back-arrow → return to Overall Win Rate view.
  $("subsetpairs-back")?.addEventListener("click", historyNavBack);

  if (meta) meta.textContent = "loading…";
  body.innerHTML = '<tr><td colspan="7" class="placeholder">Loading…</td></tr>';

  // Guard against out-of-order responses — rapidly tapping two subset
  // cards starts two fetches; the slower FIRST one must not paint its
  // pairs under the newer card's title.
  const ticket = nextTicket("subsetpairs");
  let payload = null;
  try {
    const res = await fetch(`/api/app-pair/${encodeURIComponent(subset)}/pairs`, { cache: "no-store" });
    if (res.ok) payload = await res.json();
    else if (res.status === 400) {
      if (ticketStillCurrent("subsetpairs", ticket)) {
        body.innerHTML = `<tr><td colspan="7" class="placeholder">Invalid subset. Pick one of: app1, app2, app3, app1+app2, app1+app3, app2+app3, app1+app2+app3.</td></tr>`;
        if (meta) meta.textContent = "error";
      }
      return;
    }
  } catch (e) {
    if (ticketStillCurrent("subsetpairs", ticket)) {
      body.innerHTML = `<tr><td colspan="7" class="placeholder">Failed: ${escHtml(e.message)}</td></tr>`;
      if (meta) meta.textContent = "error";
    }
    return;
  }
  if (!ticketStillCurrent("subsetpairs", ticket)) return;
  if (!payload) {
    body.innerHTML = '<tr><td colspan="7" class="placeholder">No data.</td></tr>';
    return;
  }

  const g = payload.global || {};
  const pairs = payload.pairs || [];
  const ageSec = payload.cacheAgeSec;
  if (meta) {
    const wr = g.winRate;
    const wrTxt = wr == null ? "—" : `${wr.toFixed(1)}%`;
    meta.textContent = `${g.total || 0} signals · ${g.gradedTotal || 0} graded · ${g.win || 0}W / ${g.loss || 0}L · win rate ${wrTxt} · cache ${(ageSec != null && ageSec >= 0) ? ageSec.toFixed(0) + "s" : "—"}`;
  }

  if (pairs.length === 0) {
    body.innerHTML = '<tr><td colspan="7" class="placeholder">No pairs have signals in this subset yet.</td></tr>';
    return;
  }

  body.innerHTML = pairs.map((p) => {
    const wr = p.winRate;
    const wrCls = wr == null ? "none" : wr >= 60 ? "good" : wr >= 45 ? "mid" : "low";
    const wrTxt = wr == null ? "—" : `${wr.toFixed(0)}%`;
    const isFav = state.favorites.has(p.pair);
    return `
      <tr data-pair="${escAttr(p.pair)}" data-subset="${escAttr(subset)}">
        <td class="fav ${isFav ? "is-fav" : ""}" data-fav="${escAttr(p.pair)}" data-label="★">${isFav ? "★" : "☆"}</td>
        <td data-label="Pair"><strong>${escHtml(p.displayPair)}</strong></td>
        <td data-label="Cat"><span class="pill pill--${p.category}">${p.category}</span></td>
        <td data-label="Signals" class="mono">${p.signals}</td>
        <td data-label="W/L" class="mono">${p.win}/${p.loss}${p.draw ? ` <span style="color:var(--text-dim)">(${p.draw} draw)</span>` : ""}</td>
        <td data-label="Win %"><span class="wr-bar wr-bar--${wrCls}">${wrTxt}</span></td>
        <td data-label="History"><button class="btn btn--ghost btn--mini" data-pair-history="${escAttr(p.pair)}" data-subset="${escAttr(subset)}"><i class="fas fa-clock-rotate-left"></i> History</button></td>
      </tr>`;
  }).join("");

  // Row click → open drawer (no subset pre-filter; user wants to see
  // everything for this pair). The dedicated History button below opens
  // drawer with subset pre-filtered.
  $$("#subsetpairs-table-body tr[data-pair]").forEach((row) => {
    row.addEventListener("click", (e) => {
      // Ignore clicks on the favorite ★ cell and on the History button
      // (those have their own handlers).
      if (e.target.closest(".fav") || e.target.closest("[data-pair-history]")) return;
      openPairDrawer(row.dataset.pair);
    });
  });
  // History button → drawer with subset pre-filtered.
  $$("#subsetpairs-table-body [data-pair-history]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const pair = btn.dataset.pairHistory;
      const sub = btn.dataset.subset;
      openPairDrawer(pair, { subset: sub });
    });
  });
  // Favorite toggle.
  $$("#subsetpairs-table-body .fav[data-fav]").forEach((cell) => {
    cell.addEventListener("click", (e) => {
      e.stopPropagation();
      const pair = cell.dataset.fav;
      toggleFavorite(pair);
      cell.classList.toggle("is-fav");
      cell.textContent = state.favorites.has(pair) ? "★" : "☆";
    });
  });
}

// ====== Pair drilldown (History → Pair Drilldown) ======
function populateHistoryPairSelector() {
  if (!state.snapshot) return;
  const sel = $("drilldown-pair");
  const current = sel.value;
  const pairs = (state.snapshot.pairs || []).slice(0, 100);
  sel.innerHTML = `<option value="">${escHtml(t("opt_select_pair"))}</option>` + pairs.map((p) => `<option value="${escAttr(p.pair)}">${escHtml(p.displayPair)}</option>`).join("");
  if (current && pairs.some((p) => p.pair === current)) sel.value = current;
}

$("drilldown-pair")?.addEventListener("change", async (e) => {
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

async function openPairDrawer(pair, opts = {}) {
  // opts can carry:
  //   - targetId  : render into a non-drawer element too (drilldown view)
  //   - subset    : app-subset key (e.g. "app1+app2") to pre-filter the
  //                 Signal History table to. Set by the Per-Pair Stats
  //                 table's per-subset cells and the Subset Pair List's
  //                 "History" button — both promise "the drawer opens with
  //                 the subset chip pre-selected", so it has to actually
  //                 filter the table, not just be accepted and dropped.
  const targetId = typeof opts === "string" ? opts : opts.targetId;
  const subset = typeof opts === "string" ? null : (opts.subset || null);
  // Inline render (History → Pair Drilldown): previously this ALSO popped
  // the modal drawer over the top and locked the page scroll, so the inline
  // result was hidden behind a duplicate modal. Render inline ONLY.
  if (!targetId) {
    state.drawerPair = pair;
    state.drawerSubset = subset;
    drawerOverlay.hidden = false;
    document.body.style.overflow = "hidden";
    $("drawer-body").innerHTML = '<p class="placeholder">Loading…</p>';
    $("drawer-title").textContent = "Loading…";
    $("drawer-sub").textContent = pair;
  }
  // Guard against out-of-order responses: opening pair A then quickly pair
  // B starts two fetches; A's slower response must not overwrite B's view
  // while state.drawerPair is already B (which would also make the ★ button
  // toggle the WRONG pair).
  const ticket = nextTicket(targetId ? `drilldown:${targetId}` : "drawer");
  try {
    const res = await fetch(`/api/pair/${encodeURIComponent(pair)}?candle_limit=60`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!ticketStillCurrent(targetId ? `drilldown:${targetId}` : "drawer", ticket)) return;
    if (subset) {
      // Filter to the requested app-subset only. Tagging the filter onto
      // `data` (rather than threading it through every render function's
      // signature) lets the existing re-render call in the expand/collapse
      // handler (which reads state.drawerHistoryPair) keep working
      // unchanged — it already re-renders from this same filtered list.
      data.clusterHistory = (data.clusterHistory || []).filter((c) => c.app_subset_key === subset);
      data.__subsetFilter = subset;
    }
    if (targetId) {
      const alt = $(targetId);
      if (alt) alt.innerHTML = renderPairDetailHtml(data);
    } else {
      renderPairDrawer(data);
    }
  } catch (e) {
    if (!ticketStillCurrent(targetId ? `drilldown:${targetId}` : "drawer", ticket)) return;
    if (targetId) {
      const alt = $(targetId);
      if (alt) alt.innerHTML = `<p class="placeholder">Failed: ${escHtml(e.message)}</p>`;
    } else {
      $("drawer-body").innerHTML = `<p class="placeholder">Failed: ${escHtml(e.message)}</p>`;
    }
  }
}

function closePairDrawer() {
  drawerOverlay.hidden = true;
  document.body.style.overflow = "";
  state.drawerPair = null;
  state.drawerSubset = null;
}

function renderPairDrawer(data) {
  $("drawer-title").textContent = data.displayPair;
  const cat = `<span class="pill pill--${data.category}">${data.category}</span>`;
  const cons = data.consensus ? `<span class="pill pill--${data.consensus.level}">${data.consensus.level}</span>` : "";
  $("drawer-sub").innerHTML = `${cat} ${cons} · ${data.signals?.length || 0} signals · win rate ${data.winRate == null ? "—" : data.winRate.toFixed(1) + "%"}`;
  $("drawer-body").innerHTML = renderPairDetailHtml(data);
}

function renderPairDetailHtml(data) {
  const clusterHistory = data.clusterHistory || [];
  const historyMinutes = data.clusterHistoryMinutes || 60;
  const subsetFilter = data.__subsetFilter || null;
  const subsetChip = subsetFilter
    ? ` <span class="pill pill--filter">Filtered: ${escHtml(subsetLabel(subsetFilter))} <button type="button" class="pill__clear" data-clear-subset="${escAttr(data.pair)}" title="Show all agreement types" aria-label="Clear filter">&times;</button></span>`
    : "";

  const favBtn = state.favorites.has(data.pair)
    ? `<button class="btn btn--ghost" id="drawer-unfav">★ Unfavorite</button>`
    : `<button class="btn btn--ghost" id="drawer-fav">☆ Add to favorites</button>`;

  return `
    ${renderDrawerWinRateCard(data)}
    ${renderDrawerSubsetStrip(data)}
    <div class="drawer__section drawer__section--history">
      <h3>Signal History — Last ${historyMinutes} min <span class="drawer__section-count">${clusterHistory.length} candles</span>${subsetChip}</h3>
      <p class="drawer__hint"><i class="fas fa-hand-pointer"></i> Tap any row for the per-app breakdown.</p>
      <div class="table-scroll">
        <table class="pair-table pair-table--history" id="drawer-history-table">
          <thead><tr>
            <th>Time</th>
            <th>Apps</th>
            <th>Prediction</th>
            <th>Result</th>
            <th>Win/Loss</th>
            <th>Win Rate</th>
            <th aria-label="expand"></th>
          </tr></thead>
          <tbody id="drawer-history-body">${renderSimpleHistoryRows(clusterHistory, data) || `<tr><td colspan="7" class="placeholder">No signals in the last ${historyMinutes} minutes.</td></tr>`}</tbody>
        </table>
      </div>
    </div>
    <div class="drawer__section">
      ${favBtn}
    </div>
  `;
}

// Headline win-rate card for the drawer. The backend already ships
// winRate / gradedTotal / levelStats on /api/pair/{pair}; the drawer was
// throwing all of it away and rendering only the flat table.
function renderDrawerWinRateCard(data) {
  const levels = data.levelStats || {};
  const chips = ["3-agree", "2-agree", "conflict", "1-only"].map((lv) => {
    const s = levels[lv] || {};
    const graded = (s.win || 0) + (s.loss || 0);
    const wr = graded ? Math.round(((s.win || 0) / graded) * 1000) / 10 : null;
    return `<span class="level-chip">
      <span class="level-chip__name">${escHtml(lv)}</span>
      <span class="level-chip__wl">${s.win || 0}W/${s.loss || 0}L</span>
      <span class="wr-bar wr-bar--${wrClass(wr)}">${fmtWr(wr)}</span>
    </span>`;
  }).join("");
  return `
    <div class="drawer__section">
      <h3>Win Rate <span class="drawer__section-count">${data.gradedTotal || 0} graded</span></h3>
      <div class="drawer__headline">
        <span class="wr-bar wr-bar--${wrClass(data.winRate)} wr-bar--lg">${fmtWr(data.winRate)}</span>
      </div>
      <div class="level-chip-row">${chips}</div>
    </div>`;
}

// "Which app combination works on THIS pair" — one chip per app subset.
function renderDrawerSubsetStrip(data) {
  const stats = data.appPairStats || {};
  const cells = OVERALL_SUBSET_DEFS.map((def) => {
    const s = stats[def.key] || {};
    const graded = (s.win || 0) + (s.loss || 0);
    if (!graded && !(s.total || 0)) return "";
    const wr = graded ? Math.round(((s.win || 0) / graded) * 1000) / 10 : null;
    return `<span class="level-chip">
      <span class="level-chip__name">${escHtml(def.short)}</span>
      <span class="level-chip__wl">${s.win || 0}W/${s.loss || 0}L</span>
      <span class="wr-bar wr-bar--${wrClass(wr)}">${fmtWr(wr)}</span>
    </span>`;
  }).filter(Boolean).join("");
  if (!cells) return "";
  return `
    <div class="drawer__section">
      <h3>Win Rate by App Combination</h3>
      <div class="level-chip-row">${cells}</div>
    </div>`;
}

// CALL/PUT are opposites — used to derive the actual market result from a
// graded cluster: if the prediction WON the market moved the same way it
// called, if it LOST the market moved the other way.
function oppositeDir(dir) {
  if (dir === "CALL") return "PUT";
  if (dir === "PUT") return "CALL";
  return null;
}

// Renders the flat "Market / Pair / Time / Prediction / Result / Win-Loss /
// Win Rate" history table. Win Rate is a RUNNING total — computed walking
// the candles oldest → newest so each row shows the cumulative win rate up
// to and including that candle — then the rows are flipped back to
// newest-first for display, which is how a trader actually reads this list.
function renderSimpleHistoryRows(clusterHistory, data) {
  const chronological = (clusterHistory || []).slice().sort((a, b) => (a.ts || 0) - (b.ts || 0));

  let win = 0;
  let loss = 0;
  const withRunningWr = chronological.map((c) => {
    if (c.outcome === 1) win++;
    else if (c.outcome === 0) loss++;
    const graded = win + loss;
    return { ...c, __runningWr: graded > 0 ? (win / graded) * 100 : null };
  });

  withRunningWr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (withRunningWr.length === 0) return "";

  // Stash the rows so the click handler can re-render on expand/collapse
  // without refetching the drawer payload.
  state.drawerHistoryRows = withRunningWr;
  state.drawerHistoryPair = data;

  return withRunningWr.map((c) => {
    // "drawer:" prefix keeps this Set entry distinct from the Signal
    // History list's rowKey() for the same (pair, candle) — see that
    // function's comment.
    const key = `drawer:${data.pair}|${c.ts}`;
    const expanded = state.expandedHistoryRows.has(key);
    const prediction = c.direction || null;
    const result = c.outcome === 1 ? prediction : c.outcome === 0 ? oppositeDir(prediction) : null;
    const outcomeLabel = c.outcomeLabel || "—";
    const outcomeCls = c.outcome === 1 ? "win" : c.outcome === 0 ? "loss" : "unknown";
    const wr = c.__runningWr == null ? "—" : `${c.__runningWr.toFixed(1)}%`;
    const apps = (c.agreeing_apps || []).map((a) => APP_LABELS[a] || a).join(" + ") || "—";
    const detail = {
      ...c,
      pair: data.pair,
      displayPair: data.displayPair,
      category: data.category,
      marketResult: result,
      runningWinRate: c.__runningWr,
    };
    return `<tr class="hist-row${expanded ? " hist-row--open" : ""}" data-drawer-row="${escAttr(key)}" tabindex="0" role="button" aria-expanded="${expanded}">
      <td class="mono">${escHtml(c.candleUtc || "—")}</td>
      <td class="mono">${escHtml(apps)}</td>
      <td>${prediction ? `<span class="dir dir--${escAttr(prediction)}">${escHtml(prediction)}</span>` : "—"}</td>
      <td>${result ? `<span class="dir dir--${escAttr(result)}">${escHtml(result)}</span>` : "—"}</td>
      <td><span class="outcome outcome--${outcomeCls}">${escHtml(outcomeLabel)}</span></td>
      <td class="mono">${wr}</td>
      <td class="hist-row__chev"><i class="fas fa-chevron-${expanded ? "up" : "down"}"></i></td>
    </tr>
    ${expanded ? `<tr class="hist-detail-row"><td colspan="7">${renderConsensusDetail(detail)}</td></tr>` : ""}`;
  }).join("");
}

// Expand/collapse for the drawer's history rows. Delegated so it survives
// the drawer being re-rendered.
document.addEventListener("click", (e) => {
  const tr = e.target.closest?.("[data-drawer-row]");
  if (!tr) return;
  if (e.target.closest("[data-open-pair]")) return;
  const key = tr.dataset.drawerRow;
  if (state.expandedHistoryRows.has(key)) state.expandedHistoryRows.delete(key);
  else state.expandedHistoryRows.add(key);
  const body = $("drawer-history-body");
  if (body && state.drawerHistoryPair) {
    body.innerHTML = renderSimpleHistoryRows(
      state.drawerHistoryPair.clusterHistory || [],
      state.drawerHistoryPair,
    );
  }
});

// Clear an active subset filter (the "x" on the "Filtered: App 1 + App 2"
// chip) — re-opens the same pair's drawer with every agreement type shown.
document.addEventListener("click", (e) => {
  const btn = e.target.closest?.("[data-clear-subset]");
  if (!btn) return;
  e.stopPropagation();
  openPairDrawer(btn.dataset.clearSubset);
});

// Delegate fav button in drawer
document.addEventListener("click", (e) => {
  if (e.target.id === "drawer-fav" || e.target.id === "drawer-unfav") {
    if (state.drawerPair) {
      toggleFavorite(state.drawerPair);
      // Re-render drawer — KEEP the subset filter the drawer was opened
      // with (Per-Pair Stats cells / subset list open it pre-filtered);
      // refetching without it made the chip + filtered table vanish as a
      // side effect of pressing ★.
      openPairDrawer(state.drawerPair, { subset: state.drawerSubset || null });
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
    container.innerHTML = `<span class="placeholder">${escHtml(t("placeholder_no_favorites"))}</span>`;
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
$("btn-refresh-diag")?.addEventListener("click", fetchDiag);

async function fetchDiag() {
  $("diag-content").innerHTML = '<p class="placeholder">Loading diagnostics…</p>';
  try {
    const res = await fetch("/api/diag?poll=1", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    renderDiag(d);
  } catch (e) {
    $("diag-content").innerHTML = `<p class="placeholder">Failed: ${escHtml(e.message)}</p>`;
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
      <div class="level-stat__title">${escHtml(a.app)} <span style="color:var(--text-muted);font-weight:400;text-transform:none;">(health: ${escHtml(a.health)})</span></div>
      ${_freshnessBadge(a, nowSec)}
      <div class="level-stat__row" style="margin-top:8px;"><span>Raw rows</span><span>${a.rawRows}</span></div>
      <div class="level-stat__row"><span>Normalized</span><span>${a.normalizedSignals}</span></div>
      <div class="level-stat__row"><span>Skipped</span><span>${escHtml(JSON.stringify(a.skipped))}</span></div>
      <div class="level-stat__row"><span>Distinct pairs</span><span>${(a.distinctPairs || []).length}</span></div>
      <div class="level-stat__row"><span>Valid for own candle</span><span>${a.validForOwnCandle} / ${a.invalidForOwnCandle}</span></div>
    </div>`).join("");

  const offsets = (d.offsets || []).map((o) => `
    <div class="level-stat">
      <div class="level-stat__title">${escHtml(o.apps)}</div>
      <div class="level-stat__row"><span>Modal offset</span><strong>${o.modalOffsetCandles ?? "—"} candles</strong></div>
      <div class="level-stat__row"><span>Confidence</span><span>${(o.confidence * 100).toFixed(0)}%</span></div>
      <div class="level-stat__row"><span>Samples</span><span>${o.samples}</span></div>
      <div class="level-stat__row" style="font-size:11px;color:var(--text-dim);">${escHtml(o.hint)}</div>
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
      ${(d.notes || []).map((n) => `<li style="margin-bottom:6px;">${escHtml(n)}</li>`).join("")}
    </ul>
  `;
}

// ====== Signal Sources (Settings → Signal Sources) ======
// Lets the user repoint the aggregator at redeployed Railway apps from the
// UI — no code change, no redeploy. The backend (app/source_config.py)
// validates + normalizes + persists the URLs and every fetch point resolves
// them at call time, so saving takes effect on the next poll (~1s during
// the candle-open burst).
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

function _srcDotClass(appId) {
  const a = (state.snapshot?.apps || []).find((x) => x.id === appId);
  if (!a) return "";
  if (a.health === "ok") return " src-dot--ok";
  if (a.health === "down" || a.health === "disconnected") return " src-dot--bad";
  return " src-dot--warn";
}

function updateSourceDots() {
  $$("#sources-list .src-app").forEach((row) => {
    const dot = row.querySelector(".src-dot");
    if (dot) dot.className = "src-dot" + _srcDotClass(row.dataset.app);
  });
}

function _endpointKind(url) {
  return String(url || "").replace(/^https?:\/\/[^/]+/, "").split("?")[0] || "endpoint";
}

function renderSources() {
  const list = $("sources-list");
  if (!list || !sourceConfig) return;
  list.innerHTML = (sourceConfig.apps || []).map((app) => `
    <div class="src-app" data-app="${escAttr(app.id)}">
      <div class="src-app__head">
        <span class="src-dot${_srcDotClass(app.id)}"></span>
        <span class="src-app__name">${escHtml(app.shortName)} — ${escHtml(app.name)}</span>
        <span class="src-chip src-chip--${escAttr(app.source)}">${escHtml(t("src_chip_" + app.source))}</span>
        <button class="btn btn--ghost btn--sm src-test" type="button">${escHtml(t("btn_sources_test"))}</button>
      </div>
      <input class="src-url-input" type="url" inputmode="url" autocomplete="off" spellcheck="false"
             placeholder="https://<new-name>.up.railway.app"
             value="${escAttr(app.baseUrl || "")}" aria-label="${escAttr(app.shortName)} URL">
      <div class="src-endpoints">${escHtml(Object.values(app.endpoints || {}).map((e) => _endpointKind(e.url)).join("  ·  "))}</div>
      <div class="src-test-result"></div>
    </div>
  `).join("");
  $$("#sources-list .src-app").forEach((row) => {
    row.querySelector(".src-test")?.addEventListener("click", () => testSourceApp(row));
    row.querySelector(".src-url-input")?.addEventListener("input", () => {
      const id = row.dataset.app;
      const val = row.querySelector(".src-url-input")?.value?.trim() || "";
      const cur = (sourceConfig?.apps || []).find((a) => a.id === id)?.baseUrl || "";
      const purgeRow = $("src-purge-row");
      if (purgeRow && val && val !== cur) purgeRow.hidden = false;
    });
  });
}

async function testSourceApp(row) {
  const appId = row.dataset.app;
  const input = row.querySelector(".src-url-input");
  const out = row.querySelector(".src-test-result");
  const btn = row.querySelector(".src-test");
  if (!out || !btn) return;
  btn.disabled = true;
  out.innerHTML = `<p class="placeholder">${escHtml(t("src_testing"))}</p>`;
  try {
    const res = await fetch("/api/sources/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: appId, baseUrl: input ? input.value.trim() : "" }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || `HTTP ${res.status}`);
    out.innerHTML = Object.values(d.endpoints || {}).map((e) => e.ok
      ? `<span class="src-endpoint-chip src-endpoint-chip--ok"><strong>${escHtml(_endpointKind(e.url))}</strong> ${escHtml(t("src_test_ok"))} · ${e.rows} rows · ${e.latencyMs}ms</span>`
      : `<span class="src-endpoint-chip src-endpoint-chip--fail"><strong>${escHtml(_endpointKind(e.url))}</strong> ${escHtml(t("src_test_fail"))} · ${escHtml(e.error || "error")}</span>`
    ).join("")
    + `<span class="src-reach ${d.reachable ? "src-reach--ok" : "src-reach--bad"}">${escHtml(d.reachable ? t("src_reached") : t("src_unreachable"))}</span>`;
  } catch (e) {
    out.innerHTML = `<p class="placeholder placeholder--error">${escHtml(e.message)}</p>`;
  } finally {
    btn.disabled = false;
  }
}

function _srcSaveAppLine(p) {
  const eps = Object.values(p.endpoints || {})
    .map((e) => `${_endpointKind(e.url)}: ${e.ok ? t("src_test_ok") : t("src_test_fail")}`)
    .join(" · ");
  return `<p class="src-save-app ${p.reachable ? "src-save-app--ok" : "src-save-app--bad"}"><strong>${escHtml(p.app)}</strong> ${escHtml(eps)}</p>`;
}

$("btn-sources-save")?.addEventListener("click", async () => {
  const btn = $("btn-sources-save");
  const resultBox = $("sources-result");
  if (!btn || !sourceConfig) return;
  const apps = {};
  const changed = [];
  $$("#sources-list .src-app").forEach((row) => {
    const id = row.dataset.app;
    const val = row.querySelector(".src-url-input")?.value.trim() || "";
    const cur = (sourceConfig.apps || []).find((a) => a.id === id)?.baseUrl || "";
    if (val && val !== cur) {
      apps[id] = { baseUrl: val };
      changed.push(id);
    }
  });
  if (!changed.length) {
    if (resultBox) resultBox.innerHTML = `<p class="placeholder">${escHtml(t("src_no_change"))}</p>`;
    return;
  }
  btn.disabled = true;
  if (resultBox) resultBox.innerHTML = `<p class="placeholder">${escHtml(t("src_saving"))}</p>`;
  const purge = $("src-purge")?.checked ? changed : [];
  try {
    const res = await fetch("/api/sources", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apps, purgeCaches: purge, probe: true }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.message || `HTTP ${res.status}`);
    sourceConfig = d.config;
    renderSources();
    const probes = Object.values(d.probes || {});
    const allOk = probes.length > 0 && probes.every((p) => p.reachable);
    if (resultBox) {
      resultBox.innerHTML = `<p class="src-save-msg ${allOk ? "src-save-msg--ok" : "src-save-msg--warn"}">${escHtml(allOk ? t("src_saved_ok") : t("src_saved_unreachable"))}</p>`
        + probes.map(_srcSaveAppLine).join("");
    }
    const purgeRow = $("src-purge-row");
    if (purgeRow) purgeRow.hidden = true;
    const purgeChk = $("src-purge");
    if (purgeChk) purgeChk.checked = false;
    // Reconnect the dashboard immediately — don't wait for the next poll.
    pollSnapshot();
    pollSignalFeed();
    refreshBacktestStatus();
  } catch (e) {
    if (resultBox) resultBox.innerHTML = `<p class="placeholder placeholder--error">${escHtml(e.message)}</p>`;
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
    if (resultBox) resultBox.innerHTML = "";
    pollSnapshot();
  } catch (e) {
    if (resultBox) resultBox.innerHTML = `<p class="placeholder placeholder--error">${escHtml(e.message)}</p>`;
  }
});

// Refresh the panel every time it opens (fresh URLs + fresh status dots).
document.querySelector('#settings-folder-grid .folder-card[data-folder="sources"]')
  ?.addEventListener("click", () => loadSourcesUI());

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
    // applySettings() calls applyTranslations() on every change, but
    // re-translating every [data-i18n] (153 elements) is wasted work
    // when only the polling/theme/etc. changed. The language change
    // handler below calls applyTranslations() explicitly. (REVIEW-2 M46.)
    if (key === "lang") {
      applyTranslations();
      // Re-translate the currently selected dropdown labels too — the
      // <li> items just changed language, so labels copied from them
      // would otherwise keep the previous language (e.g. "All pairs"
      // staying English while the menu itself reads "সব পেয়ার").
      syncCategoryLabels();
      resyncDropdownLabels();
    }
    if (key === "poll") restartPolling();
    if (key === "notify" && el.checked && "Notification" in window && Notification.permission !== "granted") {
      Notification.requestPermission().then(() => {});
    }
  });
});

$("btn-clear-cache")?.addEventListener("click", () => {
  if (!confirm("Clear local cache?")) return;
  state.pairDetailCache.clear();
  state.signalFeedIds.clear();
  location.reload();
});
$("btn-reset-settings")?.addEventListener("click", () => {
  if (!confirm("Reset all settings to defaults?")) return;
  state.settings = Object.assign({}, DEFAULT_SETTINGS);
  saveSettings();
  applySettings();
  // Reset implies lang may have changed back to default — re-translate.
  applyTranslations();
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
  const apps = state.snapshot?.apps || [];
  state.healthAlertDismissedApps = new Set(
    apps.filter((a) => _isAppUnhealthy(a)).map((a) => a.id ?? a.name)
  );
});

applySettings();
// applySettings() no longer calls applyTranslations() on every change
// (perf optimization, REVIEW-2 M46) — but the INITIAL load needs the
// translations applied once, so do it explicitly here.
applyTranslations();
wireHeroCards();
syncCategoryLabels();
resyncDropdownLabels();
startPolling();
refreshBacktestStatus();
// Pre-load the Signal Sources config so the Settings panel is instant and
// the per-app status dots are wired before the first open.
loadSourcesUI();
