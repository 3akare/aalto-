/**
 * Moving around a page: scrolling, jumping to a section, finding words.
 *
 * Shared by the extension's content script and the web demo's sandbox, so it
 * takes a root to work within and assumes nothing else about the page. The
 * content script gets it spliced in by `npm run sync-shared`, like matching.js.
 */

import { similarity } from "./matching.js";

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

export function scrollPage(direction, amount = "page", scope = null) {
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

export function goToSection(section, root = document.body, container = null) {
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
export function findOnPage({ query, step } = {}, root = document.body, container = null) {
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
