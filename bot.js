/**
 * Hand Cricket Telegram Bot — single file
 *
 * SOLO : /startsolo (or /solo) -> /joinsolo -> /forcestart (or /startgame)
 *        unlimited overs, one innings, everyone bats until out, just type 1-6
 * TEAM : /team (or /startteam) -> /join_a /join_b -> /startgame
 *        -> captain buttons -> toss -> bat/bowl choice -> host /setovers (1-20)
 *        -> /bat /bowl (captains) -> type 1-6
 *
 * Cards (host banner + final stats image) need the ./assets folder next to this file
 * and the `sharp` package. If sharp/assets are missing the bot falls back to text.
 */
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('Set BOT_TOKEN and DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  max: 8,
});

const bot = new Telegraf(BOT_TOKEN);
const DEFAULT_OVERS = 5; // placeholder value stored until the host runs /setovers (team) / unused in solo
const MAX_OVERS = 20; // host can choose 1..20 overs
const DEFAULT_TEAM_SIZE = 100; // max players per team (effectively unlimited)
const MIN_TEAM_PLAYERS = 2; // striker + non-striker
const MAX_BOWLER_OVERS = 4;
const LOBBY_SECONDS = 60; // solo lobby timer
const MAX_SOLO_PLAYERS = 100; // effectively unlimited

// ── Discipline rules ──
const TURN_SECONDS = 60; // batsman / bowler must respond within this time
const TURN_PENALTY = 6; // runs lost for every missed turn
const SOLO_BOWLER_WARN_LIMIT = 3; // solo: bowling auto-changes after this many missed turns
const TEAM_BOWLER_WARN_LIMIT = 2; // team: captain is tagged to choose the next bowler after this many
const BAT_RETIRE_LIMIT = 3; // batsman is retired OUT after this many missed turns
const IDLE_WARN_SECONDS = 60; // host warning interval while the lobby / setup does not progress
const IDLE_WARN_LIMIT = 10; // game is ended after this many host warnings
const VOTE_NEEDED = 3; // change-host vote: 3 votes from Team A and 3 from Team B (solo: 3 votes)
const VOTE_EXPIRE_MS = 3 * 60 * 1000;

let BOT_USERNAME = ''; // filled at startup (used for "open bot DM" buttons)

// best-effort message delete
const del = (chat, id) => (id ? bot.telegram.deleteMessage(chat, id).catch(() => {}) : null);

// matchId -> { timer, endsAt, chatId, hostId }
const lobbies = new Map();

function clearLobby(matchId) {
  const L = lobbies.get(matchId);
  if (L?.timer) clearTimeout(L.timer);
  if (L?.tick) clearInterval(L.tick);
  lobbies.delete(matchId);
}

// ─── DB ──────────────────────────────────────────────────
async function q(sql, params = []) {
  return pool.query(sql, params);
}

async function getActiveMatch(chatId) {
  const { rows } = await q(
    `SELECT * FROM matches WHERE group_chat_id=$1 AND status NOT IN ('completed','cancelled') ORDER BY created_at DESC LIMIT 1`,
    [chatId]
  );
  return rows[0] || null;
}

