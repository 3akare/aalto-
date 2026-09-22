/**
 * Offscreen worker: owns the microphone, the speaker, and the session socket.
 *
 * It lives outside the popup because the popup is destroyed as soon as it loses
 * focus - the instant Aalto opens or switches a tab. It is not the background
 * worker because a service worker has no DOM, so no getUserMedia and no Web
 * Audio, and because Chrome tears an idle service worker down after thirty
 * seconds, which would kill the socket in the middle of a conversation.
 *
 * What it does NOT do any more is decide when the user has stopped talking.
 * The previous version carried a voice-activity detector - an RMS threshold, a
 * silence hold, a lead-in grace period, a maximum utterance length and a commit
 * handshake - to cut each command into a one-shot request. AssemblyAI's Voice
 * Agent API does turn detection itself, on a continuously open session, so all
 * of that is gone. The microphone simply stays open and the agent works out
 * whose turn it is.
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

    case "SEND_TEXT":
      session?.sendText(message.text);
      sendResponse({ ok: true });
      return false;

    default:
      return false;
  }
});

async function start(config) {
  if (session) throw new Error("a session is already running");

  // Held open across sessions so starting again does not re-prompt or
  // re-negotiate the device, which adds a noticeable delay before the first
  // syllable lands.
  if (!media) {
    media = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // Without this the agent hears its own voice coming out of the speakers
        // and interrupts itself. It is what makes the demo work without headphones.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  // Deliberately the device's own rate rather than a forced 24 kHz: see the
  // note in shared/pcm-worklet.js, which does the conversion instead.
  if (!audioCtx) {
    audioCtx = new AudioContext();
    await audioCtx.audioWorklet.addModule("shared/pcm-worklet.js");
  }
  if (audioCtx.state === "suspended") await audioCtx.resume();

  speaker = new Speaker(audioCtx);

  session = new AgentSession({
    token: config.token,
    tools: config.tools,
    runTool,
    onEvent: relay,
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

/**
 * Hand a tool call to the service worker, which owns the browser.
 *
 * Everything the agent can actually do - tabs, the DOM of the active page,
 * saved macros - needs chrome.* APIs this document does not have. The socket
 * lives here because the microphone does; the acting lives there.
 */
async function runTool(name, args) {
  const response = await chrome.runtime.sendMessage({ type: "RUN_TOOL", name, args });
  if (!response) throw new Error("the extension did not respond");
  if (!response.ok) throw new Error(response.error ?? "that didn't work");
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

  // Closing the socket without saying goodbye leaves the session billing
  // through its grace window, so this is worth awaiting.
  await session?.end().catch(() => {});
  session = null;
}
