// Original Studymut capture processor. Runs on the audio rendering thread, never on the UI thread.
// Stop acknowledges only after every recorded sample (including the partial packet) has been sent.
class DictationCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.session = options.processorOptions.session;
    this.packet = new Float32Array(640); // 40 ms at the required 16 kHz.
    this.used = 0;
    this.samples = 0;
    this.sequence = 0;
    this.quietSamples = 0;
    this.level = 0; // Short running mean of |sample|, about 10 ms.
    this.active = false;
    this.done = false;
    this.tailLeft = null;
    this.port.onmessage = ({data}) => {
      if (data.session !== this.session || this.done) return;
      if (data.type === 'start') this.active = true;
      else if (data.type === 'cancel') { this.done = true; this.active = false; this.used = 0; this.port.postMessage({type: 'cancelled', session: this.session}); }
      else if (data.type === 'stop') {
        // Avoid a fixed delay when the recorded speech already ended. Keep a bounded tail when
        // release overlaps the last syllable; this is capture policy, not a speech recognizer.
        // Measured 20.11.: speech had ended before release, the tail held only the key click.
        if (this.quietSamples >= 960) this.finish();
        else this.tailLeft = 2400; // At most 150 ms, counted by audio samples.
      }
    };
  }
  flush() {
    if (!this.used) return;
    const audio = this.packet.slice(0, this.used);
    this.port.postMessage({type: 'audio', session: this.session, sequence: this.sequence++, audio}, [audio.buffer]);
    this.used = 0;
  }
  finish() {
    if (this.done) return;
    this.flush();
    this.done = true;
    this.active = false;
    this.port.postMessage({type: 'done', session: this.session, packets: this.sequence, samples: this.samples});
  }
  process(inputs) {
    if (!this.active || this.done) return true;
    const audio = inputs[0]?.[0];
    if (!audio?.length) return true;
    for (let i = 0; i < audio.length; i++) {
      const value = audio[i];
      if (!Number.isFinite(value)) { this.active = false; this.done = true; this.port.postMessage({type: 'error', session: this.session}); return true; }
      const size = Math.abs(value);
      // The key click after release: a sudden loud peak out of a quiet tail. It is not speech, so the
      // recording ends right before it instead of carrying the click and its echo.
      if (this.tailLeft !== null && size > 0.35 && size > this.level * 12) { this.finish(); break; }
      this.level = this.level * 0.994 + size * 0.006;
      this.packet[this.used++] = value;
      this.samples++;
      // Require sustained low amplitude, rather than a single zero crossing. 0.01 sits above the
      // measured room floor (0.0001 to 0.003) and below the softest word ends.
      this.quietSamples = size < 0.01 ? this.quietSamples + 1 : 0;
      if (this.used === this.packet.length) this.flush();
      if (this.samples >= 1920000 || (this.tailLeft !== null && (--this.tailLeft <= 0 || this.quietSamples >= 960))) { this.finish(); break; }
    }
    return true;
  }
}
registerProcessor('studymut-dictation-capture', DictationCapture);
