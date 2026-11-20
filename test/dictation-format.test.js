import test from 'node:test';
import assert from 'node:assert/strict';
import {formatDictation, polishDictation, validPolish, dictationContext, formatAtCursor} from '../core/dictation-text.js';

test('explicit numbered items become a list without changing their contents', () => {
  assert.equal(formatDictation('Bitte erledigen: erstens Rechnung prüfen zweitens Sabine anrufen drittens Unterlagen senden'), 'Bitte erledigen:\n\n1. Rechnung prüfen\n2. Sabine anrufen\n3. Unterlagen senden');
  assert.equal(formatDictation('Erstens Rechnung prüfen. Zweitens Sabine anrufen. Drittens Unterlagen senden.'), '1. Rechnung prüfen.\n2. Sabine anrufen.\n3. Unterlagen senden.');
});

test('unambiguous bullet commands become bullets, ordinary conjunctions stay prose', () => {
  assert.equal(formatDictation('Aufgaben: Stichpunkt Rechnung prüfen nächster Stichpunkt Sabine anrufen'), 'Aufgaben:\n\n- Rechnung prüfen\n- Sabine anrufen');
  for (const text of ['Erstens ist das teuer und außerdem schwierig.', 'Erstens prüfen wir, ob zweitens überhaupt im Text vorkommt.', 'Ich brauche Äpfel und Birnen und Milch.', 'Das Wort erstens steht vor dem Wort zweitens.']) assert.equal(formatDictation(text), text);
});

test('mail closing keeps the dictated sender and separates organisation', () => {
  assert.equal(formatDictation('Vielen Dank für deine Rückmeldung. Lg Sabine Studyacademy'), 'Vielen Dank für deine Rückmeldung.\n\nLG\nSabine\nStudyacademy');
  assert.equal(formatDictation('Vielen Dank für deine Rückmeldung. LG Sabine Studyacademy.'), 'Vielen Dank für deine Rückmeldung.\n\nLG\nSabine\nStudyacademy');
  assert.equal(formatDictation('Hallo Anna, danke für deine Nachricht. Liebe Grüße Sabine Studyacademy', {email: true}), 'Hallo Anna,\n\ndanke für deine Nachricht.\n\nLiebe Grüße\nSabine\nStudyacademy');
  assert.equal(formatDictation('Viele Grüße\nSabine\nStudyacademy'), 'Viele Grüße\nSabine\nStudyacademy');
  for (const text of ['Sie schrieb „LG Sabine Studyacademy“ in ihre Mail.', 'LG ist eine Abkürzung.', 'Viele Grüße an Sabine und das ganze Team.', 'Bitte erkläre, wie man LG Sabine Studyacademy schreibt.']) assert.equal(formatDictation(text), text);
});

test('actual recognized comma-separated mail signature formats locally in dictated order', async () => {
  const raw='Hallo Anna, danke für deine Nachricht, liebe Grüße, Study Academy, Support, Sabine.';
  const expected='Hallo Anna,\n\ndanke für deine Nachricht.\n\nLiebe Grüße\nStudyacademy Support\nSabine';
  assert.equal(formatDictation(raw),expected);
  let called=false;
  const result=await polishDictation(raw,{polish:async()=>{called=true;throw new Error('provider unavailable');}});
  assert.equal(result.text,expected);assert.equal(result.polishStatus,'local');assert.equal(called,false);
  assert.equal(formatDictation('Hallo Anna, danke für deine Nachricht, LG, Sabine, Study Academy.'),'Hallo Anna,\n\ndanke für deine Nachricht.\n\nLG\nSabine\nStudyacademy');
  assert.equal(formatDictation('Sie schrieb, liebe Grüße, Study Academy, Support, Sabine.'),'Sie schrieb, liebe Grüße, Study Academy, Support, Sabine.');
});

test('literal text and snippets keep their exact structure', () => {
  const text = 'Erstens A zweitens B. LG Sabine Studyacademy';
  assert.equal(formatDictation(text, {style: 'wortgetreu'}), text);
  assert.equal(formatDictation('⟦1⟧'), '⟦1⟧');
});

test('clear adjacent repairs and a bounded explicit restart work without network', () => {
  assert.equal(formatDictation('Wir treffen uns am Dienstag, nein am Mittwoch um 15 Uhr.'), 'Wir treffen uns am Mittwoch um 15 Uhr.');
  assert.equal(formatDictation('Wir treffen uns um 14, nein um 15 Uhr.'), 'Wir treffen uns um 15 Uhr.');
  assert.equal(formatDictation('Das ist kompliziert, ich fange nochmal an: Bitte schick mir die Rechnung bis Freitag.'), 'Bitte schick mir die Rechnung bis Freitag.');
  for (const text of ['Nein, Mittwoch passt nicht.', 'Er sagte: Ich fange nochmal an: Hallo.', 'Ich schreibe um 15 Uhr.', 'Der zweite Termin ist am dritten Mai.']) assert.equal(formatDictation(text),text);
});

