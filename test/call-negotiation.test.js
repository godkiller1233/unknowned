// Unit tests for the DM-call perfect-negotiation state machine. Pure node —
// no server, no database. A stub RTCPeerConnection models the real SDP state
// transitions (including the InvalidStateError glare would trigger) and two
// negotiators exchange signaling through an explicit mailbox.
//
// Deterministic by construction: the module under test is entirely
// microtask-driven (no timers), so signaling is relayed by the test itself
// instead of setTimeout. `pump()` delivers every queued message until the pair
// quiesces and `spinUntil()` advances only microtasks, so pacing a "mid-glare"
// or "lost offer" moment is exact — nothing depends on wall-clock scheduling,
// which is what made the earlier timer-based relay flaky under CI load.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCallNegotiator } from '../src/call-negotiation.js';

// ── Stub RTCPeerConnection ────────────────────────────────────────────────────
// Mirrors the browser's state machine: stable → have-local-offer (our offer),
// stable → have-remote-offer (their offer), answer/rollback → stable. Throws on
// the transitions real browsers reject (e.g. receiving an offer while our offer
// is pending — that is exactly the glare case the negotiator must resolve).
function makeStubPc() {
  // The SDP state machine lives directly on the pc, exactly like a real
  // RTCPeerConnection (pc.signalingState, pc.localDescription, …); separate
  // `log` tracks counters for assertions.
  const log = { addedCandidates: [], offersCreated: 0, sidCounter: 0, closed: false };
  const pc = {
    log,
    signalingState: 'stable',
    localDescription: null,
    remoteDescription: null,
    createOffer: async opts => {
      log.offersCreated += 1;
      const sid = 'sid' + (++log.sidCounter);
      const restart = Boolean(opts && opts.iceRestart);
      return { type: 'offer', sdp: `offer-${sid}${restart ? '!restart' : ''}`, sid, iceRestart: restart };
    },
    createAnswer: async () => {
      if (!pc.remoteDescription) throw new Error('createAnswer without remote offer');
      return { type: 'answer', sdp: `answer-${pc.remoteDescription.sid}`, sid: pc.remoteDescription.sid };
    },
    setLocalDescription: async desc => {
      if (desc.type === 'offer') {
        if (pc.signalingState !== 'stable') throw new Error(`setLocal(offer) from ${pc.signalingState}`);
        pc.localDescription = desc; pc.signalingState = 'have-local-offer';
      } else if (desc.type === 'answer') {
        if (pc.signalingState !== 'have-remote-offer') throw new Error(`setLocal(answer) from ${pc.signalingState}`);
        pc.localDescription = desc; pc.signalingState = 'stable';
      } else if (desc.type === 'rollback') {
        if (pc.signalingState !== 'have-local-offer') throw new Error(`rollback from ${pc.signalingState}`);
        pc.localDescription = null; pc.signalingState = 'stable';
      } else throw new Error(`unknown setLocal ${desc.type}`);
    },
    setRemoteDescription: async desc => {
      if (desc.type === 'offer') {
        // Real browsers: a new offer supersedes an old remote offer, but an
        // offer arriving while WE have a pending offer is InvalidStateError —
        // glare that the negotiator must never hit.
        if (pc.signalingState === 'have-local-offer') throw new Error(`setRemote(offer) from have-local-offer`);
        pc.remoteDescription = desc; pc.signalingState = 'have-remote-offer';
      } else if (desc.type === 'answer') {
        if (pc.signalingState !== 'have-local-offer') throw new Error(`setRemote(answer) from ${pc.signalingState}`);
        pc.remoteDescription = desc; pc.signalingState = 'stable';
      } else throw new Error(`unknown setRemote ${desc.type}`);
    },
    addIceCandidate: async cand => { log.addedCandidates.push(cand); },
    close: () => { log.closed = true; pc.signalingState = 'closed'; },
  };
  return pc;
}

