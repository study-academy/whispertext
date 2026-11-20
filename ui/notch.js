// whispertext under the notch: the strich, the voice while dictating, short notices, and the dark row that opens
// from the strich into the history and the words. A missing permission and the intro show in the same row.
import {Segmenter} from './lib/segmenter.js';

const api = window.studymut;
const $ = id => document.getElementById(id);
const body = document.body;
const escapeText = value => String(value ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);

let state = await api.state();
let data = {history: [], audio: [], words: [], rules: [], snippets: []};

/* ---------- State ---------- */
function render() {
  body.dataset.mode = state.mode;
  body.dataset.page = state.page;
  if (state.hushed) body.dataset.hushed = ''; else delete body.dataset.hushed;
  // Not during a dictation: the practice field must keep the focus while the voice shows.
  $('row').inert = state.mode === 'rest';
  for (const button of document.querySelectorAll('.ico')) button.setAttribute('aria-pressed', String(state.mode === 'open' && button.dataset.page === state.page));
  $('missing-dot').hidden = !state.missing;
  renderStep();
  requestAnimationFrame(reportRow);
}
api.onState(next => {
  const opened = next.mode === 'open' && (state.mode !== 'open' || next.page !== state.page);
  state = next;
  render();
  if (opened) refresh();
  if (state.mode !== 'open') closeSearch();
  if (state.mode !== 'rest') delete body.dataset.hover;
  if (state.mode === 'dictate') startBars();
  else setLocked(false);
});
api.onHover(progress => {
  if (progress > 0) body.dataset.hover = ''; else delete body.dataset.hover;
  body.style.setProperty('--hover', progress);
});
// Only the row takes clicks: main is told where it is whenever it changes.
function reportRow() {
  const box = ['row', 'open', 'setup'].includes(state.mode) ? $('row').getBoundingClientRect() : null;
  api.rowRegion(box && box.width > 20 ? {x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height)} : null);
}
new ResizeObserver(reportRow).observe($('row'));

/* Only protection booleans cross IPC; text stays inside this renderer. */
let reported = '';
function reportInteraction() {
  const draft = !!$('word-field').value.trim() || !!$('heard-field').value.trim();
  const key = String(draft);
  if (key !== reported) { reported = key; api.interactionState({draft, modal: false}); }
}
$('word-field').addEventListener('input', reportInteraction);
$('heard-field').addEventListener('input', reportInteraction);

/* ---------- The row: two icons, the history, the words ---------- */
for (const button of document.querySelectorAll('.ico')) button.addEventListener('click', () => api.setMode('open', button.dataset.page));
$('missing-dot').addEventListener('click', () => api.permissionOpen());

async function refresh() {
  data = await api.dictationState().catch(() => data);
  renderHistory();
  renderWords();
}
const ICONS = {
  copy: '<svg viewBox="0 0 24 24"><path d="M9 9h10v10H9zM5 15V5h10"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><path d="M7 7h10v10H7z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M6 12.5l4 4 8-9"/></svg>',
};
const iconButton = (name, label, action) => {
  const button = document.createElement('button');
  button.className = 'act'; button.innerHTML = ICONS[name]; button.title = label; button.setAttribute('aria-label', label);
  button.addEventListener('click', event => { event.stopPropagation(); action(button); });
  return button;
};
// A copy is confirmed by the button itself: for a moment it is a check.
const copied = (button, text) => { navigator.clipboard.writeText(text).catch(() => {}); button.innerHTML = ICONS.check; setTimeout(() => { button.innerHTML = ICONS.copy; }, 1100); };

let openEntry = null, playing = null;
function renderHistory() {
  const query = $('search-field').value.trim().toLowerCase();
  const entries = data.history.filter(entry => entry.final && (!query || entry.final.toLowerCase().includes(query)));
  $('history').replaceChildren(...entries.slice(0, query ? 50 : 20).map(entry => {
    const row = document.createElement('div');
    row.className = 'line entry';
    if (openEntry === entry.id) row.dataset.open = '';
    const text = document.createElement('span');
    text.className = 'text';
    text.innerHTML = query ? escapeText(entry.final).replace(new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), match => `<b>${match}</b>`) : escapeText(entry.final);
    row.append(text, iconButton('copy', 'Kopieren', button => copied(button, entry.final)));
    // Opened: the whole text, and its sound when the recording is still there (a day).
    if (openEntry === entry.id && data.audio.includes(entry.id)) {
      const sound = document.createElement('div');
      sound.className = 'sound';
      const play = iconButton(playing?.id === entry.id ? 'stop' : 'play', 'Anhören', () => listen(entry.id));
      const wave = document.createElement('span');
      wave.className = 'wave';
      wave.innerHTML = '<i></i>'.repeat(24);
      sound.append(play, wave);
      row.append(sound);
    }
    row.addEventListener('click', () => { openEntry = openEntry === entry.id ? null : entry.id; renderHistory(); });
    return row;
  }));
}
async function listen(id) {
  if (playing) { const was = playing.id; playing.audio.pause(); URL.revokeObjectURL(playing.audio.src); playing = null; renderHistory(); if (was === id) return; }
  const bytes = await api.dictationAudio(id).catch(() => null);
  if (!bytes) return;
  const audio = new Audio(URL.createObjectURL(new Blob([bytes], {type: 'audio/wav'})));
  playing = {id, audio};
  audio.onended = () => { if (playing?.audio === audio) { URL.revokeObjectURL(audio.src); playing = null; renderHistory(); } };
  audio.play().catch(() => {});
  renderHistory();
}

