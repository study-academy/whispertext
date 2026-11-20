import assert from 'node:assert/strict';
assert.equal(process.env.STUDYMUT_ISOLATED_QA, '1', 'Use an isolated profile only');
const port = process.argv[2];
assert.match(port ?? '', /^\d+$/);
const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page=pages.find(p=>/^http:\/\/127.0.0.1:\d+\/$/.test(p.url));
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let id=0;const pending=new Map();const errors=[];
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails);pending.get(m.id)?.(m);pending.delete(m.id);});
const send=(method,params={})=>new Promise(r=>{const n=++id;pending.set(n,r);ws.send(JSON.stringify({id:n,method,params}));});
const ev=async expression=>{const m=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(m.result.exceptionDetails)throw Error(JSON.stringify(m.result.exceptionDetails));return m.result.result.value;};
await send('Runtime.enable');
try {
 await ev('window.studymut.permissionSetup(false)');await ev('window.studymut.setSettingsOpen(true)');
 const results=await ev(`(()=>{const results=[];for(const tile of document.querySelectorAll('.tile')){if(['dictation','history','dictionary','snippets','styles'].includes(tile.dataset.page))continue;tile.click();const section=document.querySelector('.page[data-page="'+tile.dataset.page+'"]');results.push({page:tile.dataset.page,visible:!section.hidden,title:document.querySelector('.settings-head .title').textContent});document.getElementById('settings-back').click();}return results;})()`);
 assert.ok(results.every(r=>r.visible));
 const routes=[];for(const place of ['heute','cards','board','tools']){await ev(`window.studymut.openPlace('${place}')`);await new Promise(r=>setTimeout(r,900));routes.push({place,state:(await ev('window.studymut.state()')).webLoad});}
 console.log(JSON.stringify({settings:results,routes,errors},null,2));
} finally {ws.close();}
