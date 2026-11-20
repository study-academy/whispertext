import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, delimiter} from 'node:path';
import {knownPath, readCachedPath, askShellPath, refreshPath} from '../main/user-path.js';

test('the usual places come first, then the remembered shell PATH, without repeats', () => {
  const path = knownPath(['/a/nvm/bin', '/usr/local/bin'].join(delimiter), {PATH: ['/usr/bin', '/a/nvm/bin'].join(delimiter)}, '/Users/x').split(delimiter);
  assert.deepEqual(path, ['/Users/x/.local/bin', '/opt/homebrew/bin', '/usr/local/bin', '/a/nvm/bin', '/usr/bin']);
});

test('the shell is asked without blocking; what a profile prints at login stays out; silence gives nothing', async () => {
  const answers = (error, stdout) => (shell, args, options, done) => done(error, stdout);
  assert.equal(await askShellPath({run: answers(null, 'Welcome back!\n\n__STUDYMUT_PATH__/x/bin:/usr/bin\n')}), '/x/bin:/usr/bin');
  assert.equal(await askShellPath({run: answers(new Error('timeout'), '')}), '');
  assert.equal(await askShellPath({run: () => { throw new Error('no shell'); }}), '');
});

test('a fresh answer is remembered for the next launch and used now; a broken file is ignored', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'studymut-path-'));
  const file = join(dir, 'nested', 'shell-path.txt');
  const before = process.env.PATH;
  try {
    assert.equal(readCachedPath(file), '');
    assert.equal(await refreshPath(file, {run: (shell, args, options, done) => done(null, '__STUDYMUT_PATH__/fresh/bin\n')}), true);
    assert.equal(readFileSync(file, 'utf8'), '/fresh/bin');
    assert.ok(process.env.PATH.split(delimiter).includes('/fresh/bin'));
    assert.equal(await refreshPath(file, {run: (shell, args, options, done) => done(null, '__STUDYMUT_PATH__/fresh/bin\n')}), false);
    writeFileSync(file, 'a\nb');
    assert.equal(readCachedPath(file), '');
  } finally { process.env.PATH = before; }
});