function renderWords() {
  // Two lines each: what is heard (small, grey) and what whispertext writes. A plain word is one line.
  const items = [
    ...data.rules.map(rule => ({kind: 'rule', id: rule.id, heard: rule.from, text: rule.to})),
    ...data.snippets.map(snippet => ({kind: 'snippet', id: snippet.id, heard: snippet.trigger, text: snippet.text})),
    ...data.words.map(word => ({kind: 'word', id: word, heard: '', text: word})),
  ];
  const query = $('search-field').value.trim().toLowerCase();
  $('word-list').replaceChildren(...items.filter(item => !query || `${item.heard} ${item.text}`.toLowerCase().includes(query)).map(item => {
    const row = document.createElement('div');
    row.className = 'line pair';
    const text = document.createElement('span');
    text.className = 'text';
    text.innerHTML = (item.heard ? `<small>${escapeText(item.heard)}</small><i>→</i>` : '') + `<span>${escapeText(item.text)}</span>`;
    row.append(text, iconButton('x', 'Entfernen', async () => { await api.wordRemove(item.kind, item.id); refresh(); }));
    return row;
  }));
}
// Two lines to add: what is heard (empty for a plain word) and what to write. A long text becomes a snippet.
$('word-form').addEventListener('submit', async event => {
  event.preventDefault();
  const heard = $('heard-field').value.trim(), text = $('word-field').value.trim();
  if (!text) { $('word-field').focus(); return; }
  await api.wordSave(heard, text).catch(() => {});
  $('heard-field').value = ''; $('word-field').value = '';
  reportInteraction();
  refresh();
  $('heard-field').focus();
});
$('heard-field').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('word-field').focus(); } });

/* ⌘F searches what is open; Esc clears the search, then closes. */
function closeSearch() { if ($('search').hidden) return; $('search').hidden = true; $('search-field').value = ''; renderHistory(); renderWords(); }
$('search-field').addEventListener('input', () => { renderHistory(); renderWords(); });
document.addEventListener('keydown', event => {
  if (event.key === 'f' && event.metaKey && state.mode === 'open') { event.preventDefault(); $('search').hidden = false; $('search-field').focus(); return; }
  if (event.key !== 'Escape') return;
  if (state.mode === 'dictate') { cancelRecording(); return; }
  if (!$('search').hidden) { closeSearch(); return; }
  api.setMode('rest');
});

