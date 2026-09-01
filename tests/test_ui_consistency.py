"""UI consistency tests for the simplified 4-tab dashboard.

These lock down the things that silently drift when someone edits a panel:
duplicate ids, JS lookups with no element, classes with no CSS, colspans
that don't match the header, win-rate thresholds that disagree, and
half-translated strings. They also lock the STRUCTURE the user asked for:

- exactly four nav destinations — Home, Signals, History, Settings — with
  no extra tabs (the old "Map" tab must stay gone),
- the pair switcher (strip chips + drawer prev/dropdown/next/new-window),
- the six agreement-type filters (all / 3-agree / 2-agree /
  app1+app2 / app1+app3 / app2+app3) on the Signals history panel,
  the History tab, and the pair drawer tabs.
"""

from __future__ import annotations

import collections
import os
import re

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HTML_PATH = os.path.join(ROOT, "app", "templates", "dashboard.html")
CSS_PATH = os.path.join(ROOT, "app", "static", "dashboard.css")
JS_PATH = os.path.join(ROOT, "app", "static", "dashboard.js")

TABS = ["home", "signals", "history", "settings"]


@pytest.fixture(scope="module")
def html() -> str:
    return open(HTML_PATH, encoding="utf-8").read()


@pytest.fixture(scope="module")
def css() -> str:
    return open(CSS_PATH, encoding="utf-8").read()


@pytest.fixture(scope="module")
def js() -> str:
    return open(JS_PATH, encoding="utf-8").read()


# ---------------------------------------------------------------------------
# Structure
# ---------------------------------------------------------------------------


def test_no_duplicate_html_ids(html):
    ids = re.findall(r'\bid="([^"]+)"', html)
    dupes = [i for i, n in collections.Counter(ids).items() if n > 1]
    assert dupes == [], f"duplicate id(s): {dupes}"


def test_every_js_element_lookup_resolves(html, js):
    """Every ``$("some-id")`` must exist in the template or be created by JS."""
    html_ids = set(re.findall(r'\bid="([^"]+)"', html))
    js_made = set(re.findall(r'id="([a-zA-Z][\w-]*)"', js))
    wanted = set(re.findall(r'\$\("([a-zA-Z][\w-]*)"\)', js))
    missing = sorted(wanted - html_ids - js_made)
    assert missing == [], f"$() targets that never exist: {missing}"


def test_exactly_four_tabs_on_both_nav_rails(html):
    """The user asked for exactly four tabs: Home, Signal, History, Setting.
    Both nav rails (mobile bottom nav + desktop side nav) must carry the
    same four destinations — no extras, no missing."""
    bottom = re.findall(r'class="bottomnav__item[^"]*" data-tab="([a-z]+)"', html)
    side = re.findall(r'class="sidenav__item[^"]*" data-tab="([a-z]+)"', html)
    assert bottom == TABS, f"bottom nav tabs: {bottom}"
    assert side == TABS, f"sidenav tabs: {side}"


def test_no_map_tab_anywhere(html, js, css):
    """The old fifth 'Map' tab was removed on purpose — it must not creep
    back into the markup, the JS, or the stylesheet."""
    assert 'data-tab="map"' not in html
    assert 'id="tab-map"' not in html
    assert "renderAppMap" not in js
    assert "map-group" not in css
    assert "nav_map" not in js


def test_every_tab_has_a_section(html):
    for name in TABS:
        assert f'id="tab-{name}"' in html, f"missing section #tab-{name}"


def test_colspans_match_their_table_headers(html, js):
    """Empty-state / detail colspans must match the number of <th> columns."""
    tables = {
        "pair-table": 8,
        "sp-history-table": 8,
        "hist-table": 8,
    }
    for tid, cols in tables.items():
        head = html.split(f'id="{tid}"')[1].split("</thead>")[0]
        assert len(re.findall(r"<th[ >]", head)) == cols, f"{tid} header changed"
    # JS-rendered list rows span 8 columns; drawer rows span 7 (drawer
    # table has no Pair column — the pair is in the drawer title).
    assert 'hist-detail-row"><td colspan="8">' in js
    assert 'hist-detail-row"><td colspan="7">' in js
    assert 'colspan="7" class="placeholder">' in js


