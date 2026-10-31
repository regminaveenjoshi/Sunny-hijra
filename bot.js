/**
 * Hand Cricket Telegram Bot — single file
 *
 * SOLO : /startsolo (or /solo) -> /joinsolo -> /forcestart (or /startgame)
 *        unlimited overs, one innings, everyone bats until out, just type 0-6
 * TEAM : /team (or /startteam) -> /join_a /join_b -> /startgame
 *        -> captain buttons -> toss -> bat/bowl choice -> host /setovers (1-20)
 *        -> /bat /bowl (captains) -> type 0-6
 * TEST : /test (or /starttest) -> /team_a /team_b -> /startgame
 *        -> captains -> toss -> host picks 3-day or 6-day Test
 *        -> each day = 20 overs each side (2 innings), powerplay rules
 *        -> series winner = more day wins · pause/resume with votes
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

const BOT_VERSION = 'r49-2026-10-31-gender-bet-graph'; // shown by /testcard and in the logs so you can see which file is deployed
const bot = new Telegraf(BOT_TOKEN);

// captain pressed "Set team name": the next plain message from him in the group becomes the name
const pendingTeamName = new Map(); // `${chatId}:${userId}` -> { matchId, label, at }
bot.use(async (ctx, next) => {
  try {
    const t = ctx.message && ctx.message.text;
    if (t && !t.startsWith('/') && !/^[0-6]$/.test(t.trim()) && ctx.chat && ctx.from && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup')) {
      const key = `${ctx.chat.id}:${ctx.from.id}`;
      const pend = pendingTeamName.get(key);
      if (pend) {
        pendingTeamName.delete(key);
        if (Date.now() - pend.at < 120000) {
          const nm = cleanTeamName(t);
          if (nm) {
            await q(`UPDATE match_teams SET team_name=$3 WHERE match_id=$1 AND team_label=$2`, [pend.matchId, pend.label, nm]);
            await ctx.reply(`✅ Team ${pend.label} is now *${mdEsc(nm)}*`, { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });
            return;
          }
        }
      }
    }
  } catch (e) {
    console.error('teamname middleware:', e.message);
  }
  return next();
});

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
  female:   { id: '5877555731170856986', fb: '♀️' }, // female badge
  male:     { id: '6095758825929840339', fb: '♂️' }, // male badge
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
  '♀': '5877555731170856986', // female badge (after player names)
  '♂': '6095758825929840339', // male badge (after player names)
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

// ── Test mode ──
const TEST_OVERS = 20; // each innings = 20 overs
const TEST_MIN_PLAYERS = 8; // minimum players PER TEAM to start a Test
const TEST_MAX_PER_TEAM = 11; // max players per team
const TEST_POWERPLAY_OVERS = 5; // first 5 overs: only 0-1-2-3 allowed
const TEST_BOUNDARY_LIMIT = 2; // after powerplay: max 4/6 per over; 3rd = catch out
const TEST_PAUSE_MAX_MS = 48 * 60 * 60 * 1000; // pause can last up to 48 hours
const TEST_PAUSE_VOTES = 2; // 2 votes from each team to pause / resume

// ── Discipline rules ──
const TURN_SECONDS = 60; // batsman / bowler must respond within this time
const TURN_WARN_SECONDS = 10; // English warning this many seconds before timeout
const TURN_PENALTY = 6; // runs lost for every missed turn
const SOLO_BOWLER_WARN_LIMIT = 2; // solo: the bowler is thrown out of the game after this many missed turns
const TEAM_BOWLER_WARN_LIMIT = 2; // team: captain is tagged to choose the next bowler after this many
const BAT_RETIRE_LIMIT = 2; // batsman is retired OUT after this many missed turns
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
  const gm = p.telegram_id != null ? genderMark(p.telegram_id) : '';
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  if (full) return full + gm;
  if (p.username) return `@${p.username}` + gm;
  const id = p.telegram_id ?? p.id;
  return id != null ? String(id) + gm : '—';
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
    [btn('𝗧𝗘𝗦𝗧', 'm:test', 'trophy', 'danger'), btn('𝗣𝗥𝗢𝗙𝗜𝗟𝗘', 'm:profile', 'star', 'primary')],
    [btn('𝗕𝗢𝗔𝗥𝗗', 'm:lb', 'trophy', 'success'), btn('𝗛𝗘𝗟𝗣', 'm:help', 'bulb')],
  ]);

const testDaysKb = (id) =>
  Markup.inlineKeyboard([
    [btn('3-𝗗𝗔𝗬 𝗧𝗘𝗦𝗧', `tdays:${id}:3`, 'clock', 'primary'), btn('6-𝗗𝗔𝗬 𝗧𝗘𝗦𝗧', `tdays:${id}:6`, 'clock', 'danger')],
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
  file: 'team_final.jpg', // 1024x1536 template
  top: { cy: 85, px: 29, date: { cx: 228, w: 240 }, time: { cx: 514, w: 228 }, gc: { cx: 797, w: 246 } },
  bar: { A: { cx: 516, cy: 373 }, B: { cx: 513, cy: 1010 }, w: 432, px: 32 },
  rowDy: { A: 0, B: 639 },
  clipAboveY: 566, // the name bar overlaps the last few pixels of the DP circle - nothing is drawn over the bar
  bat: {
    circle: { cx: 246, cy: 520, r: 58 },
    name: { cx: 246, cy: 588, w: 206 },
    xs: [74, 162, 247, 324, 414], // RUNS BALLS 6s 4s STRIKE RATE
    ws: [67, 70, 60, 60, 89],
    cy: 687,
  },
  bowl: {
    circle: { cx: 779, cy: 520, r: 58 },
    name: { cx: 780, cy: 588, w: 206 },
    xs: [639, 786, 927], // WICKETS BALLS ECONOMY
    ws: [115, 115, 115],
    cy: 687,
  },
  motm: { circle: { cx: 510, cy: 863, r: 58 }, name: { cx: 511, cy: 946, w: 276 }, clipAboveY: null },
  winner: { cx: 516, cy: 1485, w: 396, px: 41 },
  namePx: 26,
  valPx: 29,
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

// Round, size-adjusted DP — centre square crop then circle mask (stable face ratio, no stretch)
async function circleImage(dpBuf, d) {
  if (!dpBuf) return defaultAvatar(d);
  const mask = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#fff"/></svg>`
  );
  try {
    const meta = await sharp(dpBuf).metadata();
    const w = meta.width || d;
    const h = meta.height || d;
    const side = Math.max(1, Math.min(w, h));
    const left = Math.max(0, Math.floor((w - side) / 2));
    const top = Math.max(0, Math.floor((h - side) / 2));
    return await sharp(dpBuf)
      .extract({ left, top, width: side, height: side })
      .resize(d, d, { fit: 'fill' }) // already square — no aspect distortion
      .ensureAlpha()
      .composite([{ input: mask, blend: 'dest-in' }])
      .png()
      .toBuffer();
  } catch (_) {
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
  for (const f of ['host.jpg', 'solo_final.jpg', 'team_final.jpg', 'team_banner.jpg', 'players_list.jpg', 'userinfo.jpg', 'win_team.mp4', 'fifty.mp4', 'fifty_female.mp4', 'graph_template.jpg', 'partnership_template.jpg', 'Poppins-Bold.ttf', 'Poppins-Medium.ttf', 'default_dp.png']) {
    const file = path.join(ASSET_DIR, f);
    if (!fs.existsSync(file)) {
      out.push(`${f} — MISSING${f === 'default_dp.png' ? ' (a built-in avatar is used)' : ''}`);
      continue;
    }
    if (/\.(mp4|ttf)$/i.test(f)) {
      out.push(`${f} — OK ${(fs.statSync(file).size / 1048576).toFixed(1)} MB`);
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
  out.push(typeof ffmpegBin === 'function' && ffmpegBin() ? 'ffmpeg — OK (videos get names on them)' : 'ffmpeg — NOT FOUND (videos are sent without names; install ffmpeg or `npm i ffmpeg-static`)');
  try {
    await renderText('Aa', 20);
    out.push('font — OK');
  } catch (e) {
    out.push(`font — PROBLEM (${e.message})`);
  }
  return out;
}

// ═══ VIDEO OVERLAYS (winning team + fifty) ═══
const POP_BOLD = path.join(ASSET_DIR, 'Poppins-Bold.ttf');
const POP_MED = path.join(ASSET_DIR, 'Poppins-Medium.ttf');
// Prefer Poppins; fall back to DejaVu so win/fifty overlays never go blank when Poppins is missing
async function popText(text, px, color = '#ffffff', bold = true) {
  needSharp();
  const tries = [];
  const popFile = bold ? POP_BOLD : POP_MED;
  if (fs.existsSync(popFile)) {
    tries.push({ font: `Poppins ${bold ? 'Bold' : 'Medium'} ${px}`, fontfile: popFile });
  }
  tries.push({ font: `${FONT_FAMILY} ${px}`, fontfile: FONT_FILE });
  let lastErr;
  for (const f of tries) {
    try {
      return await sharp({
        text: {
          text: `<span foreground="${color}">${xmlEsc(String(text))}</span>`,
          font: f.font,
          fontfile: f.fontfile,
          rgba: true,
          dpi: 72,
        },
      })
        .png()
        .toBuffer({ resolveWithObject: true });
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('popText failed');
}
async function popFit(text, px, maxW, color = '#ffffff', bold = true, minPx = 14) {
  let size = px;
  let img = await popText(text, size, color, bold);
  while (img.info.width > maxW && size > minPx) {
    size -= 2;
    img = await popText(text, size, color, bold);
  }
  return img;
}
// first + last name, else username, else "Player" (ASCII only — card fonts lack other scripts)
function videoName(p) {
  if (!p) return 'Player';
  const full = cleanName([p.first_name, p.last_name].filter(Boolean).join(' '), '').trim();
  if (full) return full;
  const un = cleanName(p.username || '', '').trim();
  if (un) return un;
  const id = p.telegram_id ?? p.id;
  return id != null && Number(id) > 0 ? `P${String(id).slice(-4)}` : 'Player';
}

// 1280x720 transparent overlay for the "WINNING TEAM" video: captain in the CAP box, players line by line in the PLAYER LIST box
async function buildWinOverlay(capName, names) {
  needSharp();
  const layers = [];
  // CAP box — try gold Poppins, fall back to plain text so name always shows
  if (capName) {
    try {
      layers.push(centered(await goldText(capName, 38, 372, { pop: true, squeeze: 1, outline: [60, 0, 0] }), 917, 346, 0));
    } catch (e) {
      console.error('win overlay cap goldText failed, plain fallback:', e.message);
      try {
        layers.push(centered(await popFit(capName, 36, 372, '#ffe08a', true, 18), 917, 346, 0));
      } catch (e2) {
        console.error('win overlay cap plain failed:', e2.message);
      }
    }
  }

  let list = (names || []).map((n) => String(n || '').trim()).filter(Boolean);
  if (list.length > 21) list = list.slice(0, 20).concat([`+${names.length - 20} more`]);
  const n = list.length;
  if (n) {
    const X0 = 590, X1 = 1238, Y0 = 440, Y1 = 686;
    const cols = n <= 7 ? 1 : n <= 14 ? 2 : 3;
    const rows = Math.ceil(n / cols);
    const lineH = Math.min(40, Math.floor((Y1 - Y0) / rows));
    const px = Math.max(14, Math.min(26, Math.round(lineH * 0.62)));
    const colW = (X1 - X0) / cols;
    const top = Y0 + ((Y1 - Y0) - rows * lineH) / 2;
    const items = [];
    for (let i = 0; i < n; i++) {
      const col = Math.floor(i / rows);
      const row = i % rows;
      const label = list[i].startsWith('+') ? null : String(i + 1).padStart(2, '0');
      try {
        const name = await popFit(list[i], px, Math.max(40, colW - 70), '#ffffff', true, 12);
        items.push({ col, row, label, name });
      } catch (e) {
        console.error('win overlay player name failed:', list[i], e.message);
      }
    }
    for (let c = 0; c < cols; c++) {
      const colItems = items.filter((x) => x.col === c);
      if (!colItems.length) continue;
      const w = Math.max(...colItems.map((x) => x.name.info.width)) + 38;
      const left = X0 + c * colW + (colW - w) / 2;
      for (const it of colItems) {
        const cy = top + it.row * lineH + lineH / 2;
        if (it.label) {
          try {
            const num = await popText(it.label, Math.max(12, px - 4), '#ffc53d', true);
            layers.push({ input: num.data, left: Math.round(left), top: Math.round(cy - num.info.height / 2) });
          } catch (_) {}
        }
        layers.push({ input: it.name.data, left: Math.round(left + 38), top: Math.round(cy - it.name.info.height / 2) });
      }
    }
  }
  return sharp({ create: { width: 1280, height: 720, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
}

// 1280x720 transparent overlay for the FIFTY video (shown while the video is paused)
async function buildFiftyOverlay({ name, runs, balls }) {
  needSharp();
  const sr = balls > 0 ? ((runs * 100) / balls).toFixed(2) : '0.00';
  const PX = 240, PY = 140, PW = 800, PH = 340;
  const panel = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#ffe08a"/><stop offset="0.5" stop-color="#d9a233"/><stop offset="1" stop-color="#ffe08a"/>
       </linearGradient></defs>
       <rect x="3" y="3" rx="30" ry="30" width="${PW - 6}" height="${PH - 6}" fill="#07070c" fill-opacity="0.72" stroke="url(#g)" stroke-width="4"/>
       <rect x="14" y="14" rx="22" ry="22" width="${PW - 28}" height="${PH - 28}" fill="none" stroke="#ffffff" stroke-opacity="0.12" stroke-width="1.5"/>
       <line x1="90" y1="176" x2="${PW - 90}" y2="176" stroke="url(#g)" stroke-opacity="0.7" stroke-width="2"/>
     </svg>`
  );
  const layers = [{ input: panel, left: PX, top: PY }];
  const cx = PX + PW / 2;
  layers.push(centered(await goldText('HALF CENTURY', 32, 640, { pop: true, squeeze: 1, outline: [30, 15, 0] }), cx, PY + 44, 0));
  layers.push(centered(await popFit(name, 60, 720, '#ffffff', true, 24), cx, PY + 118, 0));
  const cols = [
    [cx - 250, String(runs), 'RUNS'],
    [cx, String(balls), 'BALLS'],
    [cx + 250, sr, 'STRIKE RATE'],
  ];
  for (const [x, val, label] of cols) {
    layers.push(centered(await goldText(val, 70, 220, { pop: true, squeeze: 1, outline: [30, 15, 0] }), x, PY + 232, 0));
    layers.push(centered(await popText(label, 22, '#cfcfcf', false), x, PY + 296, 0));
  }
  return sharp({ create: { width: 1280, height: 720, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(layers)
    .png()
    .toBuffer();
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
  const squeeze = o.squeeze !== undefined ? o.squeeze : 0.8;
  const minPx = o.minPx || 16;
  const make = async (size) => {
    const base = o.pop ? await popText(String(text), size, '#ffffff', true) : await renderText(String(text), size, '#ffffff');
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

// rich message with an uploaded photo INSIDE it (title + photo + table in one message)
async function sendRichPhoto(chatId, html, imgBuf, replyTo) {
  const media = [{ id: 'card', media: { type: 'photo', media: 'attach://cardfile' } }];
  const tries = [];
  if (PREMIUM_TEXT) tries.push(premiumizeHtml(html, 60));
  tries.push(stripPe(html));
  let last = new Error('sendRichMessage failed');
  for (const h of tries) {
    for (const withReply of replyTo ? [true, false] : [false]) {
      try {
        const fd = new FormData();
        fd.append('chat_id', String(chatId));
        fd.append('rich_message', JSON.stringify({ html: h, media }));
        if (withReply) fd.append('reply_parameters', JSON.stringify({ message_id: replyTo, allow_sending_without_reply: true }));
        fd.append('cardfile', new Blob([imgBuf], { type: 'image/jpeg' }), 'card.jpg');
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendRichMessage`, { method: 'POST', body: fd });
        const j = await res.json();
        if (j.ok) return j.result;
        last = new Error(j.description || 'sendRichMessage failed');
      } catch (e) {
        last = e;
      }
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
  const gm = p.telegram_id != null ? genderMark(p.telegram_id) : '';
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  if (p.username && full) return `@${p.username} (${full})` + gm;
  if (p.username) return `@${p.username}` + gm;
  if (full) return full + gm;
  const id = p.telegram_id ?? p.id;
  return id != null ? String(id) + gm : '—';
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

// ─── Auto-pin: members list + match-start; unpin when match ends ───
// Bot must be group admin with "Pin Messages" permission.
const matchPins = new Map(); // matchId -> Set of message_id
function trackPin(matchId, msgId) {
  if (!matchId || !msgId) return;
  const k = String(matchId);
  if (!matchPins.has(k)) matchPins.set(k, new Set());
  matchPins.get(k).add(Number(msgId));
}
async function pinMsg(telegram, chatId, matchId, msgId) {
  if (!msgId) return;
  try {
    await telegram.pinChatMessage(chatId, Number(msgId), { disable_notification: true });
    trackPin(matchId, msgId);
  } catch (e) {
    console.error('pin failed:', e.message);
  }
}
async function unpinMatchPins(telegram, chatId, matchId) {
  const k = String(matchId);
  const set = matchPins.get(k);
  if (!set || !set.size) {
    matchPins.delete(k);
    return;
  }
  for (const id of set) {
    try {
      await telegram.unpinChatMessage(chatId, id);
    } catch (_) {}
  }
  matchPins.delete(k);
}

// Players-list banner ("Let's Begin") with the text as caption. Telegram captions stop at 1024
// characters, so whatever does not fit goes into a follow-up message.
// Returns the photo message (for pinning) or null.
async function sendPlayersListPhoto(telegram, chatId, text) {
  const lines = String(text).split('\n');
  let cap = '';
  let i = 0;
  for (; i < lines.length; i++) {
    if ((cap + lines[i] + '\n').length > 1000) break;
    cap += lines[i] + '\n';
  }
  const rest = lines.slice(i).join('\n');
  let sent = null;
  try {
    const img = await renderPlayersBanner();
    sent = await telegram.sendPhoto(chatId, { source: img }, { caption: cap.trim() || '📋', parse_mode: 'Markdown' });
  } catch (e) {
    await reportCardError('Players banner', e);
    await sendLong(telegram, chatId, text);
    return null;
  }
  if (rest.trim()) await sendLong(telegram, chatId, rest);
  return sent;
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

// /members and /team: MATCH OVERVIEW with a generated PLAYERS LIST banner (auto-pinned while match is live)
async function sendMembers(ctx, m) {
  const started = ['innings1', 'innings2', 'completed'].includes(m.status);
  const caption =
    `📊 *${fancy('MATCH OVERVIEW')}*\n` +
    `> ${pe('crown','👑')} Host: ${await hostLabel(m)}\n` +
    `> ⏳ Overs: *${started ? m.total_overs : 'None'}* | 🔄 *${statusLabel(m)}*`;
  const sent = await sendPlayersListPhoto(ctx.telegram, ctx.chat.id, caption + '\n\n' + (await rosterText(m)));
  if (sent?.message_id && m && !['completed', 'cancelled'].includes(m.status)) {
    await pinMsg(ctx.telegram, ctx.chat.id, m.id, sent.message_id);
  }
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
// Auto-pins so the group always sees who is batting/bowling.
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
  let sent = null;
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
    sent = await telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'Markdown' });
  } catch (e) {
    await reportCardError('Match banner', e);
    sent = await telegram.sendMessage(groupId, caption, { parse_mode: 'Markdown' });
  }
  if (sent?.message_id) await pinMsg(telegram, groupId, m.id, sent.message_id);
  return sent;
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
  if (ctx.chat && ctx.chat.type === 'private' && (!genderOf(ctx.from.id) || String(ctx.startPayload || '') === 'gender')) return askGender(ctx);
  return sendWelcome(ctx);
});

async function sendWelcome(ctx) {
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
}

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
    const pm = /^([ft]:)(.*)$/.exec(String(k));
    const legacy = pm ? pm[1] + (PGIF_LEGACY[pm[2]] || pm[2]) : PGIF_LEGACY[k] || k;
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
async function sendResultGif(telegram, chatId, key, replyToMessageId, caption = '', gp = null) {
  try {
    const gif = await getPgif(await expandGifKeys(key, chatId, gp));
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
async function sendCaptionedGif(telegram, chatId, key, html, extra0 = {}) {
  const { _gp, ...extra } = extra0 || {};
  let keys = Array.isArray(key) ? key : [key];
  try { keys = await expandGifKeys(key, chatId, _gp); } catch (_) {}
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
  return sendCaptionedGif(telegram, chatId, 'motm', html, { _gp: motmPlayer });
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
      `/fgif <key> — female GIFs · /tgif <key> — Test-match GIFs (also /rmfgif /showfgif /fgiflist · /rmtgif /showtgif /tgiflist)\n` +
      `/gender — choose Male / Female · /teamname <name> — captain\n` +
      `/bet 100 a · /odds · /wallet · /daily · /ranking (/leaderboard)\n` +
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
bot.action('m:test', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  if (!isGroup(ctx)) return ctx.reply('Open this menu in a group — pressing TEST there creates a Test lobby right away.');
  return createTestMatch(ctx);
});
bot.action('m:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Solo: /startsolo → join → start → type 0-6\nTeam: /team → join → /startgame → captains → toss → /setovers\nTest: /test → join → /startgame → captains → toss → 3/6 day → play'
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
bot.action('m:lb_old', async (ctx) => {
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
      `⚠️ *JOIN TIME OVER — MATCH CANCELLED*\n` +
        `${line()}\n` +
        `Not enough players to start a Solo match.\n` +
        `> Required: at least *2* players.\n` +
        `> Current: *${players.length}* player${players.length === 1 ? '' : 's'}.\n\n` +
        `The lobby has been closed. Start a new one with /solo.`,
      { parse_mode: 'Markdown' }
    );
    await cancelMatchNow(m, telegram);
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
  if (!m0 || m0.status !== 'waiting' || m0.mode === 'solo') return; // team + test both OK

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
  const total = a.length + b.length;

  // ── Auto-cancel if minimum players not met (Team + Test) ──
  let needCancel = false;
  let reason = '';
  if (m.mode === 'test') {
    // Test: 8 per team
    if (a.length < TEST_MIN_PLAYERS || b.length < TEST_MIN_PLAYERS) {
      needCancel = true;
      reason =
        `Not enough players to start a Test match.\n` +
        `> Required: at least *${TEST_MIN_PLAYERS}* players per team.\n` +
        `> Current: Team A *${a.length}* · Team B *${b.length}*.`;
    }
  } else {
    // Team: 2 per team
    if (a.length < MIN_TEAM_PLAYERS || b.length < MIN_TEAM_PLAYERS) {
      needCancel = true;
      reason =
        `Not enough players to start the match.\n` +
        `> Required: at least *${MIN_TEAM_PLAYERS}* players per team.\n` +
        `> Current: Team A *${a.length}* · Team B *${b.length}*.`;
    }
  }

  if (needCancel) {
    await telegram.sendMessage(
      chatId,
      `⚠️ *JOIN TIME OVER — MATCH CANCELLED*\n` +
        `${line()}\n` +
        `${reason}\n\n` +
        `The lobby has been closed. Start a new one with /team or /test.`,
      { parse_mode: 'Markdown' }
    );
    await cancelMatchNow(m, telegram);
    return;
  }

  let list =
    `📋 *TEAM LIST*\n` +
    `🅰 *Team A* (${a.length})\n` +
    rosterBlock(a) +
    `\n🅱 *Team B* (${b.length})\n` +
    rosterBlock(b) +
    `\n> Still join: /team\\_a · /team\\_b (until host starts)\n` +
    `> Host: /add\\_a /add\\_b`;

  const listMsg = await sendPlayersListPhoto(telegram, chatId, list);
  if (listMsg?.message_id) await pinMsg(telegram, chatId, m.id, listMsg.message_id);

  const hostId = Number(m.host_telegram_id);
  const hostTag = `[Host](tg://user?id=${hostId})`;
  await telegram.sendMessage(
    chatId,
    `👑 ${hostTag}\n` +
      `⏱ Both join timers are over.\n` +
      `> Send */startgame* now to choose captains and start the toss.`,
    { parse_mode: 'Markdown' }
  );
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

// ─── TEST mode (multi-day, 20 overs, powerplay) ───────────────────────────────
async function createTestMatch(ctx) {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this command in a group');
  try {
    if (await getActiveMatch(ctx.chat.id))
      return ctx.reply(`⚠️ *Only one game per group.*\nA match is already running here.\nHost: /endmatch to cancel it first.`, {
        parse_mode: 'Markdown',
      });

    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'test',$3,$4,$5,$6,'waiting') RETURNING *`,
      [ctx.chat.id, ctx.chat.title || null, ctx.from.id, TEST_MAX_PER_TEAM, TEST_OVERS, MAX_BOWLER_OVERS]
    );
    const m = rows[0];
    for (const L of ['A', 'B']) {
      await q(`INSERT INTO match_teams (match_id, team_label) VALUES ($1,$2)`, [m.id, L]);
    }
    await upsertUser(ctx.from);
    await q(
      `UPDATE matches SET spam_free=TRUE, test_days=NULL, current_day=0, day_wins_a=0, day_wins_b=0, pause_key=NULL, paused_at=NULL WHERE id=$1`,
      [m.id]
    );

    await sendHostBanner(
      ctx,
      `${pe('trophy','🏆')} *${fancy('TEST MATCH')}*\n` +
        `> ${pe('crown','👑')} Host: *${mn(ctx.from)}*\n` +
        `> ${pe('people','👤')} Min *${TEST_MIN_PLAYERS}* per team · Max *${TEST_MAX_PER_TEAM}* per team\n` +
        `> 📅 3-day or 6-day Test (chosen after toss)\n` +
        `> ⏳ Each day = *${TEST_OVERS}* overs per side\n` +
        `> ⚡ Powerplay: first ${TEST_POWERPLAY_OVERS} overs → only 0-1-2-3\n` +
        `> After powerplay: max *${TEST_BOUNDARY_LIMIT}* fours/sixes per over (3rd = catch out)\n\n` +
        `${pe('mega','📌')} *Join*\n` +
        `> /team\\_a — Team A\n` +
        `> /team\\_b — Team B\n\n` +
        `${pe('zap','⚡')} *Host*\n` +
        `> /startgame — captains → toss → pick days → play\n` +
        `> /members — see the teams\n` +
        `> /endmatch — cancel\n` +
        `> /pause · /resume (2 votes each team)`
    );
    await startTeamJoinPhase(ctx.telegram, m.id, ctx.chat.id);
    touchMatch(m.id);
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command(['test', 'starttest'], createTestMatch);

