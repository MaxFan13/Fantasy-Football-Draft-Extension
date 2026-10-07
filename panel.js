/* Sleeper Draft Assistant — side panel logic
 *
 * Data flow:
 *   1. User loads the FantasyPros consensus-cheatsheet CSV -> parsed & stored in chrome.storage.local
 *   2. User connects to a Sleeper draft (auto-detected from the active tab URL, or pasted manually)
 *   3. We poll api.sleeper.app for picks every few seconds and cross drafted players off the board
 */

const POLL_MS = 3000;

// ---------- sport configuration ----------
//
// Everything sport-specific lives here: FantasyPros URLs, how raw position
// strings collapse into the buckets we show, and which tabs / grid cells exist.
// FantasyPros NBA ranks players as G / F / C, which often disagrees with the
// PG / SG / SF / PF / C eligibility Sleeper actually enforces in the draft
// room. With `useSleeperPositions` set, every ranked player's position and
// eligibility are overwritten from Sleeper's own player database, and FP's
// bucket is only a fallback for players Sleeper doesn't know about.
const SPORTS = {
  nfl: {
    label: "NFL",
    fpBase: "https://www.fantasypros.com/nfl/rankings/",
    fpUrls: {
      half: "half-point-ppr-cheatsheets.php",
      ppr: "ppr-cheatsheets.php",
      std: "consensus-cheatsheets.php",
    },
    scoringLabels: { half: "Half PPR", ppr: "PPR", std: "Standard" },
    tabs: [
      ["ALL", "All"], ["QB", "QB"], ["RB", "RB"], ["WR", "WR"],
      ["TE", "TE"], ["FLEX", "FLX"], ["K", "K"], ["DST", "DST"],
    ],
    groups: { FLEX: new Set(["RB", "WR", "TE"]) },
    bestGrid: ["QB", "RB", "WR", "TE", "K", "DST"],
    normalizePos(pos) {
      const p = (pos || "").toUpperCase().replace(/[0-9]/g, "").trim();
      if (p === "DEF" || p === "D/ST" || p === "DS") return "DST";
      if (p === "PK") return "K";
      return p;
    },
  },
  nba: {
    label: "NBA",
    fpBase: "https://www.fantasypros.com/nba/rankings/",
    fpUrls: {
      roto: "overall.php",
      espn: "overall-points-espn.php",
      yahoo: "overall-points-yahoo.php",
      cbs: "overall-points-cbs.php",
    },
    scoringLabels: {
      roto: "Roto / Categories",
      espn: "Points (ESPN)",
      yahoo: "Points (Yahoo)",
      cbs: "Points (CBS)",
    },
    tabs: [
      ["ALL", "All"], ["PG", "PG"], ["SG", "SG"], ["SF", "SF"], ["PF", "PF"], ["C", "C"],
    ],
    groups: {},
    // UTIL = best available at any position
    bestGrid: ["PG", "SG", "SF", "PF", "C", "UTIL"],
    useSleeperPositions: true,
    normalizePos(pos) {
      // "PG,SG" / "PF" / "G1" -> first listed position, digits stripped
      return (pos || "").toUpperCase().replace(/[0-9]/g, "").split(/[,/\s]+/)[0] || "";
    },
  },
};

let sport = "nfl";
function cfg() {
  return SPORTS[sport];
}

let players = [];           // [{rank, tier, name, team, pos, positions, sleeperId, posRank, bye, key, nameKey}]
let draftedIds = new Set();  // Sleeper player_ids of drafted players (exact, when rankings carry sleeperId)
let draftedKeys = new Set(); // normalized keys of drafted players (from REST polling)
let draftedNameKeys = new Set();
let wsDraftedKeys = new Set();     // instant picks seen on the draft room's live
let wsDraftedNameKeys = new Set(); // WebSocket feed, ahead of the REST API
let wsDraftedIds = new Set();
let draftId = null;
let pollTimer = null;
let activePos = "ALL";
let searchTerm = "";
let hideDrafted = true;

// ---------- name normalization / matching ----------

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

// Letters that don't decompose into base + accent under NFD, so the
// combining-mark strip below would otherwise leave them intact.
const SPECIAL_LETTERS = { đ: "d", ð: "d", ø: "o", ł: "l", ß: "ss", æ: "ae", œ: "oe", þ: "th" };

