/**
 * The demo, assembled.
 *
 * Boots the sandbox, checks what is left of today's budget, and - when someone
 * clicks - opens a session and connects the microphone to it. The session
 * itself is shared/agent-session.js, the same file the extension runs.
 */

import { AgentSession } from "../vendor/shared/agent-session.js";
import { Speaker } from "../vendor/shared/speaker.js";
import { AALTO_TOOLS } from "../vendor/shared/tools.js";
import * as inspector from "./inspector.js";
import { Mic } from "./mic.js";
import * as sandbox from "./sandbox/sandbox.js";
import { resetGuard, runTool } from "./tool-executor.js";

const micBtn = document.getElementById("mic");
const micLabel = document.getElementById("micLabel");
const statusEl = document.getElementById("status");
const meterFill = document.getElementById("meterFill");
const chipsEl = document.getElementById("chips");

/**
 * The tour, in order.
 *
 * Nobody knows what to say to a microphone, and a first turn that lands on
 * silence loses the demo in ten seconds. These four are sequenced to end on the
 * only part worth remembering: beat three asks it to submit, and it refuses and
 * reads the form back instead, because the guard is a conditional rather than a
 * line in the prompt. Beat four is the confirmation it was holding out for.
 */
const SUGGESTIONS = [
  "How long does registration take, according to this page?",
  "Go to the form. My name is Dana Whitfield, I'm in retail trade, sole trader.",
  "Submit it.",
  "Fine - read it back first, then submit.",
];

let session = null;
let speaker = null;
let mic = null;
let lease = null;
let startedAt = 0;
let countdown = null;

sandbox.renderTabs();
renderChips();
refreshBudget();

// --- budget -----------------------------------------------------------------

async function refreshBudget() {
  try {
    const res = await fetch("/api/demo/status");
    const { remainingSeconds, dailyCapSeconds } = await res.json();
    meterFill.style.width = `${Math.round((remainingSeconds / dailyCapSeconds) * 100)}%`;
    if (remainingSeconds <= 0) {
      micBtn.disabled = true;
      setStatus(
        "Today's shared demo budget is spent. It resets at midnight UTC - or install the extension and use your own AssemblyAI key.",
        true
      );
    }
  } catch {
    // A status call failing is not a reason to hide the button; the token
    // request will give a better error if there really is a problem.
  }
}

function setStatus(text, warn = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("warn", warn);
}

// --- session ----------------------------------------------------------------

micBtn.addEventListener("click", () => (session ? end("You ended the session.") : start()));

async function start() {
  micBtn.disabled = true;
  setStatus("Connecting…");
  inspector.clear();
  resetGuard();

  let token;
  try {
    const res = await fetch("/api/demo/token", { method: "POST" });
    const body = await res.json();
    if (!res.ok) return void refuse(body.reason);
    token = body.token;
    lease = body.leaseId;
    startedAt = Date.now();
    startCountdown(body.maxSessionSeconds);
  } catch {
    micBtn.disabled = false;
    return setStatus("Couldn't reach the server. Try again in a moment.", true);
  }

  try {
    mic = new Mic((frame) => session?.sendAudio(frame));
    // Must happen inside the click for the AudioContext to start unsuspended.
    const ctx = await mic.start();
    speaker = new Speaker(ctx);

    session = new AgentSession({
      token,
      tools: AALTO_TOOLS,
      runTool: instrumented,
      onEvent,
      onAudio: (pcm) => speaker.push(pcm),
      onInterrupt: () => {
        speaker.stop();
        inspector.interrupted();
      },
    });
    await session.connect();

    micBtn.dataset.live = "true";
    micLabel.textContent = "Stop";
    micBtn.disabled = false;
    setStatus("Listening. Interrupt it whenever you like.");
  } catch (err) {
    await end(
      err.name === "NotAllowedError"
        ? "Microphone blocked. Allow it in the address bar and try again."
        : err.message
    );
  }
}

function refuse(reason) {
  micBtn.disabled = false;
  if (reason === "active_session") {
    setStatus("There's already a session open from this connection. Close the other tab.", true);
  } else if (reason === "daily_limit") {
    micBtn.disabled = true;
    setStatus(
      "Today's shared demo budget is spent. It resets at midnight UTC - or install the extension and use your own AssemblyAI key.",
      true
    );
  } else {
    setStatus("Too many attempts at once. Give it a minute.", true);
  }
}

/** Wrap the executor so every call shows up in the inspector as it happens. */
async function instrumented(name, args) {
  const finish = inspector.beginCall(name, args);
  try {
    const result = await runTool(name, args);
    finish("ok", result);
    return result;
  } catch (err) {
    // A refusal is not a failure, and colouring it like one would misrepresent
    // the most interesting thing the agent does.
    finish(
      /can't submit|doesn't match|isn't one of/.test(err.message) ? "refused" : "failed",
      err.message
    );
    throw err;
  }
}

function onEvent(event) {
  switch (event.type) {
    case "transcript.user.delta":
    case "transcript.user":
      return inspector.heard(event.text);
    case "transcript.agent.delta":
    case "transcript.agent":
      return inspector.spoke(event.text);
    case "session.dropped":
      return void end("The connection dropped.");
    default:
      return;
  }
}

async function end(message) {
  clearInterval(countdown);
  mic?.stop();
  speaker?.stop();
  await session?.end().catch(() => {});
  session = null;
  speaker = null;
  mic = null;

  micBtn.dataset.live = "false";
  micLabel.textContent = "Start talking";
  micBtn.disabled = false;
  setStatus(message ?? "");

  await releaseLease();
  refreshBudget();
}

/**
 * Hand back what was not used.
 *
 * sendBeacon rather than fetch, because on pagehide the page is already going
 * and a fetch will not be given the chance to finish. Without this every
 * abandoned tab charges the budget a full session.
 */
function releaseLease() {
  if (!lease) return;
  const body = JSON.stringify({
    leaseId: lease,
    durationSeconds: Math.round((Date.now() - startedAt) / 1000),
  });
  navigator.sendBeacon("/api/demo/release", body);
  lease = null;
}

function startCountdown(maxSeconds) {
  clearInterval(countdown);
  countdown = setInterval(() => {
    const left = maxSeconds - Math.round((Date.now() - startedAt) / 1000);
    if (left <= 0) return void end("Demo sessions are capped. Start another whenever you like.");
    if (left <= 20) setStatus(`${left}s left in this session.`);
  }, 1000);
}

// Closing the tab without saying goodbye leaves the session billing through its
// grace window, and leaves the lease held until it expires.
window.addEventListener("pagehide", () => {
  session?.end().catch(() => {});
  releaseLease();
});

// --- suggestions ------------------------------------------------------------

function renderChips() {
  for (const text of SUGGESTIONS) {
    const item = document.createElement("li");

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.append(document.createTextNode(text));

    const flash = document.createElement("span");
    flash.className = "copied";
    chip.append(flash);

    // Clicking copies rather than sends. This is a voice demo: the thing being
    // demonstrated is that saying it out loud works, so a button that typed it
    // for you would be demonstrating the wrong thing.
    chip.addEventListener("click", async () => {
      await navigator.clipboard?.writeText(text).catch(() => {});
      flash.textContent = "copied";
      setTimeout(() => (flash.textContent = ""), 1400);
    });

    item.append(chip);
    chipsEl.append(item);
  }
}