/* ---------- Setup and intro: one step at a time, in the row ---------- */
// Permissions first (blue "Erlauben"), then the three keys pressed for real.
const KEY = text => `<kbd>${text}</kbd>`;
const STEPS = {
  microphone: {icon: '<svg viewBox="0 0 24 24"><rect x="9" y="3.5" width="6" height="11" rx="3"/><path d="M6 11.5a6 6 0 0 0 12 0M12 17.5V20"/></svg>', action: 'Erlauben', at: 0},
  accessibility: {icon: '<svg viewBox="0 0 24 24"><rect x="3.5" y="6.5" width="17" height="11" rx="2"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8"/></svg>', action: 'Erlauben', waiting: 'whispertext in die Liste ziehen', at: 1},
  1: {html: `${KEY('fn')} halten und sprechen`, field: true, at: 2},
  2: {html: `2× ${KEY('fn')} für freies Sprechen · ${KEY('⏎')} fertig · ${KEY('esc')} verwerfen`, field: true, at: 3},
  3: {html: `${KEY('⌃')}${KEY('⌘')}${KEY('V')} fügt es nochmal ein`, field: true, at: 4},
  4: {tip: 'Das ist dein Verlauf.<br>Hier findest du vergangene Texte wieder.', at: 5},
  5: {tip: 'Das ist der Wörterbereich.<br>whispertext lernt automatisch dazu.<small>Auch längere Texte, die du oft brauchst, hier speichern und mit einem Wort einfügen.</small>', at: 6},
};
function renderStep() {
  const key = state.missing ?? (state.intro || null);
  const step = key ? STEPS[key] : null;
  // A step that worked shows the green check (the practice field is a window of its own, main.js).
  body.dataset.step = step ? String(key) : '';
  if (state.introOk) body.dataset.ok = ''; else delete body.dataset.ok;
  // The history and the words in the intro: the opened row with one line about it on top.
  $('intro-tip').hidden = !step?.tip;
  if (step?.tip) $('intro-text').innerHTML = step.tip;
  // Each row of dots counts on its own (the intro line has its own copy).
  const dots = () => document.querySelectorAll('.progress').forEach(row => [...row.children].forEach((dot, index) => { dot.className = index < step.at ? 'done' : index === step.at ? 'now' : ''; }));
  if (!step) return;
  dots();
  if (step.tip) return;
  $('step-body').innerHTML = step.icon ? `<span class="step-icon">${step.icon}</span>` : step.html;
  const s = state.permissionState ?? {};
  // After the click: the app's icon waits beside System Settings; the row says what to do with it.
  const waiting = step.waiting && s.requestKind === key && (s.requestPending || s.requestStatus === 'timed-out');
  $('step-action').hidden = !step.action || waiting;
  $('step-action').textContent = step.action ?? '';
  $('step-drag').hidden = !waiting;
  $('step-drag').textContent = step.waiting ?? '';
}
$('intro-next').addEventListener('click', () => api.introNext());
$('step-action').addEventListener('click', () => { if (state.missing) api.permissionAction(state.missing).catch(() => {}); });
$('step-drag').addEventListener('click', () => api.permissionDrag());
// In the intro the words field is ready to type into.
api.onState(next => { if (next.intro === 5 && next.mode === 'open') setTimeout(() => $('heard-field').focus(), 300); });

/* ---------- Notices: one short line under the notch ---------- */
const NOTICES = {
  'not-inserted': () => 'Erneut einfügen <kbd>⌃⌘V</kbd>',
  'secure-field': () => 'Passwortfeld · nichts eingefügt',
  'accessibility': () => 'Einfügen erlauben · Bedienungshilfen',
  'pasted-again': () => 'Wieder eingefügt',
  'nothing-to-paste': () => 'Noch kein Diktat',
  'nothing-selected': () => 'Erst Text markieren',
  'no-speech': () => 'Nichts gehört',
  'microphone': () => 'Mikrofon prüfen · Mac-Einstellungen',
  'mic-starting': () => 'Mikrofon startet …',
  'mic-lost': () => 'Mikrofon getrennt',
  'failed': () => 'Erkennung fehlgeschlagen · nochmal',
  'model-loading': () => 'Spracherkennung lädt · Text kommt gleich',
  'format-local': () => 'Ohne Glätten eingefügt',
  'refined': () => 'Geglättet',
  'done': () => 'Erledigt',
  // Only the words, a line each (17.11.2026: no "Gelernt:", no written "Zurück"); the round button beside the
  // strich takes them back.
  'learned': ({title}) => String(title ?? '').split('\n').map(line => `<span>${escapeText(line)}</span>`).join(''),
  'unlearned': () => 'Zurückgenommen',
  'discarded': () => 'Verworfen',
  'correction-suggested': ({title}) => `Wörterbuchvorschlag: ${escapeText(title)}`,
};
// Receipts are a check only, hints are plain words, errors carry a red dot. No icon anywhere.
const NOTICE_STYLE = {'done': 'ok', 'unlearned': 'plain', 'discarded': 'plain', 'refined': 'check', 'pasted-again': 'check', 'not-inserted': 'plain', 'nothing-to-paste': 'plain', 'nothing-selected': 'plain', 'no-speech': 'plain', 'model-loading': 'plain', 'secure-field': 'plain',
  'failed': 'error', 'mic-lost': 'error', 'microphone': 'error', 'accessibility': 'error'};
