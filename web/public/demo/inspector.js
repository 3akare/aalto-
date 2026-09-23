/**
 * What makes the agent legible. Without it a voice demo is a box that talks and
 * you take on trust that anything happened.
 */

const said = document.getElementById("said");
const replied = document.getElementById("replied");
const calls = document.getElementById("calls");

/** The panel scrolls, so trimming loses nothing visible - but hundreds of rows
 *  all get re-laid-out on every new call. Well past what anyone scrolls back. */
const MAX_ROWS = 60;

let seq = 0;

/**
 * Keep the newest call visible without hijacking the scrollbar. Two things move
 * the list: a new row, and the transcript above growing. Pin after either - but
 * only if the reader was already at the bottom.
 */
const PIN_SLACK = 40;

function isPinned() {
  // Empty starts pinned: otherwise a tall placeholder in a short panel reads as
  // "scrolled up" and the first call turns following off for the session.
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
    // The result changes the row's height, so pin again.
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
