/**
 * The capability cards, played rather than listed. Each card types out
 * something you could say, then shows what Aalto did about it, and moves on to
 * the next. The first example is already in the page, so with no script - or
 * with reduced motion - the cards still read correctly, just standing still.
 */

const EXAMPLES = {
  ask: [
    ["What's the weather like right now?", "Searched · 17°, light rain in London"],
    ["What does this page say about returns?", "Read the page · highlighted the answer"],
    ["How many days is the free trial?", "Found it · fourteen days"],
  ],
  move: [
    ["Where does it mention refunds?", "Found 3 matches · highlighted"],
    ["Take me to the pricing section.", "Jumped to Pricing"],
    ["Scroll down a bit.", "Scrolled · 40% of the way down"],
  ],
  write: [
    ["Summarize this.", "Rewrote the box · half the length"],
    ["Tell them I'm running ten minutes late.", "Typed it in"],
    ["Make that sound more formal.", "Rewrote your selection"],
  ],
  forms: [
    ["Just submit it.", "Held back · reading it to you first"],
    ["My name's Dana Whitfield, I'm in retail.", "Filled 2 fields"],
    ["Read the form back to me.", "Read back · 1 field still blank"],
  ],
  tabs: [
    ["Switch to the tab you just opened.", "Switched · YouTube"],
    ["Open my calendar.", "Opened and switched"],
    ["Close the research tabs.", "Closed 3 tabs"],
  ],
  routines: [
    ["Remember that as my morning setup.", "Saved · 4 steps"],
    ["Run my morning setup.", "Ran 4 steps"],
    ["What routines have I saved?", "2 saved"],
  ],
};

const TYPE_MS = 34;
const BEFORE_RESULT_MS = 550;
const HOLD_MS = 2600;
const OUT_MS = 350;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

async function play(card, examples, delay) {
  const said = card.querySelector(".ex-say");
  const saidText = card.querySelector(".ex-say-text");
  const did = card.querySelector(".ex-did");
  const didText = card.querySelector(".ex-did-text");

  await sleep(delay);
  for (let i = 1; ; i = (i + 1) % examples.length) {
    // Offscreen cards wait rather than spin, so the page costs nothing while
    // nobody is looking at this section.
    while (!card.isConnected || card.dataset.visible !== "true") await sleep(400);

    const [say, result] = examples[i];
    did.classList.remove("show");
    said.classList.add("out");
    await sleep(OUT_MS);

    saidText.textContent = "";
    said.classList.remove("out");
    said.classList.add("speaking");
    const quoted = `"${say}"`;
    for (let c = 1; c <= quoted.length; c++) {
      saidText.textContent = quoted.slice(0, c);
      await sleep(TYPE_MS);
    }
    said.classList.remove("speaking");

    await sleep(BEFORE_RESULT_MS);
    didText.textContent = result;
    did.classList.add("show");
    await sleep(HOLD_MS);
  }
}

if (!still) {
  const cards = Array.from(document.querySelectorAll(".cap[data-cap]"));
  const watcher = new IntersectionObserver((entries) => {
    for (const e of entries) e.target.dataset.visible = String(e.isIntersecting);
  });
  cards.forEach((card, index) => {
    watcher.observe(card);
    const examples = EXAMPLES[card.dataset.cap];
    // Staggered, so the grid ripples instead of every card typing in unison.
    if (examples) play(card, examples, 1800 + index * 900);
  });
}