test('different-length snippet triggers keep their original order through AI', async () => {
  const result = await polishDictation('An Adresse senden mit meiner langen Signatur', {enabled:true,snippets:[{trigger:'Adresse',text:'Musterweg 1'},{trigger:'meiner langen Signatur',text:'LG\nSabine'}],force:true,polish:async text=>text});
  assert.equal(result.text, 'An Musterweg 1 senden mit LG\nSabine');
  assert.equal(result.polishStatus,'accepted');
});

test('formatter rejects altered quantities, negations and snippet duplication', () => {
  assert.equal(validPolish('Bitte 15 Minuten warten.', 'Bitte 50 Minuten warten.'), false);
  assert.equal(validPolish('Bitte nicht senden.', 'Bitte senden.'), false);
  assert.equal(validPolish('Korrektur: Ich darf die Daten nicht löschen.', 'Ich darf die Daten löschen.'), false);
  assert.equal(validPolish('Korrektur: 15 Personen bleiben und 16 kommen.', '16 kommen.'), false);
  assert.equal(validPolish('Ich brauche fünf Milligramm.', 'Ich brauche sechs Milligramm.'), false);
  assert.equal(validPolish('Ich brauche fünf mg, nein zehn mg.', 'Ich brauche zehn mg.'), true);
  assert.equal(validPolish('Bitte 15 mg.', 'Bitte 15 ml.'), false);
  assert.equal(validPolish('Meine erste Aufgabe ist lang.', '{"transcription":"Meine erste Aufgabe ist lang."}'),false);
  assert.equal(validPolish('Bitte die Rechnung bis Freitag schicken.', 'Alles klar.'),false);
  assert.equal(validPolish('Bitte an ⟦1⟧ senden.', 'Bitte an ⟦1⟧ ⟦1⟧ senden.', ['Adresse']), false);
  assert.equal(validPolish('Wir treffen uns um 14, nein um 15 Uhr.', 'Wir treffen uns um 15 Uhr.'), true);
});

test('literal marker text never expands into private snippet content', async () => {
  const text='Das Zeichen ⟦1⟧ und meine Adresse';
  assert.equal((await polishDictation(text,{snippets:[{trigger:'meine Adresse',text:'PRIVATE'}]})).text,text);
});

test('website context is specific, overridable and never inferred from a misleading hostname', () => {
  assert.deepEqual(dictationContext({app:'company.browser',domain:'mail.google.com'}),{style:'foermlich',email:true,domain:'mail.google.com'});
  assert.equal(dictationContext({app:'company.browser',domain:'mail.google.com.evil.example'}).email,false);
  assert.equal(dictationContext({app:'company.browser',domain:'app.slack.com'}).style,'locker');
  assert.equal(dictationContext({app:'company.browser',domain:'mail.google.com'},{'site:mail.google.com':'wortgetreu'}).style,'wortgetreu');
  assert.equal(dictationContext({app:'com.openai.codex'}).style,'neutral');
});

test('cursor adaptation changes only safe boundaries and leaves code literal', () => {
  assert.equal(formatAtCursor('Und dann gehen wir.',{beforeText:'Wir warten'}),' und dann gehen wir.');
  assert.equal(formatAtCursor('Sabine kommt.',{beforeText:'Ich glaube'}),' Sabine kommt.');
  assert.equal(formatAtCursor('Ich komme.',{beforeText:'Fertig. '}),'Ich komme.');
  assert.equal(formatAtCursor('Ich komme.',{beforeText:'Fertig. ',afterText:''},'wortgetreu'),'Ich komme.');
  assert.equal(formatAtCursor('innen',{beforeText:'(',afterText:')'}),'innen');
  assert.equal(formatAtCursor('example.org',{beforeText:'https://'}),'example.org');
});

test('real dictation text pipeline formats without a provider and preserves snippets', async () => {
  const result = await polishDictation('Erstens A zweitens B. LG Sabine Studyacademy', {snippets: [], enabled: true});
  assert.match(result.text, /^1\. A\n2\. B\n/);
  assert.match(result.text, /\n\nLG\nSabine\nStudyacademy$/);
  assert.equal(result.polishStatus, 'local');
  let called = false;
  const snippet = await polishDictation('meine Signatur', {snippets: [{trigger:'meine Signatur',text:'LG\nSabine\nStudyacademy'}], enabled:true, polish: async () => { called = true; }});
  assert.equal(snippet.text, 'LG\nSabine\nStudyacademy');
  assert.equal(called, false);
});

