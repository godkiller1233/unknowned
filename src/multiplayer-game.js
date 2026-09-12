const CHESS_FILES = 8;

export function chessInitialBoard() {
  return [
    ['r','n','b','q','k','b','n','r'],
    ['p','p','p','p','p','p','p','p'],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', ''],
    ['P','P','P','P','P','P','P','P'],
    ['R','N','B','Q','K','B','N','R'],
  ];
}

export function chessColor(piece) {
  return piece && piece === piece.toUpperCase() ? 'white' : piece ? 'black' : null;
}

function inBounds(r, c) { return r >= 0 && r < CHESS_FILES && c >= 0 && c < CHESS_FILES; }
function clearPath(board, fr, fc, tr, tc) {
  const dr = Math.sign(tr - fr), dc = Math.sign(tc - fc);
  let r = fr + dr, c = fc + dc;
  while (r !== tr || c !== tc) {
    if (board[r][c]) return false;
    r += dr; c += dc;
  }
  return true;
}

export function isLegalChessMove(board, from, to, turn) {
  if (!Array.isArray(from) || !Array.isArray(to)) return false;
  const [fr, fc] = from, [tr, tc] = to;
  if (![fr, fc, tr, tc].every(Number.isInteger) || !inBounds(fr, fc) || !inBounds(tr, tc)) return false;
  const piece = board?.[fr]?.[fc];
  const target = board?.[tr]?.[tc];
  if (!piece || chessColor(piece) !== turn || (target && chessColor(target) === turn)) return false;
  if (target && target.toLowerCase() === 'k') return false;
  const dr = tr - fr, dc = tc - fc;
  const kind = piece.toLowerCase();
  if (kind === 'p') {
    const dir = turn === 'white' ? -1 : 1;
    const start = turn === 'white' ? 6 : 1;
    return (dc === 0 && !target && (dr === dir || (fr === start && dr === 2 * dir && !board[fr + dir][fc])))
      || (Math.abs(dc) === 1 && dr === dir && !!target);
  }
  if (kind === 'n') return (Math.abs(dr) === 2 && Math.abs(dc) === 1) || (Math.abs(dr) === 1 && Math.abs(dc) === 2);
  if (kind === 'k') return Math.max(Math.abs(dr), Math.abs(dc)) === 1;
  if (kind === 'b') return Math.abs(dr) === Math.abs(dc) && clearPath(board, fr, fc, tr, tc);
  if (kind === 'r') return (dr === 0 || dc === 0) && clearPath(board, fr, fc, tr, tc);
  if (kind === 'q') return (dr === 0 || dc === 0 || Math.abs(dr) === Math.abs(dc)) && clearPath(board, fr, fc, tr, tc);
  return false;
}

export function applyChessMove(state, from, to) {
  if (!isLegalChessMove(state.board, from, to, state.turn)) return { error: 'That piece cannot move there.' };
  const board = state.board.map(row => row.slice());
  const piece = board[from[0]][from[1]];
  const captured = board[to[0]][to[1]];
  board[to[0]][to[1]] = piece;
  board[from[0]][from[1]] = '';
  // Promote pawns automatically; castling and check are deliberately out of
  // scope for this lightweight room game, but every ordinary move is validated.
  if (piece === 'P' && to[0] === 0) board[to[0]][to[1]] = 'Q';
  if (piece === 'p' && to[0] === 7) board[to[0]][to[1]] = 'q';
  const winner = captured?.toLowerCase() === 'k' ? state.turn : null;
  return { state: { ...state, board, turn: state.turn === 'white' ? 'black' : 'white', winner, lastMove: { from, to } } };
}

