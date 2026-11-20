// Recognition while you speak: during a longer dictation the recording is cut at natural pauses and the
// pieces are recognised in the background, so at release only the last piece is left. Cuts happen only
// in silence, so no word is split; if anything goes wrong the caller recognises everything at once.

const RATE = 16000;

export class Segmenter {
  // recognize(samples) → Promise<string>
  constructor(recognize, {minSpeechSeconds = 4, pauseMs = 350, threshold = 0.012} = {}) {
    Object.assign(this, {recognize, threshold});
    this.minSamples = minSpeechSeconds * RATE;
    this.pauseSamples = pauseMs / 1000 * RATE;
    this.chunks = [];
    this.length = 0;
    this.cut = 0;            // samples before this are handed to recognition
    this.quietSince = null;  // sample index where the current pause began
    this.spoken = false;     // speech since the last cut
    this.texts = [];
    this.queue = Promise.resolve();
    this.failed = false;
  }

  push(chunk) {
    const start = this.length;
    this.chunks.push(chunk);
    this.length += chunk.length;
    let sum = 0;
    for (let i = 0; i < chunk.length; i++) sum += chunk[i] * chunk[i];
    const loud = Math.sqrt(sum / Math.max(1, chunk.length)) > this.threshold;
    if (loud) { this.quietSince = null; this.spoken = true; return; }
    this.quietSince ??= start;
    // A pause long enough after enough speech: cut in its middle and recognise that piece now.
    if (this.spoken && this.length - this.quietSince >= this.pauseSamples && this.quietSince - this.cut >= this.minSamples) {
      const at = Math.round(this.quietSince + (this.length - this.quietSince) / 2);
      this.#hand(this.cut, at);
      this.cut = at;
      this.spoken = false;
    }
  }

  #slice(from, to) {
    const out = new Float32Array(to - from);
    let offset = 0, position = 0;
    for (const chunk of this.chunks) {
      const end = position + chunk.length;
      if (end > from && position < to) {
        const a = Math.max(from, position) - position, b = Math.min(to, end) - position;
        out.set(chunk.subarray(a, b), offset);
        offset += b - a;
      }
      position = end;
      if (position >= to) break;
    }
    return out;
  }

  #hand(from, to) {
    const piece = this.#slice(from, to), index = this.texts.length;
    this.texts.push('');
    this.queue = this.queue.then(async () => {
      if (this.failed) return;
      try { this.texts[index] = String(await this.recognize(piece) ?? '').trim(); } catch { this.failed = true; }
    });
  }

  // At release: the text of the pieces already recognised and where the rest begins (in samples).
  // {prefix: '', cut: 0} means: recognise everything.
  async settle() {
    await this.queue;
    if (this.failed || !this.cut) return {prefix: '', cut: 0};
    return {prefix: this.texts.filter(Boolean).join(' '), cut: this.cut};
  }
}
