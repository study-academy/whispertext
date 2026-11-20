import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../ui/notch.js',import.meta.url),'utf8').split('/* ---------- Recording and local transcription ---------- */')[1].split('/* ---------- Local controls ---------- */')[0];
function harness({streamPromise,contextThrows=false,dictatePromise=Promise.resolve({text:'test',inserted:true}),platform='darwin'}={}) {
 const calls=[],handle={dataset:{},style:{setProperty(){}}},body={dataset:{},style:{setProperty(){},removeProperty(){}}};let processor;
 const api={microphone:async()=>true,dictationState:async()=>({deviceId:'',engine:platform==='darwin'?'parakeet':'whisper'}),dictate:()=>{calls.push('dictate');return dictatePromise;},cancelDictation:()=>calls.push('cancel'),insert:async()=>{calls.push('insert');return {text:'x',inserted:true};},setMode:mode=>calls.push(mode),onGesture:fn=>{api.gesture=fn;}};
 class Context {constructor(){if(contextThrows)throw Error('context unavailable');this.closed=false;this.sampleRate=16000;this.audioWorklet={addModule:async()=>{}};}suspend(){return Promise.resolve();}resume(){return Promise.resolve();}createAnalyser(){return {fftSize:1024,frequencyBinCount:512,connect(){}};}createMediaStreamSource(){return {connect(){},disconnect(){}};}createScriptProcessor(){processor={connect(){}};return processor;}close(){this.closed=true;return Promise.resolve();}}
 class Worklet {constructor(_,__,options){processor=this;this.session=options.processorOptions.session;this.packets=0;this.samples=0;this.port={postMessage:message=>{if(message.type==='stop')this.port.onmessage?.({data:{type:'done',session:this.session,packets:this.packets,samples:this.samples}});}};}connect(){}disconnect(){}feed(){for(let i=0;i<12;i++){const audio=new Float32Array(640).fill(0.2);this.port.onmessage?.({data:{type:'audio',session:this.session,sequence:this.packets++,audio}});this.samples+=audio.length;}}}
 const scope={api,body,$:()=>handle,state:{platform,arch:'arm64',mode:'dictate'},navigator:{mediaDevices:{getUserMedia:()=>streamPromise}},AudioContext:Context,AudioWorkletNode:Worklet,silence(){},say(){},setMood(){},ask(){},notice(...args){calls.push(['notice',...args]);},clearNotice(){},startBars(){},bandRanges:()=>[],analyser:null,spectrum:null,ranges:[],clearTimeout(id){clearTimeout(id);},setTimeout(fn,ms){const id=setTimeout(fn,ms);id.unref?.();return id;},Float32Array,Promise,Map,Worker:class{ constructor(){harness.worker=this;}postMessage(message){if(message.type==='transcribe')this.request=message;} },console};
 vm.runInNewContext(source+'\nglobalThis.subject={startRecording,finishRecording,cancelRecording};',scope);
 return {...scope.subject,api,calls,handle,body,get processor(){return processor;}};
}
const stream=()=>{const track={stops:0,stop(){this.stops++;}};return {track,getTracks:()=>[track],getAudioTracks:()=>[track]};};
const flush=()=>new Promise(r=>setImmediate(r));
test('Fn release while microphone is pending drains the late stream and does not recognize an empty recording',async()=>{
 let resolve;const audio=stream();const h=harness({streamPromise:new Promise(r=>resolve=r)});
 const starting=h.startRecording('dictate');await flush();const finishing=h.finishRecording('dictate');resolve(audio);await starting;await finishing;
 assert.equal(audio.track.stops,1);assert.ok(!h.calls.includes('dictate'));
});
test('audio context initialization failure does not request microphone',async()=>{const audio=stream();const h=harness({streamPromise:Promise.resolve(audio),contextThrows:true});await h.startRecording('dictate');assert.equal(audio.track.stops,0);});
test('cancel during recognition prevents stale UI completion',async()=>{
 let resolve;const audio=stream();const h=harness({streamPromise:Promise.resolve(audio),dictatePromise:new Promise(r=>resolve=r)});
 await h.startRecording('dictate');h.processor.feed();
 const finishing=h.finishRecording('dictate');for(let i=0;i<10&&!h.calls.includes('dictate');i++)await flush();assert.ok(h.calls.includes('dictate'));h.cancelRecording();const count=h.calls.length;resolve({text:'late result',inserted:true});await finishing;
 assert.equal(h.calls.length,count);assert.equal(h.body.dataset.busy,undefined);assert.equal(audio.track.stops,1);assert.equal(h.calls.filter(c=>c==='cancel').length,1);
});
test('non-Escape gesture cancellation returns the dictation pill to rest',async()=>{const audio=stream();const h=harness({streamPromise:Promise.resolve(audio)});await h.startRecording('dictate');h.api.gesture({type:'cancel'});assert.ok(h.calls.includes('rest'));assert.equal(audio.track.stops,1);});

