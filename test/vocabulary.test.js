import test from 'node:test';
import assert from 'node:assert/strict';
import {vocabularyFix, soundKey, STUDY_TERMS, termsIn} from '../core/vocabulary.js';
import {CORPUS} from '../scripts/dictation-bench.mjs';

test('near misses of known terms become the term', () => {
  const fix = text => vocabularyFix(text, STUDY_TERMS);
  assert.equal(fix('Prokrastinazion ist das eigentliche Problem.'), 'Prokrastination ist das eigentliche Problem.');
  assert.equal(fix('Ich nehme Neuro Bites vor dem Lernen.'), 'Ich nehme Neurobites vor dem Lernen.');
  assert.equal(fix('Der Hipokampus speichert das.'), 'Der Hippocampus speichert das.');
  assert.equal(fix('Spaced Repetition und Aktivrecall'), 'Spaced Repetition und Active Recall');
  assert.equal(fix('Mein Ted X Talk und aurelio health'), 'Mein TEDx Talk und aureliohealth');
  assert.equal(fix('Die Neurobitz nehme ich vor der Session.'), 'Die Neurobites nehme ich vor der Session.');
  assert.equal(fix('Kannst du das Themnail fertig machen?'), 'Kannst du das Thumbnail fertig machen?');
  assert.equal(fix('Der Floßdelit entsteht, wenn'), 'Der Flow State entsteht, wenn');
  assert.equal(fix('wie aktiv Recall und Spaced Repetition'), 'wie Active Recall und Spaced Repetition');
});

test('German words that sound like the English team terms stay German', () => {
  const fix = text => vocabularyFix(text, STUDY_TERMS);
  for (const sentence of ['Das Karussell dreht sich.', 'Die Kaution ist bezahlt.', 'Mehr Produktivität im Alltag.', 'Das Kortisol steigt bei Stress.', 'Wie viele Konten hast du?', 'Die Rezension war gut.'])
    assert.equal(fix(sentence), sentence, sentence);
});

test('what was heard right, and ordinary words, stay untouched', () => {
  for (const sentence of CORPUS) assert.equal(vocabularyFix(sentence, STUDY_TERMS), sentence, sentence);
  for (const sentence of ['Ich habe eine Indikation gesehen und eine Kondition aufgebaut.', 'Die Extraktion war schwierig, die Erklärung nicht.', 'Wir treffen uns am Wochenende zur Wiederholung.', 'Das ist eine Information über die Situation in der Abteilung.'])
    assert.equal(vocabularyFix(sentence, STUDY_TERMS), sentence, sentence);
});

test('own words and the words at the cursor count as known', () => {
  assert.equal(vocabularyFix('Der Brachioradialys beugt.', ['Brachioradialis']), 'Der Brachioradialis beugt.');
  assert.deepEqual(termsIn('Der Nervus suprascapularis und die Fossa.'), ['suprascapularis']);
  assert.equal(soundKey('Citratzyklus'), soundKey('Zitratsyklus'));
  assert.equal(vocabularyFix('den Kitra-Zyklus erklären', ['Citratzyklus']), 'den Citratzyklus erklären');
});

test('the names of a learner\'s own topics become terms the dictation knows', async () => {
  const {termsFromTitles} = await import('../core/vocabulary.js');
  const terms = termsFromTitles(['Anatomie', 'Manuelle Therapie', 'Neurophysiologie der Schmerzverarbeitung', 'Herz', '']);
  assert.deepEqual(terms, ['Anatomie', 'Manuelle Therapie', 'Manuelle', 'Therapie', 'Neurophysiologie der Schmerzverarbeitung', 'Neurophysiologie', 'Schmerzverarbeitung']);
  assert.equal(vocabularyFix('die Schmerzverarbeitun im Rückenmark', terms), 'die Schmerzverarbeitung im Rückenmark');
});

test("Studymut's own names are written right however the recogniser heard them", () => {
  const fix = text => vocabularyFix(text, STUDY_TERMS);
  assert.equal(fix('dass Study Mood dann einmal langsam zum Cursor läuft'), 'dass Studymut dann einmal langsam zum Cursor läuft');
  assert.equal(fix('obwohl ich Study-Mode geöffnet habe'), 'obwohl ich Studymut geöffnet habe');
  assert.equal(fix('Studi Mut und die Study Academy'), 'Studymut und die Studyacademy');
  assert.equal(fix('das Karussell von Sally Mut, wie so Stalin Mut kurz, dass Starry Mut sagt'), 'das Karussell von Studymut, wie so Studymut kurz, dass Studymut sagt');
  assert.equal(fix('Stalin war kein Mutiger.'), 'Stalin war kein Mutiger.');
  // Ordinary words that only begin alike stay.
  assert.equal(fix('Ich studiere Mut und Moderne.'), 'Ich studiere Mut und Moderne.');
});

test('English terms heard with other vowels, shortened units, and words built on a term', () => {
  assert.equal(vocabularyFix('Spaced Repetition und Aktivrekol', STUDY_TERMS), 'Spaced Repetition und Active Recall');
  assert.equal(vocabularyFix('Der Wert war 3,5 mm pro Liter.', STUDY_TERMS), 'Der Wert war 3,5 Millimol pro Liter.');
  assert.equal(vocabularyFix('Die Schraube ist 3 mm lang.', STUDY_TERMS), 'Die Schraube ist 3 mm lang.');
  assert.equal(vocabularyFix('Sie ist Biomechanikerin.', STUDY_TERMS), 'Sie ist Biomechanikerin.');
  assert.equal(vocabularyFix('Ich habe heute Aktien gekauft.', STUDY_TERMS), 'Ich habe heute Aktien gekauft.');
});