let noticeTimer = null, noticeRule = null;
function notice(kind, {reason, title, id} = {}) {
  const key = kind === 'not-inserted' && ['secure-field', 'accessibility'].includes(reason) ? reason : kind;
  const text = NOTICES[key]?.({title}) ?? NOTICES['not-inserted']();
  $('notice-text').innerHTML = text;
  const style = NOTICE_STYLE[key] ?? 'plain';
  body.dataset.noticeStyle = style;
  body.dataset.notice = key;
  const lines = key === 'learned' ? Math.min(3, String(title ?? '').split('\n').length) : 1;
  if (lines > 1) body.dataset.noticeLines = String(lines); else delete body.dataset.noticeLines;
  // Measured while it shows (hidden text has no width, and the words stood outside the row, 14.11.2026).
  body.style.setProperty('--notice-width', `${Math.min(window.innerWidth - 24, Math.ceil($('notice-text').scrollWidth) + (style === 'error' ? 42 : 26))}px`);
  if (key === 'accessibility') api.permissionOpen();
  clearTimeout(noticeTimer);
  if(key!=='mic-starting')noticeTimer = setTimeout(clearNotice, ['not-inserted', 'learned'].includes(key) ? 6000 : key === 'discarded' ? 8000 : key === 'done' ? 1600 : 3500);
  // A learned word can be taken back with a click on its message; a finished task's message brings you to it.
  // The round button beside the strich: a learned word goes back out, a thrown-away dictation is inserted after all.
  const back = (key === 'learned' && id) || key === 'discarded';
  if (back) body.dataset.noticeBack = ''; else delete body.dataset.noticeBack;
  setBacks(back ? lines : 0);
  noticeRule = key === 'learned' && id ? id : back ? 'discarded' : null;
  if (noticeRule) { body.dataset.noticeClick = ''; setTimeout(tellNotice, 320); } else { delete body.dataset.noticeClick; tellNotice(); }
}
function clearNotice() { clearTimeout(noticeTimer); setBacks(0); delete body.dataset.noticeBack; delete body.dataset.noticeLines; delete body.dataset.notice; delete body.dataset.noticeStyle; delete body.dataset.noticeClick; noticeRule = null; tellNotice(); }
function tellNotice() {
  const strich = noticeRule && 'notice' in body.dataset ? $('handle').getBoundingClientRect() : null;
  if (!strich || strich.width <= 40) { api.noticeRegion?.(null); return; }
  // The strich and, when it is there, the round button beside it.
  const button = 'noticeBack' in body.dataset ? $('notice-backs').getBoundingClientRect() : null;
  const right = Math.max(strich.right, button?.width ? button.right : 0), bottom = Math.max(strich.bottom, button?.width ? button.bottom : 0);
  api.noticeRegion?.({x: Math.round(strich.left), y: Math.round(strich.top), width: Math.round(right - strich.left), height: Math.round(bottom - strich.top)});
}
// One round button per line: each learned word has its own way back; a thrown-away dictation has one.
const BACK_ICON = '<svg viewBox="0 0 24 24"><path d="M9 7L4 12l5 5"/><path d="M4 12h10a5 5 0 0 1 0 10h-2"/></svg>';
function setBacks(count) {
  $('notice-backs').innerHTML = Array.from({length: count}, (_, index) => `<button type="button" tabindex="-1" data-line="${index}" aria-label="Zurücknehmen">${BACK_ICON}</button>`).join('');
}
$('notice-backs').addEventListener('pointerdown', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  event.preventDefault(); event.stopPropagation();
  const kind = body.dataset.notice;
  if (kind === 'discarded') { clearNotice(); api.pasteAgain?.(); return; }
  if (kind !== 'learned' || !noticeRule) return;
  const rules = String(noticeRule).split(','), line = Number(button.dataset.line);
  await api.dictationAction('delete-rule', {id: rules[line]}).catch(() => {});
  const lines = [...$('notice-text').children].map(node => node.textContent).filter((_, index) => index !== line);
  rules.splice(line, 1);
  // The others stay, with their own buttons; the last one gone says so.
  if (rules.length) notice('learned', {title: lines.join('\n'), id: rules.join(',')}); else notice('unlearned');
});
api.onNotice(({kind, reason, title, id}) => notice(kind, {reason, title, id}));

/* ---------- Hands-free: the strich as a pill with cancel, the voice and done ---------- */
// ✕ or Esc. A dictation thrown away is still recognised, out of sight: ⌃⌘V brings it back for half a minute.
function discardFree() {
  if (recording?.locked && recording.mode === 'dictate' && !recording.finishing && engineName === 'parakeet') {
    recording.discard = true;
    api.handsFreeDone();
    setTimeout(() => { if (recording?.locked && !recording.finishing) finishRecording(); }, 200);
  } else api.handsFreeCancel();
}
$('free-cancel')?.addEventListener?.('pointerdown', event => { event.preventDefault(); discardFree(); });
// Esc while a hands-free dictation runs comes from main (the key is pressed in another app).
api.onHandsFree?.(({discard} = {}) => { if (discard) discardFree(); });
$('free-done')?.addEventListener?.('pointerdown', event => {
  event.preventDefault();
  api.handsFreeDone();
  // The keys may already be free again (main released a stale lock): then the recording ends from here.
  setTimeout(() => { if (recording?.locked && !recording.finishing) finishRecording(); }, 200);
});

