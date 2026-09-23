/**
 * The hands. The offscreen document owns the microphone and the socket; this
 * owns the browser. Tool calls arrive here, route to the chrome.* APIs or the
 * content script, and come back as a sentence the agent can read out.
 *
 * It also holds the two guards that are the point of the whole thing - no
 * submitting what has not been read back, no guessing a value nobody said -
 * because a prompt can be talked out of a rule and a conditional cannot.
 */

import { similarity } from "./shared/matching.js";
import { AALTO_TOOLS, TOOL_TARGET } from "./shared/tools.js";

const OFFSCREEN_PATH = "offscreen.html";
const SHORTCUT_COMMAND = "start-listening";
const DEFAULT_WORKER = "https://aalto.bakaredavid007.workers.dev";
// The API-spec page also documents POST /v1/voice-agent/token on
// api.assemblyai.com; that 404s. This one exists, and auth is the bare key.
const MINT_URL = "https://agents.assemblyai.com/v1/token";

/** A quiet session is still a billed one. After this long without speech it is
 *  paused, and the next one carries on where it left off. */
const IDLE_PAUSE_MS = 90_000;
/** How long a conversation is worth continuing before a session starts fresh. */
const CONVERSATION_TTL_MS = 30 * 60_000;
const MAX_TURNS = 60;
const FRESH_GREETING = "I'm listening.";

const LIVE_PHASES = new Set(["connecting", "listening", "speaking", "working"]);

const state = {
  phase: "idle", // idle | connecting | listening | speaking | working | needs_mic | error
  error: "",
  turns: [], // { id, role: user | agent | tool | note, text, tool?, status?, live?, at }
  lastActiveAt: 0,
  openedTabs: [], // ids of tabs Aalto opened, most recent last
};

/**
 * The service worker is torn down between sessions, so the conversation lives
 * in storage and is restored on wake. Without this, every restart would look
 * to the user like the agent forgetting everything.
 */
const hydrated = chrome.storage.local.get("aaltoState").then(async ({ aaltoState }) => {
  if (!aaltoState) return;
  state.turns = Array.isArray(aaltoState.turns) ? aaltoState.turns : [];
  state.lastActiveAt = aaltoState.lastActiveAt ?? 0;
  state.openedTabs = Array.isArray(aaltoState.openedTabs) ? aaltoState.openedTabs : [];
  for (const t of state.turns) {
    t.live = false;
    if (t.status === "running") t.status = "failed";
  }
  // A session cannot outlive the document that holds its socket.
  if (LIVE_PHASES.has(aaltoState.phase) && (await hasOffscreen())) state.phase = aaltoState.phase;
});

let persistTimer = null;

function setState(patch) {
  Object.assign(state, patch);
  // Nobody listening is not an error: the side panel may be closed.
  chrome.runtime.sendMessage({ type: "STATE", state }).catch(() => {});
  // Deltas arrive several times a second; storage does not need every one.
  if (!persistTimer) persistTimer = setTimeout(flush, 400);
}

function flush() {
  clearTimeout(persistTimer);
  persistTimer = null;
  chrome.storage.local.set({ aaltoState: state });
}

const isLive = () => LIVE_PHASES.has(state.phase);

// --- side panel -------------------------------------------------------------

// The side panel, not a popup: a popup closes the moment it loses focus, and
// takes focus when it opens - so clicking into the page closed it, and opening
// it pulled focus off the input the user wanted typed into.
chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

/** Windows with the panel open, so the shortcut does not re-open one and steal
 *  focus from the page. */
const panelWindows = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "sidepanel") return;
  let windowId = null;
  port.onMessage.addListener((message) => {
    if (message.type === "hello") {
      windowId = message.windowId;
      panelWindows.add(windowId);
    }
  });
  port.onDisconnect.addListener(() => panelWindows.delete(windowId));
});

