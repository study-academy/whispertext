import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,statSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DictationStore,applyDictionary,Parakeet,reusesAhead} from '../main/dictation.js';
const withStore = fn => { const dir=mkdtempSync(join(tmpdir(),'studymut-test-'));try {fn(new DictationStore(join(dir,'dictation.json')));}finally{rmSync(dir,{recursive:true,force:true});} };
test('vocabulary and inferred suggestions remain separate from active replacements',()=>withStore(store=>{
 store.addWord('Pleura');store.addWord('Pleura');assert.deepEqual(store.data.words,['Pleura']);
 assert.equal(store.suggestRule('Plaura','Pleura','entry-1'),true);assert.equal(store.prepare('Plaura').text,'Plaura');
 assert.equal(store.suggestRule('Plaura','Andere','entry-2'),false);
 store.action('toggle-rule',{id:store.data.rules[0].id});assert.equal(store.prepare('Plaura').text,'Pleura');
 const loaded=new DictationStore(store.file);assert.deepEqual(loaded.data.words,['Pleura']);assert.equal(loaded.data.rules[0].source,'accepted-suggestion');
}));
test('snippet and replacement triggers cannot shadow each other',()=>withStore(store=>{
 store.saveSnippet('meine Adresse','Musterweg 1');assert.throws(()=>store.addRule('meine Adresse','etwas anderes'));
 store.addRule('Studi Mut','Studymut');assert.throws(()=>store.saveSnippet('Studi Mut','Text'));
}));
test('dictionary: Unicode boundaries, longest phrase, literal replacement, no cascades',()=>{
 const rules=[{from:'Study',to:'wrong',enabled:true},{from:'Study Academy',to:'Studyacademy',enabled:true},{from:'Ödem',to:'Schwellung',enabled:true},{from:'foo',to:'$& bar',enabled:true},{from:'bar',to:'BAZ',enabled:true}];
 assert.equal(applyDictionary('Study Academy, Ödem Ödematös foo',rules),'Studyacademy, Schwellung Ödematös $& bar');
 assert.equal(applyDictionary('foo',[{from:'foo',to:'x',enabled:false}]),'foo');
});
test('store preserves originals and measured metrics in private bounded history',()=>withStore(store=>{
 store.addRule('Studiemut','Studymut');const entry=store.record('Studiemut',{durationMs:1000,processingMs:42});store.inserted(entry.id,false);
 const loaded=new DictationStore(store.file);assert.equal(loaded.data.history[0].original,'Studiemut');assert.equal(loaded.data.history[0].final,'Studymut');assert.equal(loaded.data.history[0].appliedRules.length,1);assert.equal(loaded.data.history[0].processingMs,42);assert.equal(loaded.data.history[0].insertion,'not-inserted');assert.equal(statSync(store.file).mode & 0o777,0o600);
 for(let i=0;i<105;i++)store.record('hello',{durationMs:500,processingMs:1});assert.equal(store.data.history.length,100);
}));
test('learning requires saved user correction; rule edits preserve identity',()=>withStore(store=>{
 const entry=store.record('Studiemut macht Spaß',{durationMs:1000,processingMs:20});
 assert.throws(()=>store.action('learn',{id:entry.id,from:'Studiemut',to:'Studymut'}));
 store.action('correct',{id:entry.id,final:'Studymut macht Spaß'});store.action('learn',{id:entry.id,from:'Studiemut',to:'Studymut'});
 assert.equal(store.data.rules[0].source,'explicit-history-correction');const rule=store.data.rules[0];store.addRule('Studi Mut','Studymut','manual',null,rule.id);assert.equal(store.data.rules.length,1);assert.equal(store.data.rules[0].id,rule.id);
 assert.throws(()=>store.action('learn',{id:entry.id,from:'unrelated',to:'Studymut'}));
}));
test('privacy toggles and deletion survive reload',()=>withStore(store=>{
 store.addRule('foo','bar');store.update({historyEnabled:false,dictionaryEnabled:false});assert.equal(store.record('foo',{}).final,'foo');assert.equal(store.data.history.length,0);
 store.action('clear-dictionary');store.action('clear-history');assert.equal(new DictationStore(store.file).data.rules.length,0);
}));
test('missing runtime reports error; cancellation without process is safe',async()=>{const engine=new Parakeet('/missing/studymut-parakeet','/tmp/not-used');await assert.rejects(engine.request('transcribe',new Float32Array(5000)),/fehlt/);engine.cancel();});

