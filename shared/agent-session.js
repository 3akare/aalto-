/**
 * The AssemblyAI Voice Agent protocol client.
 *
 * Owns one WebSocket session: opening it, configuring it, feeding it audio,
 * and - the part that is easy to get wrong - returning tool results at the
 * moment the protocol will accept them.
 *
 * Deliberately free of chrome.* and of DOM, so the extension's offscreen
 * document and the web demo run the same code. Whoever constructs it supplies
 * a `runTool` callback; that is the only thing that differs between them.
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
  constructor({ token, runTool, onEvent, onAudio, onInterrupt, tools, greeting, output }) {
    this.token = token;
    this.runTool = runTool;
    this.onEvent = onEvent ?? (() => {});
    this.onAudio = onAudio ?? (() => {});
    this.onInterrupt = onInterrupt ?? (() => {});
    this.config = { tools, greeting, output };

    this.socket = null;
    this.ready = false;
    this.closing = false;

    /**
     * The protocol will only accept tool results while it is idle, which it
     * signals by `reply.done` being the most recent thing it sent. Sending on
     * receipt of `tool.call` instead produces an agent that appears to ignore
     * its own tools - it is not an error, the results are simply dropped.
     */
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

      this.socket.addEventListener("close", () => {
        this.ready = false;
        if (!this.closing) this.onEvent({ type: "session.dropped" });
      });
    });
  }

  #handle(frame) {
    switch (frame.type) {
      case "reply.audio":
        // Not passed to onEvent: these arrive many times a second and the UI
        // has nothing to say about them.
        this.onAudio(fromBase64(frame.data));
        return;

      case "input.speech.started":
        // Barge-in, and the earliest possible notice of it. Waiting for the
        // reply.done that eventually reports the interruption would leave the
        // agent talking over the user for the better part of a second, which
        // is exactly the thing that makes voice assistants feel deaf.
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
          // The turn these results belonged to is gone. Sending them now would
          // answer a question nobody asked any more. Playback was already cut
          // when the user started speaking.
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
      // The agent handles a failure far better than a silence: it can say what
      // went wrong, or try another way.
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

  /** Send a typed turn instead of speech. Same agent, same tools, no audio minutes. */
  sendText(text) {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({ type: "conversation.message", role: "user", content: text }));
    this.socket.send(JSON.stringify({ type: "reply.create" }));
  }

  /**
   * Close down properly.
   *
   * Just closing the socket leaves the session billing for its grace window,
   * so say session.end and give the server a moment to acknowledge it. On a
   * 90-second demo session that window is a third of the cost again.
   */
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

function describeSocketFailure() {
  // The browser deliberately withholds the reason a WebSocket handshake failed,
  // so guessing precisely is not possible. This is the overwhelmingly likely one.
  return "couldn't reach AssemblyAI - the token may have expired or already been used";
}
