/**
 * Aalto background service worker - the hands.
 *
 * The offscreen document owns the microphone and the socket; this file owns the
 * browser. When the agent calls a tool, the call arrives here, gets routed to
 * either the chrome.* APIs or the content script on the active page, and the
 * result goes back as a sentence the agent can read out.
 *
 * It also holds the two guards that are the point of the whole thing: a form is
 * never submitted until it has been read back, and a value that matches nothing
 * is never guessed at. Both live here rather than in the prompt, because a
 * prompt can be talked out of a rule and a conditional cannot.
 */

import { AALTO_TOOLS, TOOL_TARGET } from "./shared/tools.js";

const OFFSCREEN_PATH = "offscreen.html";
const SHORTCUT_COMMAND = "start-listening";
const DEFAULT_WORKER = "https://aalto.workers.dev";
// Verified against the live API: the API-spec page also documents a
// POST /v1/voice-agent/token on api.assemblyai.com, which 404s. This is the
// one that exists. Auth is the bare key in an `authorization` header.
const MINT_URL = "https://agents.assemblyai.com/v1/token";

/** Mirrored into chrome.storage.local so a re-opened popup can pick up mid-session. */
const state = {
  phase: "idle", // idle | connecting | listening | speaking | working | needs_mic | error
  heard: "", // what the user said, as it arrives
  reply: "", // what the agent said back
  activity: [], // { id, tool, status, detail }
  error: "",
};

async function setState(patch) {
  Object.assign(state, patch);
  await chrome.storage.local.set({ aaltoState: state });
  // The popup may be closed; nobody listening is not an error.
  chrome.runtime.sendMessage({ type: "STATE", state }).catch(() => {});
}

// --- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === "offscreen") return false;

  switch (message.type) {
    case "TOGGLE_SESSION":
      toggleSession()
        .then((outcome) => sendResponse({ ok: true, ...outcome }))
        .catch((err) => {
          setState({ phase: "error", error: err.message });
          sendResponse({ ok: false, error: err.message });
        });
      return true;

    case "END_SESSION":
      endSession()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "RUN_TOOL":
      runTool(message.name, message.args)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "AGENT_EVENT":
      onAgentEvent(message.event).catch(() => {});
      return false;

    case "POPUP_OPENED": {
      const autoStart = summonedByShortcut;
      summonedByShortcut = false;
      sendResponse({ state, autoStart });
      return false;
    }

    case "GET_STATE":
      sendResponse({ state });
      return false;

    default:
      return false;
  }
});

// The shortcut IS the request to talk, so pressing it starts a session there and
// then; the popup is opened afterwards, best effort, purely so there is
// something to look at. Opening the popup by hand should not start listening - a
// window that switches the microphone on the moment you glance at it is
// unnerving - so the popup asks which happened, and this flag is consumed on
// read so it never leaks into the next manual open.
let summonedByShortcut = false;

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== SHORTCUT_COMMAND) return;

  // Deliberately NOT the reserved _execute_action: Chrome handles that one
  // natively and never dispatches onCommand, so the worker could not tell a
  // shortcut press from a toolbar click.
  summonedByShortcut = state.phase === "idle";
  toggleSession().catch((err) => {
    summonedByShortcut = false;
    setState({ phase: "error", error: err.message });
  });

  try {
    await chrome.action.openPopup();
  } catch {
    // No popup on this Chrome, or not allowed in this window state. The session
    // is already running and the agent still speaks, so this is not fatal.
  }
});

// --- session lifecycle ------------------------------------------------------

async function toggleSession() {
  if (state.phase !== "idle" && state.phase !== "error" && state.phase !== "needs_mic") {
    await endSession();
    return { ended: true };
  }
  return await startSession();
}

async function startSession() {
  await setState({ phase: "connecting", heard: "", reply: "", activity: [], error: "" });
  resetGuards();

  let token;
  try {
    token = await mintToken();
  } catch (err) {
    await setState({ phase: "error", error: err.message });
    throw err;
  }

  try {
    await sendToOffscreen({ type: "START_SESSION", config: { token, tools: AALTO_TOOLS } });
  } catch (err) {
    if (isPermissionProblem(err)) {
      // An offscreen document can use the microphone but cannot prompt for it,
      // so send the user to a real page that can.
      await setState({ phase: "needs_mic", error: "Aalto needs your microphone." });
      await openPermissionPage();
      return { needsMic: true };
    }
    await setState({ phase: "error", error: err.message });
    throw err;
  }
  return { started: true };
}