/* ---------- Voice bars: nine levels, low to high pitch, eased fast up and slow down ---------- */
const bars = [...document.querySelectorAll('#handle .bars i')];
const levels = new Float32Array(bars.length);
let analyser = null, spectrum = null, lastFrame = 0, drawing = false;
const startBars = () => { if (!drawing) { drawing = true; requestAnimationFrame(drawBars); } };
function bandRanges(sampleRate, size) {
  // Logarithmic bands from 90 Hz to 4 kHz, where speech lives.
  const low = Math.log(90), high = Math.log(4000), bin = sampleRate / size;
  return bars.map((_, i) => {
    const from = Math.exp(low + (high - low) * i / bars.length), to = Math.exp(low + (high - low) * (i + 1) / bars.length);
    return [Math.max(1, Math.floor(from / bin)), Math.max(2, Math.ceil(to / bin))];
  });
}
let ranges = [];
function drawBars(time) {
  const dt = Math.min(0.1, lastFrame ? (time - lastFrame) / 1000 : 1 / 60);
  lastFrame = time;
  const busy = 'busy' in body.dataset;
  if (analyser && !busy) analyser.getByteFrequencyData(spectrum);
  for (let i = 0; i < bars.length; i++) {
    let goal;
    if (busy) goal = 0.12 + 0.3 * Math.max(0, Math.sin(time / 1000 * 7.5 - i * 0.75));
    else if (analyser) {
      const [from, to] = ranges[i];
      let sum = 0;
      for (let b = from; b < to && b < spectrum.length; b++) sum += spectrum[b];
      const value = sum / Math.max(1, to - from) / 255;
      goal = Math.min(1, Math.max(0, (value - 0.18) * 1.9)) * (0.86 + 0.14 * Math.sin(time / 1000 * 11 + i * 1.7));
    } else goal = 0;
    const rate = goal > levels[i] ? 28 : 10;
    levels[i] += (goal - levels[i]) * Math.min(1, rate * dt);
    bars[i].style.height = `${(3 + levels[i] * 11).toFixed(1)}px`;
  }
  if (state.mode === 'dictate') requestAnimationFrame(drawBars); else { drawing = false; lastFrame = 0; levels.fill(0); }
}

/* ---------- Recording and local transcription ---------- */
// Arm on keydown; the audio-thread processor flushes and acknowledges the last frame on release.
// A tap/cancel discards its session, including late microphone acquisition and late audio messages.
let captureSession = 0;
let recording = null, worker = null, requestId = 0, processing = false, generation = 0;
const pending = new Map();

function transcriber() {
  if (worker) return worker;
  worker = new Worker('/dictation-worker.js', {type: 'module'});
  worker.onmessage = ({data}) => {
    if ((data.type === 'done' || data.type === 'error') && pending.has(data.id)) {
      const {resolve, reject} = pending.get(data.id);
      pending.delete(data.id);
      data.type === 'done' ? resolve(data.text) : reject(new Error(data.error));
    }
  };
  worker.onerror = event => { event.preventDefault(); worker = null; for (const {reject} of pending.values()) reject(new Error('worker')); pending.clear(); };
  return worker;
}
// Parakeet on Apple silicon, Whisper elsewhere (Intel, Windows, Linux).
let engineName = null, selectedLanguage = 'auto';
const captureConfig = () => api.dictationConfig ? api.dictationConfig() : api.dictationState();
const engine = async () => engineName ??= 'parakeet';
const recognizeOnly = async (audio, language = selectedLanguage) => await engine() === 'parakeet'
  ? api.transcribeLocal(audio).then(result => { if (result.error) throw new Error(result.error); return result.text; })
  : transcribe(audio, language);

// The settings' microphone test recognises with exactly the engine dictation uses.
globalThis.whispertextRecognize = async audio => { selectedLanguage = (await captureConfig()).language ?? 'auto'; return recognizeOnly(audio, selectedLanguage); };

function transcribe(audio, language = selectedLanguage) {
  const id = ++requestId;
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    transcriber().postMessage({type: 'transcribe', id, audio, language: language === 'de' ? 'german' : language === 'en' ? 'english' : undefined}, [audio.buffer]);
  });
}

