/**
 * The browser inside the page.
 *
 * Three tabs, real DOM, real inputs. The agent's tools act on this the same way
 * the extension's act on a live page - the difference is confined to this file
 * and tool-executor.js, and everything above them, including the tool
 * definitions and the protocol client, is the code that ships.
 */

import {
  bestOption,
  FIELD_THRESHOLD,
  similarity,
  toIsoDate,
} from "../../vendor/shared/matching.js";

const viewport = document.getElementById("viewport");
const tabstrip = document.getElementById("tabstrip");
const address = document.getElementById("address");

const pages = Array.from(viewport.querySelectorAll("[data-page]")).map((el) => ({
  id: el.dataset.page,
  title: el.dataset.title,
  url: el.dataset.url,
  el,
}));

let activeId = pages[0].id;
let opened = []; // pages the agent opened this session, for close_tabs

// --- tabs -------------------------------------------------------------------

export function renderTabs() {
  tabstrip.replaceChildren();
  for (const page of pages) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tab";
    tab.role = "tab";
    tab.textContent = page.title;
    tab.setAttribute("aria-selected", String(page.id === activeId));
    tab.addEventListener("click", () => show(page.id));
    tabstrip.append(tab);
  }
  address.textContent = pages.find((p) => p.id === activeId)?.url ?? "";
}

export function show(id) {
  if (!pages.some((p) => p.id === id)) return false;
  activeId = id;
  for (const page of pages) page.el.hidden = page.id !== id;
  renderTabs();
  return true;
}

export function activePage() {
  return pages.find((p) => p.id === activeId);
}

export function listTabs() {
  return pages.map((p) => p.title);
}

/**
 * Find a tab the way someone would describe it out loud.
 *
 * The same similarity function the form fields use, because "the form one" and
 * "phone number" are the same kind of guess at the same kind of label.
 */
export function findTab(description) {
  const desc = (description ?? "").toLowerCase();
  if (desc.includes("next") || desc.includes("previous") || desc.includes("back")) {
    const idx = pages.findIndex((p) => p.id === activeId);
    const step = desc.includes("next") ? 1 : -1;
    return pages[(idx + step + pages.length) % pages.length];
  }
  // Scored against the id as well as the title, because people say "the form"
  // and "the article", not "Register a business name".
  const scored = pages
    .map((p) => ({
      p,
      score: Math.max(similarity(desc, p.title), similarity(desc, p.url), similarity(desc, p.id)),
    }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.score >= FIELD_THRESHOLD ? scored[0].p : null;
}

export function noteOpened(url) {
  opened.push(url);
  return opened.length;
}

export function openedTabs() {
  return opened;
}

export function closeOpened(description) {
  const before = opened.length;
  opened = opened.filter((u) => !similarity(description, u));
  return before - opened.length;
}

// --- the page's text --------------------------------------------------------

export function readPage() {
  const page = activePage();
  return `${page.title}\n\n${page.el.innerText.replace(/\n{3,}/g, "\n\n").trim()}`;
}

export function highlight(quote) {
  const needle = (quote ?? "").trim().toLowerCase();
  if (!needle) return false;

  const walker = document.createTreeWalker(activePage().el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const idx = node.textContent.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const range = document.createRange();
    range.setStart(node, idx);
    range.setEnd(node, idx + needle.length);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    node.parentElement?.scrollIntoView({ behavior: "smooth", block: "center" });
    return true;
  }
  return false;
}

// --- the form ---------------------------------------------------------------

function labelOf(el) {
  if (el.id) {
    const explicit = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (explicit) return explicit.textContent.trim();
  }
  const group = el.closest("fieldset");
  if (group) return group.querySelector(".legend")?.textContent.trim() ?? "";
  return el.closest("label")?.textContent.trim() ?? "";
}

/** Draw attention to what just changed, so a spoken action has a visible effect. */
function flash(el) {
  const target = el.closest(".field") ?? el;
  target.classList.remove("just-changed");
  void target.offsetWidth; // restart the animation rather than ignoring a repeat
  target.classList.add("just-changed");
}

export function collectFields() {
  const form = document.querySelector('[data-page="form"]');
  const groups = new Map();

  for (const el of form.querySelectorAll("input, select")) {
    const key = el.name || el.id;
    if (!groups.has(key)) groups.set(key, { label: labelOf(el), els: [] });
    groups.get(key).els.push(el);
  }

  return Array.from(groups.values())
    .filter((g) => g.label)
    .map(({ label, els }) => ({ label, ...fieldOps(label, els) }));
}

function fieldOps(label, els) {
  const first = els[0];
  const type = first.tagName === "SELECT" ? "select" : first.type;

  const options = () => els.map((el) => ({ el, text: el.value }));

  return {
    read() {
      if (type === "radio" || type === "checkbox") {
        return els
          .filter((e) => e.checked)
          .map((e) => e.value)
          .join(", ");
      }
      if (type === "select") return first.selectedIndex > 0 ? first.value : "";
      return first.value.trim();
    },

    write(value) {
      if (type === "radio") {
        const match = bestOption(options(), value);
        // The guard. Nothing is selected unless the user actually said it.
        if (!match) {
          return {
            ok: false,
            error: `"${value}" doesn't match any option for "${label}". The options are: ${els
              .map((e) => e.value)
              .join(", ")}. Ask them which they meant.`,
          };
        }
        match.el.checked = true;
        flash(match.el);
        return { ok: true, detail: `chose "${match.el.value}" for "${label}"` };
      }

      if (type === "checkbox") {
        const wanted = value
          .split(/,| and /)
          .map((v) => v.trim())
          .filter(Boolean);
        const ticked = [];
        for (const want of wanted) {
          const match = bestOption(options(), want);
          if (match && !match.el.checked) {
            match.el.checked = true;
            flash(match.el);
            ticked.push(match.el.value);
          }
        }
        if (ticked.length === 0) {
          return { ok: false, error: `"${value}" doesn't match any option for "${label}"` };
        }
        return { ok: true, detail: `ticked ${ticked.join(", ")} for "${label}"` };
      }

      if (type === "select") {
        const opts = Array.from(first.options)
          .slice(1)
          .map((o) => ({ el: o, text: o.text }));
        const match = bestOption(opts, value);
        if (!match) {
          return {
            ok: false,
            error: `"${value}" isn't one of the choices for "${label}". They are: ${opts
              .map((o) => o.text)
              .join(", ")}.`,
          };
        }
        first.value = match.el.value;
        flash(first);
        return { ok: true, detail: `chose "${match.el.text}" for "${label}"` };
      }

      if (type === "date") {
        const iso = toIsoDate(value);
        if (!iso) return { ok: false, error: `couldn't read "${value}" as a date` };
        first.value = iso;
        flash(first);
        return { ok: true, detail: `set "${label}" to ${iso}` };
      }

      first.value = value;
      flash(first);
      return { ok: true, detail: `filled "${label}" with "${value}"` };
    },
  };
}

export function submitForm() {
  document.getElementById("f-done").hidden = false;
  document.getElementById("f-submit").disabled = true;
  return true;
}

export function addTask(text) {
  const li = document.createElement("li");
  li.textContent = text;
  document.getElementById("tasks-list").append(li);
  flash(li);
  return true;
}