# ---------------------------------------------------------------------------
# CSS health
# ---------------------------------------------------------------------------


def test_css_braces_balanced(css):
    assert css.count("{") == css.count("}")


def test_no_undeclared_css_variables(css):
    declared = set(re.findall(r"(--[a-z0-9-]+)\s*:", css))
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    used = set(re.findall(r"var\((--[a-z0-9-]+)", body))
    unknown = sorted(used - declared)
    assert unknown == [], f"var() referencing undeclared tokens: {unknown}"


def test_no_empty_css_rules(css):
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    assert re.findall(r"\{\s*\}", body) == [], "empty CSS rule left behind"


def test_no_hardcoded_white_surfaces(css):
    """``rgba(255,255,255,…)``` surfaces look fine on dark and are invisible
    on the light theme — colour must come from tokens."""
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    assert not re.findall(r"rgba\(255,\s*255,\s*255", body), (
        "rgba(255,255,255,…) surfaces break the light theme"
    )


def test_themeable_classes_use_tokens(css):
    """Every win-rate / outcome colour modifier must be declared."""
    for mod in ("good", "mid", "bad", "none"):
        assert re.search(rf"\.wr--{mod}\b", css), f".wr--{mod} has no CSS rule"


# ---------------------------------------------------------------------------
# Class / modifier cross-reference
# ---------------------------------------------------------------------------

REQUIRED_CLASSES = [
    # chrome
    "topbar", "clock", "status", "alert",
    # home
    "hero", "hero-row", "app-grid", "app-card", "app-card__name",
    "app-card__count", "app-card__detail", "dot", "feed-item",
    "feed-item__time", "feed-item__pair", "feed-item__meta", "bt-levels",
    # signals
    "strip-section", "strip-head", "strip-title", "strip-meta",
    "pair-strip", "pair-chip", "pair-chip__dot", "pair-chip__dot--otc",
    "pair-chip__dot--real", "pair-chip__dir", "pair-chip__dir--CALL",
    "pair-chip__agree", "wr-grid", "wr-card", "wr-card__label",
    "wr-card__wr", "wr-card__sub", "seg-tabs", "seg-tab",
    "filters", "table-wrap", "grid-table", "grid-table--history",
    "table-foot", "pair-row",
    # history rows + detail
    "hist-row", "hist-row--open", "hist-row__chev", "hist-detail-row",
    "hist-detail", "hist-detail__head", "hist-detail__pair",
    "hist-detail__verdict--win", "hist-detail__verdict--loss",
    "hist-detail__verdict--pending", "hist-detail__meta",
    "hist-detail__actions", "app-card-grid", "hist-app-card",
    "hist-app-card--agree", "hist-app-card--silent", "hist-app-card__name",
    # shared chips / pills
    "summary-strip", "summary-chip", "summary-chip__label",
    "pill--otc", "pill--real", "dir--CALL", "dir--PUT",
    "outcome--win", "outcome--loss", "outcome--unknown",
    "placeholder", "placeholder--error", "hint",
    # drawer
    "drawer-overlay", "drawer", "drawer__header", "drawer__sub",
    "drawer__close", "drawer__switcher", "drawer__navbtn",
    "drawer__pairselect", "drawer__newwin", "drawer__body",
    "drawer__section", "drawer__section-count", "drawer-tabs",
    "drawer-tab", "drawer-tab--active", "drawer-tab__name",
    "drawer-tab__wr", "drawer-tab__stats",
    # settings
    "setting-row", "btn-row", "about-row", "btn", "btn--primary",
    "btn--ghost", "btn--mini", "src-row", "src-row__name", "src-dot",
    # nav
    "bottomnav", "bottomnav__item", "bottomnav__icon", "bottomnav__label",
    "sidenav", "sidenav__item",
]


