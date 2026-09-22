/**
 * Plays the agent's speech as it streams in.
 *
 * `reply.audio` arrives as a run of small PCM chunks, not a file, so there is
 * nothing to hand to an <audio> element - by the time you had a complete clip
 * the moment for saying it would have passed. Each chunk is scheduled onto the
 * audio clock end to end, which is what keeps the seams inaudible.
 *
 * The buffers are created at 24 kHz whatever the output device runs at; Web
 * Audio resamples them on the way out, so nothing here has to care.
 */

import { AUDIO_SAMPLE_RATE } from "./agent-config.js";

/** A little slack ahead of the clock, so a late chunk does not land in the past. */
const SCHEDULE_LEAD = 0.08;

export class Speaker {
  /** @param {AudioContext} audioCtx */
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.nextTime = 0;
    this.playing = new Set();
    this.onIdle = () => {};
  }

  /** @param {Int16Array} pcm a chunk of the reply, mono 24 kHz */
  push(pcm) {
    if (pcm.length === 0) return;

    const buffer = this.ctx.createBuffer(1, pcm.length, AUDIO_SAMPLE_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    // Falling behind the clock means the queue has drained and this chunk is
    // the start of a new run of speech, so start from now rather than from a
    // timestamp that has already gone past.
    const startAt = Math.max(this.ctx.currentTime + SCHEDULE_LEAD, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + buffer.duration;

    this.playing.add(source);
    source.onended = () => {
      this.playing.delete(source);
      if (this.playing.size === 0) this.onIdle();
    };
  }

  /**
   * Cut the agent off mid-word.
   *
   * Barge-in is the whole point: someone who has heard enough should be able to
   * say so and be listened to immediately. Everything already scheduled has to
   * go, not just whatever is audible right now, or the reply keeps coming out
   * of the speaker for another second after they interrupted it.
   */
  stop() {
    for (const source of this.playing) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already finished between the check and the call; nothing to stop.
      }
    }
    this.playing.clear();
    this.nextTime = 0;
  }

  get speaking() {
    return this.playing.size > 0;
  }
}
