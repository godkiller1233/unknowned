import React, { useState, useRef } from 'react';

// ── Game catalog ──────────────────────────────────────────────────────────────
const GAMES = [
  { id:'guess',    icon:'🎯', name:'Guess the Number', desc:'Find the secret number in 7 tries' },
  { id:'wyr',      icon:'🤔', name:'Would You Rather', desc:'Pick your poison between two options' },
  { id:'truth',    icon:'🔥', name:'Truth or Dare',    desc:'Spicy questions or silly dares' },
  { id:'trivia',   icon:'🧠', name:'Trivia',           desc:'10 questions. How smart are you?' },
  { id:'scramble', icon:'🔤', name:'Word Scramble',    desc:'Unscramble 8 words' },
];

const WYR = [
  ['Only eat pizza for a year','Never eat pizza again'],
  ['Be able to fly','Be invisible'],
  ['Always know when someone is lying','Never be lied to'],
  ['Have a photographic memory','Forget anything on demand'],
  ['Live in the past','Live in the future'],
  ['Talk to animals','Speak every language'],
  ['Never use social media again','Never watch TV again'],
  ['Be 10 minutes early to everything','Always be 10 minutes late'],
  ['Only whisper forever','Only shout forever'],
  ['Have unlimited snacks','Have unlimited coffee'],
  ['Win every argument','Never argue again'],
  ['See 10 seconds into the future','See 10 years into the past'],
];

const TRUTHS = [
  "What's the most embarrassing thing you've done online?",
  "What's a secret you've never told anyone here?",
  "Who's the last person you searched for online?",
  "What's your most-used emoji and why?",
  'Have you ever faked being busy to avoid someone?',
  "What's the worst advice you've ever followed?",
  'What is something you pretend to like?',
  "What's your most controversial food opinion?",
  'What was your very first username?',
  "What's the biggest lie you've told online?",
  'What song have you had on repeat recently?',
  "What's the weirdest thing in your search history?",
];
const DARES = [
  'Send a message using only emojis',
  'Describe yourself in 3 words to the chat',
  'Type your current thoughts out loud',
  'Compliment the person above you',
  'Share your favorite meme with zero context',
  'Only use song lyrics to answer the next question',
  "Rate your day out of 10 and explain it",
  'Say something nice about this server',
  'Make up a fact about yourself and let people guess if it is true',
  'Share one good thing that happened this week',
  "End your next message with a random emoji",
  'Tell everyone your go-to karaoke song',
];

const TRIVIA = [
  { q:'What planet is known as the Red Planet?', o:['Mars','Venus','Jupiter','Mercury'], a:0 },
  { q:'How many continents are there?', o:['5','6','7','8'], a:2 },
  { q:'What is the largest ocean on Earth?', o:['Atlantic','Indian','Arctic','Pacific'], a:3 },
  { q:'Who painted the Mona Lisa?', o:['Van Gogh','Da Vinci','Picasso','Rembrandt'], a:1 },
  { q:'What is the chemical symbol for gold?', o:['Au','Ag','Go','Gd'], a:0 },
  { q:'How many legs does a spider have?', o:['6','8','10','12'], a:1 },
  { q:'What is the smallest prime number?', o:['0','1','2','3'], a:2 },
  { q:'Which country is famous for the Great Wall?', o:['Japan','India','China','Korea'], a:2 },
  { q:'What does "www" stand for?', o:['World Wide Web','World Web Wide','Web World Wide','Wide Web World'], a:0 },
  { q:'How many days are in a leap year?', o:['364','365','366','367'], a:2 },
  { q:'What is the fastest land animal?', o:['Lion','Cheetah','Horse','Leopard'], a:1 },
  { q:'Which gas do plants absorb from the air?', o:['Oxygen','Nitrogen','Carbon dioxide','Hydrogen'], a:2 },
];

const WORDS = ['APPLE','GUITAR','PLANET','COMPUTER','ANCHOR','PIZZA','OCTOPUS','GARDEN','LEMON','ROCKET','PUZZLE','COFFEE','WINDOW','MOUNTAIN','BANANA','KEYBOARD'];

