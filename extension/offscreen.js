/**
 * Owns the microphone, the speaker, and the session socket.
 *
 * Not the popup, which is destroyed the instant Aalto opens or switches a tab.
 * Not the service worker, which has no Web Audio and is torn down while idle -
 * which a live voice session never is.
 *
 * It does not decide when the user has stopped talking: AssemblyAI does turn
 * detection on a continuously open session, so the microphone simply stays open.
 */

import { AgentSession } from "./shared/agent-session.js";
import { Speaker } from "./shared/speaker.js";

const LEVEL_INTERVAL_MS = 80; // waveform updates; the UI needs far fewer than the frames

let media = null;
let audioCtx = null;
let worklet = null;
let source = null;
let session = null;
let speaker = null;
let lastLevelAt = 0;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") return false;

  switch (message.type) {
    case "START_SESSION":
      start(message.config)
        .then(() => sendResponse({ ok: true }))
        // The name matters: the worker uses NotAllowedError to decide whether
        // to open the permission page, and err.message alone is vague.
        .catch((err) => sendResponse({ ok: false, error: err.message, name: err.name }));
      return true;

    case "END_SESSION":
      stop()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "COPY":
      sendResponse(copy(message.text));
      return false;

    default:
      return false;
  }
});

async function start(config) {
  if (session) throw new Error("a session is already running.");

  // Held open across sessions: re-negotiating the device costs a noticeable
  // delay before the first syllable lands.
  if (!media) {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Without this the agent hears itself and interrupts its own sentence.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  // The device's own rate; the worklet converts. See shared/pcm-worklet.js.
  if (!audioCtx) {
    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule("shared/pcm-worklet.js");
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();

  speaker = new Speaker(audioCtx);

  session = new AgentSession({
    token: config.token,
    tools: config.tools,
    greeting: config.greeting,
    context: config.context,
    runTool,
    onEvent: (event) => {
      relay(event);
      // A dropped socket - including a session reaching its time limit - has
      // to release the microphone and clear the slot, or the next start is
      // refused because a session is "already running".
      if (event.type === "session.dropped") stop();
    },
    onAudio: (pcm) => speaker.push(pcm),
    onInterrupt: () => speaker.stop(),
  });

  try {
    await session.connect();
  } catch (err) {
    await stop();
    throw err;
  }

  source = audioCtx.createMediaStreamSource(media);
  worklet = new AudioWorkletNode(audioCtx, "pcm-capture");
  worklet.port.onmessage = (event) => onFrame(event.data);
  source.connect(worklet);
  // Deliberately not connected to the destination: routing the microphone to
  // the speakers would echo the user back at themselves.
}

/** @param {Int16Array} frame mono 24 kHz, already resampled by the worklet */
function onFrame(frame) {
  session?.sendAudio(frame);

  const now = Date.now();
  if (now - lastLevelAt < LEVEL_INTERVAL_MS) return;
  lastLevelAt = now;

  let sum = 0;
  for (let i = 0; i < frame.length; i++) {
    const s = frame[i] / 0x8000;
    sum += s * s;
  }
  // Nobody may be watching the waveform; that is not an error.
  chrome.runtime
    .sendMessage({ type: "LEVEL", value: Math.sqrt(sum / frame.length) })
    .catch(() => {});
}

/** The socket lives here because the microphone does; the acting happens in
 *  the service worker, which has the chrome.* APIs. */
async function runTool(name, args) {
  const response = await chrome.runtime.sendMessage({ type: "RUN_TOOL", name, args });
  if (!response) throw new Error("the extension isn't responding. Try again.");
  if (!response.ok) throw new Error(response.error ?? "that didn't work.");
  return response.result;
}

function relay(event) {
  chrome.runtime.sendMessage({ type: "AGENT_EVENT", event }).catch(() => {});
}

async function stop() {
  if (worklet) {
    worklet.port.onmessage = null;
    worklet.disconnect();
    worklet = null;
  }
  if (source) {
    source.disconnect();
    source = null;
  }
  speaker?.stop();
  speaker = null;

  // Worth awaiting: see AgentSession.end().
  await session?.end().catch(() => {});
  session = null;
}

/**
 * The page cannot do this: the clipboard API needs its document to have focus,
 * and with the side panel open it rarely does. An offscreen document with the
 * CLIPBOARD reason is Chrome's sanctioned route for a write nobody clicked.
 */
function copy(text) {
  const area = document.createElement("textarea");
  area.value = text ?? "";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok ? { ok: true } : { ok: false, error: "the clipboard refused that copy." };
}
