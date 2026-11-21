import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, chmodSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Recognizer} from '../main/dictation.js';

// A stand-in helper: on the Neural Engine the first load takes long (as after a fresh install), on the CPU it is quick.
const fake = dir => {
  const file = join(dir, 'helper');
  writeFileSync(file, `#!/usr/bin/env node
const cpu = process.env.WT_UNITS === 'cpu';
let ready = null;
require('readline').createInterface({input: process.stdin}).on('line', line => {
  const r = JSON.parse(line);
  ready ??= new Promise(res => setTimeout(res, cpu ? 50 : 4000));
  ready.then(() => process.stdout.write(JSON.stringify(r.type === 'load' ? {id: r.id, ready: true} : {id: r.id, text: cpu ? 'cpu' : 'ane'}) + '\\n'));
});`);
  chmodSync(file, 0o755);
  return file;
};

test('the first dictation does not wait for the Neural Engine to be prepared', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-'));
  const recognizer = new Recognizer(fake(dir), dir, {bridgeAfterMs: 100});
  try {
    const loaded = recognizer.request('load');
    const started = Date.now();
    const first = await recognizer.request('transcribe', new Float32Array(160));
    assert.equal(first.text, 'cpu');
    assert.ok(Date.now() - started < 2500);
    await loaded;
    assert.equal(recognizer.bridge, null);
    assert.equal((await recognizer.request('transcribe', new Float32Array(160))).text, 'ane');
  } finally { recognizer.stop(); rmSync(dir, {recursive: true, force: true}); }
});