// Two negotiators whose signaling flows to each other through an explicit
// mailbox: a send just queues { to, kind, payload }; the TEST decides when (and
// in what order) each message is delivered via deliverNext/pump. Exactly like
// the socket relay: offers route to `handleRemoteDescription` (with the same
// 'accept'/'answer' via mapping the app uses), candidates to the peer.
function pair() {
  const aPc = makeStubPc();
  const bPc = makeStubPc();
  const queue = []; // { to: 'A'|'B', kind: 'invite'|'offer'|'answer'|'ice', payload }
  const A = createCallNegotiator({ pc: aPc, polite: false, send: (kind, payload) => queue.push({ to: 'B', kind, payload }) });
  const B = createCallNegotiator({ pc: bPc, polite: true, send: (kind, payload) => queue.push({ to: 'A', kind, payload }) });
  return { A, B, aPc, bPc, queue };
}

// Deliver one queued message (optionally the first one addressed to `to`).
// Handling is awaited so the target's promise chains (and any follow-up sends)
// run before we return.
async function deliverNext(p, to) {
  const idx = to ? p.queue.findIndex(m => m.to === to) : 0;
  if (idx < 0) throw new Error(`deliverNext: nothing queued${to ? ' for ' + to : ''}`);
  const [m] = p.queue.splice(idx, 1);
  const target = m.to === 'A' ? p.A : p.B;
  if (m.kind === 'ice') await target.handleRemoteCandidate(m.payload);
  else await target.handleRemoteDescription(m.payload, { via: m.kind === 'invite' ? 'accept' : 'answer' });
}

// Advance microtasks in a burst: each awaited null only lets one pending
// continuation run, so a burst lets multi-hop negotiator chains finish sending
// before the caller checks the mailbox again.
async function flush(times = 16) {
  for (let i = 0; i < times; i++) await null;
}

// Deliver queued messages until the pair is quiescent: every message handled,
// then enough microtask bursts that chains started by the last delivery have
// enqueued their follow-ups (captured on the next round). Bounded so a genuine
// negotiation bug fails loudly instead of hanging.
async function pump(p) {
  let deliveries = 0;
  let emptyRounds = 0;
  for (let round = 0; round < 500; round++) {
    let ran = false;
    while (p.queue.length) {
      await deliverNext(p);
      ran = true;
      if (++deliveries > 400) throw new Error('pump: negotiation did not converge');
    }
    await flush(); // let in-flight chains finish and queue their follow-ups
    if (!ran && !p.queue.length) {
      if (++emptyRounds >= 2) return;
    } else {
      emptyRounds = 0;
    }
  }
  throw new Error('pump: negotiation did not quiesce');
}

// Advance ONLY microtasks (never a timer or delivery): lets the negotiators
// finish whatever their promise chains are doing so their sends are queued.
async function spin(times = 64) {
  for (let i = 0; i < times; i++) await null;
}

// Spin until `cond()` holds (microtask-only), failing loudly if it never does.
async function spinUntil(cond, what) {
  for (let i = 0; i < 5000; i++) {
    if (cond()) return;
    await null;
  }
  throw new Error('spinUntil timed out: ' + (what || 'condition'));
}

// Both sides of a pair ended up agreeing on ONE session: each side's local
// descriptor is exactly the peer's remote descriptor (same sid), and both are
// stable. Returns the agreed sid.
function assertAgreed(p) {
  const { aPc, bPc } = p;
  assert.equal(aPc.signalingState, 'stable');
  assert.equal(bPc.signalingState, 'stable');
  assert.ok(aPc.localDescription && aPc.remoteDescription, 'A session complete');
  assert.ok(bPc.localDescription && bPc.remoteDescription, 'B session complete');
  assert.equal(aPc.localDescription.sdp, bPc.remoteDescription.sdp, 'A local == B remote');
  assert.equal(bPc.localDescription.sdp, aPc.remoteDescription.sdp, 'B local == A remote');
  return aPc.localDescription.sdp;
}

