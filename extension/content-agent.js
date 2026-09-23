/**
 * The agent's hands on the page - any page, not just Google Forms.
 *
 * Fields are found by their actual controls, with a label derived per control
 * from the six ways a page can name an input. A classic script rather than a
 * module, because executeScript injects files, not module graphs.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SNAPSHOT") {
    sendResponse(snapshot());
    return false;
  }
  if (message.type !== "TOOL") return false;
  try {
    sendResponse(dispatch(message.name, message.args ?? {}));
  } catch (err) {
    console.error("[Aalto]", err);
    sendResponse({ ok: false, error: String(err.message ?? err) });
  }
  return true;
});

function dispatch(name, args) {
  switch (name) {
    case "read_text":
      return readText(args.source);
    case "highlight":
      return highlight(args.quote);
    case "scroll_page":
      return { ok: true, detail: scrollPage(args.direction, args.amount) };
    case "go_to_section":
      return { ok: true, detail: goToSection(args.section) };
    case "find_on_page":
      return { ok: true, detail: findOnPage(args) };
    case "insert_text":
      return insertText(args.text, args.mode);
    case "fill_field":
      return fillField(args.label, args.value);
    case "review_form":
      return reviewForm();
    case "submit_form":
      return submitForm();
    default:
      return { ok: false, error: `${name} isn't something I can do on a page` };
  }
}

// --- reading ----------------------------------------------------------------

const MAX_PAGE_CHARS = 6000;
const FIELD_PREVIEW = 4000;
const SELECTION_PREVIEW = 2000;

/**
 * What the user is working on, for get_context: the box they are in (or were
 * last typing in) with its contents and any selection inside it, plus any text
 * selected elsewhere on the page.
 */
function snapshot() {
  const el = focusedEditable();
  let field = null;
  if (el) {
    const text = contentsOf(el);
    field = {
      label: labelFor(el).slice(0, 80),
      current: editingHost(activeElementDeep()) === el,
      text: text.slice(0, FIELD_PREVIEW),
      length: text.length,
      truncated: text.length > FIELD_PREVIEW,
      selected: selectionIn(el)?.text.slice(0, SELECTION_PREVIEW) ?? "",
    };
  }
  const pageSelection = String(window.getSelection() ?? "").trim();
  return {
    ok: true,
    field,
    selection: field?.selected ? "" : pageSelection.slice(0, SELECTION_PREVIEW),
  };
}

/** Capped: the point is one spoken sentence back, and a sprawling page costs
 *  latency on every turn for context nobody will hear. */
function readText(source) {
  if (source === "selection") {
    const selected = String(window.getSelection() ?? "").trim();
    if (!selected) return { ok: false, error: "nothing is selected on this page" };
    return { ok: true, detail: selected.slice(0, MAX_PAGE_CHARS) };
  }

  if (source === "field") {
    const el = focusedEditable();
    if (!el) return { ok: false, error: "they aren't typing in anything right now" };
    return { ok: true, detail: contentsOf(el) || "(the box is empty)" };
  }

  const main = document.querySelector("main, article, [role='main']") ?? document.body;
  const text = (main.innerText ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return { ok: false, error: "there's no readable text on this page" };
  return { ok: true, detail: `${document.title}\n\n${text.slice(0, MAX_PAGE_CHARS)}` };
}

const HIGHLIGHT_CLASS = "aalto-highlight";

/** A CSS Highlight rather than a <mark>: editing the DOM of a page we do not
 *  own breaks React reconciliation and can lose the user's place. */
function highlight(quote) {
  const needle = (quote ?? "").trim();
  if (!needle) return { ok: false, error: "no phrase to look for" };

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const idx = node.textContent.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) continue;

    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + needle.length);

    if (typeof Highlight === "function" && CSS.highlights) {
      ensureHighlightStyle();
      CSS.highlights.set(HIGHLIGHT_CLASS, new Highlight(range));
    } else {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    return { ok: true, detail: "highlighted it on the page" };
  }
  return { ok: false, error: "couldn't find that wording on the page" };
}

