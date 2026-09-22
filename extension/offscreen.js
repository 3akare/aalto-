/**
 * Offscreen worker: owns the microphone, the speaker, and the live audio stream.
 *
 * It lives outside the popup because the popup is destroyed as soon as it loses
 * focus - the instant Aalto opens or switches a tab. It is not the background
 * worker because a service worker has no DOM, so no getUserMedia and no Audio.
 *
 * Audio is streamed to the server WHILE the user speaks rather than recorded and
 * sent afterwards. That matters more than it sounds: with record-then-send, the
 * transcription clock only starts once the speaker stops, so a six-second command
 * cost six seconds of recording plus another six of transcription. Streaming
 * overlaps the two, and the reply lands about as soon as the sentence ends.
 */

const SILENCE_RMS = 0.012; // below this counts as room tone rather than speech
const SILENCE_HOLD_MS = 800; // quiet for this long after speech -> commit
const LEAD_IN_GRACE_MS = 4000; // wait at least this long for someone to start
const MAX_UTTERANCE_MS = 25_000; // hard stop
const SAMPLE_RATE = 16_000; // what Sahara wants; asking for it avoids resampling
const FRAME_BYTES = 8192; // 0.25s of PCM16 - inside Sahara's 1-32KB chunk window
const LEVEL_INTERVAL_MS = 50; // waveform updates; see the throttle in onSamples
const COMMIT_TIMEOUT_MS = 45_000; // give up if the server never answers a commit

let stream = null;
let audioCtx = null;
let worklet = null;
let source = null;
let socket = null;
let player = null;

let pending = []; // Int16 frames not yet sent
let pendingBytes = 0;
let startedAt = 0;
let lastVoiceAt = 0;
let heardVoice = false;
let active = false;
let lastLevelAt = 0;
let commitTimer = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  switch (message.type) {
    case "START_STREAM":
      startStream(message.config)
        .then(() => sendResponse({ ok: true }))
        // The name matters: the worker uses NotAllowedError to decide whether to
        // open the permission page, and err.message alone is vague.
        .catch((err) => sendResponse({ ok: false, error: err.message, name: err.name }));
      return true;

    case "STOP_STREAM":
      finish("manual")
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "ABORT_STREAM":
      teardown();
      sendResponse({ ok: true });
      return false;

    case "PLAY_AUDIO":
      play(message.url)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "STOP_AUDIO":
      stopPlayback();
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

// --- capture ----------------------------------------------------------------

async function startStream(config) {
  if (active) throw new Error("already streaming");

  // Held open across commands so repeated use does not re-prompt or re-negotiate
  // the device, which adds a noticeable delay before the first syllable lands.
  if (!stream) {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: SAMPLE_RATE,
      },
    });
  }

  // Asking the context for 16 kHz means the browser resamples once, correctly,
  // and nothing downstream has to.
  if (!audioCtx || audioCtx.sampleRate !== SAMPLE_RATE) {
    if (audioCtx) await audioCtx.close();
    audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    await audioCtx.audioWorklet.addModule("pcm-worklet.js");
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();

  await openSocket(config);

  pending = [];
  pendingBytes = 0;
  startedAt = Date.now();
  lastVoiceAt = 0;
  heardVoice = false;
  active = true;

  source = audioCtx.createMediaStreamSource(stream);
  worklet = new AudioWorkletNode(audioCtx, "pcm-capture");
  worklet.port.onmessage = (e) => onSamples(e.data);
  source.connect(worklet);
  // Deliberately not connected to the destination: routing the microphone to the
  // speakers would echo the user back at themselves.
}

function onSamples(float32) {
  if (!active) return;

  let sum = 0;
  const int16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    sum += s * s;
  }
  const rms = Math.sqrt(sum / float32.length);

  const now = Date.now();
  // A render quantum is 128 samples, so this runs ~125 times a second. Posting a
  // message per call floods the service worker badly enough to stall the whole
  // command, which looks exactly like a stream that never ends. The waveform
  // needs about 20 updates a second, not 125.
  if (now - lastLevelAt >= LEVEL_INTERVAL_MS) {
    lastLevelAt = now;
    // Nobody may be listening to the waveform; that is not an error.
    chrome.runtime.sendMessage({ type: "LEVEL", value: rms }).catch(() => {});
  }

  pending.push(int16);
  pendingBytes += int16.byteLength;
  if (pendingBytes >= FRAME_BYTES) flush();

  if (rms >= SILENCE_RMS) {
    heardVoice = true;
    lastVoiceAt = now;
  }

  const elapsed = now - startedAt;
  const quietFor = lastVoiceAt ? now - lastVoiceAt : 0;

  if (heardVoice && quietFor >= SILENCE_HOLD_MS) finish("silence");
  else if (!heardVoice && elapsed >= LEAD_IN_GRACE_MS) finish("nothing heard");
  else if (elapsed >= MAX_UTTERANCE_MS) finish("max length");
}