let preparedCapture = null, captureClosing = false;
// Preload code and a suspended output graph only. No microphone request or captured audio while idle.
function prepareCapture() {
  if (captureClosing || preparedCapture) return preparedCapture;
  let context;
  try { context = new AudioContext({sampleRate: 16000}); } catch { return null; }
  const entry = {context};
  preparedCapture = entry;
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('capture-prepare-timeout')), 5000); });
  entry.ready = Promise.race([
    Promise.resolve().then(() => Promise.all([context.suspend(), context.audioWorklet.addModule('/dictation-capture-worklet.js')])), deadline,
  ]).then(() => context.sampleRate === 16000 ? context : Promise.reject(new Error('sample-rate'))).catch(() => {
    if (preparedCapture === entry) preparedCapture = null;
    context.close().catch(() => {});
    return null;
  }).finally(() => clearTimeout(timer));
  return entry;
}
function takePreparedCapture() {
  const entry = preparedCapture ?? prepareCapture();
  preparedCapture = null;
  return entry;
}

async function startRecording(mode, targetId = null) {
  if (recording) return;
  clearNotice();
  const current = {session: ++captureSession, targetId, armedAt: Date.now(), mode, chunks: [], cancelled: false, shown: false, packets: 0, samples: 0};
  current.ready = new Promise(resolve => { current.readyResolve = resolve; });
  recording = current;
  const fail = () => {
    if (recording !== current || current.cancelled) return;
    current.captureError = true;
    current.failed = true;
    release(current);
    recording = null;
    if (current.shown) { api.setMode('rest'); notice('microphone'); }
  };
  current.startTimer = setTimeout(fail, 5000);
  try {
    const configStarted = Date.now();
    const [allowed, config] = await Promise.all([api.microphone(), captureConfig()]);
    current.captureConfigMs = Date.now() - configStarted;
    if (!allowed) throw new Error('microphone');
    current.language = selectedLanguage = ['de', 'en'].includes(config.language) ? config.language : 'auto';
    if (current.released || recording !== current) return;
    // Engine warm-up and capture proceed independently. No model load on the microphone critical path.
    engine().catch(() => {});
    const prepared = takePreparedCapture();
    if (!prepared) throw new Error('capture-prepare');
    const context = prepared.context;
    current.context = context;
    const graphStarted = Date.now();
    const graph = prepared.ready.then(ready => { if (!ready || current.released || recording !== current) throw new Error('capture-retired'); return context.resume(); }).then(() => { current.graphPrepareMs = Date.now() - graphStarted; });
    const microphoneStarted = Date.now();
    const microphone = navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: config.noiseSuppression !== false, ...(config.deviceId ? {deviceId: {exact:config.deviceId}} : {})}}).then(stream => {
      if (current.released || recording !== current) { stream.getTracks().forEach(track => track.stop()); return null; }
      current.stream = stream;
      current.micAcquireMs = Date.now() - microphoneStarted;
      return stream;
    });
    const [stream] = await Promise.all([microphone, graph]);
    if (!stream || current.released || recording !== current) return;
    const source = context.createMediaStreamSource(stream);
    current.source = source;
    const processor = new AudioWorkletNode(context, 'studymut-dictation-capture', {processorOptions: {session: current.session}});
    current.processor = processor;
    processor.onprocessorerror = fail;
    processor.port.onmessage = ({data}) => {
      if (data.session !== current.session || current.cancelled || current.released || recording !== current) return;
      if (data.type === 'error') return fail();
      if (data.type === 'done') {
        if (data.packets !== current.packets || data.samples !== current.samples) return fail();
        current.captureDone = true;
        current.stopResolve?.(true);
        if (!current.finishing) finishRecording();
        return;
      }
      if (data.type !== 'audio' || current.captureDone) return;
      const copy = data.audio;
      if (!(copy instanceof Float32Array) || copy.length > 640 || data.sequence !== current.packets || !copy.every(Number.isFinite)) return fail();
      if (current.firstFrameAt == null) {
        current.firstFrameAt = Date.now();
        analyser = current.analyser;
        spectrum = new Uint8Array(analyser.frequencyBinCount);
        ranges = bandRanges(context.sampleRate, analyser.fftSize);
        clearTimeout(current.slowTimer);
        if (current.shown) { if (body.dataset.notice === 'mic-starting') clearNotice(); startBars(); }
      }
      current.packets++;
      current.samples += copy.length;
      current.chunks.push(copy);
      // With Whisper (Intel, Windows, Linux) longer speech is recognised piece by piece while it goes on.
      // Parakeet stays whole: it reads 30 s in about half a second, and a cut can cost context
      // (measured 28.10.2026: 0.33 s instead of 0.55 s, one word pair worse).
      if (current.shown && engineName === 'whisper') {
        if (!current.segmenter) { current.segmenter = new Segmenter(audio => recognizeOnly(audio, current.language)); for (const chunk of current.chunks) current.segmenter.push(chunk); }
        else current.segmenter.push(copy);
      }
      // A pause while dictating is used (14.11.2026): what was said so far is recognised and tidied out of sight.
      // If nothing more is said before the key is let go or the ✓ is pressed, the tidied text is already there.
      if (current.mode === 'dictate' && current.shown && engineName === 'parakeet' && api.dictateAhead) {
        let loud = 0;
        for (let i = 0; i < copy.length; i += 8) loud = Math.max(loud, Math.abs(copy[i]));
        const now = performance.now();
        if (loud > 0.04) { current.lastVoice = now; current.spoke = true; }
        // Where the last sound ended, counted generously (also soft sounds): only audio after the pause's own
        // recognition that is truly silent lets the release take that recognition as it is.
        if (loud > 0.02) current.voiceUntil = current.samples;
        if (current.spoke && !current.aheadBusy && now - current.lastVoice > 600 && current.samples - (current.aheadSamples ?? 0) > 16000 * 2.5 && current.samples < 16000 * 110) {
          current.spoke = false; current.aheadBusy = true; current.aheadSamples = current.samples;
          const sofar = new Float32Array(current.samples);
          let offset = 0;
          for (const chunk of current.chunks) { sofar.set(chunk, offset); offset += chunk.length; }
          Promise.resolve(api.dictateAhead(sofar, {targetId: current.targetId})).catch(() => {}).finally(() => { current.aheadBusy = false; });
        }
      }

    };
    current.analyser = context.createAnalyser();
    current.analyser.fftSize = 1024;
    current.analyser.smoothingTimeConstant = 0.5;
    source.connect(current.analyser);
    source.connect(processor);
    processor.connect(context.destination);
    current.recordingStartedAt = Date.now();
    processor.port.postMessage({type: 'start', session: current.session});
    clearTimeout(current.startTimer);
    current.readyResolve(true);
    current.limitTimer = setTimeout(() => { if (recording === current) finishRecording(); }, 120000);
    stream.getAudioTracks()[0].onended = () => { if (recording === current) { cancelRecording(); notice('mic-lost'); } };
  } catch { fail(); }
}

