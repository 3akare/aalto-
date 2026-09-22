# Aalto

A voice agent that lives in your browser, built for the Sahara/Intron Voice AI hackathon.

Press `Alt+A`, speak, stop speaking. Aalto understands naturally code-switched speech - Yoruba-English,
Hausa-English, Igbo-English, Pidgin - and answers questions, fills Google Forms, manages tabs, and
updates Todoist. It is an **accessibility** tool - for people more fluent speaking in a mixed
local language than typing English-only forms - demonstrated on civic and
public-service forms, where being shut out costs the most.

The organising principle is **don't move the user**. Ask it what a term means and it tells you, in
place, rather than throwing you into a search results page. Tabs it opens are opened behind what
you're doing. Todoist needs no tab at all.

## Repo layout

```
aalto/
├── extension/    Chrome extension (MV3) - mic capture, tab control, Google Forms filling
├── server/       Node/TypeScript orchestrator - STT/TTS, planning, Todoist, benchmark harness
├── benchmark/    Frozen sample manifest and generated results (audio is not committed)
└── docs/         Solution description, ethics note, benchmark report
```

## How it works

1. **Capture** - an offscreen document owns the microphone and ends the command on ~1.1s of silence.
   It lives outside the popup because Chrome destroys the popup the moment it loses focus, which is
   exactly when Aalto opens or switches a tab.
2. **Transcribe** - audio is normalised once to 16 kHz mono PCM16 WAV and sent to Intron's streaming
   STT over WebSocket.
3. **Plan** - Gemini maps the transcript onto a typed tool schema (`answer`, `search_web`, `open_url`,
   `switch_tab`, `fill_form_field`, `submit_form`, `todoist_add/complete/update`, `clarify`). One
   utterance can produce several tool calls.
4. **Act** - server-side tasks (Todoist) run concurrently on the server; browser-side tasks are
   dispatched to the extension, where independent actions run in parallel and form fields run in
   order. One failure never sinks the batch.
5. **Respond** - real per-task outcomes go back to the server, which produces one spoken sentence via
   Intron TTS. Muting skips generation entirely rather than discarding audio.

## Quick start

```bash
cd server && npm install && cp .env.example .env
```

Fill in `.env` (Intron, Gemini, Todoist; AssemblyAI and a HuggingFace token for the benchmark), then:

```bash
npm run dev
```

Load the extension:

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select `extension/`
3. Press `Alt+A` (or click the icon). Grant the microphone once on the page that opens - an offscreen
   document can use the mic but can't prompt for it, so the grant has to come from a real page.

The shortcut is rebindable at `chrome://extensions/shortcuts`.

### Checking the setup

```bash
cd server && npm run smoke
```

Generates real speech with Intron TTS, pushes those exact bytes through every STT provider, and
exercises the planner and Todoist - so credentials, transcoding, request shapes and model pins are
all verified before a benchmark run spends anything.

## Benchmark

The code-switching benchmark is the substance of the submission. It evaluates four systems on
[AfriSwitch](https://huggingface.co/datasets/intronhealth/AfriSwitch) - a gated dataset, so request
access first.

```bash
npm run corpus -- smoke      # build and freeze the sample manifest
git add benchmark/manifest && git commit    # the pre-registration record
npm run benchmark -- smoke   # then: pilot, then main
```

Tiers are `smoke` (5 utterances/language), `pilot` (25), `main` (100). The manifest is committed
**before** any API call so the git timestamp stands as pre-registration; sampling is by deterministic
content hash, reproducible from the seed alone.

Output lands in `benchmark/results/latest.md`. See [`docs/BENCHMARK_REPORT.md`](docs/BENCHMARK_REPORT.md).

## Tests

```bash
cd server && npm test      # metrics, alignment, normalisation, statistics, transcode
npx tsc -p . --noEmit      # type-check
npx biome check .          # lint and format (run from the repo root)
```

## Licence

Aalto's source is MIT. It bundles a font and icon set under their own licences,
and its benchmark output derives from a CC BY-NC-SA corpus whose terms carry
over - see [NOTICE.md](NOTICE.md), which spells out which part is which.

## Submission documents

- [Solution description](docs/SOLUTION.md)
- [Ethics, safety and inclusion note](docs/ETHICS.md)
- [Benchmark report](docs/BENCHMARK_REPORT.md)