// Sleeper spells names with diacritics ("Nikola Jokić", "Luka Dončić",
// "Alperen Şengün") while FantasyPros uses plain ASCII ("Jokic", "Sengun").
// Fold both to the same accent-free form before comparing.
function stripDiacritics(s) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[đðøłßæœþ]/g, (c) => SPECIAL_LETTERS[c] || c);
}

function normalizeName(name) {
  const words = stripDiacritics(String(name).toLowerCase())
    .replace(/[.,'’\-]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !SUFFIXES.has(w));
  return words.join("");
}

function normalizePos(pos) {
  return cfg().normalizePos(pos);
}

function playerKey(name, pos) {
  return normalizeName(name) + "|" + normalizePos(pos);
}

// ---------- CSV parsing ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((f) => f.trim() !== "")) rows.push(row);
  }
  return rows;
}

function findColumn(headers, patterns) {
  for (const pat of patterns) {
    const idx = headers.findIndex((h) => pat.test(h));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseRankingsCsv(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("File looks empty.");

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const col = {
    rank: findColumn(headers, [/^(rk|rank|ecr)$/, /rank/]),
    tier: findColumn(headers, [/tier/]),
    name: findColumn(headers, [/player/, /^name$/]),
    team: findColumn(headers, [/^team$/, /team/]),
    pos: findColumn(headers, [/^pos$/, /position/]),
    bye: findColumn(headers, [/bye/]),
  };
  if (col.name === -1 || col.pos === -1) {
    throw new Error(
      "Couldn't find PLAYER/POS columns. Make sure this is the FantasyPros rankings CSV."
    );
  }

  const parsed = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[col.name] || "").trim();
    const rawPos = (r[col.pos] || "").trim();
    if (!name || !rawPos) continue;
    const pos = normalizePos(rawPos);
    const posRankMatch = rawPos.match(/\d+/);
    parsed.push({
      rank: col.rank !== -1 ? parseInt(r[col.rank], 10) || parsed.length + 1 : parsed.length + 1,
      tier: col.tier !== -1 ? parseInt(r[col.tier], 10) || null : null,
      name,
      team: col.team !== -1 ? (r[col.team] || "").trim() : "",
      pos,
      posRank: posRankMatch ? parseInt(posRankMatch[0], 10) : null,
      bye: col.bye !== -1 ? (r[col.bye] || "").trim() : "",
      eligible: rawPos.includes(",") ? rawPos.replace(/\s+/g, "") : "",
      key: playerKey(name, pos),
      nameKey: normalizeName(name),
    });
  }
  if (!parsed.length) throw new Error("No player rows found in the file.");
  parsed.sort((a, b) => a.rank - b.rank);
  return parsed;
}

// ---------- FantasyPros direct fetch ----------

// Extract the JSON object assigned to `ecrData` in the page source.
// Brace-counts (string-aware) instead of regex so embedded braces don't break it.
function extractEcrJson(html) {
  const marker = html.indexOf("ecrData");
  if (marker === -1) throw new Error("Rankings data not found in page.");
  const start = html.indexOf("{", marker);
  let depth = 0;
  let inString = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, i + 1));
    }
  }
  throw new Error("Rankings data was malformed.");
}

async function fetchFromFantasyPros(scoring) {
  const c = cfg();
  const res = await fetch(c.fpBase + c.fpUrls[scoring], { credentials: "omit" });
  if (!res.ok) throw new Error(`FantasyPros returned ${res.status}`);
  const html = await res.text();
  const data = extractEcrJson(html);
  const raw = data.players || [];
  if (!raw.length) throw new Error("No players in FantasyPros data.");

  const parsed = raw.map((p) => {
    const pos = normalizePos(p.player_position_id);
    const posRankMatch = String(p.pos_rank || "").match(/\d+/);
    // NBA rows carry finer eligibility ("PG,SG") than the G/F/C bucket
    const eligible = String(p.player_positions || "");
    return {
      rank: parseInt(p.rank_ecr, 10),
      tier: p.tier || null,
      name: p.player_name,
      team: p.player_team_id || "",
      pos,
      posRank: posRankMatch ? parseInt(posRankMatch[0], 10) : null,
      bye: p.player_bye_week || "",
      eligible: eligible.includes(",") ? eligible : "",
      key: playerKey(p.player_name, pos),
      nameKey: normalizeName(p.player_name),
    };
  });
  parsed.sort((a, b) => a.rank - b.rank);
  return {
    parsed,
    meta: `${c.label} · ${c.scoringLabels[scoring]} · updated ${data.last_updated || "today"}`,
  };
}

// ---------- Sleeper player database (positions + ids) ----------

