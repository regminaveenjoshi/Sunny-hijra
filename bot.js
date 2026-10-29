/**
 * Hand Cricket Telegram Bot — single file
 *
 * SOLO : /startsolo (or /solo) -> /joinsolo -> /forcestart (or /startgame)
 *        unlimited overs, one innings, everyone bats until out, just type 0-6
 * TEAM : /team (or /startteam) -> /join_a /join_b -> /startgame
 *        -> captain buttons -> toss -> bat/bowl choice -> host /setovers (1-20)
 *        -> /bat /bowl (captains) -> type 0-6
 *
 * Cards need the ./assets folder next to this file and the `sharp` package:
 *   host.jpg (solo host) · solo_final.jpg (Man of the Match) · team_final.jpg · team_banner.jpg · players_list.jpg
 * If sharp/assets are missing the bot falls back to text.
 */
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('Set BOT_TOKEN and DATABASE_URL');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('supabase') ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 5 * 60 * 1000, // default is 10s -> every quiet moment closed the connection and the next move paid a new SSL handshake
  keepAlive: true,
  keepAliveInitialDelayMillis: 10000,
  connectionTimeoutMillis: 15000,
});
pool.on('error', (e) => console.error('pg pool error:', e.message));

const BOT_VERSION = 'r43-2026-10-29'; // shown by /testcard and in the logs so you can see which file is deployed
const bot = new Telegraf(BOT_TOKEN);

// ─── Text styles ─────────────────────────────────────────
// Bold "fancy" font for headings (Unicode sans-serif bold): fancy('MATCH OVER') -> 𝗠𝗔𝗧𝗖𝗛 𝗢𝗩𝗘𝗥

// Premium custom emoji (Telegram HTML <tg-emoji>). Falls back to unicode if client ignores it.
const PE = {
  // Premium custom emoji — HTML <tg-emoji> + button icon_custom_emoji_id
  bat:      { id: '5346089086325130313', fb: '🏏' }, // bat + ball
  batsman:  { id: '6030703634902161922', fb: '🏃' }, // batsman
  bowler:   { id: '6030872955397872051', fb: '🎳' }, // bowling
  ball:     { id: '6021757930989164684', fb: '🔴' }, // cricket ball
  ok:       { id: '6311872470638925629', fb: '✅' }, // green check
  no:       { id: '5462998469784393745', fb: '❌' }, // red cross
  star:     { id: '5370784581341422520', fb: '⭐' }, // star
  coin:     { id: '5382164415019768638', fb: '🪙' }, // gold coin (generic)
  heads:    { id: '5343662197874630855', fb: '🪙' }, // heads — $ coin
  tails:    { id: '5382164415019768638', fb: '🪙' }, // tails — gold ↑ coin
  zap:      { id: '5809898661840169148', fb: '⚡' }, // lightning
  hand:     { id: '6107130683853903534', fb: '🤝' }, // handshake
  six:      { id: '6174505612487954828', fb: '🚀' }, // blast
  crown:    { id: '5217822164362739968', fb: '👑' }, // crown
  trophy:   { id: '6037519756590845010', fb: '🏆' }, // trophy
  plane:    { id: '6028346797368283073', fb: '✈️' },
  stop:     { id: '6086741365998227951', fb: '🚫' },
  point:    { id: '6086816966012573204', fb: '👉' },
  infinite: { id: '6152232006580181837', fb: '∞' },
  heart:    { id: '6154635934135490300', fb: '💜' },
  spark:    { id: '6105048883140760635', fb: '✨' },
  gdot:     { id: '6107134841382246388', fb: '🟢' },
  rdot:     { id: '6104873438021686768', fb: '🔴' },
  // newly provided — logical mapping
  clock:    { id: '5451732530048802485', fb: '⏳' }, // hourglass / timer
  people:   { id: '5296533616224906961', fb: '👥' }, // group / players
  mega:     { id: '5271983638995545748', fb: '📢' }, // megaphone
  door:     { id: '6035130900075777681', fb: '🚪' }, // leave / exit
  list:     { id: '5233658378797994515', fb: '📋' }, // clipboard
  shield:   { id: '5348129380474306311', fb: '🛡' }, // shield with check
  game:     { id: '5938413566624272793', fb: '🎮' }, // controller
  game2:    { id: '5319120041780726017', fb: '🎮' }, // controller alt
  target:   { id: '5782962967716829279', fb: '🎯' }, // target
  warn:     { id: '6271786398404055377', fb: '⚠️' }, // warning
  wave:     { id: '6095851644468072524', fb: '👋' }, // bye / wave
  plus:     { id: '5352996025097267519', fb: '➕' }, // add
  flag:     { id: '6070970465130648249', fb: '🚩' }, // red flag
  cart:     { id: '5431499171045581032', fb: '🛒' },
  voice:    { id: '6021793768196282527', fb: '🗣' },
  mute:     { id: '6021313238665271979', fb: '🔕' },
  chart:    { id: '5282950412784117735', fb: '📈' }, // chart up
  medal:    { id: '5188344996356448758', fb: '🏅' }, // trophy 2
  swords:   { id: '5408935401442267103', fb: '⚔️' }, // vs
  bulb:     { id: '5472146462362048818', fb: '💡' }, // help / tip
  money:    { id: '5417924076503062111', fb: '💰' },
  // Never emit <tg-emoji> HTML (shows as raw code for most bots). Unicode only.
  e: (key, fb) => {
    const p = PE[key];
    if (!p || typeof p !== 'object') return fb || '';
    return fb || p.fb || '';
  },
};
// Messages: always plain unicode emoji
const pe = (key, fb) => PE.e(key, fb);

// Strip premium tags → plain fallback text (when Telegram rejects custom emoji)
function stripPe(s) {
  return String(s || '')
    .replace(/<tg-emoji\b[^>]*>([\s\S]*?)<\/tg-emoji>/gi, '$1')
    .replace(/<tg-emoji\b[^>]*\/>/gi, '');
}