test('sequential camera toggles: one clean renegotiation each way', async () => {
  const p = pair();
  const { A, B } = p;

  // Establish the initial call (A invites, B accepts).
  A.negotiate({ via: 'invite' });
  await pump(p);
  const sid0 = assertAgreed(p);
  assert.equal(A.state().makingOffer, false);

  // A turns the camera on → one offer, B answers.
  A.markDirty();
  await pump(p);
  const sid1 = assertAgreed(p);
  assert.notEqual(sid1, sid0, 'fresh session');
  assert.equal(A.state().dirty, false);
  assert.equal(B.state().dirty, false);

  // B turns its camera on → B offers, A answers.
  B.markDirty();
  await pump(p);
  const sid2 = assertAgreed(p);
  assert.notEqual(sid2, sid1);
  assert.equal(A.state().dirty, false);
  assert.equal(B.state().dirty, false);
});

test('rapid toggles while an offer is in flight coalesce into exactly one follow-up', async () => {
  const p = pair();
  const { A, aPc } = p;
  A.negotiate({ via: 'invite' });
  await pump(p);
  assertAgreed(p);

  // Same-tick toggles: the first starts an offer, the rest collapse onto the
  // in-flight negotiation (dirty flag) and never create interleaved offers.
  A.markDirty();
  A.markDirty();
  A.markDirty();
  await pump(p);
  assert.equal(aPc.log.offersCreated, 2, 'the extra toggles must not create interleaved offers');
  assertAgreed(p);
  assert.equal(A.state().makingOffer, false);
  assert.equal(A.state().dirty, false);
});

test('glare: both sides toggle the camera at once — one agreed session, both changes applied', async () => {
  const p = pair();
  const { A, B, aPc, bPc } = p;
  A.negotiate({ via: 'invite' });
  await pump(p);
  assertAgreed(p);
  const aBefore = aPc.log.offersCreated;
  const bBefore = bPc.log.offersCreated;

  // Simultaneous toggles — same tick, before any message is delivered.
  A.markDirty();
  B.markDirty();
  // Both negotiators finish sending their offers (microtasks only), so both are
  // in flight before we deliver anything.
  await spinUntil(() => p.queue.length === 2, 'both glare offers queued');
  await pump(p);

  assertAgreed(p);
  assert.equal(A.state().makingOffer, false);
  assert.equal(B.state().makingOffer, false);
  assert.equal(A.state().ignoreOffer, false);
  assert.equal(B.state().ignoreOffer, false);
  // Despite the collision, only one negotiation round happened: A's offer (1)
  // wins, and B re-offers once (2) so ITS camera change lands. A must NOT
  // re-offer too — that would be the glare ping-pong. No oscillation.
  const aDelta = aPc.log.offersCreated - aBefore;
  const bDelta = bPc.log.offersCreated - bBefore;
  assert.equal(aDelta, 1, 'impolite side offers exactly once');
  assert.equal(bDelta, 2, 'polite side: colliding offer + follow-up re-offer');
});

test('glare in both delivery orders converges to one session', async () => {
  // Order 1: A's offer lands on B first (default FIFO mailbox order).
  const p1 = pair();
  const { A: A1, B: B1 } = p1;
  A1.negotiate({ via: 'invite' });
  await pump(p1);
  assertAgreed(p1);
  A1.markDirty();
  B1.markDirty();
  await spinUntil(() => p1.queue.length === 2, 'order-1 glare offers queued');
  await pump(p1);
  assertAgreed(p1);
  assert.equal(A1.state().ignoreOffer, false);
  assert.equal(B1.state().ignoreOffer, false);

  // Order 2: B's colliding offer lands on A first (opposite delivery order).
  const p2 = pair();
  const { A: A2, B: B2 } = p2;
  A2.negotiate({ via: 'invite' });
  await pump(p2);
  assertAgreed(p2);
  A2.markDirty();
  B2.markDirty();
  await spinUntil(() => p2.queue.length === 2, 'order-2 glare offers queued');
  // Deliver B's offer to A before A's offer reaches B: A (impolite, own offer
  // pending) must ignore it rather than collide.
  await deliverNext(p2, 'A');
  assert.equal(A2.state().ignoreOffer, true, 'impolite side ignores the colliding offer');
  await pump(p2);
  assertAgreed(p2);
  assert.equal(A2.state().ignoreOffer, false, 'collision fully resolved');
});