// --- messages ---------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target === "offscreen") return false;

  const reply = (promise) => {
    promise
      .then((value) => sendResponse({ ok: true, ...value }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  };

  switch (message.type) {
    case "TOGGLE_SESSION":
      return reply(toggleSession());

    case "NEW_CONVERSATION":
      return reply(newConversation());

    case "DISMISS_ERROR":
      if (state.phase === "error" || state.phase === "needs_mic")
        setState({ phase: "idle", error: "" });
      return false;

    case "RUN_TOOL":
      runTool(message.name, message.args)
        .then((result) => sendResponse({ ok: true, result }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;

    case "AGENT_EVENT":
      onAgentEvent(message.event).catch(() => {});
      return false;

    case "GET_STATE":
      return reply(hydrated.then(() => ({ state })));

    default:
      return false;
  }
});

chrome.commands?.onCommand.addListener((command, tab) => {
  if (command !== SHORTCUT_COMMAND) return;

  // Before any await: sidePanel.open is only allowed inside the user gesture,
  // and an await in front of it loses the gesture.
  const windowId = tab?.windowId;
  if (windowId != null && !panelWindows.has(windowId)) {
    chrome.sidePanel.open({ windowId }).catch(() => {});
  }

  toggleSession().catch((err) => setState({ phase: "error", error: err.message }));
});

// --- session lifecycle ------------------------------------------------------

async function toggleSession() {
  await hydrated;
  if (isLive()) {
    await endSession("Paused");
    return { ended: true };
  }
  return await startSession();
}

async function startSession() {
  const continuing =
    state.turns.some((t) => t.role === "user" || t.role === "agent") &&
    Date.now() - state.lastActiveAt < CONVERSATION_TTL_MS;

  setState({ phase: "connecting", error: "" });

  let token;
  try {
    ({ token } = await mintToken());
  } catch (err) {
    setState({ phase: "error", error: err.message });
    throw err;
  }

  try {
    await sendToOffscreen({
      type: "START_SESSION",
      config: {
        token,
        tools: AALTO_TOOLS,
        // Carrying on is silent. Being re-introduced every time the microphone
        // comes back on is what made each session feel like starting over.
        greeting: continuing ? null : FRESH_GREETING,
        context: continuing ? conversationDigest() : "",
      },
    });
  } catch (err) {
    await releaseLease();
    if (isPermissionProblem(err)) {
      // An offscreen document may use the microphone but not prompt for it.
      setState({ phase: "needs_mic", error: "Aalto needs your microphone." });
      await openPermissionPage();
      return { needsMic: true };
    }
    setState({ phase: "error", error: err.message });
    throw err;
  }
  bumpIdle();
  return { started: true };
}

async function endSession(note) {
  clearTimeout(idleTimer);
  await sendToOffscreen({ type: "END_SESSION" }).catch(() => {});
  await releaseLease();
  settleLiveTurns();
  if (note) pushTurn({ role: "note", text: note });
  setState({ phase: "idle" });
  flush();
}

async function newConversation() {
  await hydrated;
  if (isLive()) await endSession();
  resetGuards();
  setState({ turns: [], lastActiveAt: 0, error: "", phase: "idle" });
  flush();
  return {};
}

let idleTimer = null;

function bumpIdle() {
  clearTimeout(idleTimer);
  state.lastActiveAt = Date.now();
  idleTimer = setTimeout(() => {
    // Only pause when it is genuinely waiting on the user, never mid-reply.
    if (state.phase === "listening") endSession("Paused while quiet · Alt+A to carry on");
    else if (isLive()) bumpIdle();
  }, IDLE_PAUSE_MS);
}

// --- the conversation -------------------------------------------------------

let turnSeq = 0;

function pushTurn(turn) {
  const id = `${Date.now().toString(36)}-${++turnSeq}`;
  setState({ turns: [...state.turns, { id, at: Date.now(), ...turn }].slice(-MAX_TURNS) });
  return id;
}

function updateTurn(id, patch) {
  setState({ turns: state.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
}

const liveTurn = (role) => state.turns.findLast((t) => t.role === role && t.live);

/** Words arrive one at a time; build them into one turn rather than one row each. */
function appendLive(role, words) {
  if (!words) return;
  const live = liveTurn(role);
  if (live) updateTurn(live.id, { text: `${live.text} ${words}`.replace(/\s+/g, " ").trim() });
  else pushTurn({ role, text: words.trim(), live: true });
}

function settleTurn(role, text, extra = {}) {
  const live = liveTurn(role);
  const final = (text ?? live?.text ?? "").trim();
  if (live) updateTurn(live.id, { text: final || live.text, live: false, ...extra });
  else if (final) pushTurn({ role, text: final, ...extra });
}

function settleLiveTurns() {
  if (state.turns.some((t) => t.live)) {
    setState({ turns: state.turns.map((t) => (t.live ? { ...t, live: false } : t)) });
  }
}

/**
 * What the next session needs to know to carry on. Handed over as part of its
 * instructions, so continuity survives gaps longer than the thirty seconds
 * AssemblyAI holds a session for resumption.
 */
function conversationDigest() {
  const lines = [];
  for (const t of state.turns.slice(-16)) {
    const text = (t.text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (!text) continue;
    if (t.role === "user") lines.push(`User: ${text}`);
    else if (t.role === "agent") lines.push(`You: ${text}`);
    else if (t.role === "tool")
      lines.push(`(you ran ${t.tool}${t.status === "failed" ? ", which failed" : ""}: ${text})`);
  }
  if (lines.length === 0) return "";
  return [
    "CONVERSATION SO FAR",
    "You have been talking with this user in earlier sessions that have since ended. Treat this",
    "as one continuous conversation: do not greet them or introduce yourself again.",
    ...lines,
  ]
    .join("\n")
    .slice(-3000);
}

/**
 * Two ways in, and which one is in play is visible in the popup. With the
 * user's own key the browser mints directly. Without one it falls back to the
 * hosted endpoint, which exists so a judge can try this without signing up, and
 * which is metered accordingly.
 */
async function mintToken() {
  const { assemblyKey, workerUrl } = await chrome.storage.local.get(["assemblyKey", "workerUrl"]);

  if (assemblyKey) {
    const url = `${MINT_URL}?expires_in_seconds=300`;
    const res = await request(url, { headers: { authorization: assemblyKey } }, "AssemblyAI");
    if (!res.ok) throw new Error(await describeMintFailure(res));
    return { token: (await res.json()).token, leaseId: null };
  }

  const base = (workerUrl || DEFAULT_WORKER).replace(/\/$/, "");

  // Hand back a lease a previous session left behind before asking for another.
  // Without this, two presses of the shortcut are enough to be refused for
  // holding too many sessions at once - by yourself, from three minutes ago.
  await releaseLease(base);

  let res = await request(`${base}/api/ext/token`, {}, hostOf(base));
  if (res.status === 429) {
    const body = await res
      .clone()
      .json()
      .catch(() => ({}));
    // A stale lease we did not know about. Nothing to do but wait it out, so
    // say so in seconds rather than in the abstract.
    if (body.reason === "active_session") {
      await sleep(1200);
      res = await request(`${base}/api/ext/token`, {}, hostOf(base));
    }
  }
  if (!res.ok) throw new Error(await describeMintFailure(res));

  const body = await res.json();
  if (body.leaseId) await chrome.storage.local.set({ leaseId: body.leaseId });
  return { token: body.token, leaseId: body.leaseId ?? null };
}

/**
 * Give back the slot this install is holding.
 *
 * Kept in storage rather than memory because the service worker is torn down
 * between sessions, and a lease nobody releases is a lockout with no cause the
 * user can see.
 */
async function releaseLease(base) {
  const { leaseId, workerUrl } = await chrome.storage.local.get(["leaseId", "workerUrl"]);
  if (!leaseId) return;
  await chrome.storage.local.remove("leaseId");

  const origin = base ?? (workerUrl || DEFAULT_WORKER).replace(/\/$/, "");
  await fetch(`${origin}/api/demo/release`, {
    method: "POST",
    body: JSON.stringify({ leaseId }),
  }).catch(() => {
    // Best effort. The lease expires on its own; failing here must not stop a
    // session from ending.
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch, but a dead host reads as a sentence rather than "Failed to fetch". */
async function request(url, init, label) {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(
      `couldn't reach ${label}. Check your connection, or set a different endpoint in settings.`
    );
  }
}

async function describeMintFailure(res) {
  if (res.status === 401 || res.status === 403) {
    return "that AssemblyAI key was rejected. Check it in settings.";
  }
  const body = await res.json().catch(() => ({}));
  if (body.reason === "daily_limit") {
    return "the shared demo allowance is used up for today. Add your own AssemblyAI key in settings for unlimited use.";
  }
  if (body.reason === "active_session") {
    return "another session is still finishing. Give it a few seconds and press again.";
  }
  if (body.reason === "burst") return "that was a lot of attempts at once. Give it a moment.";
  if (body.reason === "upstream")
    return "AssemblyAI wouldn't issue a session just now. Try again shortly.";
  return `couldn't start a session (error ${res.status}).`;
}

async function onAgentEvent(event) {
  await hydrated;
  switch (event?.type) {
    case "session.ready":
      setState({ phase: "listening" });
      return bumpIdle();

    case "input.speech.started":
      bumpIdle();
      if (state.phase !== "working") setState({ phase: "listening" });
      return;

    case "transcript.user.delta":
      bumpIdle();
      return appendLive("user", event.delta ?? event.text);

    case "transcript.user":
      bumpIdle();
      return settleTurn("user", event.text);

    case "reply.started":
      bumpIdle();
      return setState({ phase: "speaking" });

    case "transcript.agent.delta":
      return appendLive("agent", event.delta ?? event.text);

    case "transcript.agent":
      return settleTurn("agent", event.text, event.interrupted ? { interrupted: true } : {});

    case "reply.done":
      bumpIdle();
      if (event.status === "interrupted") settleTurn("agent", undefined, { interrupted: true });
      if (state.phase === "speaking") setState({ phase: "listening" });
      return;

    // A session reaching its time limit ends this way too, so it is not phrased
    // or coloured as a fault, and the next one simply carries on.
    case "session.dropped":
      clearTimeout(idleTimer);
      await releaseLease();
      settleLiveTurns();
      pushTurn({ role: "note", text: "Paused · Alt+A to carry on" });
      setState({ phase: "idle" });
      return flush();

    default:
      return;
  }
}

// --- offscreen document lifecycle -------------------------------------------

let creating = null;

async function hasOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return existing.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;

  // Concurrent calls would otherwise race and throw "Only a single offscreen
  // document may be created".
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK", "CLIPBOARD"],
    justification:
      "Hold a live voice conversation, speak replies, and copy text the user asks for.",
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
    const err = new Error(res?.error ?? "the audio worker isn't responding. Try again.");
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
 * Submitting is allowed only when the form has been read back since the last
 * field changed. Keyed by tab so two open forms cannot vouch for each other,
 * and ordered by a counter rather than Date.now() because several fills and a
 * read-back all land inside the same millisecond.
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

/** Tool calls made in this conversation, so one can be saved as a macro afterwards. */
const recorded = [];

let inFlight = 0;

async function runTool(name, args) {
  await hydrated;
  const target = TOOL_TARGET[name];
  if (!target) throw new Error(`there is no tool called ${name}`);

  bumpIdle();
  // Looking is not doing: a row before every action would bury the ones that matter.
  const quiet = name === "get_context";
  const id = quiet
    ? null
    : pushTurn({ role: "tool", tool: name, status: "running", text: describeCall(args) });
  inFlight++;
  if (state.phase === "listening") setState({ phase: "working" });

  try {
    const detail =
      name === "copy_to_clipboard"
        ? await copyToClipboard(args.text)
        : target === "browser"
          ? await runBrowserTool(name, args)
          : await runPageTool(name, args);
    recorded.push({ name, args });
    if (!quiet) updateTurn(id, { status: "ok", text: displayDetail(name, detail) });
    return detail;
  } catch (err) {
    if (!quiet) updateTurn(id, { status: "failed", text: err.message });
    throw err;
  } finally {
    inFlight--;
    if (inFlight === 0 && state.phase === "working") setState({ phase: "listening" });
  }
}

/**
 * The agent gets the full result; the panel gets a line it can show. A page
 * read is thousands of characters, and pouring it into the conversation is what
 * crowded the screen.
 */
function displayDetail(name, detail) {
  const text = String(detail ?? "");
  if (name === "read_text") {
    const [title] = text.split("\n");
    return `${title.slice(0, 80)} · ${text.length.toLocaleString()} characters`;
  }
  // The results are for the agent; the feed only needs to know it searched.
  if (name === "search_web" || name === "find_on_page") return text.split("\n")[0];
  return text.length > 280 ? `${text.slice(0, 280)}…` : text;
}

/**
 * Through the offscreen document, not the page. The clipboard API needs the
 * page to have focus, and with the side panel open the page almost never does -
 * so the old route reported success and silently copied nothing.
 */
async function copyToClipboard(text) {
  await sendToOffscreen({ type: "COPY", text });
  return "copied it to their clipboard";
}

function describeCall(args) {
  const first = Object.values(args ?? {})[0];
  return typeof first === "string" ? first.slice(0, 80) : "";
}

// --- tools that run against the browser -------------------------------------

async function runBrowserTool(name, args) {
  switch (name) {
    case "get_context":
      return await getContext();

    case "search_web": {
      const url = `https://www.google.com/search?q=${encodeURIComponent(args.query)}`;
      const tab = await chrome.tabs.create({ url, active: Boolean(args.switch_to) });
      remember(tab.id);
      // The point of searching is the answer, so wait for it and hand it over.
      // Returning straight away left the agent looking for the weather on
      // whatever page the user happened to be on.
      const loaded = await waitForLoad(tab.id, 8000);
      const where = args.switch_to ? "now in front" : "in the background";
      const results = loaded ? await readTab(loaded, 3500) : "";
      if (!results) {
        return `Searched for "${args.query}" [tab ${tab.id}, ${where}], but the results had not loaded yet. Try read_text with that tab_id in a moment.`;
      }
      return `Searched for "${args.query}" [tab ${tab.id}, ${where}].\nThe results page says:\n<<<\n${results}\n>>>`;
    }

    case "open_url": {
      const url = normalizeUrl(args.url);
      // Switching is the default because opening something is asking to see
      // it. Leaving it to an optional flag meant the model rarely set it.
      const tab = await chrome.tabs.create({ url, active: !args.background });
      remember(tab.id);
      // Long enough to learn the real title, short enough not to hold up the reply.
      const loaded = (await waitForLoad(tab.id, 2500)) ?? tab;
      return args.background
        ? `Opened ${describeTab(loaded)} behind the current tab.`
        : `Opened and switched to ${describeTab(loaded)}.`;
    }

    case "switch_tab":
      return await switchTab(args);

    case "close_tabs":
      return await closeTabs(args);

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
  const tab =
    name === "read_text" && args.tab_id != null ? await tabById(args.tab_id) : await activeTab();
  if (!tab?.id) throw new Error("there's no page open to work on.");
  const guard = guardFor(tab.id);

  // Checked before the call reaches the page, and phrased as a reason rather
  // than a refusal so the agent can explain itself and do the right thing next.
  if (name === "submit_form" && (guard.reviewedAt === 0 || guard.reviewedAt < guard.filledAt)) {
    throw new Error(
      "I haven't read this form back to them yet, so I can't submit it. " +
        "Call review_form first, then ask them to confirm."
    );
  }

  const res = await messageContentScript(tab, { type: "TOOL", name, args });
  if (!res?.ok) throw new Error(res?.error ?? "that didn't work on this page.");

  if (name === "fill_field" || name === "insert_text") guard.filledAt = ++guardClock;
  if (name === "review_form") guard.reviewedAt = ++guardClock;
  if (name === "submit_form") guards.delete(tab.id);

  return res.detail;
}

/**
 * Inject on demand if the script is not there. Reloading the extension does not
 * re-inject into already-open tabs, so without this every reload silently
 * breaks every tab the user already had.
 */
async function messageContentScript(tab, message) {
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // Not there yet - try to put it there.
  }

  if (!/^https?:/.test(tab.url ?? "")) {
    throw new Error("I can't work on this kind of page - try an ordinary web page.");
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-agent.js"],
    });
  } catch {
    throw new Error("I couldn't reach that page. Try reloading it.");
  }

  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    throw new Error("that page didn't respond. Try reloading it.");
  }
}

// --- tabs -------------------------------------------------------------------

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function tabById(id) {
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab) throw new Error(`tab ${id} isn't open any more. Call get_context to see what is.`);
  return tab.status === "complete" ? tab : ((await waitForLoad(tab.id, 8000)) ?? tab);
}

/** Record a tab Aalto opened, so "the tab you opened" has an answer later. */
function remember(tabId) {
  const openedTabs = [...state.openedTabs.filter((id) => id !== tabId), tabId].slice(-20);
  setState({ openedTabs });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (state.openedTabs.includes(tabId)) {
    setState({ openedTabs: state.openedTabs.filter((id) => id !== tabId) });
  }
});

function lastOpened(tabs) {
  const open = new Set(tabs.map((t) => t.id));
  const id = state.openedTabs.findLast((t) => open.has(t));
  return id == null ? null : tabs.find((t) => t.id === id);
}

function describeTab(t) {
  const host = hostOf(t.url ?? "");
  const title = (t.title || host || "untitled").replace(/\s+/g, " ").slice(0, 90);
  const mine = state.openedTabs.includes(t.id) ? ", opened by you" : "";
  return `[tab ${t.id}] "${title}" (${host}${mine})`;
}

/** Resolves once the tab has finished loading, or null after the timeout. */
async function waitForLoad(tabId, timeout) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current || current.status === "complete") return current;
  return new Promise((resolve) => {
    const finish = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      chrome.tabs.get(tabId).then(
        (tab) => resolve(tab.status === "complete" ? tab : null),
        () => resolve(null)
      );
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === "complete") finish();
    };
    const timer = setTimeout(finish, timeout);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function readTab(tab, max) {
  try {
    const res = await messageContentScript(tab, {
      type: "TOOL",
      name: "read_text",
      args: { source: "page" },
    });
    return res?.ok ? String(res.detail).slice(0, max) : "";
  } catch {
    return "";
  }
}

/**
 * What the user is looking at. The agent cannot see the screen, and without
 * this it had no way to know that "summarize this" meant the box they were in,
 * or which tab "the new one" was.
 */
async function getContext() {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const active = tabs.find((t) => t.active);
  if (!active) return "No tab is open.";

  const lines = [`Active tab: ${describeTab(active)}`];

  let snap = null;
  try {
    snap = await messageContentScript(active, { type: "SNAPSHOT" });
  } catch {
    lines.push("You cannot see inside this page - it is a browser or store page.");
  }

  if (snap?.field) {
    const f = snap.field;
    const name = f.label ? `the box labelled "${f.label}"` : "a text box";
    const where = f.current
      ? `They are in ${name}.`
      : `The box they were last typing in is ${name}.`;
    if (!f.text) {
      lines.push(`${where} It is empty.`);
    } else {
      const cut = f.truncated
        ? ` (the first ${f.text.length} of ${f.length} characters - read_text source "field" for all of it)`
        : "";
      lines.push(`${where} It contains${cut}:\n<<<\n${f.text}\n>>>`);
    }
    if (f.selected) lines.push(`Within it they have selected:\n<<<\n${f.selected}\n>>>`);
  } else if (snap) {
    lines.push("They are not in a text box.");
  }
  if (snap?.selection) lines.push(`Selected on the page:\n<<<\n${snap.selection}\n>>>`);

  const others = tabs.filter((t) => t.id !== active.id).sort((a, b) => a.index - b.index);
  if (others.length > 0) {
    lines.push("Other open tabs, left to right:");
    for (const t of others.slice(0, 30)) lines.push(`- ${describeTab(t)}`);
  }
  const recent = lastOpened(tabs);
  if (recent) lines.push(`The tab you opened most recently is tab ${recent.id}.`);
  return lines.join("\n");
}

// Words that describe the act of switching rather than the tab itself.
const TAB_FILLER =
  /\b(the|a|an|my|to|tab|tabs|page|window|one|please|switch|go|open|called|named|with|on|that's|which|is)\b/g;
const ORDINALS = { first: 0, second: 1, third: 2, fourth: 3, fifth: 4, sixth: 5 };

/**
 * Find the tab someone means from how they said it.
 *
 * Matching the whole phrase as a substring is what failed before: "the weather
 * tab" is not inside "what is the weather like - Google Search". The shared
 * word-overlap scoring used for form labels handles it, and the references
 * that are not about content at all - "the new one", "the one you opened",
 * "next", "first" - are resolved by position and history instead.
 */
function resolveTab(tabs, description) {
  const d = (description ?? "").toLowerCase();
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  const here = sorted.findIndex((t) => t.active);

  if (
    /\b(new|newest|latest|recent|just opened|you opened|you created|you made|that tab|that one)\b/.test(
      d
    )
  ) {
    const recent = lastOpened(tabs);
    if (recent) return recent;
  }
  if (/\bnext\b/.test(d)) return sorted[(here + 1) % sorted.length];
  if (/\b(previous|prior)\b/.test(d)) return sorted[(here - 1 + sorted.length) % sorted.length];
  for (const [word, index] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(d)) return sorted[index] ?? null;
  }
  if (/\blast\b/.test(d)) return sorted.at(-1);

  const wanted = d.replace(TAB_FILLER, " ").replace(/\s+/g, " ").trim();
  if (!wanted) return null;
  let best = null;
  let bestScore = 0;
  for (const t of tabs) {
    const score = Math.max(
      similarity(wanted, t.title ?? ""),
      similarity(wanted, hostOf(t.url ?? "").replace(/\./g, " "))
    );
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

async function switchTab({ tab_id, description }) {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  const target =
    tab_id != null
      ? await chrome.tabs.get(tab_id).catch(() => null)
      : resolveTab(tabs, description);
  if (!target) {
    throw new Error(
      tab_id != null
        ? `tab ${tab_id} isn't open any more. Call get_context to see what is.`
        : `nothing open matches "${description}". Call get_context for the list of tabs and their ids.`
    );
  }
  await chrome.tabs.update(target.id, { active: true });
  return `switched to ${describeTab(target)}`;
}

/** Closing is not undoable, so too broad a match is reported back rather than
 *  acted on - with the count the agent needs to ask a useful question. */
async function closeTabs({ tab_ids, description }) {
  const tabs = await chrome.tabs.query({ lastFocusedWindow: true });
  let targets;
  if (Array.isArray(tab_ids) && tab_ids.length > 0) {
    targets = tabs.filter((t) => tab_ids.includes(t.id));
  } else if (/\b(you opened|you created|you made)\b/i.test(description ?? "")) {
    targets = tabs.filter((t) => state.openedTabs.includes(t.id));
  } else {
    const wanted = (description ?? "").toLowerCase().replace(TAB_FILLER, " ").trim();
    targets = tabs.filter(
      (t) =>
        !t.active &&
        wanted &&
        Math.max(
          similarity(wanted, t.title ?? ""),
          similarity(wanted, hostOf(t.url ?? "").replace(/\./g, " "))
        ) >= 0.5
    );
  }
  if (targets.length === 0) {
    throw new Error(
      `nothing open matches that. Call get_context for the list of tabs and their ids.`
    );
  }
  if (targets.length > 4 && !(Array.isArray(tab_ids) && tab_ids.length > 0)) {
    return `that matches ${targets.length} tabs: ${targets
      .slice(0, 5)
      .map((t) => t.title)
      .join("; ")}. Ask them to confirm before closing that many.`;
  }
  await chrome.tabs.remove(targets.map((t) => t.id));
  return `closed ${targets.length} tab${targets.length === 1 ? "" : "s"}: ${targets.map((t) => `"${t.title}"`).join(", ")}`;
}

// --- macros -----------------------------------------------------------------

/**
 * Only browser-side calls are kept: replaying an `answer` would speak a stale
 * sentence and replaying a fill would put last week's values into today's form.
 * A macro is the navigation; the conversation happens fresh each time.
 */
async function saveMacro(name) {
  const key = (name ?? "").toLowerCase().trim();
  if (!key) throw new Error("that needs a name to save it under.");

  const steps = recorded.filter(
    (s) =>
      TOOL_TARGET[s.name] === "browser" && !s.name.endsWith("_macro") && s.name !== "get_context"
  );
  if (steps.length === 0) throw new Error("nothing has happened yet that's worth saving.");

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
      // One broken step should not abandon the rest.
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