async function getMatch(id) {
  const { rows } = await q(`SELECT * FROM matches WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function getPlayers(matchId, team = null) {
  if (team) {
    const { rows } = await q(
      `SELECT * FROM match_players WHERE match_id=$1 AND team_label=$2 ORDER BY roster_position`,
      [matchId, team]
    );
    return rows;
  }
  const { rows } = await q(
    `SELECT * FROM match_players WHERE match_id=$1 ORDER BY team_label, roster_position`,
    [matchId]
  );
  return rows;
}

async function getPlayerByPos(matchId, team, pos) {
  const { rows } = await q(
    `SELECT * FROM match_players WHERE match_id=$1 AND team_label=$2 AND roster_position=$3`,
    [matchId, team, pos]
  );
  return rows[0] || null;
}

async function getPlayerByTg(matchId, tgId) {
  const { rows } = await q(
    `SELECT * FROM match_players WHERE match_id=$1 AND telegram_id=$2`,
    [matchId, tgId]
  );
  return rows[0] || null;
}

async function getPlayer(id) {
  if (!id) return null;
  const { rows } = await q(`SELECT * FROM match_players WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function getTeam(matchId, label) {
  const { rows } = await q(
    `SELECT * FROM match_teams WHERE match_id=$1 AND team_label=$2`,
    [matchId, label]
  );
  return rows[0] || null;
}

async function getInnings(matchId) {
  const { rows } = await q(
    `SELECT * FROM innings WHERE match_id=$1 AND is_completed=FALSE ORDER BY innings_number DESC LIMIT 1`,
    [matchId]
  );
  return rows[0] || null;
}

async function upsertUser(u) {
  await q(
    `INSERT INTO users (telegram_id, username, first_name, last_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username=COALESCE(EXCLUDED.username,users.username),
       first_name=COALESCE(EXCLUDED.first_name,users.first_name),
       updated_at=NOW()`,
    [u.id, u.username || null, u.first_name || null, u.last_name || null]
  );
}

// ─── Text helpers ────────────────────────────────────────
function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}

// plain name (buttons / HTML messages)
function name(p) {
  if (!p) return '—';
  if (p.username) return `@${p.username}`;
  return p.first_name || `User${p.telegram_id || p.id || ''}`;
}

// Telegram legacy-Markdown safe text (usernames contain "_" which would break parsing)
function mdEsc(value) {
  return String(value ?? '').replace(/([_*`\[])/g, '\\$1');
}
// Markdown-safe name
function mn(p) {
  return mdEsc(name(p));
}

function oversStr(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

function isGroup(ctx) {
  return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
}

function line(char = '─', n = 22) {
  return char.repeat(n);
}

// ─── Keyboards ───────────────────────────────────────────
const mainKb = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🎮 SOLO', 'm:solo'), Markup.button.callback('👥 TEAM', 'm:team')],
    [Markup.button.callback('👤 PROFILE', 'm:profile'), Markup.button.callback('🏆 BOARD', 'm:lb')],
    [Markup.button.callback('📖 HELP', 'm:help')],
  ]);

const tossKb = (id) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('🏏 BAT FIRST', `toss:${id}:bat`),
      Markup.button.callback('🎳 BOWL FIRST', `toss:${id}:bowl`),
    ],
  ]);

const bowlKb = (token) =>
  Markup.inlineKeyboard([
    [
      Markup.button.callback('1️⃣', `bowl:${token}:1`),
      Markup.button.callback('2️⃣', `bowl:${token}:2`),
      Markup.button.callback('3️⃣', `bowl:${token}:3`),
    ],
    [
      Markup.button.callback('4️⃣', `bowl:${token}:4`),
      Markup.button.callback('5️⃣', `bowl:${token}:5`),
      Markup.button.callback('6️⃣', `bowl:${token}:6`),
    ],
  ]);

// captain buttons: only for teams that still have no captain
const captainKb = (id, needA, needB) => {
  const row = [];
  if (needA) row.push(Markup.button.callback('👑 Captain — Team A', `cap:${id}:A`));
  if (needB) row.push(Markup.button.callback('👑 Captain — Team B', `cap:${id}:B`));
  return Markup.inlineKeyboard([row]);
};

// overs 1..20, five per row
const oversKb = (id) => {
  const rows = [];
  for (let start = 1; start <= MAX_OVERS; start += 5) {
    const row = [];
    for (let n = start; n < start + 5 && n <= MAX_OVERS; n++) {
      row.push(Markup.button.callback(String(n), `ov:${id}:${n}`));
    }
    rows.push(row);
  }
  return Markup.inlineKeyboard(rows);
};


// BEGIN_IMAGEGEN
let sharp = null;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('sharp is not installed - image cards disabled (run: npm i sharp)');
}
const path = require('path');
const https = require('https');

const ASSET_DIR = path.join(__dirname, 'assets');
const FONT_FILE = path.join(ASSET_DIR, 'DejaVuSansCondensed-Bold.ttf');
const FONT_FAMILY = 'DejaVu Sans Condensed Bold';

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Only plain printable ASCII is drawn on the cards (the font has no emoji / regional glyphs)
function cleanName(s, fallback = 'Player') {
  const c = String(s || '').replace(/[^\x20-\x7E]/g, '').trim();
  return c || fallback;
}

// ---- Layout (pixel coordinates measured on the template images) ----
const HOST_LAYOUT = {
  file: 'host.png',
  circle: { cx: 1327, cy: 363, r: 198 },
  bar: { x0: 1085, x1: 1560, cy: 665, px: 58 },
};

const TEAM_LAYOUT = {
  file: 'team_final.png',
  // team A rows are at dy = 0, team B rows at dy = TEAM_ROW_DY
  rowDy: { A: 0, B: 508 },
  bat: {
    circle: { cx: 239.5, cy: 574, r: 62 },
    barText: { x0: 180, x1: 346, cy: 640, px: 26 },
    boxes: [
      { x0: 52, x1: 174, y0: 718, y1: 780 },
      { x0: 187, x1: 309, y0: 718, y1: 780 },
      { x0: 323, x1: 445, y0: 718, y1: 780 },
    ],
  },
  bowl: {
    circle: { cx: 785.3, cy: 574, r: 62 },
    barText: { x0: 723, x1: 889, cy: 640, px: 26 },
    boxes: [
      { x0: 584, x1: 705, y0: 718, y1: 780 },
      { x0: 719, x1: 841, y0: 718, y1: 780 },
      { x0: 854, x1: 976, y0: 718, y1: 780 },
    ],
  },
  clipAboveY: 617, // bar top outline (team A row) - DP must not cover the bar
  boxPx: 36,
};

const SOLO_LAYOUT = {
  file: 'solo_final.png',
  rowDy: { bat: 0, bowl: 496 },
  circle: { cx: 355.5, cy: 631, r: 80 },
  barText: { x0: 262, x1: 498, cy: 712, px: 34 },
  boxes: [
    { x0: 127, x1: 358, y0: 802, y1: 869 },
    { x0: 396, x1: 631, y0: 802, y1: 869 },
    { x0: 668, x1: 900, y0: 802, y1: 869 },
  ],
  clipAboveY: 684,
  boxPx: 46,
};

// ---- Text helpers ----
function needSharp() {
  if (!sharp) throw new Error('sharp not installed');
}

async function renderText(text, px, color = '#ffffff') {
  needSharp();
  const markup = `<span foreground="${color}">${xmlEsc(text)}</span>`;
  return sharp({
    text: { text: markup, font: `${FONT_FAMILY} ${px}`, fontfile: FONT_FILE, rgba: true, dpi: 72 },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
}

// Draw only as many characters as fit in maxW (no shrinking, no "...")
async function textTruncated(text, px, maxW) {
  let t = String(text);
  let img = await renderText(t, px);
  if (img.info.width > maxW) {
    t = t.slice(0, Math.max(1, Math.floor((t.length * maxW) / img.info.width)));
    img = await renderText(t, px);
    while (img.info.width > maxW && t.length > 1) {
      t = t.slice(0, -1);
      img = await renderText(t, px);
    }
  }
  return img;
}

// Short values (numbers): shrink the font until it fits the box
async function textShrunk(text, px, maxW, maxH) {
  let size = px;
  let img = await renderText(text, size);
  while ((img.info.width > maxW || img.info.height > maxH) && size > 10) {
    size -= 2;
    img = await renderText(text, size);
  }
  return img;
}

const centered = (img, cx, cy, dy = 0) => ({
  input: img.data,
  left: Math.round(cx - img.info.width / 2),
  top: Math.round(cy - img.info.height / 2 + dy),
});

// ---- DP helpers ----
function defaultAvatarSvg(d) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}" viewBox="0 0 ${d} ${d}">
      <defs><clipPath id="c"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}"/></clipPath></defs>
      <g clip-path="url(#c)">
        <rect width="${d}" height="${d}" fill="#0b0b0b"/>
        <circle cx="${d / 2}" cy="${d * 0.4}" r="${d * 0.19}" fill="#9a9a9a"/>
        <ellipse cx="${d / 2}" cy="${d * 0.98}" rx="${d * 0.36}" ry="${d * 0.32}" fill="#9a9a9a"/>
      </g></svg>`
  );
}

// Default avatar (saved permanently in assets/default_dp.png) used when a user has no profile photo
const DEFAULT_DP_FILE = path.join(ASSET_DIR, 'default_dp.png');
async function defaultAvatar(d) {
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#fff"/></svg>`
  );
  try {
    if (require('fs').existsSync(DEFAULT_DP_FILE)) {
      return await sharp(DEFAULT_DP_FILE)
        .resize(d, d, { fit: 'cover' })
        .ensureAlpha()
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
    }
  } catch (_) {}
  return sharp(defaultAvatarSvg(d)).png().toBuffer();
}

// Round, size-adjusted DP (square crop of the photo, scaled to the circle)
async function circleImage(dpBuf, d) {
  if (!dpBuf) return defaultAvatar(d);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#fff"/></svg>`
  );
  try {
    return await sharp(dpBuf)
      .resize(d, d, { fit: 'cover', position: 'centre' })
      .ensureAlpha()
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  } catch (_) {
    return defaultAvatar(d);
  }
}

// dp layer; clipY = last y that may be drawn (so username bar stays on top)
async function dpLayer(dpBuf, c, dy = 0, clipY = null) {
  const d = Math.round(c.r * 2);
  let img = await circleImage(dpBuf, d);
  const top = Math.round(c.cy - c.r + dy);
  const left = Math.round(c.cx - c.r);
  if (clipY !== null) {
    const h = Math.max(1, Math.min(d, Math.round(clipY + dy - top)));
    if (h < d) img = await sharp(img).extract({ left: 0, top: 0, width: d, height: h }).png().toBuffer();
  }
  return { input: img, left, top };
}

const fmt1 = (n) => (Number.isFinite(n) ? n.toFixed(2) : '0.00');

// ═══ HOST BANNER ═══
async function renderHostCard({ dp, username, firstName }) {
  needSharp();
  const L = HOST_LAYOUT;
  const label = username ? `@${cleanName(username, '')}` : cleanName(firstName);
  const layers = [await dpLayer(dp, L.circle)];
  const txt = await textTruncated(label, L.bar.px, L.bar.x1 - L.bar.x0);
  layers.push(centered(txt, (L.bar.x0 + L.bar.x1) / 2, L.bar.cy, 1));
  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ TEAM FINAL CARD ═══
// team = { bat: {dp, name, runs, balls, sr} | null, bowl: {dp, name, wkts, balls, eco} | null }
async function renderTeamFinalCard({ A, B }) {
  needSharp();
  const L = TEAM_LAYOUT;
  const layers = [];
  for (const [label, team] of [['A', A], ['B', B]]) {
    const dy = L.rowDy[label];
    for (const kind of ['bat', 'bowl']) {
      const slot = L[kind];
      const p = team && team[kind];
      layers.push(await dpLayer(p && p.dp, slot.circle, dy, L.clipAboveY));
      if (p && p.name) {
        const t = await textTruncated(cleanName(p.name), slot.barText.px, slot.barText.x1 - slot.barText.x0);
        layers.push({ input: t.data, left: slot.barText.x0, top: Math.round(slot.barText.cy + dy - t.info.height / 2 + 1) });
      }
      const vals = p
        ? kind === 'bat'
          ? [String(p.runs), String(p.balls), fmt1(p.sr)]
          : [String(p.wkts), String(p.balls), fmt1(p.eco)]
        : ['-', '-', '-'];
      for (let i = 0; i < 3; i++) {
        const b = slot.boxes[i];
        const img = await textShrunk(vals[i], L.boxPx, b.x1 - b.x0 - 14, b.y1 - b.y0 - 8);
        layers.push(centered(img, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2 + dy, 1));
      }
    }
  }
  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ SOLO FINAL CARD ═══
async function renderSoloFinalCard({ bat, bowl }) {
  needSharp();
  const L = SOLO_LAYOUT;
  const layers = [];
  for (const [kind, p] of [['bat', bat], ['bowl', bowl]]) {
    const dy = L.rowDy[kind];
    layers.push(await dpLayer(p && p.dp, L.circle, dy, L.clipAboveY));
    if (p && p.name) {
      const t = await textTruncated(cleanName(p.name), L.barText.px, L.barText.x1 - L.barText.x0);
      layers.push({ input: t.data, left: L.barText.x0, top: Math.round(L.barText.cy + dy - t.info.height / 2 + 1) });
    }
    const vals = p
      ? kind === 'bat'
        ? [String(p.runs), String(p.balls), fmt1(p.sr)]
        : [String(p.wkts), String(p.balls), fmt1(p.eco)]
      : ['-', '-', '-'];
    for (let i = 0; i < 3; i++) {
      const b = L.boxes[i];
      const img = await textShrunk(vals[i], L.boxPx, b.x1 - b.x0 - 20, b.y1 - b.y0 - 8);
      layers.push(centered(img, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2 + dy, 1));
    }
  }
  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ MATCH BANNER (host + Team A captain + Team B captain) ═══
const BANNER_W = 1280;
const BANNER_H = 940;

const ringSvg = (cx, cy, r) =>
  `<g><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff1a1a" stroke-width="16" filter="url(#glow)" opacity="0.95"/>
   <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff2f2f" stroke-width="9"/>
   <circle cx="${cx}" cy="${cy}" r="${r - 8}" fill="none" stroke="#ffd6d6" stroke-width="2" opacity="0.9"/></g>`;

const ribbonSvg = (cx, cy, w, h) => {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2, k = h / 2;
  const pts = `${x0},${cy} ${x0 + k},${y0} ${x1 - k},${y0} ${x1},${cy} ${x1 - k},${y1} ${x0 + k},${y1}`;
  return `<g><polygon points="${pts}" fill="#070707" stroke="#ff1a1a" stroke-width="8" filter="url(#glow)" opacity="0.9"/>
   <polygon points="${pts}" fill="#070707" stroke="#ff3131" stroke-width="4"/></g>`;
};

async function renderMatchBanner({ hostDp, hostName, capA, capB }) {
  needSharp();
  const W = BANNER_W, H = BANNER_H;
  // background: dark red arena glow + grain
  const bg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs>
      <radialGradient id="c" cx="50%" cy="62%" r="70%"><stop offset="0" stop-color="#5a0000"/><stop offset="0.55" stop-color="#1c0000"/><stop offset="1" stop-color="#000"/></radialGradient>
      <radialGradient id="l" cx="18%" cy="70%" r="40%"><stop offset="0" stop-color="#a00000" stop-opacity="0.55"/><stop offset="1" stop-color="#a00000" stop-opacity="0"/></radialGradient>
      <radialGradient id="r" cx="82%" cy="70%" r="40%"><stop offset="0" stop-color="#a00000" stop-opacity="0.55"/><stop offset="1" stop-color="#a00000" stop-opacity="0"/></radialGradient>
      <filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7"/>
        <feColorMatrix type="matrix" values="0 0 0 0 0.8  0 0 0 0 0  0 0 0 0 0  0 0 0 0.5 0"/></filter>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#c)"/><rect width="${W}" height="${H}" fill="url(#l)"/><rect width="${W}" height="${H}" fill="url(#r)"/>
    <rect width="${W}" height="${H}" filter="url(#n)" opacity="0.22"/>
  </svg>`);

  // header (logo strip from the poster) with a soft fade at the bottom
  const headerH = Math.round((300 * W) / 1024);
  let header = await sharp(path.join(ASSET_DIR, TEAM_LAYOUT.file))
    .extract({ left: 0, top: 0, width: 1024, height: 300 })
    .resize(W, headerH)
    .ensureAlpha()
    .png()
    .toBuffer();
  const fade = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${headerH}"><defs>
    <linearGradient id="f" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="1"/><stop offset="0.7" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>
    <rect width="${W}" height="${headerH}" fill="url(#f)"/></svg>`);
  header = await sharp(header).composite([{ input: fade, blend: 'dest-in' }]).png().toBuffer();

  const hostC = { cx: 640, cy: 455, r: 82 };
  const aC = { cx: 290, cy: 600, r: 150 };
  const bC = { cx: 990, cy: 600, r: 150 };

  const layers = [{ input: header, left: 0, top: 0 }];
  layers.push(await dpLayer(hostDp, { ...hostC, r: hostC.r - 6 }));
  layers.push(await dpLayer(capA && capA.dp, { ...aC, r: aC.r - 6 }));
  layers.push(await dpLayer(capB && capB.dp, { ...bC, r: bC.r - 6 }));

  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
    <defs><filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter></defs>
    ${ringSvg(hostC.cx, hostC.cy, hostC.r)}${ringSvg(aC.cx, aC.cy, aC.r)}${ringSvg(bC.cx, bC.cy, bC.r)}
    ${ribbonSvg(hostC.cx, hostC.cy + hostC.r + 38, 190, 46)}
    ${ribbonSvg(aC.cx, aC.cy + aC.r + 52, 380, 74)}
    ${ribbonSvg(bC.cx, bC.cy + bC.r + 52, 380, 74)}
  </svg>`);
  layers.push({ input: overlay, left: 0, top: 0 });

  const put = async (text, px, cx, cy, color = '#ffffff', maxW = 9999) => {
    const img = await textTruncated(text, px, maxW);
    layers.push({ input: img.data, left: Math.round(cx - img.info.width / 2), top: Math.round(cy - img.info.height / 2 + 1) });
  };
  await put('HOST', 28, hostC.cx, hostC.cy + hostC.r + 38);
  await put('TEAM A', 50, aC.cx, aC.cy + aC.r + 52);
  await put('TEAM B', 50, bC.cx, bC.cy + bC.r + 52);
  await put('VS', 110, 640, 745);
  const nm = (s) => (s ? cleanName(s) : '');
  if (hostName) await put(`@${nm(hostName)}`, 28, hostC.cx, hostC.cy + hostC.r + 84, '#fff', 330);
  if (capA && capA.name) await put(`C  ${nm(capA.name)}`, 32, aC.cx, aC.cy + aC.r + 122, '#fff', 360);
  if (capB && capB.name) await put(`C  ${nm(capB.name)}`, 32, bC.cx, bC.cy + bC.r + 122, '#fff', 360);

  return sharp(bg).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ Telegram profile photo download ═══
function downloadBuf(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (r) => {
        if (r.statusCode !== 200) {
          r.resume();
          return reject(new Error('HTTP ' + r.statusCode));
        }
        const chunks = [];
        r.on('data', (d) => chunks.push(d));
        r.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

// returns Buffer or null (no photo / hidden / error)
async function getUserDp(telegram, userId) {
  try {
    const res = await telegram.getUserProfilePhotos(Number(userId), 0, 1);
    if (!res || !res.total_count) return null;
    const sizes = res.photos[0];
    const best = sizes[sizes.length - 1];
    const link = await telegram.getFileLink(best.file_id);
    return await downloadBuf(String(link));
  } catch (e) {
    console.error('getUserDp failed:', e.message);
    return null;
  }
}

// ─── Solo: auto set batsman + bowler (multi-player OK) ────
async function soloAutoSetup(match, inn) {
  if (match.mode !== 'solo') return inn;
  // Join order = roster_position on team A (1st, 2nd, 3rd…)
  const all = await getPlayers(match.id, 'A');
  if (all.length < 2) return inn;

  // Next not-out in join order → bats
  let batsman = null;
  for (const p of all) {
    const { rows: st } = await q(
      `SELECT is_out FROM batting_stats WHERE innings_id=$1 AND player_id=$2`,
      [inn.id, p.id]
    );
    if (!st[0]?.is_out) {
      batsman = p;
      break;
    }
  }
  if (!batsman) return inn;

  // Bowler: keep current if not batsman; else next after batsman in queue
  let bowler = null;
  if (inn.current_bowler_id) {
    const cur = await getPlayer(inn.current_bowler_id);
    if (cur && cur.id !== batsman.id) bowler = cur;
  }
  if (!bowler) {
    const idx = all.findIndex((p) => p.id === batsman.id);
    bowler = all[(idx + 1) % all.length];
    if (bowler.id === batsman.id && all.length > 1) {
      bowler = all.find((p) => p.id !== batsman.id) || all[0];
    }
  }

  await q(
    `INSERT INTO batting_stats (innings_id, player_id) VALUES ($1,$2)
     ON CONFLICT (innings_id, player_id) DO NOTHING`,
    [inn.id, batsman.id]
  );
  await q(
    `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2)
     ON CONFLICT (innings_id, player_id) DO NOTHING`,
    [inn.id, bowler.id]
  );

  await q(
    `UPDATE innings SET
       striker_player_id = $2,
       non_striker_player_id = NULL,
       current_bowler_id = $3
     WHERE id = $1`,
    [inn.id, batsman.id, bowler.id]
  );
  return getInnings(match.id);
}

// ─── Scoreboard (designed) ───────────────────────────────
async function scoreboard(matchId) {
  const match = await getMatch(matchId);
  if (!match) return '❌ Match not found';

  const inn = await getInnings(matchId);
  const isSolo = match.mode === 'solo';

  let t = '';
  t += `╔══════════════════════╗\n`;
  t += `║  🏏 HAND CRICKET     ║\n`;
  t += `╚══════════════════════╝\n\n`;

  if (['completed', 'cancelled'].includes(match.status)) {
    t += `Status: *${match.status.toUpperCase()}*\n`;
    if (match.winner_team === 'tie') t += `🤝 *MATCH TIED*\n`;
    else if (match.winner_team && !isSolo) t += `🏆 Winner: *Team ${match.winner_team}*\n`;
    return t;
  }

  if (!inn) {
    t += `⏳ Waiting for the match to start…\n`;
    return t;
  }

  if (!isSolo) return teamScoreboard(match, inn);

  const bat = inn.batting_team;
  const bowl = inn.bowling_team;
  const totalOvers = match.total_overs || DEFAULT_OVERS;
  const crr =
    inn.balls_bowled > 0
      ? ((inn.total_runs * 6) / inn.balls_bowled).toFixed(2)
      : '0.00';

  t += `📊 *INNINGS ${inn.innings_number}*\n`;
  t += `${line()}\n`;
  t += isSolo
    ? `🏏 Score: *${inn.total_runs}/${inn.total_wickets}*\n`
    : `🅰️ Team ${bat}  »  *${inn.total_runs}/${inn.total_wickets}*\n`;
  t += isSolo
    ? `⏱ Overs: *${oversStr(inn.balls_bowled)}*  (unlimited)\n`
    : `⏱ Overs: *${oversStr(inn.balls_bowled)} / ${totalOvers}*\n`;
  t += `📈 RR: *${crr}*\n`;

  if (match.target && inn.innings_number === 2) {
    const need = Math.max(0, match.target - inn.total_runs);
    t += `🎯 Target: *${match.target}*  (Need *${need}*)\n`;
  }

  const striker = await getPlayer(inn.striker_player_id);
  const non = await getPlayer(inn.non_striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);

  t += `\n${line()}\n`;
  if (striker) t += `🏏 Striker   ${mn(striker)}\n`;
  if (!isSolo && non) t += `🧍🏻 Non-strike ${mn(non)}\n`;
  if (bowler) t += `🎳 Bowler    ${mn(bowler)}\n`;

  if (!isSolo) {
    // Batting card
    t += isSolo ? `\n┌─ BATSMAN ─┐\n` : `\n┌─ BATTING Team ${bat} ─┐\n`;
    const bats = await getPlayers(matchId, bat);
    for (const p of bats) {
      const { rows: st } = await q(
        `SELECT * FROM batting_stats WHERE innings_id=$1 AND player_id=$2`,
        [inn.id, p.id]
      );
      const s = st[0];
      let icon = '⚪';
      if (striker && p.id === striker.id) icon = '🏏';
      else if (non && p.id === non.id) icon = '🧍🏻';
      else if (s?.is_out) icon = '❌';
      else if (s && (s.balls_faced || 0) > 0) icon = '✅';

      const runs = s ? `${s.runs || 0}(${s.balls_faced || 0})` : '—';
      t += `│ ${icon} ${p.roster_position}. ${mn(p)}  ${runs}\n`;
    }
    t += `└${'─'.repeat(20)}┘\n`;

    // Bowling card
    t += isSolo ? `\n┌─ BOWLER ─┐\n` : `\n┌─ BOWLING Team ${bowl} ─┐\n`;
    const bowls = await getPlayers(matchId, bowl);
    const maxOv = match.max_overs_per_bowler || MAX_BOWLER_OVERS;
    for (const p of bowls) {
      const { rows: st } = await q(
        `SELECT * FROM bowling_stats WHERE innings_id=$1 AND player_id=$2`,
        [inn.id, p.id]
      );
      const s = st[0];
      const bb = s?.balls_bowled || 0;
      let icon = '🟢';
      if (bowler && p.id === bowler.id) icon = '🎳';
      else if (!isSolo && bb / 6 >= maxOv) icon = '✅';

      const fig = s
        ? `${s.wickets || 0}/${s.runs_conceded || 0} (${oversStr(bb)})`
        : '—';
      t += `│ ${icon} ${p.roster_position}. ${mn(p)}  ${fig}\n`;
    }
    t += `└${'─'.repeat(20)}┘\n`;
  }
  t += `\n💡 Bowler sends a number in the bot's DM first, then the batsman types *1–6* in the group`;
  t += `\n⏱ ${TURN_SECONDS}s to respond, otherwise -${TURN_PENALTY} runs`;

  return t;
}

// ─── Team scoreboard (CricketMania style) ───────────────
async function hostLabel(m) {
  const { rows } = await q(`SELECT username, first_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
  return rows[0] ? mdEsc(name(rows[0])) : '—';
}

const inningsWord = (n) => (n === 1 ? '1st' : n === 2 ? '2nd' : n + 'th');

async function teamScoreboard(match, inn) {
  const totalOvers = match.total_overs || DEFAULT_OVERS;
  const { rows: all } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [match.id]);
  const teamLine = (label) => {
    const i = all.find((x) => x.batting_team === label);
    const runs = i ? i.total_runs : 0;
    const wk = i ? i.total_wickets : 0;
    const balls = i ? i.balls_bowled : 0;
    const crr = balls > 0 ? ((runs * 6) / balls).toFixed(2) : '0.0';
    const icon = label === inn.batting_team ? '🏏' : '🎯';
    return `${icon} Team ${label} | *${runs}/${wk}* | ${oversStr(balls)}/${totalOvers} overs\n📈 CRR: ${crr}`;
  };

  let t = `🏏 *SCORECARD*\n${line('─', 24)}\n`;
  t += `${teamLine('A')}\n\n${teamLine('B')}\n`;
  if (match.target && inn.innings_number === 2) {
    const need = Math.max(0, match.target - inn.total_runs);
    const left = Math.max(0, totalOvers * 6 - inn.balls_bowled);
    t += `\n🎯 Target: *${match.target}* — need *${need}* from *${left}* balls\n`;
  }

  const striker = await getPlayer(inn.striker_player_id);
  const non = await getPlayer(inn.non_striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);

  const batLine = async (p, icon) => {
    const { rows } = await q(`SELECT runs, balls_faced FROM batting_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, p.id]);
    const r = rows[0] || { runs: 0, balls_faced: 0 };
    const sr = r.balls_faced > 0 ? ((r.runs * 100) / r.balls_faced).toFixed(1) : '0.0';
    return `${icon} ${mn(p)}  ${r.runs || 0}(${r.balls_faced || 0})  SR: ${sr}`;
  };

  t += `${line('─', 24)}\n🏏 *BATTING — Team ${inn.batting_team}*\n\n`;
  t += striker ? (await batLine(striker, '⚡')) + '\n' : `⏳ waiting for the batting captain: /bat <no.>\n`;
  if (non) t += (await batLine(non, '  ')) + '\n';

  t += `${line('─', 24)}\n🎯 *BOWLING — Team ${inn.bowling_team}*\n\n`;
  if (bowler) {
    const { rows } = await q(
      `SELECT wickets, runs_conceded, balls_bowled FROM bowling_stats WHERE innings_id=$1 AND player_id=$2`,
      [inn.id, bowler.id]
    );
    const r = rows[0];
    t += `🔥 ${mn(bowler)}  ${r && r.balls_bowled > 0 ? `${r.wickets || 0}/${r.runs_conceded || 0} (${oversStr(r.balls_bowled)})` : '(—)'}\n`;
  } else {
    t += `⏳ waiting for the bowling captain: /ball <no.>\n`;
  }

  t += `${line('─', 24)}\n🎮 Game Host - ${await hostLabel(match)}\n`;
  t += `⏱ ${TURN_SECONDS}s to respond, otherwise -${TURN_PENALTY} runs`;
  return t;
}

// ─── Team lists with markers ([🧢] captain, ❌ out, 🏃 batting, 🎯 bowling) ───
async function rosterText(match) {
  const inn = await getInnings(match.id);
  const { rows: outs } = await q(
    `SELECT DISTINCT bs.player_id FROM batting_stats bs JOIN innings i ON i.id=bs.innings_id
      WHERE i.match_id=$1 AND bs.is_out`,
    [match.id]
  );
  const outSet = new Set(outs.map((r) => r.player_id));
  let t = '';
  for (const L of ['A', 'B']) {
    const team = await getTeam(match.id, L);
    const pl = await getPlayers(match.id, L);
    t += `${L === 'A' ? '🅰' : '🅱'} *TEAM ${L}*\n`;
    for (const p of pl) {
      let mark = '';
      if (team?.captain_id && Number(p.telegram_id) === Number(team.captain_id)) mark += ' [🧢]';
      if (outSet.has(p.id)) mark += ' ❌';
      if (inn && (p.id === inn.striker_player_id || p.id === inn.non_striker_player_id)) mark += ' 🏃';
      if (inn && p.id === inn.current_bowler_id) mark += ' 🎯';
      t += `${p.roster_position}. ${mn(p)}${mark}\n`;
    }
    t += '\n';
  }
  return t;
}

