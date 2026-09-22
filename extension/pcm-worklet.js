/**
 * Captures raw PCM from the microphone, one render quantum at a time.
 *
 * This replaces MediaRecorder on the live path. MediaRecorder produces WebM/Opus,
 * which had to be recorded in full and then transcoded server-side before Sahara
 * could see any of it - so transcription could not start until the speaker
 * stopped. An AudioWorklet hands over raw samples as they arrive, which is what
 * makes streaming-while-speaking possible, and it deletes the transcode from the
 * live path entirely because the samples are already PCM.
 *
 * Runs on the audio thread, so it does the minimum: copy the block and post it.
 * Conversion, buffering and framing happen on the main thread.
 */
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    // A disconnected or silent-but-live input yields an empty array rather than
    // zeros; returning true keeps the node alive for when audio resumes.
    if (channel && channel.length > 0) {
      // The buffer is reused by the engine between calls, so it must be copied.
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
