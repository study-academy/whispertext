// Run only against the isolated --hidden-preview --no-global-keys candidate, never the user's profile.
import assert from 'node:assert/strict';
assert.equal(process.env.STUDYMUT_ISOLATED_QA,'1','Explicit isolated QA acknowledgement is required');
const port=process.argv[2];assert.ok(/^\d+$/.test(port),'Pass the isolated CDP port');
const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page=pages.find(item=>item.type==='page'&&/^http:\/\/127.0.0.1/.test(item.url));assert.ok(page);
const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise(resolve=>ws.addEventListener('open',resolve,{once:true}));
let id=0;const requests=new Map();ws.addEventListener('message',event=>{const message=JSON.parse(event.data);requests.get(message.id)?.(message);requests.delete(message.id);});
const evaluate=expression=>new Promise((resolve,reject)=>{const requestId=++id;requests.set(requestId,message=>{if(message.result?.exceptionDetails)reject(Error(message.result.exceptionDetails.exception?.description));else resolve(message.result?.result?.value);});ws.send(JSON.stringify({id:requestId,method:'Runtime.evaluate',params:{expression,returnByValue:true,awaitPromise:true}}));});
let original;
try{
 original=await evaluate('window.studymut.state()');
 await evaluate('window.studymut.permissionSetup(false)');await evaluate('window.studymut.setMode("peek")');
 await evaluate('new Promise(resolve=>setTimeout(resolve,230))');
 const peek=await evaluate(`(()=>{const p=document.getElementById('peek'),r=p.getBoundingClientRect();return {mode:document.body.dataset.mode,width:r.width,height:r.height,inert:p.inert,fullInert:document.getElementById('centre').inert,buttons:[...p.querySelectorAll('button')].map(button=>button.getBoundingClientRect().height)}})()`);
 assert.equal(peek.mode,'peek');assert.equal(peek.width,320);assert.equal(peek.height,100);assert.equal(peek.inert,false);assert.equal(peek.fullInert,true);assert.ok(peek.buttons.every(height=>height>=44));
 await evaluate('document.getElementById("peek-open").click()');assert.equal((await evaluate('window.studymut.state()')).mode,'centre');
 await evaluate('window.studymut.setMode("peek")');await evaluate('document.getElementById("peek-settings").click()');assert.equal((await evaluate('window.studymut.state()')).settingsOpen,true);
 await evaluate('document.getElementById("haptics-enabled").click()');assert.equal((await evaluate('window.studymut.state()')).haptics,original.haptics===false);
 console.log(JSON.stringify({peek,explicitExpand:true,settings:true,hapticsToggle:true}));
}finally{
 if(original){await evaluate(`window.studymut.setHaptics(${original.haptics!==false})`);await evaluate(`window.studymut.permissionSetup(${!!original.permissionSetup?.active})`);await evaluate('window.studymut.setMode("rest")');}
 ws.close();
}
