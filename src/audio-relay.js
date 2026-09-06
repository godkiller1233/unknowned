// Phone-call fallback for voice/video when the direct WebRTC link cannot
// connect (symmetric NAT, carrier CGNAT, firewalls — any ICE failure).
//
// The mic stream is re-encoded with MediaRecorder (opus, ~300ms chunks) and the
// chunks ride the app's existing authenticated socket connection through the
// server, exactly like call signaling. The receiver decodes each chunk and
// schedules it for playback, exposing the result as a normal MediaStream so
// every existing UI surface (tiles, <audio>/<video> srcObject, speaker sink,
// speaking indicator) keeps working unchanged.
//
// MediaRecorder emits a container header in the FIRST chunk; later chunks are
// headerless clusters. The receiver caches that header and prepends it to every
// following chunk so each one decodes standalone. Playback keeps a small look-
// ahead and skips ahead if the network ever piles up.

const CHUNK_INTERVAL_MS = 300;
const MAX_LOOKAHEAD_S = 0.6;

export function bufferToBase64(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin);
}

export function base64ToBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** Encode a local MediaStream's audio into base64 chunks. */
export function createAudioRelaySender({ stream, emit }) {
  let ctx = null;
  let recorder = null;
  let stopped = false;
  try {
    const AC = (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : undefined);
    ctx = new AC();
    const src = ctx.createMediaStreamSource(stream);
    const dest = ctx.createMediaStreamDestination();
    src.connect(dest);
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']
      .find(m => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) || '';
    recorder = new MediaRecorder(dest.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 });
    recorder.ondataavailable = async e => {
      if (stopped || !e.data || !e.data.size) return;
      try {
        const buf = await e.data.arrayBuffer();
        if (!stopped) emit(bufferToBase64(buf));
      } catch { /* chunk lost — the stream self-corrects in 300ms */ }
    };
    recorder.start(CHUNK_INTERVAL_MS);
  } catch { /* no AudioContext/MediaRecorder — caller stays on P2P only */ }
  return {
    /** True while the encoder is producing chunks. */
    get active() { return Boolean(recorder) && recorder.state === 'recording' && !stopped; },
    stop() {
      stopped = true;
      try { recorder?.stop(); } catch {}
      try { ctx?.close(); } catch {}
      recorder = null; ctx = null;
    },
  };
}

/** Decode relayed chunks and expose them as a live MediaStream. */
export function createAudioRelayReceiver() {
  const AC = (typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : undefined);
  let ctx = null;
  let dest = null;
  let header = null;        // first chunk bytes (container header)
  let playAt = 0;           // next scheduled playback time on the AudioContext
  let stopped = false;
  try {
    ctx = new AC();
    dest = ctx.createMediaStreamDestination();
  } catch { /* decode impossible — caller falls back to silence */ }

  async function absorb(b64) {
    if (stopped || !ctx) return;
    let bytes = new Uint8Array(base64ToBuffer(b64));
    if (!header) {
      // The very first chunk must carry the container header; if we joined
      // mid-stream, skip until a fresh sender restarts (new call/mic burst).
      header = bytes;
      return;
    }
    try {
      const merged = new Uint8Array(header.length + bytes.length);
      merged.set(header, 0); merged.set(bytes, header.length);
      const audio = await ctx.decodeAudioData(merged.buffer);
      if (stopped) return;
      const now = ctx.currentTime;
      if (playAt < now) playAt = now + 0.05;
      if (playAt - now > MAX_LOOKAHEAD_S) playAt = now + 0.05; // drop the backlog
      const buffer = ctx.createBufferSource();
      buffer.buffer = audio;
      buffer.connect(dest);
      buffer.start(playAt);
      playAt += audio.duration;
    } catch { /* undecodable cluster — skip it */ }
  }

  return {
    /** MediaStream carrying the decoded relayed audio (for srcObject). */
    stream: dest ? dest.stream : null,
    absorb,
    reset() { header = null; playAt = 0; },
    stop() {
      stopped = true;
      try { ctx?.close(); } catch {}
      ctx = null; dest = null;
    },
  };
}
