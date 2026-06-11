// Emits raw interleaved-stereo Float32 PCM frames off the audio thread during
// recording. Loaded as a standalone module by AudioContext.audioWorklet.
class PCMRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0].length > 0) {
      const ch0 = input[0];
      const ch1 = input[1] ?? input[0];
      const inter = new Float32Array(ch0.length * 2);
      for (let i = 0; i < ch0.length; i++) {
        inter[2 * i] = ch0[i];
        inter[2 * i + 1] = ch1[i];
      }
      this.port.postMessage(inter, [inter.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-recorder', PCMRecorder);
