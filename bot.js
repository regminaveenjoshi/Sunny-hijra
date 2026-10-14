/**
 * Hand Cricket Telegram Bot — Single file (bot.js)
 * Node.js + Telegraf + PostgreSQL (Supabase)
 *
 * Setup:
 * 1. npm install
 * 2. Copy .env.example → .env (BOT_TOKEN + DATABASE_URL)
 * 3. Run schema SQL once on Supabase (see bottom of this file)
 * 4. npm start
 */
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const crypto = require('crypto');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
if (!BOT_TOKEN || !DATABASE_URL) {
  console.error('Set BOT_TOKEN and DATABASE_URL in .env');
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

// ─── DB helpers ──────────────────────────────────────────
async function q(text, params = []) {
  return pool.query(text, params);
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
  const { rows } = await q(`SELECT * FROM match_teams WHERE match_id=$1 AND team_label=$2`, [matchId, label]);
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

function name(p) {
  if (!p) return '?';
  return p.username ? `@${p.username}` : p.first_name || `User${p.telegram_id}`;
}

function oversStr(balls) {
  return `${Math.floor(balls / 6)}.${balls % 6}`;
}

function isGroup(ctx) {
  return ctx.chat && (ctx.chat.type === 'group' || ctx.chat.type === 'supergroup');
}

// ─── Keyboards ───────────────────────────────────────────
const mainKb = () =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🎮 SOLO', 'm:solo'), Markup.button.callback('👥 TEAM', 'm:team')],
    [Markup.button.callback('👤 PROFILE', 'm:profile'), Markup.button.callback('🏆 BOARD', 'm:lb')],
    [Markup.button.callback('📖 HOW TO PLAY', 'm:help')],
  ]);

const tossKb = (id) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('🏏 BAT FIRST', `toss:${id}:bat`), Markup.button.callback('🎳 BOWL FIRST', `toss:${id}:bowl`)],
  ]);

const bowlKb = (token) =>
  Markup.inlineKeyboard([
    [Markup.button.callback('1️⃣', `bowl:${token}:1`), Markup.button.callback('2️⃣', `bowl:${token}:2`), Markup.button.callback('3️⃣', `bowl:${token}:3`)],
    [Markup.button.callback('4️⃣', `bowl:${token}:4`), Markup.button.callback('5️⃣', `bowl:${token}:5`), Markup.button.callback('6️⃣', `bowl:${token}:6`)],
  ]);

// ─── Scoreboard ──────────────────────────────────────────
async function scoreboard(matchId) {
  const match = await getMatch(matchId);
  if (!match) return 'No match';
  const inn = await getInnings(matchId);
  let t = '🏏 HAND CRICKET — LIVE\n\n';
  if (['completed', 'cancelled'].includes(match.status)) {
    t += `Status: ${match.status}\n`;
    if (match.winner_team) t += `Winner: Team ${match.winner_team}`;
    return t;
  }
  if (!inn) return t + 'Waiting…';
  const bat = inn.batting_team;
  const bowl = inn.bowling_team;
  t += `Team ${bat}: ${inn.total_runs}/${inn.total_wickets}\n`;
  t += `Overs: ${oversStr(inn.balls_bowled)}/${match.total_overs}\n`;
  if (match.target && inn.innings_number === 2) t += `Target: ${match.target} (Need ${Math.max(0, match.target - inn.total_runs)})\n`;

  const striker = await getPlayer(inn.striker_player_id);
  const non = await getPlayer(inn.non_striker_player_id);
  const bowler = await getPlayer(inn.current_bowler_id);
  if (striker) t += `\n🏏 Striker: ${name(striker)}`;
  if (non) t += `\n🧍🏻 Non-striker: ${name(non)}`;
  if (bowler) t += `\n🎳 Bowler: ${name(bowler)}`;

  t += `\n\nTEAM ${bat} BATTING\n`;
  const bats = await getPlayers(matchId, bat);
  for (const p of bats) {
    let e = '⚪';
    if (striker && p.id === striker.id) e = '🏏';
    else if (non && p.id === non.id) e = '🧍🏻';
    const { rows: st } = await q(`SELECT * FROM batting_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, p.id]);
    if (st[0]?.is_out) e = '❌';
    t += `${p.roster_position}. ${e} ${name(p)}${st[0] ? ` (${st[0].runs})` : ''}\n`;
  }

  t += `\nTEAM ${bowl} BOWLING\n`;
  const bowls = await getPlayers(matchId, bowl);
  for (const p of bowls) {
    let e = '🟢';
    if (bowler && p.id === bowler.id) e = '🎳';
    const { rows: st } = await q(`SELECT * FROM bowling_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, p.id]);
    const bb = st[0]?.balls_bowled || 0;
    if (bb / 6 >= (match.max_overs_per_bowler || MAX_BOWLER_OVERS)) e = '✅';
    t += `${p.roster_position}. ${e} ${name(p)}${bb ? ` (${oversStr(bb)})` : ''}\n`;
  }
  return t;
}

