# Aalto

A voice agent that lives in your browser, built on
[AssemblyAI's Voice Agent API](https://www.assemblyai.com/docs/voice-agents).

Press `Alt+A` and talk. Aalto reads the page you are on and answers from it, writes text into
whatever box you are in, fills forms, and drives your tabs. It is a conversation, not a command
box: the session stays open, the agent decides when your turn has ended, and you can cut it off
mid-sentence.

It will not submit a form it has not read back to you, and it will not guess at a value you did
not say. Both of those are code, not prompt instructions.

## What you can say

| | |
| --- | --- |
| **Dictate anywhere** | *"Reply to this saying I can do Thursday after two."* Writes what you meant, punctuated, in the register of wherever it is going. *"Make that shorter"* edits what is already there. |
| **Fill any form** | *"My name is Ada Bello, I'm in retail, sole proprietorship."* One sentence, several fields. Reads every answer back **including the blanks**. |
| **Ask the page** | *"How long does registration take here?"* Answered from the page in front of you, then highlighted where it came from - not a search results page. |
| **Drive your tabs** | *"Open my inbox behind this and close the research tabs."* Anything it opens goes behind what you are reading. |
| **Chain and interrupt** | One instruction can be several actions. Change your mind halfway through and it stops and takes the new one. |
| **Work on a selection** | *"Summarise this into three bullets on my clipboard."* |
| **Teach it once** | *"Remember that as my morning setup."* Replay by name later. |

## How it works

```
Chrome extension (MV3)
  popup.js          a view; the session outlives it
  background.js     tool dispatch, the browser, the safety guards
  offscreen.js      microphone, speaker, and the socket
  content-agent.js  the DOM of whatever page you are on
        |
        |  wss://agents.assemblyai.com/v1/ws
        v
AssemblyAI Voice Agent API
  speech in - LLM routing - tool calls - turn detection - barge-in - speech out
        |
        |  GET /api/ext/token
        v
Cloudflare Worker      mints single-use tokens, meters the shared demo
```

There is no orchestration server. AssemblyAI owns the whole voice loop, so what would normally be
a planner, a summariser, a voice-activity detector and a relay is instead a tool schema and a
system prompt. The Worker exists only to mint tokens without putting an API key in a browser.

Three details that are easy to get wrong and cost a day each:

- **Tool results may only be sent while the session is idle**, which it signals with `reply.done`.
  Returning them on receipt of `tool.call` looks exactly like an agent ignoring its own tools.
- **Barge-in has to hook `input.speech.started`**, not the `reply.done` that eventually reports the
  interruption - by then you have talked over the user for the better part of a second.
- **Audio is base64 PCM16 mono 24 kHz inside a JSON message**, not binary frames, and capture has to
  resample rather than force the `AudioContext` rate. Forcing it costs echo cancellation on Firefox
  and garbles Safari.

## Install

```bash
git clone <this repo> && cd aalto
```

1. `chrome://extensions` → turn on **Developer mode**
2. **Load unpacked** → select `extension/`
3. Press `Alt+A`. The first time, Aalto opens a page asking for the microphone - it has to ask from
   a real page, because the offscreen document that does the listening may use the microphone but
   may not prompt for it. Grant it once.

The shortcut is rebindable at `chrome://extensions/shortcuts`.

**Whose credits?** Out of the box the extension uses a shared demo endpoint with a daily cap, so it
works without signing up for anything. Put your own AssemblyAI key into the extension's settings
and it mints sessions straight from that key, in your browser, with no cap and nothing in between.
The key never leaves your machine.

## The site

`web/` is one Cloudflare Worker serving both a static page and the token API. The page walks
through installing the extension and carries a demo you can talk to without installing it: a small
browser rendered inside the page, driven by the agent through the same tool definitions the
extension executes against.

```bash
cd web
npm install
cp .dev.vars.example .dev.vars   # then paste in your AssemblyAI key
npm run dev                      # http://localhost:8787
npm run deploy
```

Before the first deploy: `wrangler secret put ASSEMBLYAI_API_KEY`. Preview deployments need their
own copy, or minting fails on the one URL you only test once.

## Shared code

`shared/` is the single source of truth for the tool contract, the agent definition, the protocol
client, the audio worklet and the matching logic. Neither an MV3 service worker nor a Worker's
assets directory can load a file outside its own root, so `npm run sync-shared` copies it into both
and the copies are committed - `Load unpacked` then works from a fresh clone with no install step.

The one wrinkle: a content script is injected as a file, not a module graph, so it cannot import
anything. The sync script splices `shared/matching.js` into `extension/content-agent.js` between
markers. Edit the shared file, never the copy.

That arrangement is why "the demo runs the same tool contract as the extension" is a fact rather
than a claim on a slide.

## Checks

```bash
npm run sync-shared     # must be a no-op on a clean tree
npx biome check .       # lint and format
cd web && npx wrangler deploy --dry-run
```

## Licence

MIT - see [LICENSE](LICENSE). It bundles Cormorant Garamond (SIL OFL 1.1) and Remix Icon
(Apache-2.0); [NOTICE.md](NOTICE.md) says which is which and where each licence lives.
