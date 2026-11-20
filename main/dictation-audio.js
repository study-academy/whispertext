// Recordings kept for a day on this Mac only, so a dictation that came out wrong or failed can be
// recognised again ("Erneut erkennen", as in Wispr Flow). 16 kHz mono WAV, at most 30, never uploaded.
import {mkdir, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const KEEP = 30, MAX_AGE_MS = 24 * 60 * 60 * 1000, RATE = 16000;
const ID = /^[0-9a-f-]{36}$/;

export function toWav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
export function fromWav(buffer) {
  const samples = new Float32Array((buffer.length - 44) / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = buffer.readInt16LE(44 + i * 2) / 32768;
  return samples;
}

export class DictationAudio {
  constructor(directory) { this.folder = join(directory, 'dictation-audio'); }

  async save(id, samples) {
    if (!ID.test(id) || !(samples instanceof Float32Array)) return false;
    await mkdir(this.folder, {recursive: true, mode: 0o700});
    await writeFile(join(this.folder, `${id}.wav`), toWav(samples), {mode: 0o600});
    await this.prune();
    return true;
  }
  async load(id) { return ID.test(id) ? fromWav(await readFile(join(this.folder, `${id}.wav`))) : null; }
  remove(id) { return ID.test(id) ? rm(join(this.folder, `${id}.wav`), {force: true}) : Promise.resolve(); }
  clear() { return rm(this.folder, {recursive: true, force: true}); }

  // Older than a day or beyond the newest 30: gone.
  async prune(now = Date.now()) {
    const names = (await readdir(this.folder).catch(() => [])).filter(name => name.endsWith('.wav'));
    const files = (await Promise.all(names.map(async name => ({name, at: (await stat(join(this.folder, name)).catch(() => null))?.mtimeMs ?? 0})))).sort((a, b) => b.at - a.at);
    for (const [index, file] of files.entries()) if (index >= KEEP || now - file.at > MAX_AGE_MS) await rm(join(this.folder, file.name), {force: true});
    return new Set(files.slice(0, KEEP).filter(file => now - file.at <= MAX_AGE_MS).map(file => file.name.replace(/\.wav$/, '')));
  }
}
