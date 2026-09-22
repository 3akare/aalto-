/* global riIcon */
/**
 * Popup - a view, not the engine.
 *
 * Two ways in, deliberately different:
 *   • the keyboard shortcut starts listening immediately, because pressing it IS
 *     the request to talk;
 *   • opening it by hand shows a record button and waits, because a popup that
 *     started recording the moment you glanced at it would be unnerving.
 *
 * Either way it ends the same: when you stop talking. Recording and the command
 * flow live in the background worker and the offscreen document, so closing this
 * window mid-command interrupts nothing.
 */

const stageLabel = document.getElementById("stageLabel");
const recordBtn = document.getElementById("recordBtn");
const recordHint = document.getElementById("recordHint");
const wave = document.getElementById("wave");
const loader = document.getElementById("loader");
const settingsBtn = document.getElementById("settingsBtn");

const reply = document.getElementById("reply");
const heardEl = document.getElementById("heard");
const answerEl = document.getElementById("answer");
const answerRow = document.getElementById("answerRow");
const speakBtn = document.getElementById("speakBtn");
const tasksEl = document.getElementById("tasks");

const settings = document.getElementById("settings");
const serverUrlInput = document.getElementById("serverUrl");
const apiKeyInput = document.getElementById("apiKey");
const langSelect = document.getElementById("langSelect");
const shortcutHint = document.getElementById("shortcutHint");
const shortcutLink = document.getElementById("shortcutLink");
const langChip = document.getElementById("langChip");

// --- glyphs ----------------------------------------------------------------

settingsBtn.append(riIcon("settings", 17));
loader.append(riIcon("loader", 26));
recordBtn.append(riIcon("mic", 23));
shortcutLink.append(document.createTextNode("Change shortcut"), riIcon("arrowUpRight", 12));

speakBtn.append(riIcon("volumeUp", 16));

// Reading the reply aloud is a choice, not a default. Speaking unprompted is
// unwelcome in an office, a clinic waiting room or a queue, which is where a
// civic form is often filled in.
speakBtn.addEventListener("click", async () => {
  const text = answerEl.textContent.trim();
  if (!text || speakBtn.classList.contains("playing")) return;
  speakBtn.classList.add("playing");
  try {
    await chrome.runtime.sendMessage({ type: "SPEAK", text });
  } finally {
    speakBtn.classList.remove("playing");
  }
});

// --- settings --------------------------------------------------------------

// Sahara requires a language and its codes name code-switch PAIRS - "pcm" is
// the Pidgin-English model, not a Pidgin-only one. There is deliberately no
// "auto": sending no hint got the English model, which quietly anglicised
// Pidgin into nonsense ("wetin be CAC" -> "Waiting the CAC").
const DEFAULT_LANGUAGE = "pcm";

chrome.storage.local.get(["serverUrl", "langHint", "apiKey"], (data) => {
  if (data.serverUrl) serverUrlInput.value = data.serverUrl;
  if (data.apiKey) apiKeyInput.value = data.apiKey;
  langSelect.value = data.langHint || DEFAULT_LANGUAGE;
  if (!data.langHint) chrome.storage.local.set({ langHint: DEFAULT_LANGUAGE });
  paintLanguage();
});

/** Show the active pair on the stage; buried in settings, a wrong choice is
 *  invisible until the transcript comes back in the wrong language. */
function paintLanguage() {
  const label = langSelect.options[langSelect.selectedIndex]?.text ?? "";
  langChip.textContent = label.replace(" ⇄ English", "").replace(" only", "");
  langChip.title = `Transcribing ${label}`;
}

serverUrlInput.addEventListener("change", () => {
  chrome.storage.local.set({ serverUrl: serverUrlInput.value });
});
langSelect.addEventListener("change", () => {
  chrome.storage.local.set({ langHint: langSelect.value });
  paintLanguage();
});
apiKeyInput.addEventListener("change", () => {
  chrome.storage.local.set({ apiKey: apiKeyInput.value });
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
    // Ease toward the target so the bars glide rather than strobe at 16fps.
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

let currentPhase = "idle";

recordBtn.addEventListener("click", () => {
  const type = currentPhase === "recording" ? "CANCEL_RECORDING" : "START_RECORDING";
  chrome.runtime.sendMessage({ type }).catch(() => {});
});

const STAGE_LABEL = {
  idle: "",
  recording: "Listening",
  thinking: "Thinking",
  working: "Working",
  done: "",
  error: "",
  needs_mic: "Microphone needed",
};

const TASK_ICON = {
  ok: "check",
  failed: "close",
  needs_input: "question",
  answered: "check",
  pending: "loader",
};

function render(s) {
  if (!s) return;
  currentPhase = s.phase;

  const listening = s.phase === "recording";
  const busy = s.phase === "thinking" || s.phase === "working";

  stageLabel.textContent = STAGE_LABEL[s.phase] ?? "";
  stageLabel.classList.toggle("live", listening);

  recordBtn.hidden = listening || busy;
  wave.hidden = !listening;
  loader.hidden = !busy;
  recordHint.hidden = listening || busy || !shortcutHint.textContent;

  if (listening) startWave();
  else stopWave();

  heardEl.textContent = s.transcript ? `“${s.transcript}”` : "";
  heardEl.hidden = !s.transcript;

  const isError = s.phase === "error";
  const headline = isError ? s.error : (s.summary ?? "");
  answerEl.textContent = headline ?? "";
  answerRow.hidden = !headline;
  answerEl.classList.toggle("is-error", isError);
  // Nothing to read aloud when the reply is an error message.
  speakBtn.hidden = isError;

  // An answered task's text is already the headline; repeating it below would
  // say the same thing twice.
  const listed = (s.tasks ?? []).filter((t) => t.status !== "answered");
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
  reply.hidden = !s.transcript && !headline && listed.length === 0;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "STATE") render(message.state);
  else if (message.type === "LEVEL") pushLevel(message.value);
  return false;
});

// The background worker reports whether this popup was summoned by the shortcut
// (start talking straight away) or opened by hand (wait for the button).
chrome.runtime.sendMessage({ type: "POPUP_OPENED" }, (res) => {
  if (chrome.runtime.lastError) return;
  render(res?.state);
  // The shortcut starts recording in the worker before this window exists, so
  // only ask for a fresh one if nothing is already under way.
  const idle = !res?.state || res.state.phase === "idle" || res.state.phase === "done";
  if (res?.autoStart && idle) {
    chrome.runtime.sendMessage({ type: "START_RECORDING" }).catch(() => {});
  }
});
