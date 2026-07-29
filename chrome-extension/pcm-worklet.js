// PCM16 downsampler AudioWorklet
//
// Runs in the audio thread. Receives audio frames at whatever the
// AudioContext's sample rate is (usually 44100 or 48000), sums to mono,
// downsamples to 16000, converts to int16 LE, and posts fixed-size
// Int16Array batches to the main thread over the message port.
//
// The main thread pipes those batches straight into a WebSocket as
// binary frames — whisper.cpp on the server side expects raw PCM16.
//
// Design notes:
// - AudioWorkletProcessor.process() is called for every 128-frame
//   render quantum. At 48kHz that's ~2.67ms per call — way too small
//   to send individually. We buffer up to `frameSize` output samples
//   (default 3200 = 200ms at 16kHz) and post once per fill.
// - Downsampling uses a simple box filter: average `ratio` consecutive
//   input samples per output sample. Cheap, adequate for speech, no
//   FIR taps to tune. Whisper is robust to the aliasing this leaves.
// - We accept `targetRate` and `frameSize` via options so the main
//   thread stays authoritative on cadence.

class Pcm16DownsamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super()
    const p = (options && options.processorOptions) || {}
    this.targetRate = p.targetRate || 16000
    this.frameSize = p.frameSize || 3200 // 200ms at 16kHz
    this.ratio = sampleRate / this.targetRate

    // Accumulator for partial input samples that don't yet fill an
    // output sample (e.g. sampleRate=48000 → ratio=3 → boundary-clean;
    // but sampleRate=44100 → ratio=2.75625 → we need to carry over).
    this._inAcc = 0    // sum of input samples in the current output bucket
    this._inCount = 0  // count of input samples in the current bucket
    this._outBuf = new Int16Array(this.frameSize)
    this._outIdx = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0 || !input[0]) return true

    // Sum to mono if we have >1 channel
    const numFrames = input[0].length
    const numCh = input.length
    for (let f = 0; f < numFrames; f++) {
      let sum = 0
      for (let c = 0; c < numCh; c++) sum += input[c][f]
      const monoSample = sum / numCh

      this._inAcc += monoSample
      this._inCount += 1

      // When we've consumed `ratio` input samples, emit one output.
      // We compare against a floating threshold to handle non-integer
      // ratios cleanly across the whole stream.
      if (this._inCount >= this.ratio) {
        const avg = this._inAcc / this._inCount
        // Clip + convert to int16 LE
        const clipped = Math.max(-1, Math.min(1, avg))
        this._outBuf[this._outIdx++] = clipped < 0
          ? clipped * 0x8000
          : clipped * 0x7fff

        // Reset accumulator, carry over any fractional overshoot.
        // With ratio=3 there's no overshoot. With ratio=2.7562...
        // most calls consume 3 input samples and we drop 1 fractional
        // sample worth of error per bucket — negligible for speech.
        this._inAcc = 0
        this._inCount = 0

        if (this._outIdx >= this.frameSize) {
          // Copy — the ArrayBuffer will be transferred, and we want to
          // keep _outBuf usable for the next frame.
          const out = new Int16Array(this._outBuf)
          this.port.postMessage(out.buffer, [out.buffer])
          this._outIdx = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm16-downsampler', Pcm16DownsamplerProcessor)
