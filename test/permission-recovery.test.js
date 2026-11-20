import test from 'node:test';
import assert from 'node:assert/strict';
import {PermissionFlow,PRIVACY_PAGES} from '../main/permissions.js';

const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function harness({timeout=25,microphoneRequest,openSettings,refreshKeys}={}){
 let microphone='not-determined';const calls=[],changes=[];
 const keys={input:false,accessibility:false,listening:false};
 const flow=new PermissionFlow({readMicrophone:()=>microphone,requestMicrophone:()=>{calls.push('request-microphone');return microphoneRequest?.()??Promise.resolve(false);},
  keys:{refreshPermissions:()=>refreshKeys?.()??Promise.resolve({...keys}),askInput:()=>calls.push('request-input'),askAccessibility:()=>calls.push('request-accessibility')},
  openExternal:url=>{calls.push(url);return openSettings?.(url)??Promise.resolve();},onChange:state=>changes.push(state),actionTimeoutMs:timeout});
 return {flow,calls,changes,microphone:value=>{microphone=value;},keys};
}

test('a pending native consent request returns promptly and duplicate clicks do not create another request',async()=>{
 const native=deferred(),h=harness({microphoneRequest:()=>native.promise});
 try{const state=await h.flow.action('microphone');assert.equal(state.requestPending,true);assert.equal(state.requestStatus,'waiting');await h.flow.action('microphone');assert.equal(h.calls.filter(x=>x==='request-microphone').length,1);}finally{h.flow.close();native.resolve(false);await flush();}
});

test('observed microphone grant progresses to Accessibility even if the old native promise never settles',async()=>{
 const native=deferred(),h=harness({microphoneRequest:()=>native.promise});
 try{await h.flow.action('microphone');h.microphone('granted');await h.flow.refresh();assert.equal(h.flow.state().requestPending,false);assert.equal(h.flow.state().step,'accessibility');await h.flow.action('accessibility');assert.ok(h.calls.includes('request-accessibility'));}finally{h.flow.close();native.resolve(true);await flush();}
});

test('native request timeout releases waiting UI without blindly issuing the same OS request again',async()=>{
 const native=deferred(),h=harness({microphoneRequest:()=>native.promise,timeout:20});
 try{await h.flow.action('microphone');await wait(35);assert.equal(h.flow.state().requestPending,false);assert.equal(h.flow.state().requestStatus,'timed-out');assert.ok(h.flow.state().actionError);await h.flow.action('microphone');assert.equal(h.calls.filter(x=>x==='request-microphone').length,1);await h.flow.action('microphone',true);assert.ok(h.calls.includes(PRIVACY_PAGES.microphone));}finally{h.flow.close();native.resolve(false);await flush();}
});

test('an unresponsive helper leaves grant knowledge intact but never reports the listener ready',async()=>{
 const h=harness({refreshKeys:async()=>{throw Object.assign(Error('fixture timeout'),{code:'PERMISSION_TIMEOUT'});}});
 try{h.microphone('granted');h.flow.setKeys({input:true,accessibility:true,listening:true});await h.flow.refresh();assert.equal(h.flow.state().input,true);assert.equal(h.flow.state().accessibility,true);assert.equal(h.flow.state().helperStatus,'unresponsive');assert.equal(h.flow.state().step,'listener');assert.ok(h.flow.state().actionError);}finally{h.flow.close();}
});

test('actual denial stays denied and the next explicit action opens settings instead of repeating consent',async()=>{
 let h;h=harness({microphoneRequest:async()=>{h.microphone('denied');return false;}});
 try{await h.flow.action('microphone');await flush();assert.equal(h.flow.state().microphone,'denied');assert.equal(h.flow.state().step,'microphone');await h.flow.action('microphone');await flush();assert.equal(h.calls.filter(x=>x==='request-microphone').length,1);assert.ok(h.calls.includes(PRIVACY_PAGES.microphone));}finally{h.flow.close();}
});

test('settings opener failure becomes a recoverable state and does not hang the caller',async()=>{
 const h=harness({openSettings:async()=>{throw Error('fixture opener failed');}});
 try{await h.flow.action('input',true);await flush();assert.equal(h.flow.state().requestPending,false);assert.equal(h.flow.state().requestStatus,'error');assert.ok(h.flow.state().actionError);assert.equal(h.calls.filter(x=>x===PRIVACY_PAGES.input).length,1);}finally{h.flow.close();}
});

test('late native completion after close cannot restart polling or publish action results',async()=>{
 const native=deferred(),h=harness({microphoneRequest:()=>native.promise});
 await h.flow.action('microphone');await flush();h.flow.close();const changes=h.changes.length;native.resolve(true);await flush();assert.equal(h.flow.state().polling,false);assert.equal(h.changes.length,changes);
});

test('reopening observation survives late completion from the previous native action',async()=>{
 const native=deferred(),h=harness({microphoneRequest:()=>native.promise});
 try{await h.flow.action('microphone');h.flow.watch(false);h.flow.watch(true,true);native.resolve(false);await flush();assert.equal(h.flow.state().polling,true);}finally{h.flow.close();}
});

test('pending native action observes grant even while the collapsed renderer stops its ordinary watcher',async()=>{
 const native=deferred(),h=harness({microphoneRequest:()=>native.promise,timeout:1600});
 try{await h.flow.action('microphone');h.flow.watch(false);h.microphone('granted');await wait(1120);assert.equal(h.flow.state().microphone,'granted');assert.equal(h.flow.state().requestPending,false);assert.equal(h.calls.filter(x=>x==='request-microphone').length,1);}finally{h.flow.close();native.resolve(true);await flush();}
});

test('switching to another permission does not forget an unresolved microphone consent request',async()=>{
 const native=deferred(),h=harness({microphoneRequest:()=>native.promise});
 try{
  await h.flow.action('microphone');
  await h.flow.action('input');await flush();
  await h.flow.action('microphone');
  assert.equal(h.calls.filter(x=>x==='request-microphone').length,1);
 }finally{h.flow.close();native.resolve(false);await flush();}
});
