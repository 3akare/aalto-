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
  // --- speaking -------------------------------------------------------------
  {
    type: "function",
    name: "answer",
    description:
      "Answer a question directly, in place, without opening or changing anything. Use this " +
      "for definitions, factual questions, translations, conversions, arithmetic and " +
      "explanations - anything the user simply wants to KNOW. This is the preferred tool " +
      "whenever they are asking rather than instructing: it keeps them where they are instead " +
      "of sending them to a search results page. Only fall back to search_web when the answer " +
      "depends on something current or local that you cannot state reliably.",
    parameters: obj(
      {
        text: str(
          "The answer, in one or two short sentences of plain language. It will be spoken " +
            "aloud, so write it to be heard: no markdown, no lists, no citations, no preamble."
        ),
      },
      ["text"]
    ),
  },
  {
    type: "function",
    name: "clarify",
    description:
      "Ask a short question back when what you heard is too ambiguous or incomplete to act on " +
      "safely. Prefer this over guessing whenever acting on the wrong reading would put text " +
      "somewhere, change a field, or close something.",
    parameters: obj({ question: str("One short question to speak back.") }, ["question"]),
  },

  // --- reading the page -----------------------------------------------------
  {
    type: "function",
    name: "read_text",
    description:
      "Read text from the page the user is looking at, so you can answer from what is actually " +
      "in front of them rather than from memory. Use source 'page' for the main article or " +
      "body text, 'selection' for whatever they have highlighted, and 'field' for the contents " +
      "of the text box they are currently typing in. Call this BEFORE answering any question " +
      "about 'this page', 'this', 'here', or 'what I just wrote'.",
    parameters: obj(
      {
        source: {
          type: "string",
          enum: ["page", "selection", "field"],
          description: "Which text to read.",
        },
      },
      ["source"]
    ),
  },
  {
    type: "function",
    name: "highlight",
    description:
      "Scroll to a passage on the page and highlight it, so the user can see where an answer " +
      "came from. Use it straight after answering a question about the page, with the exact " +
      "wording you based the answer on.",
    parameters: obj(
      { quote: str("A short exact phrase from the page - a few words is enough to locate it.") },
      ["quote"]
    ),
  },

  // --- writing text ---------------------------------------------------------
  {
    type: "function",
    name: "insert_text",
    description:
      "Type text into whatever box the user is currently focused on. This is dictation, so " +
      "write what they MEANT to write, not a transcript of how they said it: drop the filler " +
      "and false starts, punctuate it, and match the register of where it is going - a chat " +
      "message is not an email. When they ask you to change what is already there ('make that " +
      "shorter', 'more formal', 'drop the last sentence'), first read_text with source 'field', " +
      "then rewrite it and insert with mode 'replace'.",
    parameters: obj(
      {
        text: str("The finished text to type."),
        mode: {
          type: "string",
          enum: ["replace", "append"],
          description:
            "'append' adds to what is there, which is the normal case while dictating. " +
            "'replace' clears the box first - only for an explicit rewrite.",
        },
      },
      ["text"]
    ),
  },
  {
    type: "function",
    name: "copy_to_clipboard",
    description:
      "Put text on the user's clipboard so they can paste it wherever they want. Use this when " +
      "they ask for something 'to my clipboard', or when they want a summary or rewrite they " +
      "will place themselves rather than have typed in immediately.",
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
    name: "open_url",
    description:
      "Open a page in a new tab BEHIND what the user is currently doing, so they are not moved " +
      "off what they were reading.",
    parameters: obj({ url: str("The address to open.") }, ["url"]),
  },
  {
    type: "function",
    name: "search_web",
    description:
      "Search the web in a new background tab. Use this only when the user actually wants to " +
      "browse results, or when the answer depends on something current or local you cannot " +
      "state reliably. For anything you simply know, use answer instead - do not send them to " +
      "a results page for a question you could have answered.",
    parameters: obj({ query: str("The search query.") }, ["query"]),
  },
  {
    type: "function",
    name: "switch_tab",
    description:
      "Move the user to one of their open tabs, described however they described it - by site, " +
      "by what is on it, or as 'the next one' or 'the one before'. This is the one action that " +
      "deliberately takes them somewhere, because going there is what they asked for.",
    parameters: obj(
      { description: str("e.g. 'the gmail tab', 'the docs about pricing', 'next tab'.") },
      ["description"]
    ),
  },
  {
    type: "function",
    name: "close_tabs",
    description:
      "Close tabs matching a description. Closing is not undoable from here, so if the " +
      "description is broad enough to catch something they might not mean, use clarify first " +
      "and tell them how many it would close.",
    parameters: obj({ description: str("e.g. 'the youtube tabs', 'everything about pricing'.") }, [
      "description",
    ]),
  },
  {
    type: "function",
    name: "list_tabs",
    description:
      "List what the user currently has open. Use it to ground a vague reference to 'that tab' " +
      "before switching or closing anything.",
    parameters: obj({}),
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
 * chrome.* APIs. `spoken` tools have no side effect at all - the agent has
 * already said the thing, and the dispatcher only acknowledges them.
 *
 * The web demo keeps the same three-way split; only the executors differ.
 */
export const TOOL_TARGET = {
  answer: "spoken",
  clarify: "spoken",

  read_text: "page",
  highlight: "page",
  insert_text: "page",
  copy_to_clipboard: "page",
  fill_field: "page",
  review_form: "page",
  submit_form: "page",

  open_url: "browser",
  search_web: "browser",
  switch_tab: "browser",
  close_tabs: "browser",
  list_tabs: "browser",
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