const SLEEPER_PLAYERS_TTL_MS = 24 * 60 * 60 * 1000; // Sleeper asks for at most one pull a day

// Returns Map<nameKey, {id, pos, positions, team}> for the current sport,
// cached in storage for a day. Only the compact name->positions map is kept,
// not the multi-MB raw dump.
async function loadSleeperPlayers() {
  const storageKey = `sleeperPlayers_${sport}`;
  const stored = await chrome.storage.local.get([storageKey]);
  const cached = stored[storageKey];
  if (cached && Date.now() - cached.ts < SLEEPER_PLAYERS_TTL_MS) {
    return new Map(Object.entries(cached.map));
  }

  const res = await fetch(`https://api.sleeper.app/v1/players/${sport}`);
  if (!res.ok) throw new Error(`Sleeper players API error (${res.status})`);
  const raw = await res.json();

  const map = {};
  for (const [id, p] of Object.entries(raw)) {
    if (!p || !p.first_name || !p.last_name || !p.position || p.position === "DEF") continue;
    const nameKey = normalizeName(`${p.first_name} ${p.last_name}`);
    const entry = {
      id,
      pos: p.position,
      positions: Array.isArray(p.fantasy_positions) && p.fantasy_positions.length
        ? p.fantasy_positions.slice()
        : [p.position],
      team: p.team || "",
    };
    // Two Sleeper players can share a name; prefer the one on an active roster
    const prev = map[nameKey];
    if (!prev || (!prev.team && entry.team)) map[nameKey] = entry;
  }
  await chrome.storage.local.set({ [storageKey]: { ts: Date.now(), map } });
  return new Map(Object.entries(map));
}

// Overwrite FantasyPros positions with Sleeper's. Players Sleeper doesn't know
// keep FP's bucket and show up only under All.
function applySleeperPositions(parsed, sleeperMap) {
  let matched = 0;
  for (const p of parsed) {
    const sp = sleeperMap.get(p.nameKey);
    if (!sp) {
      p.positions = [p.pos];
      continue;
    }
    matched++;
    p.pos = sp.pos;
    p.positions = sp.positions;
    p.sleeperId = sp.id;
    p.posRank = null; // FP's G2 / F7 no longer means anything
    p.eligible = "";
    p.key = playerKey(p.name, p.pos);
  }
  return matched;
}

// Fetch rankings for the current sport and, where configured, re-key them to
// Sleeper's positions in the same step so the board never shows FP's buckets.
async function loadRankings(scoring) {
  const result = await fetchFromFantasyPros(scoring);
  if (cfg().useSleeperPositions) {
    const sleeperMap = await loadSleeperPlayers();
    const matched = applySleeperPositions(result.parsed, sleeperMap);
    result.meta += ` · Sleeper positions (${matched}/${result.parsed.length})`;
  }
  return result;
}

// ---------- Sleeper draft polling ----------

function extractDraftId(str) {
  if (!str) return null;
  const urlMatch = str.match(/draft\/[a-z]+\/(\d{6,})/i);
  if (urlMatch) return urlMatch[1];
  const idMatch = str.trim().match(/^(\d{6,})$/);
  return idMatch ? idMatch[1] : null;
}

// Sleeper draft URLs are /draft/<sport>/<id>; use that to flag a sport mismatch
// with the loaded rankings (e.g. NBA draft open, NFL board loaded).
function extractDraftSport(str) {
  const m = (str || "").match(/draft\/([a-z]+)\/\d{6,}/i);
  const s = m ? m[1].toLowerCase() : null;
  return s && SPORTS[s] ? s : null;
}

async function fetchPicks() {
  // no-store + cache-buster: Sleeper's CDN caches API responses for a few
  // seconds, which is exactly the staleness we're trying to avoid mid-draft
  const res = await fetch(
    `https://api.sleeper.app/v1/draft/${draftId}/picks?t=${Date.now()}`,
    { cache: "no-store" }
  );
  if (!res.ok) throw new Error(`Sleeper API error (${res.status})`);
  const picks = await res.json();

  const keys = new Set();
  const nameKeys = new Set();
  const ids = new Set();
  for (const pick of picks || []) {
    if (pick.player_id) ids.add(String(pick.player_id));
    const m = pick.metadata || {};
    const name = `${m.first_name || ""} ${m.last_name || ""}`.trim();
    if (!name) continue;
    keys.add(playerKey(name, m.position));
    nameKeys.add(normalizeName(name));
  }
  return { keys, nameKeys, ids, count: (picks || []).length };
}

