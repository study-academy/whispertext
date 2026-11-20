import assert from 'node:assert/strict';
const [port,output]=process.argv.slice(2);
const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();const page=pages.find(p=>p.type==='page'&&/^http:\/\/127.0.0.1/.test(p.url));
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));let id=0;const requests=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);requests.get(m.id)?.(m);requests.delete(m.id);});
const send=(method,params={})=>new Promise(r=>{requests.set(++id,r);ws.send(JSON.stringify({id,method,params}));});
const evaluate=async expression=>{const m=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(m.result?.exceptionDetails)throw Error(m.result.exceptionDetails.exception?.description);return m.result?.result?.value;};
try{
 await evaluate('window.studymut.permissionSetup(true)');
 await evaluate('new Promise(r=>setTimeout(r,800))');
 assert.equal((await evaluate('window.studymut.state()')).mode,'centre');
 const info=await evaluate(`(()=>{const p=document.getElementById('settings').getBoundingClientRect(),b=document.getElementById('permission-primary').getBoundingClientRect(),f=document.getElementById('permission-later').getBoundingClientRect();return {userAgent:navigator.userAgent,card:{width:p.width,height:p.height},primaryVisible:b.top>=p.top&&b.bottom<=p.bottom,footerVisible:f.bottom<=p.bottom,clickHeights:[...document.querySelectorAll('.permission-select,#permission-primary,#permission-settings')].filter(n=>!n.hidden).map(n=>n.getBoundingClientRect().height),step:document.getElementById('permission-step-title').textContent,grid:getComputedStyle(document.getElementById('permission-steps')).display};})()`);
 console.log(JSON.stringify(info));assert.equal(info.card.width,576);assert.equal(info.card.height,480);assert.equal(info.primaryVisible,true);assert.equal(info.footerVisible,true);assert.ok(info.clickHeights.every(h=>h>=44));
 await evaluate('window.studymut.permissionSetup(false)');assert.equal((await evaluate('window.studymut.state()')).permissionSetup.active,false);
 await evaluate('window.studymut.permissionSetup(true)');assert.equal((await evaluate('window.studymut.state()')).permissionSetup.active,true);
 for(let i=0;i<12;i++){await evaluate('window.studymut.setMode("rest")');await evaluate('window.studymut.setMode("centre")');}
 const state=await evaluate('window.studymut.state()');assert.equal(state.mode,'centre');assert.equal(state.settingsOpen,true);console.log('rapid-open-close',JSON.stringify({cycles:12,mode:state.mode,setupActive:state.permissionSetup.active}));
 await evaluate('new Promise(r=>setTimeout(r,300))');
 if(output){const {writeFile}=await import('node:fs/promises');const shot=await send('Page.captureScreenshot',{format:'png'});await writeFile(output,Buffer.from(shot.result.data,'base64'));}
}finally{ws.close();}
