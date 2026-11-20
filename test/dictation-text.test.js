import test from 'node:test';
import assert from 'node:assert/strict';
import {expandSnippets, restoreSnippets, keepsMarks, styleFor, isCommand, learnCorrections, insights, polishPrompt} from '../core/dictation-text.js';

test('snippets are protected from polishing and restored afterwards', () => {
  const {text, marks} = expandSnippets('Schick es an meine Adresse. Danke', [{trigger: 'meine Adresse', text: 'Musterweg 1, 12345 Berlin'}]);
  assert.equal(text, 'Schick es an ⟦1⟧. Danke');
  assert.ok(keepsMarks('Schick es an ⟦1⟧ Danke.', marks));
  assert.equal(restoreSnippets('Schick es an ⟦1⟧. Danke.', marks), 'Schick es an Musterweg 1, 12345 Berlin. Danke.');
  assert.ok(!keepsMarks('Schick es an Danke.', marks));
});

test('the writing style follows the app unless set by hand', () => {
  assert.equal(styleFor('net.whatsapp.WhatsApp'), 'locker');
  assert.equal(styleFor('com.apple.mail'), 'foermlich');
  assert.equal(styleFor('com.microsoft.VSCode'), 'wortgetreu');
  assert.equal(styleFor('com.openai.codex'), 'neutral');
  assert.equal(styleFor('com.apple.Notes'), 'neutral');
  assert.equal(styleFor('com.apple.mail', {'com.apple.mail': 'locker'}), 'locker');
  assert.equal(styleFor('com.tinyspeck.slackmacgap', {Slack:'foermlich'}, 'Slack'), 'foermlich');
  assert.match(polishPrompt('locker', ['Studymut']), /Chatnachricht.*Studymut/);
});

test('command mode needs selected text and an instruction', () => {
  assert.ok(isCommand('mach das kürzer', 'Ein langer Absatz.'));
  assert.ok(isCommand('Übersetz das ins Englische', 'Hallo'));
  assert.ok(!isCommand('mach das kürzer', ''));
  assert.ok(!isCommand('Heute lerne ich Anatomie', 'Alter Text'));
  assert.ok(!isCommand('Macht das Team morgen weiter?', 'Alter Text'));
});

test('a corrected word becomes a dictionary suggestion; unrelated edits do not', () => {
  assert.deepEqual(learnCorrections('Ich lerne mit Studi Mut jeden Tag', 'Ich lerne mit Studymut jeden Tag'), [{from: 'Studi Mut', to: 'Studymut'}]);
  assert.deepEqual(learnCorrections('Die Plaura liegt außen', 'Hallo. Die Pleura liegt außen'), [{from: 'Plaura', to: 'Pleura'}]);
  assert.deepEqual(learnCorrections('Die Pleura liegt außen', 'Die Pleura liegt außen'), []);
  assert.deepEqual(learnCorrections('Ich gehe heute los', 'Ich fahre morgen weg'), []);
  assert.deepEqual(learnCorrections('Ich brauche 15 Minuten', 'Ich brauche 16 Minuten'), []);
  assert.deepEqual(learnCorrections('Das ist meine Entscheidung', 'Das ist deine Entscheidung'), []);
});

test('fixes made later in the whole message are found and taken after two looks or when it is sent', async () => {
  const {correctionStep} = await import('../ui/lib/dictation-text.js');
  // Aurelio's own dictation of 15 November 2026: two words fixed while later dictations stood behind them.
  const first = 'In den Chats soll das Karussell von Sally Mut so einen leichten Schimmerbackground haben.';
  const second = 'Ich will, dass es ins zweite Buch aufgenommen wird und beim nächsten Mal richtig verwendet wird.';
  const field = `flimmer bug. ${first.replace('Sally Mut', 'Studymut')} ${second.replace('zweite Buch', 'Wörterbuch')} Und noch ein Satz.`;
  const one = correctionStep({inserted: first, field});
  assert.deepEqual(one.last, [{from: 'Sally Mut', to: 'Studymut'}]);
  assert.deepEqual(correctionStep({inserted: first, field, ...one}).learn, [{from: 'Sally Mut', to: 'Studymut'}]);
  const looked = correctionStep({inserted: second, field});
  assert.deepEqual(correctionStep({inserted: second, field: '', ...looked}).learn, [{from: 'zweite Buch', to: 'Wörterbuch'}]);
  // Another app in front: wait; sent without a fix: stop.
  assert.deepEqual(correctionStep({inserted: first, field: null, ...one}), one);
  assert.deepEqual(correctionStep({inserted: first, field: '', seen: '', last: []}), {stop: true});
  assert.deepEqual(correctionStep({inserted: first, field: `Davor. ${first} Danach.`}), {seen: '', last: []});
});