test('overlapping rules report only the actual longest match',()=>withStore(store=>{
 store.addRule('Study','wrong');store.addRule('Study Academy','Studyacademy');
 const entry=store.record('Study Academy',{});assert.equal(entry.final,'Studyacademy');assert.deepEqual(entry.appliedRules.map(r=>r.from),['Study Academy']);
}));
test('cancelling keeps the model process warm; overlapping warm-up and dictation both resolve',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'studymut-engine-'));
 const helper=join(dir,'helper');
 writeFileSync(helper,'#!'+process.execPath+'\n'+`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify(r.type==='load'?{id:r.id,ready:true}:{id:r.id,text:'hallo',processingMs:3,pid:process.pid})+'\\n'),20);});`,{mode:0o700});
 const engine=new Parakeet(helper,dir);
 try {
  const [warm,first]=await Promise.all([engine.request('load'),engine.request('transcribe',new Float32Array(5000))]);
  assert.equal(warm.ready,true);assert.equal(first.text,'hallo');
  const dropped=engine.request('transcribe',new Float32Array(5000));engine.cancel();await assert.rejects(dropped,/Abgebrochen/);
  const again=await engine.request('transcribe',new Float32Array(5000));assert.equal(again.pid,first.pid);
 } finally {engine.stop();rmSync(dir,{recursive:true,force:true});}
});
test('native process cancellation rejects once and a fresh request cannot receive stale output',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'studymut-engine-'));
 const helper=join(dir,'helper');
 writeFileSync(helper,'#!'+process.execPath+'\n'+`const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);process.stdout.write(JSON.stringify({id:r.id,type:'progress',phase:'test',fraction:.5})+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,text:'fresh',processingMs:3})+'\\n'),80);});`,{mode:0o700});
 const engine=new Parakeet(helper,dir);
 try {
  const cancelled=engine.request('transcribe',new Float32Array(5000));engine.cancel();await assert.rejects(cancelled,/Abgebrochen/);
  const result=await engine.request('transcribe',new Float32Array(5000));assert.equal(result.text,'fresh');assert.equal(engine.status,'ready');
 } finally {engine.stop();rmSync(dir,{recursive:true,force:true});}
});

test('cancelled queued audio is never submitted to the native decoder',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'studymut-engine-queue-'));const helper=join(dir,'helper');const seen=join(dir,'seen');
 writeFileSync(helper,'#!'+process.execPath+'\n'+`const fs=require('node:fs'),rl=require('node:readline');rl.createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);fs.appendFileSync(${JSON.stringify(seen)},r.id+'\\n');setTimeout(()=>process.stdout.write(JSON.stringify({id:r.id,text:String(r.id)})+'\\n'),50);});`,{mode:0o700});
 const engine=new Parakeet(helper,dir);
 try {
  const first=engine.request('transcribe',new Float32Array(5000));
  const queued=engine.request('transcribe',new Float32Array(5000));
  const failures=Promise.all([assert.rejects(first,/Abgebrochen/),assert.rejects(queued,/Abgebrochen/)]);
  engine.cancel();await failures;
  const fresh=await engine.request('transcribe',new Float32Array(5000));assert.equal(fresh.text,'3');
  assert.deepEqual(readFileSync(seen,'utf8').trim().split('\n'),['1','3']);
 } finally {engine.stop();rmSync(dir,{recursive:true,force:true});}
});

test('the recogniser is warmed when the key goes down, but never over real work or twice in a row', async () => {
  const {Parakeet} = await import('../main/dictation.js');
  const p = new Parakeet('/nonexistent/helper', '/nonexistent/model');
  const sent = [];
  p.request = (type, audio) => { sent.push([type, audio.length]); return Promise.resolve({text: ''}); };
  assert.equal(p.warm(100_000), false); // no model loaded yet
  p.status = 'ready'; p.child = {};
  assert.equal(p.warm(100_000), true);
  assert.deepEqual(sent, [['transcribe', 4800]]);
  assert.equal(p.warm(105_000), false); // ran a moment ago
  assert.equal(p.warm(120_000), true);
  p.requests.set(1, {type: 'transcribe'});
  assert.equal(p.warm(200_000), false); // a real dictation is being recognised
});
test('a word fixed right after dictating is learned at once and used from the next dictation on',()=>withStore(store=>{
 assert.equal(store.learnRule('Plaura','Pleura','entry-1'),true);assert.equal(store.prepare('Die Plaura ist dünn.').text,'Die Pleura ist dünn.');
 assert.equal(store.data.rules[0].source,'learned');
 // Never against what the person wrote themselves, never a rule that only eats a word, and a waiting suggestion is switched on.
 store.addRule('Kitrat','Citrat');assert.equal(store.learnRule('Kitrat','Zitrat','entry-2'),false);assert.equal(store.prepare('Kitrat').text,'Citrat');
 assert.equal(store.learnRule('Der Lernforschung','Lernforschung','entry-3'),false);
 assert.equal(store.suggestRule('Hipokampus','Hippocampus','entry-4'),true);assert.equal(store.prepare('Hipokampus').text,'Hipokampus');
 assert.equal(store.learnRule('Hipokampus','Hippocampus','entry-5'),true);assert.equal(store.prepare('Hipokampus').text,'Hippocampus');
 assert.equal(store.data.rules.filter(rule=>rule.from==='Hipokampus').length,1);
}));

test('the release reuses the pause recognition only when nothing was said after it, for the same recording', () => {
  const ahead = {targetId: 't1', length: 16000 * 10};
  assert.equal(reusesAhead(ahead, {targetId: 't1', voiceUntil: 16000 * 9}), true);
  assert.equal(reusesAhead(ahead, {targetId: 't1', voiceUntil: 16000 * 10 - 800}), false); // sound right at its end
  assert.equal(reusesAhead(ahead, {targetId: 't2', voiceUntil: 16000}), false);
  assert.equal(reusesAhead(ahead, {targetId: 't1', voiceUntil: null}), false);
  assert.equal(reusesAhead(ahead, {targetId: 't1', voiceUntil: 100}, 16000), false);
  assert.equal(reusesAhead(null, {targetId: 't1', voiceUntil: 100}), false);
  assert.equal(reusesAhead({targetId: null, length: 99999}, {targetId: null, voiceUntil: 1}), false);
});
