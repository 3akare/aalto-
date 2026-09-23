/**
 * The tool contract.
 *
 * This is the single source of truth for what Aalto can do. It is shipped
 * verbatim to AssemblyAI in `session.update`, and the same names are what the
 * dispatcher routes on. The extension and the web demo both execute against
 * this file - they differ only in the executor behind each name, which is why
 * the demo is a real exercise of the contract rather than a mock of it.
 *
 * Plain ESM with no build step, because an MV3 service worker and a static
 * assets directory both load it directly. `npm run sync-shared` copies it into
 * extension/shared/ and web/public/vendor/shared/.
 *
 * Shape is AssemblyAI's: a flat {type, name, description, parameters}. The
 * descriptions are not documentation - they are the only routing signal the
 * agent has, so they are written to be read by the model, in the imperative,
 * and they say when NOT to use a tool as often as when to.
 */

const obj = (properties, required = []) => ({ type: "object", properties, required });
const str = (description) => ({ type: "string", description });

/** @type {ReadonlyArray<{type:"function", name:string, description:string, parameters:object}>} */
export const AALTO_TOOLS = [
  // --- seeing what they see -------------------------------------------------
  {
    type: "function",
    name: "get_context",
    description:
      "See what the user is looking at right now. Returns the active tab (with its id), the " +
      "text box they are in and everything it contains, any text they have selected, and their " +
      "other open tabs with ids - marking the ones you opened. You cannot see the screen, so " +
      "call this FIRST whenever they point at something without naming it ('this', 'that', " +
      "'it', 'here', 'the text', 'the box', 'the tab', 'the new one') and before acting on a " +
      "tab or a text box. It is instant; never guess instead.",
    parameters: obj({}),
  },
  {
    type: "function",
    name: "read_text",
    description:
      "Read text from a page so you can answer from what is actually there rather than from " +
      "memory. Source 'page' reads the main text of a tab - the active one, or any other tab by " +
      "tab_id without switching to it (use this to read a tab you opened in the background). " +
      "'selection' reads what they have highlighted and 'field' the box they are typing in, both " +
      "on the active tab. get_context already includes the box and the selection, so you only " +
      "need 'field' or 'selection' when get_context says the text was cut short.",
    parameters: obj(
      {
        source: {
          type: "string",
          enum: ["page", "selection", "field"],
          description: "Which text to read.",
        },
        tab_id: {
          type: "integer",
          description: "Read this tab instead of the active one. Only for source 'page'.",
        },
      },
      ["source"]
    ),
  },
  {
    type: "function",
    name: "highlight",
    description:
      "Scroll to a passage on the active page and highlight it, so the user can see where an " +
      "answer came from. Use it straight after answering a question about the page they are on, " +
      "with the exact wording you based the answer on.",
    parameters: obj(
      { quote: str("A short exact phrase from the page - a few words is enough to locate it.") },
      ["quote"]
    ),
  },

  // --- moving around the page ----------------------------------------------
  {
    type: "function",
    name: "scroll_page",
    description:
      "Scroll the page they are on: 'scroll down', 'a bit more', 'go back up', 'to the top', " +
      "'to the bottom'. Returns how far down the page they now are, so you know when there is " +
      "nothing further to scroll to.",
    parameters: obj(
      {
        direction: { type: "string", enum: ["down", "up", "top", "bottom"] },
        amount: {
          type: "string",
          enum: ["small", "page", "large"],
          description: "'small' for 'a bit', 'page' by default, 'large' for 'a lot' or 'way down'.",
        },
      },
      ["direction"]
    ),
  },
  {
    type: "function",
    name: "go_to_section",
    description:
      "Jump to a part of the page by its heading: 'take me to pricing', 'go to the FAQ', 'the " +
      "part about returns'. If nothing matches it returns the sections the page does have, so " +
      "you can pick the right one or tell them what is there.",
    parameters: obj({ section: str("The section they asked for, in their words.") }, ["section"]),
  },
  {
    type: "function",
    name: "find_on_page",
    description:
      "Find words on the page they are on, like Ctrl+F. Highlights every match, scrolls to the " +
      "first, and returns how many there are with the sentence around each. Use it for 'find', " +
      "'where does it say', 'does this mention', and answer from the sentences it returns. For " +
      "'the next one' or 'the one before', call it with step and no query.",
    parameters: obj({
      query: str("The words to find - short and exact, like 'refund' or 'free trial'."),
      step: {
        type: "string",
        enum: ["next", "previous"],
        description: "Move through the matches of the last search instead of searching again.",
      },
    }),
  },

  // --- writing text ---------------------------------------------------------
  {
    type: "function",
    name: "insert_text",
    description:
      "Put text into the box the user is working in. Two jobs. (1) Dictation: they tell you " +
      "what to write - write what they MEANT, not a transcript: drop filler and false starts, " +
      "punctuate it, match the register of where it is going. Use mode 'append'. (2) Working " +
      "on their text: when they ask you to summarize, shorten, rewrite, fix, translate or " +
      "reformat 'this' or 'it' while in a box, take the text from get_context, do the work, " +
      "and put the result back with mode 'replace' - or 'replace_selection' if they had " +
      "selected only part of it. The result goes in the box; do not read it aloud unless asked. " +
      "Never change a number, unit, name or fact while rewriting: 'up four points' stays 'up " +
      "four points' (not percent), '$2.4M' stays '$2.4M'. Shorter means fewer words, not " +
      "different facts.",
    parameters: obj(
      {
        text: str("The finished text."),
        mode: {
          type: "string",
          enum: ["append", "replace", "replace_selection"],
          description:
            "'append' adds after what is there (dictation). 'replace' swaps the whole box for " +
            "this text. 'replace_selection' swaps only the part they have selected.",
        },
      },
      ["text"]
    ),
  },
  {
    type: "function",
    name: "copy_to_clipboard",
    description:
      "Put text on the user's clipboard. Use this when they ask for something 'to my " +
      "clipboard' or 'so I can paste it', or want a summary or rewrite they will place " +
      "themselves rather than have typed into a box.",
    parameters: obj({ text: str("The text to copy.") }, ["text"]),
  },

  // --- forms ----------------------------------------------------------------
  {
    type: "function",
    name: "fill_field",
    description:
      "Fill one field on the form the user is looking at, matched by its visible label. One " +
      "spoken sentence often fills several fields - call this once per field. If the value " +
      "they said does not match any of the available options, this tool will tell you so " +
      "rather than picking one; when that happens, ask them which they meant. Never invent a " +
      "value they did not say.",
    parameters: obj(
      {
        label: str("The visible label or question text of the field."),
        value: str("The value to enter, as the user gave it."),
      },
      ["label", "value"]
    ),
  },
  {
    type: "function",
    name: "review_form",
    description:
      "Read the whole form back - every question, with whatever is currently entered against " +
      "it, and 'blank' said out loud for the ones still empty. Use it whenever the user asks " +
      "what the form says, what they have filled in, or to check it over. It is also required " +
      "before the form can be submitted, so call it when they say they are done.",
    parameters: obj({}),
  },
  {
    type: "function",
    name: "submit_form",
    description:
      "Submit the form. Only ever call this when the user has explicitly asked to submit AND " +
      "you have already read the form back to them with review_form. Never chain it after " +
      "filling fields in the same turn - they have not heard what was entered yet. If they " +
      "ask you to fill something in and submit it, fill it, review it, and ask them to confirm.",
    parameters: obj({}),
  },

  // --- tabs -----------------------------------------------------------------
  {
    type: "function",
    name: "search_web",
    description:
      "Search the web and get the results back to read. Use it for anything current or local " +
      "you cannot state reliably - weather, news, prices, scores, times, opening hours, recent " +
      "events. It opens the search in a background tab, waits for it, and returns the text of " +
      "the results page plus the tab's id: read that and answer out loud in a sentence. The " +
      "answer is in what this returns, not on the page they are looking at. Set switch_to only " +
      "if they asked to see the results. For anything you simply know, just say it.",
    parameters: obj(
      {
        query: str("The search query."),
        switch_to: {
          type: "boolean",
          description: "Bring the results tab to the front. Only when they asked to see it.",
        },
      },
      ["query"]
    ),
  },
  {
    type: "function",
    name: "open_url",
    description:
      "Open a page in a new tab and take them to it - opening something is a request to see it. " +
      "Returns the tab's id and title. Set background only when they say 'in the background', " +
      "'for later' or 'behind this'.",
    parameters: obj(
      {
        url: str("The address to open."),
        background: {
          type: "boolean",
          description: "Keep the new tab behind the current one instead of switching to it.",
        },
      },
      ["url"]
    ),
  },
  {
    type: "function",
    name: "switch_tab",
    description:
      "Bring one of their open tabs to the front. Pass tab_id whenever you know it - from " +
      "get_context, or from the open_url or search_web call that opened it ('the tab you " +
      "opened', 'the new one', 'that tab' means the one you opened most recently). Otherwise " +
      "describe it the way they did: by site or topic, 'first', 'last', 'next' or 'previous'.",
    parameters: obj({
      tab_id: { type: "integer", description: "The id of the tab to switch to." },
      description: str("How they described it, when you do not have an id."),
    }),
  },
  {
    type: "function",
    name: "close_tabs",
    description:
      "Close tabs, by id or by description ('the youtube tabs', 'the tabs you opened'). " +
      "Closing cannot be undone from here, so if a description could catch something they " +
      "might not mean, ask them first and tell them how many it would close.",
    parameters: obj({
      tab_ids: { type: "array", items: { type: "integer" }, description: "Ids of tabs to close." },
      description: str("How they described them, when you do not have ids."),
    }),
  },

  // --- macros ---------------------------------------------------------------
  {
    type: "function",
    name: "save_macro",
    description:
      "Save the actions from this conversation under a name, so the user can ask for the same " +
      "sequence again later by saying the name. Use it when they say something like 'remember " +
      "that as my morning setup'.",
    parameters: obj({ name: str("The short name they gave it, lowercased.") }, ["name"]),
  },
  {
    type: "function",
    name: "run_macro",
    description:
      "Replay a sequence the user saved earlier, by name. If the name they said does not match " +
      "one that exists, call list_macros rather than guessing at the closest.",
    parameters: obj({ name: str("The name of the saved sequence.") }, ["name"]),
  },
  {
    type: "function",
    name: "list_macros",
    description: "List the sequences the user has saved, so they can be reminded what exists.",
    parameters: obj({}),
  },
];

/**
 * Where each tool runs.
 *
 * `page` tools are dispatched into the content script on the active tab and
 * touch the DOM. `browser` tools run in the service worker against the
 * chrome.* APIs.
 *
 * The web demo keeps the same split; only the executors differ.
 */
export const TOOL_TARGET = {
  get_context: "browser",
  read_text: "page",
  highlight: "page",
  scroll_page: "page",
  go_to_section: "page",
  find_on_page: "page",
  insert_text: "page",
  copy_to_clipboard: "page",
  fill_field: "page",
  review_form: "page",
  submit_form: "page",

  open_url: "browser",
  search_web: "browser",
  switch_tab: "browser",
  close_tabs: "browser",
  save_macro: "browser",
  run_macro: "browser",
  list_macros: "browser",
};

export const TOOL_NAMES = AALTO_TOOLS.map((t) => t.name);

/** Tools that change the page, and so must not race each other. */
export const MUTATING_PAGE_TOOLS = new Set([
  "fill_field",
  "submit_form",
  "insert_text",
  "copy_to_clipboard",
]);
