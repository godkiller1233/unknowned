import React, { useState } from 'react';

const PIECES = { r:'♜', n:'♞', b:'♝', q:'♛', k:'♚', p:'♟', R:'♖', N:'♘', B:'♗', Q:'♕', K:'♔', P:'♙' };
const COLORS = ['red','yellow','green','blue'];

export default function MultiplayerGame({ game, me, onStart, onJoin, onAction, busy }) {
  const [selected, setSelected] = useState(null);
  const [wildColor, setWildColor] = useState('');
  const [error, setError] = useState('');
  const send = async action => {
    setError('');
    const result = await onAction(action);
    if (result?.error) setError(result.error);
    else setSelected(null);
  };
  if (!game) return (
    <div className="room-multiplayer-game">
      <div className="room-idle"><span className="room-icon">🎮</span><h3>Play together</h3><p>Start an authoritative game that everyone in this room can join.</p></div>
      <div className="room-game-grid multiplayer-game-picks">
        <button disabled={busy} onClick={() => onStart('chess')}>♟ Chess</button>
        <button disabled={busy} onClick={() => onStart('uno')}>🃏 UNO</button>
      </div>
    </div>
  );
  const player = game.players?.find(p => p.userId === me?.id);
  const isTurn = game.gameType === 'chess' ? player?.color === game.turn : game.players?.[game.turn]?.userId === me?.id;
  return (
    <div className="room-multiplayer-game">
      <div className="multiplayer-game-head">
        <div><b>{game.gameType === 'chess' ? '♟ Chess' : '🃏 UNO'}</b><span className="muted-text"> · {game.winner ? 'Game over' : isTurn ? 'Your turn' : 'Waiting for your turn'}</span></div>
        {!player && <button disabled={busy} onClick={() => send({ type:'join' })}>Join game</button>}
      </div>
      {error && <div className="multiplayer-game-error">{error}</div>}
      {game.gameType === 'chess' ? <ChessBoard game={game} player={player} selected={selected} setSelected={setSelected} send={send} /> : <UnoHand game={game} player={player} wildColor={wildColor} setWildColor={setWildColor} send={send} />}
    </div>
  );
}

function ChessBoard({ game, player, selected, setSelected, send }) {
  const orientation = player?.color === 'black' ? [...Array(8).keys()].reverse() : [...Array(8).keys()];
  const cols = orientation;
  const canSelect = player?.color === game.turn && !game.winner;
  function click(r, c) {
    if (!canSelect) return;
    const piece = game.board[r][c];
    if (!selected) {
      if (piece && ((piece === piece.toUpperCase()) === (player.color === 'white'))) setSelected([r,c]);
      return;
    }
    if (selected[0] === r && selected[1] === c) return setSelected(null);
    send({ type:'move', from:selected, to:[r,c] });
  }
  return <>
    <div className="chess-board" aria-label="Chess board">{orientation.flatMap(r => cols.map(c => {
      const piece = game.board[r][c];
      return <button key={`${r}-${c}`} className={`chess-square ${(r+c)%2?'dark':'light'}${selected?.[0]===r&&selected?.[1]===c?' selected':''}`} onClick={() => click(r,c)} aria-label={`${r},${c}`}>{piece ? PIECES[piece] : ''}</button>;
    }))}</div>
    <div className="multiplayer-players">{game.players.map(p => <span key={p.userId}>{p.color === 'white' ? '♔' : '♚'} {p.name}</span>)}</div>
    {game.winner && <div className="multiplayer-result">🏆 {game.winner === player?.userId ? 'You won!' : 'Game finished'}</div>}
  </>;
}

function UnoHand({ game, player, wildColor, setWildColor, send }) {
  if (!player) return <div className="multiplayer-empty">Join the UNO game to receive a private hand.</div>;
  const canPlay = game.players?.[game.turn]?.userId === player.userId && !game.winner;
  return <>
    <div className="uno-status"><span>Top card: <b className={`uno-card-mini ${game.discard?.color}`}>{game.discard?.value}</b></span><span>Color: <b>{game.currentColor}</b></span><span>{game.players.length} players</span></div>
    <div className="uno-hand">{(player.hand || []).map((card, i) => <button key={`${card.color}-${card.value}-${i}`} disabled={!canPlay} className={`uno-card ${card.color}`} onClick={() => {
      if (card.color === 'wild') { const color = wildColor || window.prompt('Choose red, yellow, green, or blue', 'red'); if (!color || !COLORS.includes(color)) return setWildColor(''); setWildColor(color); send({ type:'play', index:i, color }); }
      else send({ type:'play', index:i });
    }}>{card.value}</button>)}</div>
    <div className="uno-actions"><button disabled={!canPlay} onClick={() => send({ type:'draw' })}>Draw card</button>{game.winner && <span className="multiplayer-result">🏆 Game over</span>}</div>
    <div className="multiplayer-players">{game.players.map(p => <span key={p.userId}>{p.name} · {p.handCount ?? p.hand?.length ?? 0} cards</span>)}</div>
  </>;
}