async function endSession() {
  await sendToOffscreen({ type: "END_SESSION" }).catch(() => {});
  await setState({ phase: "idle" });
}

/**
 * Get a single-use token to open the session with.
 *
 * Two ways in, and which one is in play is deliberately visible in the popup.
 * With the user's own AssemblyAI key the browser mints directly - their key,
 * their browser, nothing in the middle. Without one it falls back to the hosted
 * endpoint, which is there so a judge can try this without signing up for
 * anything, and which is metered accordingly.
 */
async function mintToken() {
  const { assemblyKey, workerUrl } = await chrome.storage.local.get(["assemblyKey", "workerUrl"]);

  if (assemblyKey) {
    const url = `${MINT_URL}?expires_in_seconds=300`;
    const res = await fetch(url, { headers: { authorization: assemblyKey } });
    if (!res.ok) throw new Error(await describeMintFailure(res));
    return (await res.json()).token;
  }

  const base = (workerUrl || DEFAULT_WORKER).replace(/\/$/, "");
  const res = await fetch(`${base}/api/ext/token`);
  if (!res.ok) throw new Error(await describeMintFailure(res));
  return (await res.json()).token;
}

async function describeMintFailure(res) {
  if (res.status === 401) return "that AssemblyAI key was rejected";
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    return body.reason === "daily_limit"
      ? "the shared demo budget is spent for today - add your own key in settings"
      : "too many sessions at once - try again in a moment";
  }
  return `couldn't get a session token (${res.status})`;
}

/** React to the agent's side of the conversation. The UI is the only consumer. */
async function onAgentEvent(event) {
  switch (event?.type) {
    case "session.ready":
      return await setState({ phase: "listening" });

    case "input.speech.started":
      return await setState({ phase: "listening", reply: "" });

    case "transcript.user.delta":
    case "transcript.user":
      return await setState({ heard: event.text ?? state.heard });

    case "reply.started":
      return await setState({ phase: "speaking" });

    case "transcript.agent.delta":
    case "transcript.agent":
      return await setState({ reply: event.text ?? state.reply });

    case "reply.done":
      if (state.phase === "speaking") await setState({ phase: "listening" });
      return;

    case "session.dropped":
      return await setState({ phase: "error", error: "the connection dropped" });

    default:
      return;
  }
}

// --- offscreen document lifecycle -------------------------------------------

let creating = null;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  if (existing.length > 0) return;

  // Concurrent calls would otherwise race and throw "Only a single offscreen
  // document may be created".
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Hold a live voice conversation: capture the microphone and speak replies.",
  });
  try {
    await creating;
  } finally {
    creating = null;
  }
}

async function sendToOffscreen(message) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ ...message, target: "offscreen" });
  if (!res?.ok) {
    const err = new Error(res?.error ?? "the audio worker did not respond");
    err.name = res?.name ?? "Error";
    throw err;
  }
  return res;
}

/** True for the one failure the user can actually fix, via the permission page. */
function isPermissionProblem(err) {
  return (
    err?.name === "NotAllowedError" ||
    err?.name === "SecurityError" ||
    /permission|denied|not ?allowed/i.test(err?.message ?? "")
  );
}

async function openPermissionPage() {
  const url = chrome.runtime.getURL("permission.html");
  const [existing] = await chrome.tabs.query({ url });
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true });
    return;
  }
  await chrome.tabs.create({ url });
}

// --- tool dispatch ----------------------------------------------------------

/**
 * Guard state.
 *
 * `filledAt` moves every time a field changes; `reviewedAt` moves every time
 * the form is read back. Submitting is allowed only when the second is at least
 * as recent as the first - i.e. the user has heard the current contents, not an
 * earlier version of them. Keyed by tab so two forms open at once cannot vouch
 * for each other.
 *
 * Ordered by a counter, not by Date.now(): several fills and a read-back all
 * land inside the same millisecond, which made the comparison refuse a form
 * that had in fact just been read back.
 */
let guardClock = 0;
const guards = new Map(); // tabId -> { filledAt, reviewedAt }

function resetGuards() {
  guards.clear();
  recorded.length = 0;
}

