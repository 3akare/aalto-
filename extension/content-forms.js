// Runs on docs.google.com/forms/* pages. Google Forms doesn't expose <label for="">
// binding cleanly, so we match on the question's rendered heading text within each
// question container (role="listitem") instead.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "LIST_FIELDS") {
    sendResponse({ ok: true, labels: listQuestionLabels() });
    return false;
  }
  if (message.type === "READ_FIELDS") {
    sendResponse({ ok: true, fields: readFields() });
    return false;
  }
  if (message.type !== "FORM_ACTION") return false;

  try {
    if (message.action.tool === "fill_form_field") {
      sendResponse(fillField(message.action.input.fieldLabel, message.action.input.value));
    } else if (message.action.tool === "submit_form") {
      sendResponse(submitForm());
    } else {
      sendResponse({ ok: false, error: `unknown form action ${message.action.tool}` });
    }
  } catch (err) {
    console.error("[Aalto] form action error:", err);
    sendResponse({ ok: false, error: String(err) });
  }
  return true;
});

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
 * Dividing by the LARGER token set (the previous behaviour) meant a spoken "name"
 * against "What is your full legal name?" scored 0.17 and fell under the 0.3
 * threshold - short spoken labels failed against verbose questions as a rule.
 * Dividing by the smaller set asks the right question: is what they said
 * contained in this question?
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

function getQuestionContainers() {
  return Array.from(document.querySelectorAll('[role="listitem"]'));
}

function headingOf(container) {
  const heading = container.querySelector('[role="heading"]');
  return heading ? heading.textContent.trim() : "";
}

/** Question text for every field on the page, sent up so the planner targets real fields. */
function listQuestionLabels() {
  return getQuestionContainers().map(headingOf).filter(Boolean);
}

/**
 * Every question and whatever is currently entered against it.
 *
 * This is what makes review-before-submit possible: someone filling a government
 * form by voice has no way to check what actually landed in each field unless it
 * is read back to them.
 */
function readFields() {
  return getQuestionContainers()
    .map((container) => {
      const label = headingOf(container);
      return label ? { label, value: currentValue(container) } : null;
    })
    .filter(Boolean);
}

/** The entered value for one question, or "" when it is still blank. */
function currentValue(container) {
  const text = container.querySelector('input[type="text"], input[type="date"], textarea');
  if (text) return text.value.trim();

  const radio = container.querySelector('[role="radio"][aria-checked="true"]');
  if (radio) return (radio.getAttribute("aria-label") || "").trim();

  const ticked = Array.from(container.querySelectorAll('[role="checkbox"][aria-checked="true"]'))
    .map((c) => (c.getAttribute("aria-label") || "").trim())
    .filter(Boolean);
  if (ticked.length > 0) return ticked.join(", ");

  const listbox = container.querySelector('[role="listbox"]');
  if (listbox) {
    const chosen = (listbox.getAttribute("aria-label") || listbox.textContent || "").trim();
    // Google renders the placeholder as the label until something is picked.
    return /^(choose|select)$/i.test(chosen) ? "" : chosen;
  }
  return "";
}

function findBestMatchingQuestion(spokenLabel) {
  const scored = getQuestionContainers()
    .map((container) => ({ container, text: headingOf(container) }))
    .filter((c) => c.text)
    .map((c) => ({ ...c, score: similarity(spokenLabel, c.text) }))
    .sort((x, y) => y.score - x.score);

  if (scored.length === 0 || scored[0].score < 0.34) return { container: null, candidates: scored };
  return { container: scored[0].container, label: scored[0].text, candidates: scored };
}

function fillField(fieldLabel, value) {
  const { container, label } = findBestMatchingQuestion(fieldLabel);
  if (!container) {
    return { ok: false, error: `no question on this form matches "${fieldLabel}"` };
  }

  // Short text / paragraph text
  const textInput = container.querySelector('input[type="text"], textarea');
  if (textInput) {
    setNativeValue(textInput, value);
    return { ok: true, detail: `filled "${label}" with "${value}"` };
  }

  // Date fields - a conspicuous gap for civic forms, which are full of them.
  const dateInput = container.querySelector('input[type="date"]');
  if (dateInput) {
    const iso = toIsoDate(value);
    if (!iso) return { ok: false, error: `couldn't read "${value}" as a date` };
    setNativeValue(dateInput, iso);
    return { ok: true, detail: `set "${label}" to ${iso}` };
  }

  // Radios / single choice.
  const radios = Array.from(container.querySelectorAll('[role="radio"]'));
  if (radios.length > 0) {
    const match = bestOption(radios, value);
    // Previously this ran `(match ?? radios[0]).click()` - it selected the FIRST
    // option when nothing matched, then reported failure. That silently put a
    // wrong answer into a civic form, which is worse than doing nothing.
    if (!match) {
      const options = radios.map((r) => r.getAttribute("aria-label")).filter(Boolean);
      return {
        ok: false,
        error: `"${value}" doesn't match any option for "${label}" (${options.join(", ")})`,
      };
    }
    match.click();
    return { ok: true, detail: `chose "${match.getAttribute("aria-label")}" for "${label}"` };
  }

  // Checkboxes - the spoken value may list several.
  const checkboxes = Array.from(container.querySelectorAll('[role="checkbox"]'));
  if (checkboxes.length > 0) {
    const wanted = value
      .split(/,| and /)
      .map((v) => v.trim())
      .filter(Boolean);
    const chosen = [];
    for (const want of wanted) {
      const match = bestOption(checkboxes, want);
      if (match && !chosen.includes(match)) {
        match.click();
        chosen.push(match);
      }
    }
    if (chosen.length === 0) {
      return { ok: false, error: `"${value}" doesn't match any option for "${label}"` };
    }
    const names = chosen.map((c) => c.getAttribute("aria-label")).join(", ");
    return { ok: true, detail: `ticked ${names} for "${label}"` };
  }

  // Dropdowns.
  const listbox = container.querySelector('[role="listbox"]');
  if (listbox) {
    listbox.click();
    const options = Array.from(
      container.querySelectorAll('[role="option"], [role="listbox"] [data-value]')
    ).filter((o) => (o.textContent || "").trim());
    const match = bestOption(options, value, (o) => o.textContent);
    if (!match) {
      listbox.click(); // close it again rather than leaving the menu hanging open
      return { ok: false, error: `"${value}" isn't one of the choices for "${label}"` };
    }
    match.click();
    return { ok: true, detail: `chose "${match.textContent.trim()}" for "${label}"` };
  }

  return { ok: false, error: `found "${label}" but couldn't tell what kind of field it is` };
}

/** Pick the option whose text best matches the spoken value, or null if none is close. */
function bestOption(elements, value, textOf = (el) => el.getAttribute("aria-label")) {
  const scored = elements
    .map((el) => ({ el, text: (textOf(el) || "").trim() }))
    .filter((o) => o.text)
    .map((o) => ({ ...o, score: similarity(value, o.text) }))
    .sort((x, y) => y.score - x.score);
  return scored.length > 0 && scored[0].score >= 0.5 ? scored[0].el : null;
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

function submitForm() {
  const submitBtn = Array.from(document.querySelectorAll('[role="button"]')).find((b) =>
    normalize(b.textContent).includes("submit")
  );
  if (!submitBtn) return { ok: false, error: "couldn't find the submit button" };
  submitBtn.click();
  return { ok: true, detail: "submitted the form" };
}
