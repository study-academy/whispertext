// Global gestures and pasting, per platform. macOS: the bundled Swift helper sees fn, which Electron
// cannot. Windows and Linux: uiohook-napi, with Right Alt in the role of fn (fn never reaches software there).
import {spawn, spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import {KeyChord} from '../core/keychord.js';
import {NOTCH_TIMINGS} from '../core/notch-interaction.js';

export const HOLD_KEY_LABEL = process.platform === 'darwin' ? 'fn' : 'Alt Gr';
// macOS: fn, or right Option / right Command for keyboards without fn or when fn is taken.
export const HOLD_KEYS = {fn: 'fn', rightOption: 'rechte ⌥', rightCommand: 'rechte ⌘'};
const DEVICE = {leftShift: 0x02, rightShift: 0x04, leftCommand: 0x08, rightCommand: 0x10, leftOption: 0x20, rightOption: 0x40};
// The helper reports fn, Control, Option, others and the device bits; this picks which key dictates.
export function mapFlags(event, holdKey = 'fn') {
  const d = event.device ?? 0;
  if (holdKey === 'rightOption') return {hold: !!(d & DEVICE.rightOption), control: !!event.control, option: !!(d & DEVICE.leftOption), other: !!event.other};
  if (holdKey === 'rightCommand') return {hold: !!(d & DEVICE.rightCommand), control: !!event.control, option: !!event.option,
    other: !!(d & (DEVICE.leftShift | DEVICE.rightShift | DEVICE.leftCommand))};
  return {hold: !!event.hold, control: !!event.control, option: !!event.option, other: !!event.other};
}

const seconds = () => performance.now() / 1000;

export class Keys {
  // onGesture({type, mode, locked}) for arm, disarm, begin, finish, cancel; onEscape(); onPermissions({input, accessibility}).
  constructor({helperPath, onGesture, onEscape, onPermissions, talk = true}) {
    this.helperPath = helperPath;
    this.onGesture = onGesture;
    this.onEscape = onEscape;
    this.onPermissions = onPermissions;
    this.chord = new KeyChord({talk});
    this.timer = null;
    this.helper = null;
    this.pasteWaiters = new Map();
    this.targetWaiters = new Map();
    this.fieldWaiters = new Map();
    this.targetId = 0;
    this.targetPromise = Promise.resolve(null);
    this.lastPasteId = null;
    this.pasteId = 0;
    this.requestId = 0;
    this.requests = new Map();
    this.permissionId = 0;
    this.permissionWaiters = new Map();
    this.lastHapticAt = -Infinity;
    this.holdKey = 'fn';
  }

  async start() {
    if (process.platform === 'darwin') return this.#startMac();
    return this.#startHook();
  }

  stop() {
    clearTimeout(this.timer);
    this.#rejectPermissions('HELPER_UNAVAILABLE');
    this.#finishPending();
    this.helper?.stdin.end('quit\n');
    this.helper = null;
    this.hook?.stop();
  }

  cancel() { this.helper?.stdin.write('clear-target\n'); this.#finishPending('cancelled'); this.target = null; this.targetPromise = Promise.resolve(null); this.#apply(this.chord.cancel()); }

  // "Hey Studymut" starts the same hands-free talk as Control twice; silence, one tap of Control or fn, the pill's
  // buttons or Escape end it.
  startHandsFree() { this.#apply(this.chord.lockTalk(seconds())); }
  // The notch left talking and dictating: a hands-free lock that is still set must not swallow the next keys.
  release(mode = null) { this.chord.release(mode); if (this.chord.state.name !== 'locked') this.#ownReturn(false); }
  finishHandsFree() { this.#apply(this.chord.finishLocked()); }

  askInput() { this.helper?.stdin.write('ask-input\n'); }
  askAccessibility() { this.helper?.stdin.write('ask-accessibility\n'); }
  refreshPermissions({timeoutMs = 1200} = {}) {
    if (!this.helper || this.helper.stdin.destroyed) return Promise.reject(Object.assign(new Error('Der Tastaturhelfer ist nicht verfügbar.'), {code: 'HELPER_UNAVAILABLE'}));
    const id = ++this.permissionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.permissionWaiters.delete(id);
        reject(Object.assign(new Error('Der Tastaturhelfer antwortet nicht rechtzeitig.'), {code: 'PERMISSION_TIMEOUT'}));
      }, Math.max(50, Math.min(10000, timeoutMs)));
      this.permissionWaiters.set(id, {resolve, reject, timer});
      this.helper.stdin.write(`permissions ${id}\n`, error => {
        if (error) this.#rejectPermissions('HELPER_UNAVAILABLE');
      });
    });
  }

  // The native API silently does nothing on unsupported hardware. Never vibrate on pointer movement.
  haptic() {
    const now = performance.now();
    if (process.platform !== 'darwin' || !this.helper || this.helper.stdin.destroyed || now - this.lastHapticAt < NOTCH_TIMINGS.hapticCooldown) return false;
    this.lastHapticAt = now;
    this.helper.stdin.write('haptic\n');
    return true;
  }

  #rejectPermissions(code) {
    for (const waiter of this.permissionWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(Object.assign(new Error('Der Tastaturhelfer wurde beendet.'), {code}));
    }
    this.permissionWaiters.clear();
  }

  // Each snapshot remains bound to its original native field, including across another capture.
  captureTarget() {
    const targetId = ++this.targetId;
    this.target = null;
    this.targetPromise = !this.helper ? Promise.resolve(null) : new Promise(resolve => {
      const timer = setTimeout(() => { this.targetWaiters.delete(targetId); resolve(null); }, 1500);
      this.targetWaiters.set(targetId, {resolve, timer});
      this.helper.stdin.write(`capture-target ${targetId}\n`);
    });
    return this.targetPromise;
  }

  // Read only the edited insertion belonging to this paste, never another session's field.
  readInserted(pasteId = this.lastPasteId) {
    if (!this.helper || !Number.isSafeInteger(pasteId)) return Promise.resolve(null);
    const id = ++this.requestId;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.fieldWaiters.delete(id); resolve(null); }, 1500);
      this.fieldWaiters.set(id, {resolve, timer, pasteId});
      this.helper.stdin.write(`read-inserted ${id} ${pasteId}\n`);
    });
  }

  #finishPending(reason = 'helper') {
    for (const [id, waiter] of this.pasteWaiters) { clearTimeout(waiter.timer); waiter.resolve({ok: null, reason, pasteId: id}); }
    for (const waiter of [...this.targetWaiters.values(), ...this.fieldWaiters.values()]) { clearTimeout(waiter.timer); waiter.resolve(null); }
    this.pasteWaiters.clear(); this.targetWaiters.clear(); this.fieldWaiters.clear();
  }

  // What is on screen in the frontmost window (app, window title, labelled elements with centres), or null.
  // Read locally over Accessibility; nothing leaves the Mac unless a turn needs it. Never in secure input.
  elements() { return this.#request('elements', '', 1500); }
  // An app's front window on the screen, {x, y, width, height} in points, or null.
  windowOf(bundle) { return this.#request('window-of', bundle, 800).then(reply => { const r = reply?.rects?.[0]; return r && r[2] > 0 ? {x: r[0], y: r[1], width: r[2], height: r[3]} : null; }); }
  // The name of what stands at a point of the screen ({label, role}), or null.
  at(x, y) { return this.#request('at', `${Math.round(x)} ${Math.round(y)}`, 800); }
  // Acting for the person, only after they confirmed in the notch (see main/actions.js).
  click(x, y) { return this.#request('click', `${Math.round(x)} ${Math.round(y)}`); }
  // The element under the point does its own action (AXPress); false means: fall back to the mouse.
  press(x, y) { return this.#request('press', `${Math.round(x)} ${Math.round(y)}`); }
  // Sets a text field's value through accessibility and checks it took; never a password field.
  setValue(x, y, text) { return this.#request('setv', `${Math.round(x)},${Math.round(y)} ${Buffer.from(String(text)).toString('base64')}`); }
  // The menu item that has cmd+<key> as its shortcut, pressed through accessibility (Undo is "Z").
  menuShortcut(key) { return /^[a-z]$/i.test(key) ? this.#request('menukey', key.toUpperCase()) : Promise.resolve(null); }
  // Text in at the caret through accessibility; false means: fall back to keystrokes.
  insert(text) { return this.#request('insert', Buffer.from(String(text)).toString('base64')); }
  // The tidied text takes the place of what a dictation inserted a moment ago, only while everything is as it was
  // left (same field, text untouched, caret right behind it). {ok, reason, method}.
  replaceInserted(pasteId, expected, replacement) {
    if (!this.helper || !Number.isSafeInteger(pasteId) || !expected || !replacement) return Promise.resolve({ok: false, reason: 'no-region'});
    return this.#request('replace-inserted', `${pasteId} ${Buffer.from(String(expected)).toString('base64')} ${Buffer.from(String(replacement)).toString('base64')}`, 2500);
  }
  // The words in a picture of the screen with their places, read on this Mac: {ok, width, height, words: [[text, x, y, w, h]]}.
  readWords(path) { return this.#request('ocr', Buffer.from(String(path)).toString('base64'), 6000); }
  // {known, role, value}: what the focused field holds, to check typed text arrived.
  focused() { return this.#request('focused', '', 1500); }
  // Screen rectangles of pieces ([offset, length]) of the selection captured as `targetId`; null where unknown.
  rangeBounds(targetId, pieces) { return this.#request('bounds', `${targetId} ${Buffer.from(JSON.stringify(pieces)).toString('base64')}`, 2500).then(reply => reply?.rects ?? []); }
  menu(path) { return this.#request('menu', Buffer.from(JSON.stringify(path.map(String))).toString('base64')); }
  type(text) { return this.#request('type', Buffer.from(String(text)).toString('base64')); }
  key(combo) { return /^[a-z0-9+]{1,30}$/i.test(combo) ? this.#request('key', combo.toLowerCase()) : Promise.resolve(null); }
  doubleClick(x, y) { return this.#request('dclick', `${Math.round(x)},${Math.round(y)}`); }
  rightClick(x, y) { return this.#request('rclick', `${Math.round(x)},${Math.round(y)}`); }
  // x, y of -1 scroll where the pointer is; dx, dy in lines, positive is down and right.
  scroll(x, y, dx, dy) { return this.#request('scroll', `${Math.round(x)},${Math.round(y)} ${Math.round(dx)},${Math.round(dy)}`); }
  drag(x1, y1, x2, y2) { return this.#request('drag', `${Math.round(x1)},${Math.round(y1)} ${Math.round(x2)},${Math.round(y2)}`); }
  quitApp(name) { return this.#request('quit', Buffer.from(String(name)).toString('base64')); }
  activateApp(name) { return this.#request('activate', Buffer.from(String(name)).toString('base64')); }

  #request(verb, args, timeoutMs = 3000) {
    if (process.platform !== 'darwin' || !this.helper) return Promise.resolve(null);
    const id = ++this.requestId;
    return new Promise(resolve => {
      this.requests.set(id, resolve);
      this.helper.stdin.write(`${verb} ${id}${args ? ' ' + args : ''}\n`);
      setTimeout(() => { if (this.requests.delete(id)) resolve(null); }, timeoutMs);
    });
  }

  // Pastes into the field captured when the key went down. Resolves {ok, reason}; ok is null when unknown.
  paste(text, {targetId = this.target?.targetId} = {}) {
    if (process.platform === 'darwin') {
      if (!this.helper) return Promise.resolve({ok: false, reason: 'helper'});
      if (!Number.isSafeInteger(targetId) || targetId <= 0) return Promise.resolve({ok: false, reason: 'no-target'});
      // Native pasteboard promises cannot overlap safely. Never silently replace an outstanding caller.
      if (this.pasteWaiters.size) return Promise.resolve({ok: false, reason: 'paste-busy'});
      return new Promise(resolve => {
        const id = ++this.pasteId;
        const timer = setTimeout(() => {
          if (this.pasteWaiters.delete(id)) resolve({ok: null, reason: 'timeout', pasteId: id, targetId});
        }, 2500);
        this.pasteWaiters.set(id, {resolve, timer, targetId});
        this.helper.stdin.write(`paste-session ${id} ${Date.now() + 1800} ${targetId} ${Buffer.from(text).toString('base64')}\n`, error => {
          const waiter = this.pasteWaiters.get(id);
          if (error && waiter) { clearTimeout(waiter.timer); this.pasteWaiters.delete(id); resolve({ok: null, reason: 'helper', pasteId: id, targetId}); }
        });
      });
    }
    const [command, args] = process.platform === 'win32'
      ? ['powershell', ['-NoProfile', '-Command', '(New-Object -ComObject WScript.Shell).SendKeys("^v")']]
      : ['xdotool', ['key', '--clearmodifiers', 'ctrl+v']];
    const result = spawnSync(command, args, {timeout: 3000, windowsHide: true});
    return Promise.resolve({ok: result.status === 0, reason: result.status === 0 ? null : 'keystroke'});
  }

  // Resolves once no modifier is held any more (at most 700 ms), so a pasted ⌘V is not read as ⌃⌘V.
  async modifiersReleased() {
    for (let waited = 0; waited < 700 && Object.values(this.chord.flags).some(Boolean); waited += 15) await new Promise(r => setTimeout(r, 15));
  }

  #apply(effect) {
    if (effect.type === 'arm') {
      this.onGesture({type: 'arm', mode: effect.mode});
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.#apply(this.chord.tick(seconds())), Math.max(0, (effect.deadline - seconds()) * 1000) + 5);
      return;
    }
    if (effect.type !== 'none') this.onGesture(effect);
    // Return belongs to the dictation only while it runs hands-free.
    if (effect.type === 'begin' && effect.locked) this.#ownReturn(true);
    else if (['finish', 'cancel'].includes(effect.type) || this.chord.state.name !== 'locked') this.#ownReturn(false);
  }
  #ownReturn(on) { if (this.returnOwned === on) return; this.returnOwned = on; try { this.helper?.stdin?.write(on ? 'return-own-on\n' : 'return-own-off\n'); } catch {} }

  // Whether the fn key is Studymut's alone (the helper then keeps its presses from macOS).
  // The key left of 1 as the emoji key (by choice in the settings).
  emojiKey(on) { this.emoji = !!on; try { this.helper?.stdin?.write(on ? 'emoji-key-on\n' : 'emoji-key-off\n'); } catch {} }
  ownFn(own) { try { this.helper?.stdin?.write(own ? 'fn-swallow\n' : 'fn-keep\n'); } catch {} }

  #startMac() {
    const child = spawn(this.helperPath, [], {stdio: ['pipe', 'pipe', 'ignore']});
    this.helper = child;
    this.ownFn(this.holdKey === 'fn');
    this.emojiKey(this.emoji);
    const unavailable = () => {
      if (this.helper !== child) return;
      this.#rejectPermissions('HELPER_UNAVAILABLE');
      this.#finishPending();
      this.target = null;
      this.helper = null;
      this.onPermissions({listening:false,missing:true});
    };
    child.on('error', unavailable);
    child.on('exit', unavailable);
    child.stdin.on('error', unavailable);
    createInterface({input: child.stdout}).on('line', line => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'flags') this.#apply(this.chord.flagsChanged(mapFlags(event, this.holdKey), seconds()));
      else if (event.type === 'front') this.onFront?.(event);
      else if (event.type === 'emoji-key') this.onEmojiKey?.(event);
      // Return during a hands-free dictation: done, like ✓ (the helper keeps it from the app in front).
      // If the dictation already ended some other way, the key goes on to the app after all.
      else if (event.type === 'return') { if (this.chord.state.name === 'locked') this.finishHandsFree(); else { this.#ownReturn(false); this.key('return'); } }
      else if (event.type === 'key') { this.onKey?.(event); if (event.escape) this.onEscape(); this.#apply(this.chord.keyDown()); }
      else if (event.type === 'permissions') {
        const checked = {...event, checkedAt: Date.now()};
        const waiter = this.permissionWaiters.get(event.id);
        if(Number.isFinite(event.id)&&event.id!==0&&!waiter)return; // Ignore expired or unrelated replies.
        if (waiter) { clearTimeout(waiter.timer); this.permissionWaiters.delete(event.id); waiter.resolve(checked); }
        this.onPermissions(checked);
      }
      else if (['elements', 'acted', 'focused', 'bounds'].includes(event.type) && this.requests.has(event.id)) { const done = this.requests.get(event.id); this.requests.delete(event.id); done(event); }
      else if (event.type === 'target') {
        const waiter = this.targetWaiters.get(event.targetId);
        if (!waiter) return;
        const snapshot = Object.freeze({targetId: event.targetId, app: event.app, name: event.name, selection: event.selection ?? '',
          domain: event.domain ?? '', beforeText: event.beforeText ?? '', afterText: event.afterText ?? '',
          bounds: Array.isArray(event.bounds) && event.bounds.length === 4 && event.bounds.every(Number.isFinite) ? {x: event.bounds[0], y: event.bounds[1], width: event.bounds[2], height: event.bounds[3]} : null});
        clearTimeout(waiter.timer); this.targetWaiters.delete(event.targetId);
        if (event.targetId === this.targetId) this.target = snapshot;
        waiter.resolve(snapshot);
      }
      else if (event.type === 'field') {
        const waiter = this.fieldWaiters.get(event.id);
        if (waiter && event.pasteId === waiter.pasteId) { clearTimeout(waiter.timer); this.fieldWaiters.delete(event.id); waiter.resolve(typeof event.value === 'string' ? event.value : null); }
      }
      else if (event.type === 'paste') {
        const waiter = this.pasteWaiters.get(event.id);
        if (!waiter) return;
        clearTimeout(waiter.timer); this.pasteWaiters.delete(event.id);
        if (event.ok === true) this.lastPasteId = event.id;
        waiter.resolve({ok: event.ok, reason: event.reason ?? null, method: event.method ?? null,
          verification: event.verification ?? 'unknown', pasteId: event.id, targetId: waiter.targetId});
      }
    });
    child.stdin.write('start\n');
  }

  async #startHook() {
    let uIOhook, UiohookKey;
    try { ({uIOhook, UiohookKey} = await import('uiohook-napi')); } catch { this.onPermissions({input: false, missing: true}); return; }
    this.hook = uIOhook;
    const down = new Set();
    const group = {
      hold: [UiohookKey.AltRight],
      control: [UiohookKey.Ctrl, UiohookKey.CtrlRight],
      option: [UiohookKey.Alt],
      other: [UiohookKey.Shift, UiohookKey.ShiftRight, UiohookKey.Meta, UiohookKey.MetaRight],
    };
    const modifiers = new Set(Object.values(group).flat());
    const flags = () => Object.fromEntries(Object.entries(group).map(([name, codes]) => [name, codes.some(code => down.has(code))]));
    uIOhook.on('keydown', event => {
      if (modifiers.has(event.keycode)) {
        if (down.has(event.keycode)) return; // key repeat
        down.add(event.keycode);
        this.#apply(this.chord.flagsChanged(flags(), seconds()));
      } else {
        if (event.keycode === UiohookKey.Escape) this.onEscape();
        this.#apply(this.chord.keyDown());
      }
    });
    uIOhook.on('keyup', event => {
      if (!modifiers.has(event.keycode)) return;
      down.delete(event.keycode);
      this.#apply(this.chord.flagsChanged(flags(), seconds()));
    });
    uIOhook.start();
    this.onPermissions({input: true, accessibility: true});
  }
}
