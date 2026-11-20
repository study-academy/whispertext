import {TEAM_TERMS} from '../core/vocabulary.js';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {existsSync, readFileSync, mkdirSync, writeFileSync, renameSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {dropsWord} from '../core/dictation-text.js';

export const MODEL = 'NVIDIA Parakeet TDT 0.6B v3 · CoreML int8-linear v2';
const text = value => String(value ?? '').trim().slice(0, 20000);
export function applyDictionary(original, rules, applied = []) {
  const enabled = rules.filter(r => r.enabled && r.from && r.to).sort((a,b) => b.from.length-a.from.length);
  if (!enabled.length) return original;
  const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${enabled.map(r => escape(r.from)).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return original.replace(pattern, match => { const rule = enabled.find(r => r.from.toLocaleLowerCase() === match.toLocaleLowerCase()); if(rule && !applied.some(r=>r.id === rule.id)) applied.push({id:rule.id,from:rule.from,to:rule.to}); return rule?.to ?? match; });
}
export class DictationStore {
  constructor(file) {
    this.file = file;
    let saved; try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch {}
    this.data = {historyEnabled: true, dictionaryEnabled: true, polish: false, learn: true, keepAudio: true, noiseSuppression: true, language: 'auto', deviceId: '', history: [], rules: [], snippets: [], words: [], styles: {}, ...saved};
    this.data.words = Array.isArray(this.data.words) ? this.data.words.filter(word=>typeof word==='string').slice(0,500) : [];
    this.data.snippets = Array.isArray(this.data.snippets) ? this.data.snippets.slice(0, 200) : [];
    this.data.styles = this.data.styles && typeof this.data.styles === 'object' ? this.data.styles : {};
    this.data.history = Array.isArray(this.data.history) ? this.data.history.slice(0,100) : [];
    this.data.rules = Array.isArray(this.data.rules) ? this.data.rules.slice(0,500) : [];
    // Rules an earlier version learned from a deleted word are switched off (not removed): they ate that word from every dictation.
    for (const rule of this.data.rules) if (rule && rule.source !== 'manual' && rule.enabled && dropsWord(rule.from, rule.to)) { rule.enabled = false; rule.disabledBecause = 'drops-word'; }
  }
  save() {
    mkdirSync(dirname(this.file), {recursive:true, mode:0o700});
    writeFileSync(this.file+'.tmp', JSON.stringify(this.data), {mode:0o600});
    renameSync(this.file+'.tmp', this.file);
  }
  update(patch) {
    for (const key of ['historyEnabled','dictionaryEnabled','polish','learn','keepAudio','noiseSuppression']) if (typeof patch?.[key] === 'boolean') this.data[key] = patch[key];
    // A writing style per app ("" = automatic): {bundleId: 'locker' | 'neutral' | 'foermlich' | 'wortgetreu' | ''}.
    if (patch?.styles && typeof patch.styles === 'object') for (const [app, style] of Object.entries(patch.styles)) {
      if (!app || app.length > 200) continue;
      if (['locker','neutral','foermlich','wortgetreu'].includes(style)) this.data.styles[app] = style; else delete this.data.styles[app];
    }
    if (['auto','de','en'].includes(patch?.language)) this.data.language = patch.language;
    if (typeof patch?.deviceId === 'string') this.data.deviceId = patch.deviceId.slice(0,256);
    this.save(); return this.data;
  }
  addRule(from, to, source = 'manual', historyId = null, ruleId = null) {
    from = text(from).slice(0,200); to = text(to).slice(0,200);
    if (!from || !to || from === to) throw new Error('Bitte unterschiedliche Erkennung und Korrektur eingeben.');
    if (this.data.snippets.some(snippet=>snippet.trigger.toLocaleLowerCase()===from.toLocaleLowerCase())) throw new Error('Dieser Auslöser ist bereits ein Snippet. Bitte zuerst den Konflikt auflösen.');
    const existing = this.data.rules.find(r => r.id === ruleId) ?? this.data.rules.find(r => r.from.toLowerCase() === from.toLowerCase());
    const rule = {id: existing?.id ?? randomUUID(), from, to, enabled: true, source, historyId, createdAt: new Date().toISOString()};
    this.data.rules = [rule, ...this.data.rules.filter(r => r.id !== rule.id)].slice(0,500); this.save(); return this.data;
  }
  // Snippets: a spoken trigger becomes stored text. Up to 200, each up to 4000 characters.
  saveSnippet(trigger, value, id = null) {
    trigger = text(trigger).slice(0,80); value = String(value ?? '').slice(0,4000);
    if (!trigger || !value.trim()) throw new Error('Bitte Auslöser und Text eingeben.');
    if (this.data.rules.some(rule => rule.from.toLocaleLowerCase() === trigger.toLocaleLowerCase())) throw new Error('Dieser Auslöser ist bereits eine Wörterbuchkorrektur. Bitte einen anderen Auslöser wählen.');
    const snippet = {id: id ?? randomUUID(), trigger, text: value, enabled: true};
    this.data.snippets = [snippet, ...this.data.snippets.filter(s => s.id !== snippet.id && s.trigger.toLowerCase() !== trigger.toLowerCase())].slice(0,200);
    this.save(); return this.data;
  }
  deleteSnippet(id) { this.data.snippets = this.data.snippets.filter(s => s.id !== id); this.save(); return this.data; }
  // The dictionary applied to raw recognised text, before snippets and polishing.
  prepare(original) {
    const appliedRules = [];
    const value = text(original);
    return {text: this.data.dictionaryEnabled ? applyDictionary(value, this.data.rules, appliedRules) : value, appliedRules};
  }
  // Spellings the polishing should keep: the targets of the dictionary rules.
  // Studymut's own names come first for everyone, so the tidying never writes them otherwise.
  words() { return [...new Set([...this.data.words, ...this.data.rules.filter(r => r.enabled).map(r => r.to), ...TEAM_TERMS])]; }
  addWord(value) {
    const word = text(value).slice(0,200);
    if (!word || !/[\p{L}\p{N}]/u.test(word)) throw new Error('Bitte ein Wort oder einen Fachbegriff eingeben.');
    this.data.words = [word,...this.data.words.filter(existing=>existing.toLocaleLowerCase()!==word.toLocaleLowerCase())].slice(0,500);
    this.save(); return this.data;
  }
  // A word the person fixed right after dictating it: learned at once and used from the next dictation on.
  // Never against a rule the person wrote or accepted themselves; a waiting suggestion for it is switched on.
  learnRule(from, to, historyId) {
    from = text(from).slice(0,200); to = text(to).slice(0,200);
    if (!from || !to || from === to || dropsWord(from, to)) return false;
    if (this.data.snippets.some(snippet=>snippet.trigger.toLocaleLowerCase()===from.toLocaleLowerCase())) return false;
    const existing = this.data.rules.find(rule=>rule.from.toLocaleLowerCase()===from.toLocaleLowerCase());
    if (existing && existing.source !== 'suggested') return false;
    const rule = {id:existing?.id ?? randomUUID(),from,to,enabled:true,source:'learned',historyId,createdAt:new Date().toISOString()};
    this.data.rules=[rule,...this.data.rules.filter(r=>r.id!==rule.id)].slice(0,500);this.save();return true;
  }
  suggestRule(from, to, historyId) {
    // An inferred spelling is never allowed to override a manual or already accepted rule.
    if (this.data.rules.some(rule=>rule.from.toLocaleLowerCase()===from.toLocaleLowerCase())) return false;
    const rule = {id:randomUUID(),from:text(from).slice(0,200),to:text(to).slice(0,200),enabled:false,source:'suggested',historyId,createdAt:new Date().toISOString()};
    if (!rule.from || !rule.to || rule.from===rule.to || dropsWord(rule.from, rule.to)) return false;
    this.data.rules=[rule,...this.data.rules].slice(0,500);this.save();return true;
  }
  record(original, metrics, done = null) {
    original = text(original);
    const appliedRules = [];
    const final = done ?? (this.data.dictionaryEnabled ? applyDictionary(original, this.data.rules, appliedRules) : original);
    const entry = {appliedRules, id:randomUUID(), createdAt:new Date().toISOString(), original, final, language:this.data.language, detectedLanguage:null, model:MODEL, ...metrics, insertion:'pending'};
    if (this.data.historyEnabled) { this.data.history.unshift(entry); this.data.history = this.data.history.slice(0,100); this.save(); }
    return entry;
  }
  action(action, payload = {}) {
    const entry = this.data.history.find(r => r.id === payload.id);
    if (action === 'clear-history') this.data.history = [];
    else if (action === 'clear-dictionary') this.data.rules = [];
    else if (action === 'delete-history') this.data.history = this.data.history.filter(r => r.id !== payload.id);
    else if (action === 'delete-rule') this.data.rules = this.data.rules.filter(r => r.id !== payload.id);
    else if (action === 'delete-snippet') { this.data.snippets = this.data.snippets.filter(r => r.id !== payload.id); }
    else if (action === 'delete-word') this.data.words = this.data.words.filter(word=>word!==payload.word);
    else if (action === 'toggle-rule') { const rule = this.data.rules.find(r => r.id === payload.id); if (rule) { rule.enabled = !rule.enabled; if (rule.enabled && rule.source === 'suggested') rule.source = 'accepted-suggestion'; } }
    else if (action === 'correct' && entry) { entry.final = text(payload.final); entry.correctedAt = new Date().toISOString(); }
    else if (action === 'learn' && entry) {
      if (!entry.correctedAt) throw new Error('Zuerst den Verlaufseintrag selbst korrigieren.');
      if (!entry.original.includes(payload.from) || !entry.final.includes(payload.to)) throw new Error('Die Regel muss aus Original und deiner Korrektur stammen.');
      return this.addRule(payload.from, payload.to, 'explicit-history-correction', entry.id);
    }
    this.save(); return this.data;
  }
  // A dictation that was not understood: kept in the history (with its audio) so it can be recognised again.
  failed(metrics) {
    if (!this.data.historyEnabled) return null;
    const entry = {appliedRules: [], id: randomUUID(), createdAt: new Date().toISOString(), original: '', final: '', language: this.data.language, detectedLanguage: null, model: MODEL, ...metrics, insertion: 'failed'};
    this.data.history.unshift(entry); this.data.history = this.data.history.slice(0, 100); this.save();
    return entry;
  }
  retried(id, original, final) {
    const entry = this.data.history.find(item => item.id === id);
    if (!entry) return;
    Object.assign(entry, {original: text(original), final: text(final), retriedAt: new Date().toISOString(), insertion: entry.insertion === 'failed' ? 'not-inserted' : entry.insertion});
    this.save();
  }
  inserted(id, ok) { const entry = this.data.history.find(r => r.id === id); if(entry) { entry.insertion = ok === null ? 'unknown' : ok ? 'keystroke-sent' : 'not-inserted'; this.save(); } }
}
// The release can take what was recognised in the last speaking pause as it is, when that recognition belongs to
// this recording, covered everything up to the last sound with a margin, and nothing was cut off before it.
export function reusesAhead(ahead, early = {}, cut = 0) {
  if (!ahead || cut || ahead.targetId == null || ahead.targetId !== early?.targetId) return false;
  return Number.isInteger(early?.voiceUntil) && early.voiceUntil >= 0 && early.voiceUntil + 1600 <= ahead.length;
}

// One helper process keeps the model in memory. Requests are answered by id in order, so a warm-up at
// launch and the first dictation can overlap; cancelling only drops the answer, the model stays loaded.
export class Parakeet {
  constructor(helper, directory) { this.helper=helper; this.directory=directory; this.child=null; this.requests=new Map(); this.id=0; this.inflight=null;this.waiting=[]; this.progress=null; this.onProgress=()=>{}; this.status=existsSync(helper) ? 'not-loaded' : 'helper-missing'; }
  get pending() { return [...this.requests.values()].some(request => request.type === 'transcribe'); }
  #spawn() {
    const child = spawn(this.helper,[this.directory],{stdio:['pipe','pipe','ignore']}); this.child=child;
    const fail = () => {
      if (this.child !== child) return;
      this.child=null; this.status='error';this.inflight=null;this.waiting=[];
      for (const request of this.requests.values()) request.reject(new Error('Parakeet konnte nicht starten. Modell in Einstellungen einrichten.'));
      this.requests.clear();
    };
    child.on('error',fail); child.on('exit',fail);
    createInterface({input:child.stdout}).on('line',line => {
      let result; try { result=JSON.parse(line); } catch { return; }
      // A cancelled active decode may still finish. Release its slot, but never its result.
      if(result.type!=='progress' && result.id===this.inflight){this.inflight=null;this.#flush();}
      const request = this.requests.get(result.id);
      if (!request) return;
      if (result.type === 'progress') { this.progress={phase:String(result.phase),fraction:Math.max(0,Math.min(1,Number(result.fraction)||0))}; this.onProgress(this.progress); return; }
      this.requests.delete(result.id);
      if (request.type !== 'transcribe') this.progress=null;
      this.status=result.error ? (request.type === 'transcribe' ? 'ready' : 'error') : 'ready';
      result.error ? request.reject(new Error('Parakeet nicht bereit. Einrichtung prüfen und erneut versuchen.')) : request.resolve(result);
    });
  }
  // The first recognition after a pause took 0.9 s, every next one 0.2 s (measured 15 November 2026). So the
  // moment the dictation key goes down, a breath of silence runs through the model: by the time the person
  // lets go, it is warm. Never while something real is waiting, and not if it ran a moment ago.
  warm(now = Date.now()) {
    if (this.status !== 'ready' || !this.child || this.pending || now - (this.lastUsedAt ?? 0) < 12_000) return false;
    this.lastUsedAt = now;
    this.request('transcribe', new Float32Array(4800)).catch(() => {});
    return true;
  }
  // type: 'load' (warm an installed model), 'setup' (download once, then load) or 'transcribe'.
  request(type, audio) {
    if (type === 'transcribe') this.lastUsedAt = Date.now();
    if (!existsSync(this.helper)) return Promise.reject(new Error('Parakeet-Helfer fehlt in diesem Build.'));
    if(type==='transcribe' && [...this.requests.values()].filter(request=>request.type==='transcribe').length>=4)return Promise.reject(new Error('Spracherkennung ist ausgelastet. Aufnahme bitte erneut versuchen.'));
    if (!this.child) this.#spawn();
    if (type !== 'transcribe') this.status = type === 'setup' ? 'downloading' : 'loading';
    return new Promise((resolve,reject) => {
      const id=++this.id;
      const timeout=setTimeout(() => this.#drop(id,'Zeitlimit erreicht. Bitte erneut versuchen.',true), type==='setup' ? 900000 : 120000);
      this.requests.set(id,{type,resolve:v=>{clearTimeout(timeout);resolve(v);},reject:e=>{clearTimeout(timeout);reject(e);}});
      const payload=JSON.stringify({id,type,audio:audio ? Buffer.from(audio.buffer,audio.byteOffset,audio.byteLength).toString('base64') : undefined})+'\n';
      if(type==='transcribe'){this.waiting.push({id,payload});this.#flush();}
      else this.child.stdin.write(payload,error=>{if(error)this.#drop(id,'Parakeet-Verbindung unterbrochen.',true);});
    });
  }
  #flush() {
    if(this.inflight!==null || !this.child)return;
    let next;
    while((next=this.waiting.shift())) {
      if(!this.requests.has(next.id))continue;
      this.inflight=next.id;
      this.child.stdin.write(next.payload,error=>{if(error)this.#drop(next.id,'Parakeet-Verbindung unterbrochen.',true);});
      return;
    }
  }
  #drop(id, message, restart) {
    const request=this.requests.get(id); this.requests.delete(id); this.waiting=this.waiting.filter(item=>item.id!==id);request?.reject(new Error(message));
    if (restart) { const child=this.child; this.child=null;this.inflight=null;this.waiting=[]; child?.kill(); for (const other of this.requests.values()) other.reject(new Error(message)); this.requests.clear(); this.status='not-loaded'; }
  }
  // Drops waiting transcriptions; the helper finishes its current one and the model stays warm.
  cancel(message='Abgebrochen') { for (const [id,request] of this.requests) if (request.type === 'transcribe') this.#drop(id,message,false); }
  stop() { const child=this.child; this.child=null;this.inflight=null;this.waiting=[]; child?.kill(); for (const request of this.requests.values()) request.reject(new Error('Beendet')); this.requests.clear(); }
}