function guardFor(tabId) {
  if (!guards.has(tabId)) guards.set(tabId, { filledAt: 0, reviewedAt: 0 });
  return guards.get(tabId);
}

/** Tool calls made this session, so one can be saved as a macro afterwards. */
const recorded = [];

let toolSeq = 0;

async function runTool(name, args) {
  const id = `t${++toolSeq}`;
  const target = TOOL_TARGET[name];
  if (!target) throw new Error(`there is no tool called ${name}`);

  await note({ id, tool: name, status: "running", detail: describeCall(args) });
  if (state.phase === "listening") await setState({ phase: "working" });

  try {
    const detail =
      target === "browser" ? await runBrowserTool(name, args) : await runPageTool(name, args);
    if (target !== "spoken") recorded.push({ name, args });
    await note({ id, tool: name, status: "ok", detail });
    return detail;
  } catch (err) {
    await note({ id, tool: name, status: "failed", detail: err.message });
    throw err;
  }
}

async function note(entry) {
  const activity = state.activity.some((a) => a.id === entry.id)
    ? state.activity.map((a) => (a.id === entry.id ? { ...a, ...entry } : a))
    : [...state.activity, entry];
  await setState({ activity: activity.slice(-12) });
}

function describeCall(args) {
  const first = Object.values(args ?? {})[0];
  return typeof first === "string" ? first.slice(0, 80) : "";
}

// --- tools that run against the browser -------------------------------------

async function runBrowserTool(name, args) {
  switch (name) {
    // active:false throughout. The user called Aalto from somewhere else and
    // should still be there when it finishes; a tab that steals focus
    // mid-sentence is the exact thing this design is trying to avoid.
    // switch_tab is the one deliberate exception, because switching is what it
    // was asked to do.
    case "open_url": {
      const url = normalizeUrl(args.url);
      await chrome.tabs.create({ url, active: false });
      return `opened ${hostOf(url)} in a tab behind this one`;
    }

    case "search_web": {
      await chrome.tabs.create({
        url: `https://www.google.com/search?q=${encodeURIComponent(args.query)}`,
        active: false,
      });
      return `searched for "${args.query}" in a tab behind this one`;
    }

    case "switch_tab":
      return await switchTab(args.description);

    case "close_tabs":
      return await closeTabs(args.description);

    case "list_tabs": {
      const tabs = await openTabSummary();
      if (tabs.length === 0) return "nothing is open";
      return `open tabs: ${tabs.map((t) => t.title).join("; ")}`;
    }

    case "save_macro":
      return await saveMacro(args.name);

    case "run_macro":
      return await runMacro(args.name);

    case "list_macros": {
      const { macros = {} } = await chrome.storage.local.get("macros");
      const names = Object.keys(macros);
      return names.length === 0 ? "nothing saved yet" : `saved: ${names.join(", ")}`;
    }

    default:
      throw new Error(`don't know how to ${name}`);
  }
}

// --- tools that run against the page ----------------------------------------

async function runPageTool(name, args) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("there's no page open to work on");
  const guard = guardFor(tab.id);

  // The guard that matters. Checked before the call goes anywhere near the
  // page, and stated as the reason rather than a refusal, so the agent can
  // explain itself and do the right thing next.
  if (name === "submit_form" && (guard.reviewedAt === 0 || guard.reviewedAt < guard.filledAt)) {
    throw new Error(
      "I haven't read this form back to them yet, so I can't submit it. " +
        "Call review_form first, then ask them to confirm."
    );
  }

  const res = await messageContentScript(tab, { type: "TOOL", name, args });
  if (!res?.ok) throw new Error(res?.error ?? "that didn't work on this page");

  if (name === "fill_field" || name === "insert_text") guard.filledAt = ++guardClock;
  if (name === "review_form") guard.reviewedAt = ++guardClock;
  if (name === "submit_form") guards.delete(tab.id);

  return res.detail;
}

/**
 * Talk to the content script, injecting it first if it is not there.
 *
 * Manifest content scripts are injected when a page loads, and reloading the
 * extension does NOT re-inject them into tabs that are already open. So every
 * extension reload silently breaks every tab the user already had - the page
 * looks identical and reports itself unreachable. Injecting on demand also
 * covers a page opened before Aalto was installed.
 */
