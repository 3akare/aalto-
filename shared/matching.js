/**
 * Matching a spoken phrase to a thing on the page.
 *
 * The single source of truth for the fuzzy half of form filling, used by the
 * extension's content script and by the web demo's sandbox. None of it touches
 * the DOM, which is the reason it can be shared at all: the two have completely
 * different pages underneath and exactly the same problem on top.
 *
 * Every threshold and special case here came out of watching it get something
 * wrong. They are not tunable knobs, they are scar tissue.
 */

export const STOPWORDS = new Set([
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

export function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Mn}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenise(text) {
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
export function similarity(spoken, questionText) {
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
export const FIELD_THRESHOLD = 0.34;

/** How close a spoken value must be to count as naming an option. Higher on
 *  purpose: naming the wrong field wastes a turn, picking the wrong option puts
 *  a wrong answer into a form. */
export const OPTION_THRESHOLD = 0.5;

/**
 * Pick the option whose text best matches the spoken value, or null if none is
 * close enough.
 *
 * Returning null rather than a best guess is the entire safety property. An
 * earlier version fell back to the first option when nothing matched, which put
 * a wrong answer into a form nobody had agreed to and reported failure at the
 * same time - invisible until it was submitted.
 */
export function bestOption(options, value) {
  const scored = options
    .map((o) => ({ ...o, score: similarity(value, o.text) }))
    .sort((x, y) => y.score - x.score);
  return scored.length > 0 && scored[0].score >= OPTION_THRESHOLD ? scored[0] : null;
}

/** Accept "1990-04-12", "12/04/1990", and plain English like "12 April 1990". */
export function toIsoDate(value) {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;

  const dmy = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return null;

  // Built from the LOCAL parts, not toISOString(). Date.parse("12 April 1990")
  // gives local midnight; converting that to UTC moves it back a day for anyone
  // east of Greenwich, so a date of birth spoken aloud in Lagos was being
  // entered as the day before.
  const d = new Date(parsed);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
