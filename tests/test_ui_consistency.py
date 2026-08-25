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
