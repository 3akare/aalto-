/**
 * The agent's hands on the page.
 *
 * This runs on every site, not just Google Forms as its predecessor did. The
 * matching half is unchanged and deliberately so - the containment-biased
 * similarity, the stopword list, the stem-prefix credit, the date parsing and
 * above all the option guard that refuses to pick the first radio when nothing
 * matches all came out of real debugging and none of it was ever specific to
 * one site.
 *
 * What did change is discovery. Google Forms hides its structure behind
 * role="listitem" and role="heading", so the old version read those directly.
 * An arbitrary page has no such convention, so fields are found by their actual
 * controls and a label is derived per control, trying each of the six ways a
 * page can name an input before giving up.
 *
 * Kept as a classic script rather than a module: chrome.scripting.executeScript
 * injects files, not module graphs, and on-demand injection is what keeps this
 * working in tabs that were already open when the extension reloaded.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
    case "insert_text":
      return insertText(args.text, args.mode);
    case "copy_to_clipboard":
      return copyToClipboard(args.text);
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

/**
 * Text the agent can answer from.
 *
 * Capped because the whole point is one spoken sentence back, and a sprawling
 * page costs latency on every turn for context nobody will hear.
 */
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

/**
 * Show where an answer came from.
 *
 * Uses a CSS Highlight rather than wrapping the match in a <mark>: editing the
 * DOM of a page the extension does not own breaks React reconciliation, and on
 * a page with its own text selection logic it can lose the user's place.
 */
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

function focusedEditable() {
  const el = document.activeElement;
  if (!el) return null;
  if (el.isContentEditable) return el;
  if (el.tagName === "TEXTAREA") return el;
  if (el.tagName === "INPUT" && !/^(checkbox|radio|button|submit|file)$/i.test(el.type)) return el;
  return null;
}

function contentsOf(el) {
  return el.isContentEditable ? el.innerText.trim() : el.value;
}

function insertText(text, mode = "append") {
  const el = focusedEditable();
  if (!el) {
    return { ok: false, error: "they need to click into a text box first - nothing is focused" };
  }

  const existing = contentsOf(el);
  // A space between sentences, but not a leading one into an empty box.
  const next = mode === "replace" || !existing ? text : `${existing} ${text}`;

  if (el.isContentEditable) {
    el.textContent = next;
    el.dispatchEvent(new InputEvent("input", { bubbles: true }));
  } else {
    setNativeValue(el, next);
  }
  return { ok: true, detail: mode === "replace" ? "rewrote it" : "typed it in" };
}

function copyToClipboard(text) {
  // Fire and forget: the clipboard promise resolves after this handler has
  // already replied, and a failure here is not worth holding the agent up for.
  navigator.clipboard?.writeText(text).catch(() => {});
  return { ok: true, detail: "copied it to their clipboard" };
}

// --- matching ---------------------------------------------------------------

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
 * Containment-biased token overlap.
 *
 * Dividing by the LARGER token set meant a spoken "name" against "What is your
 * full legal name?" scored 0.17 and fell under the threshold - short spoken
 * labels failed against verbose questions as a rule. Dividing by the smaller
 * set asks the right question: is what they said contained in this question?
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

/** Pick the option whose text best matches the spoken value, or null if none is close. */
function bestOption(options, value) {
  const scored = options
    .map((o) => ({ ...o, score: similarity(value, o.text) }))
    .sort((x, y) => y.score - x.score);
  return scored.length > 0 && scored[0].score >= 0.5 ? scored[0] : null;
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
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return null;
}

/** React-controlled inputs ignore plain `.value =` assignment; dispatch real events too. */
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

const TEXTLIKE = "text,email,tel,url,search,number,password,date,month,week,time,datetime-local";

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

/**
 * Work out what a control is called.
 *
 * Six strategies in descending order of how much the page meant them. Google
 * Forms lands on the role="listitem" branch, which is the whole of what the
 * previous version knew how to do; an ordinary page usually lands on one of
 * the first three.
 */
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

/**
 * Every field on the page, each able to read and write itself.
 *
 * Returning behaviour rather than elements is what lets fill, review and the
 * read-back share one notion of what a field is - the alternative is three
 * near-identical switch statements that drift apart.
 */
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
        // A select's first option is usually a "Choose..." placeholder, and
        // reading that back as an answer would tell the user they had filled
        // in something they had not.
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
        // This refusal is the point. The previous behaviour selected the first
        // option when nothing matched and then reported failure, which put a
        // wrong answer into a form nobody had agreed to - worse than doing
        // nothing, and invisible until it was submitted.
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

        // An ARIA listbox has to be opened before its options exist in the DOM.
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

  if (scored[0].score < 0.34) {
    return {
      ok: false,
      error: `nothing on this page matches "${spokenLabel}". The fields are: ${fields
        .map((f) => f.label)
        .join(", ")}.`,
    };
  }
  return scored[0].field.write(value);
}

/**
 * Read the whole form back.
 *
 * Phrased for the ear rather than the screen: someone checking a form by
 * listening needs to hear "blank" said out loud, because silence where an
 * answer should be sounds exactly like the sentence having ended.
 */
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