async function joinTeam(ctx, label) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.status !== 'waiting' || m.mode === 'solo')
      return ctx.reply('❌ There is no team/test lobby open. Use /team or /test to create one.');
    if (m.vs_bot && label === 'B') return ctx.reply('🤖 Team B is the bot team — join Team A with /team_a');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('❌ You are already in a team');
    const team = await getPlayers(m.id, label);
    const maxSize = m.mode === 'test' ? TEST_MAX_PER_TEAM : m.team_size;
    if (team.length >= maxSize) return ctx.reply(`❌ Team ${label} is full (${maxSize})`);

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
    // Allow add in lobby AND during live innings (request still goes to the player)
    if (!['waiting', 'captains', 'toss', 'innings1', 'innings2'].includes(m.status))
      return ctx.reply('⚠️ Players can only be added while the match is active');
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
    if (!m || !['waiting', 'captains', 'toss', 'innings1', 'innings2'].includes(m.status))
      return ctx.answerCbQuery('Too late — the match is over', { show_alert: true });
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

// ─── /remove /kick : host (or captain) removes a player instantly (no request) ───
// Works in lobby and during live innings for both solo & team.
async function removePlayers(ctx) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
    if (!['waiting', 'captains', 'toss', 'innings1', 'innings2'].includes(m.status))
      return ctx.reply('⚠️ Match is already finished');
    const isHost = Number(m.host_telegram_id) === ctx.from.id;
    if (!isHost && !isAdmin(ctx.from.id)) {
      // captains can only remove from their own team
      const tA = await getTeam(m.id, 'A');
      const tB = await getTeam(m.id, 'B');
      const isCapA = tA && Number(tA.captain_id) === ctx.from.id;
      const isCapB = tB && Number(tB.captain_id) === ctx.from.id;
      if (!isCapA && !isCapB) return ctx.reply('❌ Only the host or a captain can remove players');
    }
    const targets = parseAddTargets(ctx);
    if (!targets.length)
      return ctx.reply(
        'Usage:\n/remove @user\n/remove 167282\n…or reply to a player’s message with /remove\n\n' +
          'By roster number:\n/remove_a1  /remove_b2  /rm_b3'
      );
    const removed = [];
    const problems = [];
    for (const t of targets) {
      const info = await resolveTarget(ctx, t);
      if (!info) {
        problems.push(`@${t.username || t.id} — not found`);
        continue;
      }
      if (Number(info.id) === Number(m.host_telegram_id)) {
        problems.push(`${info.username ? '@' + info.username : info.first_name || info.id} — cannot remove the host`);
        continue;
      }
      const pl = await getPlayerByTg(m.id, info.id);
      if (!pl) {
        problems.push(`${info.username ? '@' + info.username : info.first_name || info.id} — not in this match`);
        continue;
      }
      // captain restriction
      if (!isHost && !isAdmin(ctx.from.id)) {
        const team = await getTeam(m.id, pl.team_label);
        if (!team || Number(team.captain_id) !== ctx.from.id) {
          problems.push(`${info.username ? '@' + info.username : info.first_name || info.id} — only their captain or host can remove`);
          continue;
        }
      }
      // if currently batting / bowling, clear from innings so game can continue
      const inn = await getInnings(m.id);
      if (inn) {
        if (inn.striker_player_id === pl.id) await q(`UPDATE innings SET striker_player_id=NULL WHERE id=$1`, [inn.id]);
        if (inn.non_striker_player_id === pl.id) await q(`UPDATE innings SET non_striker_player_id=NULL WHERE id=$1`, [inn.id]);
        if (inn.current_bowler_id === pl.id) await q(`UPDATE innings SET current_bowler_id=NULL WHERE id=$1`, [inn.id]);
      }
      await q(`DELETE FROM match_players WHERE id=$1`, [pl.id]);
      // if they were captain, clear captain
      await q(`UPDATE match_teams SET captain_id=NULL WHERE match_id=$1 AND captain_id=$2`, [m.id, info.id]);
      const display = info.username ? '@' + info.username : info.first_name || String(info.id);
      removed.push(display);
    }
    let msg = '';
    if (removed.length) msg += `🗑 Removed: ${removed.map(mdEsc).join(', ')}\n`;
    if (problems.length) msg += `⚠️ Skipped:\n${problems.map(mdEsc).join('\n')}`;
    await ctx.reply(msg || 'Nothing changed', { parse_mode: 'Markdown' });
    if (removed.length && ['innings1', 'innings2'].includes(m.status)) {
      // re-arm turn so the game does not stay stuck without striker/bowler
      try { await ensureTurnClock(m.id); } catch (_) {}
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command(['remove', 'kick', 'rmplayer'], removePlayers);

// /remove_b2  /remove_a1  /rm_b3  — remove Team X player at roster position N (no request)
bot.hears(/^\/(?:remove|rm|kick)_([ab])(\d+)(?:@\w+)?(?:\s|$)/i, async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const label = String(ctx.match[1]).toUpperCase();
    const pos = parseInt(ctx.match[2], 10);
    if (!pos || pos < 1) return ctx.reply('Usage: /remove_b2  (Team B, roster #2)');

    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply(`${pe('no','❌')} No active match`);
    if (!['waiting', 'captains', 'toss', 'innings1', 'innings2'].includes(m.status))
      return ctx.reply('⚠️ Match is already finished');
    if (m.mode === 'solo' && label !== 'A')
      return ctx.reply('ℹ️ Solo has only one list — use /remove_a1 etc.');

    const isHost = Number(m.host_telegram_id) === ctx.from.id;
    if (!isHost && !isAdmin(ctx.from.id)) {
      const team = await getTeam(m.id, label);
      if (!team || Number(team.captain_id) !== ctx.from.id)
        return ctx.reply(`❌ Only the host or Team ${label} captain can remove from Team ${label}`);
    }

    const pl = await getPlayerByPos(m.id, label, pos);
    if (!pl) return ctx.reply(`❌ No player at Team ${label} #${pos}`);
    if (Number(pl.telegram_id) === Number(m.host_telegram_id))
      return ctx.reply('❌ Cannot remove the host');

    const inn = await getInnings(m.id);
    if (inn) {
      if (inn.striker_player_id === pl.id) await q(`UPDATE innings SET striker_player_id=NULL WHERE id=$1`, [inn.id]);
      if (inn.non_striker_player_id === pl.id) await q(`UPDATE innings SET non_striker_player_id=NULL WHERE id=$1`, [inn.id]);
      if (inn.current_bowler_id === pl.id) await q(`UPDATE innings SET current_bowler_id=NULL WHERE id=$1`, [inn.id]);
    }
    await q(`DELETE FROM match_players WHERE id=$1`, [pl.id]);
    await q(`UPDATE match_teams SET captain_id=NULL WHERE match_id=$1 AND captain_id=$2`, [m.id, pl.telegram_id]);

    const display = pl.username ? '@' + pl.username : name(pl);
    await ctx.reply(
      `🗑 Removed *Team ${label} #${pos}* — ${mdEsc(display)}`,
      { parse_mode: 'Markdown' }
    );
    if (['innings1', 'innings2'].includes(m.status)) {
      try { await ensureTurnClock(m.id); } catch (_) {}
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
});

// ─── /lang /setlang en|hi : choose default commentary language for this group ───
bot.command(['lang', 'setlang', 'commentary'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Use this in a group.');
  try {
    const arg = String(ctx.message?.text || '').split(/\s+/)[1]?.toLowerCase() || '';
    if (!arg || !['en', 'english', 'hi', 'hindi', 'हिं', 'हिंदी'].includes(arg)) {
      const cur = await getGroupLang(ctx.chat.id);
      return ctx.reply(
        `🎙️ *Commentary language*\n` +
          `> Current: *${cur === 'hi' ? 'Hindi' : 'English'}*\n\n` +
          `Change with:\n` +
          `/lang en  — English commentary\n` +
          `/lang hi  — Hindi commentary`,
        { parse_mode: 'Markdown' }
      );
    }
    const isHost = (await getActiveMatch(ctx.chat.id))?.host_telegram_id == ctx.from.id;
    if (!isHost && !(await isGroupAdmin(ctx.chat.id, ctx.from.id)) && !isAdmin(ctx.from.id))
      return ctx.reply('❌ Only the host or a group admin can change commentary language.');
    const lang = ['hi', 'hindi', 'हिं', 'हिंदी'].includes(arg) ? 'hi' : 'en';
    await setGroupLang(ctx.chat.id, lang);
    await ctx.reply(
      lang === 'hi'
        ? '🎙️ कमेंट्री अब *हिंदी* में चलेगी।'
        : '🎙️ Commentary language set to *English*.',
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

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
  refundBets(tg, Number(m.group_chat_id), m.id).catch((e) => console.error('refundBets:', e.message));
  const groupId = Number(m.group_chat_id);
  if (groupId) {
    await unpinMatchPins(tg, groupId, m.id);
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

// ─── Test pause / resume (2 votes from each team) ─────────
const pauseVotes = new Map(); // matchId -> { A: Set, B: Set, phase: 'pause'|'resume', startedAt }
function clearPauseVote(matchId) {
  pauseVotes.delete(mkey(matchId));
}

bot.command('pause', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'test') return ctx.reply('❌ /pause is only for Test matches');
    if (!['innings1', 'innings2'].includes(m.status)) return ctx.reply('⚠️ Match is not live');
    if (m.paused_at) return ctx.reply('⏸ Test is already paused. Use /resume <host_id>');

    const p = await getPlayerByTg(m.id, ctx.from.id);
    if (!p) return ctx.reply('❌ Only players in this Test can vote');

    let v = pauseVotes.get(mkey(m.id));
    if (!v || v.phase !== 'pause') {
      v = { A: new Set(), B: new Set(), phase: 'pause', startedAt: Date.now() };
      pauseVotes.set(mkey(m.id), v);
    }
    v[p.team_label].add(Number(ctx.from.id));
    const aN = v.A.size;
    const bN = v.B.size;
    await ctx.reply(
      `⏸ *PAUSE VOTE*\n` +
        `> Team A: *${aN}/${TEST_PAUSE_VOTES}* · Team B: *${bN}/${TEST_PAUSE_VOTES}*\n` +
        `> Need *${TEST_PAUSE_VOTES}* from each team.\n` +
        (aN >= TEST_PAUSE_VOTES && bN >= TEST_PAUSE_VOTES
          ? `> ✅ Votes reached — pausing…`
          : `> Type /pause again to add your vote.`),
      { parse_mode: 'Markdown' }
    );
    if (aN >= TEST_PAUSE_VOTES && bN >= TEST_PAUSE_VOTES) {
      const key = String(m.host_telegram_id);
      await q(`UPDATE matches SET paused_at=NOW(), pause_key=$2 WHERE id=$1`, [m.id, key]);
      clearTurnClock(m.id);
      clearPauseVote(m.id);
      await ctx.telegram.sendMessage(
        ctx.chat.id,
        `⏸ *TEST PAUSED*\n` +
          `> Key (host id): \`${key}\`\n` +
          `> Max pause: *48 hours*\n` +
          `> To resume: 2 votes each team + /resume ${key}`,
        { parse_mode: 'Markdown' }
      );
    }
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('resume', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'test') return ctx.reply('❌ /resume is only for Test matches');
    if (!m.paused_at) return ctx.reply('▶️ Test is not paused');

    const arg = String(ctx.message?.text || '').split(/\s+/)[1] || '';
    const key = String(m.pause_key || m.host_telegram_id);
    if (arg && arg !== key)
      return ctx.reply(`❌ Wrong key. Use: /resume ${key}`);

    const pausedMs = Date.now() - new Date(m.paused_at).getTime();
    if (pausedMs > TEST_PAUSE_MAX_MS) {
      await cancelMatchNow(m);
      return ctx.reply('🛑 Pause expired (48h). Test auto-cancelled.');
    }

    const p = await getPlayerByTg(m.id, ctx.from.id);
    if (!p) return ctx.reply('❌ Only players in this Test can vote');

    let v = pauseVotes.get(mkey(m.id));
    if (!v || v.phase !== 'resume') {
      v = { A: new Set(), B: new Set(), phase: 'resume', startedAt: Date.now() };
      pauseVotes.set(mkey(m.id), v);
    }
    v[p.team_label].add(Number(ctx.from.id));
    const aN = v.A.size;
    const bN = v.B.size;
    await ctx.reply(
      `▶️ *RESUME VOTE*\n` +
        `> Team A: *${aN}/${TEST_PAUSE_VOTES}* · Team B: *${bN}/${TEST_PAUSE_VOTES}*\n` +
        (aN >= TEST_PAUSE_VOTES && bN >= TEST_PAUSE_VOTES ? `> ✅ Resuming…` : `> Type /resume ${key} to add your vote.`),
      { parse_mode: 'Markdown' }
    );
    if (aN >= TEST_PAUSE_VOTES && bN >= TEST_PAUSE_VOTES) {
      await q(`UPDATE matches SET paused_at=NULL, pause_key=NULL WHERE id=$1`, [m.id]);
      clearPauseVote(m.id);
      touchMatch(m.id);
      await ctx.telegram.sendMessage(ctx.chat.id, `▶️ *TEST RESUMED* — play continues.`, { parse_mode: 'Markdown' });
      await ensureTurnClock(m.id);
    }
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
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
    if (m.mode === 'test') {
      if (a.length < TEST_MIN_PLAYERS || b.length < TEST_MIN_PLAYERS)
        return ctx.reply(
          `❌ Test needs at least *${TEST_MIN_PLAYERS}* players per team (Team A: ${a.length}, Team B: ${b.length})`,
          { parse_mode: 'Markdown' }
        );
    } else if (a.length < MIN_TEAM_PLAYERS || b.length < MIN_TEAM_PLAYERS) {
      return ctx.reply(
        `❌ Each team needs at least ${MIN_TEAM_PLAYERS} players (Team A: ${a.length}, Team B: ${b.length})`
      );
    }

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
    const groupId = Number(m.group_chat_id);
    setTimeout(() => sendTeamNamePrompt(ctx.telegram, m).catch((e) => console.error('team name prompt:', e.message)), 1500);
    if (m.mode === 'test') {
      await ctx.telegram.sendMessage(
        groupId,
        `📅 *HOST — CHOOSE TEST LENGTH*\n` +
          `> [Host](tg://user?id=${Number(m.host_telegram_id)}), pick days:\n` +
          `> • *3-Day Test* — best of 3 days\n` +
          `> • *6-Day Test* — best of 6 days\n` +
          `> Each day = *${TEST_OVERS}* overs per side · Powerplay rules apply`,
        { parse_mode: 'Markdown', ...testDaysKb(m.id) }
      );
    } else {
      await ctx.telegram.sendMessage(
        groupId,
        `⏱ *HOST — SET OVERS*\n` +
          `> [Host](tg://user?id=${Number(m.host_telegram_id)}), pick total overs (1–${MAX_OVERS}):`,
        { parse_mode: 'Markdown', ...oversKb(m.id) }
      );
    }
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
    // Pin members/roster list at match start
    try {
      const rosterMsg = await sendPlayersListPhoto(
        ctx.telegram,
        groupId,
        `📊 *${fancy('MATCH OVERVIEW')}*\n` +
          `> ${pe('crown','👑')} Host: ${await hostLabel(mm)}\n` +
          `> ⏳ Overs: *${mm.total_overs}* | 🔄 *${statusLabel(mm)}*\n\n` +
          (await rosterText(mm))
      );
      if (rosterMsg?.message_id) await pinMsg(ctx.telegram, groupId, mm.id, rosterMsg.message_id);
    } catch (e) {
      console.error('start roster pin:', e.message);
      await sendLong(ctx.telegram, groupId, await rosterText(mm));
    }
    const bowlTeam = await getTeam(m.id, mm.current_bowling_team);
    const batTeam = await getTeam(m.id, mm.current_batting_team);
    const bowlCap = bowlTeam?.captain_id ? await getPlayerByTg(m.id, bowlTeam.captain_id) : null;
    const batCap = batTeam?.captain_id ? await getPlayerByTg(m.id, batTeam.captain_id) : null;
    const startMsg = await sendCaptionedGif(
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
    if (startMsg?.message_id) await pinMsg(ctx.telegram, groupId, mm.id, startMsg.message_id);
    await botTeamAssist(m.id);
    await ensureTurnClock(m.id);
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery(String(e.message).slice(0, 150), { show_alert: true }).catch(() => {});
  }
});

// ─── Test: host picks 3-day or 6-day ─────────────────────
bot.action(/^tdays:(.+):(3|6)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const days = Number(ctx.match[2]);
  try {
    const m = await getMatch(matchId);
    if (!m || m.mode !== 'test' || m.status !== 'toss' || m.setup_phase !== 'overs')
      return ctx.answerCbQuery('Days already set', { show_alert: true });
    if (Number(m.host_telegram_id) !== ctx.from.id)
      return ctx.answerCbQuery('Only the host can choose the days', { show_alert: true });

    const a = await getPlayers(m.id, 'A');
    const b = await getPlayers(m.id, 'B');
    const minSize = Math.max(1, Math.min(a.length, b.length));
    const perBowler = Math.min(TEST_OVERS, Math.max(MAX_BOWLER_OVERS, Math.ceil(TEST_OVERS / minSize)));

    const upd = await q(
      `UPDATE matches SET total_overs=$2, max_overs_per_bowler=$3, status='innings1',
         current_innings=1, setup_phase='live', test_days=$4, current_day=1, day_wins_a=0, day_wins_b=0
       WHERE id=$1 AND status='toss' AND setup_phase='overs' RETURNING *`,
      [m.id, TEST_OVERS, perBowler, days]
    );
    if (!upd.rowCount) return ctx.answerCbQuery('Already set', { show_alert: true });
    const mm = upd.rows[0];

    await q(
      `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state)
       VALUES ($1,1,$2,$3,'idle')`,
      [m.id, mm.current_batting_team, mm.current_bowling_team]
    );

    await ctx.answerCbQuery(`${days}-Day Test`);
    try {
      await ctx.editMessageText(
        `✅ *${days}-Day Test* · ${TEST_OVERS} overs/side · Day *1/${days}*`,
        { parse_mode: 'Markdown' }
      );
    } catch (_) {}

    const groupId = Number(m.group_chat_id);
    await sendMatchBanner(
      ctx.telegram,
      groupId,
      mm,
      `\n📅 Day *1/${days}* · max ${perBowler} per bowler\n⚡ Powerplay: first ${TEST_POWERPLAY_OVERS} overs → 0-1-2-3 only`
    );
    try {
      const rosterMsg = await sendPlayersListPhoto(
        ctx.telegram,
        groupId,
        `📊 *${fancy('TEST OVERVIEW')}*\n` +
          `> ${pe('crown','👑')} Host: ${await hostLabel(mm)}\n` +
          `> 📅 ${days}-Day Test · Day 1 · ${TEST_OVERS} overs\n` +
          `> 🔄 *${statusLabel(mm)}*\n\n` +
          (await rosterText(mm))
      );
      if (rosterMsg?.message_id) await pinMsg(ctx.telegram, groupId, mm.id, rosterMsg.message_id);
    } catch (e) {
      console.error('test start roster:', e.message);
    }
    const bowlTeam = await getTeam(m.id, mm.current_bowling_team);
    const batTeam = await getTeam(m.id, mm.current_batting_team);
    const bowlCap = bowlTeam?.captain_id ? await getPlayerByTg(m.id, bowlTeam.captain_id) : null;
    const batCap = batTeam?.captain_id ? await getPlayerByTg(m.id, batTeam.captain_id) : null;
    const startMsg = await sendCaptionedGif(
      ctx.telegram,
      groupId,
      'starter',
      `🏟 <b>${fancy('TEST DAY 1 STARTED')}</b>\n` +
        `<blockquote>📅 ${days}-Day Test · ${TEST_OVERS} overs · Powerplay ${TEST_POWERPLAY_OVERS} ov</blockquote>\n` +
        `🎳 <b>Team ${mm.current_bowling_team} is fielding</b>\n` +
        `<blockquote>${bowlCap ? htag(bowlCap) : 'Captain'}, send your bowler → <code>/ball &lt;no.&gt;</code></blockquote>\n` +
        `🏏 <b>Team ${mm.current_batting_team} is batting</b>\n` +
        `<blockquote>${batCap ? htag(batCap) : 'Captain'}, send your openers → <code>/bat &lt;no.&gt;</code> (twice)</blockquote>`
    );
    if (startMsg?.message_id) await pinMsg(ctx.telegram, groupId, mm.id, startMsg.message_id);
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
    const isHost = Number(m.host_telegram_id) === ctx.from.id;
    const isCap = Number(team?.captain_id) === ctx.from.id;
    if (!isCap && !isHost && !isAdmin(ctx.from.id))
      return ctx.reply('❌ Only the batting captain or the host can do this');

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
    await sendResultGif(ctx.telegram, ctx.chat.id, 'batentry', undefined, newBatsmanCaption(p), p);
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
    const isHost = Number(m.host_telegram_id) === ctx.from.id;
    const isCap = Number(team?.captain_id) === ctx.from.id;
    if (!isCap && !isHost && !isAdmin(ctx.from.id))
      return ctx.reply('❌ Only the bowling captain or the host can do this');

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
    await sendResultGif(ctx.telegram, ctx.chat.id, 'bowlentry', undefined, newBowlerCaption(p), p);
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

// ═════════════════ DISCIPLINE: 30s turn clock, 10s warning, penalties ═════════════════
// Rules
//  • Batsman must type 0-6 within 30s, bowler must pick his number within 30s.
//  • English warning at 10s remaining.
//  • Miss = -6 runs. Team mode: -6 from the player's TEAM score. Solo: -6 from the player's own runs
//    (even if he has no runs yet — his score simply starts from -6).
//  • Bowler warnings: solo → bowling auto-changes after 3, team → captain is tagged after 2 to choose a new bowler.
//  • Batsman: after 2 missed turns he is retired OUT (solo: also removed from the match).

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
const turnClocks = new Map(); // matchId -> { key, timer, warnTimer }
const lockMsgs = new Map(); // callback_token -> group message id of the "locked" notice

function clearTurnClock(matchId) {
  const c = turnClocks.get(mkey(matchId));
  if (c?.timer) clearTimeout(c.timer);
  if (c?.warnTimer) clearTimeout(c.warnTimer);
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
    (bowlerIsBot
      ? `🤖 <b>${htag(bowler)} is choosing the number…</b>`
      : dmOk
      ? `🎳 <b>${htag(bowler)}</b> — <b>send your bowling number 1–6 in the bot's DM (${TURN_SECONDS}s)</b>`
      : `⚠️ <b>${htag(bowler)}</b> — <b>open the bot's DM and press /start, then send 1–6 (${TURN_SECONDS}s)</b>`) +
    (hat ? `\n🎩 <b>HAT-TRICK BALL!</b>` : '') +
    (spamFreeOn(m) ? `\n🛡 <b>Spam-free: no number 3 times in a row</b>` : '');
  const w = await sendCaptionedGif(tg, groupId, 'runup', html, { ...(bowlerIsBot ? {} : openBotDmKb()), _gp: bowler });
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

// Start the ball if it is time, and (re)arm the turn clock for whoever is due. Safe to call any time.
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
    // English warning at 10s remaining
    const warnMs = Math.max(0, (TURN_SECONDS - TURN_WARN_SECONDS) * 1000);
    const warnTimer = setTimeout(async () => {
      try {
        const still = turnClocks.get(mkey(matchId));
        if (!still || still.key !== st.key) return;
        const now = await turnState(matchId);
        if (!now || now.key !== st.key) return;
        const groupId = Number(st.m.group_chat_id);
        if (st.kind === 'bat') {
          const striker = await getPlayer(st.inn.striker_player_id);
          if (striker)
            await bot.telegram.sendMessage(
              groupId,
              `⚠️ *${TURN_WARN_SECONDS}s left!*\n> ${mtag(striker)} — type *0–6* now or you will be timed out.`,
              { parse_mode: 'Markdown' }
            );
        } else {
          const bowler = await getPlayer(st.inn.current_bowler_id);
          if (bowler)
            await bot.telegram.sendMessage(
              groupId,
              `⚠️ *${TURN_WARN_SECONDS}s left!*\n> ${mtag(bowler)} — send *1–6* in the bot DM now or this ball is cancelled.`,
              { parse_mode: 'Markdown' }
            );
        }
      } catch (e) {
        console.error('turn warn failed:', e.message);
      }
    }, warnMs);
    turnClocks.set(mkey(matchId), { key: st.key, timer, warnTimer });
  } catch (e) {
    console.error('ensureTurnClock failed:', e.message);
  }
}

async function onTurnTimeout(matchId, key) {
  const cur = turnClocks.get(mkey(matchId));
  if (!cur || cur.key !== key) return;
  if (cur.warnTimer) clearTimeout(cur.warnTimer);
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

// Solo: too few players left -> the match is closed
async function endSoloTooFew(m, inn) {
  const groupId = Number(m.group_chat_id);
  clearTurnClock(m.id);
  await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE innings_id=$1 AND is_resolved=FALSE`, [inn.id]);
  await bot.telegram.sendMessage(groupId, `😴 *${fancy('MATCH ENDED')}*\n> Not enough players are left to play.`, { parse_mode: 'Markdown' });
  const fresh = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0] || inn;
  await finishSolo(bot.telegram, groupId, m, fresh);
  clearTurnClock(m.id);
  clearWarns(m.id);
  stopIdleWatch(m.id);
  endVote(m.id);
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

  if (isSolo) {
    // Solo: remove the timed-out player from the match entirely (no more game for them)
    await q(`DELETE FROM match_players WHERE id=$1`, [striker.id]);
    await tg.sendMessage(
      groupId,
      `🚪 ${mtag(striker)} timed out *${BAT_RETIRE_LIMIT}* times and is *removed from this solo match*.\n` +
        `> Next batsman will come in automatically.`,
      { parse_mode: 'Markdown' }
    );
    const left = await getPlayers(m.id, 'A');
    if (left.length < 2) return endSoloTooFew(m, inn);
  } else {
    // Team: tag batting captain to send the next batsman
    const team = await getTeam(m.id, inn.batting_team);
    const cap = team?.captain_id ? await getPlayerByTg(m.id, team.captain_id) : null;
    await tg.sendMessage(
      groupId,
      `👑 ${cap ? mtag(cap) : 'Captain'} — ${mtag(striker)} is *retired OUT* after ${BAT_RETIRE_LIMIT} timeouts.\n` +
        `> Send your *new batsman*: /bat <no.>`,
      { parse_mode: 'Markdown' }
    );
  }

  // OUT gif + tag the retired batsman
  await sendResultGif(
    tg,
    groupId,
    'out',
    undefined,
    `💥 <b>OUT!</b>\n${htag(striker)} is <b>retired OUT</b> after ${BAT_RETIRE_LIMIT} missed turns.`,
    striker
  );
  // dugout only if duck (0 runs)
  const { rows: rs } = await q(`SELECT runs FROM batting_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, striker.id]);
  if (Number(rs[0]?.runs || 0) === 0) {
    await sendResultGif(tg, groupId, 'dugout', undefined, dugoutCaption(striker), striker);
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
      // thrown out of the solo game
      await q(`UPDATE innings SET current_bowler_id=NULL WHERE id=$1 AND current_bowler_id=$2`, [inn.id, bowler.id]);
      await q(`UPDATE innings SET last_bowler_id=NULL WHERE id=$1 AND last_bowler_id=$2`, [inn.id, bowler.id]);
      try {
        await q(`DELETE FROM match_players WHERE id=$1`, [bowler.id]);
      } catch (e) {
        console.error('solo bowler removal failed:', e.message);
      }
      await tg.sendMessage(
        groupId,
        `🚪 ${mtag(bowler)} timed out *${limit}* times and is *removed from this solo match*.`,
        { parse_mode: 'Markdown' }
      );
      const left = await getPlayers(m.id, 'A');
      if (left.length < 2) return endSoloTooFew(m, inn);
      const innNow = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0] || inn;
      const nb = await soloRotateBowler(m, innNow);
      if (nb) {
        await tg.sendMessage(groupId, `🔄 *BOWLING CHANGE*\n${mtag(nb)} is the new bowler.`, {
          parse_mode: 'Markdown',
        });
        await sendResultGif(tg, groupId, 'bowlentry', undefined, newBowlerCaption(nb), nb);
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
          `Send your *new bowler*: /ball <no.>`,
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
    if (m.paused_at) {
      await ctx.reply('⏸ Test is paused. Use /resume <host_id> (2 votes each team).').catch(() => {});
      return;
    }
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

    // ── Test powerplay / boundary limit ──
    if (m.mode === 'test') {
      const oversDone = Math.floor((inn.balls_bowled || 0) / 6);
      const ballInOver = (inn.balls_bowled || 0) % 6; // 0..5 before this ball
      // Powerplay (first 5 overs): only 0-1-2-3
      if (oversDone < TEST_POWERPLAY_OVERS && num >= 4) {
        await ctx.telegram.sendMessage(
          ctx.chat.id,
          `⚡ *POWERPLAY* (overs 1–${TEST_POWERPLAY_OVERS})\n` +
            `${htag(striker)} — only *0 / 1 / 2 / 3* allowed.\n4 / 5 / 6 are blocked in powerplay.`,
          { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true }
        );
        return;
      }
      // After powerplay: max 2 boundaries (4 or 6) per over → 3rd = catch out
      if (oversDone >= TEST_POWERPLAY_OVERS && (num === 4 || num === 6)) {
        const { rows: overDels } = await q(
          `SELECT bat_number FROM deliveries WHERE innings_id=$1 AND over_number=$2`,
          [inn.id, Math.floor((inn.balls_bowled || 0) / 6)]
        );
        const bounds = overDels.filter((d) => Number(d.bat_number) === 4 || Number(d.bat_number) === 6).length;
        if (bounds >= TEST_BOUNDARY_LIMIT) {
          // Force catch-out: treat as wicket regardless of bowler number
          const claimOut = await q(
            `UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1 AND is_resolved=FALSE AND bowl_number IS NOT NULL`,
            [pend.callback_token]
          );
          if (!claimOut.rowCount) return;
          // Override: resolve as out by matching bowl number artificially
          const forcedPend = { ...pend, bowl_number: num };
          try {
            await ctx.telegram.sendMessage(
              ctx.chat.id,
              `✋ *CATCH OUT!* (Test rule)\n` +
                `${htag(striker)} already hit *${TEST_BOUNDARY_LIMIT}* fours/sixes this over.\n` +
                `Third boundary = catch out.`,
              { parse_mode: 'HTML', reply_to_message_id: ctx.message.message_id, allow_sending_without_reply: true }
            );
            await resolveBall(ctx.telegram, m, inn, forcedPend, num, ctx.message.message_id);
          } catch (e) {
            try {
              await q(`UPDATE pending_balls SET is_resolved=FALSE WHERE callback_token=$1 AND bowl_number IS NOT NULL`, [
                pend.callback_token,
              ]);
            } catch (_) {}
            throw e;
          }
          return;
        }
      }
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
    `🏏 <b>${striker ? htag(striker) : 'Batsman'}</b> — <b>send your number ${hat ? '1–6' : '0–6'} in the group (${TURN_SECONDS}s)</b>` +
    (hat ? `\n🎩 <b>HAT-TRICK BALL! 0 is not allowed.</b>` : '');
  const lock = await sendCaptionedGif(ctx.telegram, groupId, 'stance', html, { _gp: striker });
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
  await unpinMatchPins(telegram, groupId, m.id);
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

  // ── Test multi-day: record day win, start next day if remaining ──
  if (m.mode === 'test' && m.test_days) {
    let winsA = Number(m.day_wins_a || 0);
    let winsB = Number(m.day_wins_b || 0);
    if (winner === 'A') winsA++;
    else if (winner === 'B') winsB++;
    const day = Number(m.current_day || 1);
    const totalDays = Number(m.test_days);

    await q(
      `UPDATE matches SET day_wins_a=$2, day_wins_b=$3 WHERE id=$1`,
      [m.id, winsA, winsB]
    );

    const { rows: inns } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [m.id]);
    let dayCap =
      `📅 *DAY ${day}/${totalDays} OVER*\n${resultLine}\n` +
      `> Series: Team A *${winsA}* — *${winsB}* Team B\n`;
    for (const i of inns) {
      dayCap += `> Team ${i.batting_team}: *${i.total_runs}/${i.total_wickets}* (${oversStr(i.balls_bowled)} ov)\n`;
    }
    await telegram.sendMessage(groupId, dayCap, { parse_mode: 'Markdown' });

    if (day < totalDays) {
      // Start next day: clear innings/stats, keep players & captains, same toss order
      await q(`DELETE FROM deliveries WHERE innings_id IN (SELECT id FROM innings WHERE match_id=$1)`, [m.id]);
      await q(`DELETE FROM batting_stats WHERE innings_id IN (SELECT id FROM innings WHERE match_id=$1)`, [m.id]);
      await q(`DELETE FROM bowling_stats WHERE innings_id IN (SELECT id FROM innings WHERE match_id=$1)`, [m.id]);
      await q(`DELETE FROM innings WHERE match_id=$1`, [m.id]);
      await q(`UPDATE match_players SET test_lifeline=1 WHERE match_id=$1`, [m.id]);

      const nextDay = day + 1;
      const batFirst = m.batting_first_team || 'A';
      const bowlFirst = batFirst === 'A' ? 'B' : 'A';
      await q(
        `UPDATE matches SET status='innings1', current_innings=1, current_day=$2,
           current_batting_team=$3, current_bowling_team=$4, target=NULL, setup_phase='live',
           penalty_log=NULL WHERE id=$1`,
        [m.id, nextDay, batFirst, bowlFirst]
      );
      await q(
        `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state)
         VALUES ($1,1,$2,$3,'idle')`,
        [m.id, batFirst, bowlFirst]
      );
      await telegram.sendMessage(
        groupId,
        `📅 *DAY ${nextDay}/${totalDays} STARTED*\n` +
          `> Series so far: A *${winsA}* — *${winsB}* B\n` +
          `> 🏏 Batting: Team *${batFirst}* · 🎳 Bowling: Team *${bowlFirst}*\n` +
          `> Captains: /bat & /ball as usual · Powerplay rules apply`,
        { parse_mode: 'Markdown' }
      );
      await ensureTurnClock(m.id);
      return;
    }

    // Series finished
    let seriesWinner = winsA > winsB ? 'A' : winsB > winsA ? 'B' : 'tie';
    resultLine =
      seriesWinner === 'tie'
        ? `🤝 *TEST SERIES TIED* (${winsA}–${winsB})`
        : `🏆 *Team ${seriesWinner} WINS THE ${totalDays}-DAY TEST* (${winsA}–${winsB})`;
    winner = seriesWinner;
  }

  await q(`UPDATE matches SET status='completed', winner_team=$2, completed_at=NOW() WHERE id=$1`, [
    m.id,
    winner,
  ]);
  await unpinMatchPins(telegram, groupId, m.id);
  if (m.mode === 'team') settleBets(telegram, groupId, m.id, winner).catch((e) => console.error('settleBets:', e.message));

  const { rows: inns } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [m.id]);
  let caption = `🏁 *${fancy(m.mode === 'test' ? 'TEST SERIES OVER' : 'MATCH OVER')}*\n${resultLine}\n`;
  for (const i of inns) {
    caption += `> Team ${i.batting_team}: *${i.total_runs}/${i.total_wickets}* (${oversStr(i.balls_bowled)} ov)\n`;
  }
  if (m.mode === 'test') {
    caption += `> Series: A *${m.day_wins_a || 0}* — *${m.day_wins_b || 0}* B\n`;
  }
  caption += `\n`;
  const aw = await matchAwards(m.id, winner);
  saveAwards(m.id, aw).catch((e) => console.error('saveAwards:', e.message));
  caption += `${awardsText(aw)}`;
  await sendTeamFinal(telegram, groupId, m, caption, { inns, winner, motm: aw.motm });
  sendWinVideo(telegram, groupId, m, winner === 'tie' ? null : winner).catch((e) => console.error('win video:', e.message));
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

// captain of a team as a tag (for "send your new batsman / bowler" prompts)
async function capTagOf(m, label) {
  try {
    const t = await getTeam(m.id, label);
    const p = t && t.captain_id ? await getPlayerByTg(m.id, t.captain_id) : null;
    return p ? mtag(p) : `Team ${label} captain`;
  } catch (_) {
    return `Team ${label} captain`;
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
    // innings finished exactly at the end of an over → graph of that last over
    if (!isSolo && inn2.balls_bowled > 0 && inn2.balls_bowled % 6 === 0) {
      await sendOverEnd(telegram, m, inn2, true).catch((e) => console.error('final over graph:', e.message));
    }

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
        await sendResultGif(telegram, groupId, 'batentry', undefined, newBatsmanCaption(st), st);
      }
    } else if (!isSolo && isWicket && !inn2.striker_player_id) {
      await telegram.sendMessage(
        groupId,
        `👑 ${await capTagOf(m, inn2.batting_team)} — send your *new batsman*: /bat <no.>`,
        { parse_mode: 'Markdown' }
      );
    }
    if (!isSolo && inn2.balls_bowled > 0 && inn2.balls_bowled % 6 === 0) {
      await sendOverEnd(telegram, m, inn2);
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
            await sendResultGif(telegram, groupId, 'bowlentry', undefined, newBowlerCaption(bw), bw);
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

// ─── Commentary language (group setting) ─────────────────
const langCache = new Map(); // chatId -> 'en'|'hi'
async function getGroupLang(chatId) {
  const k = String(chatId);
  if (langCache.has(k)) return langCache.get(k);
  try {
    const { rows } = await q(`SELECT commentary_lang FROM group_settings WHERE chat_id=$1`, [chatId]);
    const lang = rows[0]?.commentary_lang === 'hi' ? 'hi' : 'en';
    langCache.set(k, lang);
    return lang;
  } catch (_) {
    return 'en';
  }
}
async function setGroupLang(chatId, lang) {
  const l = lang === 'hi' ? 'hi' : 'en';
  await q(
    `INSERT INTO group_settings (chat_id, commentary_lang, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (chat_id) DO UPDATE SET commentary_lang=$2, updated_at=NOW()`,
    [chatId, l]
  );
  langCache.set(String(chatId), l);
  return l;
}

// Hindi commentary (fallback to English when a key is missing)
const COMMENT_HI = {
  '0': [
    'डॉट बॉल! दबाव बढ़ रहा है।',
    'मजबूत डिफेंस, कोई रन नहीं।',
    'टाइट लाइन — जीरो रन्स।',
    'ब्लॉक किया। स्कोरबोर्ड वहीं।',
    'डॉट! बॉलर जीता यह द्वंद्व।',
    'कोई रन नहीं — शुद्ध धैर्य।',
    'डॉट बॉल। दबाव जारी है।',
    'अच्छा बचाव, कुछ नहीं मिला।',
  ],
  '1': [
    'एक रन! स्मार्ट क्रिकेट।',
    'क्विक सिंगल लिया।',
    'एक रन, स्ट्राइक घुमाया।',
    'सॉफ्ट हैंड्स से एक रन।',
  ],
  '2': [
    'दो रन! अच्छी प्लेसमेंट।',
    'वे दो के लिए वापस आए।',
    'दो रन बोर्ड पर।',
  ],
  '3': [
    'तीन रन! शानदार रनिंग।',
    'तीन! उत्कृष्ट हसल।',
  ],
  '4': [
    'चार! बाउंड्री पर पहुंचा।',
    'FOUR! कवर के पार।',
    'चार रन! परफेक्ट टाइमिंग।',
    'बाउंड्री! कोई मौका नहीं।',
  ],
  '5': [
    'पांच रन! ओवरथ्रो का कहर।',
    'पांच! मिसफील्ड ने गिफ्ट दिया।',
  ],
  '6': [
    'छक्का! भीड़ में गया!',
    'मैक्सिमम! ग्राउंड से बाहर!',
    'छह रन! बिल्कुल रॉकेट।',
    'SIX! बॉलर सिर्फ देख सकता है।',
  ],
  'out': [
    'एक ही नंबर — OUT! बॉलर जीता।',
    'OUT! नंबर्स परफेक्ट मैच।',
    'विकेट! माइंड गेम खत्म।',
    'बोल्ड — एक ही नंबर!',
    'OUT! वापस जाना होगा।',
  ],
};

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
  const lang = await getGroupLang(groupId);
  const cmtPool = (lang === 'hi' ? COMMENT_HI : COMMENT)[isWicket ? 'out' : String(runs)]
    || COMMENT[isWicket ? 'out' : String(runs)]
    || COMMENT['0']
    || ['Nice ball.'];
  const cmt = pick(cmtPool);

  // milestones (each has its own /pgif GIF; the normal result GIF is the fallback)
  const strikerP = await getPlayer(strikerId);
  const nonP = nonId ? await getPlayer(nonId) : null;
  const { rows: bsr } = await q(`SELECT runs, balls_faced FROM batting_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, strikerId]);
  const afterRuns = Number(bsr[0]?.runs ?? 0);
  const afterBalls = Number(bsr[0]?.balls_faced ?? 0);
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
      // FIFTY video (pauses for 3s with the batsman's numbers) - rendered in the background, the game does not wait
      sendFiftyVideo(telegram, groupId, strikerP, afterRuns, afterBalls).catch((e) => console.error('fifty video:', e.message));
    }
    if (runs === 0) gifKeys.push('0', 'dot');
    else gifKeys.push(String(runs));
  }

  // Partnership card (team/test): 30, 50, 80, 100, then every 30 runs
  let partHit = null;
  if (!isSolo && !isWicket && nonP && strikerP) {
    try {
      const st = await partnershipStats(inn.id);
      const ms = crossedPartMilestone(st.total - runs, st.total);
      if (ms) partHit = { ms, st };
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
    const bowlerGif = isWicket && gifKeys.some((k) => ['hatrick', '5fer', '3w'].includes(k));
    await sendCaptionedGif(telegram, groupId, gifKeys, html, {
      reply_to_message_id: Number(batMsgId) || undefined,
      _gp: bowlerGif ? bowlerP : strikerP,
    });
  } catch (e) {
    console.error('result gif/text failed:', e.message);
    try {
      await telegram.sendMessage(groupId, stripPe(html), { parse_mode: 'HTML' });
    } catch (_) {}
  }

  if (partHit) {
    try {
      await sendPartnershipCard(telegram, groupId, partHit.ms, strikerP, nonP, partHit.st);
    } catch (e) {
      console.error('partnership card send:', e.message);
    }
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
    await unpinMatchPins(bot.telegram, groupId, m.id);
    refundBets(bot.telegram, groupId, m.id).catch((e) => console.error('refundBets:', e.message));
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
    `🏏 <b>${striker ? htag(striker) : 'Batsman'}</b> — <b>send your number ${hat ? '1–6' : '0–6'} in the group (${TURN_SECONDS}s)</b>` +
    (hat ? `\n🎩 <b>HAT-TRICK BALL! 0 is not allowed.</b>` : '');
  const lock = await sendCaptionedGif(bot.telegram, groupId, 'stance', html, { _gp: striker });
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
          await sendResultGif(tg, groupId, 'batentry', undefined, newBatsmanCaption(next), next);
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
          await sendResultGif(tg, groupId, 'bowlentry', undefined, newBowlerCaption(bw), bw);
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
  // Level formula kept similar; titles map to ranges. ~600 runs ≈ Club, ~5k ≈ International zone
  const level = Math.min(120, 1 + Math.floor((runs + wkts * 25 + matches * 10) / 100));
  const title =
    level >= 100 ? 'Legendary Cricketer' :
    level >= 50  ? 'Marquee Cricketer' :
    level >= 25  ? 'International Cricketer' :
    level >= 15  ? 'Domestic Cricketer' :
    level >= 6   ? 'Club Cricketer' :
                   'Street Cricketer';
  const [res, part, awards] = await Promise.all([
    userResults(id).catch(() => ({ w: 0, l: 0, d: 0, total: 0, streakType: '', streak: 0, bestStreak: 0, cap: { matches: 0, w: 0, l: 0 } })),
    userPartnership(id).catch(() => ({ runs: 0, partner: null })),
    userAwardCounts(id).catch(() => ({ orange: 0, purple: 0, motm: 0 })),
  ]);
  return {
    level,
    title,
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
function userRichHtml(t, shownName, c, withPhoto = false) {
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

  let h = withPhoto ? `<h1>${hEsc(shownName)}</h1><img src="tg://photo?id=card"/>` : `<p><b>🏏 STATS SUMMARY</b></p>`;
  h += `<p>👤 ${who}  ·  🆔 <code>${t.id}</code>  ·  📅 ${date}</p>`;
  h += tbl([
    ['⭐ Rank', `${c.title || 'Street Cricketer'} (Lv ${c.level})`],
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
    `⭐ *Rank:* ${career.title || 'Street Cricketer'} (Lv ${career.level})`
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
    let done = false;
    if (RICH_TABLES) {
      try {
        await sendRichPhoto(ctx.chat.id, userRichHtml(t, shown, career, true), img, ctx.message.message_id);
        done = true;
      } catch (e) {
        console.error('userinfo: photo-in-table failed, sending photo and table separately:', e.message);
      }
    }
    let photoSent = false;
    let tableOk = false;
    if (RICH_TABLES && !done) {
      try {
        await ctx.telegram.sendPhoto(ctx.chat.id, { source: img }, {
          caption: `📊 *${mdEsc(shown)}*  ·  ${mdEsc(career.title || 'Street Cricketer')} (Lv ${career.level})`,
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
    if (!done && !tableOk) {
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

// ═══ MATCH VIDEOS: "winning team" (after the result) and "FIFTY" (when a batsman crosses 50) ═══
const { spawn, spawnSync } = require('child_process');
const os = require('os');
const MATCH_VIDEOS = process.env.MATCH_VIDEOS !== '0'; // MATCH_VIDEOS=0 switches both videos off
const WIN_VIDEO = path.join(ASSET_DIR, 'win_team.mp4');
const FIFTY_VIDEO = path.join(ASSET_DIR, 'fifty.mp4');
const FIFTY_FREEZE_AT = 11.0; // the video pauses here ...
const FIFTY_FREEZE_SEC = 3; // ... for 3 seconds while the stats card is shown
const FIFTY_LEN = 22.07;
const FIFTY_VIDEO_F = path.join(ASSET_DIR, 'fifty_female.mp4'); // played for female batsmen
const FIFTY_F_FREEZE_AT = 8.0; // helmet-raise celebration
const FIFTY_F_LEN = 39.3;

let ffmpegCache;
function ffmpegBin() {
  if (ffmpegCache !== undefined) return ffmpegCache;
  const cands = [process.env.FFMPEG_PATH];
  for (const mod of ['ffmpeg-static', '@ffmpeg-installer/ffmpeg']) {
    try {
      const r = require(mod);
      cands.push(typeof r === 'string' ? r : r && r.path);
    } catch (_) {}
    try {
      const r = require(path.join(__dirname, 'node_modules', mod));
      cands.push(typeof r === 'string' ? r : r && r.path);
    } catch (_) {}
  }
  cands.push('ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/render/project/.render/ffmpeg/ffmpeg');
  for (const c of cands.filter(Boolean)) {
    try {
      const r = spawnSync(c, ['-version'], { timeout: 8000 });
      if (r.status === 0) return (ffmpegCache = c);
    } catch (_) {}
  }
  return (ffmpegCache = null);
}
// No ffmpeg on the host? Install the bundled one once (npm i ffmpeg-static) - the bot does it by itself.
let ffmpegInstalling = null;
function ensureFfmpeg() {
  if (ffmpegBin()) return Promise.resolve(true);
  if (ffmpegInstalling) return ffmpegInstalling;
  ffmpegInstalling = new Promise((resolve) => {
    console.log('ffmpeg not found - installing ffmpeg-static (one time, can take a minute)...');
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      ffmpegInstalling = null;
      resolve(ok);
    };
    try {
      const pr = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', 'ffmpeg-static', '--no-save', '--no-audit', '--no-fund', '--loglevel', 'error'], { cwd: __dirname });
      let err = '';
      const timer = setTimeout(() => {
        try {
          pr.kill('SIGKILL');
        } catch (_) {}
      }, 6 * 60 * 1000);
      pr.stderr.on('data', (d) => (err += d));
      pr.on('error', (e) => {
        clearTimeout(timer);
        console.error('npm could not start:', e.message);
        finish(false);
      });
      pr.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          console.error('ffmpeg-static install failed:', err.slice(-300));
          return finish(false);
        }
        try {
          Object.keys(require.cache).forEach((k) => /ffmpeg-static/.test(k) && delete require.cache[k]);
        } catch (_) {}
        ffmpegCache = undefined;
        const ok = !!ffmpegBin();
        console.log(ok ? 'ffmpeg ready' : 'ffmpeg-static installed but the binary does not run here');
        finish(ok);
      });
    } catch (e) {
      console.error('ffmpeg install error:', e.message);
      finish(false);
    }
  });
  return ffmpegInstalling;
}
async function runFfmpeg(args, timeoutMs = 300000) {
  let bin = ffmpegBin();
  if (!bin) {
    await ensureFfmpeg();
    bin = ffmpegBin();
  }
  if (!bin) throw new Error('ffmpeg not found on this host (the bot tried `npm i ffmpeg-static` - see the logs)');
  const once = (a) =>
    new Promise((resolve, reject) => {
      const pr = spawn(bin, ['-y', '-loglevel', 'error', '-threads', '2', ...a]);
      let err = '';
      const timer = setTimeout(() => {
        pr.kill('SIGKILL');
        reject(new Error('ffmpeg timeout'));
      }, timeoutMs);
      pr.stderr.on('data', (d) => (err += d));
      pr.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      pr.on('close', (code) => {
        clearTimeout(timer);
        code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.slice(-400)));
      });
    });
  try {
    return await once(args);
  } catch (e) {
    if (!/Unknown encoder|libx264|Encoder/i.test(String(e.message))) throw e;
    // this ffmpeg has no libx264: use the built-in mpeg4 encoder instead
    const a2 = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-c:v' && args[i + 1] === 'libx264') {
        a2.push('-c:v', 'mpeg4', '-q:v', '5');
        i++;
      } else if (args[i] === '-preset' || args[i] === '-crf') i++;
      else a2.push(args[i]);
    }
    return once(a2);
  }
}
// tell the bot owner (once) why a video could not be rendered
const ownerNotified = new Set();
async function notifyOwnerOnce(key, text) {
  try {
    if (ownerNotified.has(key)) return;
    ownerNotified.add(key);
    const id = Number(process.env.BOT_OWNER_ID);
    if (id) await bot.telegram.sendMessage(id, `⚠️ ${text}`.slice(0, 3800));
  } catch (_) {}
}
// one video render at a time (they are CPU heavy) - the game itself never waits for them
let videoChain = Promise.resolve();
const queueVideo = (fn) => {
  const run = videoChain.then(fn, fn);
  videoChain = run.catch(() => {});
  return run;
};
const encodeArgs = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '27', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart'];

async function renderWinVideo(capName, names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmv-'));
  try {
    const ov = path.join(dir, 'ov.png');
    const out = path.join(dir, 'out.mp4');
    const overlayBuf = await buildWinOverlay(capName, names);
    fs.writeFileSync(ov, overlayBuf);
    // Force both streams to 1280x720 so CAP/player text always lands on the template boxes
    const filter =
      '[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1[base];' +
      '[1:v]format=rgba,scale=1280:720[ov];' +
      '[base][ov]overlay=0:0:shortest=1[v]';
    await runFfmpeg([
      '-i', WIN_VIDEO,
      '-framerate', '30',
      '-loop', '1',
      '-i', ov,
      '-filter_complex', filter,
      '-map', '[v]',
      '-map', '0:a?',
      ...encodeArgs,
      '-shortest',
      out,
    ]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function renderFiftyVideo(card, female = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmv-'));
  try {
    const ov = path.join(dir, 'ov.png');
    const out = path.join(dir, 'out.mp4');
    fs.writeFileSync(ov, await buildFiftyOverlay(card));
    const T = female ? FIFTY_F_FREEZE_AT : FIFTY_FREEZE_AT;
    const D = FIFTY_FREEZE_SEC;
    const srcFile = female ? FIFTY_VIDEO_F : FIFTY_VIDEO;
    const vLen = female ? FIFTY_F_LEN : FIFTY_LEN;
    const filter =
      `[0:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,setsar=1,split=2[s1][s2];` +
      `[s1]trim=0:${T},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${D}[v1];` +
      `[s2]trim=start=${T},setpts=PTS-STARTPTS[v2];` +
      `[v1][v2]concat=n=2:v=1:a=0[vc];` +
      `[vc]eq=brightness=-0.14:enable='between(t,${T},${T + D})'[vd];` +
      `[1:v]format=rgba,fade=t=in:st=${T}:d=0.35:alpha=1,fade=t=out:st=${T + D - 0.35}:d=0.35:alpha=1[ovf];` +
      `[vd][ovf]overlay=0:0:enable='between(t,${T},${T + D})'[v];` +
      `[0:a]atrim=0:${T},asetpts=PTS-STARTPTS,apad=pad_dur=${D}[a1];` +
      `[0:a]atrim=start=${T},asetpts=PTS-STARTPTS[a2];` +
      `[a1][a2]concat=n=2:v=0:a=1[a]`;
    await runFfmpeg(['-i', srcFile, '-framerate', '30', '-loop', '1', '-i', ov, '-filter_complex', filter, '-map', '[v]', '-map', '[a]', ...encodeArgs, '-t', String(vLen + D), out]);
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const sendVideoBuf = (telegram, chatId, buf, caption) =>
  telegram.sendVideo(chatId, { source: buf, filename: 'cricmonster.mp4' }, { caption, parse_mode: 'Markdown', supports_streaming: true, width: 1280, height: 720 });
const sendVideoFile = (telegram, chatId, file, caption) =>
  telegram.sendVideo(chatId, { source: fs.createReadStream(file) }, { caption, parse_mode: 'Markdown', supports_streaming: true, width: 1280, height: 720 });

// after the result: video with the winning captain + players
async function sendWinVideo(telegram, groupId, m, label) {
  if (!MATCH_VIDEOS || !label || label === 'tie' || !fs.existsSync(WIN_VIDEO)) return;
  const players = await getPlayers(m.id, label);
  const team = await getTeam(m.id, label);
  const capP = team && team.captain_id ? players.find((p) => Number(p.telegram_id) === Number(team.captain_id)) : null;
  const capName = capP ? videoName(capP) : '';
  let listNames = players.filter((p) => !capP || p.id !== capP.id).map(videoName);
  if (!listNames.length) listNames = players.map(videoName);
  const caption = `🏆 *Congratulations Team ${label}!*`;
  try {
    const buf = await queueVideo(() => renderWinVideo(capName || listNames[0] || '', listNames));
    await sendVideoBuf(telegram, groupId, buf, caption);
  } catch (e) {
    console.error('win video failed, sending the plain video:', e.message);
    notifyOwnerOnce('win', `Winning-team video: names could not be put on the video.\n${e.message}`);
    const lines =
      (capName ? `👑 *${mdEsc(capName)}*\n` : '') +
      listNames.map((n, i) => `${i + 1}. ${mdEsc(n)}`).join('\n');
    await sendVideoFile(telegram, groupId, WIN_VIDEO, `${caption}\n${lines}`.slice(0, 1000)).catch((e2) =>
      console.error('plain win video failed:', e2.message)
    );
  }
}

// batsman crossed 50: the video pauses in the middle for 3 seconds and shows his numbers
async function sendFiftyVideo(telegram, groupId, p, runs, balls) {
  const female = genderOf(p?.telegram_id) === 'F' && fs.existsSync(FIFTY_VIDEO_F);
  const srcVideo = female ? FIFTY_VIDEO_F : FIFTY_VIDEO;
  if (!MATCH_VIDEOS || !p || isBotId(p.telegram_id) || !fs.existsSync(srcVideo)) return;
  const name = videoName(p);
  const sr = balls > 0 ? ((runs * 100) / balls).toFixed(2) : '0.00';
  const caption = `🏏 *${mdEsc(name)}* — *${runs}* (${balls})  ·  SR ${sr}`;
  try {
    const buf = await queueVideo(() => renderFiftyVideo({ name, runs, balls }, female));
    await sendVideoBuf(telegram, groupId, buf, caption);
  } catch (e) {
    console.error('fifty video failed, sending the plain video:', e.message);
    notifyOwnerOnce('fifty', `Fifty video: names could not be put on the video.\n${e.message}`);
    await sendVideoFile(telegram, groupId, srcVideo, caption).catch((e2) => console.error('plain fifty video failed:', e2.message));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// r49 — GENDER · /fgif · /tgif · TEAM NAMES · BETTING · LEADERBOARD · OVER GRAPH · PARTNERSHIP CARD
// ═══════════════════════════════════════════════════════════════════════════

// ── user gender (DM /start asks Male / Female) ──
const genderCache = new Map(); // telegram_id -> 'M' | 'F'
const genderOf = (id) => (id === null || id === undefined ? null : genderCache.get(String(id)) || null);
function genderMark(id) {
  const g = genderOf(id);
  return g === 'F' ? ' ♀️' : g === 'M' ? ' ♂️' : '';
}
async function setGender(id, g) {
  await q(
    `INSERT INTO user_gender (telegram_id, gender, updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (telegram_id) DO UPDATE SET gender=EXCLUDED.gender, updated_at=NOW()`,
    [id, g]
  );
  genderCache.set(String(id), g);
}

// shortened display name: first+last name → @username → id. Long names are cut (…)
function shortName(p, max = 16) {
  if (!p) return 'Player';
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
  let base = full || (p.username ? `@${p.username}` : String(p.telegram_id ?? p.id ?? 'Player'));
  if (base.length > max) base = base.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
  return base + genderMark(p.telegram_id);
}

const genderKb = () =>
  Markup.inlineKeyboard([[btn('𝗠𝗔𝗟𝗘', 'g:M', 'male', 'primary'), btn('𝗙𝗘𝗠𝗔𝗟𝗘', 'g:F', 'female', 'danger')]]);

async function askGender(ctx) {
  return ctx.reply(
    `👋 *Welcome to CRIC MONSTER!*\n\n` +
      `First select your gender — it decides your *GIFs* and name badge in matches.\n` +
      `You can change it later with /gender\n\n` +
      `Tap one below 👇`,
    { parse_mode: 'Markdown', ...genderKb() }
  );
}

bot.command('gender', async (ctx) => {
  if (ctx.chat?.type === 'private') return askGender(ctx);
  const g = genderOf(ctx.from.id);
  const url = `https://t.me/${BOT_USERNAME}?start=gender`;
  return ctx.reply(
    g
      ? `Your gender is *${g === 'F' ? 'Female' : 'Male'}*. To change it, open the bot DM:`
      : `Select your gender in the bot DM (needed for GIFs):`,
    { parse_mode: 'Markdown', reply_to_message_id: ctx.message?.message_id, ...Markup.inlineKeyboard([[ubtn('𝗢𝗣𝗘𝗡 𝗕𝗢𝗧 𝗗𝗠', url, 'point', 'primary')]]) }
  );
});

bot.action(/^g:(M|F)$/, async (ctx) => {
  const g = ctx.match[1];
  try {
    await upsertUser(ctx.from);
    await setGender(ctx.from.id, g);
  } catch (e) {
    console.error('setGender', e.message);
    return ctx.answerCbQuery('Could not save, try again', { show_alert: true }).catch(() => {});
  }
  await ctx.answerCbQuery(g === 'F' ? 'Female selected' : 'Male selected').catch(() => {});
  try {
    await ctx.editMessageText(
      `✅ Gender saved: *${g === 'F' ? 'FEMALE ♀️' : 'MALE ♂️'}*\nYour GIFs and name badge are set. Change anytime with /gender`,
      { parse_mode: 'Markdown' }
    );
  } catch (_) {}
  if (ctx.chat?.type === 'private') await sendWelcome(ctx).catch(() => {});
  notifyGenderPending(ctx.telegram, ctx.from.id).catch((e) => console.error('gender notify:', e.message));
});

// someone selected a gender while a team match is running → tell the captain(s) in English
const genderNagAt = new Map();
async function notifyGenderPending(telegram, userId) {
  const { rows: ms } = await q(
    `SELECT DISTINCT m.id FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.telegram_id=$1 AND m.mode IN ('team','test') AND m.status NOT IN ('completed','cancelled')`,
    [userId]
  );
  for (const r of ms) {
    const m = await getMatch(r.id);
    if (!m) continue;
    const k = String(m.id);
    if (Date.now() - (genderNagAt.get(k) || 0) < 60000) continue;
    const players = (await getPlayers(m.id)).filter((p) => !isBotId(p.telegram_id) && !genderOf(p.telegram_id));
    if (!players.length) continue;
    genderNagAt.set(k, Date.now());
    let t = '';
    for (const label of ['A', 'B']) {
      const pend = players.filter((p) => p.team_label === label);
      if (!pend.length) continue;
      const shown = pend.slice(0, 8).map((p) => mdEsc(shortName(p, 14))).join(', ') + (pend.length > 8 ? ` +${pend.length - 8}` : '');
      t +=
        `👑 ${await capTagOf(m, label)} — please first tell your players to *start the bot* and select */gender* for GIFs.\n` +
        `> ⏳ Pending (Team ${label}): ${shown}\n\n`;
    }
    if (t) await telegram.sendMessage(Number(m.group_chat_id), t.trim(), { parse_mode: 'Markdown' });
  }
}

// ── GIF routing: test GIFs (t:) → female GIFs (f:) → default GIFs ──
const testChatCache = new Map(); // chatId -> { v, at }
async function isTestChat(chatId) {
  const hit = testChatCache.get(String(chatId));
  if (hit && Date.now() - hit.at < 10000) return hit.v;
  let v = false;
  try {
    const m = await getActiveMatch(chatId);
    v = !!m && m.mode === 'test';
  } catch (_) {}
  testChatCache.set(String(chatId), { v, at: Date.now() });
  return v;
}
async function expandGifKeys(keys, chatId, gp) {
  const list = Array.isArray(keys) ? keys : [keys];
  const out = [];
  if (await isTestChat(chatId)) for (const k of list) out.push('t:' + k);
  const gid = gp ? gp.telegram_id ?? null : null;
  if (gid !== null && genderOf(gid) === 'F') for (const k of list) out.push('f:' + k);
  for (const k of list) out.push(k);
  return out;
}

// /fgif (female) and /tgif (test) — same keys as /pgif
function registerGifSet(pre, c, label) {
  const keyOf = (raw) => {
    const rk = String(raw || '').toLowerCase();
    const key = PGIF_ALIASES[rk] || rk;
    return PGIF_KEYS.has(key) ? key : null;
  };
  const usage =
    `${label} GIFs — reply to a GIF with:\n/${c}gif <key>\n\n` +
    `Keys: 0 1 2 3 4 5 6 · out · dugout · stance · runup · batentry · bowlentry · starter · opener · toss · 50 · 100 · 150 · 200 · 3w · 5fer · hatrick · motm\n\n` +
    `Remove: /rm${c}gif <key>   (or /${c}gif remove <key>)\nShow all: /show${c}gif\nList: /${c}giflist`;
  const deny = '❌ Only a group admin or the bot owner can do this.';

  async function removeKey(ctx, raw) {
    const key = keyOf(raw);
    if (!key) return ctx.reply(`Usage: /rm${c}gif <key>\nExample: /rm${c}gif 50\nSee: /${c}giflist`);
    const leg = PGIF_LEGACY[key];
    const { rowCount } = await q(`DELETE FROM public.pgif_settings WHERE result_key = $1 OR result_key = $2`, [pre + key, pre + (leg || key)]);
    if (!rowCount) return ctx.reply(`❌ No ${label.toLowerCase()} GIF saved for ${key}`);
    return ctx.reply(`🗑️ Removed ${label.toLowerCase()} GIF for ${PGIF_LABELS[key] || key} (${key})`);
  }
  async function listKeys(ctx) {
    const { rows } = await q(`SELECT result_key FROM public.pgif_settings WHERE result_key LIKE $1`, [pre + '%']);
    const have = new Set(rows.map((r) => r.result_key.slice(pre.length)));
    let t = '';
    let n = 0;
    for (const key of PGIF_LIST_ORDER) {
      const leg = PGIF_LEGACY[key];
      const ok = have.has(key) || (leg && have.has(leg));
      if (ok) n++;
      t += `${ok ? '✅' : '❌'} ${PGIF_LABELS[key] || key} — /${c}gif ${key}\n`;
    }
    return ctx.reply(`🎞️ ${label.toUpperCase()} GIF LIST (${n}/${PGIF_LIST_ORDER.length})\n\n${t}\nSet: reply to a GIF with /${c}gif <key>\nRemove: /rm${c}gif <key> · Show: /show${c}gif`);
  }
  async function showAll(ctx) {
    const { rows } = await q(`SELECT result_key, file_id, media_type FROM public.pgif_settings WHERE result_key LIKE $1 ORDER BY result_key`, [pre + '%']);
    if (!rows.length) return ctx.reply(`❌ No ${label.toLowerCase()} GIFs saved yet. Reply to a GIF with /${c}gif <key>`);
    await ctx.reply(`🎞️ Showing ${rows.length} ${label.toLowerCase()} GIF(s)…`);
    for (const r of rows) {
      const key = r.result_key.slice(pre.length);
      try {
        await sendGifFile(ctx.telegram, ctx.chat.id, r, { caption: `${label}: ${PGIF_LABELS[key] || key} (${key})` });
      } catch (e) {
        await ctx.reply(`⚠️ ${key}: could not send (${String(e.message).slice(0, 80)})`);
      }
    }
  }

  bot.command(`${c}gif`, async (ctx) => {
    try {
      const parts = String(ctx.message?.text || '').trim().split(/\s+/);
      const sub = String(parts[1] || '').toLowerCase();
      if (!(await canConfigurePgif(ctx))) return ctx.reply(deny);
      if (['remove', 'rm', 'delete', 'del'].includes(sub)) return removeKey(ctx, parts[2]);
      if (sub === 'list') return listKeys(ctx);
      if (sub === 'show') return showAll(ctx);
      const key = keyOf(sub);
      if (!key) return ctx.reply(usage);
      const replied = ctx.message?.reply_to_message;
      if (!replied) return ctx.reply(`❌ Reply to the GIF message with /${c}gif ${key}`);
      let fileId = replied.animation?.file_id || null;
      let mediaType = 'animation';
      if (!fileId && replied.document) {
        const mime = String(replied.document.mime_type || '').toLowerCase();
        if (mime === 'image/gif' || mime.startsWith('video/')) {
          fileId = replied.document.file_id;
          mediaType = 'document';
        }
      }
      if (!fileId && replied.video) {
        fileId = replied.video.file_id;
        mediaType = 'video';
      }
      if (!fileId) return ctx.reply('❌ No GIF/animation found in the replied message. Send the GIF in the group, then reply to it.');
      await q(
        `INSERT INTO public.pgif_settings (result_key, file_id, media_type, updated_by, updated_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (result_key) DO UPDATE SET file_id=EXCLUDED.file_id, media_type=EXCLUDED.media_type,
           updated_by=EXCLUDED.updated_by, updated_at=NOW()`,
        [pre + key, fileId, mediaType, String(ctx.from.id)]
      );
      return ctx.reply(`✅ ${label} GIF saved for ${PGIF_LABELS[key] || key + ' RUN' + (key === '1' ? '' : 'S')}!\n` +
        (pre === 'f:' ? 'Female players will now get this GIF.' : 'It appears only in Test matches.'));
    } catch (e) {
      console.error(`${c}gif error:`, e);
      try { await ctx.reply('❌ Could not save the GIF: ' + String(e.message || e).slice(0, 250)); } catch (_) {}
    }
  });
  bot.command([`rm${c}gif`, `un${c}gif`, `del${c}gif`], async (ctx) => {
    try {
      if (!(await canConfigurePgif(ctx))) return ctx.reply(deny);
      return await removeKey(ctx, String(ctx.message?.text || '').trim().split(/\s+/)[1]);
    } catch (e) { console.error(`rm${c}gif`, e); }
  });
  bot.command(`show${c}gif`, async (ctx) => {
    try {
      if (!(await canConfigurePgif(ctx))) return ctx.reply(deny);
      return await showAll(ctx);
    } catch (e) { console.error(`show${c}gif`, e); }
  });
  bot.command(`${c}giflist`, async (ctx) => {
    try { return await listKeys(ctx); } catch (e) { console.error(`${c}giflist`, e); }
  });
}
registerGifSet('f:', 'f', 'Female');
registerGifSet('t:', 't', 'Test');

// ── optional team names (button after the toss, or /teamname) ──
const cleanTeamName = (s) =>
  String(s || '').replace(/[<>&*_`\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
async function teamNameOf(matchId, label) {
  try {
    const t = await getTeam(matchId, label);
    return t && t.team_name ? t.team_name : `Team ${label}`;
  } catch (_) {
    return `Team ${label}`;
  }
}
async function sendTeamNamePrompt(telegram, m) {
  await telegram.sendMessage(
    Number(m.group_chat_id),
    `🏷 *TEAM NAMES* _(optional)_\n> Captains can set a team name — used in graphs, partnership cards and bets.\n> Skip it and the match works as *Team A / Team B*.`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [btn('𝗦𝗘𝗧 𝗧𝗘𝗔𝗠 𝗔 𝗡𝗔𝗠𝗘', `tn:${m.id}:A`, 'flag', 'primary'), btn('𝗦𝗘𝗧 𝗧𝗘𝗔𝗠 𝗕 𝗡𝗔𝗠𝗘', `tn:${m.id}:B`, 'flag', 'danger')],
      ]),
    }
  );
}
bot.action(/^tn:(.+):(A|B)$/, async (ctx) => {
  try {
    const m = await getMatch(ctx.match[1]);
    const label = ctx.match[2];
    if (!m || ['completed', 'cancelled'].includes(m.status)) return ctx.answerCbQuery('Match is not active', { show_alert: true });
    const team = await getTeam(m.id, label);
    const isCap = Number(team?.captain_id) === ctx.from.id;
    const isHost = Number(m.host_telegram_id) === ctx.from.id;
    if (!isCap && !isHost) return ctx.answerCbQuery(`Only the Team ${label} captain (or host) can set this`, { show_alert: true });
    pendingTeamName.set(`${ctx.chat.id}:${ctx.from.id}`, { matchId: m.id, label, at: Date.now() });
    await ctx.answerCbQuery('Now type the team name');
    await ctx.telegram.sendMessage(
      ctx.chat.id,
      `✏️ [${mdEsc(ctx.from.first_name || 'Captain')}](tg://user?id=${ctx.from.id}) — send the *Team ${label}* name now _(max 20 characters)_.`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error('tn action', e.message);
    ctx.answerCbQuery('Error').catch(() => {});
  }
});
bot.command(['teamname', 'setteamname'], async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this in the match group');
  const m = await getActiveMatch(ctx.chat.id);
  if (!m || !['team', 'test'].includes(m.mode)) return ctx.reply('❌ No team match running here.');
  const args = String(ctx.message.text || '').split(/\s+/).slice(1);
  let label = null;
  if (/^[abAB]$/.test(args[0] || '')) label = args.shift().toUpperCase();
  const nm = cleanTeamName(args.join(' '));
  const me = await getPlayerByTg(m.id, ctx.from.id);
  const isHost = Number(m.host_telegram_id) === ctx.from.id;
  if (!label) {
    const ta = await getTeam(m.id, 'A');
    const tb = await getTeam(m.id, 'B');
    label = Number(ta?.captain_id) === ctx.from.id ? 'A' : Number(tb?.captain_id) === ctx.from.id ? 'B' : me?.team_label || null;
  }
  if (!label) return ctx.reply('Usage: /teamname <name>  (captain)  ·  host: /teamname a <name>');
  const team = await getTeam(m.id, label);
  if (Number(team?.captain_id) !== ctx.from.id && !isHost) return ctx.reply(`❌ Only the Team ${label} captain or the host can set the name.`);
  if (!nm) return ctx.reply('Usage: /teamname <name>  (max 20 characters)');
  await q(`UPDATE match_teams SET team_name=$3 WHERE match_id=$1 AND team_label=$2`, [m.id, label, nm]);
  return ctx.reply(`✅ Team ${label} is now *${mdEsc(nm)}*`, { parse_mode: 'Markdown' });
});

// ═══ WALLET + LIVE BETTING (team matches) ═══
const START_COINS = 1000;
const DAILY_COINS = 500;
const BET_MIN = 10;
const BET_MAX = 10000;
const fmtCoins = (n) => Number(n || 0).toLocaleString('en-US');

async function walletOf(id) {
  await q(`INSERT INTO wallets (telegram_id, coins) VALUES ($1,$2) ON CONFLICT (telegram_id) DO NOTHING`, [id, START_COINS]);
  const { rows } = await q(`SELECT coins, last_daily FROM wallets WHERE telegram_id=$1`, [id]);
  return rows[0];
}

// live win-probability → decimal odds (1.50x, 2.30x …), 7% margin
async function liveOdds(m) {
  const { rows: inns } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [m.id]);
  const inn = inns[inns.length - 1];
  if (!inn) return null;
  const overs = Number(m.total_overs) || DEFAULT_OVERS;
  const maxBalls = overs * 6;
  const batSide = await getPlayers(m.id, inn.batting_team);
  const maxW = Math.max(1, batSide.length - 1);
  const r = Number(inn.total_runs) || 0;
  const b = Number(inn.balls_bowled) || 0;
  const w = Number(inn.total_wickets) || 0;
  const prior = 6.5; // runs per over
  const crr = b > 0 ? (r * 6) / b : prior;
  const wgt = Math.min(1, b / 18);
  const rate = Math.max(1.5, (crr * wgt + prior * (1 - wgt)) * (1 - 0.55 * (w / maxW)));
  let pBat;
  if (Number(inn.innings_number) === 1 || !m.target) {
    const exp = r + ((maxBalls - b) * rate) / 6;
    const par = overs * prior;
    pBat = 1 / (1 + Math.exp(-(exp - par) / (par * 0.3)));
    pBat = Math.min(0.78, Math.max(0.22, pBat));
  } else {
    const need = Number(m.target) - r;
    const left = maxBalls - b;
    if (need <= 0) pBat = 0.98;
    else if (left <= 0 || w >= maxW) pBat = 0.02;
    else {
      const expAdd = (left * rate) / 6;
      pBat = 1 / (1 + Math.exp(-(expAdd - need) / Math.max(6, need * 0.2)));
      if (need > left * 6) pBat = Math.min(pBat, 0.02);
      pBat = Math.min(0.97, Math.max(0.03, pBat));
    }
  }
  const pA = inn.batting_team === 'A' ? pBat : 1 - pBat;
  const mk = (p) => ({ p, odds: Math.round(Math.min(15, Math.max(1.05, 0.93 / p)) * 100) / 100 });
  return { A: mk(pA), B: mk(1 - pA), inn };
}

function bettingOpen(m) {
  return !!m && m.mode === 'team' && ['innings1', 'innings2'].includes(m.status);
}

async function resolveBetTeam(m, text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return 'A'; // default team A
  if (['a', 'team a', 'teama', 'team_a'].includes(t)) return 'A';
  if (['b', 'team b', 'teamb', 'team_b'].includes(t)) return 'B';
  const na = (await teamNameOf(m.id, 'A')).toLowerCase();
  const nb = (await teamNameOf(m.id, 'B')).toLowerCase();
  if (t === na) return 'A';
  if (t === nb) return 'B';
  const sa = na.startsWith(t);
  const sb = nb.startsWith(t);
  if (sa && !sb) return 'A';
  if (sb && !sa) return 'B';
  return null;
}

async function placeBet(telegram, user, m, label, amount) {
  const fresh = await getMatch(m.id);
  if (!bettingOpen(fresh)) return { err: 'Betting is closed for this match.' };
  const od = await liveOdds(fresh);
  if (!od) return { err: 'Odds are not ready yet.' };
  await upsertUser(user).catch(() => {});
  await walletOf(user.id);
  const upd = await q(
    `UPDATE wallets SET coins = coins - $2, updated_at = NOW() WHERE telegram_id=$1 AND coins >= $2 RETURNING coins`,
    [user.id, amount]
  );
  if (!upd.rowCount) {
    const w = await walletOf(user.id);
    return { err: `Not enough coins. Balance: ${fmtCoins(w.coins)} 🪙  ·  claim /daily` };
  }
  const odds = od[label].odds;
  await q(
    `INSERT INTO bets (match_id, chat_id, telegram_id, team, amount, odds) VALUES ($1,$2,$3,$4,$5,$6)`,
    [String(fresh.id), Number(fresh.group_chat_id), user.id, label, amount, odds]
  );
  return { ok: true, odds, balance: Number(upd.rows[0].coins) };
}

async function betReply(m, user, res, label, amount) {
  const tn = await teamNameOf(m.id, label);
  if (res.err) return `❌ ${res.err}`;
  return (
    `🎰 *BET PLACED*\n` +
    `> 👤 ${mdEsc(shortName({ first_name: user.first_name, last_name: user.last_name, username: user.username, telegram_id: user.id }, 18))}\n` +
    `> 🏏 Team *${label}* — ${mdEsc(tn)}\n` +
    `> 🪙 Stake *${fmtCoins(amount)}* @ *${res.odds.toFixed(2)}x*\n` +
    `> 💰 Win → *${fmtCoins(Math.floor(amount * res.odds))}* 🪙\n` +
    `> 🏦 Balance: *${fmtCoins(res.balance)}*`
  );
}

bot.command('bet', async (ctx) => {
  try {
    if (!isGroup(ctx)) return ctx.reply('❌ Bets are placed in the match group.');
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'team') return ctx.reply('❌ Betting works in a live *Team* match only.', { parse_mode: 'Markdown' });
    if (!bettingOpen(m)) return ctx.reply('⏳ Betting opens when the match starts (after the toss and overs are set).');
    const args = String(ctx.message.text || '').split(/\s+/).slice(1);
    let amount = null;
    const rest = [];
    for (const a of args) {
      if (amount === null && (/^\d+$/.test(a) || a.toLowerCase() === 'all')) amount = a.toLowerCase() === 'all' ? -1 : parseInt(a, 10);
      else rest.push(a);
    }
    if (amount === null) {
      return ctx.reply(
        `🎰 *HOW TO BET*\n> /bet 100 a — 100 on Team A\n> /bet 200 b — 200 on Team B\n> /bet 150 <team name>\n> /bet 100 — default Team A\n> Odds: /odds · Wallet: /wallet · Bonus: /daily`,
        { parse_mode: 'Markdown' }
      );
    }
    const label = await resolveBetTeam(m, rest.join(' '));
    if (!label) return ctx.reply('❌ Team not found. Use a / b or the exact team name.');
    if (amount === -1) amount = Math.min(BET_MAX, Number((await walletOf(ctx.from.id)).coins));
    if (amount < BET_MIN) return ctx.reply(`❌ Minimum bet is ${BET_MIN} 🪙`);
    if (amount > BET_MAX) return ctx.reply(`❌ Maximum bet is ${fmtCoins(BET_MAX)} 🪙`);
    const res = await placeBet(ctx.telegram, ctx.from, m, label, amount);
    return ctx.reply(await betReply(m, ctx.from, res, label, amount), { parse_mode: 'Markdown', reply_to_message_id: ctx.message.message_id });
  } catch (e) {
    console.error('bet', e);
    ctx.reply('❌ Bet failed: ' + String(e.message || e).slice(0, 120)).catch(() => {});
  }
});

const oddsKb = (id) =>
  Markup.inlineKeyboard([
    [btn('𝗔 · 𝟭𝟬𝟬', `bt:${id}:A:100`, 'money', 'primary'), btn('𝗕 · 𝟭𝟬𝟬', `bt:${id}:B:100`, 'money', 'danger')],
    [btn('𝗔 · 𝟱𝟬𝟬', `bt:${id}:A:500`, 'coin', 'primary'), btn('𝗕 · 𝟱𝟬𝟬', `bt:${id}:B:500`, 'coin', 'danger')],
  ]);

bot.command('odds', async (ctx) => {
  try {
    if (!isGroup(ctx)) return ctx.reply('❌ Use this in the match group.');
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'team') return ctx.reply('❌ No live team match here.');
    if (!bettingOpen(m)) return ctx.reply('⏳ Odds appear once the match starts.');
    const od = await liveOdds(m);
    if (!od) return ctx.reply('⏳ Odds are not ready yet.');
    const na = await teamNameOf(m.id, 'A');
    const nb = await teamNameOf(m.id, 'B');
    return ctx.reply(
      `📈 *LIVE ODDS*\n` +
        `> 🅰 *${mdEsc(na)}* — *${od.A.odds.toFixed(2)}x* (${Math.round(od.A.p * 100)}%)\n` +
        `> 🅱 *${mdEsc(nb)}* — *${od.B.odds.toFixed(2)}x* (${Math.round(od.B.p * 100)}%)\n` +
        `> Score: *${od.inn.total_runs}/${od.inn.total_wickets}* (${oversStr(od.inn.balls_bowled)} ov)\n\n` +
        `Bet: /bet 100 a · /bet 200 b · /bet 100 <team name>`,
      { parse_mode: 'Markdown', ...oddsKb(m.id) }
    );
  } catch (e) { console.error('odds', e.message); }
});

bot.action(/^bt:(.+):(A|B):(\d+)$/, async (ctx) => {
  try {
    const m = await getMatch(ctx.match[1]);
    const label = ctx.match[2];
    const amount = parseInt(ctx.match[3], 10);
    if (!bettingOpen(m)) return ctx.answerCbQuery('Betting is closed', { show_alert: true });
    const res = await placeBet(ctx.telegram, ctx.from, m, label, amount);
    if (res.err) return ctx.answerCbQuery(res.err.slice(0, 190), { show_alert: true });
    await ctx.answerCbQuery(`Bet placed @ ${res.odds.toFixed(2)}x`);
    await ctx.telegram.sendMessage(Number(m.group_chat_id), await betReply(m, ctx.from, res, label, amount), { parse_mode: 'Markdown' });
  } catch (e) {
    console.error('bt action', e.message);
    ctx.answerCbQuery('Bet failed').catch(() => {});
  }
});

bot.command(['wallet', 'balance', 'coins'], async (ctx) => {
  const w = await walletOf(ctx.from.id);
  return ctx.reply(`🏦 *WALLET*\n> 🪙 Coins: *${fmtCoins(w.coins)}*\n> Bonus: /daily (+${DAILY_COINS})`, { parse_mode: 'Markdown' });
});
bot.command('daily', async (ctx) => {
  await walletOf(ctx.from.id);
  const { rows } = await q(
    `UPDATE wallets SET coins = coins + $2, last_daily = NOW(), updated_at = NOW()
      WHERE telegram_id=$1 AND (last_daily IS NULL OR last_daily < NOW() - INTERVAL '24 hours') RETURNING coins`,
    [ctx.from.id, DAILY_COINS]
  );
  if (!rows.length) return ctx.reply('⏳ Daily bonus already claimed. Come back in 24 hours.');
  return ctx.reply(`🎁 *DAILY BONUS* +${DAILY_COINS} 🪙\n> Balance: *${fmtCoins(rows[0].coins)}*`, { parse_mode: 'Markdown' });
});
bot.command('bets', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Use this in the match group.');
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('❌ No active match.');
  const { rows } = await q(`SELECT team, amount, odds FROM bets WHERE match_id=$1 AND telegram_id=$2 ORDER BY id`, [String(m.id), ctx.from.id]);
  if (!rows.length) return ctx.reply('You have no bets in this match. Use /bet 100 a');
  let t = `🎰 *YOUR BETS*\n`;
  for (const r of rows) t += `> Team ${r.team}: *${fmtCoins(r.amount)}* @ *${Number(r.odds).toFixed(2)}x* → ${fmtCoins(Math.floor(r.amount * Number(r.odds)))}\n`;
  return ctx.reply(t, { parse_mode: 'Markdown' });
});

// match finished → pay out; cancelled → refund
async function settleBets(telegram, groupId, matchId, winner) {
  const { rows } = await q(
    `SELECT b.id, b.telegram_id, b.team, b.amount, b.odds, u.username, u.first_name, u.last_name
       FROM bets b LEFT JOIN users u ON u.telegram_id = b.telegram_id
      WHERE b.match_id=$1 AND b.status='open' ORDER BY b.id`,
    [String(matchId)]
  );
  if (!rows.length) return;
  const lines = [];
  for (const b of rows) {
    const amt = Number(b.amount);
    const nm = mdEsc(shortName({ first_name: b.first_name, last_name: b.last_name, username: b.username, telegram_id: b.telegram_id }, 14));
    if (winner === 'tie') {
      await q(`UPDATE wallets SET coins=coins+$2 WHERE telegram_id=$1`, [b.telegram_id, amt]);
      await q(`UPDATE bets SET status='refund', payout=$2 WHERE id=$1`, [b.id, amt]);
      lines.push(`🤝 ${nm} refund ${fmtCoins(amt)}`);
    } else if (b.team === winner) {
      const pay = Math.floor(amt * Number(b.odds));
      await q(`UPDATE wallets SET coins=coins+$2 WHERE telegram_id=$1`, [b.telegram_id, pay]);
      await q(`UPDATE bets SET status='won', payout=$2 WHERE id=$1`, [b.id, pay]);
      lines.push(`✅ ${nm} +${fmtCoins(pay - amt)} (${Number(b.odds).toFixed(2)}x)`);
    } else {
      await q(`UPDATE bets SET status='lost', payout=0 WHERE id=$1`, [b.id]);
      lines.push(`❌ ${nm} −${fmtCoins(amt)}`);
    }
  }
  const shown = lines.slice(0, 15).join('\n') + (lines.length > 15 ? `\n… +${lines.length - 15} more` : '');
  await telegram.sendMessage(Number(groupId), `🎰 *BET RESULTS*\n${winner === 'tie' ? 'Match tied — stakes refunded' : `Team ${winner} won`}\n${shown}`, { parse_mode: 'Markdown' });
}
async function refundBets(telegram, groupId, matchId) {
  const { rows } = await q(`SELECT id, telegram_id, amount FROM bets WHERE match_id=$1 AND status='open'`, [String(matchId)]);
  if (!rows.length) return;
  for (const b of rows) {
    await q(`UPDATE wallets SET coins=coins+$2 WHERE telegram_id=$1`, [b.telegram_id, Number(b.amount)]);
    await q(`UPDATE bets SET status='refund', payout=$2 WHERE id=$1`, [b.id, Number(b.amount)]);
  }
  await telegram.sendMessage(Number(groupId), `🎰 Match cancelled — *${rows.length}* bet(s) refunded.`, { parse_mode: 'Markdown' }).catch(() => {});
}

// ═══ LEADERBOARD (/ranking · /leaderboard · BOARD button) ═══
const LB_TITLES = {
  runs: '🏏 MOST RUNS',
  high: '🏏 HIGHEST INDIVIDUAL SCORE',
  wkts: '🎳 MOST WICKETS',
  best: '🎳 BEST BOWLING FIGURES',
  coins: '🪙 RICHEST PLAYERS',
};
const MEDALS = ['🥇', '🥈', '🥉'];
function lbMainKb() {
  return Markup.inlineKeyboard([
    [btn('𝗕𝗔𝗧𝗧𝗜𝗡𝗚', 'lb:menu:bat', 'bat', 'success'), btn('𝗕𝗢𝗪𝗟𝗜𝗡𝗚', 'lb:menu:bowl', 'bowler', 'danger')],
    [btn('𝗥𝗜𝗖𝗛𝗘𝗦𝗧', 'lb:coins:a', 'money', 'primary')],
  ]);
}
function lbSubKb(kind, inGroup) {
  const rows = [];
  const defs = kind === 'bat'
    ? [['𝗠𝗢𝗦𝗧 𝗥𝗨𝗡𝗦', 'runs'], ['𝗛𝗜𝗚𝗛𝗘𝗦𝗧 𝗦𝗖𝗢𝗥𝗘', 'high']]
    : [['𝗠𝗢𝗦𝗧 𝗪𝗜𝗖𝗞𝗘𝗧𝗦', 'wkts'], ['𝗕𝗘𝗦𝗧 𝗙𝗜𝗚𝗨𝗥𝗘𝗦', 'best']];
  const style = kind === 'bat' ? 'success' : 'danger';
  for (const [label, cat] of defs) {
    const row = [];
    if (inGroup) row.push(btn(`${label} · 𝗚𝗖`, `lb:${cat}:g`, kind === 'bat' ? 'bat' : 'bowler', style));
    row.push(btn(`${label} · 𝗔𝗟𝗟`, `lb:${cat}:a`, 'trophy', 'primary'));
    rows.push(row);
  }
  rows.push([btn('𝗕𝗔𝗖𝗞', 'lb:home', 'door')]);
  return Markup.inlineKeyboard(rows);
}
const lbBackKb = (cat, inGroup) =>
  Markup.inlineKeyboard([[btn('𝗕𝗔𝗖𝗞', cat === 'coins' ? 'lb:home' : `lb:menu:${cat === 'runs' || cat === 'high' ? 'bat' : 'bowl'}`, 'door')]]);

async function lbRows(cat, groupId) {
  const g = groupId ? 'AND m.group_chat_id=$1' : '';
  const params = groupId ? [groupId] : [];
  const batBase = `FROM batting_stats bs JOIN match_players mp ON mp.id=bs.player_id JOIN innings i ON i.id=bs.innings_id JOIN matches m ON m.id=i.match_id WHERE m.status='completed' AND mp.telegram_id>0 ${g}`;
  const bowlBase = `FROM bowling_stats w JOIN match_players mp ON mp.id=w.player_id JOIN innings i ON i.id=w.innings_id JOIN matches m ON m.id=i.match_id WHERE m.status='completed' AND mp.telegram_id>0 ${g}`;
  if (cat === 'runs')
    return (await q(`SELECT mp.telegram_id AS id, SUM(bs.runs)::int AS v, SUM(bs.balls_faced)::int AS b, COUNT(DISTINCT m.id)::int AS mt ${batBase} GROUP BY mp.telegram_id HAVING SUM(bs.runs)>0 ORDER BY v DESC, b ASC LIMIT 10`, params)).rows;
  if (cat === 'high')
    return (await q(`SELECT * FROM (SELECT DISTINCT ON (mp.telegram_id) mp.telegram_id AS id, bs.runs AS v, bs.balls_faced AS b ${batBase} ORDER BY mp.telegram_id, bs.runs DESC, bs.balls_faced ASC) x WHERE v>0 ORDER BY v DESC, b ASC LIMIT 10`, params)).rows;
  if (cat === 'wkts')
    return (await q(`SELECT mp.telegram_id AS id, SUM(w.wickets)::int AS v, SUM(w.balls_bowled)::int AS b, COUNT(DISTINCT m.id)::int AS mt ${bowlBase} GROUP BY mp.telegram_id HAVING SUM(w.wickets)>0 ORDER BY v DESC, b ASC LIMIT 10`, params)).rows;
  if (cat === 'best')
    return (await q(`SELECT * FROM (SELECT DISTINCT ON (mp.telegram_id) mp.telegram_id AS id, w.wickets AS v, w.runs_conceded AS c, w.balls_bowled AS b ${bowlBase} ORDER BY mp.telegram_id, w.wickets DESC, w.runs_conceded ASC) x WHERE v>0 ORDER BY v DESC, c ASC LIMIT 10`, params)).rows;
  if (cat === 'coins')
    return (await q(`SELECT telegram_id AS id, coins::bigint AS v FROM wallets ORDER BY coins DESC LIMIT 10`)).rows;
  return [];
}
async function lbText(cat, groupId, groupTitle) {
  const rows = await lbRows(cat, groupId);
  const scope = cat === 'coins' ? '' : groupId ? ` — ${groupTitle ? mdEsc(groupTitle) : 'THIS GROUP'}` : ' — ALL OVER';
  let t = `${LB_TITLES[cat]}${scope}\n${line()}\n`;
  if (!rows.length) return t + '_No data yet — play some matches!_';
  const ids = rows.map((r) => Number(r.id));
  const { rows: us } = await q(`SELECT telegram_id, username, first_name, last_name FROM users WHERE telegram_id = ANY($1::bigint[])`, [ids]);
  const um = new Map(us.map((u) => [Number(u.telegram_id), u]));
  rows.forEach((r, i) => {
    const u = um.get(Number(r.id)) || { telegram_id: r.id };
    const nm = mdEsc(shortName({ ...u, telegram_id: Number(r.id) }, 18));
    const rank = MEDALS[i] || `${i + 1}.`;
    let val;
    if (cat === 'runs') val = `*${r.v}* runs · ${r.mt}M`;
    else if (cat === 'high') val = `*${r.v}* (${r.b})`;
    else if (cat === 'wkts') val = `*${r.v}* wkts · ${r.mt}M`;
    else if (cat === 'best') val = `*${r.v}/${r.c}* (${oversStr(Number(r.b))} ov)`;
    else val = `*${fmtCoins(r.v)}* 🪙`;
    t += `${rank} ${nm} — ${val}\n`;
  });
  return t;
}
async function sendLbMenu(ctx) {
  return ctx.reply(`🏆 *LEADERBOARD*\nPick a category 👇`, { parse_mode: 'Markdown', ...lbMainKb() });
}
bot.command(['ranking', 'leaderboard', 'lb'], sendLbMenu);
bot.action('m:lb', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  return sendLbMenu(ctx);
});
bot.action(/^lb:(.+)$/, async (ctx) => {
  try {
    const parts = ctx.match[1].split(':');
    const inGroup = ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
    await ctx.answerCbQuery().catch(() => {});
    if (parts[0] === 'home') return await ctx.editMessageText(`🏆 *LEADERBOARD*\nPick a category 👇`, { parse_mode: 'Markdown', ...lbMainKb() });
    if (parts[0] === 'menu') {
      const kind = parts[1] === 'bowl' ? 'bowl' : 'bat';
      return await ctx.editMessageText(`${kind === 'bat' ? '🏏 *BATTING*' : '🎳 *BOWLING*'}\nChoose a board 👇`, { parse_mode: 'Markdown', ...lbSubKb(kind, inGroup) });
    }
    const cat = parts[0];
    if (!LB_TITLES[cat]) return;
    const groupId = parts[1] === 'g' && inGroup ? ctx.chat.id : null;
    const text = await lbText(cat, groupId, inGroup ? ctx.chat.title : null);
    await ctx.editMessageText(text, { parse_mode: 'Markdown', ...lbBackKb(cat, inGroup) });
  } catch (e) {
    if (!/not modified/i.test(String(e.message))) console.error('lb action', e.message);
  }
});

// ═══ OVER GRAPH (after every over) + PARTNERSHIP CARD ═══
const GRAPH_TPL = path.join(ASSET_DIR, 'graph_template.jpg');
const PART_TPL = path.join(ASSET_DIR, 'partnership_template.jpg');
const lblCache = new Map();
async function lbl(text, px, color = '#ffffff') {
  const k = `${text}|${px}|${color}`;
  let v = lblCache.get(k);
  if (!v) {
    v = await renderText(String(text), px, color);
    if (lblCache.size > 500) lblCache.clear();
    lblCache.set(k, v);
  }
  return v;
}
const teamTxt = (s, fb) => cleanName(String(s || ''), fb).toUpperCase();

async function overRunsOf(inningsId) {
  const { rows } = await q(
    `SELECT over_number, SUM(runs_scored)::int AS r FROM deliveries WHERE innings_id=$1 GROUP BY over_number ORDER BY over_number`,
    [inningsId]
  );
  const arr = [];
  for (const r of rows) arr[Number(r.over_number) - 1] = Number(r.r) || 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] === undefined) arr[i] = 0;
  return arr;
}

