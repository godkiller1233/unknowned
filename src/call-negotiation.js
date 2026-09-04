// Minimal perfect-negotiation state machine for DM calls (MDN "Perfect
// negotiation"). Hardens renegotiation against two real-world failure modes:
//
// 1. GLARE — both participants toggle the camera at the same moment and both
//    send offers. Naive rollback-and-answer on both sides produces two
//    different sessions and broken media. One side is marked "polite" (the
//    callee): on a collision it rolls back its own offer and answers the
//    peer's. The "impolite" side (the caller) ignores the colliding offer; its
//    pending offer wins, and a follow-up offer applies the polite side's
//    changes. Both sides' camera changes still land — no deadlock.
//
// 2. RECONNECT — a socket.io drop can swallow an in-flight offer/answer and
//    wedge the session. `restart()` rolls back a lost local offer and forces an
//    ICE-restart renegotiation from stable state once the socket is back.
//
// Every negotiation is serialized: `markDirty()` while an offer is already in
// flight only sets a flag, and the settled negotiation re-runs to apply it, so
// rapid camera on/off/on toggles can never interleave two offers.
//
// The module is framework-free: the caller supplies the RTCPeerConnection, a
// `polite` flag, and a `send(kind, payload)` callback
// (kind ∈ invite|accept|offer|answer|ice). All SDP objects are plain
// `{ type, sdp }` / `{ candidate, sdpMid, sdpMLineIndex }` values.
export function createCallNegotiator({ pc, polite, send }) {
  let makingOffer = false;    // we sent an offer and are awaiting its answer
  let ignoreOffer = false;    // impolite side: drop the colliding incoming offer
  let dirty = false;          // local changes still need a negotiation
  let pendingRestart = false; // ICE restart queued behind an in-flight negotiation
  let negotiating = false;    // synchronous guard — an offer creation is running
  let closed = false;
  let chain = Promise.resolve();

  function queue(fn) {
    const next = chain.then(() => fn()).catch(() => {});
    chain = next;
    return next;
  }

  function normalize(desc) {
    return { type: String(desc.type || '').toLowerCase(), sdp: desc.sdp || '' };
  }

  function toPlain(desc) {
    return desc && typeof desc.toJSON === 'function' ? desc.toJSON() : desc;
  }

  // Create and send an offer (optionally with ICE restart). Safe to call from
  // anywhere: a synchronous `negotiating` guard prevents concurrent offers, and
  // anything that cannot run right now is remembered via `dirty`.
  async function maybeNegotiate(restart, kind = 'offer') {
    if (closed) return;
    if (restart) pendingRestart = true;
    if (negotiating) { dirty = true; return; }
    negotiating = true;
    try {
      if (makingOffer || pc.signalingState !== 'stable') { dirty = true; return; }
      // pendingRestart stays set until a restart offer is actually ANSWERED
      // (cleared in handleRemoteDescription): if this offer collides and the
      // polite side rolls back, its follow-up re-offer must restart too, or the
      // winning session would silently skip the ICE restart.
      const iceRestart = pendingRestart;
      let offer;
      try {
        offer = await pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      } catch {
        return;
      }
      await pc.setLocalDescription(offer);
      makingOffer = true;
      dirty = false;
      send(kind, toPlain(offer));
    } catch {
      makingOffer = false;
    } finally {
      negotiating = false;
    }
  }

  return {
    // Explicit negotiation for the initial call (invite) or mid-call (offer).
    negotiate(opts = {}) {
      return queue(() => maybeNegotiate(Boolean(opts.iceRestart), opts.via || 'offer'));
    },

    // A local media change happened (camera toggled). Apply it when the line is
    // clear — if a negotiation is in flight it converges right after.
    markDirty() {
      if (closed) return;
      dirty = true;
      maybeNegotiate(false);
    },

    // Incoming SDP from the peer. `via` picks how OUR answer is sent:
    // 'accept' for the initial call_accept, 'answer' for mid-call rtc_answer.
    async handleRemoteDescription(descRaw, { via } = {}) {
      if (closed) return;
      const desc = normalize(descRaw);
      if (desc.type !== 'offer' && desc.type !== 'answer') return;
      const collision = desc.type === 'offer' && (makingOffer || pc.signalingState !== 'stable');
      if (collision) {
        if (polite) {
          // Their offer wins: roll our pending offer back (its changes are
          // re-sent by the converge step after we answer) and absorb theirs.
          try {
            await pc.setLocalDescription({ type: 'rollback' });
          } catch { /* not rollbackable — setRemoteDescription supersedes */ }
          makingOffer = false;
          dirty = true;
        } else {
          // Impolite: our offer is in flight, so drop theirs. Our pending offer
          // already carries OUR changes, and the polite side is dirty after its
          // rollback and will re-offer ITS changes — so we must NOT set dirty
          // here, or both sides would re-offer forever.
          ignoreOffer = true;
          return;
        }
      }
      try {
        await pc.setRemoteDescription(desc);
      } catch {
        return;
      }
      ignoreOffer = false;
      if (desc.type === 'offer') {
        try {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          send(via === 'accept' ? 'accept' : 'answer', toPlain(answer));
        } catch { /* nothing sensible to send */ }
      } else {
        makingOffer = false;
        // Our offer (with any ICE restart) was accepted — the restart happened.
        pendingRestart = false;
      }
      // Converge: local changes that queued up behind that negotiation now
      // need their own offer (or an ICE restart is pending).
      if (!closed && !makingOffer && pc.signalingState === 'stable' && (dirty || pendingRestart)) {
        maybeNegotiate(pendingRestart);
      }
    },

    // Incoming ICE candidate. While we are ignoring a colliding offer, its
    // candidates are dropped too (they belong to the session we rejected).
    async handleRemoteCandidate(candidate) {
      if (closed || ignoreOffer) return;
      try { await pc.addIceCandidate(candidate); } catch { /* raced */ }
    },

    // Local ICE candidate — always relayed.
    handleLocalCandidate(candidate) {
      if (closed) return;
      send('ice', {
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      });
    },

    // Socket reconnected: recover the media path. If our offer was lost in the
    // drop, roll it back first (only our OWN lost offer — incoming offers stay
    // subject to the impolite ignore rule), then ICE-restart from stable.
    restart() {
      if (closed) return;
      queue(async () => {
        pendingRestart = true;
        if (makingOffer && pc.signalingState === 'have-local-offer') {
          try {
            await pc.setLocalDescription({ type: 'rollback' });
            makingOffer = false;
          } catch { /* stay as-is; maybeNegotiate will retry from whatever state */ }
        }
        await maybeNegotiate(true);
      });
    },

    // Test/debug introspection.
    state() {
      return { makingOffer, ignoreOffer, dirty, pendingRestart, negotiating, closed, signalingState: pc.signalingState };
    },

    close() {
      closed = true;
      dirty = false;
      pendingRestart = false;
      makingOffer = false;
      ignoreOffer = false;
      chain = Promise.resolve();
    },
  };
}