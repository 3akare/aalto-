/**
 * The AssemblyAI Voice Agent protocol client: one WebSocket session, and - the
 * part that is easy to get wrong - returning tool results at the moment the
 * protocol will accept them.
 *
 * Free of chrome.* and DOM, so the extension and the web demo run the same
 * code; only the `runTool` callback differs.
 */

import { buildSessionUpdate } from "./agent-config.js";

const WS_URL = "wss://agents.assemblyai.com/v1/ws";

/** Base64 without blowing the stack on a spread of a few thousand samples. */
function toBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export class AgentSession {
  /**
   * @param {object} opts
   * @param {string} opts.token       single-use token from the minting endpoint
   * @param {(name: string, args: object) => Promise<string>} opts.runTool
   * @param {(event: object) => void} opts.onEvent   for UI; every frame is passed through
   * @param {(pcm: Int16Array) => void} [opts.onAudio]  a chunk of the agent's speech
   * @param {() => void} [opts.onInterrupt]  cut playback off; the user is talking
   */
  constructor({ token, runTool, onEvent, onAudio, onInterrupt, tools, greeting, output, context }) {
    this.token = token;
    this.runTool = runTool;
    this.onEvent = onEvent ?? (() => {});
    this.onAudio = onAudio ?? (() => {});
    this.onInterrupt = onInterrupt ?? (() => {});
    this.config = { tools, greeting, output, context };

    this.socket = null;
    this.ready = false;
    this.closing = false;

    // The protocol accepts tool results only while idle, which it signals with
    // `reply.done`. Sending on `tool.call` instead produces an agent that
    // appears to ignore its own tools - no error, the results are just dropped.
    this.lastEventType = null;
    this.pendingResults = [];
    this.inFlight = 0;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const url = new URL(WS_URL);
      url.searchParams.set("token", this.token);
      this.socket = new WebSocket(url);

      const failFast = (event) => reject(new Error(describeSocketFailure(event)));
      this.socket.addEventListener("error", failFast, { once: true });

      this.socket.addEventListener("open", () => {
        this.socket.removeEventListener("error", failFast);
        this.socket.send(JSON.stringify(buildSessionUpdate(this.config)));
      });

      this.socket.addEventListener("message", (event) => {
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return; // a malformed frame is not worth tearing the session down for
        }
        this.#handle(frame);
        if (frame.type === "session.ready") {
          this.ready = true;
          resolve();
        }
      });

      this.socket.addEventListener("close", (event) => {
        const wasReady = this.ready;
        this.ready = false;
        if (this.closing) return;
        this.onEvent({ type: "session.dropped" });
        // A socket that closes before session.ready would otherwise leave this
        // promise pending forever: the caller is sitting on `await connect()`,
        // so nothing after it ever runs and the button stays disabled with no
        // error to show for it.
        if (!wasReady) {
          // The code is for whoever is debugging; the message is for whoever is using it.
          console.warn("[Aalto] session closed before ready, code", event.code);
          reject(
            new Error("AssemblyAI closed the session before it started. Press again to retry.")
          );
        }
      });
    });
  }

  #handle(frame) {
    switch (frame.type) {
      case "reply.audio":
        // Not passed to onEvent: many a second, and the UI has nothing to say.
        this.onAudio(fromBase64(frame.data));
        return;

      case "input.speech.started":
        // The earliest notice of barge-in. Waiting for the reply.done that
        // reports it leaves the agent talking over the user for most of a second.
        this.lastEventType = frame.type;
        this.onEvent(frame);
        this.onInterrupt();
        return;

      case "tool.call":
        this.lastEventType = frame.type;
        this.onEvent(frame);
        this.#dispatch(frame);
        return;

      case "reply.done":
        this.lastEventType = frame.type;
        this.onEvent(frame);
        if (frame.status === "interrupted") {
          // That turn is gone; these results would answer a dead question.
          this.pendingResults.length = 0;
        } else {
          this.#flush();
        }
        return;

      default:
        this.lastEventType = frame.type;
        this.onEvent(frame);
    }
  }

  async #dispatch(frame) {
    this.inFlight++;
    let result;
    try {
      result = await this.runTool(frame.name, frame.arguments ?? {});
    } catch (err) {
      // A message the agent can read out beats a silence it cannot explain.
      result = `That failed: ${err.message}`;
    } finally {
      this.inFlight--;
    }
    this.pendingResults.push({ call_id: frame.call_id, result: String(result ?? "done") });
    this.#flush();
  }

  #flush() {
    if (this.lastEventType !== "reply.done") return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    for (const { call_id, result } of this.pendingResults.splice(0)) {
      this.socket.send(JSON.stringify({ type: "tool.result", call_id, result }));
    }
  }

  /** @param {Int16Array} pcm mono 24 kHz */
  sendAudio(pcm) {
    if (!this.ready || this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "input.audio", audio: toBase64(pcm) }));
  }

  /** Say session.end and wait: closing the socket alone leaves the session
   *  billing through its grace window. */
  async end() {
    if (this.closing) return;
    this.closing = true;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: "session.end" }));
      await this.#waitFor("session.ended", 2000);
      this.socket.close();
    }
    this.ready = false;
  }

  #waitFor(type, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const onMessage = (event) => {
        try {
          if (JSON.parse(event.data).type === type) done();
        } catch {
          /* ignore */
        }
      };
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.socket.addEventListener("message", onMessage);
    });
  }
}

// The browser withholds the real reason a WebSocket handshake failed; this is
// the overwhelmingly likely one.
function describeSocketFailure() {
  return "couldn't open a session with AssemblyAI. Press again to try another.";
}
