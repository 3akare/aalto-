/* global riIcon */
/**
 * The side panel - a view, not the engine. The session lives in the service
 * worker and the offscreen document, so closing this panel interrupts nothing,
 * and reopening it shows the conversation exactly where it was.
 */

const $ = (id) => document.getElementById(id);

const feed = $("feed");
const empty = $("empty");
const statusEl = $("status");
const statusText = $("statusText");
const micBtn = $("micBtn");
const micIcon = $("micIcon");
const micLabel = $("micLabel");
const wave = $("wave");
const alertEl = $("alert");
const alertText = $("alertText");
const settings = $("settings");
const settingsBtn = $("settingsBtn");
const assemblyKeyInput = $("assemblyKey");
const workerUrlInput = $("workerUrl");
const keyNote = $("keyNote");
const modeChip = $("modeChip");

$("newBtn").append(riIcon("plus", 18));
settingsBtn.append(riIcon("settings", 17));
$("alertClose").append(riIcon("close", 14));
$("shortcutLink").append(document.createTextNode("Change shortcut"), riIcon("arrowUpRight", 12));

// --- connection to the worker ----------------------------------------------

/**
 * Tells the worker this window has a panel open, so the shortcut does not
 * re-open it and pull focus off the page. Reconnects if the worker restarts.
 */
async function connect() {
  const { id: windowId } = await chrome.windows.getCurrent();
  const port = chrome.runtime.connect({ name: "sidepanel" });
  port.postMessage({ type: "hello", windowId });
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}
connect();

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE") render(message.state);
  else if (message.type === "LEVEL") pushLevel(message.value);
  return false;
});

chrome.runtime.sendMessage({ type: "GET_STATE" }, (res) => {
  if (!chrome.runtime.lastError && res?.state) render(res.state);
});

micBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "TOGGLE_SESSION" }));
$("newBtn").addEventListener("click", () =>
  chrome.runtime.sendMessage({ type: "NEW_CONVERSATION" })
);
$("alertClose").addEventListener("click", () =>
  chrome.runtime.sendMessage({ type: "DISMISS_ERROR" })
);

// --- settings --------------------------------------------------------------

chrome.storage.local.get(["assemblyKey", "workerUrl"], (data) => {
  assemblyKeyInput.value = data.assemblyKey ?? "";
  workerUrlInput.value = data.workerUrl ?? "";
  paintMode();
});

function paintMode() {
  const own = Boolean(assemblyKeyInput.value.trim());
  modeChip.textContent = own ? "Your key" : "Shared demo";
  keyNote.textContent = own
    ? "Your key stays in this browser. Sessions are minted directly from it."
    : "Without a key, Aalto uses a shared demo endpoint with a daily cap.";
}

assemblyKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ assemblyKey: assemblyKeyInput.value.trim() });
  paintMode();
});
workerUrlInput.addEventListener("change", () => {
  chrome.storage.local.set({ workerUrl: workerUrlInput.value.trim() });
});

settingsBtn.addEventListener("click", () => {
  const open = settings.hidden;
  settings.hidden = !open;
  settingsBtn.setAttribute("aria-expanded", String(open));
});

// chrome:// URLs cannot be opened from an <a href>.
$("shortcutLink").addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

chrome.commands?.getAll((commands) => {
  const shortcut = commands?.find((c) => c.name === "start-listening")?.shortcut;
  for (const el of document.querySelectorAll(".shortcut")) el.textContent = shortcut || "unset";
});

// --- rendering -------------------------------------------------------------

const PHASE = {
  idle: ["", "idle"],
  connecting: ["Connecting", "busy"],
  listening: ["Listening", "live"],
  speaking: ["Speaking", "live"],
  working: ["Working", "busy"],
  needs_mic: ["Mic needed", "warn"],
  error: ["", "idle"],
};

// Verbs, not past tense: the icon says whether it worked, and "Typed" beside a
// failure reads as a contradiction.
const TOOL_LABEL = {
  read_text: "Read page",
  highlight: "Highlight",
  scroll_page: "Scroll",
  go_to_section: "Jump to",
  find_on_page: "Find",
  insert_text: "Type",
  copy_to_clipboard: "Copy",
  fill_field: "Fill field",
  review_form: "Read back",
  submit_form: "Submit",
  open_url: "Open tab",
  search_web: "Search",
  switch_tab: "Switch tab",
  close_tabs: "Close tabs",
  save_macro: "Save routine",
  run_macro: "Run routine",
  list_macros: "Routines",
};

const TOOL_ICON = { running: "loader", ok: "check", failed: "close" };

let phase = "idle";

function render(s) {
  phase = s.phase;
  const [label, tone] = PHASE[s.phase] ?? PHASE.idle;
  // Only when something is happening. At rest the button already says so.
  statusEl.hidden = tone === "idle";
  statusText.textContent = label;
  statusEl.dataset.tone = tone;

  const live = ["listening", "speaking", "working"].includes(s.phase);
  const connecting = s.phase === "connecting";
  micBtn.dataset.live = String(live);
  micBtn.disabled = connecting;
  // State arrives several times a second while words stream in; only touch
  // what actually changed.
  const icon = connecting ? "loader" : live ? "stop" : "mic";
  if (micIcon.dataset.icon !== icon) {
    micIcon.dataset.icon = icon;
    micIcon.replaceChildren(riIcon(icon, 18));
  }
  setText(micLabel, connecting ? "Connecting…" : live ? "Stop" : "Start talking");

  wave.classList.toggle("active", live);
  if (live) startWave();
  else if (raf || !waveDrawn) stopWave();

  const showAlert = (s.phase === "error" || s.phase === "needs_mic") && Boolean(s.error);
  alertEl.hidden = !showAlert;
  if (showAlert) alertText.textContent = capitalise(s.error);

  renderTurns(s.turns ?? []);
}

