import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, utimes} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DictationAudio, toWav, fromWav} from '../main/dictation-audio.js';

test('recordings round-trip as 16 kHz WAV, are kept a day and at most 30', async () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const back = fromWav(toWav(samples));
  assert.ok(back.every((value, i) => Math.abs(value - samples[i]) < 0.001));
  const directory = await mkdtemp(join(tmpdir(), 'audio-'));
  const audio = new DictationAudio(directory);
  const ids = Array.from({length: 32}, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  for (const id of ids) await audio.save(id, samples);
  assert.equal((await audio.prune()).size, 30);
  assert.equal(await audio.save('../x', samples), false);
  const old = new Date(Date.now() - 25 * 3600 * 1000);
  await utimes(join(directory, 'dictation-audio', `${ids[31]}.wav`), old, old);
  assert.equal((await audio.prune()).has(ids[31]), false);
  assert.equal((await audio.load(ids[30])).length, 5);
});