// 1280x720 graph on graph_template.jpg: runs per over, both teams
async function renderOverGraph(m, inn) {
  needSharp();
  if (!fs.existsSync(GRAPH_TPL)) return null;
  const { rows: inns } = await q(`SELECT * FROM innings WHERE match_id=$1 ORDER BY innings_number`, [m.id]);
  const i1 = inns.find((i) => Number(i.innings_number) === 1) || inn;
  const i2 = inns.find((i) => Number(i.innings_number) === 2) || null;
  const cols = [
    { inn: i1, line: '#ff3030', grad: 'gr', txt: '#ff6a6a' },
    { inn: i2, line: '#ffc81e', grad: 'gy', txt: '#ffd95a' },
  ];
  for (const c of cols) c.runs = c.inn ? await overRunsOf(c.inn.id) : [];
  const total = Number(m.total_overs) || (m.mode === 'test' ? TEST_OVERS : DEFAULT_OVERS);
  const N = Math.max(2, total, cols[0].runs.length, cols[1].runs.length);
  const maxV = Math.max(5, ...cols[0].runs, ...cols[1].runs);
  const step = maxV <= 10 ? 2 : 5;
  const yMax = Math.ceil(maxV / step) * step;
  const X0 = 105, X1 = 1190, Y0 = 614, YT = 200;
  const xAt = (i) => X0 + (i * (X1 - X0)) / (N - 1);
  const yAt = (v) => Y0 - (v / yMax) * (Y0 - YT);

  let svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720"><defs>` +
    `<linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff2a2a" stop-opacity="0.55"/><stop offset="1" stop-color="#ff2a2a" stop-opacity="0.03"/></linearGradient>` +
    `<linearGradient id="gy" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc81e" stop-opacity="0.50"/><stop offset="1" stop-color="#ffc81e" stop-opacity="0.03"/></linearGradient>` +
    `<filter id="gl" x="-5%" y="-30%" width="110%" height="160%"><feGaussianBlur stdDeviation="4"/></filter></defs>`;
  const layers = [];
  for (let v = step; v <= yMax; v += step) {
    const y = yAt(v);
    svg += `<line x1="62" x2="1243" y1="${y}" y2="${y}" stroke="#ff3b3b" stroke-opacity="0.16" stroke-width="1" stroke-dasharray="4 7"/>`;
    layers.push(centered(await lbl(v, 15, '#9a9a9a'), 80, y - 11));
  }
  for (let i = 0; i < N; i++) {
    svg += `<line x1="${xAt(i)}" x2="${xAt(i)}" y1="${Y0}" y2="${Y0 + 8}" stroke="#ff3030" stroke-width="2"/>`;
    layers.push(centered(await lbl(i + 1, N > 14 ? 15 : 18, '#dcdcdc'), xAt(i), Y0 + 24));
  }
  cols.forEach((c, idx) => {
    const pts = c.runs.map((v, i) => [xAt(i), yAt(v)]);
    if (!pts.length) return;
    const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    svg += `<polygon points="${pts[0][0].toFixed(1)},${Y0} ${poly} ${pts[pts.length - 1][0].toFixed(1)},${Y0}" fill="url(#${c.grad})"/>`;
    svg += `<polyline points="${poly}" fill="none" stroke="${c.line}" stroke-width="9" stroke-opacity="0.45" filter="url(#gl)" stroke-linejoin="round"/>`;
    svg += `<polyline points="${poly}" fill="none" stroke="${c.line}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const p of pts) svg += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="6" fill="${c.line}" stroke="#fff" stroke-opacity="0.85" stroke-width="1.5"/>`;
  });
  // run labels: team 1 above the dot, team 2 below it
  for (let idx = 0; idx < 2; idx++) {
    const c = cols[idx];
    for (let i = 0; i < c.runs.length; i++) {
      const y = yAt(c.runs[i]) + (idx === 0 ? -17 : 19);
      layers.push(centered(await lbl(c.runs[i], 16, c.txt), xAt(i), Math.min(Y0 - 8, Math.max(190, y))));
    }
  }
  svg += `<circle cx="112" cy="104" r="8" fill="#ff3030"/><circle cx="870" cy="104" r="8" fill="#ffc81e"/>`;
  svg += `</svg>`;

  const boxes = [
    { c: cols[0], cx: 263, label: 'A' },
    { c: cols[1], cx: 1019, label: 'B' },
  ];
  for (let k = 0; k < 2; k++) {
    const b = boxes[k];
    const batLabel = b.c.inn ? b.c.inn.batting_team : k === 0 ? i1?.batting_team || 'A' : i1?.bowling_team || 'B';
    const nm = teamTxt(await teamNameOf(m.id, batLabel), `TEAM ${batLabel}`);
    layers.push(centered(await fitText(nm, 30, 300, '#ffffff', 16), b.cx + 10, 99));
    const sc = b.c.inn
      ? `${b.c.inn.total_runs}/${b.c.inn.total_wickets}  (${oversStr(b.c.inn.balls_bowled)} ov)`
      : 'YET TO BAT';
    layers.push(centered(await lbl(sc, 22, b.c.txt), b.cx + 10, 130));
  }
  return sharp(GRAPH_TPL)
    .resize(1280, 720, { fit: 'fill' })
    .composite([{ input: Buffer.from(svg), left: 0, top: 0 }, ...layers])
    .jpeg({ quality: 90 })
    .toBuffer();
}