// ---------- live WebSocket feed (relayed from the Sleeper draft tab) ----------

// Tolerant extraction: deep-walk the frame's JSON for anything shaped like a
// picked player, so minor changes to Sleeper's message format don't break us.
function extractPicksFromWs(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  const found = [];
  (function walk(node, depth) {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (
      typeof node.first_name === "string" &&
      typeof node.last_name === "string" &&
      node.position
    ) {
      found.push(node);
      return;
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  })(data, 0);
  return found;
}

let reconcileTimer = null;

function handleWsFrame(text) {
  const picks = extractPicksFromWs(text);
  let changed = false;
  for (const m of picks) {
    const name = `${m.first_name} ${m.last_name}`.trim();
    const key = playerKey(name, m.position);
    if (!wsDraftedKeys.has(key)) {
      wsDraftedKeys.add(key);
      wsDraftedNameKeys.add(normalizeName(name));
      if (m.player_id) wsDraftedIds.add(String(m.player_id));
      changed = true;
    }
  }
  if (changed) {
    render();
    // Reconcile against the REST API shortly after, once its cache catches up
    if (draftId) {
      clearTimeout(reconcileTimer);
      reconcileTimer = setTimeout(pollOnce, 2000);
    }
  }
}

if (chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "sleeper-ws") handleWsFrame(msg.data);
  });
}

function setStatus(state, text) {
  const dot = document.getElementById("statusDot");
  dot.className = "dot " + state;
  document.getElementById("statusText").textContent = text;
}

async function pollOnce() {
  try {
    const { keys, nameKeys, ids, count } = await fetchPicks();
    draftedKeys = keys;
    draftedNameKeys = nameKeys;
    draftedIds = ids;
    setStatus("on", `Connected · ${count} pick${count === 1 ? "" : "s"} made`);
    render();
  } catch (err) {
    setStatus("err", `Draft sync failed: ${err.message}`);
  }
}

function startPolling(id) {
  if (id !== draftId) {
    wsDraftedKeys = new Set();
    wsDraftedNameKeys = new Set();
    wsDraftedIds = new Set();
  }
  draftId = id;
  if (pollTimer) clearInterval(pollTimer);
  setStatus("on", "Connecting…");
  pollOnce();
  pollTimer = setInterval(pollOnce, POLL_MS);
  chrome.storage.local.set({ draftId: id });
}

function stopPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  draftId = null;
  draftedKeys = new Set();
  draftedNameKeys = new Set();
  draftedIds = new Set();
  wsDraftedKeys = new Set();
  wsDraftedNameKeys = new Set();
  wsDraftedIds = new Set();
  setStatus("off", "Not connected to a draft");
  chrome.storage.local.remove("draftId");
  render();
}

async function connectFromActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const id = extractDraftId(tab && tab.url);
    if (id) {
      startPolling(id);
      const draftSport = extractDraftSport(tab.url);
      if (draftSport && draftSport !== sport && players.length) {
        showRankingsInfo(
          `This is an ${SPORTS[draftSport].label} draft but ${cfg().label} rankings are loaded — switch sport and re-fetch.`,
          true
        );
        document.getElementById("settingsPanel").classList.remove("hidden");
      }
      return true;
    }
  } catch (e) {
    /* tabs permission issue — fall through to manual entry */
  }
  return false;
}

// ---------- rendering ----------

function positionsOf(p) {
  return p.positions && p.positions.length ? p.positions : [p.pos];
}

function isDrafted(p) {
  return (
    (p.sleeperId && (draftedIds.has(p.sleeperId) || wsDraftedIds.has(p.sleeperId))) ||
    draftedKeys.has(p.key) ||
    draftedNameKeys.has(p.nameKey) ||
    wsDraftedKeys.has(p.key) ||
    wsDraftedNameKeys.has(p.nameKey)
  );
}

function matchesTab(p) {
  if (activePos === "ALL") return true;
  const group = cfg().groups[activePos];
  if (group) return group.has(p.pos);
  return positionsOf(p).includes(activePos);
}

function playerMeta(p) {
  const bits = [p.team];
  const eligible = positionsOf(p);
  if (eligible.length > 1) bits.push(eligible.join("/"));
  else if (p.eligible) bits.push(p.eligible);
  if (p.bye) bits.push("Bye " + p.bye);
  return bits.filter(Boolean).join(" · ");
}

function render() {
  renderBestGrid();
  renderList();
}

