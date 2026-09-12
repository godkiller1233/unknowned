import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceMesh } from '../src/mesh.js';
import { applyRtcConfig } from '../src/rtc.js';

const created = [];
class FakePC {
  constructor(options) { this.options = options; created.push(this); }
  addTrack() {}
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async setLocalDescription() {}
  close() {}
}
global.RTCPeerConnection = FakePC;

function socket(id) {
  const handlers = new Map();
  return {
    id,
    connected: true,
    on(name, fn) { handlers.set(name, fn); },
    off(name) { handlers.delete(name); },
    emit() {},
    fire(name, value) { handlers.get(name)?.(value); },
  };
}

const stream = { getTracks: () => [] };

test('group meshes use the shared bootstrap TURN config', async () => {
  const iceServers = [
    { urls: ['stun:stun.relay.metered.ca:80'] },
    { urls: ['turn:global.relay.metered.ca:80?transport=tcp'], username: 'u', credential: 'p' },
  ];
  applyRtcConfig({ rtc: { iceServers } });
  const voiceSocket = socket('a');
  const voice = createVoiceMesh({ socket: voiceSocket, channelId: 'voice-channel', me: { id: 'a' } });
  voice.join(stream);
  voiceSocket.fire('voice_roster', { channelId: 'voice-channel', users: [{ userId: 'b', socketId: 'z', username: 'b' }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(created.at(-1).options.iceServers, iceServers);
  voice.destroy();

  const roomSocket = socket('a');
  const room = createVoiceMesh({ socket: roomSocket, channelId: 'temporary-room', me: { id: 'a' } });
  room.join(stream);
  roomSocket.fire('voice_roster', { channelId: 'temporary-room', users: [{ userId: 'b', socketId: 'z', username: 'b' }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(created.at(-1).options.iceServers, iceServers);
  room.destroy();
});