function flush() {
  if (pending.length === 0) return;
  const merged = new Int16Array(pendingBytes / 2);
  let offset = 0;
  for (const chunk of pending) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  pending = [];
  pendingBytes = 0;

  if (socket?.readyState === WebSocket.OPEN) socket.send(merged.buffer);
}

// --- transport --------------------------------------------------------------

function openSocket(config) {
  return new Promise((resolve, reject) => {
    const url = `${config.serverUrl.replace(/^http/, "ws")}/api/stream`;
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    const failFast = () => reject(new Error("could not reach the Aalto server"));
    socket.addEventListener("error", failFast, { once: true });

    socket.addEventListener("open", () => {
      socket.removeEventListener("error", failFast);
      socket.send(
        JSON.stringify({
          type: "start",
          languageCode: config.languageCode,
          apiKey: config.apiKey,
          context: config.context,
        })
      );
      resolve();
    });

    // Everything the server says is forwarded to the background worker, which
    // owns the state machine. This document only handles audio.
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      try {
        const parsed = JSON.parse(event.data);
        if (parsed.type !== "partial" && parsed.type !== "open") clearTimeout(commitTimer);
        // The server closes right after a terminal event. Leaving `active` set
        // means the close handler then reports "the connection dropped" on top of
        // the real reason, and the real reason is the one worth reading.
        if (parsed.type === "error" || parsed.type === "plan" || parsed.type === "empty") {
          active = false;
        }
        chrome.runtime.sendMessage({ type: "STREAM_EVENT", event: parsed });
      } catch {
        // Malformed frame; the server-side error path reports the real problem.
      }
    });

    socket.addEventListener("close", () => {
      if (active) {
        active = false;
        chrome.runtime
          .sendMessage({
            type: "STREAM_EVENT",
            event: { type: "error", message: "the connection to the server dropped" },
          })
          .catch(() => {});
      }
      teardownCapture();
    });
  });
}

/** Stop capturing, send whatever is buffered, and ask the server to commit. */
async function finish(reason) {
  if (!active) return;
  active = false;

  teardownCapture();
  flush();

  if (socket?.readyState !== WebSocket.OPEN) return;
  if (!heardVoice && reason === "nothing heard") {
    socket.send(JSON.stringify({ type: "abort", reason }));
    socket.close();
    return;
  }

  // Tell the worker the microphone is closed BEFORE waiting on the server.
  // Otherwise the popup sits on "Listening" through the whole commit, and a
  // slow transcription is indistinguishable from a stream that never ended.
  chrome.runtime
    .sendMessage({ type: "STREAM_EVENT", event: { type: "committing", reason } })
    .catch(() => {});

  socket.send(JSON.stringify({ type: "commit" }));

  // The server has its own timeouts, but if the socket simply goes quiet the
  // user would wait forever. Fail loudly instead.
  clearTimeout(commitTimer);
  commitTimer = setTimeout(() => {
    chrome.runtime
      .sendMessage({
        type: "STREAM_EVENT",
        event: { type: "error", message: "the server stopped responding" },
      })
      .catch(() => {});
    teardown();
  }, COMMIT_TIMEOUT_MS);
}

function teardownCapture() {
  if (worklet) {
    worklet.port.onmessage = null;
    worklet.disconnect();
    worklet = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
}

function teardown() {
  active = false;
  clearTimeout(commitTimer);
  commitTimer = null;
  teardownCapture();
  if (socket?.readyState === WebSocket.OPEN) socket.close();
  socket = null;
  pending = [];
  pendingBytes = 0;
}

// --- playback ---------------------------------------------------------------

async function play(url) {
  stopPlayback();
  player = new Audio(url);
  await player.play();
}

function stopPlayback() {
  if (player) {
    player.pause();
    player = null;
  }
}