function renderBestGrid() {
  const grid = document.getElementById("bestGrid");
  if (!players.length) {
    grid.classList.add("hidden");
    return;
  }
  grid.classList.remove("hidden");
  grid.innerHTML = "";
  for (const pos of cfg().bestGrid) {
    const best = players.find(
      (p) => (pos === "UTIL" || positionsOf(p).includes(pos)) && !isDrafted(p)
    );
    const cell = document.createElement("div");
    cell.className = "best-cell";
    cell.title = "Show " + pos + " rankings";
    const meta = best ? `#${best.rank} · ${playerMeta(best)}` : "—";
    cell.innerHTML = `
      <div class="pos">${pos}</div>
      <div class="name">${best ? escapeHtml(best.name) : "None left"}</div>
      <div class="meta">${escapeHtml(meta)}</div>`;
    cell.addEventListener("click", () => setActiveTab(pos));
    grid.appendChild(cell);
  }
}

function renderList() {
  const list = document.getElementById("playerList");
  const empty = document.getElementById("emptyState");

  if (!players.length) {
    empty.classList.remove("hidden");
    list.querySelectorAll(".player-row, .tier-header").forEach((el) => el.remove());
    return;
  }
  empty.classList.add("hidden");

  const term = searchTerm.toLowerCase();
  const visible = players.filter((p) => {
    if (!matchesTab(p)) return false;
    if (term && !p.name.toLowerCase().includes(term) && !p.team.toLowerCase().includes(term))
      return false;
    if (hideDrafted && isDrafted(p)) return false;
    return true;
  });

  const frag = document.createDocumentFragment();
  let lastTier = null;
  const showTiers = activePos !== "ALL" || !term;

  for (const p of visible.slice(0, 300)) {
    if (showTiers && p.tier && p.tier !== lastTier) {
      lastTier = p.tier;
      const th = document.createElement("div");
      th.className = "tier-header";
      th.textContent = "Tier " + p.tier;
      frag.appendChild(th);
    }
    const drafted = isDrafted(p);
    const row = document.createElement("div");
    row.className = "player-row" + (drafted ? " drafted" : "") + (p.tier ? " t" + Math.min(p.tier, 6) : "");
    row.innerHTML = `
      <div class="p-rank">${p.rank}</div>
      <div class="p-main">
        <div class="p-name">${escapeHtml(p.name)}</div>
        <div class="p-meta">${escapeHtml(playerMeta(p))}</div>
      </div>
      <div class="p-pos">${p.pos}${p.posRank || ""}</div>`;
    frag.appendChild(row);
  }

  list.querySelectorAll(".player-row, .tier-header").forEach((el) => el.remove());
  list.appendChild(frag);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

function setActiveTab(pos) {
  activePos = pos;
  document.querySelectorAll("#posTabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.pos === pos);
  });
  renderList();
}

// ---------- storage / setup ----------

function showRankingsInfo(text, isError = false) {
  const el = document.getElementById("rankingsInfo");
  el.textContent = text;
  el.className = "rankings-info" + (isError ? " error" : "");
}

// Rebuild the sport-dependent bits of the settings panel and tab bar.
function applySportUi() {
  const c = cfg();
  const scoringSel = document.getElementById("scoringSelect");
  const prev = scoringSel.value;
  scoringSel.innerHTML = "";
  for (const [value, label] of Object.entries(c.scoringLabels)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    scoringSel.appendChild(opt);
  }
  if (c.scoringLabels[prev]) scoringSel.value = prev;

  const link = document.getElementById("fpLink");
  link.href = c.fpBase + Object.values(c.fpUrls)[0];
  link.textContent = `FantasyPros ${c.label} consensus rankings`;
  document.getElementById("draftInput").placeholder =
    `https://sleeper.com/draft/${sport}/… or draft ID`;

  const tabs = document.getElementById("posTabs");
  tabs.innerHTML = "";
  for (const [pos, label] of c.tabs) {
    const btn = document.createElement("button");
    btn.dataset.pos = pos;
    btn.textContent = label;
    btn.addEventListener("click", () => setActiveTab(pos));
    tabs.appendChild(btn);
  }
  if (!c.tabs.some(([pos]) => pos === activePos)) activePos = "ALL";
  setActiveTab(activePos);
}

function applyRankings(parsed, meta) {
  players = parsed;
  document.getElementById("posTabs").classList.remove("hidden");
  document.getElementById("listControls").classList.remove("hidden");
  document.getElementById("clearRankings").classList.remove("hidden");
  showRankingsInfo(`${parsed.length} players loaded${meta ? " · " + meta : ""}`);
  render();
}