let highlightStyled = false;
function ensureHighlightStyle() {
  if (highlightStyled) return;
  const style = document.createElement("style");
  style.textContent = `::highlight(${HIGHLIGHT_CLASS}) { background: #f5d9a8; color: #1a1915; }`;
  document.head.appendChild(style);
  highlightStyled = true;
}

// --- writing ----------------------------------------------------------------

/**
 * The last box the user was typing in.
 *
 * Talking to the agent usually moves focus away from the page - to the side
 * panel, to the shortcut, to the microphone button - so by the time "type this"
 * arrives, nothing on the page is focused and "which box?" has no answer. The
 * box they last clicked into is what they mean.
 */
let lastEditable = null;

// Three signals rather than one: focus events do not always fire when the
// window itself is not focused, but a press and a keystroke always land.
for (const type of ["focusin", "pointerdown", "input"]) {
  document.addEventListener(
    type,
    (event) => {
      const el = editingHost(event.composedPath?.()[0] ?? event.target);
      if (el) lastEditable = el;
    },
    true
  );
}

const NOT_TEXT = /^(checkbox|radio|button|submit|reset|file|image|range|color|hidden)$/i;

/** The editable element this node belongs to, or null. */
function editingHost(node) {
  if (node?.nodeType !== 1) return null;
  if (node.tagName === "TEXTAREA") return node.disabled || node.readOnly ? null : node;
  if (node.tagName === "INPUT") {
    return NOT_TEXT.test(node.type) || node.disabled || node.readOnly ? null : node;
  }
  if (node.isContentEditable) {
    let host = node;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    return host;
  }
  return null;
}

