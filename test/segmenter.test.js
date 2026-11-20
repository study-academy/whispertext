import test from 'node:test';
import assert from 'node:assert/strict';
import {Segmenter} from '../ui/lib/segmenter.js';

const RATE = 16000, CHUNK = 2048;
const chunks = (seconds, loud) => Array.from({length: Math.ceil(seconds * RATE / CHUNK)}, (_, n) => Float32Array.from({length: CHUNK}, (_, i) => loud ? 0.2 * Math.sin((n * CHUNK + i) / 7) : 0.001));

test('a long dictation is cut at a pause and the first piece is recognised while speaking', async () => {
  const pieces = [];
  const segmenter = new Segmenter(async samples => { pieces.push(samples.length); return 'Erster Teil'; });
  for (const chunk of [...chunks(5, true), ...chunks(0.5, false), ...chunks(2, true)]) segmenter.push(chunk);
  const {prefix, cut} = await segmenter.settle();
  assert.equal(prefix, 'Erster Teil');
  assert.equal(pieces.length, 1);
  assert.ok(cut > 5 * RATE && cut < 5.6 * RATE, `cut ${cut}`);
});

test('short dictations and failures fall back to recognising everything', async () => {
  const short = new Segmenter(async () => 'x');
  for (const chunk of [...chunks(2, true), ...chunks(0.5, false), ...chunks(1, true)]) short.push(chunk);
  assert.deepEqual(await short.settle(), {prefix: '', cut: 0});
  const broken = new Segmenter(async () => { throw new Error('busy'); });
  for (const chunk of [...chunks(5, true), ...chunks(0.5, false), ...chunks(1, true)]) broken.push(chunk);
  assert.deepEqual(await broken.settle(), {prefix: '', cut: 0});
});

test('no cut inside speech, only in pauses after enough speech', async () => {
  const segmenter = new Segmenter(async () => 'Teil');
  for (const chunk of chunks(12, true)) segmenter.push(chunk);
  assert.deepEqual(await segmenter.settle(), {prefix: '', cut: 0});
});