async function init() {
  const stored = await chrome.storage.local.get([
    "rankings", "rankingsMeta", "draftId", "scoring", "sport",
  ]);

  if (stored.sport && SPORTS[stored.sport]) sport = stored.sport;
  document.getElementById("sportSelect").value = sport;
  applySportUi();
  if (stored.scoring && cfg().scoringLabels[stored.scoring]) {
    document.getElementById("scoringSelect").value = stored.scoring;
  }
  if (stored.rankings && stored.rankings.length) {
    applyRankings(stored.rankings, stored.rankingsMeta);
  } else {
    document.getElementById("settingsPanel").classList.remove("hidden");
  }

  // Try to reconnect: active tab first, then last-used draft id
  const fromTab = await connectFromActiveTab();
  if (!fromTab && stored.draftId) startPolling(stored.draftId);

  // --- event wiring ---

  document.getElementById("settingsBtn").addEventListener("click", () => {
    document.getElementById("settingsPanel").classList.toggle("hidden");
  });

  document.getElementById("sportSelect").addEventListener("change", async (e) => {
    sport = e.target.value;
    applySportUi();
    // Rankings on disk belong to the previous sport — drop them so the board
    // can't silently show NFL players during an NBA draft.
    await chrome.storage.local.set({ sport });
    await chrome.storage.local.remove(["rankings", "rankingsMeta"]);
    players = [];
    document.getElementById("clearRankings").classList.add("hidden");
    showRankingsInfo(`Switched to ${cfg().label} — fetch rankings to load the board.`);
    render();
  });

  document.getElementById("fetchRankings").addEventListener("click", async () => {
    const scoring = document.getElementById("scoringSelect").value;
    showRankingsInfo("Fetching rankings…");
    try {
      const { parsed, meta } = await loadRankings(scoring);
      await chrome.storage.local.set({ rankings: parsed, rankingsMeta: meta, scoring, sport });
      applyRankings(parsed, meta);
    } catch (err) {
      showRankingsInfo("Fetch failed: " + err.message + " — try the CSV upload below.", true);
    }
  });

  document.getElementById("csvFile").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseRankingsCsv(text);
      let meta = `${cfg().label} · CSV ${new Date().toLocaleDateString()}`;
      if (cfg().useSleeperPositions) {
        const matched = applySleeperPositions(parsed, await loadSleeperPlayers());
        meta += ` · Sleeper positions (${matched}/${parsed.length})`;
      }
      await chrome.storage.local.set({ rankings: parsed, rankingsMeta: meta, sport });
      applyRankings(parsed, meta);
    } catch (err) {
      showRankingsInfo(err.message, true);
    }
  });

  document.getElementById("clearRankings").addEventListener("click", async () => {
    await chrome.storage.local.remove(["rankings", "rankingsMeta"]);
    players = [];
    document.getElementById("posTabs").classList.add("hidden");
    document.getElementById("listControls").classList.add("hidden");
    document.getElementById("bestGrid").classList.add("hidden");
    document.getElementById("clearRankings").classList.add("hidden");
    showRankingsInfo("");
    render();
  });

  document.getElementById("connectBtn").addEventListener("click", async () => {
    if (pollTimer) {
      stopPolling();
      return;
    }
    const ok = await connectFromActiveTab();
    if (!ok) {
      document.getElementById("settingsPanel").classList.remove("hidden");
      setStatus("err", "No Sleeper draft tab found — paste the draft URL below");
    }
  });

  document.getElementById("draftInputBtn").addEventListener("click", () => {
    const id = extractDraftId(document.getElementById("draftInput").value);
    if (id) {
      startPolling(id);
      document.getElementById("settingsPanel").classList.add("hidden");
    } else {
      setStatus("err", "Couldn't find a draft ID in that text");
    }
  });

  document.getElementById("searchBox").addEventListener("input", (e) => {
    searchTerm = e.target.value;
    renderList();
  });

  document.getElementById("hideDrafted").addEventListener("change", (e) => {
    hideDrafted = e.target.checked;
    renderList();
  });

  // Update the Connect button label to reflect state
  const connectBtn = document.getElementById("connectBtn");
  const observer = new MutationObserver(() => {
    connectBtn.textContent = pollTimer ? "Disconnect" : "Connect";
  });
  observer.observe(document.getElementById("statusText"), { childList: true });
}

init();
