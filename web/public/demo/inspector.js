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

let seq = 0;

export function heard(text) {
  said.textContent = text ? `“${text}”` : "";
}

export function spoke(text) {
  replied.textContent = text ?? "";
}

export function clear() {
  calls.replaceChildren();
  heard("");
  spoke("");
}

/** Add a row for a call that has just started, and hand back a way to finish it. */
export function beginCall(name, args) {
  const started = performance.now();
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
  calls.scrollTop = calls.scrollHeight;

  return (status, detail) => {
    row.className = `call ${status}`;
    ms.textContent = `${Math.round(performance.now() - started)}ms`;
    outcome.textContent = detail;
    calls.scrollTop = calls.scrollHeight;
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