async function messageContentScript(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Not there yet - try to put it there.
  }

  if (!/^https?:/.test(tab.url ?? "")) {
    throw new Error("I can't work on this kind of page - try a normal web page");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-agent.js"],
    });
  } catch (err) {
    throw new Error(`couldn't reach that page (${err.message})`);
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    throw new Error("that page didn't respond - try reloading it");
  }
}

// --- tabs -------------------------------------------------------------------

async function openTabSummary() {
  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((t) => t.title && t.url && !t.url.startsWith("chrome://"))
    .slice(0, 20)
    .map((t) => ({ id: t.id, title: t.title, url: t.url }));
}

function matchTabs(tabs, description) {
  const desc = (description ?? "").toLowerCase().trim();
  return tabs.filter(
    (t) => t.title?.toLowerCase().includes(desc) || t.url?.toLowerCase().includes(desc)
  );
}

async function switchTab(description) {
  const desc = (description ?? "").toLowerCase();
  const tabs = await chrome.tabs.query({ currentWindow: true });

  if (desc.includes("next")) return cycleTab(tabs, 1);
  if (desc.includes("previous") || desc.includes("back") || desc.includes("last")) {
    return cycleTab(tabs, -1);
  }

  const [match] = matchTabs(tabs, description);
  if (!match?.id) throw new Error(`nothing open matches "${description}"`);
  await chrome.tabs.update(match.id, { active: true });
  return `switched to ${match.title}`;
}

async function cycleTab(tabs, direction) {
  const active = tabs.find((t) => t.active);
  if (!active) throw new Error("there's no active tab");
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const currentIdx = sorted.findIndex((t) => t.id === active.id);
  const next = sorted[(currentIdx + direction + sorted.length) % sorted.length];
  await chrome.tabs.update(next.id, { active: true });
  return `switched to ${next.title}`;
}

/**
 * Closing is not undoable from here, so a match that is too broad is reported
 * back rather than acted on. The agent's instructions tell it to check with the
 * user at that point, and it has the count it needs to ask a useful question.
 */
async function closeTabs(description) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const matches = matchTabs(tabs, description).filter((t) => !t.active);
  if (matches.length === 0) throw new Error(`nothing open matches "${description}"`);
  if (matches.length > 4) {
    return `that matches ${matches.length} tabs: ${matches
      .slice(0, 5)
      .map((t) => t.title)
      .join("; ")}. Ask them to confirm before closing that many.`;
  }
  await chrome.tabs.remove(matches.map((t) => t.id));
  return `closed ${matches.length} tab${matches.length === 1 ? "" : "s"}`;
}

// --- macros -----------------------------------------------------------------

/**
 * Save what just happened under a name.
 *
 * Only the browser-side calls are kept. Replaying an `answer` would speak a
 * stale sentence, and replaying a form fill would put last week's values into
 * today's form - so a macro is the navigation, and the conversation happens
 * fresh each time.
 */
async function saveMacro(name) {
  const key = (name ?? "").toLowerCase().trim();
  if (!key) throw new Error("that macro needs a name");

  const steps = recorded.filter(
    (s) => TOOL_TARGET[s.name] === "browser" && !s.name.endsWith("_macro")
  );
  if (steps.length === 0) throw new Error("nothing has happened yet that's worth saving");

  const { macros = {} } = await chrome.storage.local.get("macros");
  macros[key] = steps;
  await chrome.storage.local.set({ macros });
  return `saved "${key}" - ${steps.length} step${steps.length === 1 ? "" : "s"}`;
}

async function runMacro(name) {
  const key = (name ?? "").toLowerCase().trim();
  const { macros = {} } = await chrome.storage.local.get("macros");
  const steps = macros[key];
  if (!steps) {
    const names = Object.keys(macros);
    throw new Error(
      names.length === 0
        ? "nothing has been saved yet"
        : `there's no macro called "${key}". There is: ${names.join(", ")}`
    );
  }

  const outcomes = [];
  for (const step of steps) {
    try {
      outcomes.push(await runBrowserTool(step.name, step.args));
    } catch (err) {
      // One broken step should not abandon the rest of a saved routine.
      outcomes.push(`couldn't ${step.name}: ${err.message}`);
    }
  }
  return `ran "${key}": ${outcomes.join("; ")}`;
}

// --- odds and ends ----------------------------------------------------------

function normalizeUrl(url) {
  return /^https?:\/\//.test(url) ? url : `https://${url}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
