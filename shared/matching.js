/**
 * Matching a spoken phrase to a thing on the page - the fuzzy half of form
 * filling, shared by the extension's content script and the demo's sandbox.
 * Touches no DOM, which is why it can be shared at all.
 *
 * Every threshold here came out of watching it get something wrong.
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
 * Containment-biased token overlap. Dividing by the LARGER set meant a spoken
 * "name" against "What is your full legal name?" scored 0.17 and missed - short
 * labels failed against verbose questions as a rule. The smaller set asks the
 * right question: is what they said contained in this one?
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

/** Higher than the field threshold on purpose: naming the wrong field wastes a
 *  turn, picking the wrong option puts a wrong answer into a form. */
export const OPTION_THRESHOLD = 0.5;

/**
 * Best match, or null if nothing is close enough. Returning null rather than a
 * guess is the entire safety property: an earlier version fell back to the
 * first option, putting a wrong answer into a form nobody had agreed to.
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

  // Local parts, not toISOString(): local midnight converted to UTC moves back
  // a day for anyone east of Greenwich.
  const d = new Date(parsed);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