/** Keyed, so a streaming turn updates in place and an opened tool row stays open. */
const nodes = new Map();

function renderTurns(turns) {
  const wasPinned = isPinned();
  const keep = new Set(turns.map((t) => t.id));
  for (const [id, el] of nodes) {
    if (!keep.has(id)) {
      el.remove();
      nodes.delete(id);
    }
  }

  for (const turn of turns) {
    let el = nodes.get(turn.id);
    if (!el) {
      el = createTurn(turn);
      nodes.set(turn.id, el);
      feed.append(el);
    }
    updateTurn(el, turn);
  }

  empty.hidden = turns.length > 0;
  if (wasPinned) feed.scrollTop = feed.scrollHeight;
}

function createTurn(turn) {
  if (turn.role === "tool") {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "tool";
    el.innerHTML =
      '<span class="ico"></span><span class="label"></span><span class="detail"></span>';
    el.addEventListener("click", () => el.classList.toggle("open"));
    return el;
  }
  const el = document.createElement("div");
  if (turn.role === "note") {
    el.className = "note";
    el.append(document.createElement("span"));
  } else {
    el.className = `msg ${turn.role}`;
  }
  return el;
}

function updateTurn(el, turn) {
  const text = turn.text ?? "";

  if (turn.role === "tool") {
    if (el.dataset.status !== turn.status) {
      el.dataset.status = turn.status;
      el.querySelector(".ico").replaceChildren(riIcon(TOOL_ICON[turn.status] ?? "loader", 14));
    }
    el.querySelector(".label").textContent = TOOL_LABEL[turn.tool] ?? turn.tool;
    setText(el.querySelector(".detail"), text);
    el.title = text;
    return;
  }

  if (turn.role === "note") {
    setText(el.firstChild, text);
    return;
  }

  setText(el, text);
  el.classList.toggle("live", Boolean(turn.live));
  el.classList.toggle("interrupted", Boolean(turn.interrupted) && !turn.live);
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

/** Follow the newest turn, unless the reader has scrolled up to look back. */
function isPinned() {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < 48;
}

// --- waveform --------------------------------------------------------------

const BAR_COUNT = 32;
const levels = new Array(BAR_COUNT).fill(0);
let eased = new Array(BAR_COUNT).fill(0);
const ctx = wave.getContext("2d");
let raf = null;
let waveDrawn = false;

function pushLevel(rms) {
  // Speech RMS is small and non-linear; a cube root opens up the quiet end.
  levels.push(Math.min(1, (rms / 0.3) ** (1 / 3)));
  levels.shift();
}

function sizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  wave.width = Math.round(wave.clientWidth * ratio);
  wave.height = Math.round(wave.clientHeight * ratio);
}
// Resizing clears a canvas, so the resting state has to be drawn again after it.
new ResizeObserver(() => {
  sizeCanvas();
  if (!raf) stopWave();
}).observe(wave);

function draw() {
  const { width: w, height: h } = wave;
  ctx.clearRect(0, 0, w, h);
  const gap = w / BAR_COUNT / 2.2;
  const barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  const t = performance.now() / 260;

  for (let i = 0; i < BAR_COUNT; i++) {
    // While the agent talks there is no microphone level to show, so the bars
    // breathe instead of sitting flat and looking dead.
    const target = phase === "speaking" ? 0.25 + 0.2 * Math.sin(t + i * 0.5) ** 2 : levels[i];
    eased[i] += (target - eased[i]) * 0.3;
    const barH = Math.max(barW, eased[i] * h * 0.9);
    const x = i * (barW + gap);
    ctx.fillStyle =
      eased[i] > 0.05
        ? `rgba(204, 120, 92, ${0.45 + eased[i] * 0.55})`
        : "rgba(160, 157, 150, 0.25)";
    ctx.beginPath();
    ctx.roundRect(x, (h - barH) / 2, barW, barH, barW / 2);
    ctx.fill();
  }
  raf = requestAnimationFrame(draw);
}

function startWave() {
  if (!raf) draw();
}

function stopWave() {
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  waveDrawn = true;
  levels.fill(0);
  eased = new Array(BAR_COUNT).fill(0);
  sizeCanvas();
  const { width: w, height: h } = wave;
  ctx.clearRect(0, 0, w, h);
  const gap = w / BAR_COUNT / 2.2;
  const barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  ctx.fillStyle = "rgba(160, 157, 150, 0.25)";
  for (let i = 0; i < BAR_COUNT; i++) {
    ctx.beginPath();
    ctx.roundRect(i * (barW + gap), (h - barW) / 2, barW, barW, barW / 2);
    ctx.fill();
  }
}
