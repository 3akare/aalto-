/* global riIcon */
/**
 * Popup - a view, not the engine.
 *
 * Two ways in, deliberately different:
 *   • the keyboard shortcut starts a conversation immediately, because pressing
 *     it IS the request to talk;
 *   • opening it by hand shows a button and waits, because a window that
 *     switched the microphone on the moment you glanced at it would be unnerving.
 *
 * The session itself lives in the background worker and the offscreen document,
 * so closing this window interrupts nothing - the agent keeps listening and
 * keeps talking. That matters more here than it used to: a session survives
 * across tabs and the popup is closed for most of it.
 */

const stageLabel = document.getElementById("stageLabel");
const modeChip = document.getElementById("modeChip");
const recordBtn = document.getElementById("recordBtn");
const recordHint = document.getElementById("recordHint");
const wave = document.getElementById("wave");
const loader = document.getElementById("loader");
const settingsBtn = document.getElementById("settingsBtn");

const reply = document.getElementById("reply");
const heardEl = document.getElementById("heard");
const answerEl = document.getElementById("answer");
const answerRow = document.getElementById("answerRow");
const tasksEl = document.getElementById("tasks");

const settings = document.getElementById("settings");
const assemblyKeyInput = document.getElementById("assemblyKey");
const workerUrlInput = document.getElementById("workerUrl");
const keyNote = document.getElementById("keyNote");
const shortcutHint = document.getElementById("shortcutHint");
const shortcutLink = document.getElementById("shortcutLink");

// --- glyphs ----------------------------------------------------------------

settingsBtn.append(riIcon("settings", 17));
loader.append(riIcon("loader", 26));
recordBtn.append(riIcon("mic", 23));
shortcutLink.append(document.createTextNode("Change shortcut"), riIcon("arrowUpRight", 12));

// --- settings --------------------------------------------------------------

chrome.storage.local.get(["assemblyKey", "workerUrl"], (data) => {
  if (data.assemblyKey) assemblyKeyInput.value = data.assemblyKey;
  if (data.workerUrl) workerUrlInput.value = data.workerUrl;
  paintMode();
});

/**
 * Say whose credits are being spent.
 *
 * Buried in settings this would be invisible until a bill or a rate limit
 * arrived, and "which key am I on" is exactly the question someone asks after
 * the microphone goes dead mid-sentence.
 */
function paintMode() {
  const own = Boolean(assemblyKeyInput.value.trim());
  modeChip.textContent = own ? "your key" : "shared demo";
  modeChip.title = own
    ? "Sessions are minted straight from your AssemblyAI key, in this browser."
    : "Using the shared demo endpoint, which is capped. Add your own key for unlimited use.";
  modeChip.hidden = false;
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

// chrome:// URLs cannot be opened from an <a href>, so route it through tabs.
shortcutLink.addEventListener("click", () => {
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

chrome.commands?.getAll((commands) => {
  const bound = commands?.find((c) => c.name === "start-listening");
  if (bound?.shortcut) shortcutHint.textContent = bound.shortcut;
  // Unbound usually means it collided with one of Chrome's own shortcuts.
  else recordHint.hidden = true;
});

// --- waveform --------------------------------------------------------------

const BAR_COUNT = 19;
const levels = new Array(BAR_COUNT).fill(0);
const ctx = wave.getContext("2d");
let waveRaf = null;
let eased = new Array(BAR_COUNT).fill(0);

function pushLevel(rms) {
  // Speech RMS is small and very non-linear; a cube root opens up the quiet end
  // so ordinary speaking shows movement rather than a flat line with rare spikes.
  levels.push(Math.min(1, (rms / 0.3) ** (1 / 3)));
  levels.shift();
}

function bar(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

function drawWave() {
  const w = wave.width;
  const h = wave.height;
  ctx.clearRect(0, 0, w, h);

  const gap = 10;
  const barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
  const mid = h / 2;

  for (let i = 0; i < BAR_COUNT; i++) {
    // Ease toward the target so the bars glide rather than strobe.
    eased[i] += (levels[i] - eased[i]) * 0.35;
    const level = eased[i];
    const barH = Math.max(barW, level * h * 0.88);
    const x = i * (barW + gap);

    ctx.fillStyle =
      level > 0.05 ? `rgba(204, 120, 92, ${0.45 + level * 0.55})` : "rgba(160, 157, 150, 0.26)";
    bar(x, mid - barH / 2, barW, barH, barW / 2);
    ctx.fill();
  }
  waveRaf = requestAnimationFrame(drawWave);
}

function startWave() {
  if (!waveRaf) drawWave();
}

function stopWave() {
  if (waveRaf) cancelAnimationFrame(waveRaf);
  waveRaf = null;
  levels.fill(0);
  eased = new Array(BAR_COUNT).fill(0);
}

// --- stage -----------------------------------------------------------------

// One button for both directions. A live session has no natural end - the agent
// decides when a turn is over, not the user - so the way out has to be the same
// gesture as the way in.
recordBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "TOGGLE_SESSION" }).catch(() => {});
});

const STAGE_LABEL = {
  idle: "",
  connecting: "Connecting",
  listening: "Listening",
  speaking: "Speaking",
  working: "Working",
  error: "",
  needs_mic: "Microphone needed",
};

const TASK_ICON = {
  ok: "check",
  failed: "close",
  running: "loader",
};

function render(s) {
  if (!s) return;

  const live = s.phase === "listening" || s.phase === "speaking";
  const busy = s.phase === "connecting" || s.phase === "working";

  stageLabel.textContent = STAGE_LABEL[s.phase] ?? "";
  stageLabel.classList.toggle("live", live);

  recordBtn.hidden = live || busy;
  wave.hidden = !live;
  loader.hidden = !busy;
  recordHint.hidden = live || busy || !shortcutHint.textContent;

  if (live) startWave();
  else stopWave();

  heardEl.textContent = s.heard ? `“${s.heard}”` : "";
  heardEl.hidden = !s.heard;

  const isError = s.phase === "error" || s.phase === "needs_mic";
  const headline = isError ? s.error : (s.reply ?? "");
  answerEl.textContent = headline ?? "";
  answerRow.hidden = !headline;
  answerEl.classList.toggle("is-error", isError);

  const listed = s.activity ?? [];
  tasksEl.replaceChildren();
  for (const task of listed) {
    const li = document.createElement("li");
    li.className = task.status;
    li.append(riIcon(TASK_ICON[task.status] ?? "loader", 14));

    const text = document.createElement("span");
    text.textContent = task.detail || task.tool.replace(/_/g, " ");
    li.append(text);
    tasksEl.append(li);
  }

  reply.classList.toggle("has-answer", Boolean(headline) && listed.length > 0);
  reply.hidden = !s.heard && !headline && listed.length === 0;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE") render(message.state);
  else if (message.type === "LEVEL") pushLevel(message.value);
  return false;
});

// The background worker reports whether this popup was summoned by the shortcut
// (a session is already starting) or opened by hand (wait for the button).
chrome.runtime.sendMessage({ type: "POPUP_OPENED" }, (res) => {
  if (chrome.runtime.lastError) return;
  render(res?.state);
});