test('insights count words, pace, time saved and the streak', () => {
  const day = new Date('2026-10-27T12:00:00Z');
  const history = [{final: 'eins zwei drei vier', durationMs: 2000, createdAt: '2026-10-27T10:00:00Z'}, {final: 'fünf sechs', durationMs: 1000, createdAt: '2026-10-26T10:00:00Z'}];
  assert.deepEqual(insights(history, day.getTime()), {words: 6, wpm: 120, savedMinutes: 0, streak: 2});
});

test('a deleted word is never learned as a spelling, and such old rules are told apart', async () => {
  const {learnCorrections, dropsWord} = await import('../ui/lib/dictation-text.js');
  assert.deepEqual(learnCorrections('Der Lernforschung zufolge hilft Abruf.', 'Lernforschung zufolge hilft Abruf.'), []);
  assert.deepEqual(learnCorrections('Mit welchem Ziel lernst du?', 'welchem Ziel lernst du?'), []);
  assert.deepEqual(learnCorrections('Ich nutze Studi Mut jeden Tag.', 'Ich nutze Studymut jeden Tag.'), [{from: 'Studi Mut', to: 'Studymut'}]);
  assert.equal(dropsWord('Der Lernforschung', 'Lernforschung'), true);
  assert.equal(dropsWord('Studi Mut', 'Studymut'), false);
  assert.equal(dropsWord('Zitratzyklus', 'Citratzyklus'), false);
});

test('learnCorrections: lines the words up, so other edits around a fix do not hide it', async () => {
  const {learnCorrections} = await import('../ui/lib/dictation-text.js');
  // A word added elsewhere in the same text.
  assert.deepEqual(learnCorrections('Die Plaura liegt außen an der Lunge', 'Die Pleura liegt ganz außen an der Lunge'), [{from: 'Plaura', to: 'Pleura'}]);
  // Typed on after it, and text before it.
  assert.deepEqual(learnCorrections('Wir nutzen Notion für alles', 'Hi Tom, wir nutzen Notion für alles und mehr. Wir nutzen Nouschn'), []);
  assert.deepEqual(learnCorrections('Der Zitratzyklus läuft im Mitochondrium', 'Kurz: Der Citratzyklus läuft im Mitochondrium ab, klar.'), [{from: 'Zitratzyklus', to: 'Citratzyklus'}]);
  // Two fixes in one dictation.
  assert.deepEqual(learnCorrections('Die Plaura und das Perikart schützen', 'Die Pleura und das Perikard schützen'), [{from: 'Plaura', to: 'Pleura'}, {from: 'Perikart', to: 'Perikard'}]);
  // One word became two.
  assert.deepEqual(learnCorrections('Ich öffne Lernphysio jetzt', 'Ich öffne Lern Physio jetzt'), [{from: 'Lernphysio', to: 'Lern Physio'}]);
  // A rewrite teaches nothing.
  assert.deepEqual(learnCorrections('Ich gehe heute früh los', 'Morgen fahre ich lieber spät weg'), []);
});

test('impliedList: an announced list in one sentence becomes bullet points; ordinary sentences stay', async () => {
  const {impliedList} = await import('../ui/lib/dictation-text.js');
  assert.equal(impliedList('Ich brauche folgende Sachen: Milch, Eier und Brot. Danke dir.'), 'Ich brauche folgende Sachen:\n\n- Milch\n- Eier\n- Brot\n\nDanke dir.');
  assert.equal(impliedList('Für morgen Folgendes Anatomie wiederholen, Karten lernen, Flowmap zeichnen und Probeklausur planen.'), 'Für morgen Folgendes:\n\n- Anatomie wiederholen\n- Karten lernen\n- Flowmap zeichnen\n- Probeklausur planen');
  // No announcement, a clause, or only two items: nothing changes.
  for (const plain of ['Ich war heute müde, hungrig und schlecht gelaunt.', 'Die folgenden Tage sind voll, weil ich lerne, arbeite und trainiere.', 'Ich brauche: Milch und Brot.', 'Er sagte: Das ist gut, das ist richtig und das ist wichtig.'])
    assert.equal(impliedList(plain), plain);
  assert.equal(impliedList('1. Eins\n2. Zwei'), '1. Eins\n2. Zwei');
});