function release(current) {
  if (current.released) return;
  if(body.dataset.notice==='mic-starting')clearNotice();
  current.released = true;
  clearTimeout(current.slowTimer);
  clearTimeout(current.startTimer);
  clearTimeout(current.limitTimer);
  clearTimeout(current.stopTimer);
  current.readyResolve?.(false);
  current.stopResolve?.(false);
  if (current.processor) {
    current.processor.port.postMessage({type: 'cancel', session: current.session});
    current.processor.port.onmessage = null;
    current.processor.onprocessorerror = null;
    current.processor.disconnect();
  }
  current.source?.disconnect();
  if (current.stream) for (const track of current.stream.getTracks()) track.onended = null;
  current.stream?.getTracks().forEach(track => track.stop());
  current.context?.close().catch(() => {});
  if (analyser === current.analyser) analyser = null;
  Promise.resolve().then(() => { if (!recording && !captureClosing) prepareCapture(); });
}

// The hold delay passed: now it is a dictation and the handle shows the voice.
function showRecording(mode, targetId = null) {
  if (!recording) startRecording(mode, targetId);
  if (!recording) return;
  if (recording.targetId == null && targetId != null) recording.targetId = targetId;
  recording.mode = mode;
  recording.shown = true;
  // The bars come at once, flat until the first sound arrives (it is kept from the key press on anyway). Only a
  // microphone that is still silent after a second says so; before, its notice flashed Studymut on every start.
  startBars();
  if (recording.firstFrameAt == null) {
    const current = recording;
    clearTimeout(current.slowTimer);
    // No words while the microphone starts: the flat voice already says it (20.11.2026).
  }
}

function dropRecording() {
  const current = recording;
  recording = null;
  if (!current) return;
  current.cancelled = true;
  release(current);
}