// ─── /start ──────────────────────────────────────────────
bot.start(async (ctx) => {
  await upsertUser(ctx.from);
  await ctx.reply(
    '🏏 *HAND CRICKET*\n\nGroup mein match banao.\nPehle yahan /start dabao (bowling DM ke liye zaroori).',
    { parse_mode: 'Markdown', ...mainKb() }
  );
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *How to play*\n\n` +
      `Group: /startsolo ya /startteam\n` +
      `/joinsolo · /join_a · /join_b\n` +
      `/setcaptain_a 1 · /startmatch\n` +
      `/bat 1 · /bowl 1\n` +
      `Striker: group mein 1-6 type karo\n` +
      `Bowler: private buttons se number choose\n` +
      `Same number = OUT`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('m:solo', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Group mein bhejo: `/startsolo`', { parse_mode: 'Markdown' });
});
bot.action('m:team', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Group mein bhejo: `/startteam` ya `/startteam 5 5`', { parse_mode: 'Markdown' });
});
bot.action('m:help', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Group: /startsolo or /startteam → join → /startmatch → /bat /bowl → type 1-6');
});
bot.action('m:profile', async (ctx) => {
  await ctx.answerCbQuery();
  await upsertUser(ctx.from);
  const { rows } = await q(`SELECT * FROM users WHERE telegram_id=$1`, [ctx.from.id]);
  const u = rows[0] || {};
  await ctx.reply(
    `👤 ${ctx.from.username || ctx.from.first_name}\nMatches: ${u.matches_played || 0}\nWon: ${u.matches_won || 0}\nRuns: ${u.total_runs || 0}`
  );
});
bot.action('m:lb', async (ctx) => {
  await ctx.answerCbQuery();
  const { rows } = await q(
    `SELECT username, first_name, matches_won, matches_played, total_runs FROM users WHERE matches_played>0 ORDER BY matches_won DESC LIMIT 10`
  );
  if (!rows.length) return ctx.reply('No data yet');
  let t = '🏆 Leaderboard\n';
  rows.forEach((r, i) => {
    t += `${i + 1}. ${r.username ? '@' + r.username : r.first_name} — ${r.matches_won}W · ${r.total_runs} runs\n`;
  });
  await ctx.reply(t);
});

// ─── Create Solo ─────────────────────────────────────────
bot.command('startsolo', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Group mein use karo');
  try {
    const existing = await getActiveMatch(ctx.chat.id);
    if (existing) return ctx.reply('Pehle /endmatch karo');

    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'solo',$3,1,$4,$5,'waiting') RETURNING *`,
      [ctx.chat.id, ctx.chat.title || null, ctx.from.id, DEFAULT_OVERS, MAX_BOWLER_OVERS]
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
    await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label='A'`, [m.id, ctx.from.id]);
    await upsertUser(ctx.from);
    await ctx.reply(
      `🏏 SOLO MATCH\n👑 Host: ${name(ctx.from)}\nStatus: Waiting\n\n/joinsolo se join karo\nPlayers 1/2\nHost: /startmatch`
    );
  } catch (e) {
    console.error(e);
    await ctx.reply('Error: ' + e.message);
  }
});

bot.command('joinsolo', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.mode !== 'solo' || m.status !== 'waiting') return ctx.reply('No solo match waiting');
    if (Number(m.host_telegram_id) === ctx.from.id) return ctx.reply('You are host');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('Already in');
    const pl = await getPlayers(m.id);
    if (pl.length >= 2) return ctx.reply('Full');
    await q(
      `INSERT INTO match_players (match_id, telegram_id, team_label, roster_position, username, first_name, is_captain)
       VALUES ($1,$2,'B',1,$3,$4,TRUE)`,
      [m.id, ctx.from.id, ctx.from.username || null, ctx.from.first_name || null]
    );
    await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label='B'`, [m.id, ctx.from.id]);
    await upsertUser(ctx.from);
    await ctx.reply(`✅ ${name(ctx.from)} joined! 2/2\nHost: /startmatch`);
  } catch (e) {
    await ctx.reply(e.message);
  }
});