// Telegram limit is 4096 chars: split long texts at line breaks
async function sendLong(telegram, chatId, text, extra = { parse_mode: 'Markdown' }) {
  const lines = String(text).split('\n');
  let chunk = '';
  for (const ln of lines) {
    if ((chunk + ln + '\n').length > 3800) {
      if (chunk.trim()) await telegram.sendMessage(chatId, chunk, extra);
      chunk = '';
    }
    chunk += ln + '\n';
  }
  if (chunk.trim()) await telegram.sendMessage(chatId, chunk, extra);
}

// Full scorecard: every player with batting (runs(balls) SR), bowling economy and over-by-over balls
async function fullScorecard(matchId) {
  const match = await getMatch(matchId);
  const isSolo = match.mode === 'solo';
  const totalOvers = match.total_overs || DEFAULT_OVERS;
  const { rows: inns } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [matchId]);
  const { rows: bats } = await q(
    `SELECT bs.player_id, SUM(bs.runs)::int AS runs, SUM(bs.balls_faced)::int AS balls
       FROM batting_stats bs JOIN innings i ON i.id=bs.innings_id WHERE i.match_id=$1 GROUP BY bs.player_id`,
    [matchId]
  );
  const { rows: bowls } = await q(
    `SELECT bw.player_id, SUM(bw.wickets)::int AS wkts, SUM(bw.balls_bowled)::int AS balls, SUM(bw.runs_conceded)::int AS conceded
       FROM bowling_stats bw JOIN innings i ON i.id=bw.innings_id WHERE i.match_id=$1 GROUP BY bw.player_id`,
    [matchId]
  );
  const { rows: dels } = await q(
    `SELECT d.bowler_id, d.over_number, d.ball_number, d.runs_scored, d.is_wicket, i.innings_number
       FROM deliveries d JOIN innings i ON i.id=d.innings_id WHERE i.match_id=$1
      ORDER BY i.innings_number, d.over_number, d.ball_number`,
    [matchId]
  );
  const batBy = new Map(bats.map((r) => [r.player_id, r]));
  const bowlBy = new Map(bowls.map((r) => [r.player_id, r]));
  const overs = new Map(); // bowlerId -> Map("inn:over" -> [tokens])
  for (const d of dels) {
    if (!overs.has(d.bowler_id)) overs.set(d.bowler_id, new Map());
    const k = `${d.innings_number}:${d.over_number}`;
    const m = overs.get(d.bowler_id);
    if (!m.has(k)) m.set(k, { over: Number(d.over_number) + 1, balls: [] });
    m.get(k).balls.push(d.is_wicket ? 'W' : String(d.runs_scored));
  }

  let t = `🏏 *FULL SCORECARD*\n`;
  const groups = isSolo ? [null] : ['A', 'B'];
  for (const L of groups) {
    t += `${line('─', 24)}\n`;
    if (L) {
      const i = inns.find((x) => x.batting_team === L);
      const runs = i ? i.total_runs : 0;
      const wk = i ? i.total_wickets : 0;
      const balls = i ? i.balls_bowled : 0;
      const crr = balls > 0 ? ((runs * 6) / balls).toFixed(2) : '0.00';
      t += `🏏 Team ${L} | *${runs}/${wk}* | ${oversStr(balls)}/${totalOvers} Overs\n📈 CRR: ${crr}\n${line('─', 24)}\n`;
      t += `${L === 'A' ? '🅰' : '🅱'} *Team ${L}*\n\n`;
    } else {
      t += `🎮 *Players*\n\n`;
    }
    const team = L ? await getTeam(matchId, L) : null;
    const pl = await getPlayers(matchId, L || 'A');
    for (const p of pl) {
      const b = batBy.get(p.id) || { runs: 0, balls: 0 };
      const w = bowlBy.get(p.id);
      const sr = b.balls > 0 ? ((b.runs * 100) / b.balls).toFixed(1) : '—';
      const eco = w && w.balls > 0 ? ((w.conceded * 6) / w.balls).toFixed(1) : '—';
      const cap = team?.captain_id && Number(p.telegram_id) === Number(team.captain_id) ? ' [🧢]' : '';
      t += `${p.roster_position}. ${mn(p)}${cap}\n`;
      t += `  ⎣ ${b.runs}(${b.balls})  SR: ${sr}  Eco: ${eco}\n`;
      const ov = overs.get(p.id);
      if (!ov || !ov.size) t += `    _Not bowled yet_\n\n`;
      else {
        for (const o of ov.values()) t += `    Ov${o.over}: (${o.balls.join(' • ')})\n`;
        t += '\n';
      }
    }
  }
  return t;
}

// Match start banner: host + Team A captain + Team B captain (default avatar when someone has no DP)
async function sendMatchBanner(telegram, groupId, m, extraCaption = '') {
  const tA = await getTeam(m.id, 'A');
  const tB = await getTeam(m.id, 'B');
  const capA = tA?.captain_id ? await getPlayerByTg(m.id, tA.captain_id) : null;
  const capB = tB?.captain_id ? await getPlayerByTg(m.id, tB.captain_id) : null;
  const { rows } = await q(`SELECT username, first_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
  const host = rows[0] || {};
  const caption =
    `⚙ Overs — *${m.total_overs}*  |  Innings — *${inningsWord(m.current_innings || 1)}*\n` +
    `🏏 Batting — *Team ${m.current_batting_team}*\n` +
    `🎯 Bowling — *Team ${m.current_bowling_team}*` +
    extraCaption;
  try {
    const [hostDp, dpA, dpB] = await Promise.all([
      getUserDp(telegram, m.host_telegram_id),
      capA ? getUserDp(telegram, capA.telegram_id) : null,
      capB ? getUserDp(telegram, capB.telegram_id) : null,
    ]);
    const img = await renderMatchBanner({
      hostDp,
      hostName: host.username || host.first_name || '',
      capA: capA ? { dp: dpA, name: capA.username || capA.first_name } : null,
      capB: capB ? { dp: dpB, name: capB.username || capB.first_name } : null,
    });
    await telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'Markdown' });
  } catch (e) {
    await reportCardError('Match banner', e);
    await telegram.sendMessage(groupId, caption, { parse_mode: 'Markdown' });
  }
}

// ─── /start ──────────────────────────────────────────────
bot.start(async (ctx) => {
  await upsertUser(ctx.from);
  // a bowler who had not started the bot yet: deliver the number request now
  if (ctx.chat && ctx.chat.type === 'private') {
    try {
      const { rows } = await q(
        `SELECT * FROM pending_balls WHERE bowler_telegram_id=$1 AND is_resolved=FALSE AND bowl_number IS NULL`,
        [ctx.from.id]
      );
      for (const pend of rows) await sendBowlerPrompt(ctx.telegram, pend);
    } catch (e) {
      console.error('start prompt failed:', e.message);
    }
  }
  await ctx.reply(
    `╔══════════════════════╗\n` +
      `║  🏏 HAND CRICKET     ║\n` +
      `╚══════════════════════╝\n\n` +
      `Create a match in a group.\n` +
      `Press /start here first (needed for bowling in DM).\n\n` +
      `*Solo* → unlimited overs, just type 1-6\n` +
      `*Team* → /team → /startgame → captains, toss, /setovers`,
    { parse_mode: 'Markdown', ...mainKb() }
  );
});

// ─── Permanent result GIFs ────────────────────────────────────────────────
// Reply to a GIF with /pgif <event>. Saved in PostgreSQL permanently.
//  1-6        → runs scored            out       → wicket            dugout → batsman walks back after OUT
//  stance     → batsman takes stance   runup     → bowler runs in    batentry → new batsman walks in
//  bowlentry  → new bowler comes       (old names newbatsman / newbowler / runnerup still work)
const PGIF_ALIASES = {
  newbowler: 'bowlentry',
  bowlerentry: 'bowlentry',
  newbatsman: 'batentry',
  batsmanentry: 'batentry',
  runnerup: 'runup',
};
const PGIF_KEYS = new Set(['1', '2', '3', '4', '5', '6', 'out', 'dugout', 'stance', 'runup', 'batentry', 'bowlentry']);
const PGIF_LEGACY = { batentry: 'newbatsman', bowlentry: 'newbowler' }; // keys saved by an older version
const PGIF_LABELS = {
  out: 'WICKET',
  dugout: 'DUGOUT',
  stance: 'BATSMAN STANCE',
  runup: 'BOWLER RUN-UP',
  batentry: 'BATSMAN ENTRY',
  bowlentry: 'BOWLER ENTRY',
};

async function canConfigurePgif(ctx) {
  const ids = [process.env.BOT_OWNER_ID, ...(process.env.ADMIN_IDS || '').split(',')]
    .map((v) => Number(String(v || '').trim())).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (ctx.from && ids.includes(ctx.from.id)) return true;
  if (ctx.chat && ctx.chat.type !== 'private') {
    try {
      const member = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id);
      return ['creator', 'administrator'].includes(member.status);
    } catch (e) { console.error('pgif admin check failed:', e.message); }
  }
  return false;
}

bot.command('pgif', async (ctx) => {
  try {
    const parts = String(ctx.message?.text || '').trim().split(/\s+/);
    const rawKey = String(parts[1] || '').toLowerCase();
    const key = PGIF_ALIASES[rawKey] || rawKey;
    if (!PGIF_KEYS.has(key))
      return ctx.reply(
        'Reply to a GIF with:\n/pgif 1 … /pgif 6\n/pgif out · /pgif dugout\n/pgif stance · /pgif runup\n/pgif batentry · /pgif bowlentry'
      );
    if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Only a group admin or the owner configured in BOT_OWNER_ID / ADMIN_IDS can set GIFs.');

    const replied = ctx.message?.reply_to_message;
    if (!replied) return ctx.reply('❌ Reply to the GIF message with /pgif ' + key);
    let fileId = replied.animation?.file_id || null;
    let mediaType = 'animation';
    if (!fileId && replied.document) {
      const mime = String(replied.document.mime_type || '').toLowerCase();
      if (mime === 'image/gif' || mime.startsWith('video/')) {
        fileId = replied.document.file_id;
        mediaType = 'document';
      }
    }
    if (!fileId && replied.video) { fileId = replied.video.file_id; mediaType = 'video'; }
    if (!fileId) return ctx.reply('❌ No GIF/animation found in the replied message. Send the GIF directly in the group, then reply to that message.');

    await q(`INSERT INTO public.pgif_settings (result_key, file_id, media_type, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (result_key) DO UPDATE SET file_id=EXCLUDED.file_id, media_type=EXCLUDED.media_type,
      updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [key, fileId, mediaType, String(ctx.from.id)]);
    const label = PGIF_LABELS[key] || key + ' RUN' + (key === '1' ? '' : 'S');
    return ctx.reply(`✅ Permanent GIF saved for ${label}!\nIt will now appear automatically in every match.`);
  } catch (e) {
    console.error('pgif setup error:', e);
    try { return await ctx.reply('❌ Could not save the GIF: ' + String(e.message || e).slice(0, 250)); } catch {}
  }
});

async function sendResultGif(telegram, chatId, key, replyToMessageId, caption = '') {
  try {
    const legacy = PGIF_LEGACY[key] || key;
    const { rows } = await q(
      'SELECT file_id, media_type FROM public.pgif_settings WHERE result_key IN ($1,$2) ORDER BY (result_key=$1) DESC LIMIT 1',
      [String(key), String(legacy)]
    );
    const gif = rows[0];
    if (!gif) return;
    const opts = {
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
      ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    };
    if (gif.media_type === 'document') await telegram.sendDocument(chatId, gif.file_id, opts);
    else if (gif.media_type === 'video') await telegram.sendVideo(chatId, gif.file_id, opts);
    else await telegram.sendAnimation(chatId, gif.file_id, opts);
  } catch (e) { console.error(`Could not send pgif ${key}:`, e.message); }
}

// ─── Help ────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *HOW TO PLAY*\n\n` +
      `*SOLO* (unlimited overs, everyone bats until out)\n` +
      `/startsolo — open lobby (60s)\n` +
      `/joinsolo — join (#1 bats, #2 bowls…)\n` +
      `/leavesolo — leave\n` +
      `/forcestart or /startgame — start (min 2)\n` +
      `/extend30 — +30s\n` +
      `Then just type 1-6 when it is your turn to bat\n\n` +
      `*TEAM*\n` +
      `/team — create a team lobby (unlimited players)\n` +
      `/join_a  /join_b — join a team\n` +
      `/startgame — host starts: captains → toss → bat/bowl\n` +
      `/setovers — host picks overs (1-20)\n` +
      `/bat 1 · /ball 1 — captains pick players, then type 1-6\n\n` +
      `Same number = OUT\n\n` +
      `*Other*\n` +
      `/team — player list (while a match is on) · /score · /endmatch\n` +
      `/changehost — vote to change the host (3 votes per team)\n\n` +
      `*Rules*\n` +
      `⏱ Batsman and bowler must respond within ${TURN_SECONDS}s, otherwise *-${TURN_PENALTY} runs* (team: from the team score, solo: from the player's runs).\n` +
      `Solo: bowling changes automatically after ${SOLO_BOWLER_WARN_LIMIT} bowler warnings. Team: after ${TEAM_BOWLER_WARN_LIMIT} warnings the captain must choose a new bowler.\n` +
      `A batsman who misses ${BAT_RETIRE_LIMIT} turns is retired OUT.\n` +
      `If a lobby does nothing, the host gets warnings and the game ends after ${IDLE_WARN_LIMIT}.\n\n` +
      `*GIF setup (reply to a GIF):*\n` +
      `/pgif 1 … /pgif 6 · /pgif out · /pgif dugout\n/pgif stance · /pgif runup · /pgif batentry · /pgif bowlentry`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('scorecard', async (ctx) => {
  if (!isGroup(ctx)) return;
  let m = await getActiveMatch(ctx.chat.id);
  if (!m) {
    const { rows } = await q(`SELECT * FROM matches WHERE group_chat_id=$1 ORDER BY created_at DESC LIMIT 1`, [ctx.chat.id]);
    m = rows[0];
  }
  if (!m) return ctx.reply('❌ No match found');
  await sendLong(ctx.telegram, ctx.chat.id, await fullScorecard(m.id));
});

bot.action('m:solo', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isGroup(ctx)) return ctx.reply('Open this menu in a group — pressing SOLO there starts a solo lobby right away.');
  return createSoloLobby(ctx);
});
bot.action('m:team', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isGroup(ctx)) return ctx.reply('Open this menu in a group — pressing TEAM there creates a team lobby right away.');
  return createTeamMatch(ctx);
});
bot.action('m:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Solo: /startsolo → join → start → type 1-6\nTeam: /team → join → /startgame → captains → toss → /setovers'
  );
});
bot.action('m:profile', async (ctx) => {
  await ctx.answerCbQuery();
  await upsertUser(ctx.from);
  const { rows } = await q(`SELECT * FROM users WHERE telegram_id=$1`, [ctx.from.id]);
  const u = rows[0] || {};
  await ctx.reply(
    `👤 *${mn(ctx.from)}*\n` +
      `${line()}\n` +
      `Matches: ${u.matches_played || 0}\n` +
      `Won: ${u.matches_won || 0}  Lost: ${u.matches_lost || 0}\n` +
      `Runs: ${u.total_runs || 0}  Wickets: ${u.total_wickets || 0}\n` +
      `Best: ${u.highest_score || 0}`,
    { parse_mode: 'Markdown' }
  );
});
bot.action('m:lb', async (ctx) => {
  await ctx.answerCbQuery();
  const { rows } = await q(
    `SELECT username, first_name, matches_won, matches_played, total_runs
     FROM users WHERE matches_played>0 ORDER BY matches_won DESC, total_runs DESC LIMIT 10`
  );
  if (!rows.length) return ctx.reply('🏆 No matches played yet');
  let t = `🏆 *LEADERBOARD*\n${line()}\n`;
  rows.forEach((r, i) => {
    const n = r.username ? `@${r.username}` : r.first_name || '?';
    t += `${i + 1}. ${mdEsc(n)} — ${r.matches_won}W · ${r.total_runs} runs\n`;
  });
  await ctx.reply(t, { parse_mode: 'Markdown' });
});