test('semantic cleanup is used when valid and falls back locally when unavailable or unsafe', async () => {
  const raw = 'Wir treffen uns Dienstag, nein Mittwoch um 15 Uhr.';
  const result = await polishDictation(raw, {enabled:true, polish:async () => 'Wir treffen uns Mittwoch um 15 Uhr.'});
  assert.equal(result.text, 'Wir treffen uns Mittwoch um 15 Uhr.');
  assert.equal(result.polishStatus, 'accepted');
  const wrong = await polishDictation('Bitte nicht senden. Diese Nachricht bleibt intern.', {enabled:true, force:true, polish:async () => 'Bitte senden. Diese Nachricht bleibt intern.'});
  assert.equal(wrong.text, 'Bitte nicht senden. Diese Nachricht bleibt intern.');
  assert.equal(wrong.polishStatus, 'rejected');
  const offline = await polishDictation('Erstens A zweitens B', {enabled:true, polish:async () => { throw new Error('offline'); }});
  assert.equal(offline.text, '1. A\n2. B');
  assert.equal(offline.polishStatus, 'local');
});

test('fully structured explicit lists and short mail closings avoid an AI round trip', async () => {
  let called=0;
  for(const text of ['Erstens Rechnung prüfen zweitens Sabine anrufen','Danke für deine Nachricht. LG Sabine Studyacademy.']) {
    const result=await polishDictation(text,{enabled:true,polish:async()=>{called++;throw new Error('must stay local');}});
    assert.equal(result.polishStatus,'local');
  }
  assert.equal(called,0);
});

test('the AI is asked only where it helps: corrections strongly, long or ordered text mildly, a clean sentence not at all', async () => {
  const {polishNeed} = await import('../ui/lib/dictation-text.js');
  assert.equal(polishNeed('Wir treffen uns morgen um zehn Uhr in der Bibliothek.'), null);
  assert.equal(polishNeed('Nein, das möchte ich nicht.'), null);
  assert.equal(polishNeed('Ja genau.'), null);
  assert.equal(polishNeed('Wir treffen uns am Dienstag, nein Mittwoch um 14 Uhr.'), 'strong');
  assert.equal(polishNeed('Das ist ähm die Reizleitung des Herzens.'), 'strong');
  assert.equal(polishNeed('Schick das an Anna, ich meine an Sabine.'), 'strong');
  assert.equal(polishNeed('Ich meine, dass wir die Prüfung gut schaffen.'), null);
  assert.equal(polishNeed('Erstens Anatomie wiederholen zweitens Karten anlegen drittens die Probeprüfung korrigieren und abgeben'), 'mild');
  assert.equal(polishNeed('die erregung beginnt im sinusknoten und läuft über die vorhöfe zum av knoten dort wird sie kurz verzögert damit sich die kammern füllen können danach geht sie weiter'), 'mild');
  assert.equal(polishNeed('Hallo Anna danke für deine Nachricht ich melde mich morgen viele Grüße Sabine'), 'mild');
  let asked = 0;
  const clean = await polishDictation('Wir treffen uns morgen um zehn Uhr in der Bibliothek.', {enabled: true, polish: async () => { asked++; return 'x'; }});
  assert.equal(asked, 0);
  assert.equal(clean.polishStatus, 'local');
});

test('a later answer is checked like any other and offered only when it changes the text', async () => {
  const raw = 'die erregung beginnt im sinusknoten und läuft über die vorhöfe zum av knoten dort wird sie kurz verzögert damit sich die kammern füllen können danach geht sie weiter';
  const good = 'Die Erregung beginnt im Sinusknoten und läuft über die Vorhöfe zum AV-Knoten. Dort wird sie kurz verzögert, damit sich die Kammern füllen können. Danach geht sie weiter.';
  const now = await polishDictation(raw, {enabled: true, polish: async () => ({later: Promise.resolve({text: good, provider: 'chatgpt'})})});
  assert.equal(now.polishStatus, 'pending');
  assert.ok(now.text.length > 0 && now.text !== good, 'the plain text goes in first');
  assert.deepEqual(await now.later, {text: good, provider: 'chatgpt'});
  // An answer that changes the meaning is not offered, nor one that never comes.
  const bad = await polishDictation(raw, {enabled: true, polish: async () => ({later: Promise.resolve({text: 'Das Herz schlägt.'})})});
  assert.equal(await bad.later, null);
  const none = await polishDictation(raw, {enabled: true, polish: async () => ({later: Promise.reject(new Error('gone'))})});
  assert.equal(await none.later, null);
});


