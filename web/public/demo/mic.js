/**
 * Microphone capture for the demo.
 *
 * Deliberately thin: the worklet does the resampling and the framing, and the
 * session does the encoding, so all that is left here is asking for the device
 * and wiring it up.
 */

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
    this.stream = await navigator.mediaDevices.getUserMedia({
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

    // The device's own rate, not a forced 24 kHz: Firefox drops echo
    // cancellation when the context rate does not match the device, and Safari
    // garbles audio outright. The worklet converts instead.
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule("vendor/shared/pcm-worklet.js");
    if (this.ctx.state === "suspended") await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.node.port.onmessage = (event) => this.onFrame(event.data);
    this.source.connect(this.node);
    // Not connected to the destination: that would echo the speaker back at
    // themselves.
    return this.ctx;
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