function shuffle(items) {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function unoDeck() {
  const deck = [];
  for (const color of ['red','yellow','green','blue']) {
    deck.push({ color, value: '0' });
    for (let n = 1; n <= 9; n++) deck.push({ color, value: String(n) }, { color, value: String(n) });
    for (const value of ['skip','reverse','draw2']) deck.push({ color, value }, { color, value });
  }
  for (let n = 0; n < 4; n++) deck.push({ color: 'wild', value: 'wild' }, { color: 'wild', value: 'draw4' });
  return shuffle(deck);
}

export function unoCanPlay(card, top, currentColor) {
  return card?.color === 'wild' || card?.color === currentColor || card?.value === top?.value;
}

export function createChessGame(user) {
  return { gameType: 'chess', started: true, players: [{ userId: user.userId, name: user.name, color: 'white' }], board: chessInitialBoard(), turn: 'white', winner: null, lastMove: null };
}

export function applyChessAction(state, userId, from, to) {
  const player = state.players.find(p => p.userId === userId);
  if (!player) return { error: 'Join the game first.' };
  if (player.color !== state.turn) return { error: 'Wait for your turn.' };
  return applyChessMove(state, from, to);
}

export function createUnoGame(user) {
  let deck = unoDeck();
  const players = [{ userId: user.userId, name: user.name, hand: deck.splice(0, 7) }];
  let discard = deck.pop();
  while (discard?.color === 'wild') { deck.unshift(discard); discard = deck.pop(); }
  return { gameType: 'uno', started: true, players, deck, discard, currentColor: discard.color, turn: 0, winner: null, lastAction: null };
}

export function addUnoPlayer(state, user) {
  if (state.players.some(p => p.userId === user.userId)) return { state };
  if (state.players.length >= 4) return { error: 'UNO is full (up to 4 players).' };
  if (state.winner) return { error: 'This game is over.' };
  const deck = state.deck.slice();
  return { state: { ...state, deck: deck.slice(7), players: [...state.players, { userId: user.userId, name: user.name, hand: deck.slice(0, 7) }] } };
}

export function addChessPlayer(state, user) {
  if (state.players.some(p => p.userId === user.userId)) return { state };
  if (state.players.length >= 2) return { error: 'Chess already has two players.' };
  const color = state.players.some(p => p.color === 'white') ? 'black' : 'white';
  return { state: { ...state, players: [...state.players, { userId: user.userId, name: user.name, color }] } };
}

export function applyUnoAction(state, userId, action) {
  if (state.winner) return { error: 'This game is over.' };
  const playerIndex = state.players.findIndex(p => p.userId === userId);
  if (playerIndex < 0) return { error: 'Join the game first.' };
  if (state.turn !== playerIndex) return { error: 'Wait for your turn.' };
  const player = state.players[playerIndex];
  const deck = state.deck.slice();
  const hand = player.hand.slice();
  const top = state.discard;
  if (action.type === 'draw') {
    if (!deck.length) return { error: 'The draw pile is empty.' };
    hand.push(deck.shift());
    return { state: { ...state, deck, players: state.players.map((p, i) => i === playerIndex ? { ...p, hand } : p), turn: (state.turn + 1) % state.players.length, lastAction: { userId, type: 'draw' } } };
  }
  if (action.type !== 'play' || !Number.isInteger(action.index) || !hand[action.index]) return { error: 'Choose a card to play.' };
  const card = hand[action.index];
  if (!unoCanPlay(card, top, state.currentColor)) return { error: 'That card cannot be played right now.' };
  if (card.color === 'wild' && !['red','yellow','green','blue'].includes(action.color)) return { error: 'Choose a color for the wild card.' };
  hand.splice(action.index, 1);
  let next = (state.turn + 1) % state.players.length;
  let extra = 0;
  if (card.value === 'skip' || card.value === 'draw2') extra = card.value === 'draw2' ? 1 : 1;
  if (card.value === 'reverse' && state.players.length > 2) next = (state.turn - 1 + state.players.length) % state.players.length;
  if (card.value === 'draw4') extra = 1;
  next = (next + extra) % state.players.length;
  const winner = hand.length === 0 ? userId : null;
  return { state: { ...state, deck, discard: card, currentColor: card.color === 'wild' ? action.color : card.color, players: state.players.map((p, i) => i === playerIndex ? { ...p, hand } : p), turn: next, winner, lastAction: { userId, type: 'play', card } } };
}