// ─── Create Team ─────────────────────────────────────────
bot.command('startteam', async (ctx) => {
  if (!isGroup(ctx)) return ctx.reply('Group mein use karo');
  try {
    if (await getActiveMatch(ctx.chat.id)) return ctx.reply('Pehle /endmatch');
    const parts = ctx.message.text.split(/\s+/).slice(1);
    const size = parseInt(parts[0], 10) || DEFAULT_TEAM_SIZE;
    const overs = parseInt(parts[1], 10) || DEFAULT_OVERS;
    const { rows } = await q(
      `INSERT INTO matches (group_chat_id, group_title, mode, host_telegram_id, team_size, total_overs, max_overs_per_bowler, status)
       VALUES ($1,$2,'team',$3,$4,$5,$6,'waiting') RETURNING *`,
      [ctx.chat.id, ctx.chat.title || null, ctx.from.id, size, overs, Math.min(MAX_BOWLER_OVERS, overs)]
    );
    const m = rows[0];
    for (const L of ['A', 'B']) await q(`INSERT INTO match_teams (match_id, team_label) VALUES ($1,$2)`, [m.id, L]);
    await upsertUser(ctx.from);
    await ctx.reply(
      `🏏 TEAM MATCH\nSize: ${size} | Overs: ${overs}\n\n/join_a · /join_b\nHost: /setcaptain_a 1 · /startmatch`
    );
  } catch (e) {
    await ctx.reply(e.message);
  }
});

async function joinTeam(ctx, label) {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || m.status !== 'waiting' || m.mode === 'solo') return ctx.reply('No team match waiting');
    if (await getPlayerByTg(m.id, ctx.from.id)) return ctx.reply('Already joined');
    const team = await getPlayers(m.id, label);
    if (team.length >= m.team_size) return ctx.reply(`Team ${label} full`);
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
    await ctx.reply(`✅ ${name(ctx.from)} → Team ${label} (${team.length + 1}/${m.team_size})`);
  } catch (e) {
    await ctx.reply(e.message);
  }
}
bot.command('join_a', (ctx) => joinTeam(ctx, 'A'));
bot.command('join_b', (ctx) => joinTeam(ctx, 'B'));

bot.command('setcaptain_a', async (ctx) => setCap(ctx, 'A'));
bot.command('setcaptain_b', async (ctx) => setCap(ctx, 'B'));

async function setCap(ctx, label) {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m || Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('Only host');
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply(`Usage: /setcaptain_${label.toLowerCase()} <position>`);
  const p = await getPlayerByPos(m.id, label, pos);
  if (!p) return ctx.reply('Player not found');
  await q(`UPDATE match_players SET is_captain=FALSE WHERE match_id=$1 AND team_label=$2`, [m.id, label]);
  await q(`UPDATE match_players SET is_captain=TRUE WHERE id=$1`, [p.id]);
  await q(`UPDATE match_teams SET captain_id=$2 WHERE match_id=$1 AND team_label=$3`, [m.id, p.telegram_id, label]);
  await q(`UPDATE matches SET status='captains' WHERE id=$1`, [m.id]);
  await ctx.reply(`👑 Team ${label} captain: ${name(p)}`);
}

bot.command('team', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('No match');
  let t = `Match ${m.mode} | ${m.status}\n`;
  for (const L of ['A', 'B']) {
    const team = await getTeam(m.id, L);
    const pl = await getPlayers(m.id, L);
    t += `\nTeam ${L} (${pl.length}/${m.team_size})\n`;
    for (const p of pl) {
      t += `  ${p.roster_position}. ${name(p)}${Number(p.telegram_id) === Number(team?.captain_id) ? ' 👑' : ''}\n`;
    }
  }
  await ctx.reply(t);
});