function activeElementDeep() {
  let el = document.activeElement;
  // Web components keep their focused element behind a shadow root.
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

function focusedEditable() {
  return editingHost(activeElementDeep()) ?? (lastEditable?.isConnected ? lastEditable : null);
}

/**
 * What is selected inside a box, with enough to put the selection back.
 * Captured before focusing, because focusing can move the caret.
 */
function selectionIn(el) {
  if (!el.isContentEditable) {
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    return end > start ? { start, end, text: el.value.slice(start, end) } : null;
  }
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return null;
  return { range: range.cloneRange(), text: selection.toString() };
}

function restoreSelection(el, saved) {
  if (!el.isContentEditable) return el.setSelectionRange(saved.start, saved.end);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(saved.range);
}

function contentsOf(el) {
  return el.isContentEditable ? el.innerText.trim() : el.value;
}

function selectAllIn(el) {
  if (!el.isContentEditable) return el.select();
  const range = document.createRange();
  range.selectNodeContents(el);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function caretToEnd(el) {
  if (!el.isContentEditable) {
    try {
      el.setSelectionRange(el.value.length, el.value.length);
    } catch {
      // email and number inputs do not support selection; typing appends anyway.
    }
    return;
  }
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function insertText(text, mode = "append") {
  const el = focusedEditable();
  if (!el) {
    return { ok: false, error: "click into the box you want me to type in, then ask again." };
  }

  const saved = selectionIn(el);
  el.focus({ preventScroll: true });
  const existing = contentsOf(el);

  // Replacing "the selection" with nothing selected means the whole box: that
  // is what someone saying "summarize this" from inside it means.
  const scope = mode === "replace_selection" && !saved ? "replace" : mode;
  if (scope === "replace") selectAllIn(el);
  else if (scope === "replace_selection") restoreSelection(el, saved);
  else caretToEnd(el);

  // A space between sentences, but not a leading one into an empty box.
  const addition = scope === "append" && existing && !/\s$/.test(existing) ? ` ${text}` : text;

  // Through the editor's own input path, as if typed. Gmail, Slack, Notion and
  // any React form keep their own model of the text and ignore an assigned
  // value; insertText goes through it, and lands on the undo stack too.
  const typed = document.execCommand("insertText", false, addition);

  if (!typed || contentsOf(el) === existing)
    writeDirectly(el, scope, text, addition, saved, existing);

  const detail =
    scope === "replace"
      ? "replaced the text in the box"
      : scope === "replace_selection"
        ? "replaced the selected text"
        : "typed it in";
  return { ok: true, detail };
}

/** For editors that refuse insertText: set the result outright instead. */
function writeDirectly(el, scope, text, addition, saved, existing) {
  if (scope === "replace_selection" && saved) {
    if (el.isContentEditable) {
      saved.range.deleteContents();
      saved.range.insertNode(document.createTextNode(text));
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    } else {
      setNativeValue(el, el.value.slice(0, saved.start) + text + el.value.slice(saved.end));
    }
    return;
  }
  const next = scope === "replace" ? text : `${existing}${addition}`;
  if (el.isContentEditable) {
    el.textContent = next;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    setNativeValue(el, next);
  }
}

// --- matching ---------------------------------------------------------------

// A content script cannot import a module: chrome.scripting.executeScript
// injects files, not module graphs. So the shared matching code is spliced in
// here by `npm run sync-shared` and committed, which keeps one source of truth
// without giving up on-demand injection. Edit shared/matching.js, not this.
// AALTO:MATCHING-START
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "your",
  "you",
  "my",
  "is",
  "are",
  "was",
  "please",
  "enter",
  "what",
  "whats",
  "which",
  "who",
  "select",
  "choose",
  "provide",
  "type",
  "in",
  "of",
  "for",
  "to",
  "do",
  "does",
  "and",
  "or",
  "this",
  "that",
  "it",
  "here",
]);

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenise(text) {
  return normalize(text)
    .split(" ")
    .filter((w) => w && !STOPWORDS.has(w));
}

/**
 * Containment-biased token overlap. Dividing by the LARGER set meant a spoken
 * "name" against "What is your full legal name?" scored 0.17 and missed - short
 * labels failed against verbose questions as a rule. The smaller set asks the
 * right question: is what they said contained in this one?
 */
function similarity(spoken, questionText) {
  const a = new Set(tokenise(spoken));
  const b = new Set(tokenise(questionText));
  if (a.size === 0 || b.size === 0) return 0;

  let overlap = 0;
  for (const t of a) {
    if (b.has(t)) {
      overlap += 1;
      continue;
    }
    // Partial credit for a shared stem, so "registration" finds "register".
    for (const u of b) {
      if (
        t.length >= 4 &&
        u.length >= 4 &&
        (u.startsWith(t.slice(0, 4)) || t.startsWith(u.slice(0, 4)))
      ) {
        overlap += 0.5;
        break;
      }
    }
  }
  return overlap / Math.min(a.size, b.size);
}

/** How close a spoken label must be to count as naming a field. */
const FIELD_THRESHOLD = 0.34;

/** Higher than the field threshold on purpose: naming the wrong field wastes a
 *  turn, picking the wrong option puts a wrong answer into a form. */
const OPTION_THRESHOLD = 0.5;

/**
 * Best match, or null if nothing is close enough. Returning null rather than a
 * guess is the entire safety property: an earlier version fell back to the
 * first option, putting a wrong answer into a form nobody had agreed to.
 */
function bestOption(options, value) {
  const scored = options
    .map((o) => ({ ...o, score: similarity(value, o.text) }))
    .sort((x, y) => y.score - x.score);
  return scored.length > 0 && scored[0].score >= OPTION_THRESHOLD ? scored[0] : null;
}

/** Accept "1990-04-12", "12/04/1990", and plain English like "12 April 1990". */
function toIsoDate(value) {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const dmy = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;

  // Local parts, not toISOString(): local midnight converted to UTC moves back
  // a day for anyone east of Greenwich.
  const d = new Date(parsed);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
// AALTO:MATCHING-END

// --- moving around the page -----------------------------------------------------

// Spliced from shared/page-nav.js by `npm run sync-shared`, like the block above.
// Edit shared/page-nav.js, not this.
// AALTO:PAGENAV-START
const SECTION_THRESHOLD = 0.5;
const MAX_MATCHES = 200;
const STEP = { small: 0.35, page: 0.85, large: 2.5 };

// --- scrolling --------------------------------------------------------------

/**
 * The element that actually scrolls. Most apps - Gmail, Slack, Notion, docs
 * sites - scroll an inner panel, not the window, so scrolling the window does
 * nothing there. Whatever panel sits under the middle of the screen is what
 * the user means by "the page".
 */
function scroller(scope) {
  if (scope) return scope;
  let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  while (el && el !== document.body && el !== document.documentElement) {
    const { overflowY } = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 4) return el;
    el = el.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
}

function scrollPage(direction, amount = "page", scope = null) {
  const el = scroller(scope);
  const isWindow = el === document.scrollingElement || el === document.documentElement;
  const view = isWindow ? window.innerHeight : el.clientHeight;
  const max = Math.max(0, el.scrollHeight - view);
  const step = (STEP[amount] ?? STEP.page) * view;

  let target = el.scrollTop;
  if (direction === "top") target = 0;
  else if (direction === "bottom") target = max;
  else if (direction === "up") target = Math.max(0, el.scrollTop - step);
  else target = Math.min(max, el.scrollTop + step);

  if (max === 0) return "this page doesn't scroll - it all fits on screen";
  if (Math.abs(target - el.scrollTop) < 2) {
    return target === 0 ? "already at the top of the page" : "already at the bottom of the page";
  }

  el.scrollTo({ top: target, behavior: "smooth" });
  if (target === 0) return "at the top of the page";
  if (target >= max - 2) return "at the bottom of the page";
  // Reported so the agent knows when there is no more to scroll to.
  return `scrolled ${direction} - now about ${Math.round((target / max) * 100)}% of the way down the page`;
}

// --- sections ---------------------------------------------------------------

const HEADINGS = 'h1, h2, h3, h4, h5, h6, [role="heading"]';

const visible = (el) => (el.checkVisibility ? el.checkVisibility() : el.offsetParent !== null);
const clean = (text) => (text ?? "").replace(/\s+/g, " ").trim();

function goToSection(section, root = document.body, container = null) {
  const headings = Array.from(root.querySelectorAll(HEADINGS))
    .filter(visible)
    .map((el) => ({ el, text: clean(el.textContent) }))
    .filter((h) => h.text && h.text.length < 160);

  let best = null;
  for (const h of headings) {
    const score = similarity(section, h.text);
    if (score > (best?.score ?? 0)) best = { ...h, score };
  }

  // Pages without proper headings often still anchor their sections by id:
  // #pricing, #faq, #get-started.
  if (!best || best.score < SECTION_THRESHOLD) {
    for (const el of root.querySelectorAll("[id]")) {
      if (!visible(el)) continue;
      const score = similarity(section, el.id.replace(/[-_]+/g, " "));
      if (score > (best?.score ?? 0)) best = { el, text: el.id.replace(/[-_]+/g, " "), score };
    }
  }

  if (!best || best.score < SECTION_THRESHOLD) {
    const names = headings.slice(0, 15).map((h) => h.text);
    return names.length
      ? `no section matches "${section}". The sections on this page are: ${names.join("; ")}.`
      : `no section matches "${section}", and this page has no headings to jump between. Try find_on_page instead.`;
  }

  bringIntoView(best.el, container, "start");
  mark("aalto-section", [rangeOver(best.el)]);
  return `jumped to the "${best.text}" section`;
}

// --- finding ----------------------------------------------------------------

let found = null; // { root, container, query, ranges, snippets, index }

/**
 * Find words on the page, like Ctrl+F.
 *
 * The page text is flattened into one string first, with a map back to the
 * text node and offset each character came from. Searching node by node
 * misses any phrase that crosses formatting - "refund <b>policy</b>" is two
 * text nodes - and those are exactly the phrases people ask about.
 */
function findOnPage({ query, step } = {}, root = document.body, container = null) {
  if (!query && step) {
    if (!found || found.root !== root || found.ranges.length === 0) {
      return "there's no search to step through - say what to look for.";
    }
    const n = found.ranges.length;
    found.index = (found.index + (step === "previous" ? n - 1 : 1)) % n;
    show(found);
    return `match ${found.index + 1} of ${n} for "${found.query}": "${found.snippets[found.index]}"`;
  }

  const wanted = clean(query).toLowerCase();
  if (!wanted) return "say what to look for.";

  const { text, lower, nodes, nodeAt, offsetAt, breaks } = flatten(root);
  const ranges = [];
  const snippets = [];
  for (
    let at = lower.indexOf(wanted);
    at !== -1 && ranges.length < MAX_MATCHES;
    at = lower.indexOf(wanted, at + wanted.length)
  ) {
    const end = at + wanted.length - 1;
    const range = document.createRange();
    range.setStart(nodes[nodeAt[at]], offsetAt[at]);
    range.setEnd(nodes[nodeAt[end]], offsetAt[end] + 1);
    ranges.push(range);
    // The paragraph the match sits in - not a fixed window, which ran into the
    // paragraph before and gave the agent a muddled sentence to answer from.
    const blockStart = breaks.findLast((b) => b <= at) ?? 0;
    const blockEnd = breaks.find((b) => b > end) ?? text.length;
    snippets.push(excerpt(text, at, end, blockStart, blockEnd));
  }

  found = { root, container, query: clean(query), ranges, snippets, index: 0 };
  if (ranges.length === 0) {
    mark("aalto-find", []);
    mark("aalto-find-current", []);
    return `"${clean(query)}" isn't on this page.`;
  }

  show(found);
  const listed = snippets
    .slice(0, 3)
    .map((s, i) => `${i + 1}. "${s}"`)
    .join("\n");
  const more = ranges.length > 3 ? `\n...and ${ranges.length - 3} more.` : "";
  return `found ${ranges.length} match${ranges.length === 1 ? "" : "es"} for "${found.query}" - showing the first, highlighted:\n${listed}${more}`;
}

/**
 * The sentence around a match, cut at sentence or word boundaries and kept
 * inside its own paragraph. A fixed character window started mid-word and ran
 * into the paragraph before, which gave the agent a muddled sentence to answer
 * from.
 */
function excerpt(text, at, end, blockStart, blockEnd) {
  let from = Math.max(blockStart, at - 140);
  if (from > blockStart) {
    const sentence = text.lastIndexOf(". ", at);
    const space = text.indexOf(" ", from);
    if (sentence >= from) from = sentence + 2;
    else if (space !== -1 && space < at) from = space + 1;
  }
  let to = Math.min(blockEnd, end + 141);
  if (to < blockEnd) {
    const stop = text.indexOf(". ", end);
    const space = text.lastIndexOf(" ", to);
    if (stop !== -1 && stop < to) to = stop + 1;
    else if (space > end) to = space;
  }
  const lead = from > blockStart && text[from - 2] !== "." ? "..." : "";
  const tail = to < blockEnd && text[to - 1] !== "." ? "..." : "";
  return `${lead}${text.slice(from, to).trim()}${tail}`;
}

function show(state) {
  mark("aalto-find", state.ranges);
  mark("aalto-find-current", [state.ranges[state.index]]);
  const node = state.ranges[state.index].startContainer;
  bringIntoView(node.nodeType === 1 ? node : node.parentElement, state.container, "center");
}

/**
 * Scroll an element into view - within one panel when told which, so a page
 * embedded in another page does not drag its host along. Left alone,
 * scrollIntoView scrolls every scrolling ancestor, including the window.
 */
function bringIntoView(el, container, block) {
  if (!el) return;
  if (!container) {
    el.scrollIntoView({ behavior: "smooth", block });
    return;
  }
  const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top;
  const top =
    block === "center"
      ? container.scrollTop + offset - container.clientHeight / 2 + el.offsetHeight / 2
      : container.scrollTop + offset - 12;
  container.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
}

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT"]);

/** One searchable string for the whole root, whitespace collapsed, mapped back to the DOM. */
function flatten(root) {
  const nodes = [];
  let text = "";
  const nodeAt = [];
  const offsetAt = [];
  const breaks = [0]; // where each block's text begins
  let lastBlock = null;
  let spaced = true;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const parent = n.parentElement;
      if (!parent || SKIP.has(parent.tagName) || !n.data.trim()) return NodeFilter.FILTER_REJECT;
      return visible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const k = nodes.push(n) - 1;
    const block = n.parentElement.closest(
      "p, li, td, th, h1, h2, h3, h4, h5, h6, div, section, article, blockquote, pre"
    );
    // Separate blocks, so the end of one paragraph cannot run into the next.
    if (block !== lastBlock) {
      if (!spaced) {
        text += " ";
        nodeAt.push(k);
        offsetAt.push(0);
        spaced = true;
      }
      breaks.push(text.length);
    }
    lastBlock = block;
    for (let i = 0; i < n.data.length; i++) {
      const isSpace = /\s/.test(n.data[i]);
      if (isSpace && spaced) continue;
      text += isSpace ? " " : n.data[i];
      nodeAt.push(k);
      offsetAt.push(i);
      spaced = isSpace;
    }
  }
  breaks.push(text.length);
  return { text, lower: text.toLowerCase(), nodes, nodeAt, offsetAt, breaks };
}

// --- marking ----------------------------------------------------------------

const MARK_STYLES = `
  ::highlight(aalto-find) { background: rgba(245, 217, 168, 0.75); color: inherit; }
  ::highlight(aalto-find-current) { background: #f0a36b; color: #1a1915; }
  ::highlight(aalto-section) { background: rgba(240, 163, 107, 0.35); }
`;

/**
 * CSS Highlights rather than wrapping matches in <mark>: editing the DOM of a
 * page we do not own breaks React reconciliation and can lose the user's place.
 */
function mark(name, ranges) {
  if (typeof Highlight !== "function" || !CSS.highlights) return;
  if (!document.getElementById("aalto-mark-styles")) {
    const style = document.createElement("style");
    style.id = "aalto-mark-styles";
    style.textContent = MARK_STYLES;
    document.head.append(style);
  }
  if (ranges.length === 0) CSS.highlights.delete(name);
  else CSS.highlights.set(name, new Highlight(...ranges));
}

function rangeOver(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  return range;
}
// AALTO:PAGENAV-END

/** React-controlled inputs ignore plain `.value =`; dispatch real events too. */
function setNativeValue(element, value) {
  const proto =
    element.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
  setter.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

// --- finding fields ---------------------------------------------------------

function isVisible(el) {
  if (!el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none";
}

function textOf(el) {
  return (el?.innerText ?? el?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** Six strategies, in descending order of how much the page meant them. */
function labelFor(el) {
  const by = el.getAttribute?.("aria-labelledby");
  if (by) {
    const text = by
      .split(/\s+/)
      .map((id) => textOf(document.getElementById(id)))
      .filter(Boolean)
      .join(" ");
    if (text) return text;
  }

  const aria = el.getAttribute?.("aria-label");
  if (aria?.trim()) return aria.trim();

  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit) return textOf(explicit);
  }

  const wrapping = el.closest?.("label");
  if (wrapping) {
    const text = textOf(wrapping);
    if (text) return text;
  }

  // Google Forms and anything else that builds questions out of ARIA roles.
  const item = el.closest?.('[role="listitem"], fieldset, .form-group, [data-question]');
  if (item) {
    const heading = item.querySelector('[role="heading"], legend, label');
    const text = textOf(heading);
    if (text) return text;
  }

  const placeholder = el.getAttribute?.("placeholder");
  if (placeholder?.trim()) return placeholder.trim();

  return "";
}

/** The group a set of radios or checkboxes belongs to, for a shared label. */
function groupKey(el) {
  const group = el.closest?.('[role="radiogroup"], fieldset, [role="listitem"]');
  if (group) return group;
  if (el.name) return `name:${el.name}`;
  return el;
}

/** Returning behaviour rather than elements lets fill, review and read-back
 *  share one notion of what a field is. */
function collectFields() {
  const controls = Array.from(
    document.querySelectorAll(
      `input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]),
       textarea, select, [contenteditable="true"],
       [role="radio"], [role="checkbox"], [role="listbox"], [role="combobox"]`
    )
  ).filter(isVisible);

  /** @type {Map<any, {label: string, kind: string, els: Element[]}>} */
  const groups = new Map();

  for (const el of controls) {
    const nativeType = el.tagName === "INPUT" ? el.type.toLowerCase() : "";
    const role = el.getAttribute("role");
    const isChoice =
      nativeType === "radio" ||
      nativeType === "checkbox" ||
      role === "radio" ||
      role === "checkbox";

    const key = isChoice ? groupKey(el) : el;
    const kind = isChoice
      ? nativeType === "checkbox" || role === "checkbox"
        ? "multi"
        : "choice"
      : el.tagName === "SELECT" || role === "listbox" || role === "combobox"
        ? "select"
        : nativeType === "date"
          ? "date"
          : "text";

    if (!groups.has(key)) {
      const container = typeof key === "object" && key.nodeType ? key : el;
      groups.set(key, {
        label: labelFor(isChoice ? container : el) || labelFor(el),
        kind,
        els: [],
      });
    }
    groups.get(key).els.push(el);
  }

  return Array.from(groups.values())
    .filter((g) => g.label)
    .map((g) => makeField(g));
}

function optionsOf(els) {
  return els.map((el) => ({ el, text: labelForOption(el) })).filter((o) => o.text);
}

function labelForOption(el) {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  const wrapping = el.closest("label");
  if (wrapping) return textOf(wrapping);
  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit) return textOf(explicit);
  }
  return el.value || textOf(el);
}

function isTicked(el) {
  return el.getAttribute("role") ? el.getAttribute("aria-checked") === "true" : el.checked;
}

function makeField({ label, kind, els }) {
  const primary = els[0];

  return {
    label,
    kind,

    read() {
      if (kind === "choice" || kind === "multi") {
        const ticked = optionsOf(els).filter((o) => isTicked(o.el));
        return ticked.map((o) => o.text).join(", ");
      }
      if (primary.tagName === "SELECT") {
        const chosen = primary.selectedOptions[0];
        // The first option is usually a "Choose..." placeholder; reading it
        // back would claim they had filled in something they had not.
        return chosen && primary.selectedIndex > 0 ? chosen.text.trim() : "";
      }
      if (primary.isContentEditable) return primary.innerText.trim();
      if (primary.value !== undefined) return String(primary.value).trim();
      const chosen = textOf(primary);
      return /^(choose|select)$/i.test(chosen) ? "" : chosen;
    },

    write(value) {
      if (kind === "choice") {
        const options = optionsOf(els);
        const match = bestOption(options, value);
        // The refusal is the point: selecting the first option on no match
        // puts a wrong answer into a form nobody agreed to, invisibly.
        if (!match) {
          return {
            ok: false,
            error: `"${value}" doesn't match any option for "${label}". The options are: ${options
              .map((o) => o.text)
              .join(", ")}. Ask them which they meant.`,
          };
        }
        match.el.click();
        return { ok: true, detail: `chose "${match.text}" for "${label}"` };
      }

      if (kind === "multi") {
        const options = optionsOf(els);
        const wanted = value
          .split(/,| and /)
          .map((v) => v.trim())
          .filter(Boolean);
        const chosen = [];
        for (const want of wanted) {
          const match = bestOption(options, want);
          if (match && !chosen.includes(match) && !isTicked(match.el)) {
            match.el.click();
            chosen.push(match);
          }
        }
        if (chosen.length === 0) {
          return {
            ok: false,
            error: `"${value}" doesn't match any option for "${label}". The options are: ${options
              .map((o) => o.text)
              .join(", ")}.`,
          };
        }
        return {
          ok: true,
          detail: `ticked ${chosen.map((c) => c.text).join(", ")} for "${label}"`,
        };
      }

      if (kind === "select") {
        if (primary.tagName === "SELECT") {
          const options = Array.from(primary.options).map((o) => ({ el: o, text: o.text.trim() }));
          const match = bestOption(options, value);
          if (!match) {
            return {
              ok: false,
              error: `"${value}" isn't one of the choices for "${label}". They are: ${options
                .map((o) => o.text)
                .join(", ")}.`,
            };
          }
          primary.value = match.el.value;
          primary.dispatchEvent(new Event("change", { bubbles: true }));
          return { ok: true, detail: `chose "${match.text}" for "${label}"` };
        }

        // An ARIA listbox must be opened before its options exist.
        primary.click();
        const options = optionsOf(
          Array.from(document.querySelectorAll('[role="option"]')).filter(isVisible)
        );
        const match = bestOption(options, value);
        if (!match) {
          primary.click(); // close it rather than leaving the menu hanging open
          return { ok: false, error: `"${value}" isn't one of the choices for "${label}"` };
        }
        match.el.click();
        return { ok: true, detail: `chose "${match.text}" for "${label}"` };
      }

      if (kind === "date") {
        const iso = toIsoDate(value);
        if (!iso) return { ok: false, error: `couldn't read "${value}" as a date` };
        setNativeValue(primary, iso);
        return { ok: true, detail: `set "${label}" to ${iso}` };
      }

      if (primary.isContentEditable) {
        primary.textContent = value;
        primary.dispatchEvent(new InputEvent("input", { bubbles: true }));
      } else {
        setNativeValue(primary, value);
      }
      return { ok: true, detail: `filled "${label}" with "${value}"` };
    },
  };
}

// --- form tools -------------------------------------------------------------

function fillField(spokenLabel, value) {
  const fields = collectFields();
  if (fields.length === 0) return { ok: false, error: "there are no fields on this page" };

  const scored = fields
    .map((f) => ({ field: f, score: similarity(spokenLabel, f.label) }))
    .sort((a, b) => b.score - a.score);

  if (scored[0].score < FIELD_THRESHOLD) {
    return {
      ok: false,
      error: `nothing on this page matches "${spokenLabel}". The fields are: ${fields
        .map((f) => f.label)
        .join(", ")}.`,
    };
  }
  return scored[0].field.write(value);
}

/** Phrased for the ear: "blank" has to be said out loud, because silence where
 *  an answer should be sounds like the sentence having ended. */
function reviewForm() {
  const fields = collectFields();
  if (fields.length === 0) return { ok: false, error: "there's no form on this page to read back" };

  const spoken = fields.map((f) => `${f.label}: ${f.read() || "blank"}`).join(". ");
  return { ok: true, detail: `Here's what the form says. ${spoken}` };
}

const SUBMIT_WORDS = /^(submit|send|continue|confirm|finish|save|next|apply|register|sign up)$/;

function submitForm() {
  const candidates = Array.from(
    document.querySelectorAll('button, input[type="submit"], [role="button"]')
  ).filter(isVisible);

  const explicit = candidates.find((b) => b.type === "submit" && b.tagName !== "INPUT");
  const byText = candidates.find((b) => SUBMIT_WORDS.test(normalize(b.value || textOf(b))));
  const button = byText ?? explicit ?? candidates.find((b) => b.type === "submit");

  if (!button) return { ok: false, error: "I can't find a submit button on this page" };
  button.click();
  return { ok: true, detail: "submitted it" };
}
