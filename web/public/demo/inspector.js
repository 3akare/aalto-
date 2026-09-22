/**
 * The panel that makes the agent legible.
 *
 * A voice demo without this is a box that talks: a judge hears a sentence and
 * has to take on trust that anything happened. Every tool call showing up as it
 * is made, with its arguments and what came back, is the difference between
 * "that sounded nice" and "I can see what it did".
 */

const said = document.getElementById("said");
const replied = document.getElementById("replied");
const calls = document.getElementById("calls");

/**
 * How many calls stay in the DOM.
 *
 * The panel scrolls, so nothing is lost visually by trimming - but a session
 * that runs for several minutes would otherwise leave hundreds of rows in the
 * document, and every one of them is re-laid-out each time a new call scrolls
 * the list. Well past what anyone scrolls back through.
 */
const MAX_ROWS = 60;

let seq = 0;

/**
 * Keep the newest call visible, without hijacking the scrollbar.
 *
 * Two things move the list: a new row arriving, and the transcript above it
 * growing, which shrinks the list's height and quietly slides it off the
 * bottom. Both are handled by pinning after the fact - but only when the reader
 * was already at the bottom, because yanking them back down while they are
 * scrolled up reading an earlier call is worse than letting it drift.
 */
const PIN_SLACK = 40;

function isPinned() {
  // An empty list starts pinned. Otherwise a tall placeholder in a short panel
  // reads as "scrolled up", and the very first call would turn following off
  // for the whole session.
  if (calls.children.length === 0) return true;
  return calls.scrollHeight - calls.scrollTop - calls.clientHeight <= PIN_SLACK;
}

function pin(wasPinned) {
  if (!wasPinned) return;
  calls.scrollTop = calls.scrollHeight;
}

export function heard(text) {
  const wasPinned = isPinned();
  said.textContent = text ? `“${text}”` : "";
  pin(wasPinned);
}

export function spoke(text) {
  const wasPinned = isPinned();
  replied.textContent = text ?? "";
  pin(wasPinned);
}

export function clear() {
  calls.replaceChildren();
  heard("");
  spoke("");
}

/** Add a row for a call that has just started, and hand back a way to finish it. */
export function beginCall(name, args) {
  const started = performance.now();
  const wasPinned = isPinned();
  const row = document.createElement("li");
  row.className = "call running";
  row.id = `call-${++seq}`;

  const title = document.createElement("div");
  title.className = "name";
  title.textContent = name;

  const ms = document.createElement("span");
  ms.className = "ms";
  title.prepend(ms);

  const argLine = document.createElement("div");
  argLine.className = "args";
  argLine.textContent = summarise(args);

  const outcome = document.createElement("div");
  outcome.className = "outcome";

  row.append(title, argLine, outcome);
  calls.append(row);
  while (calls.children.length > MAX_ROWS) calls.firstElementChild.remove();
  pin(wasPinned);

  return (status, detail) => {
    const stillPinned = isPinned();
    row.className = `call ${status}`;
    ms.textContent = `${Math.round(performance.now() - started)}ms`;
    outcome.textContent = detail;
    // The result lands after the row exists, so it changes the row's height -
    // pin again or the newest call sits half off the bottom edge.
    pin(stillPinned);
  };
}

export function interrupted() {
  const row = calls.lastElementChild;
  if (row?.classList.contains("running")) {
    row.className = "call refused";
    row.querySelector(".outcome").textContent = "interrupted";
  }
}

function summarise(args) {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return "no arguments";
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("  ");
}