bot.command('endmatch', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('No match');
  if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('Only host');
  await q(`UPDATE matches SET status='cancelled' WHERE id=$1`, [m.id]);
  await ctx.reply('🛑 Match cancelled');
});

// ─── Start match + Toss ──────────────────────────────────
bot.command('startmatch', async (ctx) => {
  if (!isGroup(ctx)) return;
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m) return ctx.reply('No match');
    if (Number(m.host_telegram_id) !== ctx.from.id) return ctx.reply('Only host');
    const a = await getPlayers(m.id, 'A');
    const b = await getPlayers(m.id, 'B');
    if (!a.length || !b.length) return ctx.reply('Both teams need players');
    if (m.mode === 'team') {
      const tA = await getTeam(m.id, 'A');
      const tB = await getTeam(m.id, 'B');
      if (!tA?.captain_id || !tB?.captain_id) return ctx.reply('Set both captains first');
    }
    const winner = Math.random() < 0.5 ? 'A' : 'B';
    await q(`UPDATE matches SET status='toss', toss_winner_team=$2 WHERE id=$1`, [m.id, winner]);
    await ctx.reply(`🪙 TOSS\nTeam ${winner} wins!\nChoose:`, tossKb(m.id));
  } catch (e) {
    await ctx.reply(e.message);
  }
});

bot.action(/^toss:(.+):(bat|bowl)$/, async (ctx) => {
  const matchId = ctx.match[1];
  const choice = ctx.match[2];
  try {
    const m = await getMatch(matchId);
    if (!m || m.status !== 'toss') return ctx.answerCbQuery('Invalid', { show_alert: true });
    const team = await getTeam(m.id, m.toss_winner_team);
    if (Number(team?.captain_id) !== ctx.from.id) {
      const pl = await getPlayers(m.id, m.toss_winner_team);
      if (!pl.some((p) => Number(p.telegram_id) === ctx.from.id)) {
        return ctx.answerCbQuery('Only toss winner captain', { show_alert: true });
      }
    }
    const batFirst = choice === 'bat' ? m.toss_winner_team : m.toss_winner_team === 'A' ? 'B' : 'A';
    const bowlFirst = batFirst === 'A' ? 'B' : 'A';
    await q(
      `UPDATE matches SET batting_first_team=$2, current_batting_team=$2, current_bowling_team=$3, current_innings=1, status='innings1' WHERE id=$1`,
      [m.id, batFirst, bowlFirst]
    );
    await q(
      `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state) VALUES ($1,1,$2,$3,'idle')`,
      [m.id, batFirst, bowlFirst]
    );
    await ctx.editMessageText(
      `✅ Team ${m.toss_winner_team} chose ${choice.toUpperCase()}\n🏏 Team ${batFirst} bats\n🎳 Team ${bowlFirst} bowls\n\n/bat 1 then /bat 2\nThen /bowl 1`
    );
    await ctx.answerCbQuery();
  } catch (e) {
    await ctx.answerCbQuery(e.message, { show_alert: true });
  }
});

