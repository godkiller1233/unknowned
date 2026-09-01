import test from 'node:test';
import assert from 'node:assert/strict';

// ── Stubs so the game engine runs standalone ─────────────────────────────────
const posted = [];
const botGames = new Map();
const postBotMessage = async (_channelId, _botId, body) => { posted.push(body); return { id: 'm', body }; };

// ── Game engine (mirror of server/index.js) ──────────────────────────────────
const TRIVIA_POOL = [
  { q:'What planet is known as the Red Planet?', o:['Mars','Venus','Jupiter','Mercury'], a:0 },
  { q:'How many continents are there?', o:['5','6','7','8'], a:2 },
  { q:'What is the largest ocean on Earth?', o:['Atlantic','Indian','Arctic','Pacific'], a:3 },
  { q:'Who painted the Mona Lisa?', o:['Van Gogh','Da Vinci','Picasso','Rembrandt'], a:1 },
];
function shuffleArr(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function scoresText(scores, names) {
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'no scores yet — play a game!';
  return entries.map(([uid, s]) => `${names?.[uid] || uid}: ${s}`).join(' · ');
}
function tttBoard(board) {
  const cell = i => board[i] ? (board[i] === 'X' ? '❌' : '⭕') : String(i + 1);
  return `${cell(0)} | ${cell(1)} | ${cell(2)}\n─────────\n${cell(3)} | ${cell(4)} | ${cell(5)}\n─────────\n${cell(6)} | ${cell(7)} | ${cell(8)}`;
}
function tttWin(board) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,c] of lines) if (board[a] && board[a] === board[b] && board[a] === board[c]) return board[a];
  return null;
}
function tttBotMove(board) {
  const empty = board.map((v,i) => v ? null : i).filter(v => v !== null);
  const winFor = mark => { for (const i of empty) { const b = board.slice(); b[i] = mark; if (tttWin(b) === mark) return i; } return -1; };
  const w = winFor('O'); if (w >= 0) return w;
  const b = winFor('X'); if (b >= 0) return b;
  return empty[Math.floor(Math.random() * empty.length)];
}