test('sounds of thinking go, with the comma or the sentence that was only them', () => {
  const tidy = text => formatDictation(text, {style: 'neutral'});
  assert.equal(tidy('Ja, äh, und mit Escape soll man den Modus beenden.'), 'Ja, und mit Escape soll man den Modus beenden.');
  assert.equal(tidy('Ähm. Ja. Und das wird irgendwie blau.'), 'Ja. Und das wird irgendwie blau.');
  assert.equal(tidy('Das ist, ähm, sehr gut.'), 'Das ist sehr gut.');
  assert.equal(tidy('Mm, ja, das geht. Em, vielleicht morgen.'), 'Ja, das geht. Vielleicht morgen.');
  // Letters and units that only look like a hum stay, and word-for-word keeps everything.
  assert.equal(tidy('Größe M passt mir. Die Schraube ist 5 mm lang und die EM war gut.'), 'Größe M passt mir. Die Schraube ist 5 mm lang und die EM war gut.');
  assert.equal(formatDictation('Ja, äh, genau.', {style: 'wortgetreu'}), 'Ja, äh, genau.');
});

test('"ne, nochmal neu" throws away what came before it; telling about a restart does not', () => {
  const tidy = text => formatDictation(text, {style: 'neutral'});
  assert.equal(tidy('Schick das an Anna. Ne, nochmal neu. Schick das bitte an Sabine bis morgen.'), 'Schick das bitte an Sabine bis morgen.');
  assert.equal(tidy('Ich wollte sagen, nein, noch mal von vorn, wir treffen uns am Dienstag.'), 'Wir treffen uns am Dienstag.');
  assert.equal(tidy('Er sagte, nochmal neu anfangen ist keine Schande.'), 'Er sagte, nochmal neu anfangen ist keine Schande.');
  assert.equal(tidy('Das machen wir nochmal neu.'), 'Das machen wir nochmal neu.');
});

test('key names said as a shortcut become the signs on the keyboard, single ordinary words stay', () => {
  const tidy = text => formatDictation(text, {style: 'neutral'});
  assert.equal(tidy('Aber wenn ich Control Option mache, soll das schneller gehen.'), 'Aber wenn ich ⌃⌥ mache, soll das schneller gehen.');
  assert.equal(tidy('Drück Command K und dann Control Command V oder Command Shift P.'), 'Drück ⌘K und dann ⌃⌘V oder ⌘⇧P.');
  assert.equal(tidy('Drück Command Enter zum Senden und Shift Tab zurück.'), 'Drück ⌘↩ zum Senden und ⇧⇥ zurück.');
  assert.equal(tidy('Option A oder Option B, das ist die Frage. Shift ist eine Taste. Die Option löschen wir.'), 'Option A oder Option B, das ist die Frage. Shift ist eine Taste. Die Option löschen wir.');
});

test('a counted list in the middle of what was said is set out as a list; what follows it stays a sentence', () => {
  const tidy = text => formatDictation(text, {style: 'neutral'});
  assert.equal(tidy('Wir brauchen drei Dinge, erstens Milch, zweitens Brot und drittens Butter. Das wäre es dann.'), 'Wir brauchen drei Dinge:\n\n1. Milch\n2. Brot\n3. Butter\n\nDas wäre es dann.');
  assert.equal(tidy('Die Schritte sind Punkt eins Daten sichern, Punkt zwei App schließen, Punkt drei neu starten.'), 'Die Schritte sind:\n\n1. Daten sichern\n2. App schließen\n3. Neu starten');
  // Talking about the words, or whole sentences that need their words turned round: left to the model.
  assert.equal(tidy('Ich weiß nicht, ob man erstens oder zweitens sagt.'), 'Ich weiß nicht, ob man erstens oder zweitens sagt.');
  assert.equal(tidy('Erstens müssen wir testen. Zweitens müssen wir bauen.'), 'Erstens müssen wir testen. Zweitens müssen wir bauen.');
});

test('punctuation said aloud becomes the mark; the word itself stays where it is meant', () => {
  const tidy = text => formatDictation(text, {style: 'neutral'});
  assert.equal(tidy('Hallo Anna Komma wie geht es dir Fragezeichen neue Zeile ich komme morgen Punkt'), 'Hallo Anna, wie geht es dir?\nIch komme morgen.');
  assert.equal(tidy('Hallo Anna, Komma, wie geht es dir? Fragezeichen. Neuer Absatz. Bis morgen Ausrufezeichen'), 'Hallo Anna, wie geht es dir?\n\nBis morgen!');
  assert.equal(tidy('Wir brauchen Folgendes Doppelpunkt Milch Komma Brot Komma Butter Punkt'), 'Wir brauchen Folgendes: Milch, Brot, Butter.');
  assert.equal(tidy('Da fehlt ein Komma und das Fragezeichen ist falsch.'), 'Da fehlt ein Komma und das Fragezeichen ist falsch.');
  assert.equal(tidy('Das ist ein guter Punkt. Punkt eins ist klar.'), 'Das ist ein guter Punkt. Punkt eins ist klar.');
  assert.equal(tidy('Schreib in die neue Zeile etwas anderes.'), 'Schreib in die neue Zeile etwas anderes.');
});
