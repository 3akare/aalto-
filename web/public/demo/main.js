/**
 * Boots the sandbox, checks today's budget, and on a click opens a session and
 * connects the microphone to it. The session is shared/agent-session.js - the
 * same file the extension runs.
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
const chipsEl = document.getElementById("chips");

/**
 * Nobody knows what to say to a microphone, and a first turn that lands on
 * silence loses the demo in ten seconds. Sequenced to end on the part worth
 * remembering: beat three asks it to submit and it refuses, reading the form
 * back instead. Beat four is the confirmation it was holding out for.
 */
const SUGGESTIONS = [
  "Where does this page mention a penalty?",
  "Go to the form. My name is Dana Whitfield, I'm in retail trade, sole trader.",
  "Submit it.",
  "Fine - read it back first, then submit.",
];

/** Survives a reload, so a tab can hand back the lease it left behind. */
const LEASE_KEY = "aalto.lease";

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
    const { remainingSeconds } = await res.json();
    if (remainingSeconds <= 0) {
      micBtn.disabled = true;
      setStatus(
        "Today's shared demo budget is spent. It resets at midnight UTC - or install the extension and use your own AssemblyAI key.",
        true
      );
    }
  } catch {
    // Not a reason to hide the button; the token request gives a better error.
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

  // A reload, or a close the beacon did not survive, would otherwise lock the
  // visitor out by their own previous attempt.
  reclaimStaleLease();

  let token;
  try {
    const res = await fetch("/api/demo/token", { method: "POST" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return void refuse(res.status, body.reason);
    token = body.token;
    lease = body.leaseId;
    sessionStorage.setItem(LEASE_KEY, lease);
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
    // Both throw messages written to be read; show what they said.
    console.error("[Aalto] session failed to start:", err);
    await end(err.message);
  }
}

/**
 * Every refusal used to fall through to "too many attempts", including a plain
 * server error - so a missing key and a rate limit looked identical and the
 * message was wrong in both cases. Anything unrecognised reports its status.
 */
function refuse(status, reason) {
  micBtn.disabled = false;

  if (reason === "daily_limit") {
    micBtn.disabled = true;
    return setStatus(
      "Today's shared demo budget is spent. It resets at midnight UTC - or install the extension and use your own AssemblyAI key.",
      true
    );
  }
  if (reason === "active_session") {
    return setStatus(
      "Two sessions are already open from this network. Try again in a minute.",
      true
    );
  }
  if (reason === "burst") {
    return setStatus("That was a lot of attempts at once. Give it a minute.", true);
  }
  if (reason === "upstream") {
    return setStatus("AssemblyAI wouldn't issue a session just now. Try again shortly.", true);
  }
  setStatus(`The server couldn't start a session (error ${status}).`, true);
}

/** Wrap the executor so every call shows up in the inspector. */
async function instrumented(name, args) {
  const finish = inspector.beginCall(name, args);
  try {
    const result = await runTool(name, args);
    finish("ok", result);
    return result;
  } catch (err) {
    // A refusal is not a failure, and colouring it like one misrepresents the
    // most interesting thing the agent does.
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

/** sendBeacon, not fetch: on pagehide the page is already going and a fetch
 *  will not be given the chance to finish. */
function releaseLease() {
  if (!lease) return;
  // Just the id. The server times the session itself.
  navigator.sendBeacon("/api/demo/release", JSON.stringify({ leaseId: lease }));
  sessionStorage.removeItem(LEASE_KEY);
  lease = null;
}

/** A lease from a previous load of this tab, charged for but never handed back. */
function reclaimStaleLease() {
  const stale = sessionStorage.getItem(LEASE_KEY);
  if (!stale) return;
  sessionStorage.removeItem(LEASE_KEY);
  navigator.sendBeacon("/api/demo/release", JSON.stringify({ leaseId: stale }));
}

function startCountdown(maxSeconds) {
  clearInterval(countdown);
  countdown = setInterval(() => {
    const left = maxSeconds - Math.round((Date.now() - startedAt) / 1000);
    if (left <= 0) return void end("Demo sessions are capped. Start another whenever you like.");
    if (left <= 20) setStatus(`${left}s left in this session.`);
  }, 1000);
}

// Otherwise the session bills through its grace window and the lease is held
// until it expires.
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

    // Copies rather than sends: this is a voice demo, so a button that typed it
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
