// Group voice/video mesh engine. Members of a community voice channel or a
// temporary voice/video room connect peer-to-peer (full WebRTC mesh) over the
// app's existing authenticated Socket.IO link — no server media relay.
//
// Peers are keyed by SESSION (socket id), not by user id. The same account
// joined from two devices is two participants: each session gets its own tile,
// its own peer connection, and its own media. The server puts `socketId` on
// every roster row, join/leave event, and relayed signal.
//
// How a pair forms (no "glare"):
//   For every pair the session with the lexicographically SMALLER socket id is
//   the offerer and creates the RTCPeerConnection + offer; the other side
//   answers. Whichever peer learns about the pair first (via the roster pushed
//   after a voice_join, or a voice_user_joined broadcast) drives exactly that
//   rule, so only one offer ever exists per pair. On a reconnect the socket id
//   changes, the stale session's peer is torn down and the rule runs again for
//   the new session.
//
// Signals ride server-relayed `voice_rtc_*` events targeted at a socket id and
// are routed inside the shared `voice:<channelId>` room, so participants on
// different app instances still negotiate (Socket.IO runs on a PostgreSQL
// adapter and socket ids are unique cluster-wide).

import { getIceServers } from './rtc.js';

const MAX_OFFER_RETRIES = 2;

export function createVoiceMesh({ socket, channelId, me, onRoster, onRemoteStream, onRemoteEnd, iceServers }) {
  const peers = new Map();            // socketId -> { userId, socketId, pc, localInitiated, live, remoteStream, retries }
  const pendingIce = new Map();       // socketId -> [candidate]
  let localStream = null;
  let joined = false;
  let roster = [];                    // [{ userId, socketId, username, nickname, avatar, badge, camera }]
  let destroyed = false;
  let myCameraOn = true;

  // Identity of THIS session, read live: after a reconnect the socket id
  // changes and every self-comparison must use the current one.
  const mySocketId = () => socket.id;
  const isSelf = socketId => socketId && socketId === mySocketId();

  // Deterministic offer rule for a pair of sessions.
  const isOfferer = theirSocketId => String(mySocketId()) < String(theirSocketId);

  function emitSignal(event, toSocketId, payload) {
    socket.emit(event, { channelId, toSocketId, ...payload });
  }

  // Expose roster rows with a `live` flag so the UI can show who has real
  // media flowing. Self never appears in the roster (the server excludes this
  // socket), so every row is a remote session — including this account's own
  // sessions on other devices, which are regular peers.
  function publish() {
    if (destroyed) return;
    onRoster?.((roster || []).map(r => ({
      ...r,
      live: Boolean(peers.get(r.socketId)?.live),
    })));
  }

  function closePeer(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    peers.delete(peerId);
    pendingIce.delete(peerId);
    try { entry.pc.close(); } catch {}
    if (entry.live || entry.remoteStream) onRemoteEnd?.(peerId);
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
      pc = new RTCPeerConnection({ iceServers: iceServers || getIceServers() });
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
    peers.set(user.socketId, entry);
    addLocalTracks(pc);
    pc.ontrack = e => {
      entry.remoteStream = (e.streams && e.streams[0]) || entry.remoteStream;
      if (!entry.live) { entry.live = true; onRemoteStream?.(entry.socketId); publish(); }
    };
    pc.onicecandidate = e => {
      if (e.candidate) {
        const c = e.candidate.toJSON ? e.candidate.toJSON() : e.candidate;
        emitSignal('voice_rtc_ice', entry.socketId, { candidate: c });
      }
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === 'connected') {
        if (!entry.live) { entry.live = true; onRemoteStream?.(entry.socketId); }
        publish();
      } else if ((state === 'failed' || state === 'closed') && !entry.live) {
        // Transient ICE failure — retry the pair a couple of times, then give
        // up until a roster refresh (someone joins/leaves) restarts it.
        if (entry.failedTimer || entry.retries >= MAX_OFFER_RETRIES) return;
        entry.failedTimer = setTimeout(() => {
          entry.failedTimer = null;
          entry.retries += 1;
          if (peers.get(entry.socketId) !== entry || !joined || !localStream || destroyed) return;
          const sid = entry.socketId;
          closePeer(sid);
          const current = roster.find(r => r.socketId === sid);
          if (current) ensurePeer(current);
        }, 2000);
      }
    };
    return entry;
  }

  async function ensurePeer(user) {
    if (!joined || !localStream || destroyed) return;
    if (!user?.socketId || isSelf(user.socketId)) return;
    const existing = peers.get(user.socketId);
    if (existing) return; // already current for this session
    // Smaller socket id is the offerer; as the answerer we wait for their offer.
    if (!isOfferer(user.socketId)) return;
    const entry = freshPeer(user, true);
    if (!entry) return;
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      emitSignal('voice_rtc_offer', entry.socketId, { sdp: offer });
    } catch {
      closePeer(entry.socketId);
    }
  }

  async function onOffer(d) {
    if (!joined || destroyed || isSelf(d.fromSocketId)) return;
    let u = (roster || []).find(r => r.userId === d.fromUserId && r.socketId === d.fromSocketId);
    if (!u) {
      // The server only relays offers from authenticated members of this room,
      // so an offer is authoritative even when that peer's roster event has not
      // landed yet (cross-node event ordering). Add a placeholder row — the
      // profile arrives with voice_user_joined / the next roster snapshot.
      u = { userId: d.fromUserId, socketId: d.fromSocketId, username: '', nickname: '', avatar: '', badge: '', camera: true };
      roster.push(u);
      publish();
    }
    let entry = peers.get(d.fromSocketId);
    if (!entry || entry.localInitiated) {
      // Glare (both offered) — restart clean and answer theirs. With the
      // smaller-socket-id rule this only happens across reconnect races.
      if (entry) closePeer(d.fromSocketId);
      entry = freshPeer(u, false);
    }
    if (!entry) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
      flushIce(d.fromSocketId);
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription(answer);
      emitSignal('voice_rtc_answer', d.fromSocketId, { sdp: answer });
    } catch {
      closePeer(d.fromSocketId);
    }
  }

  async function onAnswer(d) {
    const entry = peers.get(d.fromSocketId);
    if (!entry || !entry.localInitiated) return;
    try {
      await entry.pc.setRemoteDescription(new RTCSessionDescription(d.sdp));
      flushIce(d.fromSocketId);
    } catch {
      closePeer(d.fromSocketId);
    }
  }

  function onIce(d) {
    if (!d?.candidate || isSelf(d.fromSocketId)) return;
    const entry = peers.get(d.fromSocketId);
    // Trickle ICE can beat the offer/answer SDP, so buffer candidates until the
    // peer connection for that session has the remote description. Buffering
    // is keyed by socket id: candidates from a stale session can never be
    // applied to the replacement connection by mistake.
    if (!entry || !entry.pc.remoteDescription) {
      const arr = pendingIce.get(d.fromSocketId) || [];
      if (arr.length < 200) arr.push(d.candidate);
      pendingIce.set(d.fromSocketId, arr);
      return;
    }
    entry.pc.addIceCandidate(new RTCIceCandidate(d.candidate)).catch(() => {});
  }

  function flushIce(peerId) {
    const queued = pendingIce.get(peerId);
    if (!queued || !queued.length) return;
    pendingIce.delete(peerId);
    const entry = peers.get(peerId);
    if (!entry || !entry.pc.remoteDescription) return; // SDP not here yet — stay buffered
    queued.forEach(c => entry.pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
  }

  const isOurs = d => d?.channelId === channelId;

  const onRosterEv = d => {
    if (!isOurs(d)) return;
    roster = (d.users || [])
      .filter(u => u.userId && u.socketId && !isSelf(u.socketId))
      .map(u => ({ ...u, camera: u.camera !== false }));
    publish();
    roster.forEach(u => ensurePeer(u));
  };
  const onJoined = d => {
    if (!isOurs(d) || isSelf(d.socketId)) return;
    const u = {
      userId: d.userId, socketId: d.socketId,
      username: d.username || '', nickname: d.nickname || '', avatar: d.avatar || '', badge: d.badge || '',
      camera: d.camera !== false,
    };
    const i = roster.findIndex(x => x.socketId === u.socketId);
    if (i >= 0) roster[i] = u; else roster.push(u);
    publish();
    ensurePeer(u);
    // A fresh joiner has no idea our camera is off (the server roster has no
    // per-client state) — tell them right away.
    if (!myCameraOn && socket.connected) socket.emit('voice_camera', { channelId, on: false });
  };
  const onCamera = d => {
    if (!isOurs(d) || isSelf(d.socketId)) return;
    const i = roster.findIndex(x => (d.socketId ? x.socketId === d.socketId : x.userId === d.userId));
    if (i < 0) return;
    roster[i] = { ...roster[i], camera: d.on !== false };
    publish();
  };
  const onLeft = d => {
    if (!isOurs(d)) return;
    const i = roster.findIndex(x => (d.socketId ? x.socketId === d.socketId : x.userId === d.userId));
    if (i >= 0) roster.splice(i, 1);
    publish();
    if (d.socketId) {
      closePeer(d.socketId);
    } else {
      // Legacy event without a socket id: drop every session of that user.
      for (const [sid, entry] of [...peers]) {
        if (entry.userId === d.userId) closePeer(sid);
      }
    }
  };
  const onOfferEv = d => { if (isOurs(d)) onOffer(d); };
  const onAnswerEv = d => { if (isOurs(d)) onAnswer(d); };
  const onIceEv = d => { if (isOurs(d)) onIce(d); };
  const onCameraEv = d => { if (isOurs(d)) onCamera(d); };
  // Reconnect: socket rooms (and this socket id) are gone — re-announce so the
  // server pushes a fresh roster and peers replace the stale session for us.
  const onReconnect = () => {
    if (joined && localStream && !destroyed && socket.connected) {
      socket.emit('voice_join', { channelId });
      if (!myCameraOn) socket.emit('voice_camera', { channelId, on: false });
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
      socket.emit('voice_join', { channelId });
    },
    /** Leave the channel/room and tear down every peer connection. */
    leave() {
      joined = false;
      for (const sid of [...peers.keys()]) closePeer(sid);
      roster = [];
      pendingIce.clear();
      if (socket.connected) socket.emit('voice_leave', { channelId });
      localStream = null;
      publish();
    },
    /** Media stream received from a peer session, or null while connecting. */
    streamFor(socketId) {
      return peers.get(socketId)?.remoteStream || null;
    },
    /** Turn the local camera on/off: disables the video track (stops sending)
     *  and tells every peer so they swap the frozen video for a placeholder. */
    setCamera(on) {
      myCameraOn = !!on;
      const videoTracks = localStream?.getVideoTracks?.() || [];
      videoTracks.forEach(t => { try { t.enabled = myCameraOn; } catch {} });
      if (joined && socket.connected) {
        socket.emit('voice_camera', { channelId, on: myCameraOn });
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
