import test from 'node:test';
import assert from 'node:assert/strict';
import {
  chessInitialBoard, createChessGame, addChessPlayer, applyChessAction,
  createUnoGame, addUnoPlayer, applyUnoAction,
} from '../src/multiplayer-game.js';

const a = { userId:'a', name:'Alice' };
const b = { userId:'b', name:'Bob' };

test('chess assigns colors and validates turn/movement', () => {
  const first = createChessGame(a);
  const joined = addChessPlayer(first, b);
  assert.equal(joined.state.players[1].color, 'black');
  const wrong = applyChessAction(joined.state, b.userId, [1, 0], [2, 0]);
  assert.match(wrong.error, /turn/i);
  const moved = applyChessAction(joined.state, a.userId, [6, 4], [4, 4]);
  assert.equal(moved.state.board[4][4], 'P');
  assert.equal(moved.state.turn, 'black');
});

test('chess rejects blocked and friendly captures', () => {
  const state = createChessGame(a);
  assert.equal(state.board.length, 8);
  const result = applyChessAction(state, a.userId, [7, 0], [6, 0]);
  assert.match(result.error, /cannot move/i);
});

test('uno deals private hands, enforces turn, and plays matching cards', () => {
  const first = createUnoGame(a);
  const joined = addUnoPlayer(first, b).state;
  assert.equal(joined.players.length, 2);
  assert.equal(joined.players[0].hand.length, 7);
  assert.equal(joined.players[1].hand.length, 7);
  const wrong = applyUnoAction(joined, b.userId, { type:'draw' });
  assert.match(wrong.error, /turn/i);
  const player = joined.players[0];
  const index = player.hand.findIndex(card => card.color === joined.currentColor || card.value === joined.discard.value || card.color === 'wild');
  assert.notEqual(index, -1);
  const card = player.hand[index];
  const played = applyUnoAction(joined, a.userId, { type:'play', index, color: card.color === 'wild' ? 'red' : undefined });
  assert.ok(played.state);
  assert.equal(played.state.players[0].hand.length, 6);
});
