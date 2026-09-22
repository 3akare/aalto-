/**
 * Executing a tool call against the sandbox.
 *
 * This file, and sandbox.js beneath it, are the entirety of what differs from
 * the extension. Everything above - the tool definitions, the system prompt,
 * the protocol client and its result queue - is the shipped code, loaded from
 * the same shared/ directory. The contract the agent is programmed against is
 * identical; only the hands are different.
 */

import { FIELD_THRESHOLD, similarity } from "../vendor/shared/matching.js";
import * as sandbox from "./sandbox/sandbox.js";

/**
 * The read-back guard, kept here rather than in the prompt.
 *
 * A prompt can be argued out of a rule. A conditional cannot, which is why a
 * judge can tell the agent to just submit it and watch it decline.
 */
/**
 * Ordered by a counter rather than by Date.now(): several fills and a read-back
 * all land inside the same millisecond, which made "reviewed after filled" read
 * as false and refused a form that HAD just been read back.
 */
let clock = 0;
let filledAt = 0;
let reviewedAt = 0;

export function resetGuard() {
  clock = 0;
  filledAt = 0;
  reviewedAt = 0;
}

export async function runTool(name, args) {
  switch (name) {
    case "answer":
      return args.text ?? "";

    case "clarify":
      return args.question ?? "";

    // --- reading ------------------------------------------------------------

    case "read_text": {
      if (args.source === "selection") {
        const selected = String(window.getSelection() ?? "").trim();
        if (!selected) throw new Error("nothing is selected");
        return selected;
      }
      if (args.source === "field") throw new Error("nothing is focused in the demo");
      return sandbox.readPage();
    }

    case "highlight":
      if (!sandbox.highlight(args.quote)) throw new Error("couldn't find that wording on the page");
      return "highlighted it on the page";

    // --- the form -----------------------------------------------------------

    case "fill_field": {
      const fields = sandbox.collectFields();
      const scored = fields
        .map((f) => ({ f, score: similarity(args.label, f.label) }))
        .sort((a, b) => b.score - a.score);

      if (!scored[0] || scored[0].score < FIELD_THRESHOLD) {
        throw new Error(
          `nothing on this page matches "${args.label}". The fields are: ${fields
            .map((f) => f.label)
            .join(", ")}.`
        );
      }
      const outcome = scored[0].f.write(args.value);
      if (!outcome.ok) throw new Error(outcome.error);
      filledAt = ++clock;
      return outcome.detail;
    }

    case "review_form": {
      sandbox.show("form");
      const spoken = sandbox
        .collectFields()
        // "blank" said out loud, because silence where an answer should be
        // sounds exactly like the sentence having ended.
        .map((f) => `${f.label}: ${f.read() || "blank"}`)
        .join(". ");
      reviewedAt = ++clock;
      return `Here's what the form says. ${spoken}`;
    }

    case "submit_form": {
      if (reviewedAt === 0 || reviewedAt < filledAt) {
        throw new Error(
          "I haven't read this form back to them yet, so I can't submit it. " +
            "Call review_form first, then ask them to confirm."
        );
      }
      sandbox.submitForm();
      resetGuard();
      return "submitted it";
    }

    // --- writing ------------------------------------------------------------

    case "insert_text":
      // The sandbox has no free-text surface other than the form, and putting
      // dictation into a form field without being asked would be worse than
      // saying so.
      throw new Error(
        "there's no text box focused in this demo - in the extension this types " +
          "into whatever box they're in on any site"
      );

    case "copy_to_clipboard":
      await navigator.clipboard?.writeText(args.text).catch(() => {});
      return "copied it to their clipboard";

    // --- tabs ---------------------------------------------------------------

    case "switch_tab": {
      const tab = sandbox.findTab(args.description);
      if (!tab) throw new Error(`nothing open matches "${args.description}"`);
      sandbox.show(tab.id);
      return `switched to ${tab.title}`;
    }

    case "list_tabs":
      return `open tabs: ${sandbox.listTabs().join("; ")}`;

    case "open_url":
      sandbox.noteOpened(args.url);
      return `opened ${args.url} in a tab behind this one. (In the demo that tab is simulated; the installed extension opens it for real.)`;

    case "search_web":
      sandbox.noteOpened(`search: ${args.query}`);
      return `searched for "${args.query}" in a tab behind this one. (Simulated in the demo.)`;

    case "close_tabs": {
      const closed = sandbox.closeOpened(args.description);
      if (closed === 0) throw new Error(`nothing matching "${args.description}" is open`);
      return `closed ${closed} tab${closed === 1 ? "" : "s"}`;
    }

    // --- tasks --------------------------------------------------------------

    case "save_macro":
    case "run_macro":
    case "list_macros":
      return "saved sequences only work in the installed extension, not in this demo";

    default:
      throw new Error(`${name} isn't available in this demo`);
  }
}