@pytest.mark.parametrize("cls", REQUIRED_CLASSES)
def test_class_has_a_css_rule(css, cls):
    assert re.search(rf"\.{re.escape(cls)}\b", css), f".{cls} is used but has no CSS"


def test_wr_class_modifiers_match_the_stylesheet(js, css):
    """``wrClass()`` must only ever return a modifier the CSS defines."""
    fn = js.split("function wrClass(wr) {")[1].split("}")[0]
    returned = set(re.findall(r'return "(\w+)"', fn))
    assert returned, "could not parse wrClass()"
    for mod in returned:
        assert re.search(rf"\.wr--{mod}\b", css), f"wrClass() returns '{mod}' with no .wr--{mod} rule"


def test_wr_class_thresholds_are_the_app_wide_60_45(js):
    fn = js.split("function wrClass(wr) {")[1].split("}")[0]
    assert "wr >= 60" in fn and "wr >= 45" in fn, (
        "wrClass() must use the app-wide 60/45 thresholds"
    )


# ---------------------------------------------------------------------------
# i18n
# ---------------------------------------------------------------------------


def _i18n_tables(js):
    blocks = re.findall(r"\n  (en|bn):\s*\{(.*?)\n  \},", js, re.S)
    return {
        lang: set(re.findall(r"([a-z][a-zA-Z0-9_]*)\s*:\s*[\"']", body))
        for lang, body in blocks
    }


def test_english_and_bengali_have_the_same_keys(js):
    tables = _i18n_tables(js)
    assert set(tables) == {"en", "bn"}, "expected an `en` and a `bn` table"
    missing_bn = sorted(tables["en"] - tables["bn"])
    missing_en = sorted(tables["bn"] - tables["en"])
    assert missing_bn == [], f"untranslated (falls back to English): {missing_bn}"
    assert missing_en == [], f"present in bn but not en: {missing_en}"


def test_every_referenced_i18n_key_exists(html, js):
    tables = _i18n_tables(js)
    used = set(re.findall(r'data-i18n="([^"]+)"', html))
    used |= set(re.findall(r'data-i18n-placeholder="([^"]+)"', html))
    used |= set(re.findall(r'\bt\("([a-z][a-zA-Z0-9_]*)"\)', js))
    missing = sorted(k for k in used if k not in tables["en"])
    assert missing == [], f"referenced but undefined i18n keys: {missing}"


def test_i18n_tables_contain_no_orphan_map_or_folder_keys(js):
    """Removed features must not leave dead translation keys behind."""
    tables = _i18n_tables(js)
    for key in ("nav_map", "map_title", "folder_drilldown_title", "folder_offsets_title"):
        assert key not in tables["en"], f"dead i18n key still present: {key}"


# ---------------------------------------------------------------------------
# Agreement-type filters (the user's core requirement)
# ---------------------------------------------------------------------------

COMBOS = ["all", "3-agree", "2-agree", "app1+app2", "app1+app3", "app2+app3"]
# Direction tabs sit after the agreement tabs in the pair drawer.
DRAWER_DIRECTION_KEYS = ["dir-call", "dir-put"]


def test_drawer_agreement_tabs_cover_the_user_asked_combinations(js):
    """The pair drawer must expose one tab per agreement type the user asked
    for: 2-agree, 3-agree, app1+app2, app1+app3, app2+app3 (plus "all").
    Each pairwise tab maps 1:1 onto the backend's app_subset_key. A CALL and
    a PUT tab close the row so each side of the market can be judged alone."""
    block = js.split("const DRAWER_TABS = [")[1].split("];", 1)[0]
    keys = re.findall(r'key: "([a-z0-9+-]+)"', block)
    assert keys == COMBOS + DRAWER_DIRECTION_KEYS