// message sent when an over is complete: graph + summary (+ tag the bowling captain: send new bowler)
async function sendOverEnd(telegram, m, inn, finalOver = false) {
  const groupId = Number(m.group_chat_id);
  const overNo = Math.floor((inn.balls_bowled - 1) / 6) + 1;
  const ovSum = await overSummary(m.id, inn);
  const tag = finalOver ? '' : `\n👑 ${await capTagOf(m, inn.bowling_team)} — please send your *new bowler*: /ball <no.>`;
  const caption = `🔔 *Over ${overNo} complete!*\n${ovSum}${tag}`;
  try {
    const img = await renderOverGraph(m, inn);
    if (img) {
      await telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'Markdown' });
      return;
    }
  } catch (e) {
    console.error('over graph failed:', e.message);
    reportCardError('Over graph', e).catch(() => {});
  }
  await telegram.sendMessage(groupId, caption, { parse_mode: 'Markdown' });
}

// ── partnership ──
function partMilestones() {
  const s = [30, 50, 80, 100];
  for (let x = 130; x <= 1000; x += 30) s.push(x);
  return s;
}
const PART_MS = partMilestones();
function crossedPartMilestone(before, after) {
  let hit = null;
  for (const ms of PART_MS) if (before < ms && after >= ms) hit = ms;
  return hit;
}
async function partnershipStats(inningsId) {
  const { rows } = await q(
    `SELECT d.batsman_id,
            COALESCE(SUM(d.runs_scored),0)::int AS runs, COUNT(*)::int AS balls,
            COUNT(*) FILTER (WHERE d.runs_scored=4 AND d.is_wicket IS NOT TRUE)::int AS f4,
            COUNT(*) FILTER (WHERE d.runs_scored=6 AND d.is_wicket IS NOT TRUE)::int AS s6
       FROM deliveries d
      WHERE d.innings_id=$1
        AND d.id > COALESCE((SELECT id FROM deliveries WHERE innings_id=$1 AND is_wicket=TRUE ORDER BY over_number DESC, ball_number DESC LIMIT 1), 0)
      GROUP BY d.batsman_id`,
    [inningsId]
  );
  const by = new Map();
  let total = 0, balls = 0, fours = 0, sixes = 0;
  for (const r of rows) {
    by.set(Number(r.batsman_id), { runs: r.runs, balls: r.balls });
    total += r.runs; balls += r.balls; fours += r.f4; sixes += r.s6;
  }
  return { total, balls, fours, sixes, by };
}

