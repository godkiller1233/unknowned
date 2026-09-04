// Shared ICE configuration for every WebRTC surface (DM calls, voice-channel and
// temp-room meshes). The server publishes the operator's TURN settings
// (TURN_URLS / TURN_USERNAME / TURN_CREDENTIAL) inside /api/bootstrap as
// `rtc.iceServers`; this module caches that list so all peer connections are
// created with the same servers. Until config arrives — or when the operator
// runs no TURN server — clients fall back to a public STUN server, which is
// enough for most connections but not for users behind symmetric NAT.
export const DEFAULT_ICE_SERVERS = [{ urls: ['stun:stun.l.google.com:19302'] }];

let iceServers = DEFAULT_ICE_SERVERS;

/** Adopt the `rtc` payload from a /api/bootstrap response (no-op if absent). */
export function applyRtcConfig(boot) {
  const list = boot && boot.rtc && Array.isArray(boot.rtc.iceServers) && boot.rtc.iceServers.length
    ? boot.rtc.iceServers
    : null;
  if (list) iceServers = list;
  return iceServers;
}

/** Current ICE server list to pass to `new RTCPeerConnection({ iceServers })`. */
export function getIceServers() {
  return iceServers;
}

/** True when the current config includes at least one TURN relay url. */
export function hasTurnRelay() {
  return iceServers.some(s => (s.urls || []).some(u => /^turns?:/i.test(String(u))));
}
