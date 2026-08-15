// Master-Ai dashboard client — polls the JSON API and renders live data
// into the server-rendered HTML shell.

const POLL_INTERVAL = 5000;  // 5s — the snapshot poller is already adaptive on the server
const BACKTEST_CACHE_TTL = 60_000;

const $ = (id) => document.getElementById(id);

let activeTab = "home";
let lastSnapshot = null;
let lastSnapshotAt = 0;
let cachedBacktest = null;

// ====== Tab switching ======
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

function switchTab(name) {
  activeTab = name;
  document.querySelectorAll(".tab").forEach((b) => b.classList.toggle("tab--active", b.dataset.tab === name));
  document.querySelectorAll(".tab-panel").forEach((p) => p.classList.toggle("tab-panel--active", p.id === `tab-${name}`));
  if (name === "chart") renderPairTable();
  if (name === "history") populateHistoryPairSelector();
}

// ====== Polling loop ======
async function pollSnapshot() {
  try {
    const res = await fetch("/api/snapshot", { cache: "no-store" });
    if (res.status === 503) {
      setStatus("stale", "first poll running…");
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    lastSnapshot = data;
    lastSnapshotAt = Date.now();
    setStatus("ok", `updated ${Math.round(data.ageMs / 1000)}s ago`);
    render();
  } catch (e) {
    setStatus("down", `error: ${e.message}`);
  }
}

function setStatus(kind, text) {
  const pill = $("status-pill");
  pill.classList.remove("is-down", "is-stale");
  if (kind === "down") pill.classList.add("is-down");
  else if (kind === "stale") pill.classList.add("is-stale");
  $("status-text").textContent = text;
}

// ====== Render ======
function render() {
  if (!lastSnapshot) return;
  renderAppCards(lastSnapshot.apps);
  renderSummary(lastSnapshot.summary);
  renderConsensusHighlights(lastSnapshot.pairs);
  renderPairTable();
  $("footer-clock").textContent = new Date().toLocaleTimeString();
}

function renderAppCards(apps) {
  const container = $("app-cards");
  container.innerHTML = apps.map((a) => {
    const accent = a.id === "app1" ? "amber" : a.id === "app2" ? "violet" : "emerald";
    const healthCls = a.health ? `card__health--${a.health}` : "card__health--down";
    return `
      <div class="card">
        <div class="card__header">
          <span class="card__title">${a.name}</span>
          <span class="card__accent card__accent--${accent}"></span>
        </div>
        <div class="card__metric">${a.signalCount} <span style="font-size:12px;color:var(--text-dim)">signals</span></div>
        <div class="card__detail">${a.detail || a.health || "—"}</div>
        <div style="margin-top:8px;">
          <span class="card__health ${healthCls}">${a.health || "unknown"}</span>
        </div>
      </div>`;
  }).join("");
}

function renderSummary(summary) {
  $("stat-3agree").textContent = summary.threeBotAgree.length;
  $("stat-2agree").textContent = summary.twoBotAgree.length;
  $("stat-conflict").textContent = summary.conflicts.length;
  $("stat-single").textContent = summary.singleOnly.length;
}

function renderConsensusHighlights(pairs) {
  const container = $("consensus-highlights");
  const highlights = pairs.filter((p) => ["3-agree", "2-agree"].includes(p.consensus.level)).slice(0, 8);
  if (highlights.length === 0) {
    container.innerHTML = '<p class="placeholder">No 2-bot or 3-bot agreements right now.</p>';
    return;
  }
  container.innerHTML = `<div class="highlight-list">${highlights.map((p) => {
    const dir = p.consensus.direction || "NEUTRAL";
    return `
      <div class="highlight highlight--${p.consensus.level}">
        <div>
          <div class="highlight__pair">${p.displayPair}</div>
          <div class="highlight__meta">${p.consensus.level} · ${p.consensus.agreeingApps.join(", ")}</div>
        </div>
        <span class="highlight__direction highlight__direction--${dir}">${dir}</span>
      </div>`;
  }).join("")}</div>`;
  $("home-meta").textContent = `${pairs.length} pairs · ${new Date(lastSnapshot.timestamp).toLocaleTimeString()}`;
}

function renderPairTable() {
  if (!lastSnapshot) return;
  const levelFilter = $("filter-level").value;
  const pairFilter = $("filter-pair").value.trim().toLowerCase();
  const body = $("pair-table-body");

  let pairs = lastSnapshot.pairs || [];
  if (levelFilter) pairs = pairs.filter((p) => p.consensus.level === levelFilter);
  if (pairFilter) pairs = pairs.filter((p) => p.displayPair.toLowerCase().includes(pairFilter));

  if (pairs.length === 0) {
    body.innerHTML = '<tr><td colspan="6" class="placeholder">No pairs match the filter.</td></tr>';
    return;
  }

  body.innerHTML = pairs.slice(0, 100).map((p) => {
    const dir = p.consensus.direction || "—";
    const dirCls = dir === "—" ? "NEUTRAL" : dir;
    const apps = p.latestCandle ? p.latestCandle.signals.map((s) => s.source).join(", ") : "—";
    const candleUtc = p.latestCandle ? new Date(p.latestCandle.candleTime * 1000).toLocaleTimeString("en-GB", { hour12: false }) : "—";
    return `
      <tr>
        <td><strong>${p.displayPair}</strong></td>
        <td><span class="pill pill--${p.category}">${p.category}</span></td>
        <td><span class="pill pill--${p.consensus.level}">${p.consensus.level}</span></td>
        <td><span class="dir dir--${dirCls}">${dir}</span></td>
        <td>${apps}</td>
        <td>${candleUtc}</td>
      </tr>`;
  }).join("");
}

$("filter-level").addEventListener("change", renderPairTable);
$("filter-pair").addEventListener("input", renderPairTable);

// ====== Backtest ======
$("btn-run-backtest").addEventListener("click", runBacktest);

async function runBacktest() {
  const btn = $("btn-run-backtest");
  btn.disabled = true;
  btn.textContent = "Running…";
  $("backtest-content").innerHTML = '<p class="placeholder">Fetching and grading signals across all 3 source apps…</p>';
  try {
    const res = await fetch("/api/backtest", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cachedBacktest = await res.json();
    renderBacktest(cachedBacktest);
  } catch (e) {
    $("backtest-content").innerHTML = `<p class="placeholder">Backtest failed: ${e.message}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Run backtest";
  }
}

function renderBacktest(bt) {
  const v = bt.verdict || {};
  const levelStats = Object.entries(bt.levels || {}).map(([level, s]) => {
    const total = s.win + s.loss;
    const winRate = total > 0 ? ((s.win / total) * 100).toFixed(1) : "—";
    return `
      <div class="level-stat">
        <div class="level-stat__title">${level}</div>
        <div class="level-stat__row"><span>Total</span><strong>${s.total}</strong></div>
        <div class="level-stat__row"><span>Win / Loss</span><strong>${s.win} / ${s.loss}</strong></div>
        <div class="level-stat__row loss"><span>Win rate</span><strong>${winRate}%</strong></div>
        <div class="level-stat__row"><span>Unknown</span><span>${s.unknown}</span></div>
        <div class="level-stat__row"><span>Draw</span><span>${s.draw}</span></div>
        <div class="level-stat__row"><span>CALL W/L</span><span>${s.callWin}/${s.callLoss}</span></div>
        <div class="level-stat__row"><span>PUT W/L</span><span>${s.putWin}/${s.putLoss}</span></div>
      </div>`;
  }).join("");

  const sourceStats = Object.entries(bt.sources || {}).map(([src, s]) => `
    <div class="level-stat">
      <div class="level-stat__title">${src}</div>
      <div class="level-stat__row"><span>Total</span><strong>${s.total}</strong></div>
      <div class="level-stat__row"><span>Win</span><strong>${s.win}</strong></div>
      <div class="level-stat__row loss"><span>Loss</span><strong>${s.loss}</strong></div>
      <div class="level-stat__row"><span>Unknown</span><span>${s.unknown}</span></div>
      <div class="level-stat__row"><span>Draw</span><span>${s.draw}</span></div>
    </div>`).join("");

  $("backtest-content").innerHTML = `
    <div class="verdict verdict--${v.kind}">${v.message || "—"}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:12px;">
      <h3 style="font-size:13px;">Per-level stats</h3>
      <span class="panel__meta">${bt.totalSignals} signals · ${bt.totalClusters} clusters</span>
    </div>
    <div class="level-stats">${levelStats}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:12px;">
      <h3 style="font-size:13px;">Per-source stats</h3>
    </div>
    <div class="level-stats">${sourceStats}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:12px;">
      <h3 style="font-size:13px;">Per-pair win rate</h3>
      <span class="panel__meta">${(bt.perPair || []).length} pairs</span>
    </div>
    <table class="pair-table">
      <thead>
        <tr><th>Pair</th><th>Category</th><th>3-agree W/L</th><th>2-agree W/L</th><th>1-only W/L</th></tr>
      </thead>
      <tbody>
        ${(bt.perPair || []).slice(0, 30).map((p) => {
          const fmt = (l) => `${p.levels[l].win}/${p.levels[l].loss}`;
          return `<tr>
            <td><strong>${p.displayPair}</strong></td>
            <td><span class="pill pill--${p.category}">${p.category}</span></td>
            <td>${fmt("3-agree")}</td>
            <td>${fmt("2-agree")}</td>
            <td>${fmt("1-only")}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
}

// ====== History tab — pair selector ======
function populateHistoryPairSelector() {
  if (!lastSnapshot) return;
  const sel = $("history-pair");
  const current = sel.value;
  const pairs = (lastSnapshot.pairs || []).slice(0, 50);
  sel.innerHTML = '<option value="">Select a pair…</option>' + pairs.map((p) => `<option value="${p.pair}">${p.displayPair}</option>`).join("");
  if (current && pairs.some((p) => p.pair === current)) sel.value = current;
}

$("history-pair").addEventListener("change", async (e) => {
  const pair = e.target.value;
  if (!pair) return;
  $("pair-history").innerHTML = '<p class="placeholder">Loading candles…</p>';
  try {
    const res = await fetch(`/api/candles?pair=${encodeURIComponent(pair)}&limit=60`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPairHistory(pair, data.candles);
  } catch (e) {
    $("pair-history").innerHTML = `<p class="placeholder">Failed: ${e.message}</p>`;
  }
});

function renderPairHistory(pair, candles) {
  if (!candles.length) {
    $("pair-history").innerHTML = '<p class="placeholder">No candle history for this pair.</p>';
    return;
  }
  const rows = candles.slice(0, 30).map((c) => {
    const utc = new Date(c.candleTime * 1000).toLocaleTimeString("en-GB", { hour12: false });
    const diff = (c.close - c.open).toFixed(5);
    const dir = diff > 0 ? "CALL" : diff < 0 ? "PUT" : "FLAT";
    const dirCls = dir === "CALL" ? "CALL" : dir === "PUT" ? "PUT" : "NEUTRAL";
    return `<tr>
      <td>${utc}</td>
      <td>${c.open.toFixed(5)}</td>
      <td>${c.high !== null ? c.high.toFixed(5) : "—"}</td>
      <td>${c.low !== null ? c.low.toFixed(5) : "—"}</td>
      <td>${c.close.toFixed(5)}</td>
      <td>${diff}</td>
      <td><span class="dir dir--${dirCls}">${dir}</span></td>
    </tr>`;
  }).join("");
  $("pair-history").innerHTML = `
    <table class="pair-table">
      <thead>
        <tr><th>Candle (UTC)</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Diff</th><th>Direction</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ====== Diagnostics ======
$("btn-refresh-diag").addEventListener("click", fetchDiag);

async function fetchDiag() {
  $("diag-content").innerHTML = '<p class="placeholder">Loading diagnostics…</p>';
  try {
    const res = await fetch("/api/diag?poll=1", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const diag = await res.json();
    renderDiag(diag);
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
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:12px;">
      <h3 style="font-size:13px;">Per-app status</h3>
    </div>
    <div class="level-stats">${apps}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:12px;">
      <h3 style="font-size:13px;">Candle offsets</h3>
    </div>
    <div class="level-stats">${offsets}</div>
    <div class="panel__header" style="padding-left:0;border-bottom:1px solid var(--border);margin-bottom:12px;">
      <h3 style="font-size:13px;">Notes</h3>
    </div>
    <ul style="color:var(--text-dim);font-size:13px;padding-left:20px;">
      ${(d.notes || []).map((n) => `<li style="margin-bottom:6px;">${n}</li>`).join("")}
    </ul>
  `;
}

// ====== Boot ======
pollSnapshot();
setInterval(pollSnapshot, POLL_INTERVAL);
fetchDiag();