// 1254x1254 partnership card on partnership_template.jpg
async function renderPartnershipCard(d) {
  needSharp();
  if (!fs.existsSync(PART_TPL)) return null;
  const layers = [];
  layers.push(await dpLayer(d.l.dp, { cx: 232, cy: 673, r: 166 }, 0, 776));
  layers.push(await dpLayer(d.r.dp, { cx: 1022, cy: 673, r: 166 }, 0, 776));
  const cover = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="1254" height="1254"><defs><radialGradient id="cg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#171717"/><stop offset="1" stop-color="#0b0b0b"/></radialGradient></defs>` +
      `<circle cx="627" cy="670" r="158" fill="url(#cg)"/>` +
      `<line x1="500" y1="722" x2="754" y2="722" stroke="#ff2a2a" stroke-width="2.5"/>` +
      `<line x1="627" y1="722" x2="627" y2="824" stroke="#ff2a2a" stroke-width="2.5"/></svg>`
  );
  layers.push({ input: cover, left: 0, top: 0 });
  layers.push(centered(await lbl('PARTNERSHIP', 27, '#ffffff'), 627, 548));
  layers.push(centered(await lbl('RUNS', 27, '#ffffff'), 627, 577));
  const gold = { pop: true, squeeze: 1, outline: [30, 15, 0] };
  layers.push(centered(await goldText(String(d.total), 84, 190, gold), 627, 640));
  layers.push(centered(await lbl(`(${d.balls})`, 30, '#ffffff'), 627, 694));
  layers.push(centered(await goldText(String(d.l.runs), 46, 84, gold), 579, 764));
  layers.push(centered(await lbl(`(${d.l.balls})`, 24, '#ffffff'), 579, 800));
  layers.push(centered(await goldText(String(d.r.runs), 46, 84, gold), 675, 764));
  layers.push(centered(await lbl(`(${d.r.balls})`, 24, '#ffffff'), 675, 800));
  await putCentered(layers, d.l.name, 34, 236, 821, 300);
  await putCentered(layers, d.r.name, 34, 1019, 817, 300);
  const vals = [d.total, d.balls, d.fours, d.sixes, d.sr];
  const xs = [189, 428, 640, 850, 1075];
  for (let i = 0; i < 5; i++) layers.push(centered(await goldText(String(vals[i]), 54, 170, gold), xs[i], 1027));
  return sharp(PART_TPL).composite(layers).jpeg({ quality: 90 }).toBuffer();
}

async function sendPartnershipCard(telegram, groupId, ms, a, b, st) {
  const sa = st.by.get(Number(a.id)) || { runs: 0, balls: 0 };
  const sb = st.by.get(Number(b.id)) || { runs: 0, balls: 0 };
  const [L, R] = sa.runs >= sb.runs ? [[a, sa], [b, sb]] : [[b, sb], [a, sa]];
  const sr = st.balls > 0 ? ((st.total * 100) / st.balls).toFixed(1) : '0.0';
  const side = async (p, s) => ({
    runs: s.runs,
    balls: s.balls,
    name: videoName(p).toUpperCase(),
    dp: await getUserDp(telegram, p.telegram_id).catch(() => null),
  });
  const caption =
    `🤝 <b>${fancy(ms + '-RUN PARTNERSHIP')}</b>\n` +
    `🎉 Congratulations <a href="tg://user?id=${Number(L[0].telegram_id)}">${escapeHtml(shortName(L[0], 16))}</a> &amp; ` +
    `<a href="tg://user?id=${Number(R[0].telegram_id)}">${escapeHtml(shortName(R[0], 16))}</a>!\n` +
    `<blockquote>${st.total} runs · ${st.balls} balls · SR ${sr}</blockquote>`;
  let img = null;
  try {
    img = await renderPartnershipCard({
      l: await side(L[0], L[1]),
      r: await side(R[0], R[1]),
      total: st.total, balls: st.balls, fours: st.fours, sixes: st.sixes, sr,
    });
  } catch (e) {
    console.error('partnership card failed:', e.message);
    reportCardError('Partnership card', e).catch(() => {});
  }
  if (img) return telegram.sendPhoto(groupId, { source: img }, { caption, parse_mode: 'HTML' });
  return telegram.sendMessage(groupId, caption, { parse_mode: 'HTML' });
}

// ── embedded templates (written to ./assets on first start when the files are missing) ──
const TPL_GRAPH_B64 = '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';
const TPL_PART_B64 = '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';
function ensureTemplates() {
  try {
    fs.mkdirSync(ASSET_DIR, { recursive: true });
    for (const [f, b64] of [['graph_template.jpg', TPL_GRAPH_B64], ['partnership_template.jpg', TPL_PART_B64]]) {
      const file = path.join(ASSET_DIR, f);
      if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.from(b64, 'base64'));
    }
  } catch (e) {
    console.error('ensureTemplates:', e.message);
  }
}

async function initR49() {
  await q(`CREATE TABLE IF NOT EXISTS user_gender (
    telegram_id BIGINT PRIMARY KEY, gender TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS wallets (
    telegram_id BIGINT PRIMARY KEY, coins BIGINT NOT NULL DEFAULT ${START_COINS}, last_daily TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE TABLE IF NOT EXISTS bets (
    id BIGSERIAL PRIMARY KEY, match_id TEXT NOT NULL, chat_id BIGINT, telegram_id BIGINT NOT NULL,
    team TEXT NOT NULL, amount BIGINT NOT NULL, odds NUMERIC(6,2) NOT NULL,
    status TEXT NOT NULL DEFAULT 'open', payout BIGINT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await q(`CREATE INDEX IF NOT EXISTS bets_match_idx ON bets (match_id, status)`);
  await q(`ALTER TABLE match_teams ADD COLUMN IF NOT EXISTS team_name TEXT`);
  const { rows } = await q(`SELECT telegram_id, gender FROM user_gender`);
  for (const r of rows) genderCache.set(String(r.telegram_id), r.gender);
  console.log(`r49: ${rows.length} genders loaded`);
  ensureTemplates();
}


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
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS test_days INTEGER');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS current_day INTEGER');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS day_wins_a INTEGER');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS day_wins_b INTEGER');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS pause_key TEXT');
  await q('ALTER TABLE matches ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ');
  await q('ALTER TABLE match_players ADD COLUMN IF NOT EXISTS last_name TEXT');
  await q('ALTER TABLE match_players ADD COLUMN IF NOT EXISTS test_lifeline INTEGER DEFAULT 1');
  // Allow mode = 'test' (old check only had solo/team)
  try {
    await q(`ALTER TABLE matches DROP CONSTRAINT IF EXISTS matches_mode_check`);
    await q(
      `ALTER TABLE matches ADD CONSTRAINT matches_mode_check CHECK (mode IN ('solo','team','test'))`
    );
    console.log('matches_mode_check updated to include test');
  } catch (e) {
    console.error('matches_mode_check:', e.message);
  }
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
  await q(`CREATE TABLE IF NOT EXISTS group_settings (
    chat_id BIGINT PRIMARY KEY,
    commentary_lang TEXT NOT NULL DEFAULT 'en',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await initR49();
  await relaxNegativeRunConstraints();
  try {
    const { rows } = await q(`SELECT id FROM matches WHERE vs_bot=TRUE AND status NOT IN ('completed','cancelled')`);
    rows.forEach((r) => botMatchIds.add(String(r.id)));
  } catch (_) {}
  console.log('DB OK');
  if (MATCH_VIDEOS) ensureFfmpeg().catch(() => {});
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
