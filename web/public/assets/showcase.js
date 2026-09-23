/**
 * "What you can do", played in a replica of the side panel. Each capability is
 * one exchange - you speak, a tool runs, Aalto replies - and the list beside
 * the panel follows along. Clicking a capability jumps straight to it.
 *
 * The replies are the kind the real agent gives; the fill-forms one shows the
 * guard refusing a submit before the form has been read back.
 */

const SCENES = [
  {
    say: "What's the weather like right now?",
    tools: [{ label: "Search", detail: '"current weather" · results read', ok: true }],
    reply: "Light rain in London, seventeen degrees.",
  },
  {
    say: "Where does it mention refunds?",
    tools: [{ label: "Find", detail: '3 matches for "refund" · highlighted', ok: true }],
    reply: "Orders can be refunded within 30 days of delivery. I've highlighted all three.",
  },
  {
    say: "Summarize this.",
    tools: [{ label: "Type", detail: "Replaced the text in the box", ok: true }],
    reply: "Done, it's shorter.",
  },
  {
    say: "Just submit it.",
    tools: [
      { label: "Submit", detail: "Held back - not read to you yet", ok: false },
      { label: "Read back", detail: "7 fields · phone number blank", ok: true },
    ],
    reply: "Your phone number is still blank. Add it and I'll submit.",
  },
  {
    say: "Switch to the tab you just opened.",
    tools: [{ label: "Switch tab", detail: "YouTube · tab 743", ok: true }],
    reply: "You're on YouTube.",
  },
  {
    say: "Remember that as my morning setup.",
    tools: [{ label: "Save routine", detail: '"morning setup" · 4 steps', ok: true }],
    reply: "Saved. Say morning setup whenever you want it.",
  },
];

const ICON = {
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>',
  no: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" /></svg>',
  run: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a8 8 0 1 0 8 8" /></svg>',
};

const feed = document.getElementById("scFeed");
const list = document.getElementById("scList");
const statusEl = document.getElementById("scStatus");
const statusText = document.getElementById("scStatusText");
const wave = document.getElementById("scWave");
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

let run = 0; // bumped to cancel whatever is playing
let visible = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function setStatus(label, tone) {
  statusText.textContent = label;
  statusEl.dataset.tone = tone;
}

function add(className, html) {
  const el = document.createElement("div");
  el.className = className;
  el.innerHTML = html;
  feed.append(el);
  return el;
}

function toolRow(tool) {
  return add(
    "sc-tool is-running",
    `<span class="sc-tool-ico">${ICON.run}</span><span class="sc-tool-label">${tool.label}</span><span class="sc-tool-detail">${tool.detail}</span>`
  );
}

function highlight(i) {
  for (const b of list.querySelectorAll(".sc-item"))
    b.classList.toggle("is-on", Number(b.dataset.i) === i);
}

/** The finished exchange at once - for reduced motion, and the first paint. */
function render(i) {
  const scene = SCENES[i];
  highlight(i);
  feed.replaceChildren();
  add("sc-msg sc-user", `"${scene.say}"`);
  for (const t of scene.tools) {
    const row = toolRow(t);
    row.className = `sc-tool ${t.ok ? "is-ok" : "is-no"}`;
    row.querySelector(".sc-tool-ico").innerHTML = t.ok ? ICON.ok : ICON.no;
  }
  add("sc-msg sc-agent", scene.reply);
  setStatus("Listening", "live");
}

async function play(i, me) {
  const alive = () => me === run;
  const scene = SCENES[i];
  highlight(i);

  feed.classList.add("is-out");
  await sleep(300);
  if (!alive()) return;
  feed.replaceChildren();
  feed.classList.remove("is-out");

  // You speak: the words arrive as you say them, the waveform moving.
  setStatus("Listening", "live");
  wave.classList.add("is-talking");
  const user = add("sc-msg sc-user is-live", "");
  const quoted = `"${scene.say}"`;
  for (let c = 1; c <= quoted.length; c++) {
    user.textContent = quoted.slice(0, c);
    await sleep(34);
    if (!alive()) return;
  }
  user.classList.remove("is-live");
  wave.classList.remove("is-talking");
  await sleep(350);

  // It acts.
  setStatus("Working", "busy");
  for (const t of scene.tools) {
    const row = toolRow(t);
    await sleep(750);
    if (!alive()) return;
    row.className = `sc-tool ${t.ok ? "is-ok" : "is-no"}`;
    row.querySelector(".sc-tool-ico").innerHTML = t.ok ? ICON.ok : ICON.no;
    await sleep(250);
  }

  // It replies, word by word, the way the panel streams it.
  setStatus("Speaking", "live");
  const agent = add("sc-msg sc-agent is-live", "");
  const words = scene.reply.split(" ");
  for (let w = 1; w <= words.length; w++) {
    agent.textContent = words.slice(0, w).join(" ");
    await sleep(110);
    if (!alive()) return;
  }
  agent.classList.remove("is-live");
  setStatus("Listening", "live");
  await sleep(3200);
}

async function loop(start) {
  const me = ++run;
  for (let i = start; ; i = (i + 1) % SCENES.length) {
    // Nothing plays while the section is off screen.
    while (!visible) {
      await sleep(400);
      if (me !== run) return;
    }
    await play(i, me);
    if (me !== run) return;
  }
}

list.addEventListener("click", (event) => {
  const button = event.target.closest(".sc-item");
  if (!button) return;
  const i = Number(button.dataset.i);
  if (still) render(i);
  else loop(i);
});

render(0);
if (!still) {
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
  }).observe(document.querySelector(".showcase"));
  // Let the first, finished frame be read before the loop starts moving.
  // Unless someone has already picked one.
  setTimeout(() => {
    if (run === 0) loop(1);
  }, 2500);
}
