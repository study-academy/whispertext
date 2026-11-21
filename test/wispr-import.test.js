import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {readWispr, applyWispr, sortDictionary} from '../main/wispr-import.js';
import {DictationStore} from '../main/dictation.js';

test('Wispr Flow entries become words, corrections and snippets', () => {
  const sorted = sortDictionary([
    {phrase: 'Neurobites', replacement: null, isSnippet: 0, isDeleted: 0},
    {phrase: 'Neuro Bytes', replacement: 'Neurobites', isSnippet: 0, isDeleted: 0},
    {phrase: 'mein Link', replacement: 'https://example.com/a', isSnippet: 1, isDeleted: 0},
    {phrase: 'weg', replacement: null, isSnippet: 0, isDeleted: 1},
    {phrase: 'Same', replacement: 'Same', isSnippet: 0, isDeleted: 0},
  ]);
  assert.deepEqual(sorted.words, ['Neurobites', 'Same']);
  assert.deepEqual(sorted.rules, [{from: 'Neuro Bytes', to: 'Neurobites'}]);
  assert.deepEqual(sorted.snippets, [{trigger: 'mein Link', value: 'https://example.com/a'}]);
});

test('reads a Wispr Flow file read-only and fills the store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wispr-'));
  try {
    const file = join(dir, 'flow.sqlite');
    const db = new DatabaseSync(file);
    db.exec(`create table Dictionary (id text, phrase text, replacement text, isSnippet integer, isDeleted integer, secret text);
      create table History (transcriptEntityId text, formattedText text, asrText text, timestamp text, app text, isArchived integer, audio blob);
      insert into Dictionary values ('1', 'Studyacademy', null, 0, 0, 'x'), ('2', 'mein Gruß', 'Viele Grüße', 1, 0, 'x');
      insert into History values ('a', 'Hallo Team', 'hallo team', '2026-11-16 18:46:46.310 +00:00', 'com.apple.mail', 0, null),
        ('b', 'Archiviert', '', '2026-11-15 10:00:00.000 +00:00', null, 1, null),
        ('c', '', 'nur roh', '2026-11-17 09:00:00.000 +00:00', null, 0, null);`);
    db.close();
    const found = await readWispr(file);
    assert.equal(found.history.length, 2);
    assert.deepEqual(found.history[0], {id: 'wispr-c', createdAt: '2026-11-17T09:00:00.000Z', app: null, final: 'nur roh'});
    assert.equal(found.history[1].app, 'com.apple.mail');
    const store = new DictationStore(join(dir, 'dictation.json'));
    assert.deepEqual(applyWispr(store, found), {words: 2, history: 2});
    assert.deepEqual(store.data.words, ['Studyacademy']);
    assert.equal(store.data.snippets[0].text, 'Viele Grüße');
    assert.equal(await readWispr(join(dir, 'none.sqlite')), null);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