// ─── /bat /bowl ──────────────────────────────────────────
bot.command('bat', async (ctx) => {
  if (!isGroup(ctx)) return;
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply('Usage: /bat 1');
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status)) return ctx.reply('Match not in progress');
    const inn = await getInnings(m.id);
    if (!inn || !['idle', 'waiting_bat'].includes(inn.ball_state)) return ctx.reply('Wait for current ball');
    const team = await getTeam(m.id, inn.batting_team);
    if (Number(team?.captain_id) !== ctx.from.id) return ctx.reply('Only batting captain');
    const p = await getPlayerByPos(m.id, inn.batting_team, pos);
    if (!p) return ctx.reply('Invalid position');
    const { rows: st } = await q(`SELECT * FROM batting_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, p.id]);
    if (st[0]?.is_out) return ctx.reply('Already out');
    if (p.id === inn.striker_player_id || p.id === inn.non_striker_player_id) return ctx.reply('Already batting');

    await q(
      `INSERT INTO batting_stats (innings_id, player_id) VALUES ($1,$2) ON CONFLICT (innings_id, player_id) DO NOTHING`,
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
    await ctx.reply(`🏏 ${name(p)} → ${role}`);
    const inn2 = await getInnings(m.id);
    if (inn2.striker_player_id && inn2.non_striker_player_id && !inn2.current_bowler_id) {
      await ctx.reply('Bowling captain: /bowl <n>');
    }
    await ctx.reply(await scoreboard(m.id));
  } catch (e) {
    await ctx.reply(e.message);
  }
});

bot.command('bowl', async (ctx) => {
  if (!isGroup(ctx)) return;
  const pos = parseInt((ctx.message.text.split(/\s+/)[1] || ''), 10);
  if (!pos) return ctx.reply('Usage: /bowl 1');
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status)) return ctx.reply('Match not in progress');
    const inn = await getInnings(m.id);
    if (!inn || inn.ball_state !== 'idle') return ctx.reply('Wait');
    if (!inn.striker_player_id || !inn.non_striker_player_id) return ctx.reply('Select 2 batsmen first');
    const team = await getTeam(m.id, inn.bowling_team);
    if (Number(team?.captain_id) !== ctx.from.id) return ctx.reply('Only bowling captain');
    const p = await getPlayerByPos(m.id, inn.bowling_team, pos);
    if (!p) return ctx.reply('Invalid position');
    const { rows: st } = await q(`SELECT * FROM bowling_stats WHERE innings_id=$1 AND player_id=$2`, [inn.id, p.id]);
    const bb = st[0]?.balls_bowled || 0;
    if (bb / 6 >= (m.max_overs_per_bowler || MAX_BOWLER_OVERS)) return ctx.reply('Overs complete');
    if (inn.last_bowler_id === p.id && inn.balls_bowled % 6 === 0 && bb > 0) return ctx.reply('No consecutive overs');

    await q(
      `INSERT INTO bowling_stats (innings_id, player_id) VALUES ($1,$2) ON CONFLICT (innings_id, player_id) DO NOTHING`,
      [inn.id, p.id]
    );
    await q(`UPDATE innings SET current_bowler_id=$2 WHERE id=$1`, [inn.id, p.id]);
    await ctx.reply(`🎳 ${name(p)} bowling\nStriker: type 1-6 in group`);
    await ctx.reply(await scoreboard(m.id));
  } catch (e) {
    await ctx.reply(e.message);
  }
});

bot.command('score', async (ctx) => {
  if (!isGroup(ctx)) return;
  const m = await getActiveMatch(ctx.chat.id);
  if (!m) return ctx.reply('No match');
  await ctx.reply(await scoreboard(m.id));
});

// ─── Bat number 1-6 ──────────────────────────────────────
bot.hears(/^[1-6]$/, async (ctx) => {
  if (!isGroup(ctx)) return;
  const num = parseInt(ctx.message.text, 10);
  try {
    const m = await getActiveMatch(ctx.chat.id);
    if (!m || !['innings1', 'innings2'].includes(m.status)) return;
    const inn = await getInnings(m.id);
    if (!inn || inn.ball_state !== 'idle' || !inn.current_bowler_id || !inn.striker_player_id) return;
    const striker = await getPlayer(inn.striker_player_id);
    if (!striker || Number(striker.telegram_id) !== ctx.from.id) return;

    const overNum = Math.floor(inn.balls_bowled / 6);
    const ballNum = (inn.balls_bowled % 6) + 1;
    await q(`UPDATE innings SET pending_bat_number=$2, ball_state='waiting_bowl' WHERE id=$1`, [inn.id, num]);

    const token = crypto.randomBytes(12).toString('base64url');
    const bowler = await getPlayer(inn.current_bowler_id);
    await q(
      `INSERT INTO pending_balls (match_id, innings_id, bowler_telegram_id, callback_token, bat_number, over_number, ball_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [m.id, inn.id, bowler.telegram_id, token, num, overNum, ballNum]
    );

    await ctx.reply(`🔒 ${name(striker)} played!\nWaiting for ${name(bowler)}…`);
    try {
      await ctx.telegram.sendMessage(
        Number(bowler.telegram_id),
        `🎳 Deliver the ball!\nGroup: ${m.group_title || 'Group'}\nStriker: ${name(striker)}\nOver: ${overNum}.${ballNum}\nChoose:`,
        bowlKb(token)
      );
    } catch {
      await ctx.reply(`⚠️ ${name(bowler)} ne bot /start nahi kiya privately.`);
      await q(`UPDATE innings SET pending_bat_number=NULL, ball_state='idle' WHERE id=$1`, [inn.id]);
      await q(`UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1`, [token]);
    }
  } catch (e) {
    console.error(e);
  }
});