async function finishRecording() {
  const current = recording;
  if (!current || current.finishing) return;
  current.finishing = true;
  setLocked(false);
  current.stoppedAt = Date.now();
  if (!await current.ready || recording !== current) return;
  if (!current.captureDone) {
    const stopped = new Promise(resolve => { current.stopResolve = resolve; });
    current.stopTimer = setTimeout(() => current.stopResolve(false), 1500);
    current.processor.port.postMessage({type: 'stop', session: current.session});
    const complete = await stopped;
    clearTimeout(current.stopTimer);
    if (recording !== current) return;
    if (!complete) { release(current); recording = null; api.setMode('rest'); notice('microphone'); return; }
  }
  if (recording !== current) return;
  recording = null;
  current.cancelled = true;
  release(current);
  const mode = current.mode;
  const length = current.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (length < 16000 * 0.3) { api.setMode('rest'); if (current.shown && mode === 'dictate') notice('no-speech'); return; }
  const audio = new Float32Array(length);
  let offset = 0;
  for (const chunk of current.chunks) { audio.set(chunk, offset); offset += chunk.length; }
  if (audio.every(sample => sample === 0)) { api.setMode('rest'); notice('no-speech'); return; }
  const captureTimings = {targetId: current.targetId, voiceUntil: current.voiceUntil ?? null, recordingStartedAt: current.recordingStartedAt, stoppedAt: current.stoppedAt, audioReadyAt: Date.now(), captureStartMs: current.firstFrameAt == null ? null : current.firstFrameAt - current.armedAt, captureConfigMs: current.captureConfigMs, micAcquireMs: current.micAcquireMs, graphPrepareMs: current.graphPrepareMs, firstFrameAfterGraphMs: current.firstFrameAt == null ? null : current.firstFrameAt - current.recordingStartedAt};
  const job = ++generation;
  processing = true;
  body.dataset.busy = '';
  if (mode === 'dictate') {
    const config = await captureConfig();
    const durationMs = audio.length / 16;
    const parakeet = await engine() === 'parakeet';
    // Pieces already recognised while speaking: only the rest is left (see lib/segmenter.js).
    const {prefix, cut} = current.segmenter ? await current.segmenter.settle() : {prefix: '', cut: 0};
    const recognize = parakeet ? api.dictate(audio, {prefix, cut, ...captureTimings, discard: current.discard === true})
      : transcribe(audio.slice(cut), current.language).then(async text => { if (job !== generation) return {cancelled: true}; const all = [prefix, text].filter(Boolean).join(' ').trim(); if (!all) return {error: 'no-speech'}; return api.insert(all, durationMs, captureTimings); });
    const result = await recognize.catch(() => ({error: 'failed'}));
    if (job !== generation) return;
    processing = false;
    delete body.dataset.busy;
    api.setMode('rest');
    if (result.cancelled) return;
    if (result.discarded) { notice('discarded'); return; }
    if (result.error) { if (current.discard) return; notice(/Keine Sprache|no-speech/.test(result.error) ? 'no-speech' : 'failed'); return; }
    if (result.inserted !== true) notice('not-inserted', {reason: result.reason});
    else if (result.polishStatus === 'rejected') notice('format-local');
    else clearNotice();
    return;
  }
  processing = false;
  delete body.dataset.busy;
  api.setMode('rest');
}

// The pill takes clicks only while it is there; main keeps the rest of the notch window click-through.
function setLocked(on) {
  if (on === ('locked' in body.dataset)) return;
  if (on) { body.dataset.locked = ''; startBars(); } else delete body.dataset.locked;
  const tell = () => {
    const box = 'locked' in body.dataset ? $('handle').getBoundingClientRect() : null;
    api.pillRegion?.(box && box.width > 60 ? {x: Math.round(box.left), y: Math.round(box.top), width: Math.round(box.width), height: Math.round(box.height)} : null);
  };
  tell();
  if (on) setTimeout(tell, 280);
}

function cancelRecording() {
  setLocked(false);
  generation++;
  dropRecording();
  processing = false;
  api.cancelDictation();
  if (state.mode === 'dictate') api.setMode('rest');
  delete body.dataset.busy;
}
api.onGesture(effect => {
  if (effect.type === 'arm') startRecording(effect.mode, effect.targetId);
  else if (effect.type === 'disarm') dropRecording();
  else if (effect.type === 'begin') { showRecording(effect.mode, effect.targetId); if (effect.locked && recording) { recording.locked = true; recording.ends = effect.ends ?? 'check'; recording.quiet = effect.quiet ?? 0; setLocked(true); } }
  else if (effect.type === 'finish') finishRecording();
  else if (effect.type === 'cancel') cancelRecording();
});
// Prepare only the output graph while idle. Retire it on renderer shutdown, including late preparation.
prepareCapture();
if (typeof window !== 'undefined') window.addEventListener('pagehide', () => {
  captureClosing = true;
  const cached = preparedCapture;
  preparedCapture = null;
  cached?.context.close().catch(() => {});
  if (recording) dropRecording();
}, {once: true});

/* ---------- Local controls ---------- */
// First paint.

// First paint once every part of the UI above is set up.
render();
