import {spawn,execFileSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import assert from 'node:assert/strict';
const [port,helper]=process.argv.slice(2);
const targets=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=targets.find(t=>t.type==='page'&&/^https?:\/\/127\.0\.0\.1/.test(t.url));
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const requests=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);requests.get(m.id)?.(m);requests.delete(m.id);});
const send=(method,params={})=>new Promise(r=>{requests.set(++id,r);ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>(await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true})).result.result.value;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let child;
try {
 await evaluate('window.studymut.setMode("write")');
 await send('Page.bringToFront');
 await delay(400);
 await evaluate('(()=>{const field=document.createElement("textarea");field.id="native-paste-test";field.setAttribute("aria-label","Isoliertes natives Einfügetestfeld");document.querySelector(".bubble").prepend(field);field.focus();return true;})()');
 await delay(200);
 const fingerprint=()=>execFileSync('/tmp/studymut-clipboard-fingerprint',[],{encoding:'utf8'}).trim();
 const before=fingerprint();
 child=spawn(helper,["--diagnose"],{stdio:['pipe','pipe','inherit']});const lines=createInterface({input:child.stdout});
 let resolvePaste;const result=new Promise(r=>resolvePaste=r);lines.on('line',line=>{try{const event=JSON.parse(line);if(event.type==='paste')resolvePaste(event); else if(event.type==='target-diagnostic')console.log(JSON.stringify(event));}catch{}});
 child.stdin.write('capture-target\n');await delay(150);child.stdin.write('paste-text 1 '+(Date.now()+1800)+' '+Buffer.from('Studymut native paste test').toString('base64')+'\n');
 const pasted=await Promise.race([result,delay(3000).then(()=>({ok:false,timeout:true}))]);
 await delay(1000);
 const value=await evaluate('document.getElementById("native-paste-test").value');
 const restored=fingerprint()===before;
 console.log(JSON.stringify({pasted,fieldMatches:value==='Studymut native paste test',allClipboardFormatsRestored:restored}));
 assert.equal(pasted.ok,true);assert.equal(value,'Studymut native paste test');assert.equal(restored,true);
 // Changed focused field must refuse a paste and leave clipboard alone.
 child.stdin.write('capture-target\n');await delay(100);await evaluate('(()=>{const field=document.createElement("textarea");field.id="native-second-test";document.querySelector(".bubble").prepend(field);field.focus();return document.activeElement.id;})()');await delay(300);resolvePaste=undefined;
 const refusal=new Promise(r=>{resolvePaste=r;});child.stdin.write('paste-text 1 '+(Date.now()+1800)+' '+Buffer.from('must not insert').toString('base64')+'\n');
 const denied=await Promise.race([refusal,delay(3000).then(()=>({timeout:true}))]);console.log('focus-change',JSON.stringify(denied));assert.equal(denied.ok,false);assert.equal(fingerprint(),before);
 // Secure fields and expired/cancelled requests must leave the pasteboard untouched.
 await evaluate('(()=>{const input=document.createElement("input");input.type="password";input.id="native-secure-test";document.querySelector(".bubble").prepend(input);input.focus();})()');
 await delay(300);child.stdin.write('capture-target\n');await delay(100);
 let securePromise=new Promise(r=>resolvePaste=r);child.stdin.write('paste-text 2 '+(Date.now()+1800)+' '+Buffer.from('must not insert').toString('base64')+'\n');
 const secure=await securePromise;console.log('secure-field',JSON.stringify(secure));assert.equal(secure.ok,false);assert.equal(secure.reason,'secure-field');assert.equal(fingerprint(),before);
 await evaluate('document.getElementById("native-paste-test").focus()');await delay(300);child.stdin.write('capture-target\n');await delay(100);
 const expiredPromise=new Promise(r=>resolvePaste=r);child.stdin.write('paste-text 3 '+(Date.now()-1)+' '+Buffer.from('expired').toString('base64')+'\n');
 const expired=await expiredPromise;console.log('expired',JSON.stringify(expired));assert.equal(expired.ok,false);assert.equal(expired.reason,'expired');assert.equal(fingerprint(),before);
 child.stdin.write('capture-target\nclear-target\n');await delay(100);
 const cancelledPromise=new Promise(r=>resolvePaste=r);child.stdin.write('paste-text 4 '+(Date.now()+1800)+' '+Buffer.from('cancelled').toString('base64')+'\n');
 const cancelled=await cancelledPromise;console.log('cancelled-target',JSON.stringify(cancelled));assert.equal(cancelled.ok,false);assert.equal(fingerprint(),before);
 // A graceful termination before the normal 800ms timer must restore immediately.
 child.stdin.write('capture-target\n');await delay(100);
 const earlyExitPromise=new Promise(r=>resolvePaste=r);child.stdin.write('paste-text 5 '+(Date.now()+1800)+' '+Buffer.from('exit restoration test').toString('base64')+'\n');
 const early=await earlyExitPromise;assert.equal(early.ok,true);child.kill('SIGTERM');await delay(300);
 console.log('early-exit-clipboard-restored',fingerprint()===before);assert.equal(fingerprint(),before);
} finally {await delay(1000);child?.kill();await evaluate('document.getElementById("native-paste-test")?.remove();document.getElementById("native-secure-test")?.remove();document.getElementById("native-second-test")?.remove()');ws.close();}