def test_drawer_direction_tabs_match_on_direction(js):
    """The CALL/PUT drawer tabs must filter on the row's direction, not on
    level or subset — so 'CALL' counts every CALL candle across levels."""
    block = js.split("const DRAWER_TABS = [")[1].split("];", 1)[0]
    assert 'key: "dir-call", label: "CALL", match: (c) => c.direction === "CALL"' in block
    assert 'key: "dir-put", label: "PUT", match: (c) => c.direction === "PUT"' in block


def test_signals_history_panel_tabs_match_drawer_tabs(html):
    tabs = re.findall(r'data-shfilter="([a-z0-9+-]+)"', html)
    assert tabs == COMBOS


def test_history_tab_tabs_match_drawer_tabs(html):
    tabs = re.findall(r'data-hfilter="([a-z0-9+-]+)"', html)
    assert tabs == COMBOS


def test_signals_and_history_share_one_filter_table(js):
    """Both history views must render through the SAME painter + row
    renderer, so a fix to the row layout can't miss one of them."""
    assert "function paintHistoryTable(prefix" in js
    assert 'paintHistoryTable("sp-history"' in js
    assert 'paintHistoryTable("hist"' in js


def test_history_list_and_drawer_row_keys_are_namespaced(js):
    """state.expandedRows is a single Set shared by the list views
    (list:pair|ts) and the drawer's own table (drawer:pair|ts) — the two
    key-builders must use distinct prefixes so a candle expanded in one
    view never renders pre-expanded in the other."""
    assert "list:" in js.split("function listRowKey(c)")[1].split("\n", 1)[0]
    drawer_keys = re.findall(r"const key = `(drawer:\$\{[^`]+)`;", js)
    assert drawer_keys, "drawer row key must use the drawer: prefix"


# ---------------------------------------------------------------------------
# Pair switcher / hash router — regression locks
# ---------------------------------------------------------------------------


def test_pair_switcher_strip_exists(html):
    assert 'id="sp-pair-strip"' in html
    assert 'id="sp-pairstrip-meta"' in html
    assert 'data-i18n="panel_pair_switcher"' in html


def test_pair_chips_are_anchors_to_pair_routes(js):
    strip_fn = js.split("function renderPairStrip()", 1)[1].split("// ---- Live win-rate", 1)[0]
    assert 'href="#/signals/pair/' in strip_fn
    assert "encodeURIComponent(p.pair)" in strip_fn
    assert "is-active" in strip_fn  # current drawer pair is highlighted


def test_drawer_has_pair_switcher_bar(html):
    """The pair drawer must let the user flip through pairs without
    closing: prev/next buttons, a pair dropdown, and a ↗ new-window link."""
    block = html.split('class="drawer__switcher"')[1].split("</div>", 1)[0]
    for el in ("drawer-prev", "drawer-next", "drawer-pairselect", "drawer-newwin"):
        assert el in block, f"drawer switcher is missing {el}"
    assert 'target="_blank"' in html.split('id="drawer-newwin"')[1][:120], (
        "drawer ↗ must open in a NEW window"
    )


def test_drawer_switcher_is_wired_in_js(js):
    for caller in ("stepDrawerPair", "$(\"drawer-pairselect\")"):
        assert caller in js
    fn = js.split("function updateDrawerSwitcher(data) {")[1].split("\n}", 1)[0]
    assert "#/signals/pair/" in fn, "↗ link href must point at the pair route"


def test_js_router_covers_all_deep_links(js):
    for marker in (
        "function applyRoute()",
        "function nav(hash)",
        'addEventListener("hashchange", applyRoute)',
        '"signals"',
        '"history"',
        '"settings"',
    ):
        assert marker in js, f"router is missing: {marker}"
    # The boot sequence must apply the initial route so deep links land on
    # the right view even in a freshly opened window.
    boot = js.rsplit("startPolling();", 1)[1]
    assert "applyRoute();" in boot


