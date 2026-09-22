/**
 * Captures microphone PCM and resamples it to what the Voice Agent API wants.
 *
 * Runs on the audio thread. It does two things and nothing else: resample to
 * 24 kHz, and hand up whole frames rather than 128-sample render quanta.
 *
 * Resampling here rather than by forcing `new AudioContext({sampleRate: 24000})`
 * is the portable choice. Chrome tolerates a forced rate, but Firefox quietly
 * drops echo cancellation when the context rate does not match the device, and
 * Safari garbles audio outright. Taking the device's native rate and converting
 * ourselves works everywhere, and echo cancellation is what stops the agent
 * hearing its own voice and interrupting itself.
 *
 * Framing happens here too: posting every quantum means ~190 messages a second,
 * which is enough to stall the receiving thread. A frame of 2048 samples is
 * about 85 ms - small enough that turn detection still feels immediate.
 */

const TARGET_RATE = 24000;
const FRAME_SAMPLES = 2048;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global in the worklet scope: the context's real rate.
    this.ratio = sampleRate / TARGET_RATE;
    this.readPos = 0; // fractional, carried across quanta so no click at the seam
    this.tail = new Float32Array(0); // samples the last quantum could not consume
    this.frame = new Int16Array(FRAME_SAMPLES);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    // A disconnected or silent-but-live input yields an empty array rather than
    // zeros; returning true keeps the node alive for when audio resumes.
    if (!channel || channel.length === 0) return true;

    // Join what is left over from last time so interpolation can look across
    // the boundary instead of restarting at every quantum.
    const buffer = new Float32Array(this.tail.length + channel.length);
    buffer.set(this.tail, 0);
    buffer.set(channel, this.tail.length);

    let pos = this.readPos;
    while (pos < buffer.length - 1) {
      const i = Math.floor(pos);
      const frac = pos - i;
      const sample = buffer[i] * (1 - frac) + buffer[i + 1] * frac;

      const clamped = Math.max(-1, Math.min(1, sample));
      this.frame[this.filled++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;

      if (this.filled === FRAME_SAMPLES) {
        // Transferred rather than copied: this runs on the audio thread and the
        // frame is no use to us once it is gone.
        const out = this.frame;
        this.port.postMessage(out, [out.buffer]);
        this.frame = new Int16Array(FRAME_SAMPLES);
        this.filled = 0;
      }

      pos += this.ratio;
    }

    const consumed = Math.floor(pos);
    this.tail = buffer.slice(consumed);
    this.readPos = pos - consumed;
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
