/**
 * Microphone capture for the demo.
 *
 * Deliberately thin: the worklet does the resampling and the framing, and the
 * session does the encoding, so all that is left here is asking for the device
 * and wiring it up.
 */

/**
 * What each refusal actually means, and what to do about it.
 *
 * The raw DOMException messages are terse to the point of useless - Chrome says
 * "Permission denied" whether the person clicked Block, the site is blocked at
 * the browser level, or an OS-level switch is off. Each has a different fix.
 */
const MIC_ERRORS = {
  NotAllowedError:
    "The microphone was blocked. Click the icon at the right of the address bar, allow the microphone, and try again.",
  NotFoundError: "No microphone was found. Plug one in, or check your system sound settings.",
  NotReadableError:
    "Something else is holding the microphone - a call, or another tab. Close it and try again.",
  OverconstrainedError: "This microphone won't record in a format the agent can use.",
  SecurityError: "The browser blocked microphone access on this page.",
  AbortError: "The microphone stopped responding. Try again.",
};

export class Mic {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.stream = null;
    this.ctx = null;
    this.node = null;
    this.source = null;
  }

  /**
   * Must be called from a click.
   *
   * An AudioContext created outside a user gesture starts suspended and never
   * recovers, and that is also what stops a bot draining the day's budget by
   * loading the page.
   */
  async start() {
    this.stream = await this.#capture();

    // The device's own rate, not a forced 24 kHz: Firefox drops echo
    // cancellation when the context rate does not match the device, and Safari
    // garbles audio outright. The worklet converts instead.
    this.ctx = new AudioContext();
    // Absolute: a relative worklet path resolves against the document, which is
    // fine at the site root and silently wrong anywhere else.
    await this.ctx.audioWorklet.addModule("/vendor/shared/pcm-worklet.js");
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (event) => this.onFrame(event.data);
    this.source.connect(this.node);
    // Not connected to the destination: that would echo the speaker back at
    // themselves.
    return this.ctx;
  }

  /**
   * Ask for the microphone, and say something useful when it says no.
   *
   * The raw DOMException messages are terse to the point of useless - Chrome
   * says "Permission denied" whether the user clicked Block, the site is
   * blocked at the browser level, or an OS-level switch is off. Each of these
   * has a different fix and the person needs to be told which one.
   */
  async #capture() {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          // Without this the agent hears itself through the speakers and
          // interrupts its own sentence. It is what lets this be demonstrated in
          // a room, without headphones.
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      throw new Error(MIC_ERRORS[err.name] ?? `The microphone failed: ${err.message}`);
    }
  }

  stop() {
    if (this.node) this.node.port.onmessage = null;
    this.node?.disconnect();
    this.source?.disconnect();
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.node = null;
    this.source = null;
  }
}
