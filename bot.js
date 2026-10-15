/**
 * Hand Cricket Telegram Bot — Single file
 * Solo: auto batsman/bowler, no non-striker, just type 1-6
 * Team: full /bat /bowl flow
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
const DEFAULT_OVERS = 5;
const DEFAULT_TEAM_SIZE = 5;
const MAX_BOWLER_OVERS = 4;
const LOBBY_SECONDS = 60; // solo lobby timer
const MAX_SOLO_PLAYERS = 20; // unlimited-style join (cap 20)

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

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');
}

function name(p) {
  if (!p) return '—';
  if (p.username) return `@${p.username}`;
  return p.first_name || `User${p.telegram_id || ''}`;
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
    else if (match.winner_team) t += `🏆 Winner: *Team ${match.winner_team}*\n`;
    return t;
  }

  if (!inn) {
    t += `⏳ Waiting for match to start…\n`;
    return t;
  }

  const bat = inn.batting_team;
  const bowl = inn.bowling_team;
  const totalOvers = match.total_overs || 5;
  const crr =
    inn.balls_bowled > 0
      ? ((inn.total_runs * 6) / inn.balls_bowled).toFixed(2)
      : '0.00';

  t += `📊 *INNINGS ${inn.innings_number}*\n`;
  t += `${line()}\n`;
  t += isSolo
    ? `🏏 Score: *${inn.total_runs}/${inn.total_wickets}*\n`
    : `🅰️ Team ${bat}  »  *${inn.total_runs}/${inn.total_wickets}*\n`;
  t += `⏱ Overs: *${oversStr(inn.balls_bowled)} / ${totalOvers}*\n`;
  t += `📈 RR: *${crr}*\n`;

  if (match.target && inn.innings_number === 2) {
    const need = Math.max(0, match.target - inn.total_runs);
    t += `🎯 Target: *${match.target}*  (Need *${need}*)\n`;
  }

  const striker = await getPlayer(inn.striker_player_id);
  const non = await getPlayer(inn.non_striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);

  t += `\n${line()}\n`;
  if (striker) t += `🏏 Striker   ${name(striker)}\n`;
  if (!isSolo && non) t += `🧍🏻 Non-strike ${name(non)}\n`;
  if (bowler) t += `🎳 Bowler    ${name(bowler)}\n`;

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
    t += `│ ${icon} ${p.roster_position}. ${name(p)}  ${runs}\n`;
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
    else if (bb / 6 >= maxOv) icon = '✅';

    const fig = s
      ? `${s.wickets || 0}/${s.runs_conceded || 0} (${oversStr(bb)})`
      : '—';
    t += `│ ${icon} ${p.roster_position}. ${name(p)}  ${fig}\n`;
  }
  t += `└${'─'.repeat(20)}┘\n`;

  if (isSolo) {
    t += `\n💡 Batsman group mein *1–6* type kare`; 
  }

  return t;
}

// ─── /start ──────────────────────────────────────────────
bot.start(async (ctx) => {
  await upsertUser(ctx.from);
  await ctx.reply(
    `╔══════════════════════╗\n` +
      `║  🏏 HAND CRICKET     ║\n` +
      `╚══════════════════════╝\n\n` +
      `Group mein match banao.\n` +
      `Pehle yahan /start dabao (bowling DM ke liye).\n\n` +
      `*Solo* → sirf 1-6 type karo, auto setup\n` +
      `*Team* → /bat /bowl se select`,
    { parse_mode: 'Markdown', ...mainKb() }
  );
});

// ─── Permanent result GIFs ────────────────────────────────────────────────
// Reply to a GIF with /pgif 1|2|3|4|5|6|out. Saved in PostgreSQL permanently.
const PGIF_KEYS = new Set(['1', '2', '3', '4', '5', '6', 'out']);

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
    const key = String(parts[1] || '').toLowerCase();
    if (!PGIF_KEYS.has(key)) return ctx.reply('GIF ke message par reply karke /pgif 1 (ya 2, 3, 4, 5, 6, out) use karo.');
    if (!(await canConfigurePgif(ctx))) return ctx.reply('❌ Sirf group admin ya BOT_OWNER_ID / ADMIN_IDS mein configured owner GIF set kar sakta hai.');

    const replied = ctx.message?.reply_to_message;
    if (!replied) return ctx.reply('❌ GIF wale message par reply karke /pgif ' + key + ' bhejo.');
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
    if (!fileId) return ctx.reply('❌ Reply kiye message mein GIF/animation nahi mili. GIF ko directly Telegram group mein bhejo, phir usi message par reply karo.');

    await q(`INSERT INTO public.pgif_settings (result_key, file_id, media_type, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (result_key) DO UPDATE SET file_id=EXCLUDED.file_id, media_type=EXCLUDED.media_type,
      updated_by=EXCLUDED.updated_by, updated_at=NOW()`, [key, fileId, mediaType, String(ctx.from.id)]);
    return ctx.reply(`✅ Permanent GIF saved for ${key === 'out' ? 'WICKET' : key + ' RUN' + (key === '1' ? '' : 'S')}!\nAb matching result par har match mein automatically aayegi.`);
  } catch (e) {
    console.error('pgif setup error:', e);
    try { return await ctx.reply('❌ GIF save nahi hui: ' + String(e.message || e).slice(0, 250)); } catch {}
  }
});

async function sendResultGif(telegram, chatId, key, replyToMessageId, caption = '') {
  try {
    const { rows } = await q('SELECT file_id, media_type FROM public.pgif_settings WHERE result_key=$1', [String(key)]);
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

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *HOW TO PLAY*\n\n` +
      `*SOLO*\n` +
      `/startsolo — lobby (60s)\n` +
      `/joinsolo — join (#1 bat, #2 bowl…)\n` +
      `/leavesolo — leave\n` +
      `/forcestart — start (min 2)\n` +
      `/extend30 — +30s\n` +
      `Join order = number (no teams)\n` +
      `Type 1-6 to play\n\n` +
      `*TEAM*\n` +
      `/startteam → /join_a /join_b\n` +
      `/setcaptain_a 1 → /startmatch\n` +
      `/bat 1 · /bowl 1 → 1-6\n\n` +
      `Same number = OUT\n\n` +
      `*GIF setup (reply to GIF):* /pgif 1, /pgif 2, /pgif 3, /pgif 4, /pgif 5, /pgif 6, /pgif out`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('m:solo', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Group mein bhejo:\n`/startsolo`', { parse_mode: 'Markdown' });
});
bot.action('m:team', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Group mein bhejo:\n`/startteam` ya `/startteam 5 5`', {
    parse_mode: 'Markdown',
  });
});
bot.action('m:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    'Solo: /startsolo → join → start → type 1-6\nTeam: /startteam → join → captains → /bat /bowl'
  );
});
bot.action('m:profile', async (ctx) => {
  await ctx.answerCbQuery();
  await upsertUser(ctx.from);
  const { rows } = await q(`SELECT * FROM users WHERE telegram_id=$1`, [ctx.from.id]);
  const u = rows[0] || {};
  await ctx.reply(
    `👤 *${name(ctx.from)}*\n` +
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
  if (!rows.length) return ctx.reply('🏆 Abhi koi match nahi');
  let t = `🏆 *LEADERBOARD*\n${line()}\n`;
  rows.forEach((r, i) => {
    const n = r.username ? `@${r.username}` : r.first_name || '?';
    t += `${i + 1}. ${n} — ${r.matches_won}W · ${r.total_runs} runs\n`;
  });
  await ctx.reply(t, { parse_mode: 'Markdown' });
});

// ─── Solo: start match (toss) from lobby ─────────────────
async function beginSoloFromLobby(matchId, chatId, telegram) {
  clearLobby(matchId);
  const m = await getMatch(matchId);
  if (!m || m.status !== 'waiting' || m.mode !== 'solo') return;

  // All solo players on team A, ordered by join number
  const players = await getPlayers(matchId, 'A');
  if (players.length < 2) {
    await telegram.sendMessage(
      chatId,
      `⏰ *Lobby time up!*\nPlayers: ${players.length}\nMatch cancelled. /startsolo dubara try karo.`,
      { parse_mode: 'Markdown' }
    );
    await q(`UPDATE matches SET status='cancelled' WHERE id=$1`, [matchId]);
    return;
  }

  // No teams / no toss — join order: #1 bats, #2 bowls
  await q(
    `UPDATE matches SET
       status='innings1', current_innings=1,
       batting_first_team='A', current_batting_team='A', current_bowling_team='A',
       toss_winner_team='A'
     WHERE id=$1`,
    [matchId]
  );
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
    list += `  *#${i + 1}* ${name(p)}\n`;
  });

  await telegram.sendMessage(
    chatId,
    `⚡ *SOLO CRICKET BEGINS!*\n` +
      `${line('═')}\n` +
      list +
      `\n🏏 First Batter: *${name(batter)}*  (#1)\n` +
      `🎳 First Bowler: *${name(bowler)}*  (#2)\n\n` +
      `🎯 Same number = OUT\n` +
      `👉 *${name(batter)}* group mein *1–6* type karo!`,
    { parse_mode: 'Markdown' }
  );
  await telegram.sendMessage(chatId, await scoreboard(matchId), {
    parse_mode: 'Markdown',
  });
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
bot.command('startsolo', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Group mein use karo');
  try {
    if (await getActiveMatch(ctx.chat.id)) return ctx.reply('⚠️ Pehle /endmatch karo');

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

    await ctx.reply(
      `╔══ 🎮 SOLO MODE ══╗\n\n` +
        `👑 Host: *${name(ctx.from)}*\n` +
        `👥 Players: *1*  ·  max ${MAX_SOLO_PLAYERS}\n` +
        `⏱ Lobby: *${LOBBY_SECONDS}s*\n` +
        `🎯 Same number = OUT\n\n` +
        `📢 /joinsolo — join (#1 bat, #2 bowl…)\n` +
        `🚪 /leavesolo — leave\n` +
        `📋 /team — list\n\n` +
        `⚡ Host:\n` +
        `• /forcestart — start (min 2)\n` +
        `• /extend30 — +30s\n` +
        `• /endmatch — cancel`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('joinsolo', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting')
      return ctx.reply('❌ Koi solo lobby open nahi');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('❌ Already joined');

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
      `✅ *${name(ctx.from)}* joined as *#${pos}*${role}\n` +
        `👥 Players: *${total}*\n` +
        (left ? `⏳ Lobby: ${left}s left\n` : '') +
        (total >= 2
          ? `\n⚡ Host: /forcestart ya timer wait`
          : `\n⏳ Kam se kam 2 players chahiye`),
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('leavesolo', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting') return ctx.reply('❌ No open lobby');
    if (Number(m.host_telegram_id) === ctx.from.id)
      return ctx.reply('❌ Host leave nahi kar sakta — /endmatch use karo');
    const p = await getPlayerByTg(m.id, ctx.from.id);
    if (!p) return ctx.reply('❌ Tum lobby mein nahi ho');
    await q(`DELETE FROM match_players WHERE match_id=$1 AND telegram_id=$2`, [
      m.id,
      ctx.from.id,
    ]);
    const pl = await getPlayers(m.id);
    await ctx.reply(`👋 ${name(ctx.from)} left.\n👥 Players: *${pl.length}*`, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('forcestart', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting')
      return ctx.reply('❌ Solo lobby open nahi / already started');
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only host');

    const pl = await getPlayers(m.id);
    if (pl.length < 2)
      return ctx.reply(`❌ Minimum 2 players chahiye (abhi ${pl.length}/2)`);

    await ctx.reply(`⚡ *Force starting with ${pl.length} players!*`, {
      parse_mode: 'Markdown',
    });
    await beginSoloFromLobby(m.id, ctx.chat.id, ctx.telegram);
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
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only host');

    const L = lobbies.get(m.id);
    if (!L) return ctx.reply('❌ Lobby timer nahi mila');

    const extra = 30;
    const newLeft = Math.ceil((L.endsAt - Date.now()) / 1000) + extra;
    startLobbyTimer(m.id, ctx.chat.id, ctx.from.id, ctx.telegram, newLeft);

    await ctx.reply(`⏱️ Lobby *+${extra}s* — ab ~*${newLeft}s* bache hain`, {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

// ─── TEAM ────────────────────────────────────────────────
bot.command('startteam', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('❌ Group mein use karo');
  try {
    if (await getActiveMatch(ctx.chat.id)) return ctx.reply('⚠️ Pehle /endmatch');
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const size = parseInt(parts[0], 10) || DEFAULT_TEAM_SIZE;
    const overs = parseInt(parts[1], 10) || DEFAULT_OVERS;

    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'team',$3,$4,$5,$6,'waiting') RETURNING *`,
      [
        ctx.chat.id,
        ctx.chat.title || null,
        ctx.from.id,
        size,
        overs,
        Math.min(MAX_BOWLER_OVERS, overs),
      ]
    );
    const m = rows[0];
    for (const L of ['A', 'B']) {
      await q(`INSERT INTO match_teams (match_id, team_label) VALUES ($1,$2)`, [m.id, L]);
    }
    await upsertUser(ctx.from);

    await ctx.reply(
      `╔══ 👥 TEAM MATCH ══╗\n\n` +
        `👑 Host: ${name(ctx.from)}\n` +
        `👤 Size: *${size}*  |  ⏱ Overs: *${overs}*\n\n` +
        `Join:\n` +
        `• /join_a — Team A\n` +
        `• /join_b — Team B\n\n` +
        `Host:\n` +
        `• /setcaptain_a 1\n` +
        `• /setcaptain_b 1\n` +
        `• /startmatch`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

async function joinTeam(ctx, label) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.status !== 'waiting' || m.mode === 'solo')
      return ctx.reply('❌ Team match waiting nahi');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('❌ Already in a team');
    const team = await getPlayers(m.id, label);
    if (team.length >= m.team_size) return ctx.reply(`❌ Team ${label} full`);

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
      `✅ ${name(ctx.from)} → *Team ${label}*\n` +
        `👥 ${team.length + 1}/${m.team_size}`,
      { parse_mode: 'Markdown' }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
}
bot.command('join_a', (ctx) => joinTeam(ctx, 'A'));
bot.command('join_b', (ctx) => joinTeam(ctx, 'B'));

bot.command('setcaptain_a', async (ctx) => setCap(ctx, 'A'));
bot.command('setcaptain_b', async (ctx) => setCap(ctx, 'B'));

async function setCap(ctx, label) {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m || Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only host');
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply(`Usage: /setcaptain_${label.toLowerCase()} <number>`);
  const p = await getPlayerByPos(m.id, label, pos);
  if (!p) return ctx.reply('❌ Player nahi mila');
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
  await q(`UPDATE matches SET status='captains' WHERE id=$1`, [m.id]);
  await ctx.reply(`👑 Team ${label} captain: *${name(p)}*`, { parse_mode: 'Markdown' });
}

bot.command('team', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('❌ No match');
  let t = `🏏 *${m.mode.toUpperCase()}* · ${m.status}\n${line()}\n`;
  for (const L of ['A', 'B']) {
    const team = await getTeam(m.id, L);
    const pl = await getPlayers(m.id, L);
    t += `\n*Team ${L}* (${pl.length}/${m.team_size})\n`;
    for (const p of pl) {
      const star = Number(p.telegram_id) === Number(team?.captain_id) ? ' 👑' : '';
      t += `  ${p.roster_position}. ${name(p)}${star}\n`;
    }
    if (!pl.length) t += `  (empty)\n`;
  }
  await ctx.reply(t, { parse_mode: 'Markdown' });
});

bot.command('endmatch', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('❌ No match');
  if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only host');
  clearLobby(m.id);
  await q(`UPDATE matches SET status='cancelled' WHERE id=$1`, [m.id]);
  await ctx.reply('🛑 Match / lobby cancelled');
});

// ─── Start + Toss ────────────────────────────────────────
bot.command('startmatch', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply('❌ No match');
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('❌ Only host');

    // Solo waiting lobby → same as forcestart
    if (m.mode === 'solo' && m.status === 'waiting') {
      const pl = await getPlayers(m.id);
      if (pl.length < 2)
        return ctx.reply(`❌ Minimum 2 players (abhi ${pl.length}/2). /forcestart after join.`);
      await ctx.reply(`⚡ *Starting solo…*`, { parse_mode: 'Markdown' });
      await beginSoloFromLobby(m.id, ctx.chat.id, ctx.telegram);
      return;
    }

    const a = await getPlayers(m.id, 'A');
    const b = await getPlayers(m.id, 'B');
    if (!a.length || !b.length) return ctx.reply('❌ Dono teams mein players chahiye');
    if (m.mode === 'team') {
      const tA = await getTeam(m.id, 'A');
      const tB = await getTeam(m.id, 'B');
      if (!tA?.captain_id || !tB?.captain_id)
        return ctx.reply('❌ Pehle dono captains set karo');
    }
    const winner = Math.random() < 0.5 ? 'A' : 'B';
    await q(`UPDATE matches SET status='toss', toss_winner_team=$2 WHERE id=$1`, [
      m.id,
      winner,
    ]);
    await ctx.reply(
      `🪙 *TOSS*\n${line()}\n` +
        `🏆 Team *${winner}* wins the toss!\n\n` +
        `Choose:`,
      { parse_mode: 'Markdown', ...tossKb(m.id) }
    );
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.action(/^toss:(.+):(bat|bowl)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const choice = ctx.match[2];
  try {
    const m = await getMatch(matchId);
    if (!m || m.status !== 'toss')
      return ctx.answerCbQuery('Invalid', { show_alert: true });

    const team = await getTeam(m.id, m.toss_winner_team);
    const isCap = Number(team?.captain_id) === ctx.from.id;
    if (!isCap) {
      const pl = await getPlayers(m.id, m.toss_winner_team);
      if (!pl.some((p) => Number(p.telegram_id) === ctx.from.id)) {
        return ctx.answerCbQuery('Only toss winner', { show_alert: true });
      }
    }

    const batFirst =
      choice === 'bat' ? m.toss_winner_team : m.toss_winner_team === 'A' ? 'B' : 'A';
    const bowlFirst = batFirst === 'A' ? 'B' : 'A';

    await q(
      `UPDATE matches SET batting_first_team=$2, current_batting_team=$2,
       current_bowling_team=$3, current_innings=1, status='innings1' WHERE id=$1`,
      [m.id, batFirst, bowlFirst]
    );
    await q(
      `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state)
       VALUES ($1,1,$2,$3,'idle')`,
      [m.id, batFirst, bowlFirst]
    );

    let msg =
      `✅ Team ${m.toss_winner_team} chose *${choice.toUpperCase()}*\n\n` +
      `🏏 Batting: Team *${batFirst}*\n` +
      `🎳 Bowling: Team *${bowlFirst}*\n\n`;

    if (m.mode === 'solo') {
      // Auto setup solo
      let inn = await getInnings(m.id);
      inn = await soloAutoSetup(m, inn);
      const striker = await getPlayer(inn.striker_player_id);
      const bowler = await getPlayer(inn.current_bowler_id);
      msg +=
        `⚡ *Solo auto-setup*\n` +
        `🏏 Batsman: ${name(striker)}\n` +
        `🎳 Bowler: ${name(bowler)}\n\n` +
        `👉 ${name(striker)} group mein *1–6* type karo!`;
    } else {
      msg += `Batting captain: /bat 1 then /bat 2\nBowling captain: /bowl 1`;
    }

    await ctx.editMessageText(msg, { parse_mode: 'Markdown' });
    await ctx.answerCbQuery();

    if (m.mode === 'solo') {
      await ctx.telegram.sendMessage(Number(m.group_chat_id), await scoreboard(m.id), {
        parse_mode: 'Markdown',
      });
    }
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery(e.message, { show_alert: true });
  }
});

// ─── /bat /bowl (team mainly; solo auto) ─────────────────
bot.command('bat', async (ctx) => {
  if (!isGroup(ctx)) return;
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply('Usage: /bat 1');
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status))
      return ctx.reply('❌ Match in progress nahi');
    if (m.mode === 'solo') return ctx.reply('ℹ️ Solo mein auto hai — seedha 1-6 type karo');

    let inn = await getInnings(m.id);
    if (!inn || !['idle', 'waiting_bat'].includes(inn.ball_state))
      return ctx.reply('⏳ Ball pending');
    const team = await getTeam(m.id, inn.batting_team);
    if (Number(team?.captain_id) !== ctx.from.id) return ctx.reply('❌ Only batting captain');

    const p = await getPlayerByPos(m.id, inn.batting_team, pos);
    if (!p) return ctx.reply('❌ Invalid position');
    const { rows: st } = await q(
      `SELECT * FROM batting_stats WHERE innings_id=$1 AND player_id=$2`,
      [inn.id, p.id]
    );
    if (st[0]?.is_out) return ctx.reply('❌ Already out');
    if (p.id === inn.striker_player_id || p.id === inn.non_striker_player_id)
      return ctx.reply('❌ Already batting');

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

    await ctx.reply(`🏏 ${name(p)} → *${role}*`, { parse_mode: 'Markdown' });
    inn = await getInnings(m.id);
    if (inn.striker_player_id && inn.non_striker_player_id && !inn.current_bowler_id) {
      await ctx.reply('Bowling captain: /bowl <n>');
    }
    await ctx.reply(await scoreboard(m.id), { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('bowl', async (ctx) => {
  if (!isGroup(ctx)) return;
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply('Usage: /bowl 1');
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status))
      return ctx.reply('❌ Match in progress nahi');
    if (m.mode === 'solo') return ctx.reply('ℹ️ Solo mein auto bowler hai');

    const inn = await getInnings(m.id);
    if (!inn || inn.ball_state !== 'idle') return ctx.reply('⏳ Wait');
    if (!inn.striker_player_id || !inn.non_striker_player_id)
      return ctx.reply('❌ Pehle 2 batsmen /bat se select karo');

    const team = await getTeam(m.id, inn.bowling_team);
    if (Number(team?.captain_id) !== ctx.from.id) return ctx.reply('❌ Only bowling captain');

    const p = await getPlayerByPos(m.id, inn.bowling_team, pos);
    if (!p) return ctx.reply('❌ Invalid position');
    const { rows: st } = await q(
      `SELECT * FROM bowling_stats WHERE innings_id=$1 AND player_id=$2`,
      [inn.id, p.id]
    );
    const bb = st[0]?.balls_bowled || 0;
    if (bb / 6 >= (m.max_overs_per_bowler || MAX_BOWLER_OVERS))
      return ctx.reply('❌ Overs complete');
    if (inn.last_bowler_id === p.id && inn.balls_bowled % 6 === 0 && bb > 0)
      return ctx.reply('❌ Consecutive over nahi');

    await q(
      `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2)
       ON CONFLICT (innings_id, player_id) DO NOTHING`,
      [inn.id, p.id]
    );
    await q(`UPDATE innings SET current_bowler_id=$2 WHERE id=$1`, [inn.id, p.id]);

    await ctx.reply(
      `🎳 ${name(p)} bowling\n👉 Striker: group mein *1–6* type karo`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply(await scoreboard(m.id), { parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('❌ ' + e.message);
  }
});

bot.command('score', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('❌ No match');
  await ctx.reply(await scoreboard(m.id), { parse_mode: 'Markdown' });
});

// ─── Batsman types 1-6 ───────────────────────────────────
bot.hears(/^[1-6]$/, async (ctx) => {
  if (!isGroup(ctx)) return;
  const num = parseInt(ctx.message.text, 10);
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status)) return;

    let inn = await getInnings(m.id);
    if (!inn) return;

    // Solo: ensure auto setup every ball
    if (m.mode === 'solo') {
      inn = await soloAutoSetup(m, inn);
    }

    if (inn.ball_state !== 'idle' || !inn.current_bowler_id || !inn.striker_player_id) return;

    const striker = await getPlayer(inn.striker_player_id);
    if (!striker || Number(striker.telegram_id) !== ctx.from.id) return;

    // Solo: no non-striker required
    if (m.mode !== 'solo' && !inn.non_striker_player_id) return;

    const overNum = Math.floor(inn.balls_bowled / 6);
    const ballNum = (inn.balls_bowled % 6) + 1;

    await q(
      `UPDATE innings SET pending_bat_number=$2, ball_state='waiting_bowl' WHERE id=$1`,
      [inn.id, num]
    );

    const token = crypto.randomBytes(12).toString('base64url');
    const bowler = await getPlayer(inn.current_bowler_id);

    await q(
      `INSERT INTO pending_balls (match_id, innings_id, bowler_telegram_id, callback_token, bat_number, over_number, ball_number, batting_message_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [m.id, inn.id, bowler.telegram_id, token, num, overNum, ballNum, ctx.message.message_id]
    );

    const bowlerTag = `<a href="tg://user?id=${Number(bowler.telegram_id)}">${escapeHtml(name(bowler))}</a>`;
    await ctx.reply(
      `🔒 ${escapeHtml(name(striker))} ne shot khel liya!\n⏳ Bowler ${bowlerTag} DM mein number bhejega…`,
      {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([[Markup.button.url(`🎳 DM Bowler: ${name(bowler).slice(0, 35)}`, `tg://user?id=${Number(bowler.telegram_id)}`)]]),
      }
    );

    try {
      await ctx.telegram.sendMessage(
        Number(bowler.telegram_id),
        `🎳 *YOUR TURN TO BOWL*\n` +
          `${line()}\n` +
          `📍 ${m.group_title || 'Group'}\n` +
          `🏏 Striker: ${name(striker)}\n` +
          `⏱ Over: ${overNum}.${ballNum}\n\n` +
          `Number choose karo:`,
        { parse_mode: 'Markdown', ...bowlKb(token) }
      );
    } catch {
      await ctx.reply(
        `⚠️ ${name(bowler)} ne bot privately /start nahi kiya.\n` +
          `Bot open karke /start dabao, phir dubara try.`
      );
      await q(`UPDATE innings SET pending_bat_number=NULL, ball_state='idle' WHERE id=$1`, [
        inn.id,
      ]);
      await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1`, [token]);
    }
  } catch (e) {
    console.error(e);
  }
});

// ─── Bowl resolve ────────────────────────────────────────
bot.action(/^bowl:(.+):([1-6])$/, async (ctx) => {
  const token = ctx.match[1];
  const bowlNum = parseInt(ctx.match[2], 10);
  try {
    const { rows: pendRows } = await q(
      `SELECT * FROM pending_balls WHERE callback_token=$1 AND is_resolved=FALSE AND expires_at>NOW()`,
      [token]
    );
    const pend = pendRows[0];
    if (!pend) return ctx.answerCbQuery('Expired / used', { show_alert: true });
    if (Number(pend.bowler_telegram_id) !== ctx.from.id)
      return ctx.answerCbQuery('Not your ball', { show_alert: true });

    const upd = await q(
      `UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1 AND is_resolved=FALSE`,
      [token]
    );
    if (upd.rowCount === 0)
      return ctx.answerCbQuery('Already resolved', { show_alert: true });

    const { rows: innRows } = await q(`SELECT * FROM innings WHERE id=$1`, [pend.innings_id]);
    const inn = innRows[0];
    if (!inn || inn.ball_state !== 'waiting_bowl')
      return ctx.answerCbQuery('Invalid state', { show_alert: true });

    const m = await getMatch(pend.match_id);
    const batNum = pend.bat_number;
    const isWicket = batNum === bowlNum;
    const runs = isWicket ? 0 : batNum;
    const strikerId = inn.striker_player_id;
    const nonId = inn.non_striker_player_id;
    const bowlerId = inn.current_bowler_id;
    const isSolo = m.mode === 'solo';

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
        // Solo: stay on same striker unless out (then innings may end)
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

    await ctx.answerCbQuery('✅ Delivered!');
    try {
      await ctx.editMessageText(`✅ You bowled *${bowlNum}*`, { parse_mode: 'Markdown' });
    } catch {}

    const inn2 = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0];
    const groupId = Number(m.group_chat_id);

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
    const resultMessage = await ctx.telegram.sendMessage(groupId, ballMsg, { parse_mode: 'Markdown' });
    // Permanent GIF replies directly to the batsman's original 1-6 message, with result + short commentary caption.
    const gifReplyTo = Number(pend.batting_message_id) || resultMessage.message_id;
    const commentary = isWicket ? '💥 Bowler wins this battle!' : ({1:'👏 Smart single!',2:'⚡ Quick two!',3:'🏃 Great running!',4:'🔥 Beautiful boundary!',5:'💨 Excellent running!',6:'🚀 What a hit!'}[runs] || '🏏 Nice shot!');
    const gifCaption = isWicket ? '💥 <b>WICKET!</b>\n🎙️ Bowler wins this battle!' : `${runs === 6 ? '🚀' : runs === 4 ? '🔥' : '🏏'} <b>${runs} RUN${runs === 1 ? '' : 'S'}!</b>\n🎙️ ${commentary}`;
    if (isWicket) await sendResultGif(ctx.telegram, groupId, 'out', gifReplyTo, gifCaption);
    else if (runs > 0) await sendResultGif(ctx.telegram, groupId, String(runs), gifReplyTo, gifCaption);

    // Innings end?
    const batSide = await getPlayers(m.id, inn2.batting_team);
    const teamSize = isSolo
      ? Math.max(1, batSide.length)
      : m.team_size || 5;
    const maxBalls = (m.total_overs || 5) * 6;
    let ended =
      inn2.total_wickets >= teamSize || inn2.balls_bowled >= maxBalls;
    if (inn2.innings_number === 2 && m.target && inn2.total_runs >= m.target) ended = true;

    if (ended) {
      await q(`UPDATE innings SET is_completed=TRUE WHERE id=$1`, [inn2.id]);

      if (inn2.innings_number === 1) {
        const target = inn2.total_runs + 1;
        const bat2 = inn2.bowling_team;
        const bowl2 = inn2.batting_team;
        await q(
          `UPDATE matches SET status='innings2', current_innings=2,
           current_batting_team=$2, current_bowling_team=$3, target=$4 WHERE id=$1`,
          [m.id, bat2, bowl2, target]
        );
        await q(
          `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state)
           VALUES ($1,2,$2,$3,'idle')`,
          [m.id, bat2, bowl2]
        );

        let mid =
          `🏁 *END OF INNINGS 1*\n` +
          `${line()}\n` +
          (isSolo ? `Score: *${inn2.total_runs}/${inn2.total_wickets}*\n` : `Team ${inn2.batting_team}: *${inn2.total_runs}/${inn2.total_wickets}*\n`) +
          `🎯 Target for Team ${bat2}: *${target}*\n\n`;

        if (isSolo) {
          const m2 = await getMatch(m.id);
          let innNew = await getInnings(m.id);
          innNew = await soloAutoSetup(m2, innNew);
          const st = await getPlayer(innNew.striker_player_id);
          const bw = await getPlayer(innNew.current_bowler_id);
          mid +=
            `⚡ Solo auto-setup\n` +
            `🏏 ${name(st)} batting\n` +
            `🎳 ${name(bw)} bowling\n\n` +
            `👉 ${name(st)} type *1–6*!`;
        } else {
          mid += `Batting captain: /bat 1 · /bat 2\nBowling captain: /bowl 1`;
        }

        await ctx.telegram.sendMessage(groupId, mid, { parse_mode: 'Markdown' });
      } else {
        let text;
        if (inn2.total_runs >= m.target) {
          text = `🏆 *Team ${inn2.batting_team} WINS!*`;
          await q(
            `UPDATE matches SET status='completed', winner_team=$2, completed_at=NOW() WHERE id=$1`,
            [m.id, inn2.batting_team]
          );
        } else if (inn2.total_runs === m.target - 1) {
          text = `🤝 *MATCH TIED!*`;
          await q(
            `UPDATE matches SET status='completed', winner_team='tie', completed_at=NOW() WHERE id=$1`,
            [m.id]
          );
        } else {
          const margin = m.target - 1 - inn2.total_runs;
          text = `🏆 *Team ${inn2.bowling_team} WINS by ${margin} runs!*`;
          await q(
            `UPDATE matches SET status='completed', winner_team=$2, completed_at=NOW() WHERE id=$1`,
            [m.id, inn2.bowling_team]
          );
        }
        await ctx.telegram.sendMessage(groupId, text, { parse_mode: 'Markdown' });
      }
    } else {
      // Continue play prompts
      if (isSolo && isWicket && !ended) {
        // Auto next batsman on same side
        const mReload = await getMatch(m.id);
        let innNew = await soloAutoSetup(mReload, inn2);
        const st = await getPlayer(innNew.striker_player_id);
        if (st) {
          await ctx.telegram.sendMessage(
            groupId,
            `🔄 Next batsman: *${name(st)}*\n👉 Type *1–6*`,
            { parse_mode: 'Markdown' }
          );
        }
      } else if (!isSolo && isWicket && !inn2.striker_player_id) {
        await ctx.telegram.sendMessage(
          groupId,
          `👑 Team ${inn2.batting_team} captain: next batsman → /bat <n>`
        );
      } else if (!isSolo && inn2.balls_bowled > 0 && inn2.balls_bowled % 6 === 0) {
        await ctx.telegram.sendMessage(
          groupId,
          `🔔 Over complete!\n👑 Team ${inn2.bowling_team}: /bowl <n>`
        );
      } else if (isSolo && !isWicket) {
        const st = await getPlayer(inn2.striker_player_id);
        await ctx.telegram.sendMessage(
          groupId,
          `👉 ${name(st)} next ball: type *1–6*`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    await ctx.telegram.sendMessage(groupId, await scoreboard(m.id), {
      parse_mode: 'Markdown',
    });
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery('Error', { show_alert: true });
  }
});

// ─── Launch ──────────────────────────────────────────────
async function main() {
  await q('SELECT 1');
  await q('ALTER TABLE pending_balls ADD COLUMN IF NOT EXISTS batting_message_id BIGINT');
  await q(`CREATE TABLE IF NOT EXISTS pgif_settings (
    result_key TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    media_type TEXT NOT NULL DEFAULT 'animation',
    updated_by TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  console.log('DB OK');
  const me = await bot.telegram.getMe();
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