// Convert our Markdown (+ pe tags) to HTML and send safely.
// Tries HTML with premium emoji; on entity errors retries without custom emoji.
async function sendHtmlMessage(telegram, chatId, mdOrHtml, extra = {}) {
  const html = stripPe(md2html(mdOrHtml));
  const opts = { ...extra, parse_mode: 'HTML' };
  try {
    return await telegram.sendMessage(chatId, html, opts);
  } catch (e) {
    const msg = String(e.message || e || '');
    if (/can't parse entities|tg-emoji|custom emoji|ENTITY/i.test(msg)) {
      const plain = stripPe(html);
      try {
        return await telegram.sendMessage(chatId, plain, opts);
      } catch (e2) {
        return telegram.sendMessage(chatId, stripPe(mdOrHtml).replace(/[*_`]/g, ''), { ...extra, parse_mode: undefined });
      }
    }
    throw e;
  }
}

async function sendHtmlPhoto(telegram, chatId, photo, mdOrHtml, extra = {}) {
  const html = stripPe(md2html(mdOrHtml));
  const opts = { ...extra, caption: html, parse_mode: 'HTML' };
  try {
    return await telegram.sendPhoto(chatId, photo, opts);
  } catch (e) {
    const msg = String(e.message || e || '');
    if (/can't parse entities|tg-emoji|custom emoji|ENTITY|caption/i.test(msg)) {
      const plain = stripPe(html);
      try {
        return await telegram.sendPhoto(chatId, photo, { ...extra, caption: plain, parse_mode: 'HTML' });
      } catch (e2) {
        // last resort: photo without caption + text message
        const sent = await telegram.sendPhoto(chatId, photo, { ...extra, caption: undefined });
        await sendHtmlMessage(telegram, chatId, mdOrHtml, extra);
        return sent;
      }
    }
    throw e;
  }
}

function fancy(str) {
  return [...String(str)]
    .map((ch) => {
      const c = ch.codePointAt(0);
      if (c >= 65 && c <= 90) return String.fromCodePoint(0x1d5d4 + (c - 65));
      if (c >= 97 && c <= 122) return String.fromCodePoint(0x1d5ee + (c - 97));
      if (c >= 48 && c <= 57) return String.fromCodePoint(0x1d7ec + (c - 48));
      return ch;
    })
    .join('');
}

// All our messages are written in the small Markdown dialect (*bold*, _italic_, `code`, [text](url),
// "\_" escapes and "> quote" lines). They are converted to Telegram HTML right before sending, because
// only HTML supports quote blocks. Consecutive lines starting with "> " become one <blockquote>.
function md2html(src) {
  const ESC = { _: '\uE001', '*': '\uE002', '`': '\uE003', '[': '\uE004' };
  const BACK = { '\uE001': '_', '\uE002': '*', '\uE003': '`', '\uE004': '[' };
  // protect premium <tg-emoji> so HTML escape does not break them
  const held = [];
  let s = String(src).replace(/<tg-emoji\b[^>]*>[\s\S]*?<\/tg-emoji>/gi, (m) => {
    held.push(m);
    return `\uE010${held.length - 1}\uE011`;
  });
  s = s.replace(/\\([_*`\[])/g, (_, c) => ESC[c]);
  const out = [];
  let quote = [];
  const flush = () => {
    if (quote.length) {
      out.push(`<blockquote>${quote.join('\n')}</blockquote>`);
      quote = [];
    }
  };
  const inline = (line) =>
    line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
      .replace(/\*([^*\n]+)\*/g, '<b>$1</b>')
      .replace(/_([^_\n]+)_/g, '<i>$1</i>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>');
  let pre = null;
  const escPre = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  for (const line of s.split('\n')) {
    if (line.trim() === '```') {
      if (pre === null) {
        flush();
        pre = [];
      } else {
        out.push(`<pre>${escPre(pre.join('\n'))}</pre>`);
        pre = null;
      }
      continue;
    }
    if (pre !== null) {
      pre.push(line);
      continue;
    }
    if (/^>( |$)/.test(line)) quote.push(inline(line.slice(2)));
    else {
      flush();
      out.push(inline(line));
    }
  }
  if (pre !== null) out.push(`<pre>${escPre(pre.join('\n'))}</pre>`);
  flush();
  return out
    .join('\n')
    .replace(/[\uE001-\uE004]/g, (c) => BACK[c])
    .replace(/\uE010(\d+)\uE011/g, (_, i) => held[Number(i)] || '');
}

// ─── Premium custom emoji in every message text / caption ───
// Every normal emoji we write is swapped for its premium twin (<tg-emoji>) right before sending.
// Set PREMIUM_TEXT=0 in the env to switch this off (buttons keep their premium icons).
const PREMIUM_TEXT = process.env.PREMIUM_TEXT !== '0';
const PREMIUM_EMOJI = {
  '🏏': '5346089086325130313', // bat + ball
  '🏃': '6030703634902161922', // batsman (striker)
  '🎳': '6030872955397872051', // bowler
  '⚪': '6021757930989164684', // ball (dot)
  '🔴': '6104873438021686768', // red dot
  '🟢': '6107134841382246388', // green dot
  '🪙': '5382164415019768638', // coin
  '👑': '5217822164362739968', // crown / captain / host
  '🏆': '6037519756590845010', // trophy
  '🏅': '5188344996356448758', // medal
  '⏱': '5451732530048802485', '⏳': '5451732530048802485', '⏰': '5451732530048802485', // timer
  '👥': '5296533616224906961', '👤': '5296533616224906961', // players
  '📢': '5271983638995545748', '📌': '5271983638995545748', // announce
  '🚪': '6035130900075777681', // leave
  '📋': '5233658378797994515', // list
  '🛡': '5348129380474306311', // shield
  '🎮': '5938413566624272793', // game
  '🎯': '5782962967716829279', // target
  '⚠': '6271786398404055377', // warning
  '🚩': '6070970465130648249', // flag
  '👋': '6095851644468072524', // wave
  '➕': '5352996025097267519', // add
  '⚡': '5809898661840169148', // zap
  '✅': '6311872470638925629', // ok
  '❌': '5462998469784393745', // no
  '🚫': '6086741365998227951', // stop
  '👉': '6086816966012573204', // point
  '♾': '6152232006580181837', // unlimited
  '💜': '6154635934135490300', // heart
  '✨': '6105048883140760635', // spark
  '⭐': '5370784581341422520', // star
  '🚀': '6174505612487954828', // six
  '📊': '5282950412784117735', '📈': '5282950412784117735', // chart
  '⚔': '5408935401442267103', // versus
  '🤝': '6107130683853903534', // handshake / tie
  '💡': '5472146462362048818', // tip
  '✈': '6028346797368283073', // plane
  '🔕': '6021313238665271979', // mute
};
const PREMIUM_RE_SRC = Object.keys(PREMIUM_EMOJI)
  .sort((x, y) => y.length - x.length)
  .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\uFE0F?')
  .join('|');
function premiumizeHtml(html, max = 45) {
  let n = 0;
  const re = new RegExp(
    `<tg-emoji\\b[^>]*>[\\s\\S]*?<\\/tg-emoji>|<(code|pre)\\b[^>]*>[\\s\\S]*?<\\/\\1>|<[^>]+>|(${PREMIUM_RE_SRC})`,
    'g'
  );
  return String(html).replace(re, (m, _t, emo) => {
    if (!emo || n >= max) return m;
    const id = PREMIUM_EMOJI[emo.replace(/\uFE0F/g, '')];
    if (!id) return m;
    n++;
    return `<tg-emoji emoji-id="${id}">${emo}</tg-emoji>`;
  });
}
const stripButtonIcons = (markup) => {
  if (!markup || !Array.isArray(markup.inline_keyboard)) return markup;
  return {
    ...markup,
    inline_keyboard: markup.inline_keyboard.map((row) =>
      row.map((b) => {
        const { icon_custom_emoji_id, style, ...rest } = b;
        return rest;
      })
    ),
  };
};
const TEXT_FIELD = {
  sendMessage: 'text',
  editMessageText: 'text',
  sendPhoto: 'caption',
  sendAnimation: 'caption',
  sendVideo: 'caption',
  sendDocument: 'caption',
  editMessageCaption: 'caption',
};

// every message sent through the Telegram API: Markdown dialect → HTML, emojis → premium emojis
const _callApi = bot.telegram.callApi.bind(bot.telegram);
bot.telegram.callApi = async (method, payload = {}, extra) => {
  if (!payload) return _callApi(method, payload, extra);
  const p = { ...payload };
  const field = TEXT_FIELD[method];
  if (p.parse_mode === 'Markdown') {
    p.parse_mode = 'HTML';
    if (typeof p.text === 'string') p.text = md2html(p.text);
    if (typeof p.caption === 'string') p.caption = md2html(p.caption);
  }
  if (!field || typeof p[field] !== 'string' || p.entities || p.caption_entities) return _callApi(method, p, extra);

  // plain text (no parse mode) → HTML so emojis can be swapped
  let base = p;
  if (!p.parse_mode && PREMIUM_TEXT) {
    base = { ...p, parse_mode: 'HTML', [field]: escapeHtml(p[field]) };
  }
  if (base.parse_mode !== 'HTML') return _callApi(method, p, extra);

  const clean = { ...base, [field]: stripPe(base[field]) };
  if (PREMIUM_TEXT) {
    const prem = premiumizeHtml(clean[field]);
    if (prem !== clean[field]) {
      try {
        return await _callApi(method, { ...clean, [field]: prem }, extra);
      } catch (e) {
        const msg = String(e.message || e || '');
        if (!/parse|entit|emoji|DOCUMENT|custom|BUTTON|icon|style/i.test(msg)) throw e;
      }
    }
  }
  try {
    return await _callApi(method, clean, extra);
  } catch (e) {
    const msg = String(e.message || e || '');
    if (clean.reply_markup && /BUTTON|icon|emoji|style/i.test(msg))
      return _callApi(method, { ...clean, reply_markup: stripButtonIcons(clean.reply_markup) }, extra);
    throw e;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULT_OVERS = 5; // placeholder value stored until the host runs /setovers (team) / unused in solo
const MAX_OVERS = 20; // host can choose 1..20 overs
const COIN_FRAME_MS = 750; // speed of the coin-flip animation
const DEFAULT_TEAM_SIZE = 100; // max players per team (effectively unlimited)
const MIN_TEAM_PLAYERS = 2; // striker + non-striker
const MAX_BOWLER_OVERS = 4;
const LOBBY_SECONDS = 60; // solo lobby timer
const TEAM_JOIN_SECONDS = 45; // team lobby join window
const TEAM_JOIN_WARN_LAST = 10; // send warning this many seconds before end
const MAX_SOLO_PLAYERS = 100; // effectively unlimited

// ── Discipline rules ──
const TURN_SECONDS = 60; // batsman / bowler must respond within this time
const TURN_PENALTY = 6; // runs lost for every missed turn
const SOLO_BOWLER_WARN_LIMIT = 3; // solo: bowling auto-changes after this many missed turns
const TEAM_BOWLER_WARN_LIMIT = 2; // team: captain is tagged to choose the next bowler after this many
const BAT_RETIRE_LIMIT = 3; // batsman is retired OUT after this many missed turns
const IDLE_WARN_SECONDS = 60; // host warning interval while the lobby / setup does not progress
const IDLE_WARN_LIMIT = 10; // game is ended after this many host warnings
const STUCK_MINUTES = 6; // active game with no response → auto-cancel so others can play
const STUCK_CHECK_MS = 60 * 1000; // how often we scan for stuck games
const matchActivity = new Map(); // matchId -> last activity ms
function touchMatch(matchId) {
  matchActivity.set(mkey(matchId), Date.now());
  // Any real progress resets host idle-warning counter
  const w = idleWatch.get(mkey(matchId));
  if (w) {
    w.warnings = 0;
  }
}
const VOTE_NEEDED = 3; // change-host vote: 3 votes from Team A and 3 from Team B (solo: 3 votes)
const VOTE_EXPIRE_MS = 3 * 60 * 1000;

// bot owner / admins from env (BOT_OWNER_ID, ADMIN_IDS)
const BOT_ADMIN_IDS = [process.env.BOT_OWNER_ID, ...(process.env.ADMIN_IDS || '').split(',')]
  .map((v) => Number(String(v || '').trim()))
  .filter((n) => Number.isSafeInteger(n) && n > 0);
const isAdmin = (id) => BOT_ADMIN_IDS.includes(Number(id));

async function isGroupAdmin(chatId, userId) {
  try {
    const r = await bot.telegram.getChatMember(chatId, userId);
    return ['creator', 'administrator'].includes(r.status);
  } catch (_) {
    return false;
  }
}

let BOT_USERNAME = ''; // filled at startup (used for "open bot DM" buttons)

// best-effort message delete
const del = (chat, id) => (id ? bot.telegram.deleteMessage(chat, id).catch(() => {}) : null);

// matchId -> { timer, endsAt, chatId, hostId }
const lobbies = new Map();
const teamJoinTimers = new Map(); // matchId -> { timer, warnTimer, endsAt, chatId };

function clearLobby(matchId) {
  const L = lobbies.get(matchId);
  if (L?.timer) clearTimeout(L.timer);
  if (L?.tick) clearInterval(L.tick);
  lobbies.delete(matchId);
}

// ─── DB ──────────────────────────────────────────────────
const SLOW_Q_MS = Number(process.env.SLOW_Q_MS || 400); // set SLOW_Q_MS=0 to silence
async function q(sql, params = []) {
  const t0 = Date.now();
  const res = await pool.query(sql, params);
  const ms = Date.now() - t0;
  if (SLOW_Q_MS && ms >= SLOW_Q_MS) console.warn(`[slow-db] ${ms}ms  ${String(sql).replace(/\s+/g, ' ').slice(0, 90)}`);
  if (/^\s*(INSERT|UPDATE|DELETE)/i.test(sql) && /pgif_settings|bot_media/.test(sql)) pgifCache.clear();
  return res;
}
const pgifCache = new Map(); // key -> { v, at }  (saved GIFs almost never change)
const PGIF_TTL_MS = 5 * 60 * 1000;
async function dbLatency(n = 3) {
  const t = [];
  for (let i = 0; i < n; i++) {
    const t0 = Date.now();
    await pool.query('SELECT 1');
    t.push(Date.now() - t0);
  }
  return Math.round(t.reduce((a, b) => a + b, 0) / t.length);
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

// plain name: first + last name preferred, else @username, else telegram id
function name(p) {
  if (!p) return '—';
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  if (full) return full;
  if (p.username) return `@${p.username}`;
  const id = p.telegram_id ?? p.id;
  return id != null ? String(id) : '—';
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

// ─── Keyboards (premium icon_custom_emoji_id + bold text) ───
// style: 'primary' (blue) | 'success' (green) | 'danger' (red) - Telegram coloured buttons
function ubtn(text, url, peKey, style) {
  const b = Markup.button.url(text, url);
  const p = peKey && PE[peKey];
  if (p && p.id) b.icon_custom_emoji_id = p.id;
  if (style) b.style = style;
  return b;
}
function btn(text, data, peKey, style) {
  const b = Markup.button.callback(text, data);
  const p = peKey && PE[peKey];
  if (p && p.id) b.icon_custom_emoji_id = p.id;
  if (style) b.style = style;
  return b;
}

const mainKb = () =>
  Markup.inlineKeyboard([
    [btn('𝗦𝗢𝗟𝗢', 'm:solo', 'game', 'success'), btn('𝗧𝗘𝗔𝗠', 'm:team', 'people', 'primary')],
    [btn('𝗣𝗥𝗢𝗙𝗜𝗟𝗘', 'm:profile', 'star', 'primary'), btn('𝗕𝗢𝗔𝗥𝗗', 'm:lb', 'trophy', 'success')],
    [btn('𝗛𝗘𝗟𝗣', 'm:help', 'bulb')],
  ]);

const tossKb = (id) =>
  Markup.inlineKeyboard([
    [btn('𝗕𝗔𝗧', `toss:${id}:bat`, 'bat', 'success'), btn('𝗕𝗔𝗟𝗟', `toss:${id}:bowl`, 'bowler', 'danger')],
  ]);

const tossCallKb = (id) =>
  Markup.inlineKeyboard([
    [btn('𝗛𝗘𝗔𝗗𝗦', `tc:${id}:H`, 'heads', 'primary'), btn('𝗧𝗔𝗜𝗟𝗦', `tc:${id}:T`, 'tails', 'danger')],
  ]);

const bowlKb = (token) =>
  Markup.inlineKeyboard([
    [
      btn('𝟭', `bowl:${token}:1`, 'ball'),
      btn('𝟮', `bowl:${token}:2`, 'ball'),
      btn('𝟯', `bowl:${token}:3`, 'ball'),
    ],
    [
      btn('𝟰', `bowl:${token}:4`, 'ball'),
      btn('𝟱', `bowl:${token}:5`, 'ball'),
      btn('𝟲', `bowl:${token}:6`, 'six'),
    ],
  ]);

// captain buttons: only for teams that still have no captain
const captainKb = (id, needA, needB) => {
  const row = [];
  if (needA) row.push(btn('𝗖𝗮𝗽𝘁𝗮𝗶𝗻 — 𝗧𝗲𝗮𝗺 𝗔', `cap:${id}:A`, 'crown', 'primary'));
  if (needB) row.push(btn('𝗖𝗮𝗽𝘁𝗮𝗶𝗻 — 𝗧𝗲𝗮𝗺 𝗕', `cap:${id}:B`, 'crown', 'danger'));
  return Markup.inlineKeyboard([row]);
};

// overs 1..20, five per row
const oversKb = (id) => {
  const rows = [];
  for (let start = 1; start <= MAX_OVERS; start += 5) {
    const row = [];
    for (let n = start; n < start + 5 && n <= MAX_OVERS; n++) {
      row.push(btn(String(n), `ov:${id}:${n}`, 'ball', 'primary'));
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

// ---- Layout (pixel coordinates measured on the template images in ./assets) ----
// host.jpg (1280x640) - SOLO ONLY: DP goes in the big circle, host name pill sits on the lower part of the DP
const HOST_LAYOUT = {
  file: 'host.jpg',
  circle: { cx: 997, cy: 315, r: 219 },
  pill: { cx: 997, cy: 440, h: 56, maxW: 296 },
};

// solo_final.jpg (1280x934) - MAN OF THE MATCH card (the "PLAYER NAME" text is already erased from the file)
const MOTM_LAYOUT = {
  file: 'solo_final.jpg',
  circle: { cx: 650.5, cy: 445, r: 97 },
  name: { cx: 650, cy: 644, maxW: 250, px: 32, color: '#2b1700' },
  top: { cy: 753, xs: [236.5, 442, 644, 844.5, 1047.5], w: 138 }, // RUNS BALLS 4s 6s STRIKE RATE
  bot: { cy: 874, xs: [442, 644, 844.5], w: 138 }, // WICKETS BALLS ECONOMY
  px: 28,
};

// team_final.jpg (853x1280) - team result card
const TEAMFIN_LAYOUT = {
  file: 'team_final.jpg',
  top: { cy: 71, px: 24, date: { cx: 190, w: 200 }, time: { cx: 428, w: 190 }, gc: { cx: 664, w: 205 } },
  bar: { A: { cx: 430, cy: 311 }, B: { cx: 427, cy: 841 }, w: 360, px: 27 },
  rowDy: { A: 0, B: 532 },
  clipAboveY: null, // DP circles are placed fully above the name bars (never cut)
  bat: {
    circle: { cx: 205, cy: 430, r: 44 },
    name: { cx: 205, cy: 490, w: 172 },
    xs: [62, 135, 206, 270, 345], // RUNS BALLS 6s 4s STRIKE RATE
    ws: [56, 58, 50, 50, 74],
    cy: 572,
  },
  bowl: {
    circle: { cx: 649, cy: 430, r: 44 },
    name: { cx: 650, cy: 490, w: 172 },
    xs: [532, 655, 772], // WICKETS BALLS ECONOMY
    ws: [96, 96, 96],
    cy: 572,
  },
  motm: { circle: { cx: 425, cy: 719, r: 48 }, name: { cx: 426, cy: 788, w: 230 }, clipAboveY: null },
  winner: { cx: 430, cy: 1237, w: 330, px: 34 },
  namePx: 22,
  valPx: 24,
};

// team_banner.jpg (1280x934) - TEAM A vs TEAM B (host + both captains)
const BANNER_LAYOUT = {
  file: 'team_banner.jpg',
  host: { cx: 640.5, cy: 451.5, r: 67 },
  A: { cx: 291, cy: 596, r: 135 },
  B: { cx: 989.5, cy: 595, r: 135 },
  nameHost: { cx: 640, cy: 623, w: 270, px: 26 },
  nameA: { cx: 292, cy: 872, w: 340, px: 34 },
  nameB: { cx: 990, cy: 872, w: 340, px: 34 },
};

const PLAYERS_LIST_FILE = 'players_list.jpg'; // 1280x640 "PLAYERS LIST - Let's Begin" banner (used as is)

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
async function textTruncated(text, px, maxW, color = '#ffffff') {
  let t = String(text);
  let img = await renderText(t, px, color);
  if (img.info.width > maxW) {
    t = t.slice(0, Math.max(1, Math.floor((t.length * maxW) / img.info.width)));
    img = await renderText(t, px, color);
    while (img.info.width > maxW && t.length > 1) {
      t = t.slice(0, -1);
      img = await renderText(t, px, color);
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
      .resize(d, d, { fit: 'cover', position: 'attention' })
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

// Shrink the font until the text fits maxW (then cut characters if still too wide)
async function fitText(text, px, maxW, color = '#ffffff', minPx = 16) {
  let size = px;
  let img = await renderText(text, size, color);
  while (img.info.width > maxW && size > minPx) {
    size -= 2;
    img = await renderText(text, size, color);
  }
  if (img.info.width > maxW) img = await textTruncated(text, size, maxW, color);
  return img;
}

// text layer centred on (cx, cy)
async function putCentered(layers, text, px, cx, cy, maxW, color = '#ffffff') {
  if (text === undefined || text === null || text === '') return;
  const img = await fitText(String(text), px, maxW, color);
  layers.push(centered(img, cx, cy, 1));
}

// IST by default; set CARD_TZ (e.g. 'Asia/Dhaka') to change
function cardDateTime(d = new Date()) {
  const tz = process.env.CARD_TZ || 'Asia/Kolkata';
  const date = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).format(d);
  return { date, time };
}

// ═══ HOST BANNER (SOLO only) ═══
async function renderHostCard({ dp, username, firstName }) {
  needSharp();
  const L = HOST_LAYOUT;
  const label = username ? `@${cleanName(username, '')}` : cleanName(firstName);
  const layers = [await dpLayer(dp, L.circle)];
  const txt = await fitText(label, 40, L.pill.maxW - 56, '#ffe9a8', 20);
  const w = Math.min(L.pill.maxW, Math.max(180, txt.info.width + 56));
  const pill = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${L.pill.h}">
       <rect x="2" y="2" rx="${L.pill.h / 2 - 2}" ry="${L.pill.h / 2 - 2}" width="${w - 4}" height="${L.pill.h - 4}" fill="#000" fill-opacity="0.72" stroke="#d9b45a" stroke-width="3"/>
     </svg>`
  );
  layers.push({ input: pill, left: Math.round(L.pill.cx - w / 2), top: Math.round(L.pill.cy - L.pill.h / 2) });
  layers.push(centered(txt, L.pill.cx, L.pill.cy, 1));
  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ MAN OF THE MATCH card (solo result) ═══
// p = { dp, name, runs, balls, fours, sixes, sr, wkts, bballs, eco } (bat or bowl part may be empty)
async function renderMotmCard(p) {
  needSharp();
  const L = MOTM_LAYOUT;
  const layers = [await dpLayer(p && p.dp, L.circle)];
  if (p && p.name) await putCentered(layers, cleanName(p.name), L.name.px, L.name.cx, L.name.cy, L.name.maxW, L.name.color);
  const batted = p && p.balls > 0;
  const bowled = p && p.bballs > 0;
  const top = batted ? [p.runs, p.balls, p.fours, p.sixes, fmt1(p.sr)] : ['-', '-', '-', '-', '-'];
  const bot = bowled ? [p.wkts, p.bballs, fmt1(p.eco)] : ['-', '-', '-'];
  for (let i = 0; i < 5; i++) await putCentered(layers, String(top[i]), L.px, L.top.xs[i], L.top.cy, L.top.w);
  for (let i = 0; i < 3; i++) await putCentered(layers, String(bot[i]), L.px, L.bot.xs[i], L.bot.cy, L.bot.w);
  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ TEAM FINAL card ═══
// A / B = { bat: {dp,name,runs,balls,fours,sixes,sr} | null, bowl: {dp,name,wkts,balls,eco} | null }
// info = { date, time, gc, barA, barB, winner, motm: {dp,name} | null }
async function renderTeamFinalCard({ A, B, info }) {
  needSharp();
  const L = TEAMFIN_LAYOUT;
  const layers = [];

  // date / time / group
  await putCentered(layers, info.date, L.top.px, L.top.date.cx, L.top.cy, L.top.date.w);
  await putCentered(layers, info.time, L.top.px, L.top.time.cx, L.top.cy, L.top.time.w);
  await putCentered(layers, cleanName(info.gc, 'GROUP'), L.top.px, L.top.gc.cx, L.top.cy, L.top.gc.w);

  // team bars (name + score)
  await putCentered(layers, info.barA, L.bar.px, L.bar.A.cx, L.bar.A.cy, L.bar.w);
  await putCentered(layers, info.barB, L.bar.px, L.bar.B.cx, L.bar.B.cy, L.bar.w);

  // best batsman / best bowler of each team
  for (const [label, team] of [['A', A], ['B', B]]) {
    const dy = L.rowDy[label];
    const bat = team && team.bat;
    const bowl = team && team.bowl;

    layers.push(await dpLayer(bat && bat.dp, L.bat.circle, dy, L.clipAboveY));
    if (bat && bat.name) await putCentered(layers, cleanName(bat.name), L.namePx, L.bat.name.cx, L.bat.name.cy + dy, L.bat.name.w);
    const bv = bat ? [bat.runs, bat.balls, bat.sixes, bat.fours, fmt1(bat.sr)] : ['-', '-', '-', '-', '-'];
    for (let i = 0; i < 5; i++) await putCentered(layers, String(bv[i]), L.valPx, L.bat.xs[i], L.bat.cy + dy, L.bat.ws[i]);

    layers.push(await dpLayer(bowl && bowl.dp, L.bowl.circle, dy, L.clipAboveY));
    if (bowl && bowl.name) await putCentered(layers, cleanName(bowl.name), L.namePx, L.bowl.name.cx, L.bowl.name.cy + dy, L.bowl.name.w);
    const wv = bowl ? [bowl.wkts, bowl.balls, fmt1(bowl.eco)] : ['-', '-', '-'];
    for (let i = 0; i < 3; i++) await putCentered(layers, String(wv[i]), L.valPx, L.bowl.xs[i], L.bowl.cy + dy, L.bowl.ws[i]);
  }

  // man of the match
  layers.push(await dpLayer(info.motm && info.motm.dp, L.motm.circle, 0, L.motm.clipAboveY));
  if (info.motm && info.motm.name) await putCentered(layers, cleanName(info.motm.name), L.namePx + 2, L.motm.name.cx, L.motm.name.cy, L.motm.name.w);

  // winner
  await putCentered(layers, info.winner, L.winner.px, L.winner.cx, L.winner.cy, L.winner.w, '#ffd54a');

  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ MATCH BANNER (host + Team A captain + Team B captain) ═══
async function renderMatchBanner({ hostDp, hostName, capA, capB }) {
  needSharp();
  const L = BANNER_LAYOUT;
  const layers = [
    await dpLayer(hostDp, L.host),
    await dpLayer(capA && capA.dp, L.A),
    await dpLayer(capB && capB.dp, L.B),
  ];
  const gold = '#ffe08a';
  if (hostName) await putCentered(layers, `@${cleanName(hostName)}`, L.nameHost.px, L.nameHost.cx, L.nameHost.cy, L.nameHost.w, gold);
  if (capA && capA.name) await putCentered(layers, `C  ${cleanName(capA.name)}`, L.nameA.px, L.nameA.cx, L.nameA.cy, L.nameA.w, gold);
  if (capB && capB.name) await putCentered(layers, `C  ${cleanName(capB.name)}`, L.nameB.px, L.nameB.cx, L.nameB.cy, L.nameB.w, gold);
  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

// ═══ PLAYERS LIST banner ("PLAYERS LIST - Let's Begin") - the template is sent as it is ═══
let playersBannerCache = null;
async function renderPlayersBanner() {
  if (playersBannerCache) return playersBannerCache;
  playersBannerCache = fs.readFileSync(path.join(ASSET_DIR, PLAYERS_LIST_FILE));
  return playersBannerCache;
}

// Which asset files can really be decoded? Used by /testcard and at startup.
async function assetReport() {
  const fs = require('fs');
  const out = [];
  for (const f of ['host.jpg', 'solo_final.jpg', 'team_final.jpg', 'team_banner.jpg', 'players_list.jpg', 'userinfo.jpg', 'default_dp.png']) {
    const file = path.join(ASSET_DIR, f);
    if (!fs.existsSync(file)) {
      out.push(`${f} — MISSING${f === 'default_dp.png' ? ' (a built-in avatar is used)' : ''}`);
      continue;
    }
    try {
      const meta = await sharp(file).metadata();
      await sharp(file).resize(8, 8, { fit: 'fill' }).raw().toBuffer(); // forces a real decode
      out.push(`${f} — OK ${meta.width}x${meta.height}`);
    } catch (e) {
      out.push(`${f} — INVALID (${e.message}) — re-upload the original file`);
    }
  }
  try {
    await renderText('Aa', 20);
    out.push('font — OK');
  } catch (e) {
    out.push(`font — PROBLEM (${e.message})`);
  }
  return out;
}

// ═══ /userinfo PROFILE CARD ═══
// userinfo.jpg (1469x1071): the empty CRIC MONSTER stats template (the printed "@" is already removed)
const USERCARD_LAYOUT = {
  file: 'userinfo.jpg',
  circle: { cx: 733, cy: 498, r: 121 },
  name: { cx: 734, cy: 651, maxW: 304, px: 46 },
  handle: { cx: 735, cy: 711, maxW: 250, px: 36 },
  level: { cx: 733, cy: 925, maxW: 200, px: 78 },
  px: 46,
  bat: {
    r1: { cy: 596, xs: [108, 238, 368, 497], w: 100 }, // TOTAL RUNS, BALLS, MATCH PLAYED, DUCK
    r2: { cy: 724, xs: [108, 238, 368, 497], w: 100 }, // FOURS, SIXES, STRIKE RATE, 50s / 100s
  },
  bowl: {
    r1: { cy: 596, xs: [970, 1094, 1228, 1366], w: 100 }, // WICKETS, HAT-TRICK, MATCH PLAYED, TOTAL BALLS
    r2: { cy: 724, xs: [994, 1167, 1344], w: 124 }, // 3W, 5W, ECONOMY
  },
};

// condensed, gold-gradient text with a dark outline (like the example card)
async function goldText(text, px, maxW, o = {}) {
  needSharp();
  const top = o.top || [255, 244, 204];
  const bottom = o.bottom || [232, 168, 58];
  const outline = o.outline || [40, 20, 0];
  const squeeze = o.squeeze || 0.8;
  const minPx = o.minPx || 16;
  const make = async (size) => {
    const base = await renderText(String(text), size, '#ffffff');
    const w = Math.max(1, Math.round(base.info.width * squeeze));
    return sharp(base.data).resize(w, base.info.height, { fit: 'fill' }).png().toBuffer({ resolveWithObject: true });
  };
  let size = px;
  let t = await make(size);
  while (t.info.width + 8 > maxW && size > minPx) {
    size -= 2;
    t = await make(size);
  }
  const { data, info } = await sharp(t.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const recolor = (fn) => {
    const out = Buffer.alloc(data.length);
    for (let y = 0; y < info.height; y++) {
      const f = info.height > 1 ? y / (info.height - 1) : 0;
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 4;
        const c = fn(f);
        out[i] = c[0];
        out[i + 1] = c[1];
        out[i + 2] = c[2];
        out[i + 3] = data[i + 3];
      }
    }
    return sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  };
  const gold = await recolor((f) => [0, 1, 2].map((k) => Math.round(top[k] * (1 - f) + bottom[k] * f)));
  const dark = await recolor(() => outline);
  const pad = 4;
  const layers = [];
  for (let dx = -2; dx <= 2; dx++)
    for (let dy = -2; dy <= 2; dy++) if ((dx || dy) && dx * dx + dy * dy <= 5) layers.push({ input: dark, left: pad + dx, top: pad + dy });
  layers.push({ input: dark, left: pad + 1, top: pad + 3 }); // soft drop shadow
  layers.push({ input: gold, left: pad, top: pad });
  return sharp({
    create: { width: info.width + pad * 2, height: info.height + pad * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(layers)
    .png()
    .toBuffer({ resolveWithObject: true });
}

// p = { dp, name, handle, level, bat: {runs, balls, matches, ducks, fours, sixes, sr, fifties, hundreds},
//       bowl: {wkts, hattricks, matches, balls, w3, w5, eco} }
async function renderUserCard(p) {
  needSharp();
  const L = USERCARD_LAYOUT;
  const layers = [await dpLayer(p.dp, L.circle)];
  const put = async (txt, cx, cy, maxW, px, opts) => {
    if (txt === undefined || txt === null || txt === '') return;
    layers.push(centered(await goldText(String(txt), px, maxW, opts), cx, cy, 0));
  };
  await put(String(p.name || 'PLAYER').toUpperCase(), L.name.cx, L.name.cy, L.name.maxW, L.name.px);
  await put(p.handle, L.handle.cx, L.handle.cy, L.handle.maxW, L.handle.px, {
    top: [255, 250, 235], bottom: [240, 226, 190], outline: [10, 6, 2], squeeze: 0.84,
  });
  await put(p.level, L.level.cx, L.level.cy, L.level.maxW, L.level.px);

  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const b = p.bat || {};
  const w = p.bowl || {};
  const batVals1 = [n(b.runs), n(b.balls), n(b.matches), n(b.ducks)];
  const batVals2 = [n(b.fours), n(b.sixes), (b.sr || 0).toFixed(2), `${b.fifties || 0} / ${b.hundreds || 0}`];
  const bowlVals1 = [n(w.wkts), n(w.hattricks), n(w.matches), n(w.balls)];
  const bowlVals2 = [n(w.w3), n(w.w5), (w.eco || 0).toFixed(2)];
  for (let i = 0; i < 4; i++) {
    await put(batVals1[i], L.bat.r1.xs[i], L.bat.r1.cy, L.bat.r1.w, L.px);
    await put(batVals2[i], L.bat.r2.xs[i], L.bat.r2.cy, L.bat.r2.w, L.px);
    await put(bowlVals1[i], L.bowl.r1.xs[i], L.bowl.r1.cy, L.bowl.r1.w, L.px);
  }
  for (let i = 0; i < 3; i++) await put(bowlVals2[i], L.bowl.r2.xs[i], L.bowl.r2.cy, L.bowl.r2.w, L.px);

  return sharp(path.join(ASSET_DIR, L.file)).composite(layers).jpeg({ quality: 90 }).toBuffer();
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
const dpCache = new Map(); // userId -> { buf, at }
const DP_TTL_MS = 30 * 60 * 1000;
async function getUserDp(telegram, userId) {
  if (Number(userId) <= -1001) return null; // bot players have no photo
  const hit = dpCache.get(String(userId));
  if (hit && Date.now() - hit.at < (hit.buf ? DP_TTL_MS : 5 * 60 * 1000)) return hit.buf;
  const buf = await getUserDpFresh(telegram, userId);
  dpCache.set(String(userId), { buf, at: Date.now() });
  if (dpCache.size > 300) dpCache.delete(dpCache.keys().next().value);
  return buf;
}
async function getUserDpFresh(telegram, userId) {
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
// ─── tabulate "fancy_grid" style tables (monospace, shown inside ``` blocks) ───
function fancyGrid(headers, rows) {
  const all = [headers, ...rows].map((r) => r.map((c) => String(c)));
  const len = (c) => [...c].length;
  const w = headers.map((_, i) => Math.max(...all.map((r) => len(r[i]))));
  const cell = (c, i) => (i === 0 ? ' ' + c + ' '.repeat(w[i] - len(c) + 1) : ' '.repeat(w[i] - len(c) + 1) + c + ' ');
  const bar = (l, m, r, ch) => l + w.map((n) => ch.repeat(n + 2)).join(m) + r;
  const row = (r) => '│' + r.map(cell).join('│') + '│';
  const out = [bar('╒', '╤', '╕', '═'), row(all[0]), bar('╞', '╪', '╡', '═')];
  all.slice(1).forEach((r, i) => {
    if (i > 0) out.push(bar('├', '┼', '┤', '─'));
    out.push(row(r));
  });
  out.push(bar('╘', '╧', '╛', '═'));
  return out.join('\n');
}
// full name when it fits; otherwise only the first word (first name); last resort: cut at 11 letters
const tblName = (p) => {
  const full = cleanName((p && (p.username || p.first_name)) || '', 'Player').trim() || 'Player';
  if (full.length <= 11) return full;
  const first = full.split(/\s+/)[0];
  return first.length <= 11 ? first : first.slice(0, 11);
};
const gridBlock = (headers, rows) => '```\n' + fancyGrid(headers, rows) + '\n```\n';

// PRESSURE bar while chasing (needs runs vs balls left + wickets lost), 20 slots like [IIIIIIIIIIIIIIII.   ]
function pressureBar(need, ballsLeft, wicketsLost, maxWickets) {
  const rrr = ballsLeft > 0 ? (need * 6) / ballsLeft : 99;
  const p = Math.min(1, rrr / 14) * 0.75 + Math.min(1, wicketsLost / Math.max(1, maxWickets)) * 0.25;
  const k = Math.max(0, Math.min(20, Math.round(p * 20)));
  return 'I'.repeat(k) + (k < 20 ? '.' + ' '.repeat(19 - k) : '');
}

// ═════════════════ NATIVE TABLE SCOREBOARD (Bot API 10.1 sendRichMessage) ═════════════════
const RICH_TABLES = process.env.RICH_TABLES !== '0'; // RICH_TABLES=0 -> always use the old text scoreboard
let richWarned = false;
const hEsc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const richName = (p) => hEsc([p?.first_name, p?.last_name].filter(Boolean).join(' ').trim() || p?.username || 'Player');

async function sendRich(telegram, chatId, html, extra = {}) {
  const tries = [];
  if (PREMIUM_TEXT) tries.push(premiumizeHtml(html, 60));
  tries.push(stripPe(html));
  let last;
  for (const h of tries) {
    try {
      return await telegram.callApi('sendRichMessage', { chat_id: chatId, rich_message: { html: h }, ...extra });
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

const batCell = (runs, balls, fours, sixes) =>
  `${runs} runs | ${balls} ball | ${sixes} six | ${fours} four | ${balls > 0 ? ((runs * 100) / balls).toFixed(1) : '0.0'} strike rate`;
const richTable = (headers, rows) =>
  `<table bordered striped><tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>` +
  rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('') +
  `</table>`;

// returns html, or null when there is nothing to show as a table (not started / finished)
async function scoreboardRich(matchId) {
  const match = await getMatch(matchId);
  if (!match || ['completed', 'cancelled'].includes(match.status)) return null;
  const inn = await getInnings(matchId);
  if (!inn) return null;
  const isSolo = match.mode === 'solo';
  const totalOvers = match.total_overs || DEFAULT_OVERS;

  const striker = await getPlayer(inn.striker_player_id);
  const non = await getPlayer(inn.non_striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);
  const { rows: bsRows } = await q(`SELECT * FROM batting_stats WHERE innings_id=$1`, [inn.id]);
  const { rows: wsRows } = await q(`SELECT * FROM bowling_stats WHERE innings_id=$1`, [inn.id]);
  const bmap = new Map(bsRows.map((r) => [r.player_id, r]));
  const wmap = new Map(wsRows.map((r) => [r.player_id, r]));

  let h = `<p><b>🏏 ${hEsc(fancy('SCORECARD'))}</b>  ·  Innings ${inn.innings_number}</p>`;

  // summary quote
  const pen = match.penalty_log ? String(match.penalty_log).split('\n').filter(Boolean) : [];
  if (isSolo) {
    const crr = inn.balls_bowled > 0 ? ((inn.total_runs * 6) / inn.balls_bowled).toFixed(2) : '0.00';
    h += `<blockquote><p>🏏 Score: <b>${inn.total_runs}/${inn.total_wickets}</b></p><p>⏱ Balls: <b>${inn.balls_bowled}</b></p><p>📈 RR: <b>${crr}</b></p>` +
      pen.map((l) => `<p>⚖️ ${hEsc(l)}</p>`).join('') + `</blockquote>`;
  } else {
    const { rows: all } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [match.id]);
    const line = (label) => {
      const i = all.find((x) => x.batting_team === label);
      const runs = i ? i.total_runs : 0;
      const wk = i ? i.total_wickets : 0;
      const balls = i ? i.balls_bowled : 0;
      const crr = balls > 0 ? ((runs * 6) / balls).toFixed(2) : '0.0';
      const icon = label === inn.batting_team ? '🏏' : '🎳';
      return `<p>${icon} Team ${label} | <b>${runs}/${wk}</b> | ${oversStr(balls)}/${totalOvers} overs</p><p>📈 CRR: ${crr}</p>`;
    };
    h += `<blockquote>${line('A')}${line('B')}` + pen.map((l) => `<p>⚖️ ${hEsc(l)}</p>`).join('') + `</blockquote>`;
  }

  // batting table
  if (isSolo) {
    const players = await getPlayers(match.id, 'A');
    const rows = players
      .map((p) => ({ p, r: bmap.get(p.id) }))
      .filter((x) => x.r || (striker && x.p.id === striker.id))
      .sort((a, b) => (b.r?.runs || 0) - (a.r?.runs || 0))
      .slice(0, 12)
      .map(({ p, r }) => {
        const mark = striker && p.id === striker.id ? '🏃 ' : r?.is_out ? '❌ ' : '';
        return [mark + richName(p), batCell(r?.runs || 0, r?.balls_faced || 0, r?.fours || 0, r?.sixes || 0)];
      });
    h += `<p><b>PLAYERS</b></p>`;
    if (rows.length) h += richTable(['Name', 'Score'], rows);
    if (bowler) h += `<p>🎳 Bowler: <b>${richName(bowler)}</b></p>`;
  } else {
    const batters = await getPlayers(match.id, inn.batting_team);
    const bowlers = await getPlayers(match.id, inn.bowling_team);
    const batRows = [];
    for (const p of batters) {
      const r = bmap.get(p.id);
      const isStr = striker && p.id === striker.id;
      const isNon = non && p.id === non.id;
      if (!r && !isStr && !isNon) continue;
      const mark = isStr ? '🏃 ' : isNon ? '🏏 ' : r?.is_out ? '❌ ' : '';
      batRows.push([mark + richName(p), batCell(r?.runs || 0, r?.balls_faced || 0, r?.fours || 0, r?.sixes || 0)]);
    }
    h += `<p><b>TEAM ${inn.batting_team} PLAYERS</b></p>`;
    if (batRows.length) h += richTable(['Name', 'Score'], batRows);
    if (!striker) h += `<p>⏳ waiting for the batting captain: /bat &lt;no.&gt;</p>`;

    const bowlRows = [];
    for (const p of bowlers) {
      const r = wmap.get(p.id);
      const bb = r?.balls_bowled || 0;
      const isCur = bowler && p.id === bowler.id;
      if (bb === 0 && !isCur) continue;
      const conc = r?.runs_conceded || 0;
      bowlRows.push([
        (isCur ? '🎳 ' : '') + richName(p),
        `${oversStr(bb)} overs | ${conc} runs | ${r?.wickets || 0} wkt | ${bb > 0 ? ((conc * 6) / bb).toFixed(1) : '0.0'} econ`,
      ]);
    }
    h += `<p><b>TEAM ${inn.bowling_team} BOWLERS</b></p>`;
    if (bowlRows.length) h += richTable(['Name', 'Overs'], bowlRows);
    if (!bowler) h += `<p>⏳ waiting for the bowling captain: /ball &lt;no.&gt;</p>`;

    if (match.target && inn.innings_number === 2) {
      const need = Math.max(0, match.target - inn.total_runs);
      const left = Math.max(0, totalOvers * 6 - inn.balls_bowled);
      const bar = pressureBar(need, left, inn.total_wickets || 0, Math.max(1, batters.length - 1));
      h += `<p>• Chasing Target <b>${match.target}</b> — <b>${need}</b> runs need from <b>${left}</b> balls</p>`;
      h += `<blockquote><p>PRESSURE <code>[${bar}]</code></p></blockquote>`;
    }
  }

  h += `<p>💡 Bowler: 1–6 in bot DM · Batsman: 0–6 in group (0 = dot)</p>`;
  h += `<p>⏱ ${TURN_SECONDS}s to respond, otherwise -${TURN_PENALTY} runs</p>`;
  return h;
}

// native table scoreboard; falls back to the old text scoreboard if Telegram refuses it
async function sendScoreboard(telegram, chatId, matchId) {
  if (RICH_TABLES) {
    try {
      const html = await scoreboardRich(matchId);
      if (html) {
        await sendRich(telegram, chatId, html);
        return;
      }
    } catch (e) {
      if (!richWarned) {
        richWarned = true;
        console.error('rich scoreboard failed, using the text scoreboard:', e.message);
      }
    }
  }
  await telegram.sendMessage(chatId, await scoreboard(matchId), { parse_mode: 'Markdown' });
}

async function scoreboard(matchId) {
  const match = await getMatch(matchId);
  if (!match) return '❌ Match not found';

  const inn = await getInnings(matchId);
  const isSolo = match.mode === 'solo';

  let t = `${pe('bat','🏏')} *${fancy('CRIC MONSTER')}*\n`;

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
    ? `⏱ Balls: *${inn.balls_bowled}*\n`
    : `⏱ Overs: *${oversStr(inn.balls_bowled)} / ${totalOvers}*\n`;
  t += `📈 RR: *${crr}*\n`;
  if (match.penalty_log) {
    for (const pl of String(match.penalty_log).split('\n').filter(Boolean)) {
      t += `⚖️ *${mdEsc(pl)}*\n`;
    }
  }

  if (match.target && inn.innings_number === 2) {
    const need = Math.max(0, match.target - inn.total_runs);
    t += `🎯 Target: *${match.target}*  (Need *${need}*)\n`;
  }

  const striker = await getPlayer(inn.striker_player_id);
  const non = await getPlayer(inn.non_striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);

  t += `\n${line()}\n`;
  if (striker) t += `${pe('batsman','🏃')} Striker   ${mn(striker)}\n`;
  if (!isSolo && non) t += `${pe('batsman','🏏')} Non-strike ${mn(non)}\n`;
  if (bowler) t += `${pe('bowler','🎳')} Bowler    ${mn(bowler)}\n`;
  if (isSolo) {
    const { rows: bsr } = await q(
      `SELECT bs.*, mp.username, mp.first_name FROM batting_stats bs JOIN match_players mp ON mp.id = bs.player_id
        WHERE bs.innings_id=$1 ORDER BY bs.runs DESC, bs.balls_faced ASC LIMIT 12`,
      [inn.id]
    );
    if (bsr.length) {
      const rowsT = bsr.map((r) => [
        tblName(r) + (striker && r.player_id === striker.id ? '*' : r.is_out ? '-' : ''),
        `${r.runs || 0}(${r.balls_faced || 0})`,
        `${r.fours || 0}/${r.sixes || 0}`,
        r.balls_faced > 0 ? ((r.runs * 100) / r.balls_faced).toFixed(1) : '0.0',
      ]);
      t += `\n*${fancy('PLAYERS')}*\n` + gridBlock(['Name', 'R(B)', '4/6', 'SR'], rowsT) + `\\* on strike   - out\n`;
    }
  }

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
      if (striker && p.id === striker.id) icon = '🏃';
      else if (non && p.id === non.id) icon = '🏏';
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
  t += `\n💡 Bowler: *1–6* in bot DM · Batsman: *0–6* in group (0 = dot)`;
  t += `\n⏱ ${TURN_SECONDS}s to respond, otherwise -${TURN_PENALTY} runs`;

  return t;
}

// remember every user the bot sees (needed to resolve @usernames in /add_a /add_b)
const seenUsers = new Map();
bot.use(async (ctx, next) => {
  try {
    const u = ctx.from;
    if (u && !u.is_bot) {
      const sig = `${u.username || ''}|${u.first_name || ''}`;
      if (seenUsers.get(u.id) !== sig) {
        seenUsers.set(u.id, sig);
        await upsertUser(u).catch(() => {});
      }
    }
  } catch (_) {}
  return next();
});

// ─── Team scoreboard (CricketMania style) ───────────────
async function hostLabel(m) {
  const { rows } = await q(`SELECT username, first_name, last_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
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
    const icon = label === inn.batting_team ? '🏏' : '🎳';
    return `${icon} Team ${label} | *${runs}/${wk}* | ${oversStr(balls)}/${totalOvers} overs\n📈 CRR: ${crr}`;
  };

  const quote = (txt) => String(txt).split('\n').map((l) => `> ${l}`).join('\n');
  let t = `🏏 *${fancy('SCORECARD')}*\n`;
  let top = `${teamLine('A')}\n\n${teamLine('B')}`;
  if (match.penalty_log) {
    top += '\n\n' + String(match.penalty_log).split('\n').filter(Boolean).map((l) => '⚖️ ' + l).join('\n');
  }
  t += quote(top) + '\n';

  const striker = await getPlayer(inn.striker_player_id);
  const non = await getPlayer(inn.non_striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);

  const batters = await getPlayers(match.id, inn.batting_team);
  const bowlersAll = await getPlayers(match.id, inn.bowling_team);
  const { rows: bsRows } = await q(`SELECT * FROM batting_stats WHERE innings_id=$1`, [inn.id]);
  const { rows: wsRows } = await q(`SELECT * FROM bowling_stats WHERE innings_id=$1`, [inn.id]);
  const bmap = new Map(bsRows.map((r) => [r.player_id, r]));
  const wmap = new Map(wsRows.map((r) => [r.player_id, r]));

  const batRows = [];
  for (const p of batters) {
    const r = bmap.get(p.id);
    const isStr = striker && p.id === striker.id;
    const isNon = non && p.id === non.id;
    if (!r && !isStr && !isNon) continue;
    const runs = r?.runs || 0;
    const balls = r?.balls_faced || 0;
    batRows.push([
      tblName(p) + (isStr ? '*' : r?.is_out ? '-' : ''),
      `${runs}(${balls})`,
      `${r?.fours || 0}/${r?.sixes || 0}`,
      balls > 0 ? ((runs * 100) / balls).toFixed(1) : '0.0',
    ]);
  }
  t += `\n*${fancy('TEAM ' + inn.batting_team + ' PLAYERS')}*\n`;
  if (batRows.length) t += gridBlock(['Name', 'R(B)', '4/6', 'SR'], batRows) + `\\* on strike   - out\n`;
  if (!striker) t += `⏳ waiting for the batting captain: /bat <no.>\n`;

  const bowlRows = [];
  for (const p of bowlersAll) {
    const r = wmap.get(p.id);
    const bb = r?.balls_bowled || 0;
    const isCur = bowler && p.id === bowler.id;
    if (bb === 0 && !isCur) continue;
    bowlRows.push([
      tblName(p) + (isCur ? '*' : ''),
      oversStr(bb),
      r?.runs_conceded || 0,
      r?.wickets || 0,
      bb > 0 ? (((r?.runs_conceded || 0) * 6) / bb).toFixed(1) : '0.0',
    ]);
  }
  t += `\n*${fancy('TEAM ' + inn.bowling_team + ' BOWLERS')}*\n`;
  if (bowlRows.length) t += gridBlock(['Name', 'O', 'R', 'W', 'Eco'], bowlRows);
  if (!bowler) t += `⏳ waiting for the bowling captain: /ball <no.>\n`;

  // chasing: target line + PRESSURE bar (only in the 2nd innings)
  if (match.target && inn.innings_number === 2) {
    const need = Math.max(0, match.target - inn.total_runs);
    const left = Math.max(0, totalOvers * 6 - inn.balls_bowled);
    const bar = pressureBar(need, left, inn.total_wickets || 0, Math.max(1, batters.length - 1));
    t += `\n• Chasing Target *${match.target}* — *${need}* runs need from *${left}* balls\n`;
    t += `> PRESSURE \`[${bar}]\`\n`;
  }

  t += `\n🎮 Game Host - ${await hostLabel(match)}\n`;
  t += `⏱ ${TURN_SECONDS}s to respond, otherwise -${TURN_PENALTY} runs`;
  return t;
}

// ─── Team lists with markers ([🧢] captain, ❌ out, 🏃 batting, 🎯 bowling) ───
// "@username (First Last)" - or just the name / the username / the id, whatever exists
function handleOf(p) {
  if (!p) return '—';
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  if (p.username && full) return `@${p.username} (${full})`;
  if (p.username) return `@${p.username}`;
  if (full) return full;
  const id = p.telegram_id ?? p.id;
  return id != null ? String(id) : '—';
}
const playerTag = (p) => mdEsc(handleOf(p));

// ┣ 1. @user (Name) [🧢]  ... ┗ last
function rosterBlock(players, markOf = () => '') {
  if (!players.length) return `  _(empty)_\n`;
  let t = '';
  players.forEach((p, i) => {
    const branch = i === players.length - 1 ? '┗' : '┣';
    t += `${branch} ${p.roster_position}. ${playerTag(p)}${markOf(p)}\n`;
  });
  return t;
}

// Players-list banner ("Let's Begin") with the text as caption. Telegram captions stop at 1024
// characters, so whatever does not fit goes into a follow-up message.
async function sendPlayersListPhoto(telegram, chatId, text) {
  const lines = String(text).split('\n');
  let cap = '';
  let i = 0;
  for (; i < lines.length; i++) {
    if ((cap + lines[i] + '\n').length > 1000) break;
    cap += lines[i] + '\n';
  }
  const rest = lines.slice(i).join('\n');
  try {
    const img = await renderPlayersBanner();
    await telegram.sendPhoto(chatId, { source: img }, { caption: cap.trim() || '📋', parse_mode: 'Markdown' });
  } catch (e) {
    await reportCardError('Players banner', e);
    await sendLong(telegram, chatId, text);
    return;
  }
  if (rest.trim()) await sendLong(telegram, chatId, rest);
}

async function rosterText(match) {
  const inn = await getInnings(match.id);
  const isSolo = match.mode === 'solo';
  const { rows: allInn } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [match.id]);
  const { rows: outs } = await q(
    `SELECT DISTINCT bs.player_id FROM batting_stats bs JOIN innings i ON i.id=bs.innings_id
      WHERE i.match_id=$1 AND bs.is_out`,
    [match.id]
  );
  const outSet = new Set(outs.map((r) => r.player_id));
  let t = '';
  for (const L of isSolo ? ['A'] : ['A', 'B']) {
    const team = await getTeam(match.id, L);
    const pl = await getPlayers(match.id, L);
    const i = allInn.find((x) => x.batting_team === L);
    const score = i ? `${i.total_runs}/${i.total_wickets} (${oversStr(i.balls_bowled)} ov)` : '0/0 (0.0 ov)';
    t += isSolo
      ? `🎮 *PLAYERS* (${pl.length})\n`
      : `${L === 'A' ? '🅰' : '🅱'} *TEAM ${L}* - ${score}\n`;
    if (match.status === 'waiting') t += `⎣ _Joining..._\n`;
    const markOf = (p) => {
      let mark = '';
      if (!isSolo && team?.captain_id && Number(p.telegram_id) === Number(team.captain_id)) mark += ' [🧢]';
      if (outSet.has(p.id)) mark += ' ❌';
      if (inn && (p.id === inn.striker_player_id || p.id === inn.non_striker_player_id)) mark += ' 🏃';
      if (inn && p.id === inn.current_bowler_id) mark += ' 🎳';
      return mark;
    };
    t += rosterBlock(pl, markOf);
    t += '\n';
  }
  return t;
}

function statusLabel(m) {
  if (m.status === 'waiting') return 'Joining';
  if (m.status === 'captains') return 'Choosing captains';
  if (m.status === 'toss') return m.setup_phase === 'overs' ? 'Choosing overs' : m.setup_phase === 'choice' ? 'Toss won - bat or ball' : 'Toss';
  if (m.status === 'innings1' || m.status === 'innings2') return `Live — Innings ${inningsWord(m.current_innings || 1)}`;
  if (m.status === 'completed') return 'Completed';
  return 'Cancelled';
}

// /members and /team: MATCH OVERVIEW with a generated PLAYERS LIST banner
async function sendMembers(ctx, m) {
  const started = ['innings1', 'innings2', 'completed'].includes(m.status);
  const caption =
    `📊 *${fancy('MATCH OVERVIEW')}*\n` +
    `> ${pe('crown','👑')} Host: ${await hostLabel(m)}\n` +
    `> ⏳ Overs: *${started ? m.total_overs : 'None'}* | 🔄 *${statusLabel(m)}*`;
  await sendPlayersListPhoto(ctx.telegram, ctx.chat.id, caption + '\n\n' + (await rosterText(m)));
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
  const { rows } = await q(`SELECT username, first_name, last_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
  const host = rows[0] || {};
  const caption =
    `⚙ Overs — *${m.total_overs}*  |  Innings — *${inningsWord(m.current_innings || 1)}*\n` +
    `🏏 Batting — *Team ${m.current_batting_team}*\n` +
    `🎳 Bowling — *Team ${m.current_bowling_team}*` +
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
      `║  🏏 CRIC MONSTER     ║\n` +
      `╚══════════════════════╝\n\n` +
      `Create a match in a group.\n` +
      `Press /start here first (needed for bowling in DM).\n\n` +
      `*Solo* → everyone bats until OUT, type *0–6* to bat\n` +
      `*Team* → /team → /startgame → captains, toss, /setovers\n\n` +
      `Bowling: send *1–6* in bot DM (0 not allowed)\n` +
      `Batting: type *0–6* in group (0 = dot ball)`,
    { parse_mode: 'Markdown', ...mainKb() }
  );
});

// ─── Permanent result GIFs ────────────────────────────────────────────────
// Reply to a GIF with /pgif <event>. Saved in PostgreSQL permanently.
//  0-6        → runs scored (0 = dot ball)            out       → wicket            dugout → duck out (out for 0)
//  stance     → batsman takes stance   runup     → bowler runs in    batentry → new batsman walks in
//  starter    → match started (fielding GIF)   opener → openers are ready
//  bowlentry  → new bowler comes       (old names newbatsman / newbowler / runnerup still work)
const PGIF_ALIASES = {
  dot: '0',
  duck: 'dugout',
  newbowler: 'bowlentry',
  bowlerentry: 'bowlentry',
  newbatsman: 'batentry',
  batsmanentry: 'batentry',
  runnerup: 'runup',
  fielding: 'starter',
  starting: 'starter',
  startfielding: 'starter',
  fifty: '50',
  century: '100',
  hundred: '100',
  '150': '150',
  '200': '200',
  doublecentury: '200',
  threew: '3w',
  '3wickets': '3w',
  fifer: '5fer',
  fivefer: '5fer',
  '5w': '5fer',
  fivew: '5fer',
  '5wickets': '5fer',
  hattrick: 'hatrick',
  duckout: 'dugout',
  'duck-out': 'dugout',
  'duck_out': 'dugout',
  mom: 'motm',
  manofthematch: 'motm',
  'man-of-the-match': 'motm',
  'man_of_the_match': 'motm',
};
const PGIF_KEYS = new Set([
  '0', '1', '2', '3', '4', '5', '6', 'out', 'dugout', 'stance', 'runup', 'batentry', 'bowlentry',
  'starter', 'opener', 'toss', '50', '100', '150', '200', '3w', '5fer', 'hatrick', 'motm',
]);
const PGIF_LEGACY = { batentry: 'newbatsman', bowlentry: 'newbowler', dugout: 'duck', duck: 'dugout', dot: '0', '5w': '5fer' }; // dugout also checks old 'duck' row
const PGIF_LABELS = {
  0: 'DOT BALL',
  dot: 'DOT BALL',
  50: 'FIFTY',
  100: 'CENTURY',
  150: '150 RUNS',
  200: 'DOUBLE CENTURY',
  '3w': '3 WICKETS',
  '5fer': 'FIVE-WICKET HAUL',
  hatrick: 'HAT-TRICK',
  toss: 'TOSS',
  starter: 'MATCH STARTER (fielding)',
  opener: 'OPENERS READY',
  out: 'WICKET',
  dugout: 'DUCK OUT',
  stance: 'BATSMAN STANCE',
  runup: 'BOWLER RUN-UP',
  batentry: 'BATSMAN ENTRY',
  bowlentry: 'BOWLER ENTRY',
  motm: 'MAN OF THE MATCH',
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
    let rawKey = String(parts[1] || '').toLowerCase();
    // /pgif remove <key>  or  /pgif rm <key>
    if (rawKey === 'remove' || rawKey === 'rm' || rawKey === 'delete' || rawKey === 'del') {
      if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Only a group admin or bot owner can remove GIFs.');
      const rk = String(parts[2] || '').toLowerCase();
      const key = PGIF_ALIASES[rk] || rk;
      if (!rk || !PGIF_KEYS.has(key))
        return ctx.reply('Usage: `/pgif remove <key>`\nExample: `/pgif remove 50`\nSee keys: /giflist', { parse_mode: 'Markdown' });
      const leg = PGIF_LEGACY[key];
      const { rowCount } = await q(
        `DELETE FROM public.pgif_settings WHERE result_key = $1 OR result_key = $2`,
        [key, leg || key]
      );
      if (!rowCount) return ctx.reply(`❌ No GIF saved for *${key}*`, { parse_mode: 'Markdown' });
      const label = PGIF_LABELS[key] || key;
      return ctx.reply(`🗑️ Removed GIF for *${mdEsc(label)}* (\`${key}\`)`, { parse_mode: 'Markdown' });
    }
    const key = PGIF_ALIASES[rawKey] || rawKey;
    if (!PGIF_KEYS.has(key))
      return ctx.reply(
        'Reply to a GIF with:\n/pgif 0 (or /pgif dot) … /pgif 6 · /pgif out · /pgif dugout (duck out)\n/pgif stance · /pgif runup · /pgif batentry · /pgif bowlentry\n/pgif starter · /pgif opener · /pgif toss\n/pgif 50 · /pgif 100 · /pgif 150 · /pgif 200 · /pgif 3w · /pgif 5w · /pgif hatrick · /pgif motm\n\nRemove: /pgif remove <key>  or  /rmgif <key>'
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

// key can be one key or a list (first key with a saved GIF wins)
async function getPgif(key) {
  const ck = Array.isArray(key) ? key.join('|') : String(key);
  const hit = pgifCache.get(ck);
  if (hit && Date.now() - hit.at < PGIF_TTL_MS) return hit.v;
  const v = await getPgifUncached(key);
  pgifCache.set(ck, { v, at: Date.now() });
  return v;
}
async function getPgifUncached(key) {
  for (const k of Array.isArray(key) ? key : [key]) {
    const legacy = PGIF_LEGACY[k] || k;
    const { rows } = await q(
      'SELECT file_id, media_type FROM public.pgif_settings WHERE result_key IN ($1,$2) ORDER BY (result_key=$1) DESC LIMIT 1',
      [String(k), String(legacy)]
    );
    if (rows[0]) return rows[0];
  }
  // media saved with /setmedia <key> (photo, video, GIF ... that can carry a caption)
  try {
    for (const k of Array.isArray(key) ? key : [key]) {
      const { rows } = await q(
        `SELECT file_id, media_type FROM bot_media WHERE media_key=$1 AND media_type IN ('animation','video','document','photo','audio','voice')`,
        [String(k)]
      );
      if (rows[0]) return rows[0];
    }
  } catch (_) {}
  return null;
}

async function sendGifFile(telegram, chatId, gif, opts) {
  if (gif.media_type === 'photo') return telegram.sendPhoto(chatId, gif.file_id, opts);
  if (gif.media_type === 'audio') return telegram.sendAudio(chatId, gif.file_id, opts);
  if (gif.media_type === 'voice') return telegram.sendVoice(chatId, gif.file_id, opts);
  if (gif.media_type === 'document') return telegram.sendDocument(chatId, gif.file_id, opts);
  if (gif.media_type === 'video') return telegram.sendVideo(chatId, gif.file_id, opts);
  return telegram.sendAnimation(chatId, gif.file_id, opts);
}

// Decorative GIF only (nothing is sent when no GIF is saved). Returns true when sent.
async function sendResultGif(telegram, chatId, key, replyToMessageId, caption = '') {
  try {
    const gif = await getPgif(key);
    if (!gif) return false;
    await sendGifFile(telegram, chatId, gif, {
      reply_to_message_id: replyToMessageId,
      allow_sending_without_reply: true,
      ...(caption ? { caption, parse_mode: 'HTML' } : {}),
    });
    return true;
  } catch (e) {
    console.error(`Could not send pgif ${key}:`, e.message);
    return false;
  }
}

// A message that MUST be delivered: GIF + HTML caption when a GIF is saved for `key`, otherwise the same text.
// `extra` may hold reply_markup / reply_to_message_id. Returns the sent message.
async function sendCaptionedGif(telegram, chatId, key, html, extra = {}) {
  const keys = Array.isArray(key) ? key : [key];
  try {
    const gif = await getPgif(keys);
    if (gif) {
      return await sendGifFile(telegram, chatId, gif, {
        caption: html,
        parse_mode: 'HTML',
        allow_sending_without_reply: true,
        ...extra,
      });
    }
  } catch (e) {
    console.error(`Could not send pgif ${keys.join(',')}:`, e.message);
  }
  try {
    return await telegram.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      allow_sending_without_reply: true,
      ...extra,
    });
  } catch (e2) {
    // reply_to may be gone — send without it
    const { reply_to_message_id, ...rest } = extra || {};
    return telegram.sendMessage(chatId, html, { parse_mode: 'HTML', ...rest });
  }
}

// HTML mention

// MOTM celebration GIF (set with /pgif motm)
async function sendMotmGif(telegram, chatId, motmPlayer) {
  if (!motmPlayer) return false;
  const html =
    `${pe('trophy','🏅')} <b>${fancy('MAN OF THE MATCH')}</b>\n` +
    `${pe('ok','🎊')} Congratulations ${htag(motmPlayer)}!\n` +
    `<blockquote>${escapeHtml(String(motmPlayer.runs || 0))} run${Number(motmPlayer.runs) === 1 ? '' : 's'}` +
    (motmPlayer.wkts ? ` · ${motmPlayer.wkts} wicket${Number(motmPlayer.wkts) === 1 ? '' : 's'}` : '') +
    `</blockquote>`;
  return sendCaptionedGif(telegram, chatId, 'motm', html);
}

// Ordered list for /giflist and /showgif
const PGIF_LIST_ORDER = [
  '0', '1', '2', '3', '4', '5', '6',
  'out', 'dugout',
  'stance', 'runup', 'batentry', 'bowlentry',
  'starter', 'opener', 'toss',
  '50', '100', '150', '200',
  '3w', '5fer', 'hatrick', 'motm',
];

bot.command('giflist', async (ctx) => {
  try {
    const { rows } = await q(`SELECT result_key FROM public.pgif_settings`);
    const have = new Set(rows.map((r) => String(r.result_key)));
    // also count legacy keys (and reverse: old duck row counts as dugout)
    for (const [k, leg] of Object.entries(PGIF_LEGACY)) {
      if (have.has(leg)) have.add(k);
      if (have.has(k)) have.add(leg);
    }
    if (have.has('duck')) have.add('dugout');
    let ok = 0;
    const lines = [];
    for (const key of PGIF_LIST_ORDER) {
      const label = PGIF_LABELS[key] || key;
      // resolve via aliases already stored as canonical key
      const set = have.has(key) || (PGIF_LEGACY[key] && have.has(PGIF_LEGACY[key]));
      if (set) ok += 1;
      lines.push(`${set ? '✅' : '❌'} <code>${key}</code> — ${escapeHtml(label)}`);
    }
    const total = PGIF_LIST_ORDER.length;
    const html =
      `🎞️ <b>${fancy('GIF LIST')}</b>\n` +
      `<blockquote>${ok}/${total} configured</blockquote>\n` +
      lines.join('\n') +
      `\n\nSet missing ones: reply to a GIF with <code>/pgif &lt;key&gt;</code>\n` +
      `Admin: <code>/showgif</code> preview · <code>/rmgif &lt;key&gt;</code> remove`;
    await ctx.reply(html, { parse_mode: 'HTML' });
  } catch (e) {
    console.error('giflist', e);
    await ctx.reply('❌ ' + e.message);
  }
});


bot.command(['rmgif', 'ungif', 'delgif'], async (ctx) => {
  try {
    if (!(await canConfigurePgif(ctx)))
      return ctx.reply('❌ Only group admin / bot owner can remove GIFs.');
    const parts = String(ctx.message?.text || '').trim().split(/\s+/);
    const rk = String(parts[1] || '').toLowerCase();
    const key = PGIF_ALIASES[rk] || rk;
    if (!rk || !PGIF_KEYS.has(key))
      return ctx.reply('Usage: `/rmgif <key>`\nExample: `/rmgif 50`\nSee all keys: /giflist', { parse_mode: 'Markdown' });
    const leg = PGIF_LEGACY[key];
    const { rowCount } = await q(
      `DELETE FROM public.pgif_settings WHERE result_key = $1 OR result_key = $2`,
      [key, leg || key]
    );
    if (!rowCount) return ctx.reply(`❌ No GIF saved for *${key}*`, { parse_mode: 'Markdown' });
    const label = PGIF_LABELS[key] || key;
    return ctx.reply(`🗑️ Removed GIF for *${mdEsc(label)}* (\`${key}\`)`, { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('rmgif', e);
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('showgif', async (ctx) => {
  try {
    if (!(await canConfigurePgif(ctx)))
      return ctx.reply('❌ Only group admin / bot owner can use /showgif');
    const { rows } = await q(
      `SELECT result_key, file_id, media_type FROM public.pgif_settings ORDER BY result_key`
    );
    if (!rows.length) return ctx.reply('❌ No GIFs saved yet. Use /pgif <key> while replying to a GIF.');

    await ctx.reply(`🎞️ Showing *${rows.length}* saved GIF(s)…`, { parse_mode: 'Markdown' });
    for (const r of rows) {
      const label = PGIF_LABELS[r.result_key] || r.result_key;
      const cap = `✅ <b>${escapeHtml(String(r.result_key))}</b> — ${escapeHtml(label)}`;
      try {
        await sendGifFile(ctx.telegram, ctx.chat.id, r, {
          caption: cap,
          parse_mode: 'HTML',
        });
        await sleep(400);
      } catch (e) {
        await ctx.reply(`❌ ${r.result_key}: ${e.message}`).catch(() => {});
      }
    }
    await ctx.reply('✅ Done. Use /giflist to see missing keys.');
  } catch (e) {
    console.error('showgif', e);
    await ctx.reply('❌ ' + e.message);
  }
});

const htag = (p) =>
  isBotId(p.telegram_id ?? p.id)
    ? `<b>${escapeHtml(name(p))}</b>`
    : `<a href="tg://user?id=${Number(p.telegram_id ?? p.id)}">${escapeHtml(name(p))}</a>`;

// Spam rules: team = spam-free by default, solo = spam allowed by default (host can switch with /spam)
function spamFreeOn(m) {
  const v = m.spam_free;
  if (v === null || v === undefined) return m.mode !== 'solo';
  return v === true || v === 1 || v === 't' || v === '1';
}

// Hat-trick ball: the current bowler took wickets with his previous two deliveries
async function isHatTrickBall(inn) {
  const { rows } = await q(
    `SELECT bowler_id, is_wicket FROM deliveries WHERE innings_id=$1 ORDER BY over_number DESC, ball_number DESC LIMIT 2`,
    [inn.id]
  );
  return (
    rows.length === 2 &&
    rows.every((r) => r.bowler_id === inn.current_bowler_id && (r.is_wicket === true || r.is_wicket === 1 || r.is_wicket === 't'))
  );
}

// Spam-free: the bowler may not send the same number three times in a row
async function bowlerSpamBlocked(m, inn, n) {
  if (!spamFreeOn(m)) return false;
  const { rows } = await q(
    `SELECT bowler_id, bowl_number FROM deliveries WHERE innings_id=$1 ORDER BY over_number DESC, ball_number DESC LIMIT 2`,
    [inn.id]
  );
  return rows.length === 2 && rows.every((r) => r.bowler_id === inn.current_bowler_id && Number(r.bowl_number) === n);
}

// ─── Help ────────────────────────────────────────────────
bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *HOW TO PLAY*\n\n` +
      `*SOLO* (everyone bats until out)\n` +
      `/startsolo — open lobby (60s)\n` +
      `/join\\_solo — join (#1 bats, #2 bowls…)\n` +
      `/leavesolo — leave\n` +
      `/forcestart or /startgame — start (min 2)\n` +
      `/extend30 — +30s\n` +
      `/soloball 3 or 6 — bowler changes every 3 or 6 balls (next player by number)\n` +
      `Then just type 0-6 when it is your turn to bat\n\n` +
      `*PROFILE*\n` +
      `/setmedia <key> — reply to any media to save it under a key (admin)\n` +
      `/userinfo — your stats card (or reply to / tag someone, or /userinfo <id>)\n\n` +
      `*PRACTICE vs BOT*\n` +
      `/vsbotsolo [3|6] — 1v1 against the bot\n` +
      `/botteam 5 or /botteam 10 — your team vs a bot team\n\n` +
      `*TEAM*\n` +
      `/team — create a team lobby (unlimited players)\n` +
      `/team\\_a  /team\\_b — join a team\n` +
      `/add\\_a  /add\\_b — host/captain adds players (@user, id, reply — many at once)\n` +
      `/setcap\\_a  /setcap\\_b <no.> — host sets a captain\n` +
      `/startgame — host starts: captains → toss → bat/bowl\n` +
      `/setovers — host picks overs (1-20)\n` +
      `/bat 1 · /ball 1 — captains pick players, then type 0-6\n\n` +
      `Same number = OUT\n\n` +
      `*Other*\n` +
      `/members (or /team) — overview + player list · /score · /scorecard · /endmatch\n` +
      `/spam — host switches Spam-free / Spam mode\n` +
      `/penalty team a -5 reason — host deducts/adds team runs\n` +
      `/changehost — vote to change the host (3 votes per team)\n\n` +
      `*Rules*\n` +
      `⏱ Batsman and bowler must respond within ${TURN_SECONDS}s, otherwise *-${TURN_PENALTY} runs* (team: from the team score, solo: from the player's runs).\n` +
      `Solo: bowling changes automatically after ${SOLO_BOWLER_WARN_LIMIT} bowler warnings. Team: after ${TEAM_BOWLER_WARN_LIMIT} warnings the captain must choose a new bowler.\n` +
      `A batsman who misses ${BAT_RETIRE_LIMIT} turns is retired OUT.\n` +
      `If a lobby does nothing, the host gets warnings and the game ends after ${IDLE_WARN_LIMIT}.\n\n` +
      `*GIF setup (reply to a GIF):*\n` +
      `/giflist — which event GIFs are set (✅/❌)\n` +
      `/showgif — admin: preview every saved GIF\n` +
      `/rmgif <key> — admin: remove a saved GIF\n` +
      `/pgif 0 … /pgif 6 · /pgif out · /pgif dugout (duck out)\n/pgif duck · /pgif stance (batsman batting) · /pgif runup (bowler bowling)\n/pgif batentry · /pgif bowlentry · /pgif starter (fielding) · /pgif opener · /pgif toss\n/pgif 50 · /pgif 100 · /pgif 150 · /pgif 200 · /pgif 3w · /pgif 5w (or 5fer) · /pgif hatrick · /pgif motm`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('members', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply(`${pe('no','❌')} No active match. Start one with /team or /solo.`);
  return sendMembers(ctx, m);
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
    'Solo: /startsolo → join → start → type 0-6\nTeam: /team → join → /startgame → captains → toss → /setovers'
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
      // Pre-convert to HTML so <tg-emoji> is real HTML, not raw text
      return await sendHtmlPhoto(ctx.telegram, ctx.chat.id, { source: img }, caption, extra);
    } catch (e) {
      lastErr = e;
      console.error(`host banner attempt failed (dp=${useDp}):`, e.message);
    }
  }
  await reportCardError('Host banner', lastErr);
  return sendHtmlMessage(ctx.telegram, ctx.chat.id, caption, extra);
}

// /testcard (admin) — bot version, which asset files are valid, and the real error if the host banner fails
bot.command('testcard', async (ctx) => {
  if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Admin only.');
  let report = [];
  try {
    report = await assetReport();
  } catch (e) {
    report = ['asset check failed: ' + e.message];
  }
  await ctx.reply(`🔧 Bot version: ${BOT_VERSION}\n` + report.join('\n'));
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
            SUM(bs.runs)::int AS runs, SUM(bs.balls_faced)::int AS balls,
            SUM(bs.fours)::int AS fours, SUM(bs.sixes)::int AS sixes
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

const tagOf = (p) => (isBotId(p.telegram_id) ? `*${mdEsc(name(p))}*` : `[${mdEsc(name(p))}](tg://user?id=${Number(p.telegram_id)})`);

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
  return `> ${o}\n> ${p}\n> ${m}`;
}

// full numbers of one player in a match (for the MOTM card)
async function playerMatchStats(matchId, telegramId) {
  const { rows } = await q(
    `SELECT mp.telegram_id, mp.username, mp.first_name, mp.last_name,
            COALESCE(b.runs,0) AS runs, COALESCE(b.balls,0) AS balls, COALESCE(b.fours,0) AS fours, COALESCE(b.sixes,0) AS sixes,
            COALESCE(w.wkts,0) AS wkts, COALESCE(w.bballs,0) AS bballs, COALESCE(w.conceded,0) AS conceded
       FROM match_players mp
       LEFT JOIN (SELECT bs.player_id, SUM(bs.runs)::int AS runs, SUM(bs.balls_faced)::int AS balls,
                         SUM(bs.fours)::int AS fours, SUM(bs.sixes)::int AS sixes
                    FROM batting_stats bs JOIN innings i ON i.id = bs.innings_id
                   WHERE i.match_id=$1 GROUP BY bs.player_id) b ON b.player_id = mp.id
       LEFT JOIN (SELECT bw.player_id, SUM(bw.wickets)::int AS wkts, SUM(bw.balls_bowled)::int AS bballs,
                         SUM(bw.runs_conceded)::int AS conceded
                    FROM bowling_stats bw JOIN innings i ON i.id = bw.innings_id
                   WHERE i.match_id=$1 GROUP BY bw.player_id) w ON w.player_id = mp.id
      WHERE mp.match_id=$1 AND mp.telegram_id=$2
      LIMIT 1`,
    [matchId, telegramId]
  );
  const r = rows[0];
  if (!r) return null;
  const runs = Number(r.runs), balls = Number(r.balls), bballs = Number(r.bballs), conceded = Number(r.conceded);
  return {
    ...r,
    runs,
    balls,
    fours: Number(r.fours),
    sixes: Number(r.sixes),
    sr: balls > 0 ? (runs * 100) / balls : 0,
    wkts: Number(r.wkts),
    bballs,
    eco: bballs > 0 ? (conceded * 6) / bballs : 0,
  };
}

// Final result image + caption (team: Date / Time / GC, Team A + Team B best performers, MOTM, Winner)
// extra = { inns: [innings rows], winner: 'A' | 'B' | 'tie', motm: awards.motm }
async function sendTeamFinal(telegram, groupId, m, caption, extra = {}) {
  const [batA, bowlA, batB, bowlB] = await Promise.all([
    bestBatter(m.id, 'A'),
    bestBowler(m.id, 'A'),
    bestBatter(m.id, 'B'),
    bestBowler(m.id, 'B'),
  ]);
  try {
    const motm = extra.motm || null;
    const dps = await Promise.all(
      [batA, bowlA, batB, bowlB, motm].map((p) => (p ? getUserDp(telegram, p.telegram_id) : null))
    );
    const mk = (p, dp, bat) =>
      p
        ? bat
          ? { dp, name: cardName(p), runs: p.runs, balls: p.balls, fours: p.fours, sixes: p.sixes, sr: p.sr }
          : { dp, name: cardName(p), wkts: p.wkts, balls: p.balls, eco: p.eco }
        : null;
    const inns = extra.inns || [];
    const bar = (L) => {
      const i = inns.find((x) => x.batting_team === L);
      return i ? `TEAM ${L}  ${i.total_runs}/${i.total_wickets} (${oversStr(i.balls_bowled)} ov)` : `TEAM ${L}`;
    };
    const w = extra.winner;
    const { date, time } = cardDateTime(m.completed_at ? new Date(m.completed_at) : new Date());
    const img = await renderTeamFinalCard({
      A: { bat: mk(batA, dps[0], true), bowl: mk(bowlA, dps[1], false) },
      B: { bat: mk(batB, dps[2], true), bowl: mk(bowlB, dps[3], false) },
      info: {
        date,
        time,
        gc: m.group_title || 'GROUP',
        barA: bar('A'),
        barB: bar('B'),
        winner: w === 'tie' ? 'MATCH TIED' : w ? `TEAM ${w}` : '',
        motm: motm ? { dp: dps[4], name: cardName(motm) } : null,
      },
    });
    await telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'Markdown' });
  } catch (e) {
    await reportCardError('Team final card', e);
    await telegram.sendMessage(
      groupId,
      caption + '\n\n' + performersText('TEAM A', batA, bowlA) + '\n' + performersText('TEAM B', batB, bowlB),
      { parse_mode: 'Markdown' }
    );
  }
}

// Final result image + caption (solo: Man of the Match card)
async function sendSoloFinal(telegram, groupId, m, caption, motm, bat, bowl) {
  try {
    if (!motm) throw new Error('no MOTM');
    const [dp, st] = await Promise.all([getUserDp(telegram, motm.telegram_id), playerMatchStats(m.id, motm.telegram_id)]);
    const s = st || motm;
    const img = await renderMotmCard({
      dp,
      name: cardName(s),
      runs: Number(s.runs || 0),
      balls: Number(s.balls || 0),
      fours: Number(s.fours || 0),
      sixes: Number(s.sixes || 0),
      sr: Number(s.sr || 0),
      wkts: Number(s.wkts || 0),
      bballs: Number(s.bballs || 0),
      eco: Number(s.eco || 0),
    });
    await telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'Markdown' });
  } catch (e) {
    if (String(e.message) !== 'no MOTM') await reportCardError('MOTM card', e);
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
      `❌ *Lobby closed* — can't play solo with one player.`,
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

  await telegram.sendMessage(
    chatId,
    `⚡ *${fancy('SOLO MATCH STARTED')}*\n` +
      `${line('─')}\n` +
      `👥 Players: *${players.length}*\n` +
      `🏏 Batting: *${mn(batter)}*\n` +
      `🎳 Bowling: *${mn(bowler)}*`,
    { parse_mode: 'Markdown' }
  );
  await sendScoreboard(telegram, chatId, matchId);
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
          `⏳ *${left}s* left  ·  ${pl.length} player${pl.length === 1 ? '' : 's'}  ·  /joinsolo`,
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
      return ctx.reply(`⚠️ *Only one game per group.*\nA match is already running here.\nHost: /endmatch to cancel it first.`);

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
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, last_name, is_captain)
       VALUES ($1,$2,'A',1,$3,$4,$5,TRUE)`,
      [m.id, ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null]
    );
    await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label='A'`, [
      m.id,
      ctx.from.id,
    ]);
    await upsertUser(ctx.from);

    touchMatch(m.id);
    startLobbyTimer(m.id, ctx.chat.id, ctx.from.id, ctx.telegram, LOBBY_SECONDS);
    await q(`UPDATE matches SET spam_free=$2 WHERE id=$1`, [m.id, false]); // solo: spam allowed by default
    const soloBalls = parseInt(((ctx.message?.text || '').split(/\s+/)[1] || ''), 10) === 6 ? 6 : 3;
    await q(`UPDATE matches SET solo_balls=$2 WHERE id=$1`, [m.id, soloBalls]);

    await sendHostBanner(
      ctx,
      `🎮 *${fancy('SOLO LOBBY IS OPEN')}*\n` +
        `${line('─')}\n` +
        `👑 Host: *${mn(ctx.from)}*\n` +
        `Join with /joinsolo\n` +
        `⏳ Closes in *${LOBBY_SECONDS}s*  ·  min 2 players\n` +
        `${line('─')}\n` +
        `Host: /forcestart to begin now`,
      Markup.inlineKeyboard([
        [btn('𝟯 𝗕𝗔𝗟𝗟𝗦', `sb:${m.id}:3`, 'bowler', 'primary'), btn('𝟲 𝗕𝗔𝗟𝗟𝗦', `sb:${m.id}:6`, 'bowler', 'success')],
      ])
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
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, last_name, is_captain)
       VALUES ($1,$2,'A',$3,$4,$5,$6,FALSE)`,
      [m.id, ctx.from.id, pos, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null]
    );

    await upsertUser(ctx.from);
    const total = pos;
    const left = lobbies.has(m.id)
      ? Math.max(0, Math.ceil((lobbies.get(m.id).endsAt - Date.now()) / 1000))
      : 0;

    await ctx.reply(
      `✅ *${mn(ctx.from)}* joined  ·  #${pos}  ·  ${total} player${total > 1 ? 's' : ''}` + (left ? `  ·  ${left}s left` : ''),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command(['join_solo', 'joinsolo'], joinSolo);

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
    await ctx.reply(`${pe('wave','👋')} ${mn(ctx.from)} left.\n${pe('people','👥')} Players: *${rest.length}*`, {
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

// ─── Team join phase: Team A 45s → Team B 45s → team list ───
function clearTeamJoinTimer(matchId) {
  const t = teamJoinTimers.get(mkey(matchId));
  if (!t) return;
  if (t.timer) clearTimeout(t.timer);
  if (t.warnTimer) clearTimeout(t.warnTimer);
  teamJoinTimers.delete(mkey(matchId));
}

async function startTeamJoinPhase(telegram, matchId, chatId) {
  // Step 1/2: Team A only
  await runTeamJoinWindow(telegram, matchId, chatId, 'A');
}

async function runTeamJoinWindow(telegram, matchId, chatId, label) {
  clearTeamJoinTimer(matchId);
  const m0 = await getMatch(matchId);
  if (!m0 || m0.status !== 'waiting' || m0.mode === 'solo') return;

  const cmd = label === 'A' ? '/team\\_a' : '/team\\_b';
  const warnAt = Math.max(0, (TEAM_JOIN_SECONDS - TEAM_JOIN_WARN_LAST) * 1000);

  // Clean prompt — no "warning coming" text (warning is still sent at T-10s)
  await telegram.sendMessage(
    chatId,
    `📌 *JOIN TEAM ${label}*\n` +
      `${line()}\n` +
      `> Tap ${cmd} to join *Team ${label}*\n\n` +
      `⏱ Timer: *${TEAM_JOIN_SECONDS} seconds*\n` +
      `Host can also use /add\\_${label.toLowerCase()}`,
    { parse_mode: 'Markdown' }
  );

  const warnTimer = setTimeout(async () => {
    try {
      const m = await getMatch(matchId);
      if (!m || m.status !== 'waiting') return;
      const pl = await getPlayers(matchId, label);
      await telegram.sendMessage(
        chatId,
        `⚠️ *${TEAM_JOIN_WARN_LAST}s LEFT — Team ${label}!*\n` +
          `> Team ${label}: *${pl.length}* player${pl.length === 1 ? '' : 's'}\n` +
          `> Quick: ${cmd}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error('team join warn:', e.message);
    }
  }, warnAt);

  const timer = setTimeout(() => {
    onTeamJoinWindowEnd(telegram, matchId, chatId, label).catch((e) =>
      console.error('onTeamJoinWindowEnd:', e.message)
    );
  }, TEAM_JOIN_SECONDS * 1000);

  teamJoinTimers.set(mkey(matchId), { timer, warnTimer, chatId, label });
}

async function onTeamJoinWindowEnd(telegram, matchId, chatId, label) {
  clearTeamJoinTimer(matchId);
  const m = await getMatch(matchId);
  if (!m || m.status !== 'waiting' || m.mode === 'solo') return;

  const pl = await getPlayers(matchId, label);
  let summary = `✅ *Team ${label} join window closed*\n> Players: *${pl.length}*\n`;
  for (const p of pl) summary += `  ${p.roster_position}. ${mn(p)}\n`;
  if (!pl.length) summary += `  _(empty)_\n`;
  await telegram.sendMessage(chatId, summary, { parse_mode: 'Markdown' });

  if (label === 'A') {
    await telegram.sendMessage(
      chatId,
      `➡️ Next: *Team B* join opens now (*${TEAM_JOIN_SECONDS}s*).`,
      { parse_mode: 'Markdown' }
    );
    await runTeamJoinWindow(telegram, matchId, chatId, 'B');
    return;
  }

  // Team B timer done → list + tag host for /startgame immediately
  await endTeamJoinPhase(telegram, matchId, chatId);
}

async function endTeamJoinPhase(telegram, matchId, chatId) {
  clearTeamJoinTimer(matchId);
  const m = await getMatch(matchId);
  if (!m || m.status !== 'waiting' || m.mode === 'solo') return;

  const a = await getPlayers(matchId, 'A');
  const b = await getPlayers(matchId, 'B');
  let list =
    `📋 *TEAM LIST*\n` +
    `🅰 *Team A* (${a.length})\n` +
    rosterBlock(a) +
    `\n🅱 *Team B* (${b.length})\n` +
    rosterBlock(b) +
    `\n> Still join: /team\\_a · /team\\_b (until host starts)\n` +
    `> Host: /add\\_a /add\\_b`;

  await sendPlayersListPhoto(telegram, chatId, list);

  // Always tag the host to start the game
  const hostId = Number(m.host_telegram_id);
  const hostTag = `[Host](tg://user?id=${hostId})`;
  let hostMsg =
    `👑 ${hostTag}\n` +
    `⏱ Both join timers are over.\n` +
    `> Send */startgame* now to choose captains and start the toss.`;
  if (a.length < MIN_TEAM_PLAYERS || b.length < MIN_TEAM_PLAYERS) {
    hostMsg +=
      `\n\n⚠️ Need at least *${MIN_TEAM_PLAYERS}* per team ` +
      `(A: ${a.length}, B: ${b.length}). Add players first.`;
  }
  await telegram.sendMessage(chatId, hostMsg, { parse_mode: 'Markdown' });
}

async function createTeamMatch(ctx) {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  try {
    if (await getActiveMatch(ctx.chat.id))
      return ctx.reply(`⚠️ *Only one game per group.*\nA match is already running here.\nHost: /endmatch to cancel it first.`);
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
    // Idle host-warnings start only after /startgame (captains/toss), not during join timers
    await q(`UPDATE matches SET spam_free=$2 WHERE id=$1`, [m.id, true]); // team: spam-free by default

    await sendHostBanner(
      ctx,
      `${pe('people','👥')} *${fancy('TEAM MATCH')}*\n` +
        `> ${pe('crown','👑')} Host: *${mn(ctx.from)}*\n` +
        `> ${pe('people','👤')} Players: *unlimited* per team\n` +
        `> ${pe('ok','🛡')} Mode: *Spam Free* (host: /spam to switch)\n` +
        `> ${pe('clock','⏱')} Join window: *${TEAM_JOIN_SECONDS}s* · Overs after toss (auto)\n\n` +
        `${pe('mega','📌')} *Join*\n` +
        `> /team\\_a — Team A\n` +
        `> /team\\_b — Team B\n\n` +
        `${pe('plus','➕')} *Add players* (host / captain)\n` +
        `> /add\\_a @user  ·  /add\\_b 167282  ·  or reply to someone\n` +
        `> many at once — one @user / id per line\n\n` +
        `${pe('zap','⚡')} *Host*\n` +
        `> /startgame — captains → toss → play\n` +
        `> /members — see the teams\n` +
        `> /endmatch — cancel`
    );
    // 45s join window + last-10s warning, then auto team list
    await startTeamJoinPhase(ctx.telegram, m.id, ctx.chat.id);
    touchMatch(m.id);
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
    if (m.vs_bot && label === 'B') return ctx.reply('🤖 Team B is the bot team — join Team A with /team_a');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('❌ You are already in a team');
    const team = await getPlayers(m.id, label);
    if (team.length >= m.team_size) return ctx.reply(`❌ Team ${label} is full`);

    const { rows } = await q(
      `SELECT COALESCE(MAX(roster_position),0)+1 AS n FROM match_players WHERE match_id=$1 AND team_label=$2`,
      [m.id, label]
    );
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, last_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [m.id, ctx.from.id, label, rows[0].n, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null]
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
bot.command(['team_a', 'join_a'], (ctx) => joinTeam(ctx, 'A'));
bot.command(['team_b', 'join_b'], (ctx) => joinTeam(ctx, 'B'));

// pending "do you want to join?" invites: token -> { matchId, label, user, by, timer }
const inviteMap = new Map();
const INVITE_EXPIRE_MS = 3 * 60 * 1000;

// ─── /add_a /add_b /add : host (or the team's captain) invites players by @username, id or reply ───
function parseAddTargets(ctx) {
  const msg = ctx.message;
  const text = String(msg.text || '').replace(/^\/\S+\s*/, '');
  const targets = [];
  const seen = new Set();
  const push = (t) => {
    const k = t.id ? 'i' + t.id : 'u' + String(t.username).toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      targets.push(t);
    }
  };
  for (const e of msg.entities || []) {
    if (e.type === 'text_mention' && e.user && !e.user.is_bot)
      push({ id: e.user.id, username: e.user.username, first_name: e.user.first_name, last_name: e.user.last_name });
  }
  for (const tok of text.split(/[\s,;]+/).filter(Boolean)) {
    if (/^@[A-Za-z0-9_]{3,32}$/.test(tok)) push({ username: tok.slice(1) });
    else if (/^\d{5,15}$/.test(tok)) push({ id: Number(tok) });
  }
  const rep = msg.reply_to_message;
  if (!targets.length && rep && rep.from && !rep.from.is_bot)
    push({ id: rep.from.id, username: rep.from.username, first_name: rep.from.first_name, last_name: rep.from.last_name });
  return targets;
}

async function resolveTarget(ctx, t) {
  if (t.id && (t.username || t.first_name))
    return { id: t.id, username: t.username || null, first_name: t.first_name || null, last_name: t.last_name || null };
  if (t.id) {
    const { rows } = await q(`SELECT username, first_name, last_name FROM users WHERE telegram_id=$1`, [t.id]);
    if (rows[0]) return { id: t.id, username: rows[0].username, first_name: rows[0].first_name, last_name: rows[0].last_name };
    try {
      const c = await ctx.telegram.getChat(t.id);
      return { id: t.id, username: c.username || null, first_name: c.first_name || c.title || null, last_name: c.last_name || null };
    } catch (_) {}
    try {
      const cm = await ctx.telegram.getChatMember(ctx.chat.id, t.id);
      return { id: t.id, username: cm.user.username || null, first_name: cm.user.first_name || null, last_name: cm.user.last_name || null };
    } catch (_) {}
    return { id: t.id, username: null, first_name: null, last_name: null };
  }
  const { rows } = await q(
    `SELECT telegram_id, username, first_name, last_name FROM users WHERE lower(username)=lower($1)`,
    [t.username]
  );
  if (rows[0])
    return { id: Number(rows[0].telegram_id), username: rows[0].username, first_name: rows[0].first_name, last_name: rows[0].last_name };
  try {
    const c = await ctx.telegram.getChat('@' + t.username);
    if (c && c.type === 'private')
      return { id: c.id, username: c.username || t.username, first_name: c.first_name || null, last_name: c.last_name || null };
  } catch (_) {}
  return null;
}

async function addPlayers(ctx, label, viaAdd = false) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
    if (!['waiting', 'captains', 'toss'].includes(m.status))
      return ctx.reply('⚠️ Players can only be added before the match starts');
    if (m.mode !== 'solo' && viaAdd) return ctx.reply('Use /add_a or /add_b to choose the team.');
    if (m.mode === 'solo') label = 'A';
    if (m.vs_bot && label === 'B') return ctx.reply('🤖 Team B is the bot team');

    const isHost = Number(m.host_telegram_id) === ctx.from.id;
    const team = m.mode === 'solo' ? null : await getTeam(m.id, label);
    const isCap = !!team && Number(team.captain_id) === ctx.from.id;
    if (!isHost && !isCap)
      return ctx.reply(`❌ Only the host${m.mode === 'solo' ? '' : ' or the Team ' + label + ' captain'} can add players`);

    const targets = parseAddTargets(ctx);
    if (!targets.length)
      return ctx.reply(
        `Usage:\n/add_${label.toLowerCase()} @user\n@user2\n167282\n…or reply to a player's message with /add_${label.toLowerCase()}`
      );

    const invited = [];
    const problems = [];
    for (const t of targets) {
      const info = await resolveTarget(ctx, t);
      if (!info) {
        problems.push(`@${t.username} — not known yet (they must press /start in the bot or write in this group once)`);
        continue;
      }
      if (await getPlayerByTg(m.id, info.id)) {
        problems.push(`${info.username ? '@' + info.username : info.first_name || info.id} — already in the match`);
        continue;
      }
      if ([...inviteMap.values()].some((v) => v.matchId === m.id && v.user.id === info.id)) {
        problems.push(`${info.username ? '@' + info.username : info.first_name || info.id} — already invited`);
        continue;
      }
      const pl = await getPlayers(m.id, label);
      if (pl.length >= m.team_size) {
        problems.push(`${info.username ? '@' + info.username : info.id} — team is full`);
        break;
      }
      const display = info.username ? '@' + info.username : info.first_name || String(info.id);
      const token = crypto.randomBytes(6).toString('base64url');
      const sent = await ctx.telegram.sendMessage(
        ctx.chat.id,
        `🙋 [${mdEsc(display)}](tg://user?id=${info.id}) — ${mtag(ctx.from)} wants to add you to *${
          m.mode === 'solo' ? 'the solo lobby' : 'Team ' + label
        }*.\n> Do you want to join?`,
        {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([
            [
              btn(`𝗬𝗲𝘀, 𝗷𝗼𝗶𝗻${m.mode === 'solo' ? '' : ' Team ' + label}`, `inv:Y:${token}`, 'ok', 'success'),
              btn('𝗡𝗼', `inv:N:${token}`, 'no', 'danger'),
            ],
          ]),
        }
      );
      const timer = setTimeout(async () => {
        if (!inviteMap.delete(token)) return;
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, sent.message_id, undefined, `⌛ Invite for ${display} expired.`);
        } catch (_) {}
      }, INVITE_EXPIRE_MS);
      inviteMap.set(token, { matchId: m.id, label, user: info, by: ctx.from.id, timer });
      invited.push(display);
    }
    if (problems.length || !invited.length) {
      await ctx.reply(
        (invited.length ? '' : '⚠️ Nobody was invited\n') +
          (problems.length ? `⚠️ Skipped:\n${problems.map((x) => mdEsc(x)).join('\n')}` : ''),
        { parse_mode: 'Markdown' }
      );
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}

// the invited player answers Yes / No
bot.action(/^inv:(Y|N):(.+)$/, async (ctx) => {
  const yes = ctx.match[1] === 'Y';
  const token = ctx.match[2];
  try {
    const inv = inviteMap.get(token);
    if (!inv) return ctx.answerCbQuery('This invite has expired', { show_alert: true });
    if (ctx.from.id !== inv.user.id)
      return ctx.answerCbQuery('This invite is not for you', { show_alert: true });
    const m = await getMatch(inv.matchId);
    clearTimeout(inv.timer);
    inviteMap.delete(token);
    const display = inv.user.username ? '@' + inv.user.username : inv.user.first_name || String(inv.user.id);
    if (!yes) {
      await ctx.answerCbQuery('Declined');
      return editCard(ctx, `❌ ${mdEsc(display)} declined the invite.`);
    }
    if (!m || !['waiting', 'captains', 'toss'].includes(m.status))
      return ctx.answerCbQuery('Too late — the match has already started', { show_alert: true });
    if (await getPlayerByTg(m.id, inv.user.id)) return ctx.answerCbQuery('You are already in the match');
    const pl = await getPlayers(m.id, inv.label);
    if (pl.length >= m.team_size) return ctx.answerCbQuery('The team is full', { show_alert: true });
    const { rows } = await q(
      `SELECT COALESCE(MAX(roster_position),0)+1 AS n FROM match_players WHERE match_id=$1 AND team_label=$2`,
      [m.id, inv.label]
    );
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, last_name)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [m.id, inv.user.id, inv.label, rows[0].n, inv.user.username || null, inv.user.first_name || null, inv.user.last_name || null]
    );
    await upsertUser({ id: inv.user.id, username: inv.user.username, first_name: inv.user.first_name }).catch(() => {});
    await ctx.answerCbQuery('You joined!');
    await editCard(
      ctx,
      `✅ ${mdEsc(display)} joined *${m.mode === 'solo' ? 'the solo lobby' : 'Team ' + inv.label}* (#${rows[0].n})`
    );
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery('Error', { show_alert: true }).catch(() => {});
  }
});
bot.command('add_a', (ctx) => addPlayers(ctx, 'A'));
bot.command('add_b', (ctx) => addPlayers(ctx, 'B'));
bot.command('add', (ctx) => addPlayers(ctx, 'A', true));

// /spam (host): Spam-free (same number max 2 times in a row) <-> Spam (no limit)
bot.command('spam', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
  if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can change the mode');
  const next = !spamFreeOn(m);
  await q(`UPDATE matches SET spam_free=$2 WHERE id=$1`, [m.id, next]);
  await ctx.reply(
    next
      ? `${pe('ok','🛡')} *Spam-free mode* — a bowler cannot send the same number 3 times in a row.`
      : '⚡ *Spam mode* — bowlers may repeat numbers freely (666666 is fine).',
    { parse_mode: 'Markdown' }
  );
});

// Host override: /setcaptain_a <number>  (the normal way is the captain buttons after /startgame)
bot.command(['setcaptain_a', 'setcaptain_A', 'setcap_a', 'setcap_A'], async (ctx) => setCap(ctx, 'A'));
bot.command(['setcaptain_b', 'setcaptain_B', 'setcap_b', 'setcap_B'], async (ctx) => setCap(ctx, 'B'));

async function setCap(ctx, label) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can do this');
    if (m.mode === 'solo') return ctx.reply('ℹ️ Solo has no captains');
    if (m.vs_bot && label === 'B') return ctx.reply('🤖 Team B is the bot team (captain Bot 1)');
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

// /team → create a lobby when nothing is running, otherwise overview + players (same as /members)
bot.command('team', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return createTeamMatch(ctx);
  return sendMembers(ctx, m);
});

// Cancelling needs the host's permission: Yes / No
async function cancelMatchNow(m, telegram = null) {
  clearLobby(m.id);
  clearTeamJoinTimer(m.id);
  stopIdleWatch(m.id);
  clearTurnClock(m.id);
  clearWarns(m.id);
  endVote(m.id);
  matchActivity.delete(mkey(m.id));
  await q(`UPDATE matches SET status='cancelled' WHERE id=$1`, [m.id]);
  const tg = telegram || bot.telegram;
  const groupId = Number(m.group_chat_id);
  if (groupId) {
    try {
      await sendMatchDataFile(tg, groupId, m.id);
    } catch (e) {
      console.error('cancel match data file:', e.message);
    }
  }
}

bot.command('endmatch', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
  const isHost = Number(m.host_telegram_id) === ctx.from.id;
  if (!isHost && !isAdmin(ctx.from.id) && !(await getPlayerByTg(m.id, ctx.from.id)) && !(await isGroupAdmin(ctx.chat.id, ctx.from.id)))
    return ctx.reply('❌ Only players of this match can ask to cancel it');
  const kb = Markup.inlineKeyboard([
    [
      btn('𝗬𝗲𝘀, 𝗰𝗮𝗻𝗰𝗲𝗹', `em:Y:${m.id}`, 'ok'),
      btn('𝗡𝗼', `em:N:${m.id}`, 'no'),
    ],
  ]);
  if (isHost) {
    return ctx.reply(`${pe('stop','🛑')} *${fancy('CANCEL MATCH')}*\n> Do you really want to cancel this match?`, {
      parse_mode: 'Markdown',
      ...kb,
    });
  }
  return ctx.reply(
    `${pe('stop','🛑')} *${fancy('CANCEL REQUEST')}*\n> ${mtag(ctx.from)} wants to cancel this match.\n> [Host](tg://user?id=${Number(m.host_telegram_id)}), do you allow it?`,
    { parse_mode: 'Markdown', ...kb }
  );
});

bot.action(/^em:(Y|N):(.+)$/, async (ctx) => {
  try {
    const m = await getMatch(ctx.match[2]);
    if (!m || ['completed', 'cancelled'].includes(m.status))
      return ctx.answerCbQuery('This match is already over', { show_alert: true });
    if (Number(m.host_telegram_id) !== ctx.from.id && !isAdmin(ctx.from.id))
      return ctx.answerCbQuery('Only the host can answer this', { show_alert: true });
    if (ctx.match[1] === 'N') {
      await ctx.answerCbQuery('Match continues');
      return editCard(ctx, '▶️ The host said *No* — the match continues.');
    }
    await cancelMatchNow(m);
    await ctx.answerCbQuery('Cancelled');
    await editCard(ctx, `${pe('stop','🛑')} ${pe('ok','✅')} The host said *Yes* — match / lobby cancelled.`);
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery('Error', { show_alert: true }).catch(() => {});
  }
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
    if (!m) return ctx.reply(`${pe('no','❌')} No active match. Use /team or /startsolo first.`);
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can start the game');
    if (m.status !== 'waiting') return ctx.reply('⚠️ The game has already started');

    if (m.mode === 'solo') return forceStartSolo(ctx, m);

    if (m.vs_bot) {
      const target = Math.max(2, Number(m.team_size) || 5);
      let have = (await getPlayers(m.id, 'A')).length;
      let nb = await botCount(m.id);
      while (have < target) {
        nb++;
        await addBotPlayer(m.id, 'A', nb);
        have++;
      }
    }

    const a = await getPlayers(m.id, 'A');
    const b = await getPlayers(m.id, 'B');
    if (a.length < MIN_TEAM_PLAYERS || b.length < MIN_TEAM_PLAYERS)
      return ctx.reply(
        `❌ Each team needs at least ${MIN_TEAM_PLAYERS} players (Team A: ${a.length}, Team B: ${b.length})`
      );

    clearTeamJoinTimer(m.id);
    const claim = await q(
      `UPDATE matches SET status='captains' WHERE id=$1 AND status='waiting' RETURNING id`,
      [m.id]
    );
    if (!claim.rowCount) return;

    // Host idle-warnings begin only once the game has started (/startgame)
    const pl0 = await getPlayers(m.id);
    startIdleWatch(m.id, ['captains', '', pl0.length, 0].join('|'));
    touchMatch(m.id);

    // Show current teams, then captain buttons
    try {
      await ctx.reply(await rosterText(m), { parse_mode: 'Markdown' });
    } catch (_) {}

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

// edit a card that may be a GIF (caption) or a plain text message
async function editCard(ctx, md) {
  const msg = ctx.callbackQuery && ctx.callbackQuery.message;
  const isMedia = msg && (msg.animation || msg.video || msg.document || msg.photo);
  try {
    if (isMedia) await ctx.editMessageCaption(stripPe(md2html(md)), { parse_mode: 'HTML' });
    else await ctx.editMessageText(md, { parse_mode: 'Markdown' });
  } catch (_) {}
}

// ─── TOSS ────────────────────────────────────────────────
// 1) both captains known → one captain is picked at random to call HEADS or TAILS
// 2) coin animation → /pgif toss GIF with the winner tagged → winner chooses BAT or BALL
async function tryBeginToss(telegram, matchId) {
  const m = await getMatch(matchId);
  if (!m || m.status !== 'captains') return false;
  const tA = await getTeam(matchId, 'A');
  const tB = await getTeam(matchId, 'B');
  if (!tA?.captain_id || !tB?.captain_id) return false;

  const caller = m.vs_bot ? 'A' : Math.random() < 0.5 ? 'A' : 'B';
  const upd = await q(
    `UPDATE matches SET status='toss', setup_phase='call', toss_caller=$2 WHERE id=$1 AND status='captains' RETURNING id`,
    [matchId, caller]
  );
  if (!upd.rowCount) return false;
  await sendTossCall(telegram, matchId);
  return true;
}

async function sendTossCall(telegram, matchId) {
  const m = await getMatch(matchId);
  const capOf = async (L) => {
    const t = await getTeam(m.id, L);
    return t?.captain_id ? await getPlayerByTg(m.id, t.captain_id) : null;
  };
  const [capA, capB] = [await capOf('A'), await capOf('B')];
  const caller = m.toss_caller === 'B' ? capB : capA;
  await telegram.sendMessage(
    Number(m.group_chat_id),
    `🪙 *${fancy('TOSS TIME')}*\n` +
      `> 👑 Team A: ${capA ? mn(capA) : '—'}\n` +
      `> 👑 Team B: ${capB ? mn(capB) : '—'}\n\n` +
      `🎲 Picked at random to call: *Team ${m.toss_caller}*\n` +
      `${caller ? mtag(caller) : 'Captain'}, choose *HEADS* or *TAILS*:`,
    { parse_mode: 'Markdown', ...tossCallKb(m.id) }
  );
}

async function sendTossChoice(telegram, matchId, html) {
  const m = await getMatch(matchId);
  return sendCaptionedGif(telegram, Number(m.group_chat_id), 'toss', html, tossKb(m.id));
}

async function coinAnimation(telegram, chatId) {
  const frames = [
    '🪙 The coin goes up…',
    '🪙 ⟳ spinning…',
    '🪙 ⟳ ⟳ spinning…',
    '🪙 ⟳ ⟳ ⟳ almost…',
    '🪙 landing…',
  ];
  const msg = await telegram.sendMessage(chatId, frames[0]);
  for (let i = 1; i < frames.length; i++) {
    await sleep(COIN_FRAME_MS);
    try {
      await telegram.editMessageText(chatId, msg.message_id, undefined, frames[i]);
    } catch (_) {}
  }
  await sleep(COIN_FRAME_MS);
  return msg;
}

// the caller captain taps HEADS or TAILS
bot.action(/^tc:(.+):(H|T)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const call = ctx.match[2];
  try {
    const m = await getMatch(matchId);
    if (!m || m.status !== 'toss' || m.setup_phase !== 'call')
      return ctx.answerCbQuery('This toss call is not active', { show_alert: true });
    const callerTeam = await getTeam(m.id, m.toss_caller);
    if (Number(callerTeam?.captain_id) !== ctx.from.id)
      return ctx.answerCbQuery(`Only the Team ${m.toss_caller} captain can call`, { show_alert: true });

    const claim = await q(
      `UPDATE matches SET setup_phase='flip' WHERE id=$1 AND status='toss' AND setup_phase='call' RETURNING id`,
      [m.id]
    );
    if (!claim.rowCount) return ctx.answerCbQuery('Already called', { show_alert: true });
    await ctx.answerCbQuery(`You called ${call === 'H' ? 'HEADS' : 'TAILS'}`);

    const callerP = await getPlayerByTg(m.id, ctx.from.id);
    await editCard(ctx, `🪙 ${mtag(ctx.from)} called *${call === 'H' ? 'HEADS' : 'TAILS'}*`);

    const groupId = Number(m.group_chat_id);
    const coinMsg = await coinAnimation(ctx.telegram, groupId);

    const coin = Math.random() < 0.5 ? 'H' : 'T';
    try {
      await ctx.telegram.editMessageText(
        groupId,
        coinMsg.message_id,
        undefined,
        `🪙 The coin landed on ${coin === 'H' ? 'HEADS' : 'TAILS'}!`
      );
    } catch (_) {}
    const winner = coin === call ? m.toss_caller : m.toss_caller === 'A' ? 'B' : 'A';
    const upd = await q(
      `UPDATE matches SET toss_winner_team=$2, setup_phase='choice' WHERE id=$1 AND setup_phase='flip' RETURNING id`,
      [m.id, winner]
    );
    if (!upd.rowCount) return;

    const winTeam = await getTeam(m.id, winner);
    const winCap = winTeam?.captain_id ? await getPlayerByTg(m.id, winTeam.captain_id) : null;
    if (winCap && isBotId(winCap.telegram_id)) {
      await ctx.telegram.sendMessage(
        groupId,
        `🪙 Coin: *${coin === 'H' ? 'HEADS' : 'TAILS'}* — ${mtag(callerP || ctx.from)} called *${call === 'H' ? 'HEADS' : 'TAILS'}*`,
        { parse_mode: 'Markdown' }
      );
      return botTossChoose(ctx.telegram, m.id, winner);
    }
    await sendTossChoice(
      ctx.telegram,
      m.id,
      `🪙 <b>${fancy('TOSS')}</b>\n` +
        `<blockquote>Coin: <b>${coin === 'H' ? 'HEADS' : 'TAILS'}</b>\n` +
        `${htag(callerP || ctx.from)} called <b>${call === 'H' ? 'HEADS' : 'TAILS'}</b></blockquote>\n` +
        `🏆 <b>Team ${winner}</b> wins the toss!\n` +
        `${winCap ? htag(winCap) : 'Captain'}, choose <b>BAT</b> or <b>BALL</b>:`
    );
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery(String(e.message).slice(0, 150), { show_alert: true }).catch(() => {});
  }
});

// /toss: starts the toss when it is time, or shows the current toss step again
bot.command('toss', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode === 'solo') return ctx.reply('❌ There is no team match to toss for');
    if (m.status === 'captains') {
      const ok = await tryBeginToss(ctx.telegram, m.id);
      if (!ok) return ctx.reply('⏳ Both captains must be chosen first (/startgame).');
      return;
    }
    if (m.status !== 'toss') return ctx.reply('ℹ️ The toss is only available after the captains are chosen.');
    if (m.setup_phase === 'call') return sendTossCall(ctx.telegram, m.id);
    if (m.setup_phase === 'flip') {
      if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('🪙 The coin is in the air…');
      await q(`UPDATE matches SET setup_phase='call' WHERE id=$1 AND setup_phase='flip'`, [m.id]);
      return sendTossCall(ctx.telegram, m.id); // host recovery if the flip got stuck
    }
    if (m.setup_phase === 'choice') {
      const t = await getTeam(m.id, m.toss_winner_team);
      const cap = t?.captain_id ? await getPlayerByTg(m.id, t.captain_id) : null;
      return sendTossChoice(
        ctx.telegram,
        m.id,
        `🪙 <b>${fancy('TOSS')}</b>\n🏆 <b>Team ${m.toss_winner_team}</b> won the toss!\n` +
          `${cap ? htag(cap) : 'Captain'}, choose <b>BAT</b> or <b>BALL</b>:`
      );
    }
    return ctx.reply('⏱ The host picks the overs now: /setovers');
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

// ─── Toss choice → then host picks overs ─────────────────
bot.action(/^toss:(.+):(bat|bowl)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const choice = ctx.match[2];
  try {
    const m = await getMatch(matchId);
    if (!m || m.status !== 'toss' || m.setup_phase !== 'choice')
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
       WHERE id=$1 AND status='toss' AND setup_phase='choice' RETURNING id`,
      [m.id, batFirst, bowlFirst]
    );
    if (!upd.rowCount) return ctx.answerCbQuery('Already chosen', { show_alert: true });

    await editCard(
      ctx,
      `✅ Team ${m.toss_winner_team} chose to *${choice === 'bat' ? 'BAT' : 'BALL'}* first\n` +
        `> 🏏 Batting first: Team *${batFirst}*\n` +
        `> 🎳 Bowling first: Team *${bowlFirst}*`
    );
    await ctx.answerCbQuery();
    // Host gets overs buttons automatically — no /setovers needed
    const groupId = Number(m.group_chat_id);
    await ctx.telegram.sendMessage(
      groupId,
      `⏱ *HOST — SET OVERS*\n` +
        `> [Host](tg://user?id=${Number(m.host_telegram_id)}), pick total overs (1–${MAX_OVERS}):`,
      { parse_mode: 'Markdown', ...oversKb(m.id) }
    );
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
    if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only the host can set the overs');
    if (m.mode === 'solo') return ctx.reply('♾ Solo matches do not use fixed overs');
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
    const bowlTeam = await getTeam(m.id, mm.current_bowling_team);
    const batTeam = await getTeam(m.id, mm.current_batting_team);
    const bowlCap = bowlTeam?.captain_id ? await getPlayerByTg(m.id, bowlTeam.captain_id) : null;
    const batCap = batTeam?.captain_id ? await getPlayerByTg(m.id, batTeam.captain_id) : null;
    await sendCaptionedGif(
      ctx.telegram,
      groupId,
      'starter',
      `🏟 <b>${fancy('MATCH STARTED')}</b>\n` +
        `<blockquote>⚙ ${overs} overs · max ${perBowler} per bowler${spamFreeOn(mm) ? ' · 🛡 spam-free' : ' · ⚡ spam'}</blockquote>\n` +
        `🎳 <b>Team ${mm.current_bowling_team} is fielding</b>\n` +
        `<blockquote>${bowlCap ? htag(bowlCap) : 'Captain'}, send your bowler → <code>/ball &lt;no.&gt;</code></blockquote>\n` +
        `🏏 <b>Team ${mm.current_batting_team} is batting</b>\n` +
        `<blockquote>${batCap ? htag(batCap) : 'Captain'}, send your openers → <code>/bat &lt;no.&gt;</code> (twice)</blockquote>`
    );
    await botTeamAssist(m.id);
    await ensureTurnClock(m.id);
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
    if (m.mode === 'solo') return ctx.reply('ℹ️ Solo is automatic — just type 0-6');

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
    if (role === 'non-striker' && inn.striker_player_id && inn.balls_bowled === 0) {
      // both openers are in
      const striker = await getPlayer(inn.striker_player_id);
      const bowlTeam = await getTeam(m.id, inn.bowling_team);
      const cap = bowlTeam?.captain_id ? await getPlayerByTg(m.id, bowlTeam.captain_id) : null;
      await sendCaptionedGif(
        ctx.telegram,
        ctx.chat.id,
        'opener',
        `🏏 <b>OPENERS READY!</b>\n` +
          `🏃 Striker: ${htag(striker)}\n` +
          `🏏 Non-striker: ${htag(p)}\n` +
          (inn.current_bowler_id
            ? `🔥 Game on!`
            : `🎳 Bowling captain ${cap ? htag(cap) : ''}, choose your opening bowler:\n<code>/ball &lt;no.&gt;</code>`)
      );
    }
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
    await ensureTurnClock(m.id);
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});


// Host: /penalty team a -5 abusing   OR  /penalty A -5 reason text
bot.command('penalty', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
    if (Number(ctx.from.id) !== Number(m.host_telegram_id) && !isAdmin(ctx.from.id))
      return ctx.reply('❌ Only the host can give penalties');
    if (m.mode === 'solo')
      return ctx.reply('❌ /penalty is for team matches. Use time-miss penalties for solo.');
    if (!['innings1', 'innings2', 'toss', 'captains', 'waiting'].includes(m.status) && m.status === 'completed')
      return ctx.reply('❌ Match already finished');

    const parts = String(ctx.message?.text || '').trim().split(/\s+/);
    // /penalty team a -5 reason...  OR /penalty A -5 reason
    let team = null;
    let amount = null;
    let reasonStart = 1;
    if (parts[1] && /^team$/i.test(parts[1]) && parts[2]) {
      team = String(parts[2]).toUpperCase().replace(/[^AB]/g, '');
      amount = Number(parts[3]);
      reasonStart = 4;
    } else if (parts[1]) {
      team = String(parts[1]).toUpperCase().replace(/[^AB]/g, '');
      amount = Number(parts[2]);
      reasonStart = 3;
    }
    if (team !== 'A' && team !== 'B')
      return ctx.reply('Usage: `/penalty team a -5 abusing`\nOr: `/penalty A -5 reason`', { parse_mode: 'Markdown' });
    if (!Number.isFinite(amount) || amount === 0)
      return ctx.reply('❌ Amount must be a non-zero number (e.g. -5 or 5). Negative = deduct runs.');
    // host said -5 → deduct 5; host said 5 → also treat as deduct 5 if positive? User said -5 so keep sign.
    // If positive, add runs (bonus); if negative, deduct.
    const delta = amount; // can be negative
    const reason = parts.slice(reasonStart).join(' ').trim() || 'host penalty';

    const inn = await getInnings(m.id);
    const trow = await getTeam(m.id, team);
    if (!trow) return ctx.reply('❌ Team not found');

    // Apply to current innings if this team is batting, else to penalty_runs (starts innings below 0)
    let applied = '';
    if (inn && inn.batting_team === team) {
      await q(`UPDATE innings SET total_runs = total_runs + $2 WHERE id=$1`, [inn.id, delta]);
      applied = `innings score ${delta >= 0 ? '+' : ''}${delta}`;
    } else {
      // store cumulative host penalty on team (penalty_runs is already used for time penalties as negative)
      await q(
        `UPDATE match_teams SET penalty_runs = COALESCE(penalty_runs,0) + $3 WHERE match_id=$1 AND team_label=$2`,
        [m.id, team, delta]
      );
      // If they already batted in a completed innings, adjust that too
      const { rows: past } = await q(
        `SELECT id FROM innings WHERE match_id=$1 AND batting_team=$2 AND is_completed=TRUE ORDER BY innings_number DESC LIMIT 1`,
        [m.id, team]
      );
      if (past[0]) {
        await q(`UPDATE innings SET total_runs = total_runs + $2 WHERE id=$1`, [past[0].id, delta]);
        applied = `completed innings ${delta >= 0 ? '+' : ''}${delta}`;
      } else {
        applied = `pre-innings penalty ${delta >= 0 ? '+' : ''}${delta} (starts from this)`;
      }
    }

    // Log note on match for scoreboard
    await q(`ALTER TABLE matches ADD COLUMN IF NOT EXISTS penalty_log TEXT`);
    const line = `Team ${team} ${delta >= 0 ? '+' : ''}${delta} (${reason})`;
    await q(
      `UPDATE matches SET penalty_log = CASE
         WHEN penalty_log IS NULL OR penalty_log = '' THEN $2
         ELSE penalty_log || E'\\n' || $2
       END WHERE id=$1`,
      [m.id, line]
    );

    await ctx.reply(
      `⚖️ *PENALTY APPLIED*\n` +
        `> Team *${team}*: *${delta >= 0 ? '+' : ''}${delta}* runs\n` +
        `> Reason: *${mdEsc(reason)}*\n` +
        `> (${mdEsc(applied)})`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('penalty', e);
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('score', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
  await sendScoreboard(ctx.telegram, ctx.chat.id, m.id);
});

// ═════════════════ DISCIPLINE: 60s turn clock, penalties, warnings ═════════════════
// Rules
//  • Batsman must type 0-6 within 60s, bowler must pick his number within 60s.
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
const mtag = (p) =>
  isBotId(p.telegram_id ?? p.id) ? `*${mdEsc(name(p))}*` : `[${mdEsc(name(p))}](tg://user?id=${Number(p.telegram_id ?? p.id)})`;

// GIF captions for the extra GIF events (/pgif batentry | bowlentry | dugout=duck out | stance | runup)
const newBowlerCaption = (p) => `🎳 <b>NEW BOWLER</b>\n🎙️ ${escapeHtml(name(p))} takes the ball!`;
const newBatsmanCaption = (p) => `🏏 <b>NEW BATSMAN</b>\n🎙️ ${escapeHtml(name(p))} walks in to bat!`;
const stanceCaption = (p) => `🏏 <b>STANCE</b>\n🎙️ ${escapeHtml(name(p))} takes the stance.`;
const runupCaption = (p) => `🎳 <b>RUN-UP</b>\n🎙️ ${escapeHtml(name(p))} runs in to bowl…`;
const dugoutCaption = (p) => `${pe('batsman','🦆')} <b>DUCK OUT</b>\n🎙️ ${escapeHtml(name(p))} out for 0 — walks back to the pavilion.`;

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
  if (!all.length) return null;
  const fromId = inn.current_bowler_id || inn.last_bowler_id;
  const idx = all.findIndex((p) => p.id === fromId);
  let chosen = null;
  for (let k = 1; k <= all.length; k++) {
    const cand = all[(Math.max(idx, 0) + k) % all.length];
    if (cand.id !== inn.striker_player_id && cand.id !== fromId) {
      chosen = cand;
      break;
    }
  }
  if (!chosen) chosen = all.find((p) => p.id !== inn.striker_player_id) || all[0];
  if (!chosen) return null;
  await q(
    `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2)
     ON CONFLICT (innings_id, player_id) DO NOTHING`,
    [inn.id, chosen.id]
  );
  await q(`UPDATE innings SET current_bowler_id=$2, last_bowler_id=COALESCE($3, last_bowler_id) WHERE id=$1`, [
    inn.id,
    chosen.id,
    fromId || null,
  ]);
  return chosen;
}

// ─── Ball flow + turn clock ──────────────────────────────
// Every ball: 1) the bowler gets a DM and sends his number (0-6) as a message,
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
    ? Markup.inlineKeyboard([[ubtn('𝗢𝗽𝗲𝗻 𝗯𝗼𝘁 𝗗𝗠', `https://t.me/${BOT_USERNAME}`, 'plane', 'primary')]])
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
        `Send your number *1–6* as a message within *${TURN_SECONDS}s* (0 not allowed for bowlers).\n⏱ ${TURN_SECONDS}s or -${TURN_PENALTY} runs.` +
        (spamFreeOn(m) ? `\n🛡 Spam-free: you can't send the same number 3 times in a row.` : ''),
      { parse_mode: 'Markdown' }
    );
    return true;
  } catch (_) {
    return false;
  }
}

// Start the next ball when everybody is in place (no-op otherwise)
async function startBall(matchId) {
  touchMatch(matchId);
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

  const bowlerIsBot = isBotId(bowler.telegram_id);
  const dmOk = bowlerIsBot ? true : await sendBowlerPrompt(tg, pend);
  const hat = await isHatTrickBall({ ...inn, current_bowler_id: bowler.id });
  const html =
    `🎳 <b>${fancy('RUN-UP')}</b>  <i>(Over ${overNum}.${ballNum})</i>\n` +
    `<blockquote>${htag(bowler)} to ${escapeHtml(name(striker))}\n` +
    (bowlerIsBot
      ? `🤖 ${htag(bowler)} is choosing the number…`
      : dmOk
      ? `📩 ${htag(bowler)}, send your bowling number <b>1–6</b> in the bot's DM (${TURN_SECONDS}s)`
      : `⚠️ ${htag(bowler)}, open the bot's DM and press /start — then send <b>1–6</b> (${TURN_SECONDS}s)`) +
    (hat ? `\n🎩 <b>HAT-TRICK BALL!</b>` : '') +
    (spamFreeOn(m) ? `\n🛡 ${pe('ok','🛡')} Spam-free mode: no number 3 times in a row` : '') +
    `</blockquote>`;
  const w = await sendCaptionedGif(tg, groupId, 'runup', html, bowlerIsBot ? {} : openBotDmKb());
  await q(`UPDATE pending_balls SET batting_message_id=$2 WHERE callback_token=$1`, [token, w.message_id]);
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
    await botTeamAssist(matchId);
    await startBall(matchId);
    let st = await turnState(matchId);
    if (st && st.repair) {
      await q(`UPDATE innings SET ball_state='idle' WHERE id=$1 AND ball_state='waiting_bowl'`, [st.inn.id]);
      await startBall(matchId);
      st = await turnState(matchId);
    }
    if (!st) return clearTurnClock(matchId);
    botKick(st).catch(() => {});
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

// Solo: when nobody answers (all players are away) the match ends by itself
const soloIdle = new Map(); // matchId -> timeouts in a row without any ball being played
const soloIdleReset = (matchId) => soloIdle.delete(mkey(matchId));
async function soloIdleHit(m, inn) {
  if (m.mode !== 'solo') return false;
  const c = (soloIdle.get(mkey(m.id)) || 0) + 1;
  soloIdle.set(mkey(m.id), c);
  const players = await getPlayers(m.id, 'A');
  const limit = players.length <= 2 ? 2 : 3;
  if (c < limit) return false;
  soloIdle.delete(mkey(m.id));
  const groupId = Number(m.group_chat_id);
  clearTurnClock(m.id);
  await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
  await bot.telegram.sendMessage(
    groupId,
    `😴 *${fancy('MATCH ENDED')}*\n> Nobody is playing — ${limit} turns in a row timed out.\n> The match is closed automatically.`,
    { parse_mode: 'Markdown' }
  );
  const fresh = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0] || inn;
  await finishSolo(bot.telegram, groupId, m, fresh);
  clearTurnClock(m.id);
  clearWarns(m.id);
  stopIdleWatch(m.id);
  endVote(m.id);
  return true;
}

// Bowler locked his number but the batsman did not type 0-6 in time
async function batTimeout({ m, inn, pend }) {
  touchMatch(m.id);
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
    `${pe('clock','⏰')} *${fancy('TIME UP')}*\n` +
      `> ${mtag(striker)} did not play within ${TURN_SECONDS}s.\n` +
      `> 💥 Penalty: *-${TURN_PENALTY} runs*${isSolo ? '' : ' for Team ' + inn.batting_team}  (warning ${warn}/${BAT_RETIRE_LIMIT})\n` +
      (retire
        ? `> 🚪 ${mtag(striker)} is *retired OUT* after ${BAT_RETIRE_LIMIT} warnings.`
        : `> 👉 Type *0–6* now (${TURN_SECONDS}s)`),
    { parse_mode: 'Markdown' }
  );
  if (isSolo && (await soloIdleHit(m, inn))) return;

  if (!retire) return ensureTurnClock(m.id); // same locked bowler number, fresh clock

  resetWarn(m.id, striker.id, 'bat');
  await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
  await q(`UPDATE batting_stats SET is_out=TRUE WHERE innings_id=$1 AND player_id=$2`, [inn.id, striker.id]);
  await q(
    `UPDATE innings SET total_wickets=total_wickets+1, striker_player_id=NULL, ball_state='idle' WHERE id=$1`,
    [inn.id]
  );
  // OUT gif + tag the retired batsman
  await sendResultGif(
    tg,
    groupId,
    'out',
    undefined,
    `💥 <b>OUT!</b>\n${htag(striker)} is <b>retired OUT</b> after ${BAT_RETIRE_LIMIT} missed turns.`
  );
  // dugout only if duck (0 runs)
  const { rows: rs } = await q(`SELECT runs FROM batting_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, striker.id]);
  if (Number(rs[0]?.runs || 0) === 0) {
    await sendResultGif(tg, groupId, 'dugout', undefined, dugoutCaption(striker));
  }
  const inn2 = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0];
  await progressAfterBall(tg, m, inn2, true);
}

// Bowler did not send his number in time: ball is cancelled, bowler's side loses 6
async function bowlTimeout({ m, inn, pend }) {
  touchMatch(m.id);
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

  const bowler = await getPlayer(inn.current_bowler_id);
  if (!bowler) return;

  const limit = isSolo ? SOLO_BOWLER_WARN_LIMIT : TEAM_BOWLER_WARN_LIMIT;
  const warn = bumpWarn(m.id, bowler.id, 'bowl');
  if (isSolo) await applyPlayerPenalty(inn, bowler);
  else await applyTeamPenalty(m, inn.bowling_team);

  await tg.sendMessage(
    groupId,
    `${pe('clock','⏰')} *${fancy('TIME UP')}*\n` +
      `> ${mtag(bowler)} did not send a number within ${TURN_SECONDS}s.\n` +
      `> 💥 Penalty: *-${TURN_PENALTY} runs*${isSolo ? '' : ' for Team ' + inn.bowling_team}  (warning ${warn}/${limit})\n` +
      `> 🔁 This ball is cancelled.`,
    { parse_mode: 'Markdown' }
  );
  if (isSolo && (await soloIdleHit(m, inn))) return;

  if (warn >= limit) {
    resetWarn(m.id, bowler.id, 'bowl');
    if (isSolo) {
      const nb = await soloRotateBowler(m, inn);
      if (nb) {
        await tg.sendMessage(groupId, `🔄 *BOWLING CHANGE*\n${mtag(nb)} is the new bowler.`, {
          parse_mode: 'Markdown',
        });
        await sendResultGif(tg, groupId, 'bowlentry', undefined, newBowlerCaption(nb));
        await sendScoreboard(tg, groupId, m.id); // solo: new bowler → scoreboard
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
  // Only after /startgame — not during the join lobby (waiting)
  if (!m || !['captains', 'toss'].includes(m.status)) return stopIdleWatch(matchId);

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
    await q(`UPDATE matches SET status='cancelled' WHERE id=$1 AND status IN ('captains','toss')`, [
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
  if (m.status === 'waiting') hint = `Players: /team\\_a or /team\\_b — then the host starts with /startgame.`;
  else if (m.status === 'captains') hint = `Captains: tap your team's "Captain" button.`;
  else if (m.setup_phase === 'overs') hint = `Host: send /setovers and choose the overs.`;
  else if (m.setup_phase === 'choice') hint = `The captain of the toss-winning team must choose BAT or BALL.`;
  else hint = `The captain picked for the toss must choose HEADS or TAILS (/toss shows the buttons again).`;

  const { rows } = await q(`SELECT username, first_name, last_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
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
  const { rows } = await q(`SELECT username, first_name, last_name FROM users WHERE telegram_id=$1`, [m.host_telegram_id]);
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
    if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
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
      ...Markup.inlineKeyboard([[btn('𝗩𝗼𝘁𝗲 𝘁𝗼 𝗰𝗵𝗮𝗻𝗴𝗲 𝗵𝗼𝘀𝘁', `hv:${m.id}`, 'people', 'primary')]]),
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
        ...Markup.inlineKeyboard([[btn('𝗕𝗲𝗰𝗼𝗺𝗲 𝗛𝗼𝘀𝘁', `hc:${m.id}`, 'crown', 'success')]]),
      });
    } else {
      await ctx
        .editMessageText(await voteText(m, v), {
          parse_mode: 'Markdown',
          ...Markup.inlineKeyboard([[btn('𝗩𝗼𝘁𝗲 𝘁𝗼 𝗰𝗵𝗮𝗻𝗴𝗲 𝗵𝗼𝘀𝘁', `hv:${m.id}`, 'people', 'primary')]]),
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
bot.hears(/^[0-6]$/, async (ctx) => {
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

    // hat-trick ball: a dot (0) is not allowed
    if (num === 0 && (await isHatTrickBall(inn))) {
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        `🎩 ${htag(striker)} — <b>0 is not allowed on a hat-trick ball!</b>\nType a number from <b>1–6</b>.`,
        { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true }
      );
      return;
    }

    const claim = await q(
      `UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NOT NULL`,
      [pend.callback_token]
    );
    if (!claim.rowCount) return; // double tap

    // like the batsman's message, the result comes as a reply to it
    try {
      if (typeof ctx.telegram.setMessageReaction === 'function') {
        ctx.telegram
          .setMessageReaction(ctx.chat.id, ctx.message.message_id, [{ type: 'emoji', emoji: '👍' }])
          .catch(() => {});
      }
    } catch (_) {}
    try {
      await resolveBall(ctx.telegram, m, inn, pend, num, ctx.message.message_id);
    } catch (e) {
      // Re-open the ball so the batsman can try again (e.g. after DB constraint fix / restart)
      try {
        await q(
          `UPDATE pending_balls SET is_resolved=FALSE WHERE callback_token=$1 AND bowl_number IS NOT NULL`,
          [pend.callback_token]
        );
      } catch (_) {}
      throw e;
    }
  } catch (e) {
    console.error('ball resolve error:', e);
    try {
      await ctx.reply(
        '⚠️ Could not resolve that ball. Send *0–6* again.\n' +
          String(e.message || e).slice(0, 120),
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}
    try {
      const m2 = await getActiveMatch(ctx.chat.id);
      if (m2) await ensureTurnClock(m2.id);
    } catch (_) {}
  }
});

// Bowler sends his number in the bot's DM → it is linked to the game he is playing in
async function bowlerLocksNumber(ctx, n) {
  try {
    const { rows: pm } = await q(`SELECT match_id FROM pending_balls WHERE bowler_telegram_id=$1 AND is_resolved=FALSE LIMIT 1`, [ctx.from.id]);
    if (pm[0]) soloIdleReset(pm[0].match_id);
  } catch (_) {}
  // Bowlers bowl 1–6 only. 0 is a batsman-only choice (dot ball).
  if (n === 0) {
    return ctx.reply(
      `🚫 *Bowlers cannot send 0.*\nSend a number from *1–6* only.\n(0 = dot ball is for the batsman in the group.)`,
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  }
  if (n < 1 || n > 6) {
    return ctx.reply(`🚫 Send a number from *1–6*.`, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
    });
  }

  const { rows } = await q(
    `SELECT * FROM pending_balls WHERE bowler_telegram_id=$1 AND is_resolved=FALSE AND bowl_number IS NULL`,
    [ctx.from.id]
  );
  if (!rows.length) return ctx.reply('ℹ️ No ball is waiting for your number right now.\nWait for the "YOUR TURN TO BOWL" message, then send your number.');
  const pend = rows[rows.length - 1];

  const m = await getMatch(pend.match_id);
  const { rows: ir } = await q(`SELECT * FROM innings WHERE id=$1`, [pend.innings_id]);
  const inn = ir[0];

  // spam-free mode: the same number 3 times in a row is not allowed
  if (await bowlerSpamBlocked(m, inn, n)) {
    return ctx.reply(`🚫 Spam-free mode: you can't send *${n}* three times in a row.\nChoose a different number (*1–6*).`, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
    });
  }

  const upd = await q(
    `UPDATE pending_balls SET bowl_number=$2 WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NULL RETURNING callback_token`,
    [pend.callback_token, n]
  );
  if (!upd.rowCount) return ctx.reply('⚠️ This ball is no longer waiting for your number.');

  const groupId = Number(m.group_chat_id);
  const striker = await getPlayer(inn.striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);
  const hat = await isHatTrickBall(inn);

  const html =
    `🔒 <b>${fancy('NUMBER LOCKED')}</b>\n` +
    `<blockquote>${bowler ? `<b>${escapeHtml(name(bowler))}</b>` : 'Bowler'} has locked the number!\n` +
    `🏏 ${striker ? htag(striker) : 'Batsman'} takes the stance — send your number <b>${hat ? '1–6' : '0–6'}</b> in the group (${TURN_SECONDS}s)` +
    (hat ? `\n🎩 <b>HAT-TRICK BALL!</b> 0 is not allowed.` : '') +
    `</blockquote>`;
  const lock = await sendCaptionedGif(ctx.telegram, groupId, 'stance', html);
  lockMsgs.set(pend.callback_token, lock.message_id);

  const url = groupMsgLink(groupId, lock.message_id);
  await ctx.reply(`✅ Number *${n}* locked!\n📍 Back to the game: ${mdEsc(m.group_title || 'group')}`, {
    parse_mode: 'Markdown',
    reply_to_message_id: ctx.message.message_id,
    ...(url ? Markup.inlineKeyboard([[ubtn('𝗕𝗮𝗰𝗸 𝘁𝗼 𝗴𝗿𝗼𝘂𝗽', url, 'people')]]) : {}),
  });
  await ensureTurnClock(m.id); // now the batsman is on the clock
}

// Old DM buttons (previous version) are no longer used
bot.action(/^bowl:(.+):([1-6])$/, async (ctx) => {
  await ctx.answerCbQuery('Buttons are no longer used — send your number as a message.', { show_alert: true });
});


// ─── Full match data file (sent when match ends / is cancelled) ───
async function buildMatchDataText(matchId) {
  const m = await getMatch(matchId);
  if (!m) return 'Match not found.';
  const players = await getPlayers(matchId);
  const { rows: inns } = await q(
    `SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`,
    [matchId]
  );
  const { rows: dels } = await q(
    `SELECT d.*, i.innings_number, i.batting_team, i.bowling_team,
            b.username AS bat_user, b.first_name AS bat_first, b.last_name AS bat_last, b.telegram_id AS bat_tg,
            o.username AS bowl_user, o.first_name AS bowl_first, o.last_name AS bowl_last, o.telegram_id AS bowl_tg
       FROM deliveries d
       JOIN innings i ON i.id = d.innings_id
       LEFT JOIN match_players b ON b.id = d.batsman_id
       LEFT JOIN match_players o ON o.id = d.bowler_id
      WHERE i.match_id = $1
      ORDER BY i.innings_number, d.over_number, d.ball_number`,
    [matchId]
  );
  const { rows: bats } = await q(
    `SELECT bs.*, mp.username, mp.first_name, mp.last_name, mp.telegram_id, mp.team_label, mp.roster_position,
            i.innings_number
       FROM batting_stats bs
       JOIN match_players mp ON mp.id = bs.player_id
       JOIN innings i ON i.id = bs.innings_id
      WHERE i.match_id = $1
      ORDER BY i.innings_number, mp.roster_position`,
    [matchId]
  );
  const { rows: bowls } = await q(
    `SELECT bw.*, mp.username, mp.first_name, mp.last_name, mp.telegram_id, mp.team_label, mp.roster_position,
            i.innings_number
       FROM bowling_stats bw
       JOIN match_players mp ON mp.id = bw.player_id
       JOIN innings i ON i.id = bw.innings_id
      WHERE i.match_id = $1
      ORDER BY i.innings_number, mp.roster_position`,
    [matchId]
  );

  const pname = (r) => {
    const full = [r.first_name || r.bat_first || r.bowl_first, r.last_name || r.bat_last || r.bowl_last]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (full) return full;
    const u = r.username || r.bat_user || r.bowl_user;
    if (u) return '@' + u;
    return String(r.telegram_id || r.bat_tg || r.bowl_tg || '—');
  };

  const lines = [];
  lines.push('══════════════════════════════════════');
  lines.push('         CRIC MONSTER — MATCH DATA');
  lines.push('══════════════════════════════════════');
  lines.push(`Match ID     : ${m.id}`);
  lines.push(`Group        : ${m.group_title || m.group_chat_id || '—'}`);
  lines.push(`Mode         : ${m.mode || '—'}`);
  lines.push(`Status       : ${m.status || '—'}`);
  lines.push(`Overs        : ${m.total_overs != null ? m.total_overs : '—'}`);
  lines.push(`Target       : ${m.target != null ? m.target : '—'}`);
  lines.push(`Winner       : ${m.winner_team != null ? m.winner_team : '—'}`);
  lines.push(`Spam-free    : ${m.spam_free ? 'yes' : 'no'}`);
  lines.push(`Created      : ${m.created_at || '—'}`);
  lines.push(`Completed    : ${m.completed_at || '—'}`);
  if (m.penalty_log) {
    lines.push('Penalties    :');
    for (const pl of String(m.penalty_log).split('\n').filter(Boolean)) lines.push('  • ' + pl);
  }
  lines.push('');
  lines.push('── PLAYERS ──');
  for (const p of players) {
    const n = name(p);
    lines.push(
      `  #${p.roster_position || '?'} ${n}` +
        (p.username ? ` (@${p.username})` : '') +
        `  tg:${p.telegram_id}` +
        (p.team_label ? `  Team ${p.team_label}` : '') +
        (p.is_captain ? '  [C]' : '')
    );
  }
  lines.push('');
  for (const inn of inns) {
    lines.push(`── INNINGS ${inn.innings_number} ──`);
    lines.push(
      `  Batting: Team ${inn.batting_team || '—'} | Bowling: Team ${inn.bowling_team || '—'}`
    );
    lines.push(
      `  Score: ${inn.total_runs || 0}/${inn.total_wickets || 0}  (${oversStr(inn.balls_bowled || 0)} ov)` +
        (inn.is_completed ? '  [completed]' : '')
    );
    lines.push('');
    lines.push('  Batting:');
    const innBats = bats.filter((b) => Number(b.innings_number) === Number(inn.innings_number));
    for (const b of innBats) {
      const sr =
        Number(b.balls_faced) > 0
          ? ((Number(b.runs) * 100) / Number(b.balls_faced)).toFixed(1)
          : '0.0';
      lines.push(
        `    ${pname(b)}  ${b.runs || 0}(${b.balls_faced || 0})  4s:${b.fours || 0} 6s:${b.sixes || 0}  SR:${sr}` +
          (b.is_out ? `  OUT${b.dismissal_type ? ' (' + b.dismissal_type + ')' : ''}` : '  not out')
      );
    }
    if (!innBats.length) lines.push('    (none)');
    lines.push('');
    lines.push('  Bowling:');
    const innBowls = bowls.filter((b) => Number(b.innings_number) === Number(inn.innings_number));
    for (const b of innBowls) {
      lines.push(
        `    ${pname(b)}  ${b.wickets || 0}/${b.runs_conceded || 0}  (${oversStr(b.balls_bowled || 0)})`
      );
    }
    if (!innBowls.length) lines.push('    (none)');
    lines.push('');
    lines.push('  Ball-by-ball:');
    const innDels = dels.filter((d) => Number(d.innings_number) === Number(inn.innings_number));
    for (const d of innDels) {
      const res =
        d.is_wicket === true || d.is_wicket === 1 || d.is_wicket === 't'
          ? 'W'
          : String(d.runs_scored);
      lines.push(
        `    ${d.over_number}.${d.ball_number}  bat:${pname({ first_name: d.bat_first, last_name: d.bat_last, username: d.bat_user, telegram_id: d.bat_tg })} ` +
          `(${d.bat_number}) vs bowl:${pname({ first_name: d.bowl_first, last_name: d.bowl_last, username: d.bowl_user, telegram_id: d.bowl_tg })} ` +
          `(${d.bowl_number})  → ${res}`
      );
    }
    if (!innDels.length) lines.push('    (no deliveries)');
    lines.push('');
  }
  lines.push('══════════════════════════════════════');
  lines.push(`Generated by Cric Monster · ${new Date().toISOString()}`);
  return lines.join('\n');
}

async function sendMatchDataFile(telegram, chatId, matchId) {
  try {
    const fsys = require('fs');
    const pathMod = require('path');
    const text = await buildMatchDataText(matchId);
    const dir = pathMod.join('/tmp', 'cricmonster');
    try {
      fsys.mkdirSync(dir, { recursive: true });
    } catch (_) {}
    const filePath = pathMod.join(dir, `match_${matchId}_${Date.now()}.txt`);
    fsys.writeFileSync(filePath, text, 'utf8');
    await telegram.sendDocument(
      chatId,
      { source: filePath, filename: `CricMonster_Match_${matchId}.txt` },
      { caption: '📄 Full match data' }
    );
    try {
      fsys.unlinkSync(filePath);
    } catch (_) {}
  } catch (e) {
    console.error('sendMatchDataFile:', e.message);
    try {
      // Fallback: send as text chunks if file send fails
      const text = await buildMatchDataText(matchId).catch(() => null);
      if (text) {
        await sendLong(telegram, chatId, '📄 *MATCH DATA*\n```\n' + text.slice(0, 3500) + '\n```', {
          parse_mode: 'Markdown',
        });
      } else {
        await telegram.sendMessage(chatId, '⚠️ Could not attach match data file: ' + String(e.message || e).slice(0, 120));
      }
    } catch (_) {}
  }
}

// ─── Match finish (cards) ────────────────────────────────
// Solo: single innings finished (everyone is out)
async function finishSolo(telegram, groupId, m, inn) {
  await q(`UPDATE matches SET status='completed', winner_team='A', completed_at=NOW() WHERE id=$1`, [m.id]);
  const [bat, bowl, aw] = await Promise.all([bestBatter(m.id), bestBowler(m.id), matchAwards(m.id)]);
  saveAwards(m.id, aw).catch((e) => console.error('saveAwards:', e.message));
  const players = await getPlayers(m.id, 'A');
  let vsLine = '';
  if (players.length === 2 && players.some((p) => isBotId(p.telegram_id))) {
    const sts = await Promise.all(players.map((p) => playerMatchStats(m.id, p.telegram_id)));
    const r = sts.map((x) => (x ? x.runs : 0));
    vsLine =
      `⚔️ ${mn(players[0])} *${r[0]}* — *${r[1]}* ${mn(players[1])}\n` +
      (r[0] === r[1] ? `🤝 *It's a tie!*` : `🏆 Winner: *${mn(players[r[0] > r[1] ? 0 : 1])}*`) +
      `\n\n`;
  }
  const caption =
    `🏁 *${fancy('SOLO MATCH OVER')}*\n` +
    `> 👥 Players: *${players.length}*\n` +
    `> 📊 Total: *${inn.total_runs}/${inn.total_wickets}* in ${oversStr(inn.balls_bowled)} overs\n\n` +
    vsLine +
    awardsText(aw);
  await sendSoloFinal(telegram, groupId, m, caption, aw.motm, bat, bowl);
  await sendMotmGif(telegram, groupId, aw.motm);
  try { await sendLong(telegram, groupId, await fullScorecard(m.id)); } catch (_) {}
  await sendMatchDataFile(telegram, groupId, m.id);
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
  let caption = `🏁 *${fancy('MATCH OVER')}*\n${resultLine}\n`;
  for (const i of inns) {
    caption += `> Team ${i.batting_team}: *${i.total_runs}/${i.total_wickets}* (${oversStr(i.balls_bowled)} ov)\n`;
  }
  caption += `\n`;
  const aw = await matchAwards(m.id, winner);
  saveAwards(m.id, aw).catch((e) => console.error('saveAwards:', e.message));
  caption += `${awardsText(aw)}`;
  await sendTeamFinal(telegram, groupId, m, caption, { inns, winner, motm: aw.motm });
  await sendMotmGif(telegram, groupId, aw.motm);
  await sendLong(telegram, groupId, await fullScorecard(m.id));
  await sendMatchDataFile(telegram, groupId, m.id);
}


// English over summary (last 6 balls)
async function overSummary(matchId, inn) {
  try {
    const overNo = Math.floor((inn.balls_bowled - 1) / 6) + 1; // just finished over
    const { rows } = await q(
      `SELECT d.bat_number, d.bowl_number, d.runs_scored, d.is_wicket,
              b.username AS bu, b.first_name AS bf, o.username AS ou, o.first_name AS ofn
         FROM deliveries d
         LEFT JOIN match_players b ON b.id = d.batsman_id
         LEFT JOIN match_players o ON o.id = d.bowler_id
        WHERE d.innings_id=$1 AND d.over_number=$2
        ORDER BY d.ball_number`,
      [inn.id, overNo]
    );
    if (!rows.length) return `> Over ${overNo}: no balls logged`;
    const bowler = rows[0];
    const bName = bowler.ou ? '@' + bowler.ou : (bowler.ofn || 'Bowler');
    let runs = 0, wk = 0;
    const balls = [];
    for (const r of rows) {
      if (r.is_wicket === true || r.is_wicket === 1 || r.is_wicket === 't') {
        balls.push('W');
        wk += 1;
      } else {
        balls.push(String(r.runs_scored));
        runs += Number(r.runs_scored) || 0;
      }
    }
    const seq = balls.join(' · ');
    return (
      `> 📊 *Over ${overNo} summary*\n` +
      `> 🎳 Bowler: *${mdEsc(bName)}*\n` +
      `> 🏏 Balls: \`${seq}\`\n` +
      `> 📈 Runs this over: *${runs}*${wk ? ` · Wickets: *${wk}*` : ''}`
    );
  } catch (e) {
    console.error('overSummary', e.message);
    return '> Over summary unavailable';
  }
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
  // scoreboard: team → at the end of every over; solo → when a new bowler comes
  let showBoard = !isSolo && inn2.balls_bowled > 0 && inn2.balls_bowled % 6 === 0;
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
      if (innNew.current_bowler_id !== inn2.current_bowler_id) showBoard = true; // bowling changed
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
      const ovSum = await overSummary(m.id, inn2);
      await telegram.sendMessage(
        groupId,
        `🔔 *Over complete!*\n${ovSum}\n👑 Team ${inn2.bowling_team}: /ball <no.>`,
        { parse_mode: 'Markdown' }
      );
    }

    // Solo: new bowler every 3 balls
    if (isSolo && !inn2.current_bowler_id && inn2.striker_player_id) {
      const prevBowler = inn2.last_bowler_id || inn2.current_bowler_id;
      const bw = await soloRotateBowler(m, inn2);
      if (bw) {
        inn2 = (await q(`SELECT * FROM innings WHERE id=$1`, [inn2.id])).rows[0] || inn2;
        // announce only when the ball really goes to a different player
        if (bw.id !== prevBowler) {
          showBoard = true;
          await telegram.sendMessage(groupId, `🎳 *New bowler:* *${mn(bw)}*`, { parse_mode: 'Markdown' });
          try {
            await sendResultGif(telegram, groupId, 'bowlentry', undefined, newBowlerCaption(bw));
          } catch (_) {}
        }
      }
    }
  }

  if (matchFinished) {
    clearTurnClock(m.id);
    clearWarns(m.id);
    stopIdleWatch(m.id);
    endVote(m.id);
  } else {
    if (showBoard) await sendScoreboard(telegram, groupId, m.id);
    await ensureTurnClock(m.id);
  }
}

const COMMENT = {
  '0': [
    'Dot ball! The pressure builds.',
    'Solid defence, nothing doing.',
    'Tight line — zero runs.',
    'Blocked. Scoreboard stays put.',
    'Dot! Bowler wins that duel.',
    'No run — pure patience.',
    'Dead bat, dead ball, dead silence.',
    'Dot ball. The squeeze is on.',
    'Left alone — smart cricket.',
    'Pushed to the fielder, no single.',
    'Dot! Camera crew almost fell asleep.',
    'Textbook defence, zero reward.',
    'Nothing off that delivery.',
    'Dot ball keeps the rate honest.',
    'Beaten outside off — still a dot.',
    'Maiden pressure continues.',
    'Soft hands, hard reality: no run.',
    'Dot! Bowler pumps the fist.',
    'Played back carefully — zero.',
    'That one had no room to score.',
    'Dot ball. Chess, not checkers.',
    'Prodding and poking — still zero.',
    'No width, no run.',
    'Dot! Crowd wants boundary, gets nothing.',
    'Solid as a wall.',
    'Back foot block — score stays same.',
    'Dot ball. Next one loads up.',
    'Can\'t get it away.',
    'Dot! Fielders clap the effort.',
    'Respect the good ball.',
    'Zero on the board from that.',
    'Dot ball builds the over.',
    'Played down the line — nothing.',
    'Tight stuff from the bowler.',
    'Dot! Batsman resets the stance.',
    'No pace off the bat.',
    'Defended under the eyes.',
    'Dot ball — plan working.',
    'Squeezed out, no single available.',
    'Dot! Over still young.',
    'Left on length — zero.',
    'Stonewall defence.',
    'Dot ball. Pressure index rising.',
    'Nowhere to go with that.',
    'Blocked to cover, no run.',
    'Dot! Pure concentration.',
    'Good ball, better defence, still zero.',
    'Dot ball keeps them guessing.',
    'No freebies here.',
    'Dot! Next ball is the big one.',
  ],
  '1': [
    'Quick single, scoreboard ticks.',
    'Nudged into the gap for one.',
    'Smart cricket — easy single.',
    'Soft hands, taken one.',
    'One run, strike rotated.',
    'Pushed wide of mid-on for a single.',
    'They scamper one.',
    'Quick call, safe single.',
    'Tucked to leg for one.',
    'Single keeps the board moving.',
    'Drop and run — well judged.',
    'One to the total.',
    'Glanced fine for a single.',
    'Worked into the gap.',
    'Easy single on offer, taken.',
    'One run, no drama.',
    'Rotated the strike neatly.',
    'Pushed off the pads for one.',
    'Single! Good running.',
    'Opened the face for one.',
    'Soft push, hard run — one.',
    'Taken a sharp single.',
    'One more on the board.',
    'Nudged and gone.',
    'Single to long-on.',
    'Quick feet, one run.',
    'Steered to third for one.',
    'One! Keeps the bowler thinking.',
    'Placed, not powered — single.',
    'They jog a comfortable one.',
    'Single from a thick edge, safe.',
    'Worked to square leg for one.',
    'One run, innings ticking.',
    'Dabbed down for a single.',
    'Smart single under pressure.',
    'One off the hips.',
    'Rotated again — single.',
    'Pushed to midwicket, one.',
    'Single keeps the partnership alive.',
    'Easy one, no throw.',
    'Taken the one on offer.',
    'Soft hands for a single.',
    'One! Rate holds steady.',
    'Glided to third man for one.',
    'Single, and breathe.',
    'Worked square for one.',
    'One run — simple cricket.',
    'Drop it and go.',
    'Single stolen smartly.',
    'One to the total, well run.',
  ],
  '2': [
    'Two runs! Good placement.',
    'They come back for two.',
    'Placed in the gap — easy couple.',
    'Two more on the board.',
    'Driven wide, two taken.',
    'Excellent running, two runs.',
    'Punched through, they take two.',
    'Two! Fielders slow to react.',
    'Worked away for a couple.',
    'Hard run two, well called.',
    'Two runs into the deep.',
    'Placed past the fielder for two.',
    'They hustle two.',
    'Couple of runs, nice shot.',
    'Two on the bounce to the sweeper.',
    'Good judgment — two runs.',
    'Two! Partnership growing.',
    'Angled away for two.',
    'They pick up two comfortably.',
    'Driven to the gap for two.',
    'Two runs, no risk.',
    'Worked off the pads for two.',
    'Two! Scoreboard rolling.',
    'Bisected the field for a couple.',
    'Two runs into the vacant area.',
    'Hard flat throw, still two.',
    'They steal a second.',
    'Two more, well placed.',
    'Couple taken with ease.',
    'Two runs — positive intent.',
    'Punched down the ground for two.',
    'Two! Keep them coming.',
    'Opened up for a couple.',
    'Two into the deep midwicket.',
    'They race back for two.',
    'Nice timing, two runs.',
    'Two off a controlled pull.',
    'Couple more, rate lifts.',
    'Two runs past point.',
    'They pick two with soft hands.',
    'Two! Good cricket all round.',
    'Driven hard, cut off — still two.',
    'Two runs, no sweat.',
    'Worked square for a couple.',
    'Two! Building an over.',
    'Placed perfectly for two.',
    'They jog two, calm heads.',
    'Two more in the book.',
    'Couple of runs, pressure eases.',
    'Two! Nicely done.',
  ],
  '3': [
    'Three runs! Superb running.',
    'They push hard for three.',
    'Three! Excellent hustle.',
    'Driven deep, three taken.',
    'Three runs — rare and valuable.',
    'All the way for three!',
    'Great call, three runs.',
    'Three! Fielders exhausted.',
    'Pushed into the deep for three.',
    'Three runs, pure athleticism.',
    'They scamper three brilliantly.',
    'Three! Over just got expensive.',
    'Hard running yields three.',
    'Three runs past the sweeper.',
    'They dare a third — make it!',
    'Three! Momentum shift.',
    'Driven wide, three completed.',
    'Three runs on the board.',
    'Hustle of the over — three.',
    'Three! Captain loves that.',
    'Outfield slow, still three.',
    'Three runs, no throw in time.',
    'They steal three with sharp legs.',
    'Three! Big over brewing.',
    'Pushed past mid-off for three.',
    'Three runs — high value.',
    'They turn two into three.',
    'Three! Outstanding running.',
    'Deep in the pocket, three taken.',
    'Three runs, field looks ragged.',
    'They go for three and get it.',
    'Three! Rate jumps.',
    'Excellent placement for three.',
    'Three runs off a controlled drive.',
    'They charge the third.',
    'Three! Crowd on its feet.',
    'Worked into a huge gap for three.',
    'Three runs, pure determination.',
    'They make three look easy.',
    'Three! Keep the foot down.',
    'Long chase, three completed.',
    'Three runs — smart cricket.',
    'They push every yard for three.',
    'Three! Over tilted their way.',
    'Driven hard, three all the way.',
    'Three runs into the deep.',
    'They earn every one of those three.',
    'Three! Brilliant between the wickets.',
    'Gap found, three taken.',
    'Three runs — job done.',
  ],
  '4': [
    'FOUR! Races away to the fence.',
    'Cracked through the covers — boundary!',
    'Four runs! Timed to perfection.',
    'That pierces the field — FOUR!',
    'Boundary! No chance for the fielder.',
    'Four! Sweet sound off the bat.',
    'Driven to the rope for four.',
    'FOUR! Overpitched and punished.',
    'Cut away for a blistering four.',
    'Four runs, pure class.',
    'Pulled to the fence — FOUR!',
    'Four! Bowler under pressure.',
    'Threaded the gap for four.',
    'FOUR! Scoreboard jumps.',
    'Lofted just over — one bounce four.',
    'Four runs along the carpet.',
    'Smashed past midwicket for four.',
    'FOUR! Statement shot.',
    'Guided to the third-man boundary.',
    'Four! Free swing, full reward.',
    'Cover drive for four — textbook.',
    'FOUR! Crowd roars.',
    'Whipped off the pads to the fence.',
    'Four runs, no stopping that.',
    'Upper cut for four!',
    'FOUR! Rate skyrockets.',
    'Drilled down the ground for four.',
    'Four! Fielders can only watch.',
    'Square drive races away — four.',
    'FOUR! Perfect timing.',
    'Slogged to cow corner for four.',
    'Four runs, over getting messy.',
    'Late cut for four — delicate.',
    'FOUR! Power and placement.',
    'Hammered through extra cover.',
    'Four! Bowler resets the mark.',
    'Flicked fine for four.',
    'FOUR! Absolute bullet.',
    'Stepped down and four more.',
    'Four runs to long-on.',
    'FOUR! In the slot, out of the park almost.',
    'Cut hard past point for four.',
    'Four! Partnership on fire.',
    'Driven on the up for four.',
    'FOUR! Classic shot.',
    'Pulled in front of square for four.',
    'Four runs, clean as a whistle.',
    'FOUR! No second thoughts.',
    'Bludgeoned to the boundary.',
    'Four! Take a bow.',
  ],
  '5': [
    'Five runs! Overthrow chaos.',
    'Five! Misfield gifts extras.',
    'Unusual five — running and a wild throw.',
    'Five runs! Fielders all over the place.',
    'Five! Bonus from the chaos.',
    'Overthrow turns two into five.',
    'Five runs — rare score.',
    'Five! Comedy of errors.',
    'They scramble five somehow.',
    'Five runs off a single bad throw.',
    'Five! Captain is not amused.',
    'Wild throw, five completed.',
    'Five runs — unexpected gift.',
    'Five! Keep running!',
    'Misfield and five on the board.',
    'Five runs from pure hustle plus error.',
    'Five! Over already expensive.',
    'They turn a two into five.',
    'Five runs — scoreboard confuses itself.',
    'Five! Fielding coach covers face.',
    'Overthrow special — five runs.',
    'Five runs, take them all.',
    'Five! Chaos cricket.',
    'Bad bounce, worse throw — five.',
    'Five runs into the total.',
    'Five! Never leave a throw unpunished.',
    'They steal five with sharp eyes.',
    'Five runs — highlight of the over.',
    'Five! Bowler can\'t believe it.',
    'Misfield parade ends in five.',
    'Five runs, pure opportunism.',
    'Five! Legs and luck.',
    'Throw misses, five finished.',
    'Five runs — rare as a unicorn.',
    'Five! Keep the scoreboard honest.',
    'They push for everything — five.',
    'Five runs from one loose moment.',
    'Five! Over the top drama.',
    'Bonus five after the fumble.',
    'Five runs — smile on the faces.',
    'Five! Fielding nightmare.',
    'They convert two into five.',
    'Five runs, absolute mess.',
    'Five! Take the freebies.',
    'Overthrow five, loud cheers.',
    'Five runs — unexpected jackpot.',
    'Five! Never stop running.',
    'Wild arm, five on the board.',
    'Five runs from the mix-up.',
    'Five! Chaos pays off.',
  ],
  '6': [
    'SIX! Gone into the crowd!',
    'Maximum! Out of the ground!',
    'Six runs! Absolute rocket.',
    'SIX! Bowler can only watch.',
    'Smashed into the stands — six!',
    'Six! Huge hit.',
    'Lofted high and handsome — SIX!',
    'Six runs over long-on.',
    'SIX! In the slot and dispatched.',
    'Picked up and deposited — six!',
    'Six! Rate goes through the roof.',
    'Clean strike, six more.',
    'SIX! Monster hit.',
    'Swung through the line for six.',
    'Six runs into the second tier.',
    'SIX! Statement of intent.',
    'Hammered over midwicket for six.',
    'Six! No chance for anyone.',
    'Stepped out and six!',
    'SIX! Crowd loses it.',
    'Muscled over the rope for six.',
    'Six runs — pure power.',
    'SIX! Length ball punished.',
    'Flat six over extra cover!',
    'Six! Bowler stares at the sky.',
    'Launched into orbit — six.',
    'SIX! Partnership exploding.',
    'Full toss, six runs.',
    'Six! Take that.',
    'Slog-swept for a big six.',
    'SIX! Maximum damage.',
    'High and long — six more.',
    'Six runs, clean as can be.',
    'SIX! Over the sightscreen.',
    'Bludgeoned for six.',
    'Six! Free hit energy without the free hit.',
    'Danced down, six up!',
    'SIX! Absolute meat of the bat.',
    'Picked the bones out — six.',
    'Six runs into the night.',
    'SIX! Captain wants another.',
    'Swung hard, six hard.',
    'Six! Fielders don\'t even move.',
    'Lofted straight for six.',
    'SIX! Scoreboard on fire.',
    'Into the crowd for six more.',
    'Six! Pure timing, not just muscle.',
    'SIX! Over is ruined.',
    'Deposited over cow corner — six.',
    'Six! Stand and deliver.',
  ],
  'out': [
    'Same number — OUT! Bowler wins.',
    'OUT! Numbers matched perfectly.',
    'Wicket! Mind games over.',
    'Bowled him — same number!',
    'OUT! Time to walk back.',
    'Gone! Bowler read it right.',
    'Wicket! The guess was perfect.',
    'OUT! Partnership broken.',
    'Same digits, different fate — OUT.',
    'Wicket! Crowd erupts.',
    'OUT! Batsman can\'t believe it.',
    'Numbers aligned — that\'s out.',
    'Wicket! Fresh batter please.',
    'OUT! Plan executed.',
    'Same number seals it — OUT.',
    'Wicket! Bowler celebrates.',
    'OUT! End of the road this over.',
    'Matched and dispatched — OUT.',
    'Wicket! Pressure paid off.',
    'OUT! Simple as matching numbers.',
    'Gone for a duck / big score — still OUT.',
    'Wicket! Next please.',
    'OUT! The mind game is real.',
    'Same call, different result — wicket.',
    'OUT! Bowler had the last laugh.',
    'Wicket! Stumps in the mind.',
    'OUT! Walk back to the dugout.',
    'Numbers don\'t lie — OUT.',
    'Wicket! Over just flipped.',
    'OUT! Perfect read by the bowler.',
    'Same number, game over for the batter.',
    'Wicket! Celebration time.',
    'OUT! That one hurt.',
    'Matched on the money — OUT.',
    'Wicket! New batter incoming.',
    'OUT! Classic hand-cricket dismissal.',
    'Same guess, fatal result.',
    'Wicket! Keep them coming.',
    'OUT! No second chance.',
    'Numbers collided — batter out.',
    'Wicket! Pure skill in the call.',
    'OUT! Innings takes a hit.',
    'Same number strikes again.',
    'Wicket! Bowler on fire.',
    'OUT! That\'s the danger of matching.',
    'Mind-read complete — OUT.',
    'Wicket! Big moment.',
    'OUT! Back to the pavilion.',
    'Same number, different emotion — OUT.',
    'Wicket! The bowler smiles.',
  ],
};
const pick = (a) => a[Math.floor(Math.random() * a.length)];

// ─── Resolve a ball: bowler number (locked) vs batsman number ───────────
async function resolveBall(telegram, m, inn, pend, batNum, batMsgId) {
  touchMatch(m.id);
  soloIdleReset(m.id);
  const bowlNum = Number(pend.bowl_number);
  const isWicket = Number(batNum) === bowlNum;
  const runs = isWicket ? 0 : Number(batNum) || 0;
  const strikerId = inn.striker_player_id;
  const nonId = inn.non_striker_player_id;
  const bowlerId = inn.current_bowler_id;
  const isSolo = m.mode === 'solo';
  const groupId = Number(m.group_chat_id);

  clearTurnClock(m.id);

  const client = await pool.connect();
  try {
      await client.query('BEGIN');

      // Ensure stats rows exist (avoids silent no-op updates)
      if (strikerId) {
        await client.query(
          `INSERT INTO batting_stats (innings_id, player_id) VALUES ($1,$2)
           ON CONFLICT (innings_id, player_id) DO NOTHING`,
          [inn.id, strikerId]
        );
      }
      if (bowlerId) {
        await client.query(
          `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2)
           ON CONFLICT (innings_id, player_id) DO NOTHING`,
          [inn.id, bowlerId]
        );
      }

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

      // Solo: new bowler every 3 balls; team: clear on over end
      let currentBowler = bowlerId;
      let lastBowler = inn.last_bowler_id || bowlerId;
      if (isSolo) {
        // every bowler gets his own 3 (or 6) balls, counted from the moment he takes the ball
        const per = Number(m.solo_balls) === 6 ? 6 : 3;
        const { rows: stint } = await client.query(
          `SELECT bowler_id FROM deliveries WHERE innings_id=$1 ORDER BY over_number DESC, ball_number DESC LIMIT 60`,
          [inn.id]
        );
        let run = 0;
        for (const r of stint) {
          if (r.bowler_id !== bowlerId) break;
          run++;
        }
        if (run > 0 && run % per === 0) {
          currentBowler = null; // progressAfterBall will pick next bowler
          lastBowler = bowlerId;
        }
      } else {
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
          (Number(inn.total_runs) || 0) + runs,
          (Number(inn.total_wickets) || 0) + (isWicket ? 1 : 0),
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

  // result: reply to the batsman's message, with the saved GIF (or plain text) + commentary
  const head = isWicket
    ? `${pe('no','💥')} <b>WICKET!</b>`
    : runs === 0
    ? `${pe('ball','⚪')} <b>DOT BALL</b>`
    : `${runs === 6 ? pe('six','🚀') : runs === 4 ? pe('bat','🏏') : pe('bat','🏏')} <b>${runs} RUN${runs === 1 ? '' : 'S'}!</b>`;
  const cmt = pick(COMMENT[isWicket ? 'out' : String(runs)] || COMMENT['0'] || ['Nice ball.']);

  // milestones (each has its own /pgif GIF; the normal result GIF is the fallback)
  const strikerP = await getPlayer(strikerId);
  const nonP = nonId ? await getPlayer(nonId) : null;
  const { rows: bsr } = await q(`SELECT runs FROM batting_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, strikerId]);
  const afterRuns = Number(bsr[0]?.runs ?? 0);
  const beforeRuns = afterRuns - runs;
  const { rows: bwr } = await q(`SELECT wickets FROM bowling_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, bowlerId]);
  const bowlWk = Number(bwr[0]?.wickets ?? 0);
  const bowlerP = await getPlayer(bowlerId);
  const gifKeys = [];
  const notes = [];
  const disp = (p) => (p ? htag(p) : '—');

  // personal batting milestones: 50 / 100 / 150 / 200
  const batMilestones = [200, 150, 100, 50];
  let hitBatMs = null;
  if (!isWicket) {
    for (const ms of batMilestones) {
      if (beforeRuns < ms && afterRuns >= ms) {
        hitBatMs = ms;
        break;
      }
    }
  }

  if (isWicket) {
    const { rows: last3 } = await q(
      `SELECT bowler_id, is_wicket FROM deliveries WHERE innings_id=$1 ORDER BY over_number DESC, ball_number DESC LIMIT 3`,
      [inn.id]
    );
    const hat =
      last3.length === 3 &&
      last3.every((r) => r.bowler_id === bowlerId && (r.is_wicket === true || r.is_wicket === 1 || r.is_wicket === 't'));
    if (hat) {
      gifKeys.push('hatrick');
      notes.push(
        `${pe('trophy','🎩')} <b>${fancy('HAT-TRICK')}!</b>\n` +
          `${pe('ok','🎊')} Congratulations ${disp(bowlerP)} — <b>three wickets in three balls!</b>`
      );
    }
    if (bowlWk === 5) {
      gifKeys.push('5fer');
      notes.push(
        `${pe('trophy','🖐')} <b>${fancy('FIVE-FOR')}!</b>\n` +
          `${pe('ok','🎊')} Congratulations ${disp(bowlerP)} — <b>5 wickets!</b> Absolute domination.`
      );
    } else if (bowlWk === 3) {
      gifKeys.push('3w');
      notes.push(
        `${pe('bat','🏏')} <b>${fancy('3 WICKETS')}!</b>\n` +
          `${pe('ok','🎊')} Congratulations ${disp(bowlerP)} — <b>3 wickets</b> and still hungry!`
      );
    }
    if (afterRuns === 0) {
      gifKeys.push('dugout');
      notes.push(`${pe('batsman','🦆')} <b>DUCK OUT!</b> ${disp(strikerP)} is out for 0.`);
    }
    gifKeys.push('out');
  } else {
    if (hitBatMs === 200) {
      gifKeys.push('200');
      notes.push(
        `${pe('trophy','🏆')} <b>${fancy('DOUBLE CENTURY')}!</b>\n` +
          `${pe('ok','🎊')} Congratulations ${disp(strikerP)} — hit the <b>200!</b>`
      );
    } else if (hitBatMs === 150) {
      gifKeys.push('150');
      notes.push(
        `${pe('star','💎')} <b>${fancy('150 RUNS')}!</b>\n` +
          `${pe('ok','🎊')} Congratulations ${disp(strikerP)} — hit the <b>150!</b>`
      );
    } else if (hitBatMs === 100) {
      gifKeys.push('100');
      notes.push(
        `${pe('star','💯')} <b>${fancy('CENTURY')}!</b>\n` +
          `${pe('ok','🎊')} Congratulations ${disp(strikerP)} — hit the <b>100!</b>`
      );
    } else if (hitBatMs === 50) {
      gifKeys.push('50');
      notes.push(
        `${pe('spark','🌟')} <b>${fancy('FIFTY')}!</b>\n` +
          `${pe('ok','🎊')} Congratulations ${disp(strikerP)} — hit the <b>50!</b>`
      );
    }
    if (runs === 0) gifKeys.push('0', 'dot');
    else gifKeys.push(String(runs));
  }

  // Partnership milestones (team mode only): runs since last wicket
  if (!isSolo && !isWicket && nonP) {
    try {
      const { rows: pr } = await q(
        `SELECT COALESCE(SUM(runs_scored),0)::int AS pruns
           FROM deliveries
          WHERE innings_id=$1
            AND id > COALESCE(
              (SELECT id FROM deliveries WHERE innings_id=$1 AND is_wicket=TRUE
                ORDER BY over_number DESC, ball_number DESC LIMIT 1),
              0
            )`,
        [inn.id]
      );
      const partAfter = Number(pr[0]?.pruns || 0);
      const partBefore = partAfter - runs;
      const partMs = [200, 150, 100, 50];
      for (const ms of partMs) {
        if (partBefore < ms && partAfter >= ms) {
          notes.push(
            `${pe('hand','🎊')}🎊🎊🎊 <b>${fancy(ms + '-RUN PARTNERSHIP')}!</b>\n` +
              `${disp(strikerP)} &amp; ${disp(nonP)} — <b>${ms} runs</b> together!`
          );
          // reuse personal milestone GIF if no better key; optional partnership uses 50/100 gif
          if (ms === 200) gifKeys.unshift('200');
          else if (ms === 150) gifKeys.unshift('150');
          else if (ms === 100) gifKeys.unshift('100');
          else gifKeys.unshift('50');
          break;
        }
      }
    } catch (e) {
      console.error('partnership check', e.message);
    }
  }
  // Only batsman number is shown publicly — bowler's number stays hidden
  const html =
    `${head}  ·  <b>${batNum}</b>\n` +
    `<blockquote>🎙️ <i>${escapeHtml(cmt)}</i></blockquote>` +
    (notes.length ? `\n${notes.join('\n')}` : '');
  try {
    await sendCaptionedGif(telegram, groupId, gifKeys, html, {
      reply_to_message_id: Number(batMsgId) || undefined,
    });
  } catch (e) {
    console.error('result gif/text failed:', e.message);
    try {
      await telegram.sendMessage(groupId, stripPe(html), { parse_mode: 'HTML' });
    } catch (_) {}
  }

  try {
    await progressAfterBall(telegram, m, inn2, isWicket);
  } catch (e) {
    console.error('progressAfterBall failed:', e.message);
    try {
      await ensureTurnClock(m.id);
    } catch (_) {}
  }
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

// Time penalties can push scores below zero. Also bat_number must allow 0 (dot ball).
// Drop bad CHECKs at startup and install correct ranges.
async function relaxNegativeRunConstraints() {
  try {
    const { rows } = await q(
      `SELECT c.conname, c.conrelid::regclass::text AS tbl, pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
        WHERE c.contype='c'
          AND (
            c.conrelid::regclass::text IN (
              'innings','batting_stats','deliveries',
              'public.innings','public.batting_stats','public.deliveries'
            )
            OR c.conname ILIKE '%bat_number%'
            OR c.conname ILIKE '%bowl_number%'
            OR c.conname ILIKE '%runs%'
          )`
    );
    for (const r of rows) {
      const def = String(r.def || '');
      const drop =
        /\b(total_runs|runs)\b\s*>=\s*0|\b(total_runs|runs)\b\s*>\s*-1/i.test(def) ||
        /bat_number/i.test(def) ||
        /bowl_number/i.test(def) ||
        /deliveries_bat_number_check/i.test(r.conname) ||
        /deliveries_bowl_number_check/i.test(r.conname);
      if (drop) {
        try {
          await q(`ALTER TABLE ${r.tbl} DROP CONSTRAINT IF EXISTS "${r.conname}"`);
          console.log(`Dropped constraint ${r.conname} on ${r.tbl}`);
        } catch (e2) {
          console.error(`drop ${r.conname}:`, e2.message);
        }
      }
    }
  } catch (e) {
    console.error('constraint check skipped:', e.message);
  }

  // Correct ranges: batsman 0–6 (0 = dot), bowler 1–6
  try {
    await q(`ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_bat_number_check`);
    await q(`ALTER TABLE deliveries DROP CONSTRAINT IF EXISTS deliveries_bowl_number_check`);
    await q(
      `ALTER TABLE deliveries ADD CONSTRAINT deliveries_bat_number_check CHECK (bat_number >= 0 AND bat_number <= 6)`
    );
    await q(
      `ALTER TABLE deliveries ADD CONSTRAINT deliveries_bowl_number_check CHECK (bowl_number IS NULL OR (bowl_number >= 1 AND bowl_number <= 6))`
    );
    console.log('deliveries bat/bowl number checks set (bat 0–6, bowl 1–6)');
  } catch (e) {
    console.error('deliveries check install:', e.message);
  }
}

// ═════════════════ STUCK GAME WATCHDOG ═════════════════
// If a live match has no ball progress for STUCK_MINUTES, auto-cancel so the GC can start a new game.
async function lastMatchActivity(matchId) {
  const mem = matchActivity.get(mkey(matchId));
  if (mem) return mem;
  try {
    const { rows } = await q(
      `SELECT COALESCE(
          (SELECT MAX(d.created_at) FROM deliveries d
             JOIN innings i ON i.id = d.innings_id WHERE i.match_id = $1),
          (SELECT created_at FROM matches WHERE id = $1),
          NOW()
        ) AS last_at`,
      [matchId]
    );
    return rows[0]?.last_at ? new Date(rows[0].last_at).getTime() : Date.now();
  } catch (e) {
    console.error('lastMatchActivity:', e.message);
    return Date.now();
  }
}

async function cancelStuckMatch(m, reason) {
  try {
    clearTurnClock(m.id);
    stopIdleWatch(m.id);
    clearLobby(m.id);
    matchActivity.delete(mkey(m.id));
    await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE match_id=$1 AND is_resolved=FALSE`, [m.id]);
    await q(
      `UPDATE matches SET status='cancelled' WHERE id=$1 AND status NOT IN ('completed','cancelled')`,
      [m.id]
    );
    const groupId = Number(m.group_chat_id);
    await bot.telegram.sendMessage(
      groupId,
      `🛑 *GAME AUTO-CANCELLED*\n` +
        `> No response for *${STUCK_MINUTES} minutes*.\n` +
        `> ${reason || 'Match was stuck.'}\n` +
        `> Start a new one with /team or /startsolo.`,
      { parse_mode: 'Markdown' }
    );
    await sendMatchDataFile(bot.telegram, groupId, m.id);
  } catch (e) {
    console.error('cancelStuckMatch:', e.message);
  }
}

async function stuckGamesTick() {
  try {
    const { rows } = await q(
      `SELECT * FROM matches WHERE status IN ('innings1','innings2','captains','toss','waiting')`
    );
    const now = Date.now();
    const limit = STUCK_MINUTES * 60 * 1000;
    for (const m of rows) {
      const last = await lastMatchActivity(m.id);
      // lobby/setup: also respect idle watch, but hard-cap at STUCK_MINUTES of zero delivery activity
      if (now - last >= limit) {
        await cancelStuckMatch(m, 'Players did not respond — freeing the group for a new game.');
      }
    }
  } catch (e) {
    console.error('stuckGamesTick:', e.message);
  }
}

setInterval(() => stuckGamesTick().catch(() => {}), STUCK_CHECK_MS);



// ─── Practice modes: bot players (/vsbotsolo, /botteam) ──────────────────────────
// Bot players are normal match_players rows with a negative telegram_id (-1001, -1002 …).
const BOT_ID_START = -1001;
const isBotId = (id) => id !== null && id !== undefined && Number.isFinite(Number(id)) && Number(id) <= BOT_ID_START;
const botTgId = (n) => -1000 - Number(n); // Bot 1 -> -1001

async function addBotPlayer(matchId, label, n) {
  const id = botTgId(n);
  await q(
    `INSERT INTO users (telegram_id, username, first_name, last_name) VALUES ($1,NULL,$2,NULL)
     ON CONFLICT (telegram_id) DO NOTHING`,
    [id, `Bot ${n}`]
  );
  const { rows } = await q(
    `SELECT COALESCE(MAX(roster_position),0)+1 AS n FROM match_players WHERE match_id=$1 AND team_label=$2`,
    [matchId, label]
  );
  await q(
    `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, last_name)
     VALUES ($1,$2,$3,$4,NULL,$5,NULL)`,
    [matchId, id, label, rows[0].n, `Bot ${n}`]
  );
  return id;
}

async function botCount(matchId) {
  const { rows } = await q(`SELECT COUNT(*)::int AS c FROM match_players WHERE match_id=$1 AND telegram_id <= $2`, [
    matchId,
    BOT_ID_START,
  ]);
  return rows[0].c;
}

const botMatchIds = new Set(); // ids of /vsbotsolo and /botteam matches - normal matches skip every bot check
const botBusy = new Set();
const pickOf = (arr) => arr[Math.floor(Math.random() * arr.length)];

// Called from ensureTurnClock: when the bot is the one on the clock, it plays after a short "thinking" delay
async function botKick(st) {
  if (!st || st.repair || !st.pend) return;
  if (!botMatchIds.has(String(st.m && st.m.id))) return;
  const { inn, pend, kind } = st;
  const tok = `${kind}:${pend.callback_token}`;
  if (botBusy.has(tok)) return;
  let run = null;
  if (kind === 'bowl' && isBotId(pend.bowler_telegram_id)) run = () => botLockNumber(pend.callback_token);
  else if (kind === 'bat') {
    const striker = await getPlayer(inn.striker_player_id);
    if (striker && isBotId(striker.telegram_id)) run = () => botPlayBat(pend.callback_token);
  }
  if (!run) return;
  botBusy.add(tok);
  setTimeout(async () => {
    try {
      await run();
    } catch (e) {
      console.error('bot move failed:', e.message);
    } finally {
      botBusy.delete(tok);
    }
  }, 1800 + Math.random() * 1700);
}

// bot bowler locks a number (1-6)
async function botLockNumber(token) {
  const { rows } = await q(
    `SELECT * FROM pending_balls WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NULL`,
    [token]
  );
  const pend = rows[0];
  if (!pend) return;
  const m = await getMatch(pend.match_id);
  const { rows: ir } = await q(`SELECT * FROM innings WHERE id=$1`, [pend.innings_id]);
  const inn = ir[0];
  if (!m || !inn) return;

  let n = 1 + Math.floor(Math.random() * 6);
  for (let i = 0; i < 12 && (await bowlerSpamBlocked(m, inn, n)); i++) n = 1 + Math.floor(Math.random() * 6);
  const upd = await q(
    `UPDATE pending_balls SET bowl_number=$2 WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NULL RETURNING callback_token`,
    [token, n]
  );
  if (!upd.rowCount) return;

  const groupId = Number(m.group_chat_id);
  const striker = await getPlayer(inn.striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);
  const hat = await isHatTrickBall(inn);
  const html =
    `🔒 <b>${fancy('NUMBER LOCKED')}</b>\n` +
    `<blockquote>${bowler ? `<b>${escapeHtml(name(bowler))}</b>` : 'Bowler'} has locked the number!\n` +
    `🏏 ${striker ? htag(striker) : 'Batsman'} takes the stance — send your number <b>${hat ? '1–6' : '0–6'}</b> in the group (${TURN_SECONDS}s)` +
    (hat ? `\n🎩 <b>HAT-TRICK BALL!</b> 0 is not allowed.` : '') +
    `</blockquote>`;
  const lock = await sendCaptionedGif(bot.telegram, groupId, 'stance', html);
  lockMsgs.set(token, lock.message_id);
  await ensureTurnClock(m.id);
}

// bot batsman plays 0-6
async function botPlayBat(token) {
  const { rows } = await q(
    `SELECT * FROM pending_balls WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NOT NULL`,
    [token]
  );
  const pend = rows[0];
  if (!pend) return;
  const m = await getMatch(pend.match_id);
  const { rows: ir } = await q(`SELECT * FROM innings WHERE id=$1`, [pend.innings_id]);
  const inn = ir[0];
  if (!m || !inn || inn.ball_state !== 'waiting_bowl') return;
  const striker = await getPlayer(inn.striker_player_id);
  if (!striker || !isBotId(striker.telegram_id)) return;

  const hat = await isHatTrickBall(inn);
  let pool = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6, 6];
  if (hat) pool = pool.filter((x) => x !== 0);
  const num = pickOf(pool);

  const claim = await q(
    `UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NOT NULL`,
    [token]
  );
  if (!claim.rowCount) return;
  try {
    await bot.telegram.sendMessage(Number(m.group_chat_id), `🤖 ${mtag(striker)} plays *${num}*`, {
      parse_mode: 'Markdown',
    });
  } catch (_) {}
  try {
    await resolveBall(bot.telegram, m, inn, pend, num, undefined);
  } catch (e) {
    try {
      await q(`UPDATE pending_balls SET is_resolved=FALSE WHERE callback_token=$1 AND bowl_number IS NOT NULL`, [token]);
    } catch (_) {}
    throw e;
  }
}

// Bot captain duties in /botteam matches: openers, next batsman, bowler for every over
async function botTeamAssist(matchId) {
  if (!botMatchIds.has(String(matchId))) return;
  try {
    const m = await getMatch(matchId);
    if (!m || m.mode === 'solo' || !m.vs_bot || !['innings1', 'innings2'].includes(m.status)) return;
    let inn = await getInnings(matchId);
    if (!inn || inn.ball_state !== 'idle') return;
    const tg = bot.telegram;
    const groupId = Number(m.group_chat_id);
    const batTeam = await getTeam(m.id, inn.batting_team);
    const bowlTeam = await getTeam(m.id, inn.bowling_team);

    // batting side: fill the striker / non-striker places
    if (isBotId(batTeam?.captain_id) && (!inn.striker_player_id || !inn.non_striker_player_id)) {
      const pl = await getPlayers(m.id, inn.batting_team);
      const { rows: outs } = await q(`SELECT player_id FROM batting_stats WHERE innings_id=$1 AND is_out`, [inn.id]);
      const outSet = new Set(outs.map((r) => r.player_id));
      for (let guard = 0; guard < 2 && (!inn.striker_player_id || !inn.non_striker_player_id); guard++) {
        const busy = new Set([inn.striker_player_id, inn.non_striker_player_id].filter(Boolean));
        const next = pl.find((p) => !outSet.has(p.id) && !busy.has(p.id));
        if (!next) break;
        await q(
          `INSERT INTO batting_stats (innings_id, player_id) VALUES ($1,$2) ON CONFLICT (innings_id, player_id) DO NOTHING`,
          [inn.id, next.id]
        );
        const col = !inn.striker_player_id ? 'striker_player_id' : 'non_striker_player_id';
        await q(`UPDATE innings SET ${col}=$2 WHERE id=$1`, [inn.id, next.id]);
        await tg.sendMessage(groupId, `🤖 Bot captain → 🏏 ${mn(next)} → *${col === 'striker_player_id' ? 'striker' : 'non-striker'}*`, {
          parse_mode: 'Markdown',
        });
        try {
          await sendResultGif(tg, groupId, 'batentry', undefined, newBatsmanCaption(next));
        } catch (_) {}
        inn = await getInnings(m.id);
      }
    }

    // bowling side: choose the bowler for the next over
    if (isBotId(bowlTeam?.captain_id) && !inn.current_bowler_id && inn.striker_player_id && inn.non_striker_player_id) {
      const pl = await getPlayers(m.id, inn.bowling_team);
      const { rows: st } = await q(`SELECT player_id, balls_bowled FROM bowling_stats WHERE innings_id=$1`, [inn.id]);
      const balls = new Map(st.map((r) => [r.player_id, Number(r.balls_bowled) || 0]));
      const maxO = m.max_overs_per_bowler || MAX_BOWLER_OVERS;
      const notLast = (p) => !(inn.last_bowler_id === p.id && inn.balls_bowled % 6 === 0 && (balls.get(p.id) || 0) > 0);
      let cands = pl.filter((p) => (balls.get(p.id) || 0) / 6 < maxO && notLast(p));
      if (!cands.length) cands = pl.filter(notLast);
      if (!cands.length) cands = pl;
      const least = Math.min(...cands.map((p) => balls.get(p.id) || 0));
      const bw = pickOf(cands.filter((p) => (balls.get(p.id) || 0) === least));
      if (bw) {
        await q(
          `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2) ON CONFLICT (innings_id, player_id) DO NOTHING`,
          [inn.id, bw.id]
        );
        await q(`UPDATE innings SET current_bowler_id=$2 WHERE id=$1`, [inn.id, bw.id]);
        await tg.sendMessage(groupId, `🤖 Bot captain → 🎳 ${mn(bw)} is bowling`, { parse_mode: 'Markdown' });
        try {
          await sendResultGif(tg, groupId, 'bowlentry', undefined, newBowlerCaption(bw));
        } catch (_) {}
      }
    }
  } catch (e) {
    console.error('botTeamAssist failed:', e.message);
  }
}

// Bot team won the toss: it chooses BAT or BALL by itself, then the host picks the overs
async function botTossChoose(telegram, matchId, winner) {
  const m = await getMatch(matchId);
  if (!m) return;
  const choice = Math.random() < 0.5 ? 'bat' : 'bowl';
  const batFirst = choice === 'bat' ? winner : winner === 'A' ? 'B' : 'A';
  const bowlFirst = batFirst === 'A' ? 'B' : 'A';
  const upd = await q(
    `UPDATE matches SET batting_first_team=$2, current_batting_team=$2, current_bowling_team=$3, setup_phase='overs'
      WHERE id=$1 AND status='toss' AND setup_phase='choice' RETURNING id`,
    [m.id, batFirst, bowlFirst]
  );
  if (!upd.rowCount) return;
  const groupId = Number(m.group_chat_id);
  await telegram.sendMessage(
    groupId,
    `🤖 *Team ${winner}* (bot) won the toss and chose to *${choice === 'bat' ? 'BAT' : 'BALL'}* first\n` +
      `> 🏏 Batting first: Team *${batFirst}*\n> 🎳 Bowling first: Team *${bowlFirst}*`,
    { parse_mode: 'Markdown' }
  );
  await telegram.sendMessage(
    groupId,
    `⏱ *HOST — SET OVERS*\n> [Host](tg://user?id=${Number(m.host_telegram_id)}), pick total overs (1–${MAX_OVERS}):`,
    { parse_mode: 'Markdown', ...oversKb(m.id) }
  );
}

// ─── /vsbotsolo [3|6] : 1v1 against the bot ───
async function createVsBotSolo(ctx) {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  try {
    if (await getActiveMatch(ctx.chat.id))
      return ctx.reply(`⚠️ *Only one game per group.*\nA match is already running here.\nHost: /endmatch to cancel it first.`, {
        parse_mode: 'Markdown',
      });
    const balls = parseInt(((ctx.message?.text || '').split(/\s+/)[1] || ''), 10) === 6 ? 6 : 3;
    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'solo',$3,$4,$5,$6,'waiting') RETURNING *`,
      [ctx.chat.id, ctx.chat.title || null, ctx.from.id, 2, DEFAULT_OVERS, MAX_BOWLER_OVERS]
    );
    const m = rows[0];
    await q(`UPDATE matches SET spam_free=FALSE, solo_balls=$2, vs_bot=TRUE WHERE id=$1`, [m.id, balls]);
    botMatchIds.add(String(m.id));
    for (const L of ['A', 'B']) await q(`INSERT INTO match_teams (match_id, team_label) VALUES ($1,$2)`, [m.id, L]);
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, last_name, is_captain)
       VALUES ($1,$2,'A',1,$3,$4,$5,TRUE)`,
      [m.id, ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null]
    );
    await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label='A'`, [m.id, ctx.from.id]);
    await upsertUser(ctx.from);
    await addBotPlayer(m.id, 'A', 1);
    touchMatch(m.id);
    await sendHtmlMessage(
      ctx.telegram,
      ctx.chat.id,
      `🤖 *${fancy('SOLO VS BOT')}*\n` +
        `> ${pe('crown','👑')} You: *${mn(ctx.from)}*  vs  *Bot 1*\n` +
        `> 🎳 Bowler changes every *${balls}* balls\n` +
        `> ♾ Everyone bats until OUT — higher score wins`
    );
    await beginSoloFromLobby(m.id, ctx.chat.id, ctx.telegram);
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command(['vsbotsolo', 'vsbot'], createVsBotSolo);

// ─── /botteam [2-11] : my team vs a bot team (practice) ───
async function createBotTeam(ctx) {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  try {
    if (await getActiveMatch(ctx.chat.id))
      return ctx.reply(`⚠️ *Only one game per group.*\nA match is already running here.\nHost: /endmatch to cancel it first.`, {
        parse_mode: 'Markdown',
      });
    let size = parseInt(((ctx.message?.text || '').split(/\s+/)[1] || ''), 10);
    if (!size) size = 5;
    size = Math.max(2, Math.min(11, size));

    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'team',$3,$4,$5,$6,'waiting') RETURNING *`,
      [ctx.chat.id, ctx.chat.title || null, ctx.from.id, size, DEFAULT_OVERS, MAX_BOWLER_OVERS]
    );
    const m = rows[0];
    await q(`UPDATE matches SET spam_free=TRUE, vs_bot=TRUE WHERE id=$1`, [m.id]);
    botMatchIds.add(String(m.id));
    for (const L of ['A', 'B']) await q(`INSERT INTO match_teams (match_id, team_label) VALUES ($1,$2)`, [m.id, L]);
    await upsertUser(ctx.from);
    // host is player #1 of Team A, Team B is the bot team
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, last_name)
       VALUES ($1,$2,'A',1,$3,$4,$5)`,
      [m.id, ctx.from.id, ctx.from.username || null, ctx.from.first_name || null, ctx.from.last_name || null]
    );
    for (let n = 1; n <= size; n++) await addBotPlayer(m.id, 'B', n);
    await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label='B'`, [m.id, botTgId(1)]);
    await q(`UPDATE match_players SET is_captain=TRUE WHERE match_id=$1 AND telegram_id=$2`, [m.id, botTgId(1)]);
    touchMatch(m.id);

    await sendHtmlMessage(
      ctx.telegram,
      ctx.chat.id,
      `🤖 *${fancy('TEAM VS BOT')}*\n` +
        `> ${pe('crown','👑')} Host: *${mn(ctx.from)}*  (Team A #1)\n` +
        `> 🅱 Team B: *${size} bots* (captain Bot 1)\n` +
        `> 🅰 Team A: up to *${size}* players — missing places are filled with bots\n\n` +
        `${pe('mega','📌')} *Join your team*\n` +
        `> /team\\_a — join Team A\n` +
        `> /add\\_a @user — host adds friends\n\n` +
        `${pe('zap','⚡')} *Host*\n` +
        `> /startgame — captain → toss → overs → play\n` +
        `> /members — see the teams\n` +
        `> /endmatch — cancel`
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command('botteam', createBotTeam);

// ─── /soloball 3|6 : how many balls one bowler bowls in solo before the ball goes to the next player ───
async function setSoloBalls(ctx, n) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo') return ctx.reply('❌ There is no solo match');
    if (Number(m.host_telegram_id) !== ctx.from.id && !isAdmin(ctx.from.id)) return ctx.reply('❌ Only the host can change this');
    if (m.status !== 'waiting') return ctx.reply('⚠️ This can only be changed before the match starts');
    await q(`UPDATE matches SET solo_balls=$2 WHERE id=$1`, [m.id, n]);
    await ctx.reply(`🎳 Solo: the bowler changes every *${n}* balls (next player by number)`, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command('soloball', (ctx) => setSoloBalls(ctx, parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10) === 6 ? 6 : 3));
bot.command('solo3', (ctx) => setSoloBalls(ctx, 3));
bot.command('solo6', (ctx) => setSoloBalls(ctx, 6));
bot.action(/^sb:(.+):(3|6)$/, async (ctx) => {
  try {
    const m = await getMatch(ctx.match[1]);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting') return ctx.answerCbQuery('The lobby is closed', { show_alert: true });
    if (Number(m.host_telegram_id) !== ctx.from.id && !isAdmin(ctx.from.id))
      return ctx.answerCbQuery('Only the host can choose', { show_alert: true });
    await q(`UPDATE matches SET solo_balls=$2 WHERE id=$1`, [m.id, Number(ctx.match[2])]);
    await ctx.answerCbQuery(`Bowler changes every ${ctx.match[2]} balls`);
  } catch (e) {
    await ctx.answerCbQuery('Error', { show_alert: true }).catch(() => {});
  }
});

// ─── Wrong input: tell bowler (DM) and batsman (group) to type just the number ───
bot.on('text', async (ctx, next) => {
  try {
    const txt = String(ctx.message?.text || '').trim();
    if (!txt || txt.startsWith('/')) return next && next();
    if (/^[0-6]$/.test(txt)) return next && next();

    if (ctx.chat && ctx.chat.type === 'private') {
      const { rows } = await q(
        `SELECT 1 FROM pending_balls WHERE bowler_telegram_id=$1 AND is_resolved=FALSE AND bowl_number IS NULL LIMIT 1`,
        [ctx.from.id]
      );
      if (rows.length)
        await ctx.reply('⚠️ Please type only the number *1–6* (0 is not allowed for bowlers).', {
          parse_mode: 'Markdown',
          reply_to_message_id: ctx.message.message_id,
        });
      return;
    }
    if (!isGroup(ctx)) return;
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status)) return;
    const inn = await getInnings(m.id);
    if (!inn || inn.ball_state !== 'waiting_bowl') return;
    const { rows } = await q(`SELECT * FROM pending_balls WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
    const pend = rows[rows.length - 1];
    if (!pend || pend.bowl_number == null) return;
    const striker = await getPlayer(inn.striker_player_id);
    if (!striker || Number(striker.telegram_id) !== ctx.from.id) return;
    await ctx.reply('⚠️ Please type only the number *0–6*.', {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id,
      allow_sending_without_reply: true,
    });
  } catch (e) {
    console.error('wrong-input handler:', e.message);
  }
});

// ─── /userinfo : career stats card (yours, or of the replied / tagged / id given player) ───
async function userCareer(tgId) {
  const id = Number(tgId);
  const { rows: bt } = await q(
    `SELECT COALESCE(SUM(bs.runs),0)::int AS runs, COALESCE(SUM(bs.balls_faced),0)::int AS balls,
            COALESCE(SUM(bs.fours),0)::int AS fours, COALESCE(SUM(bs.sixes),0)::int AS sixes,
            COUNT(*) FILTER (WHERE bs.is_out)::int AS outs,
            COUNT(*) FILTER (WHERE bs.is_out AND COALESCE(bs.runs,0)=0)::int AS ducks,
            COUNT(*) FILTER (WHERE bs.runs>=50 AND bs.runs<100)::int AS fifties,
            COUNT(*) FILTER (WHERE bs.runs>=100)::int AS hundreds
       FROM batting_stats bs
       JOIN match_players mp ON mp.id = bs.player_id
       JOIN innings i ON i.id = bs.innings_id
       JOIN matches m ON m.id = i.match_id
      WHERE mp.telegram_id=$1 AND m.status='completed'`,
    [id]
  );
  const { rows: bw } = await q(
    `SELECT COALESCE(SUM(w.wickets),0)::int AS wkts, COALESCE(SUM(w.balls_bowled),0)::int AS balls,
            COALESCE(SUM(w.runs_conceded),0)::int AS conceded,
            COUNT(*) FILTER (WHERE w.wickets>=3 AND w.wickets<5)::int AS w3,
            COUNT(*) FILTER (WHERE w.wickets>=5)::int AS w5
       FROM bowling_stats w
       JOIN match_players mp ON mp.id = w.player_id
       JOIN innings i ON i.id = w.innings_id
       JOIN matches m ON m.id = i.match_id
      WHERE mp.telegram_id=$1 AND m.status='completed'`,
    [id]
  );
  const { rows: mc } = await q(
    `SELECT COUNT(DISTINCT m.id)::int AS c FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.telegram_id=$1 AND m.status='completed'`,
    [id]
  );
  // hat-tricks: 3 wickets in 3 consecutive balls by the same bowler
  const { rows: dl } = await q(
    `SELECT d.innings_id, d.bowler_id, d.is_wicket FROM deliveries d
       JOIN innings i ON i.id = d.innings_id JOIN matches m ON m.id = i.match_id
      WHERE m.status='completed'
        AND d.innings_id IN (SELECT d2.innings_id FROM deliveries d2 JOIN match_players mp ON mp.id = d2.bowler_id WHERE mp.telegram_id=$1)
      ORDER BY d.innings_id, d.over_number, d.ball_number`,
    [id]
  );
  const { rows: mine } = await q(`SELECT id FROM match_players WHERE telegram_id=$1`, [id]);
  const myIds = new Set(mine.map((r) => r.id));
  let hat = 0;
  let streak = 0;
  let curInn = null;
  for (const r of dl) {
    if (r.innings_id !== curInn) {
      curInn = r.innings_id;
      streak = 0;
    }
    const wk = r.is_wicket === true || r.is_wicket === 1 || r.is_wicket === 't';
    if (myIds.has(r.bowler_id) && wk) {
      streak++;
      if (streak === 3) {
        hat++;
        streak = 0;
      }
    } else streak = 0;
  }
  const { rows: hsr } = await q(
    `SELECT bs.runs, bs.balls_faced FROM batting_stats bs
       JOIN match_players mp ON mp.id = bs.player_id JOIN innings i ON i.id = bs.innings_id JOIN matches m ON m.id = i.match_id
      WHERE mp.telegram_id=$1 AND m.status='completed' ORDER BY bs.runs DESC, bs.balls_faced ASC LIMIT 1`,
    [id]
  );
  const { rows: bbr } = await q(
    `SELECT w.wickets, w.runs_conceded FROM bowling_stats w
       JOIN match_players mp ON mp.id = w.player_id JOIN innings i ON i.id = w.innings_id JOIN matches m ON m.id = i.match_id
      WHERE mp.telegram_id=$1 AND m.status='completed' AND w.balls_bowled>0 ORDER BY w.wickets DESC, w.runs_conceded ASC LIMIT 1`,
    [id]
  );
  const { rows: hostR } = await q(`SELECT COUNT(*)::int AS c FROM matches WHERE host_telegram_id=$1 AND status='completed'`, [id]);
  const b = bt[0] || {};
  const w = bw[0] || {};
  const matches = mc[0]?.c || 0;
  const runs = Number(b.runs || 0);
  const wkts = Number(w.wkts || 0);
  const level = Math.min(99, 1 + Math.floor((runs + wkts * 25 + matches * 10) / 100));
  const [res, part, awards] = await Promise.all([
    userResults(id).catch(() => ({ w: 0, l: 0, d: 0, total: 0, streakType: '', streak: 0, bestStreak: 0, cap: { matches: 0, w: 0, l: 0 } })),
    userPartnership(id).catch(() => ({ runs: 0, partner: null })),
    userAwardCounts(id).catch(() => ({ orange: 0, purple: 0, motm: 0 })),
  ]);
  return {
    level,
    res,
    part,
    awards,
    hs: hsr[0] ? { runs: Number(hsr[0].runs || 0), balls: Number(hsr[0].balls_faced || 0) } : { runs: 0, balls: 0 },
    bestBowl: bbr[0] ? { wkts: Number(bbr[0].wickets || 0), runs: Number(bbr[0].runs_conceded || 0) } : { wkts: 0, runs: 0 },
    hosted: hostR[0]?.c || 0,
    bat: {
      runs,
      balls: Number(b.balls || 0),
      matches,
      outs: Number(b.outs || 0),
      ducks: Number(b.ducks || 0),
      fours: Number(b.fours || 0),
      sixes: Number(b.sixes || 0),
      sr: b.balls > 0 ? (runs * 100) / b.balls : 0,
      fifties: Number(b.fifties || 0),
      hundreds: Number(b.hundreds || 0),
    },
    bowl: {
      wkts,
      hattricks: hat,
      matches,
      balls: Number(w.balls || 0),
      w3: Number(w.w3 || 0),
      w5: Number(w.w5 || 0),
      eco: w.balls > 0 ? (Number(w.conceded || 0) * 6) / w.balls : 0,
    },
  };
}

// who is the card for? replied user > tagged user (@username / text mention) > numeric id > the sender
async function resolveInfoTarget(ctx) {
  const msg = ctx.message;
  const fromRow = (u) => ({ id: Number(u.id ?? u.telegram_id), username: u.username || null, first_name: u.first_name || null, last_name: u.last_name || null });
  const byUsername = async (uname) => {
    const { rows } = await q(`SELECT telegram_id, username, first_name, last_name FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1`, [uname]);
    if (rows[0]) return fromRow(rows[0]);
    const { rows: r2 } = await q(
      `SELECT telegram_id, username, first_name, last_name FROM match_players WHERE LOWER(username)=LOWER($1) ORDER BY id DESC LIMIT 1`,
      [uname]
    );
    return r2[0] ? fromRow(r2[0]) : null;
  };
  const byId = async (id) => {
    const { rows } = await q(`SELECT telegram_id, username, first_name, last_name FROM users WHERE telegram_id=$1`, [id]);
    return rows[0] ? fromRow(rows[0]) : { id, username: null, first_name: null, last_name: null };
  };
  const rep = msg.reply_to_message?.from;
  if (rep && !rep.is_bot) return fromRow(rep);
  const text = msg.text || '';
  for (const e of msg.entities || []) {
    if (e.type === 'text_mention' && e.user && !e.user.is_bot) return fromRow(e.user);
    if (e.type === 'mention') {
      const found = await byUsername(text.substr(e.offset + 1, e.length - 1));
      return found || { notFound: text.substr(e.offset, e.length) };
    }
  }
  const arg = text.split(/\s+/)[1] || '';
  if (/^\d{5,}$/.test(arg)) return byId(Number(arg));
  if (/^[A-Za-z0-9_]{4,}$/.test(arg)) {
    const found = await byUsername(arg);
    return found || { notFound: arg };
  }
  return fromRow(ctx.from);
}

// ─── win / lose / streak / captaincy / best partnership / award counts ───
async function userResults(id) {
  const { rows: tm } = await q(
    `SELECT m.id, mp.team_label,
            (SELECT COALESCE(SUM(i.total_runs),0) FROM innings i WHERE i.match_id=m.id AND i.batting_team=mp.team_label)::int AS my_runs,
            (SELECT COALESCE(SUM(i.total_runs),0) FROM innings i WHERE i.match_id=m.id AND i.batting_team<>mp.team_label)::int AS opp_runs,
            EXISTS (SELECT 1 FROM match_teams t WHERE t.match_id=m.id AND t.team_label=mp.team_label AND t.captain_id=$1) AS cap
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.telegram_id=$1 AND m.status='completed' AND m.mode<>'solo'`,
    [id]
  );
  const { rows: so } = await q(
    `SELECT m.id,
            COALESCE((SELECT SUM(bs.runs) FROM batting_stats bs WHERE bs.player_id=mp.id),0)::int AS my_runs,
            COALESCE((SELECT MAX(x.r) FROM (SELECT SUM(bs2.runs) AS r FROM batting_stats bs2
                        JOIN match_players mp2 ON mp2.id = bs2.player_id
                       WHERE mp2.match_id=m.id AND mp2.id<>mp.id GROUP BY mp2.id) x),0)::int AS best_other
       FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.telegram_id=$1 AND m.status='completed' AND m.mode='solo'`,
    [id]
  );
  const all = [];
  for (const r of tm) all.push({ id: r.id, res: r.my_runs > r.opp_runs ? 'W' : r.my_runs < r.opp_runs ? 'L' : 'D', cap: !!r.cap });
  for (const r of so) all.push({ id: r.id, res: r.my_runs > r.best_other ? 'W' : r.my_runs < r.best_other ? 'L' : 'D', cap: false });
  all.sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0)); // newest first
  const cnt = { W: 0, L: 0, D: 0 };
  all.forEach((x) => cnt[x.res]++);
  // current streak (from the newest match) and best win streak
  let cur = 0;
  let curType = '';
  for (const x of all) {
    if (!curType) {
      if (x.res === 'D') break;
      curType = x.res;
    }
    if (x.res === curType) cur++;
    else break;
  }
  let best = 0;
  let run = 0;
  for (const x of [...all].reverse()) {
    if (x.res === 'W') best = Math.max(best, ++run);
    else run = 0;
  }
  const caps = all.filter((x) => x.cap);
  return {
    w: cnt.W, l: cnt.L, d: cnt.D, total: all.length,
    streakType: curType, streak: cur, bestStreak: best,
    cap: { matches: caps.length, w: caps.filter((x) => x.res === 'W').length, l: caps.filter((x) => x.res === 'L').length },
  };
}

// best batting partnership: runs added between two wickets while the player was batting (team matches)
async function userPartnership(id) {
  const { rows: mine } = await q(`SELECT id FROM match_players WHERE telegram_id=$1`, [id]);
  const myIds = new Set(mine.map((r) => r.id));
  const { rows } = await q(
    `SELECT d.innings_id, d.batsman_id, d.runs_scored, d.is_wicket
       FROM deliveries d
      WHERE d.innings_id IN (SELECT DISTINCT d2.innings_id FROM deliveries d2
                               JOIN match_players mp ON mp.id = d2.batsman_id
                               JOIN innings i ON i.id = d2.innings_id JOIN matches m ON m.id = i.match_id
                              WHERE mp.telegram_id=$1 AND m.mode<>'solo' AND m.status='completed')
      ORDER BY d.innings_id, d.over_number, d.ball_number`,
    [id]
  );
  let best = { runs: 0, partner: null };
  let cur = null;
  let innId = null;
  const close = () => {
    if (cur && [...cur.set].some((x) => myIds.has(x)) && cur.runs > best.runs) {
      const other = [...cur.set].filter((x) => !myIds.has(x));
      best = { runs: cur.runs, partner: other.length === 1 ? other[0] : null };
    }
    cur = null;
  };
  for (const r of rows) {
    if (r.innings_id !== innId) {
      close();
      innId = r.innings_id;
    }
    if (!cur) cur = { runs: 0, set: new Set() };
    cur.runs += Number(r.runs_scored || 0);
    cur.set.add(r.batsman_id);
    const wk = r.is_wicket === true || r.is_wicket === 1 || r.is_wicket === 't';
    if (wk) close();
  }
  close();
  let partnerName = null;
  if (best.partner) {
    const { rows: pr } = await q(`SELECT first_name, last_name, username FROM match_players WHERE id=$1`, [best.partner]);
    if (pr[0]) partnerName = [pr[0].first_name, pr[0].last_name].filter(Boolean).join(' ').trim() || pr[0].username || null;
  }
  return { runs: best.runs, partner: partnerName };
}

async function userAwardCounts(id) {
  const { rows } = await q(`SELECT kind, COUNT(*)::int AS c FROM match_awards WHERE telegram_id=$1 AND kind<>'done' GROUP BY kind`, [id]);
  const m = { orange: 0, purple: 0, motm: 0 };
  rows.forEach((r) => (m[r.kind] = r.c));
  return m;
}

// ─── Orange cap / Purple cap / MOTM are remembered per match (and filled in for old matches in the background) ───
async function saveAwards(matchId, aw) {
  const mid = String(matchId);
  for (const [kind, p] of [['orange', aw.orange], ['purple', aw.purple], ['motm', aw.motm]]) {
    if (!p || isBotId(p.telegram_id)) continue;
    await q(`INSERT INTO match_awards (match_id, telegram_id, kind) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [mid, Number(p.telegram_id), kind]);
  }
  await q(`INSERT INTO match_awards (match_id, telegram_id, kind) VALUES ($1,0,'done') ON CONFLICT DO NOTHING`, [mid]);
}
async function backfillAwards() {
  const { rows } = await q(
    `SELECT m.id, m.mode FROM matches m
      WHERE m.status='completed' AND m.id::text NOT IN (SELECT match_id FROM match_awards WHERE kind='done')
      ORDER BY m.id DESC LIMIT 300`
  );
  if (rows.length) console.log(`awards backfill: ${rows.length} old matches`);
  for (const m of rows) {
    try {
      let winner = null;
      if (m.mode !== 'solo') {
        const { rows: t } = await q(`SELECT batting_team, SUM(total_runs)::int AS r FROM innings WHERE match_id=$1 GROUP BY batting_team`, [m.id]);
        const a = t.find((x) => x.batting_team === 'A')?.r || 0;
        const b = t.find((x) => x.batting_team === 'B')?.r || 0;
        winner = a === b ? 'tie' : a > b ? 'A' : 'B';
      }
      await saveAwards(m.id, await matchAwards(m.id, winner));
    } catch (e) {
      console.error('awards backfill failed for', m.id, e.message);
    }
    await sleep(600); // gentle: never compete with a running game
  }
}

// ─── native table (Rich Message) for /userinfo ───
function userRichHtml(t, shownName, c) {
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const b = c.bat;
  const w = c.bowl;
  const r = c.res;
  const a = c.awards;
  const played = r.w + r.l + r.d;
  const rate = played > 0 ? ((r.w * 100) / played).toFixed(1) + '%' : '—';
  const streak = r.streakType ? `${r.streakType}${r.streak}` : '—';
  const capPlayed = r.cap.matches;
  const capRate = capPlayed > 0 ? ((r.cap.w * 100) / capPlayed).toFixed(1) + '%' : '—';
  const avg = b.outs > 0 ? (b.runs / b.outs).toFixed(2) : b.runs > 0 ? `${b.runs} (not out)` : '—';
  const tbl = (rows) => richTable(['Stat', 'Value'], rows);
  const who = isBotId(t.id) ? `<b>${hEsc(shownName)}</b>` : `<a href="tg://user?id=${t.id}">${hEsc(shownName)}</a>`;
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.CARD_TZ || 'Asia/Kolkata' }).format(new Date());

  let h = `<p><b>🏏 STATS SUMMARY</b></p>`;
  h += `<p>👤 ${who}  ·  🆔 <code>${t.id}</code>  ·  📅 ${date}</p>`;
  h += tbl([
    ['⭐ Level', c.level],
    ['🏅 Matches Played', n(b.matches)],
    ['🎮 Matches Hosted', n(c.hosted)],
    ['✅ Win / Lose', `${r.w} W · ${r.l} L` + (r.d ? ` · ${r.d} D` : '')],
    ['📊 Win Rate', rate],
    ['🔥 Streak', `${streak}  (best win streak ${r.bestStreak})`],
  ]);
  h += `<details><summary>🏏 Batting</summary>` + tbl([
    ['Runs (Balls)', `${n(b.runs)} (${n(b.balls)})`],
    ['Highest Score', `${c.hs.runs} (${c.hs.balls} balls)`],
    ['Average', avg],
    ['Strike Rate', b.sr.toFixed(2)],
    ['Fours / Sixes', `${n(b.fours)} / ${n(b.sixes)}`],
    ['50s / 100s', `${b.fifties} / ${b.hundreds}`],
    ['Ducks', b.ducks],
    ['Best Partnership', c.part.runs > 0 ? `${c.part.runs} runs` + (c.part.partner ? ` with ${hEsc(c.part.partner)}` : '') : '—'],
  ]) + `</details>`;
  h += `<details><summary>🎳 Bowling</summary>` + tbl([
    ['Wickets', n(w.wkts)],
    ['Balls Bowled', n(w.balls)],
    ['Economy', w.eco.toFixed(2)],
    ['Best Bowling', `${c.bestBowl.wkts}/${c.bestBowl.runs}`],
    ['3W / 5W', `${w.w3} / ${w.w5}`],
    ['Hat-tricks', w.hattricks],
  ]) + `</details>`;
  h += `<details><summary>🏆 Awards & Captaincy</summary>` + tbl([
    ['🟠 Orange Cap', a.orange],
    ['🟣 Purple Cap', a.purple],
    ['🏅 Man of the Match', a.motm],
    ['👑 Captain (matches)', capPlayed],
    ['👑 Captain Win / Lose', `${r.cap.w} W · ${r.cap.l} L`],
    ['👑 Captain Win Rate', capRate],
  ]) + `</details>`;
  return h;
}

// caption under the profile card: "Stats Summary" design (text fallback)
function userCaption(t, name, career) {
  const line = '─────⊱◈◈◈⊰─────';
  const b = career.bat;
  const w = career.bowl;
  const n = (v) => Number(v || 0).toLocaleString('en-US');
  const shown = mdEsc([t.first_name, t.last_name].filter(Boolean).join(' ').trim() || t.username || name);
  const who = isBotId(t.id) ? `*${shown}*` : `[${shown}](tg://user?id=${t.id})`;
  const tz = process.env.CARD_TZ || 'Asia/Kolkata';
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date()); // 2026-10-27
  return (
    `🏏 *Stats Summary*\n` +
    `👤 *User:* ${who}\n` +
    `🆔 *User ID:* \`${t.id}\`\n` +
    `📅 *Date:* ${date}\n` +
    `${line}\n` +
    `🏆 *Highest Score:* ${career.hs.runs}(${career.hs.balls} Balls)\n` +
    `🎮 *Matches Hosted:* ${n(career.hosted)}\n` +
    `📊 *Runs:* ${n(b.runs)} (${n(b.balls)})\n` +
    `🎳 *Wickets:* ${n(w.wkts)}\n` +
    `💥 *Sixes:* ${n(b.sixes)}\n` +
    `✨ *Fours:* ${n(b.fours)}\n` +
    `🔥 *Centuries:* ${n(b.hundreds)}\n` +
    `⭐ *Fifties:* ${n(b.fifties)}\n` +
    `🦆 *Ducks:* ${n(b.ducks)}\n` +
    `🎩 *Hat-Tricks:* ${n(w.hattricks)}\n` +
    `⚡ *Strike Rate:* ${b.sr.toFixed(2)}\n` +
    `🎳 *Economy Rate:* ${w.eco.toFixed(2)}\n` +
    `${line}\n` +
    `🎯 *Best Bowling:* ${career.bestBowl.wkts}/${career.bestBowl.runs}\n` +
    `🏅 *Matches Played:* ${n(b.matches)}\n` +
    `⭐ *Level:* ${career.level}`
  );
}

bot.command(['userinfo', 'myinfo'], async (ctx) => {
  try {
    const t = await resolveInfoTarget(ctx);
    if (t.notFound) return ctx.reply(`❌ I don't know ${t.notFound} yet — they need to play or use the bot once.`);
    const [career, dp] = await Promise.all([userCareer(t.id), getUserDp(ctx.telegram, t.id)]);
    const full = [t.first_name, t.last_name].filter(Boolean).join(' ').trim();
    const name = cleanName(full || t.username || '', '').trim() || cleanName(t.username || '', '').trim() || 'PLAYER';
    // no username -> the name is used as the username
    const handle = '@' + (t.username ? cleanName(t.username, '') : name.replace(/\s+/g, '')) ;
    const img = await renderUserCard({ dp, name, handle, level: career.level, bat: career.bat, bowl: career.bowl });
    const shown = [t.first_name, t.last_name].filter(Boolean).join(' ').trim() || t.username || name;
    let photoSent = false;
    let tableOk = false;
    if (RICH_TABLES) {
      try {
        await ctx.telegram.sendPhoto(ctx.chat.id, { source: img }, {
          caption: `📊 *${mdEsc(shown)}*  ·  Level ${career.level}`,
          parse_mode: 'Markdown',
          reply_to_message_id: ctx.message.message_id,
          allow_sending_without_reply: true,
        });
        photoSent = true;
        await sendRich(ctx.telegram, ctx.chat.id, userRichHtml(t, shown, career));
        tableOk = true;
      } catch (e) {
        if (!richWarned) {
          richWarned = true;
          console.error('rich userinfo failed, using the text version:', e.message);
        }
        if (photoSent) {
          // the photo is already out - only the native table failed: send the text version under it
          await ctx.telegram.sendMessage(ctx.chat.id, userCaption(t, name, career), { parse_mode: 'Markdown' }).catch(() => {});
          tableOk = true;
        }
      }
    }
    if (!tableOk) {
      await ctx.telegram.sendPhoto(ctx.chat.id, { source: img }, {
        caption: userCaption(t, name, career),
        parse_mode: 'Markdown',
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
      });
    }
  } catch (e) {
    await reportCardError('Userinfo card', e);
    await ctx.reply('❌ Could not build the profile card right now.');
  }
});

// ─── /setmedia <key> : reply to ANY media (photo, video, GIF, sticker, voice, file...) to save it under a key ───
// /setmedia 1 run  ->  key "1": if it is a game key (0-6, out, 50 ...) the saved media is also used by the game
const MEDIA_CAPTION_TYPES = ['animation', 'video', 'document', 'photo', 'audio', 'voice'];
function pickMedia(msg) {
  if (!msg) return null;
  if (msg.animation) return { type: 'animation', id: msg.animation.file_id, uid: msg.animation.file_unique_id };
  if (msg.video) return { type: 'video', id: msg.video.file_id, uid: msg.video.file_unique_id };
  if (msg.photo && msg.photo.length) {
    const ph = msg.photo[msg.photo.length - 1];
    return { type: 'photo', id: ph.file_id, uid: ph.file_unique_id };
  }
  if (msg.sticker) return { type: 'sticker', id: msg.sticker.file_id, uid: msg.sticker.file_unique_id };
  if (msg.video_note) return { type: 'video_note', id: msg.video_note.file_id, uid: msg.video_note.file_unique_id };
  if (msg.voice) return { type: 'voice', id: msg.voice.file_id, uid: msg.voice.file_unique_id };
  if (msg.audio) return { type: 'audio', id: msg.audio.file_id, uid: msg.audio.file_unique_id };
  if (msg.document) return { type: 'document', id: msg.document.file_id, uid: msg.document.file_unique_id };
  return null;
}
function mediaKeyFrom(ctx) {
  let k = String(ctx.message?.text || '').replace(/^\/\w+(@\w+)?\s*/, '').trim().toLowerCase().replace(/\s+/g, ' ');
  k = k.replace(/\s+runs?$/, ''); // "1 run" -> "1"
  return PGIF_ALIASES[k] || k;
}
async function sendAnyMedia(telegram, chatId, m, opts = {}) {
  const t = m.media_type;
  if (t === 'photo') return telegram.sendPhoto(chatId, m.file_id, opts);
  if (t === 'video') return telegram.sendVideo(chatId, m.file_id, opts);
  if (t === 'sticker') return telegram.sendSticker(chatId, m.file_id, opts);
  if (t === 'video_note') return telegram.sendVideoNote(chatId, m.file_id, opts);
  if (t === 'voice') return telegram.sendVoice(chatId, m.file_id, opts);
  if (t === 'audio') return telegram.sendAudio(chatId, m.file_id, opts);
  if (t === 'document') return telegram.sendDocument(chatId, m.file_id, opts);
  return telegram.sendAnimation(chatId, m.file_id, opts);
}

bot.command('setmedia', async (ctx) => {
  try {
    if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Only a group admin or the bot owner can save media.');
    const key = mediaKeyFrom(ctx);
    if (!key)
      return ctx.reply('Reply to any media (photo, video, GIF, sticker, voice, file) with:\n/setmedia <key>\nExample: /setmedia 1 run  ·  /setmedia welcome\n\nOther: /getmedia <key> · /medialist · /delmedia <key>');
    if (key.length > 60) return ctx.reply('❌ The key is too long (max 60 characters).');
    const media = pickMedia(ctx.message?.reply_to_message);
    if (!media) return ctx.reply('❌ Reply to a message that has media, then send /setmedia ' + key);
    await q(
      `INSERT INTO bot_media (media_key, file_id, file_unique_id, media_type, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (media_key) DO UPDATE SET file_id=EXCLUDED.file_id, file_unique_id=EXCLUDED.file_unique_id,
         media_type=EXCLUDED.media_type, updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
      [key, media.id, media.uid || null, media.type, String(ctx.from.id)]
    );
    const forGame = PGIF_KEYS.has(key) && MEDIA_CAPTION_TYPES.includes(media.type);
    await ctx.reply(
      `✅ *Media saved*\n> 🔑 Key: \`${key}\`\n> 📎 Type: *${media.type}*\n> 🆔 File ID: \`${media.id}\`` +
        (forGame ? `\n> 🎮 The game uses it for *${key}*` : ''),
      { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id }
    );
  } catch (e) {
    console.error('setmedia:', e);
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('getmedia', async (ctx) => {
  try {
    if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Only a group admin or the bot owner can use this.');
    const key = mediaKeyFrom(ctx);
    if (!key) return ctx.reply('Usage: /getmedia <key>');
    const { rows } = await q(`SELECT file_id, media_type FROM bot_media WHERE media_key=$1`, [key]);
    if (!rows[0]) return ctx.reply(`❌ No media saved for key "${key}". See /medialist`);
    await sendAnyMedia(ctx.telegram, ctx.chat.id, rows[0], { reply_to_message_id: ctx.message.message_id });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('medialist', async (ctx) => {
  try {
    if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Only a group admin or the bot owner can use this.');
    const { rows } = await q(`SELECT media_key, media_type FROM bot_media ORDER BY media_key`);
    if (!rows.length) return ctx.reply('No media saved yet. Reply to a media with /setmedia <key>');
    await ctx.reply('🗂 *Saved media*\n' + rows.map((r) => `> \`${r.media_key}\` — ${r.media_type}`).join('\n'), { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('delmedia', async (ctx) => {
  try {
    if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Only a group admin or the bot owner can use this.');
    const key = mediaKeyFrom(ctx);
    if (!key) return ctx.reply('Usage: /delmedia <key>');
    const { rowCount } = await q(`DELETE FROM bot_media WHERE media_key=$1`, [key]);
    await ctx.reply(rowCount ? `🗑 Removed media for key \`${key}\`` : `❌ No media saved for key "${key}"`, { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

// /ping : how fast are the database and Telegram right now?
bot.command('ping', async (ctx) => {
  try {
    const t0 = Date.now();
    const sent = await ctx.reply('🏓 …');
    const tg = Date.now() - t0;
    const db = await dbLatency(5);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      sent.message_id,
      undefined,
      `🏓 Pong\n🗄 Database: ${db} ms per query` + (db > 80 ? ' (slow)' : ' (good)') + `\n✈️ Telegram: ${tg} ms\n🏷 ${BOT_VERSION}`
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

// ─── Launch ──────────────────────────────────────────────
async function main() {
  await q('SELECT 1');
  await q('ALTER TABLE pending_balls ADD COLUMN IF NOT EXISTS batting_message_id BIGINT');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS setup_phase TEXT');
  await q('ALTER TABLE match_teams ADD COLUMN IF NOT EXISTS penalty_runs INTEGER NOT NULL DEFAULT 0');
  await q('ALTER TABLE pending_balls ADD COLUMN IF NOT EXISTS bowl_number INTEGER');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS spam_free BOOLEAN');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS penalty_log TEXT');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS toss_caller TEXT');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS solo_balls INTEGER');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS vs_bot BOOLEAN');
  await q('ALTER TABLE match_players ADD COLUMN IF NOT EXISTS last_name TEXT');
  await q(`CREATE TABLE IF NOT EXISTS pgif_settings (
    result_key TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'animation',
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS bot_media (
    media_key TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    file_unique_id TEXT,
    media_type TEXT NOT NULL,
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS match_awards (
    match_id TEXT NOT NULL,
    telegram_id BIGINT NOT NULL,
    kind TEXT NOT NULL,
    PRIMARY KEY (match_id, telegram_id, kind)
  )`);
  await relaxNegativeRunConstraints();
  try {
    const { rows } = await q(`SELECT id FROM matches WHERE vs_bot=TRUE AND status NOT IN ('completed','cancelled')`);
    rows.forEach((r) => botMatchIds.add(String(r.id)));
  } catch (_) {}
  console.log('DB OK');
  setTimeout(() => backfillAwards().catch((e) => console.error('awards backfill:', e.message)), 30000);
  try {
    const ms = await dbLatency(5);
    console.log(`DB latency: ${ms} ms per query` + (ms > 80 ? '  <-- SLOW: put the database in the same region as the bot host' : ''));
  } catch (_) {}
  await rearmAfterRestart();
  const me = await bot.telegram.getMe();
  BOT_USERNAME = me.username;
  console.log(`Bot @${me.username}`);
  await bot.launch();
  
console.log(`Running… (version ${BOT_VERSION})`);
  try {
    const rep = await assetReport();
    console.log('Assets:\n' + rep.join('\n'));
    if (rep.some((r) => /INVALID|PROBLEM/.test(r))) {
      const owner = Number(String(process.env.BOT_OWNER_ID || (process.env.ADMIN_IDS || '').split(',')[0] || '').trim());
      if (owner) await bot.telegram.sendMessage(owner, `⚠️ Asset problem (version ${BOT_VERSION}):\n` + rep.join('\n'));
    }
  } catch (e) {
    console.error('asset check failed:', e.message);
  }
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