function shuffle(s) {
  let a = s.split('');
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.join('');
}
function pickWord() {
  const w = WORDS[Math.floor(Math.random() * WORDS.length)];
  let sh = shuffle(w);
  while (sh === w) sh = shuffle(w);
  return { word: w, shuffled: sh };
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function Game({ onClose, me, shareTarget, initial, onLog, onShare }) {
  const [sel, setSel] = useState(initial || null);
  const [notice, setNotice] = useState('');
  const logged = useRef(false);

  // Guess the Number
  const [target, setTarget] = useState(() => Math.floor(Math.random() * 100) + 1);
  const [guess, setGuess] = useState('');
  const [guesses, setGuesses] = useState([]);
  const [won, setWon] = useState(false);
  const [lost, setLost] = useState(false);

  // Would You Rather
  const [wyrIdx, setWyrIdx] = useState(() => Math.floor(Math.random() * WYR.length));
  const [wyrPick, setWyrPick] = useState(null);

  // Truth or Dare
  const [tMode, setTMode] = useState(null);
  const [tCount, setTCount] = useState(0);

  // Trivia
  const [tq, setTq] = useState(0);
  const [tScore, setTScore] = useState(0);
  const [tPick, setTPick] = useState(null);
  const [tDone, setTDone] = useState(false);

  // Word Scramble
  const [sw, setSw] = useState(() => pickWord());
  const [swIdx, setSwIdx] = useState(0);
  const [swScore, setSwScore] = useState(0);
  const [swWrong, setSwWrong] = useState(0);
  const [sIn, setSIn] = useState('');

  const [shareText, setShareText] = useState(null);
  const [shareMsg, setShareMsg] = useState('');

  function startGame(id) {
    logged.current = false;
    setSel(id); setNotice(''); setShareText(null); setShareMsg('');
    setTarget(Math.floor(Math.random() * 100) + 1); setGuesses([]); setWon(false); setLost(false); setGuess('');
    setWyrIdx(Math.floor(Math.random() * WYR.length)); setWyrPick(null);
    setTMode(null); setTCount(0);
    setTq(0); setTScore(0); setTPick(null); setTDone(false);
    setSw(pickWord()); setSwIdx(0); setSwScore(0); setSwWrong(0); setSIn('');
  }

  function finish(game, result, text) {
    if (!logged.current) {
      logged.current = true;
      if (onLog) onLog(game, result);
    }
    setShareText(text);
  }

  async function share() {
    if (!shareText) return;
    if (!shareTarget) { setShareMsg('Open a chat first to share'); return; }
    const d = await onShare(shareText);
    setShareMsg(d && !d.error ? 'Shared to chat ✓' : 'Could not share');
  }

  const sharedBtn = shareText && (
    <div className="g-share">
      <button onClick={share}>📤 Share to chat</button>
      {!shareTarget && <small>Open a chat to share your result</small>}
      {shareMsg && <small className="g-share-msg">{shareMsg}</small>}
    </div>
  );

  // ── Hub ──
  if (!sel) {
    return (
      <div className="game-overlay" onClick={onClose}>
        <div className="game-modal game-hub" onClick={e => e.stopPropagation()}>
          <div className="game-header">
            <h2>🎮 Games Hub</h2>
            <button className="icon-btn" onClick={onClose}>✕</button>
          </div>
          <p className="game-desc">Pick a game — finish one to earn quest credit (🎯 Player One / Arcade Addict).</p>
          <div className="game-grid">
            {GAMES.map(g => (
              <button key={g.id} className="game-card" onClick={() => startGame(g.id)}>
                <span className="game-card-icon">{g.icon}</span>
                <b>{g.name}</b>
                <small>{g.desc}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const backBtn = <button className="ghost" onClick={() => startGame(null)}>← All games</button>;

  // ── Guess the Number ──
  if (sel === 'guess') {
    const submit = e => {
      e.preventDefault();
      const n = parseInt(guess);
      if (!n || n < 1 || n > 100) return;
      const dir = n === target ? 'correct' : n < target ? 'low' : 'high';
      const newGuesses = [...guesses, { n, dir }];
      setGuesses(newGuesses); setGuess('');
      if (dir === 'correct') { setWon(true); finish('guess', 'won', `🎯 I won Guess the Number in ${newGuesses.length} ${newGuesses.length === 1 ? 'guess' : 'guesses'}! 🎉`); }
      else if (newGuesses.length >= 7) { setLost(true); finish('guess', 'lost', `🎯 I lost Guess the Number... the number was ${target} 😅`); }
    };
    return (
      <div className="game-overlay" onClick={onClose}>
        <div className="game-modal" onClick={e => e.stopPropagation()}>
          <div className="game-header"><h2>🎯 Guess the Number</h2><button className="icon-btn" onClick={onClose}>✕</button></div>
          <p className="game-desc">I'm thinking of a number between <b>1</b> and <b>100</b>. You have <b>7</b> guesses.</p>
          {!won && !lost && (
            <form onSubmit={submit} className="game-form">
              <input type="number" min="1" max="100" value={guess} onChange={e => setGuess(e.target.value)} placeholder="Your guess…" autoFocus />
              <button type="submit">Guess</button>
            </form>
          )}
          <div className="game-guesses">
            {guesses.map((g, i) => (
              <div key={i} className={`game-guess-row hint-${g.dir}`}>
                <span className="game-guess-num">{g.n}</span>
                <span className="game-hint">{g.dir === 'correct' ? '✅ Correct!' : g.dir === 'low' ? '⬆ Too low' : '⬇ Too high'}</span>
              </div>
            ))}
          </div>
          {!won && !lost && guesses.length > 0 && <p className="game-remaining">{7 - guesses.length} guesses remaining</p>}
          {won && <div className="game-result won">🎉 You got it! The number was <b>{target}</b> in {guesses.length} guesses!</div>}
          {lost && <div className="game-result lost">😬 Out of guesses! The number was <b>{target}</b>.</div>}
          {(won || lost) && (
            <div className="game-end-actions">
              <button onClick={() => startGame('guess')}>Play again</button>
              {backBtn}
            </div>
          )}
          {sharedBtn}
        </div>
      </div>
    );
  }

  // ── Would You Rather ──
  if (sel === 'wyr') {
    const pair = WYR[wyrIdx];
    const pick = (i) => {
      setWyrPick(i);
      finish('wyr', i === 0 ? 'a' : 'b', `🤔 Would You Rather: I picked "${pair[i]}" over "${pair[1 - i]}"! What would you pick?`);
    };
    return (
      <div className="game-overlay" onClick={onClose}>
        <div className="game-modal" onClick={e => e.stopPropagation()}>
          <div className="game-header"><h2>🤔 Would You Rather</h2><button className="icon-btn" onClick={onClose}>✕</button></div>
          {wyrPick === null ? (
            <>
              <p className="game-desc">You must choose. No middle ground.</p>
              <div className="g-choices">
                <button className="g-choice" onClick={() => pick(0)}>{pair[0]}</button>
                <span className="g-vs">VS</span>
                <button className="g-choice" onClick={() => pick(1)}>{pair[1]}</button>
              </div>
            </>
          ) : (
            <>
              <div className="game-result won">You picked <b>{pair[wyrPick]}</b> — bold choice!</div>
              <div className="game-end-actions">
                <button onClick={() => { logged.current = false; setWyrPick(null); setWyrIdx(Math.floor(Math.random() * WYR.length)); setShareText(null); }}>Next pair</button>
                {backBtn}
              </div>
            </>
          )}
          {sharedBtn}
        </div>
      </div>
    );
  }

  // ── Truth or Dare ──
  if (sel === 'truth') {
    const reveal = (mode) => {
      setTMode(mode); setTCount(c => c + 1);
      finish('truth', mode, `🔥 Truth or Dare: I got a ${mode} → "${mode === 'truth' ? TRUTHS[Math.floor(Math.random() * TRUTHS.length)] : DARES[Math.floor(Math.random() * DARES.length)]}"`);
    };
    const prompt = tMode === 'truth' ? TRUTHS[Math.floor(Math.random() * TRUTHS.length)] : DARES[Math.floor(Math.random() * DARES.length)];
    return (
      <div className="game-overlay" onClick={onClose}>
        <div className="game-modal" onClick={e => e.stopPropagation()}>
          <div className="game-header"><h2>🔥 Truth or Dare</h2><button className="icon-btn" onClick={onClose}>✕</button></div>
          {!tMode ? (
            <div className="g-choices">
              <button className="g-choice" onClick={() => reveal('truth')}>🤫 Truth</button>
              <button className="g-choice" onClick={() => reveal('dare')}>😈 Dare</button>
            </div>
          ) : (
            <>
              <div className="g-prompt">{prompt}</div>
              <div className="game-end-actions">
                <button onClick={() => { logged.current = false; setTMode(null); setShareText(null); }}>Next round</button>
                {backBtn}
              </div>
            </>
          )}
          {sharedBtn}
        </div>
      </div>
    );
  }

  // ── Trivia ──
  if (sel === 'trivia') {
    const q = TRIVIA[tq];
    const answer = (i) => {
      if (tPick !== null) return;
      setTPick(i);
      if (i === q.a) setTScore(s => s + 1);
    };
    const next = () => {
      if (tq + 1 >= TRIVIA.length) { setTDone(true); finish('trivia', `${tScore}/${TRIVIA.length}`, `🧠 Trivia: I scored ${tScore}/${TRIVIA.length}! Can you beat me?`); }
      else { setTq(t => t + 1); setTPick(null); }
    };
    return (
      <div className="game-overlay" onClick={onClose}>
        <div className="game-modal" onClick={e => e.stopPropagation()}>
          <div className="game-header"><h2>🧠 Trivia</h2><button className="icon-btn" onClick={onClose}>✕</button></div>
          {!tDone ? (
            <>
              <div className="g-trivia-progress">Question {tq + 1} / {TRIVIA.length} · Score {tScore}</div>
              <p className="game-desc"><b>{q.q}</b></p>
              <div className="g-choices">
                {q.o.map((opt, i) => (
                  <button key={i} className={`g-choice${tPick !== null ? (i === q.a ? ' right' : i === tPick ? ' wrong' : ' dim') : ''}`} onClick={() => answer(i)}>
                    {opt}
                  </button>
                ))}
              </div>
              {tPick !== null && (
                <div className="game-end-actions">
                  <span className={`g-feedback ${tPick === q.a ? 'right' : 'wrong'}`}>{tPick === q.a ? '✅ Correct!' : `❌ Nope — it's ${q.o[q.a]}`}</span>
                  <button onClick={next}>{tq + 1 >= TRIVIA.length ? 'See score' : 'Next'}</button>
                </div>
              )}
            </>
          ) : (
            <>
              <div className={`game-result ${tScore >= 7 ? 'won' : 'lost'}`}>You scored <b>{tScore} / {TRIVIA.length}</b>!</div>
              <div className="game-end-actions">
                <button onClick={() => startGame('trivia')}>Play again</button>
                {backBtn}
              </div>
            </>
          )}
          {sharedBtn}
        </div>
      </div>
    );
  }

  // ── Word Scramble ──
  if (sel === 'scramble') {
    const submit = e => {
      e.preventDefault();
      if (!sIn.trim()) return;
      if (sIn.trim().toUpperCase() === sw.word) {
        const newScore = swScore + 1;
        setSwScore(newScore);
        if (swIdx + 1 >= 8) { setSwIdx(8); finish('scramble', `${newScore}/8`, `🔤 Word Scramble: I unscrambled ${newScore}/8 words! Beat that!`); }
        else { setSw(pickWord()); setSwIdx(i => i + 1); setSwWrong(0); setSIn(''); setNotice(''); }
      } else {
        const w = swWrong + 1;
        setSwWrong(w);
        setSIn('');
        if (w >= 3) {
          setNotice(`The word was ${sw.word}`);
          if (swIdx + 1 >= 8) { setSwIdx(8); finish('scramble', `${swScore}/8`, `🔤 Word Scramble: I unscrambled ${swScore}/8 words! Beat that!`); }
          else { setSw(pickWord()); setSwIdx(i => i + 1); setSwWrong(0); setSIn(''); }
        }
      }
    };
    const doneScramble = swIdx >= 8;
    return (
      <div className="game-overlay" onClick={onClose}>
        <div className="game-modal" onClick={e => e.stopPropagation()}>
          <div className="game-header"><h2>🔤 Word Scramble</h2><button className="icon-btn" onClick={onClose}>✕</button></div>
          {!doneScramble ? (
            <>
              <div className="g-trivia-progress">Word {swIdx + 1} / 8 · Solved {swScore}</div>
              <p className="game-desc">Unscramble: <b className="g-scramble-word">{sw.shuffled.split('').join(' ')}</b> ({sw.word.length} letters)</p>
              <form onSubmit={submit} className="game-form">
                <input value={sIn} onChange={e => setSIn(e.target.value)} placeholder="Your answer…" autoFocus />
                <button type="submit">Guess</button>
              </form>
              {notice && <p className="g-feedback wrong">{notice}</p>}
              {swWrong > 0 && <p className="game-remaining">{3 - swWrong} {3 - swWrong === 1 ? 'strike' : 'strikes'} left</p>}
            </>
          ) : (
            <>
              <div className={`game-result ${swScore >= 5 ? 'won' : 'lost'}`}>You unscrambled <b>{swScore} / 8</b> words!</div>
              <div className="game-end-actions">
                <button onClick={() => startGame('scramble')}>Play again</button>
                {backBtn}
              </div>
            </>
          )}
          {sharedBtn}
        </div>
      </div>
    );
  }

  return null;
}