def test_drawer_close_navigates_back_via_router(js):
    """Closing the drawer (✕ / overlay tap / Escape) must route back to the
    view it was opened over, and the router closes it silently when the
    route itself changed."""
    close_fn = js.split("function closePairDrawer(opts = {}) {")[1].split("\n}", 1)[0]
    assert "opts.silent" in close_fn
    assert "nav(" in close_fn
    for caller in ("requestCloseDrawer()", "drawer-close"):
        assert caller in js
    assert 'if (e.target === $("drawer-overlay")) requestCloseDrawer();' in js


def test_router_records_a_return_hash_for_the_drawer(js):
    """applyRoute() must record the last non-pair hash so closing a
    deep-linked drawer returns somewhere sensible."""
    route_fn = js.split("function applyRoute() {")[1].split("\n}", 1)[0]
    assert "drawerReturnHash" in route_fn


def test_open_pair_drawer_uses_the_subset_option(js):
    """openPairDrawer(pair, {subset}) is promised to open the drawer
    pre-scoped to that combination — opts.subset must become the active
    drawer tab, not be silently dropped."""
    fn = js.split("async function openPairDrawer(pair, opts = {}) {")[1].split("\nfunction closePairDrawer", 1)[0]
    assert "opts.subset" in fn
    assert "state.drawerTab" in fn


def test_expandable_rows_are_keyboard_reachable(js):
    row = js.split("function renderListRow(c) {")[1].split("\n}")[0]
    for attr in ('role="button"', 'tabindex="0"', "aria-expanded="):
        assert attr in row, f"expandable row is missing {attr}"


def test_expandable_rows_handle_enter_and_space(js):
    block = js.split("function wireListRowToggles")[1].split("\n}")[0]
    assert '"Enter"' in block and '" "' in block, "row toggle is not keyboard-operable"


def test_narrow_screens_drop_the_crowded_columns(css):
    """8 columns on a 360px phone is ~45px each. The two columns whose
    content also appears in the expanded detail get hidden instead."""
    for table in ("sp-history-table", "hist-table"):
        assert f"#{table} th:nth-child(5)" in css
        assert f"#{table} th:nth-child(7)" in css


def test_filter_controls_have_accessible_labels(html):
    for sel in ("filter-market", "filter-level", "hist-direction", "hist-minutes",
                "drawer-pairselect", "sh-pair", "hist-pair"):
        # Grab the whole tag that carries the id (aria-label may sit before
        # or after the id attribute).
        tail = html.split(f'id="{sel}"', 1)[1][:160]
        head = html.split(f'id="{sel}"', 1)[0][-160:]
        assert "aria-label" in tail or "aria-label" in head, (
            f"#{sel} has no accessible label"
        )


def test_settings_are_flat_panels_not_folders(html):
    """The user asked for a simple Settings tab — plain stacked panels,
    no folder-card grid, no sub-routes."""
    assert "settings-folder-grid" not in html
    assert "data-folder" not in html
    for panel in ("set-theme", "set-lang", "set-tz", "set-sound",
                  "sources-list", "btn-sources-save", "btn-clear-cache"):
        assert f'id="{panel}"' in html


def test_sources_panel_uses_the_runtime_url_api(js):
    """Signal Sources stays: GET /api/sources, POST /api/sources (probe),
    POST /api/sources/reset — the no-redeploy URL management."""
    assert 'fetch("/api/sources"' in js
    assert '"/api/sources/test"' in js
    assert '"/api/sources/reset"' in js


def test_no_dead_feature_code_remains(js):
    """Removed panels must not leave dead functions in the bundle."""
    for gone in (
        "renderAppPairLeaders", "renderSubsetPairList", "renderPerPairTable",
        "exportSignalsCsv", "renderActiveFilterTags", "renderBacktest",
        "loadDiag", "renderDiag", "runBacktest", "populateHistoryPairSelector",
    ):
        assert gone not in js, f"dead function still present: {gone}"


# ---------------------------------------------------------------------------
# Touch / nav wiring (mobile regression)
# ---------------------------------------------------------------------------


