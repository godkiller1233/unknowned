// Group voice/video mesh engine. Members of a community voice channel or a
// temporary voice/video room connect peer-to-peer (full WebRTC mesh) over the
// app's existing authenticated Socket.IO link — no server media relay.
//
// How a pair forms (no "glare"):
//   For every pair the user with the lexicographically SMALLER id is the
//   offerer and creates the RTCPeerConnection + offer; the other side answers.
//   Whichever peer learns about the pair first (via the roster pushed after a
//   voice_join, or a voice_user_joined broadcast) drives exactly that rule, so
//   only one offer ever exists per pair. On a reconnect the socket id changes,
//   peers replace the stale connection for that user and the rule runs again.
//
// Signals ride server-relayed `voice_rtc_*` events targeted at a socket id and
// are routed inside the shared `voice:<channelId>` room, so participants on
// different app instances still negotiate (Socket.IO runs on a PostgreSQL
// adapter and socket ids are unique cluster-wide).

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
const MAX_OFFER_RETRIES = 2;

export function createVoiceMesh({ socket, channelId, me, onRoster, onRemoteStream, onRemoteEnd }) {
  const peers = new Map();            // userId -> { userId, socketId, pc, localInitiated, live, retries }
  const pendingIce = new Map();       // userId -> [candidate]
  let localStream = null;
  let joined = false;
  let roster = [];                    // [{ userId, socketId, username, nickname, avatar, badge, camera }]
  let destroyed = false;
  let myCameraOn = true;

  function emitSignal(event, toSocketId, payload) {
    socket.emit(event, { channelId, toSocketId, ...payload });
  }

  // Expose roster rows with a `live` flag so the UI can show who has real
  // media flowing (self is always "live" while in call).
  function publish() {
    if (destroyed) return;
    onRoster?.((roster || []).map(r => ({
      ...r,
      live: r.userId === me?.id ? Boolean(localStream) : Boolean(peers.get(r.userId)?.live),
    })));
  }

  function closePeer(userId) {
    const entry = peers.get(userId);
    if (!entry) return;
    peers.delete(userId);
    pendingIce.delete(userId);
    try { entry.pc.close(); } catch {}
    if (entry.live || entry.remoteStream) onRemoteEnd?.(userId);
    publish();
  }

  function addLocalTracks(pc) {
    localStream?.getTracks().forEach(t => {
      try { pc.addTrack(t, localStream); } catch {}
    });
  }

  function freshPeer(user, localInitiated) {
    let pc;
    try {
      pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    } catch {
      return null;
    }
    const entry = {
      userId: user.userId,
      socketId: user.socketId,
      pc,
      localInitiated,
      live: false,
      remoteStream: null,
      retries: 0,
      failedTimer: null,
    };
    peers.set(user.userId, entry);
    addLocalTracks(pc);
    pc.ontrack = e => {
      entry.remoteStream = (e.streams && e.streams[0]) || entry.remoteStream;
      if (!entry.live) { entry.live = true; onRemoteStream?.(user.userId); publish(); }
    };
    pc.onicecandidate = e => {
      if (e.candidate) {
        const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
        emitSignal('voice_rtc_ice', user.socketId, { toUserId: user.userId, candidate: c });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        if (!entry.live) { entry.live = true; onRemoteStream?.(user.userId); }
        publish();
      } else if ((state === 'failed' || state === 'closed') && !entry.live) {
        // Transient ICE failure — retry the pair a couple of times, then give
        // up until a roster refresh (someone joins/leaves) restarts it.
        if (entry.failedTimer || entry.retries >= MAX_OFFER_RETRIES) return;
        entry.failedTimer = setTimeout(() => {
          entry.failedTimer = null;
          entry.retries += 1;
          if (peers.get(user.userId) !== entry || !joined || !localStream || destroyed) return;
          closePeer(user.userId);
          const current = roster.find(r => r.userId === user.userId);
          if (current) ensurePeer(current);
        }, 2000);
      }
    };
    return entry;
  }

  async function ensurePeer(user) {
    if (!joined || !localStream || destroyed) return;
    if (!user || user.userId === me?.id) return;
    const existing = peers.get(user.userId);
    if (existing) {
      if (existing.socketId === user.socketId) return; // already current
      closePeer(user.userId);                          // reconnected under a new socket
    }
    // Smaller id is the offerer; as the answerer we wait for their offer.
    if (!(String(me?.id) < String(user.userId))) return;
    const entry = freshPeer(user, true);
    if (!entry) return;
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      emitSignal('voice_rtc_offer', user.socketId, { toUserId: user.userId, sdp: offer });
    } catch {
      closePeer(user.userId);
    }
  }

  async function onOffer(d) {
    if (!joined || destroyed || d.fromUserId === me?.id) return;
    const known = (roster || []).find(r => r.userId === d.fromUserId && r.socketId === d.fromSocketId);
    if (!known) {
      // The server only relays offers from authenticated members of this room,
      // so an offer is authoritative even when that peer's roster event has not
      // landed yet (cross-node event ordering). Add a placeholder row — the
      // profile arrives with voice_user_joined / the next roster snapshot.
      const i = roster.findIndex(r => r.userId === d.fromUserId);
      const placeholder = { userId: d.fromUserId, socketId: d.fromSocketId, username:'', nickname:'', avatar:'', badge:'' };
      if (i >= 0) roster[i] = placeholder; else roster.push(placeholder);
      publish();
    }
    const u = (roster || []).find(r => r.userId === d.fromUserId && r.socketId === d.fromSocketId)
      || { userId: d.fromUserId, socketId: d.fromSocketId };
    let entry = peers.get(d.fromUserId);
    if (!entry || entry.socketId !== d.fromSocketId) {
      if (entry) closePeer(d.fromUserId);
      entry = freshPeer(u, false);
    } else if (entry.localInitiated) {
      // Glare (both offered) — restart clean and answer theirs. With the
      // smaller-id rule this only happens across reconnect races.
      closePeer(d.fromUserId);
      entry = freshPeer(u, false);
    }
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
      flushIce(d.fromUserId);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      emitSignal('voice_rtc_answer', d.fromSocketId, { toUserId: d.fromUserId, sdp: answer });
    } catch {
      closePeer(d.fromUserId);
    }
  }

  async function onAnswer(d) {
    const entry = peers.get(d.fromUserId);
    if (!entry || !entry.localInitiated || entry.socketId !== d.fromSocketId) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
      flushIce(d.fromUserId);
    } catch {
      closePeer(d.fromUserId);
    }
  }

  function onIce(d) {
    if (!d || d.fromUserId === me?.id || !d.candidate) return;
    const entry = peers.get(d.fromUserId);
    // Trickle ICE can beat the offer/answer SDP, so buffer candidates until a
    // peer connection for that user has the remote description. Buffering is
    // keyed by user (not socket) so a reconnect that swaps sockets can still
    // apply candidates that were already in flight.
    const canApply = entry && entry.socketId === d.fromSocketId && entry.pc.remoteDescription;
    if (!canApply) {
      const arr = pendingIce.get(d.fromUserId) || [];
      if (arr.length < 200) arr.push(d.candidate);
      pendingIce.set(d.fromUserId, arr);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(() => {});
  }

  function flushIce(userId) {
    const queued = pendingIce.get(userId);
    if (!queued || !queued.length) return;
    pendingIce.delete(userId);
    const entry = peers.get(userId);
    if (!entry || !entry.pc.remoteDescription) return; // SDP not here yet — stay buffered
    queued.forEach(c => entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
  }

  const isOurs = d => d?.channelId === channelId;

  const onRosterEv = d => {
    if (!isOurs(d)) return;
    roster = (d.users || [])
      .filter(u => u.userId && u.userId !== me?.id)
      .map(u => ({ ...u, camera: u.camera !== false }));
    publish();
    roster.forEach(u => ensurePeer(u));
  };
  const onJoined = d => {
    if (!isOurs(d) || d.userId === me?.id) return;
    const u = {
      userId: d.userId, socketId: d.socketId,
      username: d.username || '', nickname: d.nickname || '', avatar: d.avatar || '', badge: d.badge || '',
      camera: d.camera !== false,
    };
    const i = roster.findIndex(x => x.userId === u.userId);
    if (i >= 0) roster[i] = u; else roster.push(u);
    publish();
    ensurePeer(u);
    // A fresh joiner has no idea our camera is off (the server roster has no
    // per-client state) — tell them right away.
    if (!myCameraOn && socket.connected) socket.emit('voice_camera', { channelId, userId: me?.id, on: false });
  };
  const onCamera = d => {
    if (!isOurs(d) || d.userId === me?.id) return;
    const i = roster.findIndex(x => x.userId === d.userId);
    if (i < 0) return;
    roster[i] = { ...roster[i], camera: d.on !== false };
    publish();
  };
  const onLeft = d => {
    if (!isOurs(d)) return;
    const i = roster.findIndex(x => x.userId === d.userId && x.socketId === d.socketId);
    if (i >= 0) roster.splice(i, 1);
    publish();
    const entry = peers.get(d.userId);
    if (entry && entry.socketId === d.socketId) closePeer(d.userId);
  };
  const onOfferEv = d => { if (isOurs(d)) onOffer(d); };
  const onAnswerEv = d => { if (isOurs(d)) onAnswer(d); };
  const onIceEv = d => { if (isOurs(d)) onIce(d); };
  const onCameraEv = d => { if (isOurs(d)) onCamera(d); };
  // Reconnect: socket rooms (and this socket id) are gone — re-announce so the
  // server pushes a fresh roster and peers replace the stale socket for us.
  const onReconnect = () => {
    if (joined && localStream && !destroyed && socket.connected) {
      socket.emit('voice_join', { channelId, userId: me?.id });
      if (!myCameraOn) socket.emit('voice_camera', { channelId, userId: me?.id, on: false });
    }
  };

  socket.on('voice_roster', onRosterEv);
  socket.on('voice_user_joined', onJoined);
  socket.on('voice_user_left', onLeft);
  socket.on('voice_camera', onCameraEv);
  socket.on('voice_rtc_offer', onOfferEv);
  socket.on('voice_rtc_answer', onAnswerEv);
  socket.on('voice_rtc_ice', onIceEv);
  socket.on('connect', onReconnect);

  return {
    /** Start the mesh: capture stream first, then announce voice_join. */
    join(stream) {
      if (destroyed) return;
      localStream = stream;
      joined = true;
      publish();
      socket.emit('voice_join', { channelId, userId: me?.id });
    },
    /** Leave the channel/room and tear down every peer connection. */
    leave() {
      joined = false;
      for (const userId of [...peers.keys()]) closePeer(userId);
      roster = [];
      pendingIce.clear();
      if (socket.connected) socket.emit('voice_leave', { channelId, userId: me?.id });
      localStream = null;
      publish();
    },
    /** Media stream received from a peer, or null while connecting. */
    streamFor(userId) {
      return peers.get(userId)?.remoteStream || null;
    },
    /** Turn the local camera on/off: disables the video track (stops sending)
     *  and tells every peer so they swap the frozen video for a placeholder. */
    setCamera(on) {
      myCameraOn = !!on;
      const videoTracks = localStream?.getVideoTracks?.() || [];
      videoTracks.forEach(t => { try { t.enabled = myCameraOn; } catch {} });
      if (joined && socket.connected) {
        socket.emit('voice_camera', { channelId, userId: me?.id, on: myCameraOn });
      }
      return myCameraOn;
    },
    /** Whether this client currently has the camera on. */
    cameraOn() {
      return myCameraOn;
    },
    /** Remove socket listeners + leave. Safe to call twice. */
    destroy() {
      if (destroyed) return;
      destroyed = true;
      this.leave();
      socket.off('voice_roster', onRosterEv);
      socket.off('voice_user_joined', onJoined);
      socket.off('voice_user_left', onLeft);
      socket.off('voice_camera', onCameraEv);
      socket.off('voice_rtc_offer', onOfferEv);
      socket.off('voice_rtc_answer', onAnswerEv);
      socket.off('voice_rtc_ice', onIceEv);
      socket.off('connect', onReconnect);
    },
  };
}