// ─── Cards: host banner + final stats image ──────────────

// Card problems are reported once in a while to the owner/admin so they can be fixed quickly
let lastCardReport = 0;
async function reportCardError(what, err) {
  console.error(`${what} failed:`, err && err.stack ? err.stack : err);
  try {
    const owner = Number(String(process.env.BOT_OWNER_ID || (process.env.ADMIN_IDS || '').split(',')[0] || '').trim());
    if (owner && Date.now() - lastCardReport > 30 * 60 * 1000) {
      lastCardReport = Date.now();
      await bot.telegram.sendMessage(owner, `⚠️ ${what} failed:\n${String(err && err.message ? err.message : err).slice(0, 600)}`);
    }
  } catch (_) {}
}

// Host banner (host DP + username) with a caption; falls back to plain text
async function sendHostBanner(ctx, caption, extra = {}) {
  let lastErr = null;
  try {
    ctx.telegram.sendChatAction(ctx.chat.id, 'upload_photo').catch(() => {});
  } catch (_) {}
  for (const useDp of [true, false]) {
    try {
      const dp = useDp ? await getUserDp(ctx.telegram, ctx.from.id) : null;
      const img = await renderHostCard({
        dp,
        username: ctx.from.username,
        firstName: ctx.from.first_name,
      });
      return await ctx.telegram.sendPhoto(
        ctx.chat.id,
        { source: img },
        { caption, parse_mode: 'Markdown', ...extra }
      );
    } catch (e) {
      lastErr = e;
      console.error(`host banner attempt failed (dp=${useDp}):`, e.message);
    }
  }
  await reportCardError('Host banner', lastErr);
  return ctx.telegram.sendMessage(ctx.chat.id, caption, { parse_mode: 'Markdown', ...extra });
}

// /testcard (admin) — shows the real error if the host banner cannot be made
bot.command('testcard', async (ctx) => {
  if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Admin only.');
  try {
    const dp = await getUserDp(ctx.telegram, ctx.from.id);
    const img = await renderHostCard({ dp, username: ctx.from.username, firstName: ctx.from.first_name });
    await ctx.telegram.sendPhoto(ctx.chat.id, { source: img }, { caption: '✅ Host banner works.' });
  } catch (e) {
    await ctx.reply('❌ Host banner failed:\n' + String((e && e.stack) || e).slice(0, 900));
  }
});

// best batsman of a match (optionally of one team). Most runs, then fewest balls.
async function bestBatter(matchId, label = null) {
  const params = [matchId];
  let cond = '';
  if (label) {
    params.push(label);
    cond = 'AND mp.team_label=$2';
  }
  const { rows } = await q(
    `SELECT mp.telegram_id, mp.username, mp.first_name,
            SUM(bs.runs)::int AS runs, SUM(bs.balls_faced)::int AS balls
       FROM batting_stats bs
       JOIN innings i ON i.id = bs.innings_id
       JOIN match_players mp ON mp.id = bs.player_id
      WHERE i.match_id=$1 ${cond}
      GROUP BY mp.id, mp.telegram_id, mp.username, mp.first_name
     HAVING SUM(bs.balls_faced) > 0
      ORDER BY runs DESC, balls ASC
      LIMIT 1`,
    params
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, sr: r.balls > 0 ? (r.runs * 100) / r.balls : 0 };
}

// best bowler of a match (optionally of one team). Most wickets, then best economy.
async function bestBowler(matchId, label = null) {
  const params = [matchId];
  let cond = '';
  if (label) {
    params.push(label);
    cond = 'AND mp.team_label=$2';
  }
  const { rows } = await q(
    `SELECT mp.telegram_id, mp.username, mp.first_name,
            SUM(bw.wickets)::int AS wkts, SUM(bw.balls_bowled)::int AS balls,
            SUM(bw.runs_conceded)::int AS conceded
       FROM bowling_stats bw
       JOIN innings i ON i.id = bw.innings_id
       JOIN match_players mp ON mp.id = bw.player_id
      WHERE i.match_id=$1 ${cond}
      GROUP BY mp.id, mp.telegram_id, mp.username, mp.first_name
     HAVING SUM(bw.balls_bowled) > 0
      ORDER BY wkts DESC, (SUM(bw.runs_conceded)::float / SUM(bw.balls_bowled)) ASC
      LIMIT 1`,
    params
  );
  const r = rows[0];
  if (!r) return null;
  return { ...r, eco: r.balls > 0 ? (r.conceded * 6) / r.balls : 0 };
}

const cardName = (r) => (r ? r.username || r.first_name || 'Player' : '');

function performersText(title, bat, bowl) {
  let t = `*${title}*\n`;
  t += bat
    ? `🏏 Best Batsman: ${mdEsc(name(bat))} — ${bat.runs} (${bat.balls}) · SR ${bat.sr.toFixed(2)}\n`
    : `🏏 Best Batsman: —\n`;
  t += bowl
    ? `🎳 Best Bowler: ${mdEsc(name(bowl))} — ${bowl.wkts} wkts · ${bowl.balls} balls · Eco ${bowl.eco.toFixed(2)}\n`
    : `🎳 Best Bowler: —\n`;
  return t;
}

// Orange Cap (most runs), Purple Cap (most wickets) and MOTM of a match
async function matchAwards(matchId, winnerLabel = null) {
  const { rows } = await q(
    `SELECT mp.telegram_id, mp.username, mp.first_name, mp.team_label,
            COALESCE(b.runs,0) AS runs, COALESCE(b.balls,0) AS balls,
            COALESCE(w.wkts,0) AS wkts, COALESCE(w.bballs,0) AS bballs, COALESCE(w.conceded,0) AS conceded
       FROM match_players mp
       LEFT JOIN (SELECT bs.player_id, SUM(bs.runs)::int AS runs, SUM(bs.balls_faced)::int AS balls
                    FROM batting_stats bs JOIN innings i ON i.id = bs.innings_id
                   WHERE i.match_id=$1 GROUP BY bs.player_id) b ON b.player_id = mp.id
       LEFT JOIN (SELECT bw.player_id, SUM(bw.wickets)::int AS wkts, SUM(bw.balls_bowled)::int AS bballs,
                         SUM(bw.runs_conceded)::int AS conceded
                    FROM bowling_stats bw JOIN innings i ON i.id = bw.innings_id
                   WHERE i.match_id=$1 GROUP BY bw.player_id) w ON w.player_id = mp.id
      WHERE mp.match_id=$1`,
    [matchId]
  );
  const pl = rows.map((r) => ({
    ...r,
    runs: Number(r.runs),
    balls: Number(r.balls),
    wkts: Number(r.wkts),
    bballs: Number(r.bballs),
    conceded: Number(r.conceded),
    eco: Number(r.bballs) > 0 ? (Number(r.conceded) * 6) / Number(r.bballs) : 99,
  }));
  const orange = pl
    .filter((p) => p.balls > 0)
    .sort((a, b) => b.runs - a.runs || a.balls - b.balls)[0] || null;
  const purple = pl
    .filter((p) => p.wkts > 0)
    .sort((a, b) => b.wkts - a.wkts || a.eco - b.eco)[0] || null;
  // MOTM: best all-round impact (runs + 20 per wicket); in team games it comes from the winning side
  let pool = pl.filter((p) => p.balls > 0 || p.bballs > 0);
  if (winnerLabel && winnerLabel !== 'tie') {
    const w = pool.filter((p) => p.team_label === winnerLabel);
    if (w.length) pool = w;
  }
  const motm =
    pool.sort((a, b) => b.runs + 20 * b.wkts - (a.runs + 20 * a.wkts) || b.wkts - a.wkts || a.balls - b.balls)[0] ||
    null;
  return { orange, purple, motm };
}

const tagOf = (p) => `[${mdEsc(name(p))}](tg://user?id=${Number(p.telegram_id)})`;

function awardsText(aw) {
  const o = aw.orange
    ? `🟠 *Orange Cap:* ${tagOf(aw.orange)} — ${aw.orange.runs} (${aw.orange.balls})`
    : `🟠 *Orange Cap:* —`;
  const p = aw.purple
    ? `🟣 *Purple Cap:* ${tagOf(aw.purple)} — ${aw.purple.wkts} wkt${aw.purple.wkts === 1 ? '' : 's'}`
    : `🟣 *Purple Cap:* —`;
  const m = aw.motm
    ? `🏅 *MOTM:* ${tagOf(aw.motm)} — ${aw.motm.runs} run${aw.motm.runs === 1 ? '' : 's'}${aw.motm.wkts ? ' · ' + aw.motm.wkts + ' wkt' + (aw.motm.wkts === 1 ? '' : 's') : ''}`
    : `🏅 *MOTM:* —`;
  return `${o}\n${p}\n${m}`;
}

// Final result image + caption (team: Team A / Team B best performers)
async function sendTeamFinal(telegram, groupId, m, caption) {
  const [batA, bowlA, batB, bowlB] = await Promise.all([
    bestBatter(m.id, 'A'),
    bestBowler(m.id, 'A'),
    bestBatter(m.id, 'B'),
    bestBowler(m.id, 'B'),
  ]);
  try {
    const dps = await Promise.all(
      [batA, bowlA, batB, bowlB].map((p) => (p ? getUserDp(telegram, p.telegram_id) : null))
    );
    const mk = (p, dp, bat) =>
      p
        ? bat
          ? { dp, name: cardName(p), runs: p.runs, balls: p.balls, sr: p.sr }
          : { dp, name: cardName(p), wkts: p.wkts, balls: p.balls, eco: p.eco }
        : null;
    const img = await renderTeamFinalCard({
      A: { bat: mk(batA, dps[0], true), bowl: mk(bowlA, dps[1], false) },
      B: { bat: mk(batB, dps[2], true), bowl: mk(bowlB, dps[3], false) },
    });
    await telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'Markdown' });
  } catch (e) {
    console.error('team final card failed:', e.message);
    await telegram.sendMessage(
      groupId,
      caption + '\n\n' + performersText('TEAM A', batA, bowlA) + '\n' + performersText('TEAM B', batB, bowlB),
      { parse_mode: 'Markdown' }
    );
  }
}

// Final result image + caption (solo: best batsman + best bowler overall)
async function sendSoloFinal(telegram, groupId, m, caption, bat, bowl) {
  try {
    const [dpB, dpW] = await Promise.all([
      bat ? getUserDp(telegram, bat.telegram_id) : null,
      bowl ? getUserDp(telegram, bowl.telegram_id) : null,
    ]);
    const img = await renderSoloFinalCard({
      bat: bat ? { dp: dpB, name: cardName(bat), runs: bat.runs, balls: bat.balls, sr: bat.sr } : null,
      bowl: bowl ? { dp: dpW, name: cardName(bowl), wkts: bowl.wkts, balls: bowl.balls, eco: bowl.eco } : null,
    });
    await telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'Markdown' });
  } catch (e) {
    console.error('solo final card failed:', e.message);
    await telegram.sendMessage(groupId, caption + '\n\n' + performersText('SOLO', bat, bowl), {
      parse_mode: 'Markdown',
    });
  }
}

// ─── Solo: start match from lobby (single innings, unlimited overs) ─────
async function beginSoloFromLobby(matchId, chatId, telegram) {
  clearLobby(matchId);
  const m = await getMatch(matchId);
  if (!m || m.status !== 'waiting' || m.mode !== 'solo') return;

  // All solo players on team A, ordered by join number
  const players = await getPlayers(matchId, 'A');
  if (players.length < 2) {
    await telegram.sendMessage(
      chatId,
      `⏰ *Lobby time is up!*\nPlayers: ${players.length}\nMatch cancelled. Try /startsolo again.`,
      { parse_mode: 'Markdown' }
    );
    await q(`UPDATE matches SET status='cancelled' WHERE id=$1`, [matchId]);
    return;
  }

  // Claim the start atomically (timer and /forcestart can race)
  const claim = await q(
    `UPDATE matches SET
       status='innings1', current_innings=1,
       batting_first_team='A', current_batting_team='A', current_bowling_team='A',
       toss_winner_team='A'
     WHERE id=$1 AND status='waiting' RETURNING id`,
    [matchId]
  );
  if (!claim.rowCount) return;

  await q(
    `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state)
     VALUES ($1,1,'A','A','idle')`,
    [matchId]
  );

  let inn = await getInnings(matchId);
  inn = await soloAutoSetup(m, inn);
  const batter = await getPlayer(inn.striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);

  let list = `👥 Players (${players.length}):\n`;
  players.forEach((p, i) => {
    list += `  *#${i + 1}* ${mn(p)}\n`;
  });

  await telegram.sendMessage(
    chatId,
    `⚡ *SOLO CRICKET BEGINS!*\n` +
      `${line('═')}\n` +
      list +
      `\n🏏 First Batter: *${mn(batter)}*  (#1)\n` +
      `🎳 First Bowler: *${mn(bowler)}*  (#2)\n\n` +
      `♾ Unlimited overs — every player bats until OUT\n` +
      `🎯 Same number = OUT\n` +
      `📩 The bowler sends a number in the bot's DM first, then *${mn(batter)}* types *1–6* in the group!`,
    { parse_mode: 'Markdown' }
  );
  await telegram.sendMessage(chatId, await scoreboard(matchId), {
    parse_mode: 'Markdown',
  });
  await ensureTurnClock(matchId);
}

function startLobbyTimer(matchId, chatId, hostId, telegram, seconds = LOBBY_SECONDS) {
  clearLobby(matchId);
  const endsAt = Date.now() + seconds * 1000;

  const timer = setTimeout(() => {
    beginSoloFromLobby(matchId, chatId, telegram).catch(console.error);
  }, seconds * 1000);

  // Mid reminders
  const tick = setInterval(async () => {
    const left = Math.ceil((endsAt - Date.now()) / 1000);
    if (left <= 0) {
      clearInterval(tick);
      return;
    }
    if (left === 30 || left === 10) {
      try {
        const pl = await getPlayers(matchId);
        await telegram.sendMessage(
          chatId,
          `⏳ *${left}s* left to join!\n👥 Players: *${pl.length}*\nHost: /forcestart`,
          { parse_mode: 'Markdown' }
        );
      } catch (_) {}
    }
  }, 1000);

  lobbies.set(matchId, { timer, tick, endsAt, chatId, hostId });
}

// ─── SOLO ────────────────────────────────────────────────
async function createSoloLobby(ctx) {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  try {
    if (await getActiveMatch(ctx.chat.id))
      return ctx.reply('⚠️ A match is already running here. Host: /endmatch to cancel it first.');

    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'solo',$3,$4,$5,$6,'waiting') RETURNING *`,
      [
        ctx.chat.id,
        ctx.chat.title || null,
        ctx.from.id,
        MAX_SOLO_PLAYERS,
        DEFAULT_OVERS,
        MAX_BOWLER_OVERS,
      ]
    );
    const m = rows[0];
    for (const L of ['A', 'B']) {
      await q(`INSERT INTO match_teams (match_id, team_label) VALUES ($1,$2)`, [m.id, L]);
    }
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, is_captain)
       VALUES ($1,$2,'A',1,$3,$4,TRUE)`,
      [m.id, ctx.from.id, ctx.from.username || null, ctx.from.first_name || null]
    );
    await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label='A'`, [
      m.id,
      ctx.from.id,
    ]);
    await upsertUser(ctx.from);

    startLobbyTimer(m.id, ctx.chat.id, ctx.from.id, ctx.telegram, LOBBY_SECONDS);

    await sendHostBanner(
      ctx,
      `╔══ 🎮 SOLO MODE ══╗\n\n` +
        `👑 Host: *${mn(ctx.from)}*\n` +
        `👥 Players: *1*  ·  max ${MAX_SOLO_PLAYERS}\n` +
        `⏱ Lobby: *${LOBBY_SECONDS}s*\n` +
        `♾ Unlimited overs — everyone bats until OUT\n` +
        `🎯 Same number = OUT\n\n` +
        `📢 /joinsolo — join (#1 bats, #2 bowls…)\n` +
        `🚪 /leavesolo — leave\n` +
        `📋 /team — player list\n\n` +
        `⚡ Host:\n` +
        `• /forcestart — start (min 2)\n` +
        `• /extend30 — +30s\n` +
        `• /endmatch — cancel`,
      Markup.inlineKeyboard([[Markup.button.callback('➕ Join Solo', 'js')]])
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command(['startsolo', 'solo'], createSoloLobby);

async function joinSolo(ctx) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting')
      return ctx.reply('❌ There is no open solo lobby');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('❌ You already joined');

    const pl = await getPlayers(m.id, 'A');
    if (pl.length >= MAX_SOLO_PLAYERS)
      return ctx.reply(`❌ Lobby full (${MAX_SOLO_PLAYERS}/${MAX_SOLO_PLAYERS})`);

    // Join order number = roster position on team A
    const pos = pl.length + 1;
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, is_captain)
       VALUES ($1,$2,'A',$3,$4,$5,FALSE)`,
      [m.id, ctx.from.id, pos, ctx.from.username || null, ctx.from.first_name || null]
    );

    await upsertUser(ctx.from);
    const total = pos;
    const left = lobbies.has(m.id)
      ? Math.max(0, Math.ceil((lobbies.get(m.id).endsAt - Date.now()) / 1000))
      : 0;

    let role = '';
    if (pos === 1) role = ' → 🏏 first bat';
    else if (pos === 2) role = ' → 🎳 first bowl';
    else role = ` → #${pos} in queue`;

    await ctx.reply(
      `✅ *${mn(ctx.from)}* joined as *#${pos}*${role}\n` +
        `👥 Players: *${total}*\n` +
        (left ? `⏳ Lobby: ${left}s left\n` : '') +
        (total >= 2
          ? `\n⚡ Host: /startgame or wait for the timer`
          : `\n⏳ At least 2 players are needed`),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command('joinsolo', joinSolo);
bot.action('js', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return joinSolo(ctx);
});