async function runBotGame(cmd, commandName, argText, channelId, replyToId, user) {
  const kind = (String(cmd.response).match(/{{game:([^}]+)}}/) || [])[1] || '';
  const bot = cmd.bot_nickname || cmd.bot_username || 'Bot';
  let game = botGames.get(channelId);
  const touchNames = () => { if (!game) return; game.names = game.names || {}; if (user) game.names[user.id] = user.username; };

  if (kind === 'trivia' || kind === 'trivia_answer') {
    if (!game || game.type !== 'trivia' || game.done) {
      game = { type:'trivia', questions: shuffleArr(TRIVIA_POOL).slice(0, 2), qi: 0, scores: {}, names: {}, done: false };
      botGames.set(channelId, game);
    }
    touchNames();
    if (kind === 'trivia') {
      if (game.qi >= game.questions.length) {
        game.done = true;
        await postBotMessage(channelId, cmd.bot_id, `🏁 Trivia over! Scores: ${scoresText(game.scores, game.names)}`, replyToId);
        botGames.delete(channelId);
        return;
      }
      const q = game.questions[game.qi];
      await postBotMessage(channelId, cmd.bot_id,
        `🧠 ${bot} — Q${game.qi + 1}/${game.questions.length}: ${q.q}\n${q.o.map((o, i) => `${i + 1}. ${o}`).join('\n')}\nAnswer with /answer <text or number>`, replyToId);
      return;
    }
    if (game.qi >= game.questions.length) {
      await postBotMessage(channelId, cmd.bot_id, 'No active question — start one with /trivia', replyToId);
      return;
    }
    const q = game.questions[game.qi];
    const ans = String(argText || '').trim().toLowerCase();
    const correct = ans === q.o[q.a].toLowerCase() || ans === String(q.a + 1) || ans === String.fromCharCode(97 + q.a);
    if (!correct) {
      await postBotMessage(channelId, cmd.bot_id, `❌ Not it, ${user?.username || 'friend'} — guess again!`, replyToId);
      return;
    }
    game.scores[user.id] = (game.scores[user.id] || 0) + 10;
    touchNames();
    game.qi++;
    if (game.qi >= game.questions.length) {
      game.done = true;
      await postBotMessage(channelId, cmd.bot_id, `✅ ${user.username} got it! +10 🏁 Trivia over! Scores: ${scoresText(game.scores, game.names)}`, replyToId);
      botGames.delete(channelId);
      return;
    }
    const nq = game.questions[game.qi];
    await postBotMessage(channelId, cmd.bot_id,
      `✅ ${user.username} got it! +10 · Scores: ${scoresText(game.scores, game.names)}\n\nNext — Q${game.qi + 1}/${game.questions.length}: ${nq.q}\n${nq.o.map((o, i) => `${i + 1}. ${o}`).join('\n')}`, replyToId);
    return;
  }

  if (kind === 'ttt' || kind === 'ttt_move') {
    if (kind === 'ttt') {
      if (game && game.type === 'ttt' && !game.over) {
        await postBotMessage(channelId, cmd.bot_id, 'A tic-tac-toe game is already running! Move with /move 1-9', replyToId);
        return;
      }
      game = { type:'ttt', board: Array(9).fill(null), turn:'X', players: { X: user.id, O: null }, scores: {}, names: {}, over: false, vsBot: true };
      touchNames();
      botGames.set(channelId, game);
      await postBotMessage(channelId, cmd.bot_id,
        `🎮 ${bot} — tic-tac-toe (you vs me)\n${tttBoard(game.board)}\nX goes first — /move 1-9`, replyToId);
      return;
    }
    if (!game || game.type !== 'ttt' || game.over) {
      await postBotMessage(channelId, cmd.bot_id, 'No active game — start one with /ttt [@user]', replyToId);
      return;
    }
    touchNames();
    const idx = parseInt(argText, 10) - 1;
    if (isNaN(idx) || idx < 0 || idx > 8 || game.board[idx]) {
      await postBotMessage(channelId, cmd.bot_id, 'Invalid move — /move 1-9 on an empty cell', replyToId);
      return;
    }
    const current = game.turn === 'X' ? game.players.X : game.players.O;
    if (current && current !== user.id) {
      await postBotMessage(channelId, cmd.bot_id, `Not your turn — it's ${game.turn}'s move`, replyToId);
      return;
    }
    const finish = async (msg, del) => { game.over = true; await postBotMessage(channelId, cmd.bot_id, msg, replyToId); if (del) botGames.delete(channelId); };
    const place = async (mark, i) => {
      game.board[i] = mark;
      const win = tttWin(game.board);
      if (win) {
        if (win === 'X' && game.players.X) game.scores[game.players.X] = (game.scores[game.players.X] || 0) + 10;
        if (win === 'O' && game.players.O) game.scores[game.players.O] = (game.scores[game.players.O] || 0) + 10;
        const winnerName = win === 'X' ? (game.names[game.players.X] || 'X') : bot;
        await finish(`🏆 ${winnerName} wins with ${win}! +10\n${tttBoard(game.board)}\nScores: ${scoresText(game.scores, game.names)}`, true);
        return true;
      }
      if (game.board.every(Boolean)) { await finish(`🤝 It's a draw!\n${tttBoard(game.board)}`, true); return true; }
      game.turn = game.turn === 'X' ? 'O' : 'X';
      return false;
    };
    if (await place(game.turn, idx)) return;
    if (game.vsBot && game.turn === 'O') {
      const bi = tttBotMove(game.board);
      if (bi >= 0) { if (await place('O', bi)) return; }
      await postBotMessage(channelId, cmd.bot_id, `${tttBoard(game.board)}\nYour turn (X) — /move 1-9`, replyToId);
      return;
    }
    await postBotMessage(channelId, cmd.bot_id, `${tttBoard(game.board)}\n${game.turn === 'X' ? 'X' : 'O'}'s turn — /move 1-9`, replyToId);
    return;
  }

  if (kind === 'score') {
    const g = botGames.get(channelId);
    await postBotMessage(channelId, cmd.bot_id, `🏆 Game scores: ${scoresText(g?.scores || {}, g?.names)}`, replyToId);
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────
test('bot trivia: starts, scores correct answers, posts final scores', async () => {
  botGames.clear(); posted.length = 0;
  const cmd = { bot_id:'b1', bot_nickname:'Trivia Bot', response:'{{game:trivia}}' };
  const user = { id:'u1', username:'Alice' };

  await runBotGame(cmd, 'trivia', '', 'c1', null, user);
  assert.match(posted[0], /Q1\/2:/);

  await runBotGame({ ...cmd, response:'{{game:trivia_answer}}' }, 'answer', 'wrongguess', 'c1', null, user);
  assert.match(posted[1], /❌ Not it/);
  assert.strictEqual(botGames.get('c1').scores.u1, undefined);

  const game = botGames.get('c1');
  const q = game.questions[0];
  await runBotGame({ ...cmd, response:'{{game:trivia_answer}}' }, 'answer', q.o[q.a], 'c1', null, user);
  assert.match(posted[2], /✅ Alice got it! \+10/);
  assert.strictEqual(game.scores.u1, 10);
  assert.match(posted[2], /Next — Q2\/2:/);

  await runBotGame({ ...cmd, response:'{{game:trivia_answer}}' }, 'answer', String(game.questions[1].a + 1), 'c1', null, user);
  assert.match(posted[3], /Trivia over! Scores: Alice: 20/);
  assert.strictEqual(botGames.has('c1'), false);
});

test('bot tic-tac-toe: starts vs the bot and detects a win with scores', async () => {
  botGames.clear(); posted.length = 0;
  const cmd = { bot_id:'b2', bot_nickname:'Fun Bot', response:'{{game:ttt}}' };
  const move = { bot_id:'b2', bot_nickname:'Fun Bot', response:'{{game:ttt_move}}' };
  const user = { id:'u1', username:'Alice' };

  await runBotGame(cmd, 'ttt', '', 'c2', null, user);
  assert.match(posted[0], /tic-tac-toe \(you vs me\)/);
  assert.match(posted[0], /1 \| 2 \| 3/);

  const g = botGames.get('c2');
  g.board = ['X', null, null, null, 'X', null, null, null, null];
  g.turn = 'X';
  posted.length = 0;

  await runBotGame(move, 'move', '9', 'c2', null, user);
  assert.match(posted[0], /🏆 Alice wins with X! \+10/);
  assert.strictEqual(g.scores.u1, 10);
  assert.strictEqual(botGames.has('c2'), false);
});

test('bot tic-tac-toe: rejects invalid moves', async () => {
  botGames.clear(); posted.length = 0;
  const cmd = { bot_id:'b2', bot_nickname:'Fun Bot', response:'{{game:ttt}}' };
  const move = { bot_id:'b2', bot_nickname:'Fun Bot', response:'{{game:ttt_move}}' };
  const user = { id:'u1', username:'Alice' };

  await runBotGame(cmd, 'ttt', '', 'c3', null, user);
  posted.length = 0;
  await runBotGame(move, 'move', '12', 'c3', null, user);
  assert.match(posted[0], /Invalid move/);
});

test('bot game scores: reports empty sessions', async () => {
  botGames.clear(); posted.length = 0;
  await runBotGame({ bot_id:'b1', bot_nickname:'Trivia Bot', response:'{{game:score}}' }, 'score', '', 'c9', null, { id:'u1', username:'Alice' });
  assert.match(posted[0], /no scores yet/);
});
