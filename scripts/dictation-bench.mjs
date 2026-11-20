// A small spoken corpus for the dictation, without a microphone: German study sentences are spoken by the
// Mac's own voices (say), recognised by the bundled recognizer and run through the local text chain. It prints
// the word error rate and the time per sentence, so a change to the dictation can be judged in numbers.
// Usage: node scripts/dictation-bench.mjs [--voice "Anna"] [--keep]
import {spawn, execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir, homedir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {polishDictation, formatAtCursor} from '../core/dictation-text.js';
import {vocabularyFix, STUDY_TERMS} from '../core/vocabulary.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const voices = args.includes('--voice') ? [args[args.indexOf('--voice') + 1]] : ['Anna', 'Markus (Enhanced)'];
export const CORPUS = [
  // The team's own way of speaking: scripts about learning and the brain, Denglisch, names and products.
  'Der Hook für das nächste Reel ist: Warum dein Gehirn Aufgaben aufschiebt.',
  'Prokrastination hat viel mit Dopamin und dem präfrontalen Kortex zu tun.',
  'Henry erklärt im Video, wie Active Recall und Spaced Repetition zusammenspielen.',
  'Die Neurobites nehme ich vor der Deep Work Session.',
  'Kannst du das Thumbnail bis morgen fertig machen und mir das Skript schicken?',
  'Im Inner Circle machen wir diese Woche ein Live Coaching zum Thema Prüfungsangst.',
  'Der Call to Action am Ende verweist auf den Newsletter.',
  'Das Meeting ist auf nächste Woche verschoben, ich schicke dir gleich das Update.',
  'Morgen um vierzehn Uhr habe ich einen Call mit dem Team.',
  'Erstens brauchen wir eine bessere Retention, zweitens mehr Engagement in der Community.',
  'Hallo Joy, ich komme heute etwas später nach Hause.',
  'Der Flow State entsteht, wenn die Aufgabe genau richtig schwer ist.',
  'Schreib mir bitte eine kurze E-Mail an das Team von Studyacademy.',
  'Im Hippocampus werden neue Erinnerungen konsolidiert.',
];
const NUMBERS = {vierzehn: '14'};
const words = text => text.toLowerCase().replace(/[a-zäöüß]+/g, word => NUMBERS[word] ?? word).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
// Word error rate: edits (replace, insert, delete) per word of the reference.
export function wordErrors(reference, heard) {
  const a = words(reference), b = words(heard);
  const row = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) { let previous = row[0]; row[0] = i; for (let j = 1; j <= b.length; j++) { const keep = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1)); previous = keep; } }
  return {errors: row[b.length], words: a.length};
}
// Numbers, times, dates, amounts: spoken as words, expected written as a person would type them (exactly).
export const NUMBER_CORPUS = [
  ['Die Prüfung ist am zwölften Dezember zweitausendsechsundzwanzig.', 'Die Prüfung ist am 12. Dezember 2026.'],
  ['Am ersten März um acht Uhr fünfzehn geht es los.', 'Am 1. März um 8.15 Uhr geht es los.'],
  ['Die Wahrscheinlichkeit liegt bei fünfundachtzig Prozent.', 'Die Wahrscheinlichkeit liegt bei 85%.'],
  ['Der Wert war drei Komma fünf Millimol pro Liter.', 'Der Wert war 3,5 Millimol pro Liter.'],
  ['Die Herzfrequenz lag bei zweiundsiebzig Schlägen pro Minute.', 'Die Herzfrequenz lag bei 72 Schlägen pro Minute.'],
  ['Seite einhundertdreiundvierzig bis einhundertfünfzig lesen.', 'Seite 143 bis 150 lesen.'],
  ['Das kostet neunzehn Euro neunundneunzig.', 'Das kostet 19,99 Euro.'],
];

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const helper = join(root, 'native', 'mac', 'bin', 'studymut-parakeet');
  const model = join(root, 'native', 'models', 'parakeet-v3');
  const folder = mkdtempSync(join(tmpdir(), 'studymut-bench-'));
  const child = spawn(helper, [model], {stdio: ['pipe', 'pipe', 'ignore']});
  let pending = null, id = 0;
  createInterface({input: child.stdout}).on('line', line => { let data; try { data = JSON.parse(line); } catch { return; } if (pending && data.id === pending.id) { const p = pending; pending = null; p.resolve(data); } });
  const request = value => new Promise(resolve => { pending = {id: ++id, resolve}; child.stdin.write(JSON.stringify({id, ...value}) + '\n'); });
  await request({type: 'load'});
  let errors = 0, total = 0, polishedErrors = 0;
  const times = [], misses = [];
  let numbersExact = 0;
  const all = [...CORPUS.map(sentence => [sentence, null]), ...NUMBER_CORPUS];
  for (const voice of voices) for (const [index, [sentence, expected]] of all.entries()) {
    const aiff = join(folder, `${index}.aiff`), wav = join(folder, `${index}.wav`);
    execFileSync('say', ['-v', voice, '-o', aiff, sentence]);
    execFileSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', aiff, wav]);
    const bytes = readFileSync(wav);
    let offset = 12, pcm = null;
    while (offset + 8 <= bytes.length) { const size = bytes.readUInt32LE(offset + 4); if (bytes.toString('ascii', offset, offset + 4) === 'data') { pcm = bytes.subarray(offset + 8, offset + 8 + size); break; } offset += 8 + size + (size % 2); }
    const samples = new Float32Array(pcm.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    const started = performance.now();
    const result = await request({type: 'transcribe', audio: Buffer.from(samples.buffer).toString('base64')});
    const took = performance.now() - started;
    const raw = result.text ?? '';
    const local = formatAtCursor((await polishDictation(vocabularyFix(raw, STUDY_TERMS), {snippets: [], style: 'neutral', enabled: false, polish: null})).text, {}, 'neutral');
    if (expected) { if (local === expected) numbersExact++; else misses.push(`${voice}: „${expected}“ → „${local}“`); continue; }
    const first = wordErrors(sentence, raw), second = wordErrors(sentence, local);
    errors += first.errors; polishedErrors += second.errors; total += first.words; times.push(took);
    if (second.errors) misses.push(`${voice}: „${sentence}“ → „${local}“`);
  }
  child.kill();
  if (!args.includes('--keep')) rmSync(folder, {recursive: true, force: true});
  times.sort((a, b) => a - b);
  console.log(JSON.stringify({sentences: times.length, wordErrorRate: +(errors / total * 100).toFixed(1), afterLocalText: +(polishedErrors / total * 100).toFixed(1),
    recogniseMsMedian: Math.round(times[Math.floor(times.length / 2)]), recogniseMsP90: Math.round(times[Math.floor(times.length * 0.9)]), numbersExact: `${numbersExact}/${NUMBER_CORPUS.length * voices.length}`}));
  for (const miss of misses) console.log(miss);
}
