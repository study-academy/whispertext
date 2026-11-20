import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../ui/dictation-capture-worklet.js', import.meta.url), 'utf8');
function capture() {
  let Processor;
  const messages = [];
  class Base { constructor() { this.port = {postMessage: message => messages.push(message)}; } }
  vm.runInNewContext(source, {AudioWorkletProcessor: Base, Float32Array, registerProcessor: (_, value) => { Processor = value; }});
  const processor = new Processor({processorOptions: {session: 42}});
  const send = (type, session = 42) => processor.port.onmessage({data: {type, session}});
  const feed = (count, value = 0.2) => { for (let i = 0; i < count; i++) processor.process([[new Float32Array(128).fill(value)]]); };
  send('start');
  return {processor, messages, send, feed};
}
const packets = messages => messages.filter(message => message.type === 'audio');

test('capture sends ordered 40ms packets and flushes final voiced samples before its done acknowledgement', () => {
  const {messages, send, feed} = capture();
  feed(7);
  send('stop');
  feed(32); // Tail is bounded to exactly 2400 samples, not a timer or entire extra render block.
  const audio = packets(messages);
  assert.equal(audio.reduce((n, message) => n + message.audio.length, 0), 896 + 2400);
  assert.deepEqual(audio.map(message => message.sequence), audio.map((_, i) => i));
  assert.ok(audio.slice(0, -1).every(message => message.audio.length === 640));
  assert.equal(audio.at(-1).audio.length, 96);
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(messages.at(-1).samples, 3296);
  assert.equal(messages.at(-1).packets, audio.length);
});

test('already sustained silence needs no fixed release delay and the partial packet is retained', () => {
  const {messages, send, feed} = capture();
  feed(1);
  feed(17, 0);
  send('stop');
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(messages.at(-1).samples, 2304);
  assert.equal(packets(messages).at(-1).audio.length, 384);
});

test('a release overlapping speech waits for sustained quiet and never omits the final captured syllable', () => {
  const {messages, send, feed} = capture();
  feed(5);
  send('stop');
  feed(3, 0.1);
  assert.equal(messages.at(-1).type, 'audio');
  feed(15, 0);
  assert.equal(messages.at(-1).type, 'done');
  assert.equal(messages.at(-1).samples, 640 + 384 + 960);
  assert.ok(packets(messages).flatMap(message => [...message.audio]).slice(640, 1024).every(value => value > 0));
});

test('the key click after release ends the recording before it; loud speech at release is kept', () => {
  const click = capture();
  click.feed(5);
  click.send('stop');
  click.feed(3, 0.005);
  click.processor.process([[new Float32Array(128).fill(0.9)]]);
  assert.equal(click.messages.at(-1).type, 'done');
  assert.equal(click.messages.at(-1).samples, 640 + 384);
  assert.ok(packets(click.messages).flatMap(message => [...message.audio]).every(value => value < 0.5));
  const loud = capture();
  loud.feed(5);
  loud.send('stop');
  loud.feed(1, 0.5);
  assert.equal(loud.messages.at(-1).type, 'audio');
  assert.equal(loud.processor.samples, 640 + 128);
});

test('cancel discards buffered audio, rejects foreign-session control and cannot resume', () => {
  const {messages, processor, send, feed} = capture();
  feed(1);
  send('stop', 999);
  assert.equal(messages.length, 0);
  send('cancel');
  feed(20);
  send('start');
  feed(20);
  assert.deepEqual(messages.map(message => message.type), ['cancelled']);
  assert.equal(processor.samples, 128);
});

test('invalid samples fail closed and long capture cannot exceed the recognizer 120-second limit', () => {
  const bad = capture();
  bad.processor.process([[new Float32Array([NaN])]]);
  assert.equal(bad.messages.at(-1).type, 'error');
  const long = capture();
  long.processor.samples = 1920000 - 128;
  long.feed(2);
  assert.equal(long.messages.at(-1).type, 'done');
  assert.equal(long.messages.at(-1).samples, 1920000);
});