test('socket reconnect: ICE restart re-establishes the session', async () => {
  const p = pair();
  const { A, B, aPc, bPc } = p;
  A.negotiate({ via: 'invite' });
  await pump(p);
  const sid0 = assertAgreed(p);

  // Socket drops and comes back → both sides restart at the same moment.
  A.restart();
  B.restart();
  await spinUntil(() => p.queue.length >= 2, 'both restart offers queued');
  await pump(p);
  const sid1 = assertAgreed(p);
  assert.notEqual(sid1, sid0, 'restart must produce a fresh session');
  // The agreed session must actually be an ICE restart (whichever side's offer
  // won the collision), or the reconnect did not recover media.
  assert.ok((aPc.remoteDescription.sdp + bPc.remoteDescription.sdp).includes('!restart'), 'agreed session carries the ICE restart');
  assert.equal(A.state().pendingRestart, false);
  assert.equal(B.state().pendingRestart, false);
});

test('socket reconnect with a lost in-flight offer: rollback then ice-restart, never wedged', async () => {
  const p = pair();
  const { A, B, aPc, bPc } = p;
  A.negotiate({ via: 'invite' });
  await pump(p);
  const sid0 = assertAgreed(p);

  // A toggles; the offer is queued but LOST in the drop — it never reaches B.
  A.markDirty();
  await spinUntil(() => A.state().makingOffer, 'offer stranded in the void');
  assert.equal(A.state().makingOffer, true, 'A has an offer stranded in the void');
  assert.equal(p.queue.length, 1, 'exactly the stranded offer is queued');
  p.queue.length = 0; // the drop swallows it
  A.restart(); // rollback the lost offer, then ice-restart
  await pump(p);
  assertAgreed(p);
  assert.equal(A.state().makingOffer, false);
  assert.equal(A.state().signalingState, 'stable');
  assert.ok((aPc.remoteDescription.sdp + bPc.remoteDescription.sdp).includes('!restart'), 'agreed session carries the ICE restart');
  const sid1 = assertAgreed(p);
  assert.notEqual(sid1, sid0);
});

test('impolite side drops candidates belonging to the colliding offer', async () => {
  const p = pair();
  const { A, B, aPc, bPc } = p;
  A.negotiate({ via: 'invite' });
  await pump(p);
  assertAgreed(p);

  // Glare: A and B both offer. Deliver A's offer to B first (B will answer),
  // then deliver B's colliding offer to A while A's offer is still in flight —
  // A ignores it, including its candidates.
  A.markDirty();
  B.markDirty();
  await spinUntil(() => p.queue.length === 2, 'both glare offers queued');
  await deliverNext(p); // A's offer → B
  await deliverNext(p); // B's colliding offer → A (ignored)
  assert.equal(A.state().ignoreOffer, true, 'A is ignoring B colliding offer');
  const candidatesBefore = aPc.log.addedCandidates.length;
  // B's candidates for the colliding offer reach A while A ignores it.
  await A.handleRemoteCandidate({ candidate: 'candidate:b1', sdpMid: '0' });
  await A.handleRemoteCandidate({ candidate: 'candidate:b2', sdpMid: '0' });
  assert.equal(aPc.log.addedCandidates.length, candidatesBefore, 'candidates of the ignored offer are dropped');
  await pump(p);
  assertAgreed(p);
  assert.equal(A.state().ignoreOffer, false, 'collision resolved');
  // After the dust settles, real candidates flow again.
  await A.handleRemoteCandidate({ candidate: 'candidate:b3', sdpMid: '0' });
  await spin();
  assert.ok(aPc.log.addedCandidates.some(c => c.candidate === 'candidate:b3'), 'post-collision candidates accepted');
});

test('close() halts all negotiation', async () => {
  const p = pair();
  const { A, aPc } = p;
  A.negotiate({ via: 'invite' });
  await pump(p);
  assertAgreed(p);
  const offersBefore = aPc.log.offersCreated;
  A.close();
  A.markDirty();
  A.restart();
  await pump(p);
  assert.equal(aPc.log.offersCreated, offersBefore, 'closed negotiator must not send offers');
  assert.equal(A.state().closed, true);
});