bot.command('leavesolo', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting') return ctx.reply('❌ No open lobby');
    if (Number(m.host_telegram_id) === ctx.from.id)
      return ctx.reply('❌ The host cannot leave — use /endmatch');
    const p = await getPlayerByTg(m.id, ctx.from.id);
    if (!p) return ctx.reply('❌ You are not in the lobby');
    await q(`DELETE FROM match_players WHERE match_id=$1 AND telegram_id=$2`, [
      m.id,
      ctx.from.id,
    ]);
    // keep join numbers continuous (#1, #2, #3 …)
    const rest = await getPlayers(m.id, 'A');
    for (let i = 0; i < rest.length; i++) {
      if (rest[i].roster_position !== i + 1) {
        await q(`UPDATE match_players SET roster_position=$2 WHERE id=$1`, [rest[i].id, i + 1]);
      }
    }
    await ctx.reply(`👋 ${mn(ctx.from)} left.\n👥 Players: *${rest.length}*`, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

async function forceStartSolo(ctx, m) {
  const pl = await getPlayers(m.id);
  if (pl.length < 2)
    return ctx.reply(`❌ At least 2 players are needed (now ${pl.length}/2)`);

  await ctx.reply(`⚡ *Starting with ${pl.length} players!*`, {
    parse_mode: 'Markdown',
  });
  await beginSoloFromLobby(m.id, ctx.chat.id, ctx.telegram);
}

bot.command('forcestart', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting')
      return ctx.reply('❌ No open solo lobby (or it already started)');
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can do this');
    await forceStartSolo(ctx, m);
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('extend30', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting')
      return ctx.reply('❌ No open solo lobby');
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can do this');

    const L = lobbies.get(m.id);
    if (!L) return ctx.reply('❌ Lobby timer not found');

    const extra = 30;
    const newLeft = Math.ceil((L.endsAt - Date.now()) / 1000) + extra;
    startLobbyTimer(m.id, ctx.chat.id, ctx.from.id, ctx.telegram, newLeft);

    await ctx.reply(`⏱️ Lobby *+${extra}s* — about *${newLeft}s* left`, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

// ─── TEAM ────────────────────────────────────────────────
// /team (no match running) or /startteam [maxTeamSize] → team lobby with host banner
async function createTeamMatch(ctx) {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  try {
    if (await getActiveMatch(ctx.chat.id))
      return ctx.reply('⚠️ A match is already running here. Host: /endmatch to cancel it first.');
    const parts = String(ctx.message?.text || '').split(/\s+/).slice(1);
    let size = parseInt(parts[0], 10);
    if (!size || size < MIN_TEAM_PLAYERS) size = DEFAULT_TEAM_SIZE;
    size = Math.min(size, DEFAULT_TEAM_SIZE);

    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'team',$3,$4,$5,$6,'waiting') RETURNING *`,
      [
        ctx.chat.id,
        ctx.chat.title || null,
        ctx.from.id,
        size,
        DEFAULT_OVERS,
        MAX_BOWLER_OVERS,
      ]
    );
    const m = rows[0];
    for (const L of ['A', 'B']) {
      await q(`INSERT INTO match_teams (match_id, team_label) VALUES ($1,$2)`, [m.id, L]);
    }
    await upsertUser(ctx.from);
    startIdleWatch(m.id);

    await sendHostBanner(
      ctx,
      `╔══ 👥 TEAM MATCH ══╗\n\n` +
        `👑 Host: *${mn(ctx.from)}*\n` +
        `👤 Players: *unlimited* per team\n` +
        `⏱ Overs: the host picks them later with /setovers\n\n` +
        `Join:\n` +
        `• /join_a — Team A\n` +
        `• /join_b — Team B\n\n` +
        `Host:\n` +
        `• /startgame — captains → toss → play\n` +
        `• /team — see the teams\n` +
        `• /endmatch — cancel`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback('➕ Join Team A', 'jt:A'),
          Markup.button.callback('➕ Join Team B', 'jt:B'),
        ],
      ])
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}

bot.command('startteam', createTeamMatch);

async function joinTeam(ctx, label) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.status !== 'waiting' || m.mode === 'solo')
      return ctx.reply('❌ There is no team lobby open. Use /team to create one.');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('❌ You are already in a team');
    const team = await getPlayers(m.id, label);
    if (team.length >= m.team_size) return ctx.reply(`❌ Team ${label} is full`);

    const { rows } = await q(
      `SELECT COALESCE(MAX(roster_position),0)+1 AS n FROM match_players WHERE match_id=$1 AND team_label=$2`,
      [m.id, label]
    );
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [m.id, ctx.from.id, label, rows[0].n, ctx.from.username || null, ctx.from.first_name || null]
    );
    await upsertUser(ctx.from);

    await ctx.reply(
      `✅ ${mn(ctx.from)} → *Team ${label}*  (#${rows[0].n})\n` +
        `👥 Team ${label}: ${team.length + 1} player${team.length + 1 === 1 ? '' : 's'}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command('join_a', (ctx) => joinTeam(ctx, 'A'));
bot.command('join_b', (ctx) => joinTeam(ctx, 'B'));
bot.action(/^jt:(A|B)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return joinTeam(ctx, ctx.match[1]);
});

// Host override: /setcaptain_a <number>  (the normal way is the captain buttons after /startgame)
bot.command('setcaptain_a', async (ctx) => setCap(ctx, 'A'));
bot.command('setcaptain_b', async (ctx) => setCap(ctx, 'B'));

async function setCap(ctx, label) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can do this');
    if (m.mode === 'solo') return ctx.reply('ℹ️ Solo has no captains');
    if (!['waiting', 'captains'].includes(m.status)) return ctx.reply('⚠️ Captains can only be changed before the toss');
    const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
    if (!pos) return ctx.reply(`Usage: /setcaptain_${label.toLowerCase()} <player number>`);
    const p = await getPlayerByPos(m.id, label, pos);
    if (!p) return ctx.reply('❌ Player not found');
    await q(`UPDATE match_players SET is_captain=FALSE WHERE match_id=$1 AND team_label=$2`, [
      m.id,
      label,
    ]);
    await q(`UPDATE match_players SET is_captain=TRUE WHERE id=$1`, [p.id]);
    await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label=$3`, [
      m.id,
      p.telegram_id,
      label,
    ]);
    await ctx.reply(`👑 Team ${label} captain: *${mn(p)}*`, { parse_mode: 'Markdown' });
    if (m.status === 'captains') await tryBeginToss(ctx.telegram, m.id);
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
}

// /team → create a lobby when nothing is running, otherwise show the teams / players
bot.command('team', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return createTeamMatch(ctx);
  if (m.mode !== 'solo' && ['innings1', 'innings2'].includes(m.status)) {
    return sendLong(ctx.telegram, ctx.chat.id, await rosterText(m));
  }
  let t = `🏏 *${m.mode.toUpperCase()}* · ${m.status}\n${line()}\n`;
  for (const L of ['A', 'B']) {
    const team = await getTeam(m.id, L);
    const pl = await getPlayers(m.id, L);
    if (m.mode === 'solo' && L === 'B') continue;
    t += `\n*${m.mode === 'solo' ? 'Players' : 'Team ' + L}* (${pl.length})\n`;
    for (const p of pl) {
      const star =
        m.mode !== 'solo' && Number(p.telegram_id) === Number(team?.captain_id) ? ' 👑' : '';
      t += `  ${p.roster_position}. ${mn(p)}${star}\n`;
    }
    if (!pl.length) t += `  (empty)\n`;
  }
  await ctx.reply(t, { parse_mode: 'Markdown' });
});

bot.command('endmatch', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('❌ No active match');
  if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can do this');
  clearLobby(m.id);
  stopIdleWatch(m.id);
  clearTurnClock(m.id);
  clearWarns(m.id);
  endVote(m.id);
  await q(`UPDATE matches SET status='cancelled' WHERE id=$1`, [m.id]);
  await ctx.reply('🛑 Match / lobby cancelled');
});

// ─── /startgame : captains → toss ────────────────────────
async function captainPromptText(m) {
  const tA = await getTeam(m.id, 'A');
  const tB = await getTeam(m.id, 'B');
  const pa = tA?.captain_id ? await getPlayerByTg(m.id, tA.captain_id) : null;
  const pb = tB?.captain_id ? await getPlayerByTg(m.id, tB.captain_id) : null;
  return {
    needA: !tA?.captain_id,
    needB: !tB?.captain_id,
    text:
      `👑 *CHOOSE YOUR CAPTAINS*\n${line()}\n` +
      `Team A: ${pa ? '👑 *' + mn(pa) + '*' : '⏳ waiting…'}\n` +
      `Team B: ${pb ? '👑 *' + mn(pb) + '*' : '⏳ waiting…'}\n\n` +
      `A player of each team taps their team's button to become its captain.`,
  };
}

async function startGame(ctx) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply('❌ No active match. Use /team or /startsolo first.');
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can start the game');
    if (m.status !== 'waiting') return ctx.reply('⚠️ The game has already started');

    if (m.mode === 'solo') return forceStartSolo(ctx, m);

    const a = await getPlayers(m.id, 'A');
    const b = await getPlayers(m.id, 'B');
    if (a.length < MIN_TEAM_PLAYERS || b.length < MIN_TEAM_PLAYERS)
      return ctx.reply(
        `❌ Each team needs at least ${MIN_TEAM_PLAYERS} players (Team A: ${a.length}, Team B: ${b.length})`
      );

    const claim = await q(
      `UPDATE matches SET status='captains' WHERE id=$1 AND status='waiting' RETURNING id`,
      [m.id]
    );
    if (!claim.rowCount) return;

    const info = await captainPromptText(m);
    if (!info.needA && !info.needB) return tryBeginToss(ctx.telegram, m.id);
    await ctx.reply(info.text, {
      parse_mode: 'Markdown',
      ...captainKb(m.id, info.needA, info.needB),
    });
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command(['startgame', 'startmatch'], startGame);

bot.action(/^cap:(.+):(A|B)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const label = ctx.match[2];
  try {
    const m = await getMatch(matchId);
    if (!m || m.status !== 'captains')
      return ctx.answerCbQuery('Captain selection is not active', { show_alert: true });

    const p = await getPlayerByTg(m.id, ctx.from.id);
    if (!p || p.team_label !== label)
      return ctx.answerCbQuery(`Only Team ${label} players can become its captain`, { show_alert: true });

    const upd = await q(
      `UPDATE match_teams SET captain_id=$3 WHERE match_id=$1 AND team_label=$2 AND captain_id IS NULL RETURNING *`,
      [m.id, label, ctx.from.id]
    );
    if (!upd.rowCount)
      return ctx.answerCbQuery('This team already has a captain', { show_alert: true });

    await q(`UPDATE match_players SET is_captain=(telegram_id=$3) WHERE match_id=$1 AND team_label=$2`, [
      m.id,
      label,
      ctx.from.id,
    ]);
    await ctx.answerCbQuery(`You are the captain of Team ${label}!`);

    const info = await captainPromptText(m);
    try {
      if (info.needA || info.needB) {
        await ctx.editMessageText(info.text, {
          parse_mode: 'Markdown',
          ...captainKb(m.id, info.needA, info.needB),
        });
      } else {
        await ctx.editMessageText(info.text, { parse_mode: 'Markdown' });
      }
    } catch (_) {}

    if (!info.needA && !info.needB) await tryBeginToss(ctx.telegram, m.id);
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery('Error', { show_alert: true }).catch(() => {});
  }
});

// Both captains known → coin toss
async function tryBeginToss(telegram, matchId) {
  const m = await getMatch(matchId);
  if (!m || m.status !== 'captains') return false;
  const tA = await getTeam(matchId, 'A');
  const tB = await getTeam(matchId, 'B');
  if (!tA?.captain_id || !tB?.captain_id) return false;

  const winner = Math.random() < 0.5 ? 'A' : 'B';
  const upd = await q(
    `UPDATE matches SET status='toss', toss_winner_team=$2 WHERE id=$1 AND status='captains' RETURNING id`,
    [matchId, winner]
  );
  if (!upd.rowCount) return false;

  const capA = await getPlayerByTg(matchId, tA.captain_id);
  const capB = await getPlayerByTg(matchId, tB.captain_id);
  const winCap = winner === 'A' ? capA : capB;
  await telegram.sendMessage(
    Number(m.group_chat_id),
    `🪙 *TOSS*\n${line()}\n` +
      `👑 Team A: ${mn(capA)}\n` +
      `👑 Team B: ${mn(capB)}\n\n` +
      `🏆 Team *${winner}* wins the toss!\n` +
      `${mn(winCap)}, choose:`,
    { parse_mode: 'Markdown', ...tossKb(m.id) }
  );
  return true;
}

// ─── Toss choice → then host picks overs ─────────────────
bot.action(/^toss:(.+):(bat|bowl)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const choice = ctx.match[2];
  try {
    const m = await getMatch(matchId);
    if (!m || m.status !== 'toss' || m.setup_phase === 'overs')
      return ctx.answerCbQuery('This toss is not active', { show_alert: true });

    const team = await getTeam(m.id, m.toss_winner_team);
    if (Number(team?.captain_id) !== ctx.from.id)
      return ctx.answerCbQuery('Only the captain of the toss-winning team can choose', { show_alert: true });

    const batFirst =
      choice === 'bat' ? m.toss_winner_team : m.toss_winner_team === 'A' ? 'B' : 'A';
    const bowlFirst = batFirst === 'A' ? 'B' : 'A';

    // Overs are not set yet — innings are created after the host picks them
    const upd = await q(
      `UPDATE matches SET batting_first_team=$2, current_batting_team=$2,
         current_bowling_team=$3, setup_phase='overs'
       WHERE id=$1 AND status='toss' AND setup_phase IS DISTINCT FROM 'overs' RETURNING id`,
      [m.id, batFirst, bowlFirst]
    );
    if (!upd.rowCount) return ctx.answerCbQuery('Already chosen', { show_alert: true });

    await ctx.editMessageText(
      `✅ Team ${m.toss_winner_team} chose *${choice.toUpperCase()}* first\n\n` +
        `🏏 Batting first: Team *${batFirst}*\n` +
        `🎳 Bowling first: Team *${bowlFirst}*\n\n` +
        `⏱ [Host](tg://user?id=${Number(m.host_telegram_id)}): send /setovers to choose the overs (1–${MAX_OVERS})`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery();
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery(String(e.message).slice(0, 150), { show_alert: true }).catch(() => {});
  }
});

// ─── /setovers (host) → buttons 1..20 ────────────────────
bot.command('setovers', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply('❌ No active match');
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can set the overs');
    if (m.mode === 'solo') return ctx.reply('♾ Solo matches have unlimited overs');
    if (!(m.status === 'toss' && m.setup_phase === 'overs'))
      return ctx.reply('⚠️ You can set the overs right after the toss choice (bat / bowl)');
    await ctx.reply(`⏱ *Choose the total overs* (1–${MAX_OVERS}):`, {
      parse_mode: 'Markdown',
      ...oversKb(m.id),
    });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.action(/^ov:(.+):(\d+)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const overs = Math.max(1, Math.min(MAX_OVERS, parseInt(ctx.match[2], 10)));
  try {
    const m = await getMatch(matchId);
    if (!m || m.status !== 'toss' || m.setup_phase !== 'overs')
      return ctx.answerCbQuery('Overs are already set', { show_alert: true });
    if (Number(m.host_telegram_id) !== ctx.from.id)
      return ctx.answerCbQuery('Only the host can choose the overs', { show_alert: true });

    // per-bowler limit: normally 4 overs, raised if teams are small so the innings can be completed
    const a = await getPlayers(m.id, 'A');
    const b = await getPlayers(m.id, 'B');
    const minSize = Math.max(1, Math.min(a.length, b.length));
    const perBowler = Math.min(overs, Math.max(MAX_BOWLER_OVERS, Math.ceil(overs / minSize)));

    const upd = await q(
      `UPDATE matches SET total_overs=$2, max_overs_per_bowler=$3, status='innings1',
         current_innings=1, setup_phase='live'
       WHERE id=$1 AND status='toss' AND setup_phase='overs' RETURNING *`,
      [m.id, overs, perBowler]
    );
    if (!upd.rowCount) return ctx.answerCbQuery('Overs are already set', { show_alert: true });
    const mm = upd.rows[0];

    await q(
      `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state)
       VALUES ($1,1,$2,$3,'idle')`,
      [m.id, mm.current_batting_team, mm.current_bowling_team]
    );

    await ctx.answerCbQuery(`${overs} overs`);
    try {
      await ctx.editMessageText(`✅ Overs set: *${overs}* (max ${perBowler} per bowler)`, {
        parse_mode: 'Markdown',
      });
    } catch (_) {}

    const groupId = Number(m.group_chat_id);
    await sendMatchBanner(ctx.telegram, groupId, mm, `\n⏱ max ${perBowler} per bowler`);
    await sendLong(ctx.telegram, groupId, await rosterText(mm));
    await ctx.telegram.sendMessage(
      groupId,
      `🏏 *MATCH BEGINS!*\n` +
        `Batting captain (Team ${mm.current_batting_team}): /bat <no.> twice — striker, then non-striker\n` +
        `Bowling captain (Team ${mm.current_bowling_team}): /ball <no.>\n` +
        `Use /team to see the player numbers.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery(String(e.message).slice(0, 150), { show_alert: true }).catch(() => {});
  }
});

// ─── /bat /ball (team; solo is automatic) ────────────────
bot.command('bat', async (ctx) => {
  if (!isGroup(ctx)) return;
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply('Usage: /bat 1');
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status))
      return ctx.reply('❌ No match in progress');
    if (m.mode === 'solo') return ctx.reply('ℹ️ Solo is automatic — just type 1-6');

    let inn = await getInnings(m.id);
    if (!inn || !['idle', 'waiting_bat'].includes(inn.ball_state))
      return ctx.reply('⏳ A ball is pending');
    const team = await getTeam(m.id, inn.batting_team);
    if (Number(team?.captain_id) !== ctx.from.id) return ctx.reply('❌ Only the batting captain can do this');

    const p = await getPlayerByPos(m.id, inn.batting_team, pos);
    if (!p) return ctx.reply('❌ Invalid player number');
    const { rows: st } = await q(
      `SELECT * FROM batting_stats WHERE innings_id=$1 AND player_id=$2`,
      [inn.id, p.id]
    );
    if (st[0]?.is_out) return ctx.reply('❌ That player is already out');
    if (p.id === inn.striker_player_id || p.id === inn.non_striker_player_id)
      return ctx.reply('❌ That player is already batting');

    await q(
      `INSERT INTO batting_stats (innings_id, player_id) VALUES ($1,$2)
       ON CONFLICT (innings_id, player_id) DO NOTHING`,
      [inn.id, p.id]
    );

    let role;
    if (!inn.striker_player_id) {
      await q(`UPDATE innings SET striker_player_id=$2 WHERE id=$1`, [inn.id, p.id]);
      role = 'striker';
    } else if (!inn.non_striker_player_id) {
      await q(`UPDATE innings SET non_striker_player_id=$2 WHERE id=$1`, [inn.id, p.id]);
      role = 'non-striker';
    } else {
      await q(`UPDATE innings SET striker_player_id=$2 WHERE id=$1`, [inn.id, p.id]);
      role = 'striker';
    }

    await ctx.reply(`🏏 ${mn(p)} → *${role}*`, { parse_mode: 'Markdown' });
    await sendResultGif(ctx.telegram, ctx.chat.id, 'batentry', undefined, newBatsmanCaption(p));
    inn = await getInnings(m.id);
    if (inn.striker_player_id && inn.non_striker_player_id && !inn.current_bowler_id) {
      await ctx.reply('Bowling captain: /ball <no.>');
    }
    await ctx.reply(await scoreboard(m.id), { parse_mode: 'Markdown' });
    await ensureTurnClock(m.id);
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command(['ball', 'bowling'], async (ctx) => {
  if (!isGroup(ctx)) return;
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply('Usage: /ball 1');
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status))
      return ctx.reply('❌ No match in progress');
    if (m.mode === 'solo') return ctx.reply('ℹ️ Solo has an automatic bowler');

    const inn = await getInnings(m.id);
    if (!inn || inn.ball_state !== 'idle') return ctx.reply('⏳ Please wait');
    if (!inn.striker_player_id || !inn.non_striker_player_id)
      return ctx.reply('❌ First pick 2 batsmen with /bat');

    const team = await getTeam(m.id, inn.bowling_team);
    if (Number(team?.captain_id) !== ctx.from.id) return ctx.reply('❌ Only the bowling captain can do this');

    const p = await getPlayerByPos(m.id, inn.bowling_team, pos);
    if (!p) return ctx.reply('❌ Invalid player number');
    const { rows: st } = await q(
      `SELECT * FROM bowling_stats WHERE innings_id=$1 AND player_id=$2`,
      [inn.id, p.id]
    );
    const bb = st[0]?.balls_bowled || 0;
    if (bb / 6 >= (m.max_overs_per_bowler || MAX_BOWLER_OVERS))
      return ctx.reply('❌ This bowler has completed the maximum overs');
    if (inn.last_bowler_id === p.id && inn.balls_bowled % 6 === 0 && bb > 0)
      return ctx.reply('❌ A bowler cannot bowl consecutive overs');

    await q(
      `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2)
       ON CONFLICT (innings_id, player_id) DO NOTHING`,
      [inn.id, p.id]
    );
    await q(`UPDATE innings SET current_bowler_id=$2 WHERE id=$1`, [inn.id, p.id]);

    await ctx.reply(`🎳 ${mn(p)} is bowling`, { parse_mode: 'Markdown' });
    await sendResultGif(ctx.telegram, ctx.chat.id, 'bowlentry', undefined, newBowlerCaption(p));
    await ctx.reply(await scoreboard(m.id), { parse_mode: 'Markdown' });
    await ensureTurnClock(m.id);
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('score', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('❌ No active match');
  await ctx.reply(await scoreboard(m.id), { parse_mode: 'Markdown' });
});

// ═════════════════ DISCIPLINE: 60s turn clock, penalties, warnings ═════════════════
// Rules
//  • Batsman must type 1-6 within 60s, bowler must pick his number within 60s.
//  • Miss = -6 runs. Team mode: -6 from the player's TEAM score. Solo: -6 from the player's own runs
//    (even if he has no runs yet — his score simply starts from -6).
//  • Bowler warnings: solo → bowling auto-changes after 3, team → captain is tagged after 2 to choose a new bowler.
//  • Batsman: after 3 missed turns he is retired OUT.

const mkey = (id) => String(id);
const warnCounts = new Map(); // `${matchId}:${playerId}:${kind}` -> count
function bumpWarn(matchId, playerId, kind) {
  const k = `${mkey(matchId)}:${playerId}:${kind}`;
  const n = (warnCounts.get(k) || 0) + 1;
  warnCounts.set(k, n);
  return n;
}
function resetWarn(matchId, playerId, kind) {
  warnCounts.delete(`${mkey(matchId)}:${playerId}:${kind}`);
}
function clearWarns(matchId) {
  const prefix = `${mkey(matchId)}:`;
  for (const k of [...warnCounts.keys()]) if (k.startsWith(prefix)) warnCounts.delete(k);
}

// Markdown mention that pings the player
const mtag = (p) => `[${mdEsc(name(p))}](tg://user?id=${Number(p.telegram_id ?? p.id)})`;

// GIF captions for the extra GIF events (/pgif batentry | bowlentry | dugout | stance | runup)
const newBowlerCaption = (p) => `🎳 <b>NEW BOWLER</b>\n🎙️ ${escapeHtml(name(p))} takes the ball!`;
const newBatsmanCaption = (p) => `🏏 <b>NEW BATSMAN</b>\n🎙️ ${escapeHtml(name(p))} walks in to bat!`;
const stanceCaption = (p) => `🏏 <b>STANCE</b>\n🎙️ ${escapeHtml(name(p))} takes the stance.`;
const runupCaption = (p) => `🎳 <b>RUN-UP</b>\n🎙️ ${escapeHtml(name(p))} runs in to bowl…`;
const dugoutCaption = (p) => `🚶 <b>DUGOUT</b>\n🎙️ ${escapeHtml(name(p))} walks back to the pavilion.`;

// ─── Penalties ───────────────────────────────────────────
// Team penalty: -6 from the team's score (works before the team has batted too)
async function applyTeamPenalty(m, label) {
  const cur = await getInnings(m.id);
  if (cur && cur.batting_team === label) {
    await q(`UPDATE innings SET total_runs=total_runs-$2 WHERE id=$1`, [cur.id, TURN_PENALTY]);
    return;
  }
  const { rows } = await q(
    `SELECT id FROM innings WHERE match_id=$1 AND batting_team=$2 AND is_completed=TRUE ORDER BY innings_number DESC LIMIT 1`,
    [m.id, label]
  );
  if (rows[0]) {
    // this team already batted: its total (and therefore the target) goes down
    await q(`UPDATE innings SET total_runs=total_runs-$2 WHERE id=$1`, [rows[0].id, TURN_PENALTY]);
    await q(`UPDATE matches SET target=target-$2 WHERE id=$1 AND target IS NOT NULL`, [m.id, TURN_PENALTY]);
    return;
  }
  // team has not batted yet: its innings will start from the penalty (e.g. -6)
  await q(
    `UPDATE match_teams SET penalty_runs=COALESCE(penalty_runs,0)-$3 WHERE match_id=$1 AND team_label=$2`,
    [m.id, label, TURN_PENALTY]
  );
}

// Solo penalty: -6 from the player's own runs (row is created at -6 if he has not batted yet)
async function applyPlayerPenalty(inn, player) {
  await q(
    `INSERT INTO batting_stats (innings_id, player_id, runs) VALUES ($1,$2,$3)
     ON CONFLICT (innings_id, player_id) DO UPDATE SET runs=batting_stats.runs-$4`,
    [inn.id, player.id, -TURN_PENALTY, TURN_PENALTY]
  );
  await q(`UPDATE innings SET total_runs=total_runs-$2 WHERE id=$1`, [inn.id, TURN_PENALTY]);
}

// Solo: automatic bowling change (next player in join order who is not the batsman)
async function soloRotateBowler(m, inn) {
  const all = await getPlayers(m.id, 'A');
  const idx = all.findIndex((p) => p.id === inn.current_bowler_id);
  let chosen = null;
  for (let k = 1; k <= all.length; k++) {
    const cand = all[(idx + k + all.length) % all.length];
    if (cand.id !== inn.striker_player_id && cand.id !== inn.current_bowler_id) {
      chosen = cand;
      break;
    }
  }
  if (!chosen) return null;
  await q(
    `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2)
     ON CONFLICT (innings_id, player_id) DO NOTHING`,
    [inn.id, chosen.id]
  );
  await q(`UPDATE innings SET current_bowler_id=$2 WHERE id=$1`, [inn.id, chosen.id]);
  return chosen;
}

// ─── Ball flow + turn clock ──────────────────────────────
// Every ball: 1) the bowler gets a DM and sends his number (1-6) as a message,
//             2) the group is told the number is locked, 3) the batsman types 1-6 in the group.
// ball_state 'waiting_bowl' covers both steps; pending_balls.bowl_number tells which step we are in.
const turnClocks = new Map(); // matchId -> { key, timer }
const lockMsgs = new Map(); // callback_token -> group message id of the "locked" notice

function clearTurnClock(matchId) {
  const c = turnClocks.get(mkey(matchId));
  if (c?.timer) clearTimeout(c.timer);
  turnClocks.delete(mkey(matchId));
}

// t.me link to a message of a group (works for supergroups)
function groupMsgLink(chatId, msgId) {
  const id = String(chatId);
  if (!id.startsWith('-100') || !msgId) return null;
  return `https://t.me/c/${id.slice(4)}/${msgId}`;
}

const openBotDmKb = () =>
  BOT_USERNAME
    ? Markup.inlineKeyboard([[Markup.button.url('🤖 Open bot DM', `https://t.me/${BOT_USERNAME}`)]])
    : {};

// DM to the bowler: "send your number"
async function sendBowlerPrompt(telegram, pend) {
  try {
    const m = await getMatch(pend.match_id);
    const { rows } = await q(`SELECT * FROM innings WHERE id=$1`, [pend.innings_id]);
    const inn = rows[0];
    const striker = inn ? await getPlayer(inn.striker_player_id) : null;
    await telegram.sendMessage(
      Number(pend.bowler_telegram_id),
      `🎳 *YOUR TURN TO BOWL*\n${line()}\n` +
        `📍 ${mdEsc(m?.group_title || 'Group')}\n` +
        `🏏 Batsman: ${striker ? mn(striker) : '—'}\n` +
        `⏱ Over: ${pend.over_number}.${pend.ball_number}\n\n` +
        `Send your number *1–6* as a message within *${TURN_SECONDS}s* (otherwise -${TURN_PENALTY} runs).`,
      { parse_mode: 'Markdown' }
    );
    return true;
  } catch (_) {
    return false;
  }
}

// Start the next ball when everybody is in place (no-op otherwise)
async function startBall(matchId) {
  const m = await getMatch(matchId);
  if (!m || !['innings1', 'innings2'].includes(m.status)) return false;
  const inn = await getInnings(matchId);
  if (!inn || inn.ball_state !== 'idle') return false;
  if (!inn.striker_player_id || !inn.current_bowler_id) return false;
  if (m.mode !== 'solo' && !inn.non_striker_player_id) return false;

  const claim = await q(
    `UPDATE innings SET ball_state='waiting_bowl' WHERE id=$1 AND ball_state='idle' RETURNING id`,
    [inn.id]
  );
  if (!claim.rowCount) return false;

  const tg = bot.telegram;
  const groupId = Number(m.group_chat_id);
  const striker = await getPlayer(inn.striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);
  const overNum = Math.floor(inn.balls_bowled / 6);
  const ballNum = (inn.balls_bowled % 6) + 1;
  const token = crypto.randomBytes(12).toString('base64url');

  await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
  // bat_number is a placeholder (1) until the batsman plays; bowl_number is NULL until the bowler locks
  await q(
    `INSERT INTO pending_balls (match_id, innings_id, bowler_telegram_id, callback_token, bat_number, over_number, ball_number)
     VALUES ($1,$2,$3,$4,1,$5,$6)`,
    [m.id, inn.id, bowler.telegram_id, token, overNum, ballNum]
  );
  const { rows: pr } = await q(`SELECT * FROM pending_balls WHERE callback_token=$1`, [token]);
  const pend = pr[0];

  const dmOk = await sendBowlerPrompt(tg, pend);
  const w = await tg.sendMessage(
    groupId,
    `🎳 ${mtag(bowler)} is bowling to ${mn(striker)}  (Over ${overNum}.${ballNum})\n` +
      (dmOk
        ? `📩 ${mn(bowler)}, check the bot's DM and send your number *1–6* (${TURN_SECONDS}s)`
        : `⚠️ ${mn(bowler)}, open the bot's DM and press /start — then send your number *1–6* (${TURN_SECONDS}s)`),
    { parse_mode: 'Markdown', ...openBotDmKb() }
  );
  await q(`UPDATE pending_balls SET batting_message_id=$2 WHERE callback_token=$1`, [token, w.message_id]);
  await sendResultGif(tg, groupId, 'stance', undefined, stanceCaption(striker));
  return true;
}

// What are we waiting for right now? (null = nobody is on the clock)
async function turnState(matchId) {
  const m = await getMatch(matchId);
  if (!m || !['innings1', 'innings2'].includes(m.status)) return null;
  const inn = await getInnings(matchId);
  if (!inn || inn.ball_state !== 'waiting_bowl') return null;
  const { rows } = await q(`SELECT * FROM pending_balls WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
  const pend = rows[rows.length - 1];
  if (!pend) return { repair: true, m, inn };
  const kind = pend.bowl_number == null ? 'bowl' : 'bat';
  const key = `${kind}:${inn.id}:${inn.balls_bowled}:${pend.callback_token}`;
  return { m, inn, pend, kind, key };
}

// Start the ball if it is time, and (re)arm the 60s clock for whoever is due. Safe to call any time.
async function ensureTurnClock(matchId) {
  try {
    await startBall(matchId);
    let st = await turnState(matchId);
    if (st && st.repair) {
      await q(`UPDATE innings SET ball_state='idle' WHERE id=$1 AND ball_state='waiting_bowl'`, [st.inn.id]);
      await startBall(matchId);
      st = await turnState(matchId);
    }
    if (!st) return clearTurnClock(matchId);
    const cur = turnClocks.get(mkey(matchId));
    if (cur && cur.key === st.key) return; // same turn, keep the running clock
    clearTurnClock(matchId);
    const timer = setTimeout(
      () => onTurnTimeout(matchId, st.key).catch((e) => console.error('turn timeout error:', e)),
      TURN_SECONDS * 1000
    );
    turnClocks.set(mkey(matchId), { key: st.key, timer });
  } catch (e) {
    console.error('ensureTurnClock failed:', e.message);
  }
}

async function onTurnTimeout(matchId, key) {
  const cur = turnClocks.get(mkey(matchId));
  if (!cur || cur.key !== key) return;
  turnClocks.delete(mkey(matchId));
  const st = await turnState(matchId);
  if (!st || st.repair || st.key !== key) return; // something happened in the meantime
  if (st.kind === 'bat') await batTimeout(st);
  else await bowlTimeout(st);
}

// Bowler locked his number but the batsman did not type 1-6 in time
async function batTimeout({ m, inn, pend }) {
  const tg = bot.telegram;
  const groupId = Number(m.group_chat_id);
  const isSolo = m.mode === 'solo';
  const striker = await getPlayer(inn.striker_player_id);
  if (!striker) return;

  const warn = bumpWarn(m.id, striker.id, 'bat');
  if (isSolo) await applyPlayerPenalty(inn, striker);
  else await applyTeamPenalty(m, inn.batting_team);

  const retire = warn >= BAT_RETIRE_LIMIT;
  await tg.sendMessage(
    groupId,
    `⏰ *TIME UP!*\n${mtag(striker)} did not play within ${TURN_SECONDS}s.\n` +
      `💥 Penalty: *-${TURN_PENALTY} runs*${isSolo ? '' : ' for Team ' + inn.batting_team}  (warning ${warn}/${BAT_RETIRE_LIMIT})\n` +
      (retire
        ? `🚪 ${mn(striker)} is retired OUT.`
        : `👉 Type *1–6* now (${TURN_SECONDS}s)`),
    { parse_mode: 'Markdown' }
  );

  if (!retire) return ensureTurnClock(m.id); // same locked bowler number, fresh clock

  resetWarn(m.id, striker.id, 'bat');
  await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
  await q(`UPDATE batting_stats SET is_out=TRUE WHERE innings_id=$1 AND player_id=$2`, [inn.id, striker.id]);
  await q(
    `UPDATE innings SET total_wickets=total_wickets+1, striker_player_id=NULL, ball_state='idle' WHERE id=$1`,
    [inn.id]
  );
  await sendResultGif(tg, groupId, 'dugout', undefined, dugoutCaption(striker));
  const inn2 = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0];
  await progressAfterBall(tg, m, inn2, true);
}

// Bowler did not send his number in time: ball is cancelled, bowler's side loses 6
async function bowlTimeout({ m, inn, pend }) {
  const tg = bot.telegram;
  const groupId = Number(m.group_chat_id);
  const isSolo = m.mode === 'solo';

  // claim the pending ball (if the bowler answered at the same moment, he wins)
  const claim = await q(
    `UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NULL`,
    [pend.callback_token]
  );
  if (!claim.rowCount) return;
  await q(`UPDATE innings SET ball_state='idle' WHERE id=$1 AND ball_state='waiting_bowl'`, [inn.id]);
  await del(groupId, pend.batting_message_id);

  const bowler = await getPlayer(inn.current_bowler_id);
  if (!bowler) return;

  const limit = isSolo ? SOLO_BOWLER_WARN_LIMIT : TEAM_BOWLER_WARN_LIMIT;
  const warn = bumpWarn(m.id, bowler.id, 'bowl');
  if (isSolo) await applyPlayerPenalty(inn, bowler);
  else await applyTeamPenalty(m, inn.bowling_team);

  await tg.sendMessage(
    groupId,
    `⏰ *TIME UP!*\n${mtag(bowler)} did not send a number within ${TURN_SECONDS}s.\n` +
      `💥 Penalty: *-${TURN_PENALTY} runs*${isSolo ? '' : ' for Team ' + inn.bowling_team}  (warning ${warn}/${limit})\n` +
      `🔁 This ball is cancelled.`,
    { parse_mode: 'Markdown' }
  );

  if (warn >= limit) {
    resetWarn(m.id, bowler.id, 'bowl');
    if (isSolo) {
      const nb = await soloRotateBowler(m, inn);
      if (nb) {
        await tg.sendMessage(groupId, `🔄 *BOWLING CHANGE*\n${mtag(nb)} is the new bowler.`, {
          parse_mode: 'Markdown',
        });
        await sendResultGif(tg, groupId, 'bowlentry', undefined, newBowlerCaption(nb));
      }
    } else {
      // team: nobody is bowling until the captain chooses
      await q(`UPDATE innings SET current_bowler_id=NULL WHERE id=$1`, [inn.id]);
      const team = await getTeam(m.id, inn.bowling_team);
      const cap = team?.captain_id ? await getPlayerByTg(m.id, team.captain_id) : null;
      await tg.sendMessage(
        groupId,
        `👑 ${cap ? mtag(cap) : 'Captain'} — ${mn(bowler)} has been warned ${limit} times.\n` +
          `Choose your next bowler: /ball <no.>`,
        { parse_mode: 'Markdown' }
      );
      return;
    }
  }
  await ensureTurnClock(m.id); // new ball: the (new) bowler gets a fresh DM
}

// ═════════════════ HOST WARNINGS (idle lobby / setup) ═════════════════
// While the match is only a lobby / setup (waiting, captains, toss) and nothing moves,
// the host gets a warning every minute. After 10 warnings the game is ended.
const idleWatch = new Map(); // matchId -> { timer, lastKey, warnings }

function stopIdleWatch(matchId) {
  const w = idleWatch.get(mkey(matchId));
  if (w?.timer) clearInterval(w.timer);
  idleWatch.delete(mkey(matchId));
}

function startIdleWatch(matchId, baselineKey = 'waiting||0|0') {
  stopIdleWatch(matchId);
  const w = { timer: null, lastKey: baselineKey, warnings: 0 };
  w.timer = setInterval(
    () => idleTick(matchId).catch((e) => console.error('idleTick error:', e)),
    IDLE_WARN_SECONDS * 1000
  );
  idleWatch.set(mkey(matchId), w);
}

async function idleTick(matchId) {
  const w = idleWatch.get(mkey(matchId));
  if (!w) return;
  const m = await getMatch(matchId);
  if (!m || !['waiting', 'captains', 'toss'].includes(m.status)) return stopIdleWatch(matchId);

  const pl = await getPlayers(m.id);
  const { rows: caps } = await q(
    `SELECT COUNT(*)::int AS n FROM match_teams WHERE match_id=$1 AND captain_id IS NOT NULL`,
    [m.id]
  );
  const key = [m.status, m.setup_phase || '', pl.length, caps[0]?.n || 0].join('|');
  if (key !== w.lastKey) {
    // progress was made → reset the counter
    w.lastKey = key;
    w.warnings = 0;
    return;
  }

  w.warnings += 1;
  const groupId = Number(m.group_chat_id);
  if (w.warnings >= IDLE_WARN_LIMIT) {
    stopIdleWatch(m.id);
    clearLobby(m.id);
    await q(`UPDATE matches SET status='cancelled' WHERE id=$1 AND status IN ('waiting','captains','toss')`, [
      m.id,
    ]);
    await bot.telegram.sendMessage(
      groupId,
      `🛑 *GAME ENDED*\nThe lobby had no activity after ${IDLE_WARN_LIMIT} warnings.\nStart a new one with /team or /startsolo.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  let hint;
  if (m.status === 'waiting') hint = `Players: /join_a or /join_b — then the host starts with /startgame.`;
  else if (m.status === 'captains') hint = `Captains: tap your team's "Captain" button.`;
  else if (m.setup_phase === 'overs') hint = `Host: send /setovers and choose the overs.`;
  else hint = `The captain of the toss-winning team must choose BAT or BOWL.`;

  const { rows } = await q(`SELECT username, first_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
  const hostLabel = rows[0] ? mdEsc(name({ ...rows[0] })) : 'Host';
  await bot.telegram.sendMessage(
    groupId,
    `⚠️ *WARNING ${w.warnings}/${IDLE_WARN_LIMIT}*\n` +
      `[${hostLabel}](tg://user?id=${Number(m.host_telegram_id)}) — the game is not moving.\n${hint}\n` +
      `The game ends automatically after ${IDLE_WARN_LIMIT} warnings.`,
    { parse_mode: 'Markdown' }
  );
}

// ═════════════════ CHANGE HOST (vote) ═════════════════
// /changehost → players vote (3 votes from Team A + 3 from Team B; solo: 3 votes).
// When enough votes are in, the first player who taps "Become Host" is the new host.
const hostVotes = new Map(); // matchId -> { need, votes, phase, timer, chatId, msgId }

async function voteText(m, v) {
  const { rows } = await q(`SELECT username, first_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
  const hostLabel = rows[0] ? mdEsc(name({ ...rows[0] })) : String(m.host_telegram_id);
  if (v.phase === 'claim') {
    return (
      `✅ *VOTE PASSED*\n${line()}\n` +
      `Current host: ${hostLabel}\n\n` +
      `The first player to tap the button becomes the new host!`
    );
  }
  let t = `🗳 *CHANGE HOST — VOTE*\n${line()}\nCurrent host: ${hostLabel}\n\n`;
  if (m.mode === 'solo') {
    t += `Votes: *${v.votes.T.size}/${v.need.T}*\n`;
  } else {
    t += `Team A: *${v.votes.A.size}/${v.need.A}*\nTeam B: *${v.votes.B.size}/${v.need.B}*\n`;
  }
  t += `\nPlayers of this match: tap *Vote*.\nExpires in ${Math.round(VOTE_EXPIRE_MS / 60000)} minutes.`;
  return t;
}

function endVote(matchId) {
  const v = hostVotes.get(mkey(matchId));
  if (v?.timer) clearTimeout(v.timer);
  hostVotes.delete(mkey(matchId));
}

bot.command(['changehost', 'votehost'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply('❌ No active match');
    const me = await getPlayerByTg(m.id, ctx.from.id);
    if (!me) return ctx.reply('❌ Only players of this match can start a host vote');
    if (hostVotes.has(mkey(m.id))) return ctx.reply('🗳 A host vote is already running.');

    const players = await getPlayers(m.id);
    const need =
      m.mode === 'solo'
        ? { T: Math.min(VOTE_NEEDED, players.length) }
        : {
            A: Math.min(VOTE_NEEDED, players.filter((p) => p.team_label === 'A').length),
            B: Math.min(VOTE_NEEDED, players.filter((p) => p.team_label === 'B').length),
          };
    const v = {
      need,
      votes: { A: new Set(), B: new Set(), T: new Set() },
      phase: 'vote',
      timer: null,
      chatId: ctx.chat.id,
      msgId: null,
    };
    const sent = await ctx.reply(await voteText(m, v), {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([[Markup.button.callback('🗳 Vote to change host', `hv:${m.id}`)]]),
    });
    v.msgId = sent.message_id;
    v.timer = setTimeout(async () => {
      if (!hostVotes.has(mkey(m.id))) return;
      endVote(m.id);
      try {
        await bot.telegram.editMessageText(v.chatId, v.msgId, undefined, '⌛ The host vote expired.');
      } catch (_) {}
    }, VOTE_EXPIRE_MS);
    hostVotes.set(mkey(m.id), v);
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
});

bot.action(/^hv:(.+)$/, async (ctx) => {
  try {
    const m = await getMatch(ctx.match[1]);
    const v = m && hostVotes.get(mkey(m.id));
    if (!m || !v || v.phase !== 'vote')
      return ctx.answerCbQuery('This vote is not active', { show_alert: true });
    const p = await getPlayerByTg(m.id, ctx.from.id);
    if (!p) return ctx.answerCbQuery('Only players of this match can vote', { show_alert: true });

    const bucket = m.mode === 'solo' ? 'T' : p.team_label;
    if (v.votes[bucket].has(ctx.from.id))
      return ctx.answerCbQuery('You already voted', { show_alert: true });
    v.votes[bucket].add(ctx.from.id);

    const done =
      m.mode === 'solo'
        ? v.votes.T.size >= v.need.T
        : v.votes.A.size >= v.need.A && v.votes.B.size >= v.need.B;
    await ctx.answerCbQuery('Vote counted');

    if (done) {
      v.phase = 'claim';
      await ctx.editMessageText(await voteText(m, v), {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([[Markup.button.callback('👑 Become Host', `hc:${m.id}`)]]),
      });
    } else {
      await ctx
        .editMessageText(await voteText(m, v), {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[Markup.button.callback('🗳 Vote to change host', `hv:${m.id}`)]]),
        })
        .catch(() => {});
    }
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery('Error', { show_alert: true }).catch(() => {});
  }
});

bot.action(/^hc:(.+)$/, async (ctx) => {
  try {
    const m = await getMatch(ctx.match[1]);
    const v = m && hostVotes.get(mkey(m.id));
    if (!m || !v || v.phase !== 'claim')
      return ctx.answerCbQuery('This vote is not active', { show_alert: true });
    const p = await getPlayerByTg(m.id, ctx.from.id);
    if (!p) return ctx.answerCbQuery('Only players of this match can become host', { show_alert: true });
    if (Number(m.host_telegram_id) === ctx.from.id)
      return ctx.answerCbQuery('You are already the host', { show_alert: true });

    endVote(m.id); // first tap wins
    await upsertUser(ctx.from);
    await q(`UPDATE matches SET host_telegram_id=$2 WHERE id=$1`, [m.id, ctx.from.id]);
    const lob = lobbies.get(m.id);
    if (lob) lob.hostId = ctx.from.id;
    await ctx.answerCbQuery('You are the new host!');
    await ctx
      .editMessageText(`👑 *NEW HOST*\n${line()}\n${mtag(ctx.from)} is now the host of this match!`, {
        parse_mode: 'Markdown',
      })
      .catch(() => {});
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery('Error', { show_alert: true }).catch(() => {});
  }
});

// ─── Numbers: bowler (DM) first, then batsman (group) ────
bot.hears(/^[1-6]$/, async (ctx) => {
  const num = parseInt(ctx.message.text, 10);
  try {
    if (ctx.chat && ctx.chat.type === 'private') return await bowlerLocksNumber(ctx, num);
    if (!isGroup(ctx)) return;

    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status)) return;
    const inn = await getInnings(m.id);
    if (!inn || inn.ball_state !== 'waiting_bowl') return;

    const { rows } = await q(`SELECT * FROM pending_balls WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
    const pend = rows[rows.length - 1];
    if (!pend || pend.bowl_number == null) return; // the bowler has not locked his number yet

    const striker = await getPlayer(inn.striker_player_id);
    if (!striker || Number(striker.telegram_id) !== ctx.from.id) return;

    const claim = await q(
      `UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NOT NULL`,
      [pend.callback_token]
    );
    if (!claim.rowCount) return; // double tap
    await resolveBall(ctx.telegram, m, inn, pend, num, ctx.message.message_id);
  } catch (e) {
    console.error(e);
  }
});

// Bowler sends his number in the bot's DM → it is linked to the game he is playing in
async function bowlerLocksNumber(ctx, n) {
  const { rows } = await q(
    `SELECT * FROM pending_balls WHERE bowler_telegram_id=$1 AND is_resolved=FALSE AND bowl_number IS NULL`,
    [ctx.from.id]
  );
  if (!rows.length) return ctx.reply('ℹ️ No ball is waiting for your number right now.');
  const pend = rows[rows.length - 1];
  const upd = await q(
    `UPDATE pending_balls SET bowl_number=$2 WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NULL RETURNING callback_token`,
    [pend.callback_token, n]
  );
  if (!upd.rowCount) return ctx.reply('⚠️ This ball is no longer waiting for your number.');

  const m = await getMatch(pend.match_id);
  const { rows: ir } = await q(`SELECT * FROM innings WHERE id=$1`, [pend.innings_id]);
  const inn = ir[0];
  const groupId = Number(m.group_chat_id);
  const striker = await getPlayer(inn.striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);

  await del(groupId, pend.batting_message_id); // "check your DM" notice
  const lock = await ctx.telegram.sendMessage(
    groupId,
    `🔒 ${bowler ? tagOf(bowler) : 'Bowler'} has locked the number!\n` +
      `👉 ${striker ? tagOf(striker) : 'Batsman'} type *1–6* in the group (${TURN_SECONDS}s)`,
    { parse_mode: 'Markdown' }
  );
  lockMsgs.set(pend.callback_token, lock.message_id);
  if (bowler) await sendResultGif(ctx.telegram, groupId, 'runup', undefined, runupCaption(bowler));

  const url = groupMsgLink(groupId, lock.message_id);
  await ctx.reply(`✅ Number *${n}* locked!\n📍 Back to the game: ${mdEsc(m.group_title || 'group')}`, {
    parse_mode: 'Markdown',
    reply_to_message_id: ctx.message.message_id,
    ...(url ? Markup.inlineKeyboard([[Markup.button.url('↩️ Back to group', url)]]) : {}),
  });
  await ensureTurnClock(m.id); // now the batsman is on the clock
}

// Old DM buttons (previous version) are no longer used
bot.action(/^bowl:(.+):([1-6])$/, async (ctx) => {
  await ctx.answerCbQuery('Buttons are no longer used — send your number as a message.', { show_alert: true });
});

// ─── Match finish (cards) ────────────────────────────────
// Solo: single innings finished (everyone is out)
async function finishSolo(telegram, groupId, m, inn) {
  await q(`UPDATE matches SET status='completed', winner_team='A', completed_at=NOW() WHERE id=$1`, [m.id]);
  const [bat, bowl, aw] = await Promise.all([bestBatter(m.id), bestBowler(m.id), matchAwards(m.id)]);
  const players = await getPlayers(m.id, 'A');
  const caption =
    `🏁 *SOLO MATCH OVER*\n${line()}\n` +
    `👥 Players: *${players.length}*\n` +
    `📊 Total: *${inn.total_runs}/${inn.total_wickets}* in ${oversStr(inn.balls_bowled)} overs\n\n` +
    awardsText(aw);
  await sendSoloFinal(telegram, groupId, m, caption, bat, bowl);
}

// Team: second innings finished
async function finishTeam(telegram, groupId, m, inn2) {
  const batSide = await getPlayers(m.id, inn2.batting_team);
  let resultLine;
  let winner;
  if (inn2.total_runs >= m.target) {
    winner = inn2.batting_team;
    const left = Math.max(1, batSide.length - 1 - inn2.total_wickets);
    resultLine = `🏆 *Team ${winner} WINS by ${left} wicket${left === 1 ? '' : 's'}!*`;
  } else if (inn2.total_runs === m.target - 1) {
    winner = 'tie';
    resultLine = `🤝 *MATCH TIED!*`;
  } else {
    winner = inn2.bowling_team;
    const margin = m.target - 1 - inn2.total_runs;
    resultLine = `🏆 *Team ${winner} WINS by ${margin} run${margin === 1 ? '' : 's'}!*`;
  }
  await q(`UPDATE matches SET status='completed', winner_team=$2, completed_at=NOW() WHERE id=$1`, [
    m.id,
    winner,
  ]);

  const { rows: inns } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [m.id]);
  let caption = `🏁 *MATCH OVER*\n${line()}\n${resultLine}\n\n`;
  for (const i of inns) {
    caption += `Team ${i.batting_team}: *${i.total_runs}/${i.total_wickets}* (${oversStr(i.balls_bowled)} ov)\n`;
  }
  const aw = await matchAwards(m.id, winner);
  caption += `\n${awardsText(aw)}`;
  await sendTeamFinal(telegram, groupId, m, caption);
  await sendLong(telegram, groupId, await fullScorecard(m.id));
}

// ─── After every ball (or retire): innings end? next prompts, scoreboard, clocks ───
//  solo : unlimited overs, ends when every player is out
//  team : all out (last batter has no partner => players-1 wickets), overs finished or target chased
async function progressAfterBall(telegram, m0, inn2, isWicket) {
  const m = (await getMatch(m0.id)) || m0; // fresh row (target may have changed through penalties)
  const isSolo = m.mode === 'solo';
  const groupId = Number(m.group_chat_id);

  const batSide = await getPlayers(m.id, inn2.batting_team);
  const nBat = Math.max(1, batSide.length);
  const maxBalls = (m.total_overs || DEFAULT_OVERS) * 6;
  let ended = isSolo
    ? inn2.total_wickets >= nBat
    : inn2.total_wickets >= nBat - 1 || inn2.balls_bowled >= maxBalls;
  if (!isSolo && inn2.innings_number === 2 && m.target && inn2.total_runs >= m.target) ended = true;

  let matchFinished = false;
  if (ended) {
    clearTurnClock(m.id);
    await q(`UPDATE innings SET is_completed=TRUE WHERE id=$1`, [inn2.id]);

    if (isSolo) {
      matchFinished = true;
      await finishSolo(telegram, groupId, m, inn2);
    } else if (inn2.innings_number === 1) {
      const target = inn2.total_runs + 1;
      const bat2 = inn2.bowling_team;
      const bowl2 = inn2.batting_team;
      // a team that was penalised before it batted starts its innings below zero
      const t2 = await getTeam(m.id, bat2);
      const startRuns = Number(t2?.penalty_runs || 0);
      await q(
        `UPDATE matches SET status='innings2', current_innings=2,
         current_batting_team=$2, current_bowling_team=$3, target=$4 WHERE id=$1`,
        [m.id, bat2, bowl2, target]
      );
      await q(
        `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state, total_runs)
         VALUES ($1,2,$2,$3,'idle',$4)`,
        [m.id, bat2, bowl2, startRuns]
      );

      const mid =
        `🏁 *END OF INNINGS 1*\n` +
        `${line()}\n` +
        `Team ${inn2.batting_team}: *${inn2.total_runs}/${inn2.total_wickets}* (${oversStr(inn2.balls_bowled)} ov)\n` +
        `🎯 Target for Team ${bat2}: *${target}*\n` +
        (startRuns < 0 ? `⚠️ Team ${bat2} starts on *${startRuns}* (time penalties)\n` : '') +
        `\nBatting captain: /bat 1 · /bat 2\nBowling captain: /ball 1`;

      await telegram.sendMessage(groupId, mid, { parse_mode: 'Markdown' });
      await sendLong(telegram, groupId, await fullScorecard(m.id));
    } else {
      matchFinished = true;
      await finishTeam(telegram, groupId, m, inn2);
    }
  } else {
    // Continue play prompts
    if (isSolo && isWicket) {
      // Auto next batsman on same side
      const innNew = await soloAutoSetup(m, inn2);
      const st = await getPlayer(innNew.striker_player_id);
      if (st) {
        await telegram.sendMessage(
          groupId,
          `🔄 Next batsman: *${mn(st)}*`,
          { parse_mode: 'Markdown' }
        );
        await sendResultGif(telegram, groupId, 'batentry', undefined, newBatsmanCaption(st));
      }
    } else if (!isSolo && isWicket && !inn2.striker_player_id) {
      await telegram.sendMessage(
        groupId,
        `👑 Team ${inn2.batting_team} captain: next batsman → /bat <no.>`
      );
    } else if (!isSolo && inn2.balls_bowled > 0 && inn2.balls_bowled % 6 === 0) {
      await telegram.sendMessage(
        groupId,
        `🔔 Over complete!\n👑 Team ${inn2.bowling_team}: /ball <no.>`
      );
    }
  }

  if (matchFinished) {
    clearTurnClock(m.id);
    clearWarns(m.id);
    stopIdleWatch(m.id);
    endVote(m.id);
  } else {
    await telegram.sendMessage(groupId, await scoreboard(m.id), { parse_mode: 'Markdown' });
    await ensureTurnClock(m.id);
  }
}

// ─── Resolve a ball: bowler number (locked) vs batsman number ───────────
async function resolveBall(telegram, m, inn, pend, batNum, batMsgId) {
  const bowlNum = Number(pend.bowl_number);
  const isWicket = batNum === bowlNum;
  const runs = isWicket ? 0 : batNum;
  const strikerId = inn.striker_player_id;
  const nonId = inn.non_striker_player_id;
  const bowlerId = inn.current_bowler_id;
  const isSolo = m.mode === 'solo';
  const groupId = Number(m.group_chat_id);

  clearTurnClock(m.id);
  const lockId = lockMsgs.get(pend.callback_token);
  if (lockId) {
    lockMsgs.delete(pend.callback_token);
    del(groupId, lockId);
  }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO deliveries (innings_id, over_number, ball_number, batsman_id, bowler_id, bat_number, bowl_number, runs_scored, is_wicket)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          inn.id,
          pend.over_number,
          pend.ball_number,
          strikerId,
          bowlerId,
          batNum,
          bowlNum,
          runs,
          isWicket,
        ]
      );

      if (isWicket) {
        await client.query(
          `UPDATE batting_stats SET balls_faced=balls_faced+1, is_out=TRUE, dismissal_type='bowled'
           WHERE innings_id=$1 AND player_id=$2`,
          [inn.id, strikerId]
        );
      } else {
        await client.query(
          `UPDATE batting_stats SET runs=runs+$3, balls_faced=balls_faced+1,
           fours=fours+$4, sixes=sixes+$5
           WHERE innings_id=$1 AND player_id=$2`,
          [inn.id, strikerId, runs, runs === 4 ? 1 : 0, runs === 6 ? 1 : 0]
        );
      }

      await client.query(
        `UPDATE bowling_stats SET balls_bowled=balls_bowled+1, runs_conceded=runs_conceded+$3,
         wickets=wickets+$4, overs_bowled=(balls_bowled+1)/6.0
         WHERE innings_id=$1 AND player_id=$2`,
        [inn.id, bowlerId, runs, isWicket ? 1 : 0]
      );

      let newStriker = strikerId;
      let newNon = nonId;

      if (isSolo) {
        // Solo: stay on same striker unless out (then the next player comes in)
        if (isWicket) newStriker = null;
      } else {
        if (isWicket) newStriker = null;
        else if (runs % 2 === 1) {
          newStriker = nonId;
          newNon = strikerId;
        }
      }

      const newBalls = inn.balls_bowled + 1;
      const endOver = newBalls % 6 === 0;

      if (!isSolo && endOver && !isWicket) {
        const tmp = newStriker;
        newStriker = newNon;
        newNon = tmp;
      }

      // Solo: keep same bowler always; team: clear on over end
      let currentBowler = bowlerId;
      let lastBowler = inn.last_bowler_id || bowlerId;
      if (!isSolo) {
        currentBowler = endOver ? null : bowlerId;
        lastBowler = endOver ? bowlerId : lastBowler;
      }

      await client.query(
        `UPDATE innings SET total_runs=$2, total_wickets=$3, balls_bowled=$4,
         striker_player_id=$5, non_striker_player_id=$6,
         current_bowler_id=$7, last_bowler_id=$8,
         pending_bat_number=NULL, ball_state='idle' WHERE id=$1`,
        [
          inn.id,
          inn.total_runs + runs,
          inn.total_wickets + (isWicket ? 1 : 0),
          newBalls,
          newStriker,
          isSolo ? null : newNon,
          currentBowler,
          lastBowler,
        ]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }


  const inn2 = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0];

  let ballMsg;
  if (isWicket) {
    ballMsg =
      `💥 *WICKET!*\n` +
      `${line()}\n` +
      `Bat: *${batNum}*  ·  Bowl: *${bowlNum}*\n` +
      (isSolo ? `Score: *${inn2.total_runs}/${inn2.total_wickets}*\n` : `Team ${inn2.batting_team}: *${inn2.total_runs}/${inn2.total_wickets}*\n`) +
      `Overs: ${oversStr(inn2.balls_bowled)}`;
  } else {
    const emoji = runs === 6 ? '🚀' : runs === 4 ? '🔥' : '🏏';
    ballMsg =
      `${emoji} *${runs} RUN${runs !== 1 ? 'S' : ''}!*\n` +
      `${line()}\n` +
      `Bat: *${batNum}*  ·  Bowl: *${bowlNum}*\n` +
      (isSolo ? `Score: *${inn2.total_runs}/${inn2.total_wickets}*\n` : `Team ${inn2.batting_team}: *${inn2.total_runs}/${inn2.total_wickets}*\n`) +
      `Overs: ${oversStr(inn2.balls_bowled)}`;
  }
  const resultMessage = await telegram.sendMessage(groupId, ballMsg, { parse_mode: 'Markdown' });
  // Permanent GIF replies directly to the batsman's 1-6 message, with result + short commentary caption.
  const gifReplyTo = Number(batMsgId) || resultMessage.message_id;
  const commentary = isWicket ? '💥 Bowler wins this battle!' : ({1:'👏 Smart single!',2:'⚡ Quick two!',3:'🏃 Great running!',4:'🔥 Beautiful boundary!',5:'💨 Excellent running!',6:'🚀 What a hit!'}[runs] || '🏏 Nice shot!');
  const gifCaption = isWicket ? '💥 <b>WICKET!</b>\n🎙️ Bowler wins this battle!' : `${runs === 6 ? '🚀' : runs === 4 ? '🔥' : '🏏'} <b>${runs} RUN${runs === 1 ? '' : 'S'}!</b>\n🎙️ ${commentary}`;
  if (isWicket) await sendResultGif(telegram, groupId, 'out', gifReplyTo, gifCaption);
  else if (runs > 0) await sendResultGif(telegram, groupId, String(runs), gifReplyTo, gifCaption);

  if (isWicket) {
    // the batsman walks back to the dugout
    const outP = await getPlayer(strikerId);
    if (outP) await sendResultGif(telegram, groupId, 'dugout', undefined, dugoutCaption(outP));
  }

  await progressAfterBall(telegram, m, inn2, isWicket);
}

bot.catch((err, ctx) => {
  console.error(`Bot error (${ctx?.updateType}):`, err);
});

// After a restart the in-memory timers are gone: re-arm them for matches that are still open
async function rearmAfterRestart() {
  try {
    const { rows: setup } = await q(
      `SELECT id, mode, group_chat_id, host_telegram_id, status FROM matches WHERE status IN ('waiting','captains','toss')`
    );
    for (const r of setup) {
      if (r.mode === 'solo' && r.status === 'waiting') {
        startLobbyTimer(r.id, Number(r.group_chat_id), Number(r.host_telegram_id), bot.telegram, LOBBY_SECONDS);
      } else if (r.mode !== 'solo') {
        const m = await getMatch(r.id);
        const pl = await getPlayers(r.id);
        const { rows: caps } = await q(
          `SELECT COUNT(*)::int AS n FROM match_teams WHERE match_id=$1 AND captain_id IS NOT NULL`,
          [r.id]
        );
        startIdleWatch(r.id, [m.status, m.setup_phase || '', pl.length, caps[0]?.n || 0].join('|'));
      }
    }
    const { rows: live } = await q(`SELECT id FROM matches WHERE status IN ('innings1','innings2')`);
    for (const r of live) await ensureTurnClock(r.id);
    console.log(`Re-armed ${setup.length} setup match(es) and ${live.length} live match(es)`);
  } catch (e) {
    console.error('rearmAfterRestart failed:', e.message);
  }
}

// Time penalties can push scores below zero. If the database has CHECK (runs >= 0) style
// constraints on these columns, drop them once at startup (otherwise the penalty UPDATE would fail).
async function relaxNegativeRunConstraints() {
  try {
    const { rows } = await q(
      `SELECT c.conname, c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.contype='c'
          AND c.conrelid::regclass::text IN ('innings','batting_stats','public.innings','public.batting_stats')`
    );
    for (const r of rows) {
      if (/\b(total_runs|runs)\b\s*>=\s*0|\b(total_runs|runs)\b\s*>\s*-1/i.test(r.def)) {
        await q(`ALTER TABLE ${r.tbl} DROP CONSTRAINT "${r.conname}"`);
        console.log(`Dropped constraint ${r.conname} on ${r.tbl} (negative runs are needed for time penalties)`);
      }
    }
  } catch (e) {
    console.error('constraint check skipped:', e.message);
  }
}

// ─── Launch ──────────────────────────────────────────────
async function main() {
  await q('SELECT 1');
  await q('ALTER TABLE pending_balls ADD COLUMN IF NOT EXISTS batting_message_id BIGINT');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS setup_phase TEXT');
  await q('ALTER TABLE match_teams ADD COLUMN IF NOT EXISTS penalty_runs INTEGER NOT NULL DEFAULT 0');
  await q('ALTER TABLE pending_balls ADD COLUMN IF NOT EXISTS bowl_number INTEGER');
  await q(`CREATE TABLE IF NOT EXISTS pgif_settings (
    result_key TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'animation',
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await relaxNegativeRunConstraints();
  console.log('DB OK');
  await rearmAfterRestart();
  const me = await bot.telegram.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot @${me.username}`);
  await bot.launch();
  console.log('Running…');
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
