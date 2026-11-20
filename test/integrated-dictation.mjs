import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const [port,file]=process.argv.slice(2);
const bytes=readFileSync(file);let offset=12,pcm;
while(offset+8<=bytes.length){const size=bytes.readUInt32LE(offset+4);if(bytes.toString('ascii',offset,offset+4)==='data'){pcm=bytes.subarray(offset+8,offset+8+size);break;}offset+=8+size+(size%2);}
const samples=new Float32Array(pcm.length/2);for(let i=0;i<samples.length;i++)samples[i]=pcm.readInt16LE(i*2)/32768;
const encoded=Buffer.from(samples.buffer).toString('base64');
const pages=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=pages.find(t=>t.type==='page'&&/^http:\/\/127.0.0.1/.test(t.url));
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let id=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m);pending.delete(m.id);});
const evaluate=expression=>new Promise((resolve,reject)=>{pending.set(++id,m=>m.result?.exceptionDetails?reject(Error(m.result.exceptionDetails.exception?.description)):resolve(m.result?.result?.value));ws.send(JSON.stringify({id,method:'Runtime.evaluate',params:{expression,awaitPromise:true,returnByValue:true}}));});
const dictate=()=>evaluate(`(()=>{const raw=atob('${encoded}');const bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));return window.studymut.dictate(new Float32Array(bytes.buffer));})()`);
try {
 await evaluate('window.studymut.cancelDictation()');
 await evaluate('window.studymut.dictationSettings({historyEnabled:true,dictionaryEnabled:true,language:"de"})');
 const started=performance.now();const first=await dictate();const firstWallMs=performance.now()-started;
 console.log('first-cold-ipc',JSON.stringify({...first,wallMs:firstWallMs}));assert.ok(first.text?.includes('Wörterbuch'));assert.equal(first.inserted,false);
 let data=await evaluate('window.studymut.dictationState()');const entry=data.history[0];assert.equal(entry.original,entry.final);assert.equal(entry.language,'de');assert.equal(entry.insertion,'not-inserted');
 const final=entry.original.replace(/StudioMod/gi,'Studymut');assert.notEqual(final,entry.original);
 await evaluate(`window.studymut.dictationAction('correct',${JSON.stringify({id:entry.id,final})})`);
 await evaluate(`window.studymut.dictationAction('learn',${JSON.stringify({id:entry.id,from:'StudioMod',to:'Studymut'})})`);
 const warm=performance.now();const second=await dictate();const warmWallMs=performance.now()-warm;data=await evaluate('window.studymut.dictationState()');
 assert.equal(second.text,final);assert.equal(data.history[0].original,entry.original);assert.ok(data.history[0].appliedRules.some(r=>r.from==='StudioMod'));assert.ok(data.rules.some(r=>r.source==='explicit-history-correction'));
 console.log('warm-ipc-with-learned-rule',JSON.stringify({text:second.text,wallMs:warmWallMs,history:data.history[0],recoveryAvailable:!!data.recovery}));
 await evaluate('window.studymut.dictationSettings({dictionaryEnabled:false,historyEnabled:false})');const count=data.history.length;
 const third=await dictate();data=await evaluate('window.studymut.dictationState()');assert.equal(third.text,entry.original);assert.equal(data.history.length,count);assert.equal(data.recovery,entry.original);
 console.log('privacy-off',JSON.stringify({dictionaryBypassed:third.text===entry.original,historyCountUnchanged:data.history.length===count,recoveryAvailable:!!data.recovery}));
 await evaluate('window.studymut.dictationSettings({dictionaryEnabled:true,historyEnabled:true})');
 await evaluate('window.studymut.setMode("centre").then(()=>window.studymut.setSettingsOpen(true))');
} finally {ws.close();}