// ─── Bowl callback ───────────────────────────────────────
bot.action(/^bowl:(.+):([1-6])$/, async (ctx) => {
  const token = ctx.match[1];
  const bowlNum = parseInt(ctx.match[2], 10);
  try {
    const { rows: pendRows } = await q(
      `SELECT * FROM pending_balls WHERE callback_token=$1 AND is_resolved=FALSE AND expires_at>NOW()`,
      [token]
    );
    const pend = pendRows[0];
    if (!pend) return ctx.answerCbQuery('Expired / already used', { show_alert: true });
    if (Number(pend.bowler_telegram_id) !== ctx.from.id) return ctx.answerCbQuery('Not your ball', { show_alert: true });

    const upd = await q(
      `UPDATE pending_balls SET is_resolved=TRUE WHERE callback_token=$1 AND is_resolved=FALSE`,
      [token]
    );
    if (upd.rowCount === 0) return ctx.answerCbQuery('Already resolved', { show_alert: true });

    const { rows: innRows } = await q(`SELECT * FROM innings WHERE id=$1`, [pend.innings_id]);
    const inn = innRows[0];
    if (!inn || inn.ball_state !== 'waiting_bowl') return ctx.answerCbQuery('Invalid state', { show_alert: true });
    const m = await getMatch(pend.match_id);

    const batNum = pend.bat_number;
    const isWicket = batNum === bowlNum;
    const runs = isWicket ? 0 : batNum;
    const strikerId = inn.striker_player_id;
    const nonId = inn.non_striker_player_id;
    const bowlerId = inn.current_bowler_id;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO deliveries (innings_id, over_number, ball_number, batsman_id, bowler_id, bat_number, bowl_number, runs_scored, is_wicket)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [inn.id, pend.over_number, pend.ball_number, strikerId, bowlerId, batNum, bowlNum, runs, isWicket]
      );
      if (isWicket) {
        await client.query(
          `UPDATE batting_stats SET balls_faced=balls_faced+1, is_out=TRUE, dismissal_type='bowled' WHERE innings_id=$1 AND player_id=$2`,
          [inn.id, strikerId]
        );
      } else {
        await client.query(
          `UPDATE batting_stats SET runs=runs+$3, balls_faced=balls_faced+1, fours=fours+$4, sixes=sixes+$5 WHERE innings_id=$1 AND player_id=$2`,
          [inn.id, strikerId, runs, runs === 4 ? 1 : 0, runs === 6 ? 1 : 0]
        );
      }
      await client.query(
        `UPDATE bowling_stats SET balls_bowled=balls_bowled+1, runs_conceded=runs_conceded+$3, wickets=wickets+$4, overs_bowled=(balls_bowled+1)/6.0 WHERE innings_id=$1 AND player_id=$2`,
        [inn.id, bowlerId, runs, isWicket ? 1 : 0]
      );

      let newStriker = strikerId;
      let newNon = nonId;
      if (isWicket) newStriker = null;
      else if (runs % 2 === 1) {
        newStriker = nonId;
        newNon = strikerId;
      }
      const newBalls = inn.balls_bowled + 1;
      const endOver = newBalls % 6 === 0;
      if (endOver && !isWicket) {
        const tmp = newStriker;
        newStriker = newNon;
        newNon = tmp;
      }
      await client.query(
        `UPDATE innings SET total_runs=$2, total_wickets=$3, balls_bowled=$4,
         striker_player_id=$5, non_striker_player_id=$6, current_bowler_id=$7, last_bowler_id=$8,
         pending_bat_number=NULL, ball_state='idle' WHERE id=$1`,
        [
          inn.id,
          inn.total_runs + runs,
          inn.total_wickets + (isWicket ? 1 : 0),
          newBalls,
          newStriker,
          newNon,
          endOver ? null : bowlerId,
          endOver ? bowlerId : inn.last_bowler_id || bowlerId,
        ]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    await ctx.answerCbQuery('Done!');
    try {
      await ctx.editMessageText(`✅ You bowled ${bowlNum}`);
    } catch {}

    const inn2 = (await q(`SELECT * FROM innings WHERE id=$1`, [inn.id])).rows[0];
    const groupId = Number(m.group_chat_id);
    let msg = isWicket
      ? `💥 WICKET!\nBat: ${batNum} · Bowl: ${bowlNum}\nTeam ${inn2.batting_team}: ${inn2.total_runs}/${inn2.total_wickets}`
      : `🏏 ${runs} run(s)!\nBat: ${batNum} · Bowl: ${bowlNum}\nTeam ${inn2.batting_team}: ${inn2.total_runs}/${inn2.total_wickets}`;
    msg += `\nOvers: ${oversStr(inn2.balls_bowled)}`;
    await ctx.telegram.sendMessage(groupId, msg);

    // Innings / match end check
    const teamSize = m.team_size || 5;
    const maxBalls = (m.total_overs || 5) * 6;
    let ended = inn2.total_wickets >= teamSize || inn2.balls_bowled >= maxBalls;
    if (inn2.innings_number === 2 && m.target && inn2.total_runs >= m.target) ended = true;

    if (ended) {
      await q(`UPDATE innings SET is_completed=TRUE WHERE id=$1`, [inn2.id]);
      if (inn2.innings_number === 1) {
        const target = inn2.total_runs + 1;
        const bat2 = inn2.bowling_team;
        const bowl2 = inn2.batting_team;
        await q(
          `UPDATE matches SET status='innings2', current_innings=2, current_batting_team=$2, current_bowling_team=$3, target=$4 WHERE id=$1`,
          [m.id, bat2, bowl2, target]
        );
        await q(
          `INSERT INTO innings (match_id, innings_number, batting_team, bowling_team, ball_state) VALUES ($1,2,$2,$3,'idle')`,
          [m.id, bat2, bowl2]
        );
        await ctx.telegram.sendMessage(
          groupId,
          `🏁 Innings 1 over\nTeam ${inn2.batting_team}: ${inn2.total_runs}/${inn2.total_wickets}\nTarget: ${target}\n\n/bat 1 · /bat 2 · /bowl 1`
        );
      } else {
        let winner, text;
        if (inn2.total_runs >= m.target) {
          winner = inn2.batting_team;
          text = `🏆 Team ${winner} wins!`;
        } else if (inn2.total_runs === m.target - 1) {
          winner = 'tie';
          text = '🤝 Tied!';
        } else {
          winner = inn2.bowling_team;
          text = `🏆 Team ${winner} wins by ${m.target - 1 - inn2.total_runs} runs!`;
        }
        await q(`UPDATE matches SET status='completed', winner_team=$2, completed_at=NOW() WHERE id=$1`, [
          m.id,
          winner === 'tie' ? 'tie' : winner,
        ]);
        await ctx.telegram.sendMessage(groupId, text);
      }
    } else {
      if (isWicket && !inn2.striker_player_id) {
        await ctx.telegram.sendMessage(groupId, `👑 Team ${inn2.batting_team} captain: /bat <n>`);
      }
      if (inn2.balls_bowled > 0 && inn2.balls_bowled % 6 === 0 && !isWicket) {
        await ctx.telegram.sendMessage(groupId, `Over done!\n👑 Team ${inn2.bowling_team}: /bowl <n>`);
      }
    }
    await ctx.telegram.sendMessage(groupId, await scoreboard(m.id));
  } catch (e) {
    console.error(e);
    await ctx.answerCbQuery('Error', { show_alert: true });
  }
});

// ─── Launch ──────────────────────────────────────────────
async function main() {
  await q('SELECT 1');
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

/*
========== SUPABASE: SQL Editor mein EK BAAR run karo ==========

Paste the full schema from database/schema.sql of the full project,
OR minimal tables below if you prefer:

-- (Use the complete schema.sql from the zip for production)

Same schema as Python/full JS version — users, matches, match_teams,
match_players, innings, batting_stats, bowling_stats, deliveries,
pending_balls, match_events.
*/