// Exercise the actual UI capture functions with deterministic microphone/worklet boundaries.
const notch = readFileSync(new URL('../ui/notch.js', import.meta.url), 'utf8');
function captureUI({deferMicrophone = false, deferPreparation = false, acknowledge = true} = {}) {
  const timers = new Map(), calls = [], tracks = [], nodes = [];
  let timerID = 0, resolveMicrophone, resolvePreparation;
  const preparation = deferPreparation ? new Promise(resolve => { resolvePreparation = resolve; }) : Promise.resolve();
  const stream = {getTracks: () => tracks, getAudioTracks: () => tracks};
  tracks.push({stop() { this.stopped = true; }, onended: null});
  const microphone = deferMicrophone ? new Promise(resolve => { resolveMicrophone = resolve; }) : Promise.resolve(stream);
  const node = () => ({connect() {}, disconnect() {}, fftSize: 1024, frequencyBinCount: 512});
  class Context {
    sampleRate = 16000;
    audioWorklet = {addModule: async path => { calls.push(['module', path]); await preparation; }};
    createMediaStreamSource() { return node(); }
    createAnalyser() { return node(); }
    suspend() { calls.push(['suspend']); return Promise.resolve(); }
    resume() { return Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
  }
  class Worklet {
    constructor(_, __, options) {
      this.session = options.processorOptions.session;
      this.port = {onmessage: null, postMessage: message => {
        calls.push(['control', message]);
        if (message.type === 'stop' && acknowledge) this.emit({type: 'done', packets: this.packets ?? 0, samples: this.samples ?? 0});
      }};
      nodes.push(this);
    }
    connect() {}
    disconnect() {}
    emit(data) { this.port.onmessage?.({data: {session: this.session, ...data}}); }
    audio(value = 0.2) {
      this.emit({type: 'audio', sequence: this.packets ?? 0, audio: new Float32Array(640).fill(value)});
      this.packets = (this.packets ?? 0) + 1;
      this.samples = (this.samples ?? 0) + 640;
    }
  }
  const sandbox = {
    AudioContext: Context, AudioWorkletNode: Worklet, Float32Array, Uint8Array, Date, performance,
    navigator: {mediaDevices: {getUserMedia: () => { calls.push(['microphone']); return microphone; }}},
    setTimeout(fn, delay) { const id = ++timerID; timers.set(id, {fn, delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    silence() {}, clearNotice() { calls.push(['clear-notice']); }, startBars() { calls.push(['bars']); }, bandRanges: () => [], setMood() {},
    notice: type => calls.push(['notice', type]),
    body: {dataset: {}}, state: {mode: 'dictate'},
    api: {
      microphone: async () => true, dictationState: async () => ({engine: 'parakeet', modelStatus: 'ready'}),
      setMode: mode => calls.push(['mode', mode]), cancelDictation() {}, agentDismiss() {},
      dictate: async (audio, metadata) => { calls.push(['dictate', audio.length, metadata]); return {inserted: true}; },
    },
  };
  sandbox.captureConfig = () => sandbox.api.dictationState();
  const context = vm.createContext(sandbox);
  vm.runInContext(`let recording=null,captureSession=0,generation=0,processing=false,analyser=null,spectrum,ranges; let engineName='parakeet',selectedLanguage='auto'; const engine=async()=>engineName;
${notch.slice(notch.indexOf('let preparedCapture = null,'), notch.indexOf('api.onGesture(effect'))}
globalThis.captureAPI={prepareCapture,startRecording,showRecording,finishRecording,cancelRecording,dropRecording,get current(){return recording;}};`, context);
  return {api: sandbox.captureAPI, calls, nodes, tracks, ready: () => new Promise(setImmediate), acquire: () => resolveMicrophone(stream), prepared: () => resolvePreparation(), expire(delay) { for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.fn(); } }};
}

test('cancelling while microphone acquisition is pending closes late stream and cannot publish capture', async () => {
  const ui = captureUI({deferMicrophone: true});
  const start = ui.api.startRecording('dictate');
  await ui.ready();
  ui.api.cancelRecording();
  ui.acquire();
  await start;
  assert.equal(ui.api.current, null);
  assert.ok(ui.tracks.every(track => track.stopped));
  assert.equal(ui.nodes.length, 0);
});

test('finish waits for final worklet acknowledgement, passes timings and ignores stale-session audio', async () => {
  const ui = captureUI();
  await ui.api.startRecording('dictate', 71);
  const processor = ui.nodes[0];
  processor.emit({type: 'audio', session: -1, sequence: 0, audio: new Float32Array(640)});
  for (let i = 0; i < 8; i++) processor.audio();
  await ui.api.finishRecording();
  const result = ui.calls.find(call => call[0] === 'dictate');
  assert.equal(result[1], 5120);
  assert.equal(result[2].targetId, 71);
  assert.ok(result[2].audioReadyAt >= result[2].stoppedAt);
  assert.ok(result[2].recordingStartedAt <= result[2].stoppedAt);
  assert.ok(ui.tracks.every(track => track.stopped));
  assert.equal(ui.api.current, null);
});

test('missing stop acknowledgement fails boundedly without transcribing incomplete audio', async () => {
  const ui = captureUI({acknowledge: false});
  await ui.api.startRecording('dictate');
  for (let i = 0; i < 8; i++) ui.nodes[0].audio();
  const finishing = ui.api.finishRecording();
  await ui.ready();
  ui.expire(1500);
  await finishing;
  assert.equal(ui.api.current, null);
  assert.ok(ui.tracks.every(track => track.stopped));
  assert.ok(!ui.calls.some(call => call[0] === 'dictate'));
  assert.ok(ui.calls.some(call => call[0] === 'notice' && call[1] === 'microphone'));
});

test('packet discontinuity closes capture instead of recognizing a silently incomplete recording', async () => {
  const ui = captureUI();
  await ui.api.startRecording('dictate');
  ui.nodes[0].emit({type: 'audio', sequence: 2, audio: new Float32Array(640)});
  assert.equal(ui.api.current, null);
  assert.ok(ui.tracks.every(track => track.stopped));
  assert.ok(!ui.calls.some(call => call[0] === 'dictate'));
});

test('microphone startup watchdog retires the session and closes a later permission/device result', async () => {
  const ui = captureUI({deferMicrophone: true});
  const starting = ui.api.startRecording('dictate');
  await ui.ready();
  ui.expire(5000);
  assert.equal(ui.api.current, null);
  ui.acquire();
  await starting;
  assert.ok(ui.tracks.every(track => track.stopped));
  assert.equal(ui.nodes.length, 0);
});

test('stop acknowledgement with missing sample coverage is rejected', async () => {
  const ui = captureUI({acknowledge: false});
  await ui.api.startRecording('dictate');
  ui.nodes[0].audio();
  ui.nodes[0].emit({type: 'done', packets: 1, samples: 639});
  assert.equal(ui.api.current, null);
  assert.ok(ui.tracks.every(track => track.stopped));
  assert.ok(!ui.calls.some(call => call[0] === 'dictate'));
});

test('idle graph preloading suspends output, reuses its module and never requests a microphone', async () => {
  const ui = captureUI();
  const first = ui.api.prepareCapture();
  assert.equal(ui.api.prepareCapture(), first);
  await first.ready;
  assert.equal(ui.calls.filter(call => call[0] === 'module').length, 1);
  assert.equal(ui.calls.filter(call => call[0] === 'suspend').length, 1);
  assert.ok(!ui.calls.some(call => call[0] === 'microphone'));
  await ui.api.startRecording('dictate');
  assert.equal(ui.calls.filter(call => call[0] === 'module').length, 1);
  assert.equal(ui.calls.filter(call => call[0] === 'microphone').length, 1);
  ui.api.cancelRecording();
});

test('cancelling while graph module preparation is pending cannot publish late recording nodes', async () => {
  const ui = captureUI({deferPreparation: true});
  const starting = ui.api.startRecording('dictate');
  await ui.ready();
  ui.api.cancelRecording();
  ui.prepared();
  await starting;
  assert.equal(ui.api.current, null);
  assert.equal(ui.nodes.length, 0);
  assert.ok(ui.tracks.every(track => track.stopped));
});

test('the bars come at once; no words while the microphone starts, not even after a second', async () => {
  const ui = captureUI();
  await ui.api.startRecording('dictate');
  ui.api.showRecording('dictate');
  assert.equal(ui.calls.filter(call => call[0] === 'bars').length, 1);
  assert.ok(!ui.calls.some(call => call[0] === 'notice'));
  ui.nodes[0].audio();
  ui.expire(1000);
  assert.ok(!ui.calls.some(call => call[0] === 'notice'));
  ui.api.cancelRecording();

  const slow = captureUI();
  await slow.api.startRecording('dictate');
  slow.api.showRecording('dictate');
  slow.expire(1000);
  assert.ok(!slow.calls.some(call => call[0] === 'notice'));
  slow.api.cancelRecording();
});
