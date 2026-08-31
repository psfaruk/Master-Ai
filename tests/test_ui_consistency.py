"""UI consistency tests.

These lock down the things that silently drift when someone adds a panel:
duplicate ids, classes with no CSS, colspans that don't match the header,
hardcoded colours that break the light theme, and half-translated strings.

Every check here caught a real defect when it was written:

- ``wrClass()`` returned a ``bad`` modifier that had no CSS rule, and used
  65/50 thresholds while the rest of the dashboard used 60/45 — so the same
  win rate rendered green in one panel and amber in another.
- The new history CSS redeclared ``.wr-bar``, silently restyling every
  win-rate pill in the app (pill shape, mono font and min-width all lost).
- It also used ``rgba(255,255,255,.045)`` backgrounds and hardcoded hex
  text colours, which are invisible on the light theme.
- ``th_winrate`` was referenced by ``data-i18n`` but never defined.
- ``.stat`` was used in the level cards with no rule behind it.
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


def test_exactly_one_history_panel_is_active_by_default(html):
    active = re.findall(r'class="history-panel history-panel--active" id="([^"]+)"', html)
    assert len(active) == 1, f"expected 1 default-active history panel, got {active}"


def test_history_folder_cards_all_have_a_panel(html):
    """Every History folder card must open a panel that exists.

    Scoped to the History tab: the Settings tab reuses the same
    ``data-folder`` markup but renders ``settings-panel`` sections.
    """
    grid = html.split('id="history-folder-grid"')[1].split('id="history-folder-detail"')[0]
    folders = set(re.findall(r'data-folder="([^"]+)"', grid))
    assert folders, "no History folder cards found — did the markup move?"
    panels = set(re.findall(r'id="history-([a-z]+)"', html))
    missing = sorted(f for f in folders if f not in panels)
    assert missing == [], f"History folder cards with no panel: {missing}"


def test_settings_folder_cards_all_have_a_panel(html):
    grid = html.split('id="settings-folder-grid"')[1].split('id="settings-folder-detail"')[0]
    folders = set(re.findall(r'data-folder="([^"]+)"', grid))
    assert folders, "no Settings folder cards found — did the markup move?"
    panels = set(re.findall(r'id="settings-([a-z]+)"', html))
    missing = sorted(f for f in folders if f not in panels)
    assert missing == [], f"Settings folder cards with no panel: {missing}"


def test_detail_row_colspan_matches_header_column_count(html, js):
    """A colspan smaller than the header leaves a visual gap; larger breaks
    the table layout."""
    head = html.split('id="consensuslist-table"')[1].split("</thead>")[0]
    columns = len(re.findall(r"<th[ >]", head))
    colspans = {
        int(m) for m in re.findall(r'hist-detail-row"><td colspan="(\d+)"', js)
    }
    assert columns in colspans, (
        f"consensuslist has {columns} columns but detail rows use colspan={colspans}"
    )


# ---------------------------------------------------------------------------
# CSS health
# ---------------------------------------------------------------------------


def test_css_braces_balanced(css):
    assert css.count("{") == css.count("}")


def test_no_undeclared_css_variables(css):
    declared = set(re.findall(r"(--[a-z0-9-]+)\s*:", css))
    # Strip comments first — prose mentioning var(--color) is not a usage.
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    used = set(re.findall(r"var\((--[a-z0-9-]+)", body))
    unknown = sorted(used - declared)
    assert unknown == [], f"var() referencing undeclared tokens: {unknown}"


def test_history_css_uses_design_tokens_not_hardcoded_colours(css):
    """The history block must theme correctly.

    Hardcoded hex text colours and ``rgba(255,255,255,…)`` surfaces look
    fine on the dark theme and are invisible on the light one. Colour must
    come from the ``--emerald`` / ``--red`` / ``--blue`` / ``--bg-card`` /
    ``--border`` tokens, matching the ``rgba(r,g,b,0.15)`` + ``var(--x)``
    pattern the folder-card icons already use.
    """
    block = css.split("HISTORY TAB — breadcrumb, sub-folders, expandable rows")[1]
    block = re.sub(r"/\*.*?\*/", "", block, flags=re.S)
    hex_colours = re.findall(r"#[0-9a-fA-F]{6}\b", block)
    white_surfaces = re.findall(r"rgba\(255,\s*255,\s*255", block)
    assert hex_colours == [], f"hardcoded hex in history CSS: {hex_colours}"
    assert white_surfaces == [], "rgba(255,255,255,…) surfaces break the light theme"


def test_no_empty_css_rules(css):
    body = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    assert re.findall(r"\{\s*\}", body) == [], "empty CSS rule left behind"


def test_wr_bar_base_is_declared_exactly_once(css):
    """Redeclaring the shared ``.wr-bar`` base restyles every win-rate pill
    in the app, not just the new panels."""
    bases = re.findall(r"^\.wr-bar \{", css, re.M)
    assert len(bases) == 1, f"`.wr-bar` base declared {len(bases)}x — must be 1"


# ---------------------------------------------------------------------------
# Class / modifier cross-reference
# ---------------------------------------------------------------------------

# Every literal class the new history UI emits, and the dynamic modifiers it
# can produce. Kept explicit rather than scraped, because scraping template
# literals yields noise like "${escAttr(c.level)}".
REQUIRED_CLASSES = [
    "breadcrumb", "breadcrumb__link", "breadcrumb__sep", "breadcrumb__current",
    "subfolder-grid", "subfolder-card", "subfolder-card__title",
    "subfolder-card__desc", "subfolder-card__stats", "subfolder-card__note",
    "subfolder-card__icon--emerald", "subfolder-card__icon--blue",
    "subfolder-card__icon--amber", "subfolder-card__icon--violet",
    "summary-strip", "summary-strip__item", "summary-strip__label",
    "hist-row", "hist-row--open", "hist-row__chev", "hist-detail-row",
    "hist-detail", "hist-detail__head", "hist-detail__pair",
    "hist-detail__verdict--win", "hist-detail__verdict--loss",
    "hist-detail__verdict--pending", "hist-detail__meta", "hist-detail__actions",
    "app-card-grid", "app-card", "app-card--agree", "app-card--silent",
    "app-card__name", "app-card__dir",
    "level-chip-row", "level-chip", "level-chip__name", "level-chip__wl",
    "wr-bar--lg", "panel__note", "panel__sub", "placeholder--error", "check",
    "drawer__headline",
    "drawer-tabs", "drawer-tab", "drawer-tab--active", "drawer-tab__name",
    "drawer-tab__wr", "drawer-tab__stats",
    "subfolder-heading", "panel__body--flush",
    "sp-wr-section", "sp-wr-head", "sp-wr-title", "sp-wr-meta",
    "sp-wr-grid", "sp-wr-card", "sp-wr-card__label", "sp-wr-card__wr",
    "sp-wr-card__sub",
    "sp-history-section", "sp-history-tabs", "sp-history-tab",
    "sp-history-summary", "sp-history-tablewrap", "sp-history-scroll",
]


@pytest.mark.parametrize("cls", REQUIRED_CLASSES)
def test_class_has_a_css_rule(css, cls):
    assert re.search(rf"\.{re.escape(cls)}\b", css), f".{cls} is used but has no CSS"


def test_wr_class_modifiers_match_the_stylesheet(js, css):
    """``wrClass()`` must only ever return a modifier the CSS defines."""
    fn = js.split("function wrClass(wr) {")[1].split("}")[0]
    returned = set(re.findall(r'return "([a-z]+)"', fn))
    assert returned, "could not parse wrClass()"
    for mod in returned:
        assert re.search(rf"\.wr-bar--{mod}\b", css), f"wrClass() returns '{mod}' with no .wr-bar--{mod} rule"


def test_wr_class_thresholds_match_the_rest_of_the_dashboard(js):
    """The dashboard's established convention is 60 / 45. A second helper
    using different cut-offs makes the same number render a different colour
    depending on which panel you are looking at."""
    fn = js.split("function wrClass(wr) {")[1].split("\n}")[0]
    assert "wr >= 60" in fn and "wr >= 45" in fn, (
        "wrClass() must use the app-wide 60/45 thresholds"
    )


def test_no_hand_rolled_win_rate_threshold_disagrees_with_wr_class(js):
    """Two render functions (Backtest per-level cards, Per-Pair Stats table)
    used to duplicate wrClass()'s good/mid/low logic inline with their own
    ``>= 40`` cutoff instead of the app-wide ``>= 45`` — so the identical win
    rate (e.g. 42%) rendered "mid" (amber) in those two panels while every
    other panel, including the adjacent per-app-subset columns in the SAME
    table row, rendered "low" (red) via wrClass(). Guard against a hand-rolled
    threshold ternary reappearing anywhere outside wrClass() itself."""
    body = js.split("function wrClass(wr) {", 1)[0] + js.split("function wrClass(wr) {", 1)[1].split("\n}", 1)[1]
    assert not re.search(r">=\s*60\s*\?[^:]*:\s*[a-zA-Z_.]+\s*>=\s*40\b", body), (
        "found a hand-rolled 60/40 win-rate threshold outside wrClass() — "
        "use wrClass() instead so every panel agrees on good/mid/low"
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
    used |= set(re.findall(r'\bt\("([a-z][a-zA-Z0-9_]*)"\)', js))
    missing = sorted(k for k in used if k not in tables["en"])
    assert missing == [], f"referenced but undefined i18n keys: {missing}"


# ---------------------------------------------------------------------------
# Accessibility / mobile
# ---------------------------------------------------------------------------


def test_expandable_rows_are_keyboard_reachable(js):
    """Rows are clickable, so they need a role, a tab stop and an
    aria-expanded state — otherwise the detail view is mouse-only."""
    row = js.split("function renderConsensusRow(c) {")[1].split("\n}")[0]
    for attr in ('role="button"', 'tabindex="0"', "aria-expanded="):
        assert attr in row, f"expandable row is missing {attr}"


def test_expandable_rows_handle_enter_and_space(js):
    block = js.split("function wireConsensusRowToggles")[1].split("\n}")[0]
    assert '"Enter"' in block and '" "' in block, "row toggle is not keyboard-operable"


def test_narrow_screens_drop_the_crowded_columns(css):
    """8 columns on a 360px phone is ~45px each. The two columns whose
    content also appears in the expanded detail get hidden instead."""
    assert "#consensuslist-table th:nth-child(3)" in css
    assert "#drawer-history-table th:nth-child(2)" in css


def test_filter_controls_have_accessible_labels(html):
    panel = html.split('id="history-consensuslist"')[1].split("</div>\n        </div>")[0]
    for sel in ("consensus-direction", "consensus-minutes"):
        chunk = panel.split(f'id="{sel}"')[1][:120]
        assert "aria-label" in panel.split(f'id="{sel}"')[0][-200:] or "aria-label" in chunk, (
            f"#{sel} has no accessible label"
        )


# ---------------------------------------------------------------------------
# App Pair Leaders / per-pair drawer subset filter
# ---------------------------------------------------------------------------


def test_app_pair_leader_headline_wr_has_high_and_low_css(css):
    """renderAppPairLeaders() assigns a "high"/"low" modifier class to
    .sp-app-pair-leader-col__wr, but the stylesheet only ever defined the
    base rule — every App Pair Leaders headline win-rate number rendered in
    the same flat blue regardless of value, unlike the sibling
    .sp-app-pair-card__wr / .overall-card__wr, which do colour-code."""
    for mod in ("high", "low"):
        assert re.search(rf"\.sp-app-pair-leader-col__wr\.{mod}\b", css), (
            f".sp-app-pair-leader-col__wr.{mod} has no CSS rule — the headline "
            "win rate can't be colour-coded"
        )


def test_open_pair_drawer_actually_uses_the_subset_option(js):
    """openPairDrawer(pair, {subset}) is called by three entry points that
    promise "opens the drawer already scoped to that combination" (the
    Per-Pair Stats table's per-subset cells, the Subset Pair List's
    "History" button, and the inline detail row's app-pair cards) —
    opts.subset must actually be read and applied as the drawer's active
    agreement TAB, not silently accepted and dropped."""
    fn = js.split("async function openPairDrawer(pair, opts = {}) {")[1]
    fn = fn.split("\nfunction closePairDrawer")[0]
    assert "opts.subset" in fn, "openPairDrawer() never reads opts.subset"
    assert "clusterHistory" in fn, (
        "openPairDrawer() must scope data.clusterHistory via the requested "
        "subset tab, not just note that a subset was requested"
    )
    assert "drawerTab" in fn, (
        "opts.subset must preselect the drawer's agreement tab"
    )


def test_drawer_agreement_tabs_cover_the_user_asked_combinations(js):
    """The pair drawer must expose one tab per agreement type the user asked
    for: 2-agree, 3-agree, app1+app2, app1+app3, app2+app3 (plus "all").
    Each pairwise tab maps 1:1 onto the backend's app_subset_key."""
    block = js.split("const DRAWER_TABS = [")[1].split("];", 1)[0]
    keys = re.findall(r'key: "([a-z0-9+-]+)"', block)
    assert keys == ["all", "3-agree", "2-agree", "app1+app2", "app1+app3", "app2+app3"]


def test_signals_history_panel_tabs_match_drawer_tabs(html):
    """The Signals tab's Live Signal History panel exposes the same
    agreement-type filter tabs (plus All) as the pair drawer."""
    tabs = re.findall(r'data-shfilter="([a-z0-9+-]+)"', html)
    assert tabs == ["all", "3-agree", "2-agree", "app1+app2", "app1+app3", "app2+app3"]


def test_history_list_and_drawer_row_keys_are_namespaced(js):
    """state.expandedHistoryRows is a single Set shared by the Signal
    History level lists (rowKey()) and the per-pair drawer's own history
    table (renderSimpleHistoryRows()) — both used to build the exact same
    `${pair}|${ts}` key, so expanding a candle in one view could render the
    SAME candle pre-expanded in the other view the user never opened there.
    The two key-builders must use distinct prefixes."""
    row_key_fn = js.split("function rowKey(c) {", 1)[1].split("\n", 1)[0]
    drawer_key_line = js.split("function renderSimpleHistoryRows(", 1)[1]
    drawer_key_line = drawer_key_line.split("const key = `", 1)[1].split("`;", 1)[0]
    assert "list:" in row_key_fn or "drawer:" not in row_key_fn, (
        "rowKey() and the drawer's history-row key must not collide"
    )
    assert row_key_fn.strip() != f"return `{drawer_key_line}`;".strip()
    assert "list:" in row_key_fn
    assert "drawer:" in drawer_key_line


# ---------------------------------------------------------------------------
# Pair switcher / hash router / App Map (link-up) — regression locks
# ---------------------------------------------------------------------------


def test_folder_cards_are_real_links_with_hash_hrefs(html):
    """Every History/Settings folder card must be an <a> whose href matches
    its data-folder, so cards navigate through the hash router and can be
    long-pressed → "open in new window" on mobile."""
    for grid_id, prefix in (("history-folder-grid", "/history"),
                            ("settings-folder-grid", "/settings")):
        grid = html.split(f'id="{grid_id}"')[1].split('class="folder-detail"')[0]
        cards = re.findall(r'<a class="folder-card[^"]*" href="#([^"]*)" data-folder="([a-z]+)"', grid)
        assert cards, f"{grid_id} has no anchor folder cards — did the markup regress to <button>?"
        for href, folder in cards:
            assert href == f"{prefix}/{folder}", f"{grid_id}: {folder} card links to {href}"


def test_pair_switcher_strip_exists(html):
    """The Signals tab must have the per-pair switcher strip: the visible
    "switch through every pair" control."""
    assert 'id="sp-pair-strip"' in html
    assert 'id="sp-pairstrip-meta"' in html
    assert 'data-i18n="panel_pair_switcher"' in html


def test_drawer_has_pair_switcher_bar(html):
    """The pair drawer must let the user flip through pairs without
    closing: prev/next buttons, a pair dropdown, and a ↗ new-window link."""
    block = html.split('id="drawer-switcher"')[1].split("</div>", 1)[0]
    for el in ("drawer-prev", "drawer-next", "drawer-pairselect", "drawer-newwin"):
        assert el in block, f"drawer switcher is missing {el}"
    assert 'target="_blank"' in html.split('id="drawer-newwin"')[1][:200], (
        "drawer ↗ must open in a NEW window"
    )


def test_js_router_covers_all_deep_links(js):
    """The hash router must understand every route family it emits:
    plain tabs, signals history filter, pair drawer (+subset), the whole
    History tree, and the Settings tree."""
    for marker in (
        "function applyRoute()",
        "function applyHistoryRoute(parts)",
        "function applySettingsRoute(parts)",
        "function nav(hash)",
        'addEventListener("hashchange", applyRoute)',
        '"signals" && parts[1] === "pair"',
        '"signals" && parts[1] === "history"',
        'if (head === "history")',
        'if (head === "settings")',
    ):
        assert marker in js, f"router is missing: {marker}"
    # The boot sequence must apply the initial route so deep links land on
    # the right view even in a freshly opened window.
    boot = js.rsplit("startPolling();", 1)[1]
    assert "applyRoute();" in boot


def test_map_tab_is_the_fifth_nav_destination(html, js):
    """Nav rails carry 5 destinations (home/signals/history/settings/map)
    and the Map section exists — the link-up hub."""
    assert len(re.findall(r'data-tab="([a-z]+)"', html)) >= 10  # 5 per rail × 2 rails
    assert html.count('data-tab="map"') == 2
    assert 'id="tab-map"' in html
    assert 'id="map-content"' in html
    assert "function renderAppMap()" in js
    assert "function renderMapPairs()" in js
    # Map rows carry an explicit ↗ sibling that opens a NEW window.
    map_fn = js.split("function _mapRow(", 1)[1].split("function _mapGroup(", 1)[0]
    assert 'target="_blank"' in map_fn


def test_map_links_cover_screens_folders_apis_and_files(js):
    """The App Map must link up every section: the 4 screens + map, every
    History sub-view, every Settings panel, the API endpoints and the
    project files."""
    block = js.split("function renderAppMap()", 1)[1].split("function renderMapPairs()", 1)[0]
    for href in (
        "#/home", "#/signals", "#/history", "#/settings", "#/map",
        "#/history/consensus", "#/history/consensus/3-agree",
        "#/history/subset/app1+app2", "#/history/subset/app1+app3", "#/history/subset/app2+app3",
        "#/history/overall", "#/history/overall/app1+app2+app3",
        "#/history/backtest", "#/history/perpair", "#/history/apppair", "#/history/drilldown",
    ):
        assert href in block, f"App Map is missing a link to {href}"
    # Settings panels are built from SETTINGS_SUBS via a template literal.
    assert "SETTINGS_SUBS.map" in block and "#/settings/${sub}" in block, (
        "App Map must link every settings panel via SETTINGS_SUBS"
    )
    for api in ("/api/snapshot", "/api/pairs", "/api/live-winrate", "/api/diag", "/api/sources"):
        assert api in block, f"App Map is missing the {api} endpoint link"
    for path in ("main.py", "app/api/routes.py", "app/static/dashboard.js", "app/templates/dashboard.html"):
        assert path in block, f"App Map is missing project file {path}"
    # GitHub base is a module-level constant next to the map renderer.
    assert 'const MAP_GITHUB_BASE = "https://github.com/psfaruk/Master-Ai/blob/main/"' in js
    assert "MAP_GITHUB_BASE + path" in block


def test_pair_chips_are_anchors_to_pair_routes(js):
    """Strip chips and map pair chips must be real <a> links to
    #/signals/pair/<pair> (router-openable, new-window-able)."""
    strip_fn = js.split("function renderPairStrip()", 1)[1].split("function _rerenderDrawerBody", 1)[0]
    strip_fn = js.split("function renderPairStrip()", 1)[1].split("// ====== Live Win Rate panel", 1)[0]
    assert 'href="#/signals/pair/' in strip_fn
    assert "encodeURIComponent(p.pair)" in strip_fn
    assert "is-active" in strip_fn  # current drawer pair is highlighted
    map_pairs = js.split("function renderMapPairs()", 1)[1].split("\n}\n", 1)[0]
    assert 'href="#/signals/pair/' in map_pairs


def test_drawer_close_navigates_back_via_router(js):
    """Closing the drawer (✕ / overlay tap / Escape) must route back to the
    view it was opened over, and the router closes it silently when the
    route itself changed."""
    close_fn = js.split("function closePairDrawer(", 1)[1].split("\n}", 1)[0]
    assert "opts.silent" in close_fn or ".silent" in close_fn
    assert "nav(" in close_fn
    for caller in ("drawerClose.addEventListener", "requestCloseDrawer()"):
        assert caller in js
    assert 'if (e.target === drawerOverlay) requestCloseDrawer();' in js


def test_new_ui_classes_have_css_rules(css):
    """Every class introduced by the pair switcher / drawer switcher /
    App Map must have a stylesheet rule."""
    for cls in (
        "sp-pairstrip-section", "sp-pair-strip", "sp-pair-chip",
        "sp-pair-chip__dot", "sp-pair-chip__name", "sp-pair-chip__dir",
        "sp-pair-chip__agree", "sp-pair-chip__dot--otc", "sp-pair-chip__dot--real",
        "drawer__switcher", "drawer__navbtn", "drawer__pairselect", "drawer__newwin",
        "map-group", "map-group__title", "map-row", "map-link", "map-link__icon",
        "map-link__body", "map-link__title", "map-link__desc", "map-newwin",
        "map-chips", "map-chip", "map-chip__link", "map-newwin--chip",
        "folder-card__win",
    ):
        assert re.search(rf"\.{re.escape(cls)}\b", css), f".{cls} is used but has no CSS"


def test_i18n_covers_map_and_switcher_keys(js):
    """The new UI copy must exist in BOTH languages."""
    tables = _i18n_tables(js)
    for key in (
        "nav_map", "panel_pair_switcher", "map_title", "map_subtitle",
        "map_open_new_hint", "map_group_screens", "map_group_signals",
        "map_group_history", "map_group_settings", "map_group_pairs",
        "map_group_api", "map_group_files", "map_open_pair",
    ):
        assert key in tables["en"], f"missing en key {key}"
        assert key in tables["bn"], f"missing bn key {key}"