def test_nav_buttons_are_wired_to_the_router(js):
    """Regression: the 4-tab rebuild shipped both nav rails WITHOUT click
    listeners — tapping Home/Signals/History/Settings did nothing on mobile
    and every tab except Home was unreachable by touch. The JS must select
    both rails and route every tap through nav(#/<tab>)."""
    pattern = re.compile(
        r'\$\$\("\.bottomnav__item,\s*\.sidenav__item"\)\s*\.forEach\('
        r'[^;]*?dataset\.tab',
        re.S,
    )
    assert pattern.search(js), (
        "nav buttons are not wired: add "
        '$$(".bottomnav__item, .sidenav__item").forEach((btn) => '
        'btn.addEventListener("click", () => nav(`#/${btn.dataset.tab}`)))'
    )


def test_nav_wiring_runs_at_boot_not_inside_a_conditional(js):
    """The listener block sits at top level (runs once on load). If it were
    inside a function that is never called, tabs would silently die again."""
    m = re.search(
        r'^\$\$\("\.bottomnav__item, \.sidenav__item"\)\.forEach',
        js,
        re.M,
    )
    assert m, "nav wiring must be a top-level statement (column 0), not nested"


def test_tab_switch_closes_an_open_pair_drawer(js):
    """Tapping a nav tab while a pair drawer is open must dismiss the
    drawer — otherwise the drawer stays stuck over the new tab and every
    tab feels broken on mobile."""
    apply_body = js.split("function applyRoute() {")[1].split("\n}")[0]
    assert re.search(
        r"if\s*\(!isPairRoute[^)]*\)\s*closePairDrawer", apply_body
    ), "applyRoute() must closePairDrawer({silent:true}) on non-pair routes"


def test_touch_targets_opt_out_of_double_tap_zoom(css):
    """touch-action: manipulation removes the double-tap-zoom hold that
    makes taps feel dead on mobile; tap-highlight off so the grey flash
    does not linger over the bottom nav."""
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    m = re.search(r"touch-action:\s*manipulation", body)
    assert m, "add touch-action: manipulation for interactive elements"
    assert "-webkit-tap-highlight-color" in body


# ---------------------------------------------------------------------------
# Pair filter on the history panels (user request)
# ---------------------------------------------------------------------------


def test_history_panels_have_pair_filter_selects(html):
    """The user asked for a per-pair filter on the live history views: the
    Signals tab's Live Signal History panel and the History tab's list both
    carry a pair dropdown."""
    assert 'id="sh-pair"' in html, "Signals Live Signal History needs a pair filter"
    assert 'id="hist-pair"' in html, "History tab list needs a pair filter"
    # Both default to an "All pairs" option and start empty — JS fills them.
    assert html.count('data-i18n="opt_all_pairs"') >= 2


def test_history_queries_carry_the_pair_param(js):
    """Both panels must send the selected pair to the server (server-side
    filtering — client-side filtering would only clip the fetched page)."""
    sp_q = js.split("async function renderSpHistoryPanel")[1].split("URLSearchParams({")[1].split("})")[0]
    hist_q = js.split("async function renderHistoryPanel")[1].split("URLSearchParams({")[1].split("})")[0]
    assert "pair" in sp_q, "Live Signal History query must include the pair param"
    assert "pair" in hist_q, "History list query must include the pair param"


def test_history_pair_cache_keys_include_the_selection(js):
    """The 30s panel cache must be keyed by the pair selection too —
    otherwise switching pairs serves the previous pair's rows."""
    assert "state._spHistoryData.__pair === pair" in js
    assert "state._histData.__pair === pair" in js
    assert 'data.__pair = pair' in js


def test_pair_options_populate_from_the_snapshot(js):
    """One dropdown option per known pair, filled from the snapshot, with
    the current selection preserved across polls."""
    assert "function renderPairOptions()" in js
    assert 'renderPairOptions();' in js.split("function render()")[1].split("function")[0]
    for id_sel in ("sh-pair", "hist-pair"):
        assert f'"{id_sel}"' in js
