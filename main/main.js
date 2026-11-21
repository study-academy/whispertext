// whispertext: dictation for every app on the Mac, with fn only. A strich under the notch that becomes the voice
// while one dictates; resting on it opens the same dark row with history and words. Local recognition with
// Parakeet, local formatting, dictionary, snippets and learned corrections. No account, no AI service.
// Taken from the Studymut desktop app (b77e3b4) with everything that is not dictation left out.
import {app, BrowserWindow, ipcMain, screen, shell, clipboard, systemPreferences, session, dialog, Menu, globalShortcut} from 'electron';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {readWispr, applyWispr} from './wispr-import.js';

// "39 Wörter aus Wispr Flow" (and the dictations, when there were any).
const importText = ({words, history}) => [words ? `${words} Wörter` : '', history ? `${history} Diktate` : ''].filter(Boolean).join(' und ') + ' aus Wispr Flow';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {startStaticServer} from './static-server.js';
import {DictationStore, Recognizer, reusesAhead} from './dictation.js';
import {PermissionFlow} from './permissions.js';
import {notchLayout, inside} from '../core/notch-layout.js';
import {Settings} from './settings.js';
import {NOTCH_TIMINGS} from '../core/notch-interaction.js';
import {Keys} from './keys.js';
import {DragHelper} from './drag-helper.js';
import {GlassBacking, fadeIn} from './glass.js';
import {DictationAudio, toWav} from './dictation-audio.js';
import {polishDictation, dictationContext, formatAtCursor, styleFor, correctionStep} from '../core/dictation-text.js';
import {vocabularyFix, ownNames, termsIn, TEAM_TERMS} from '../core/vocabulary.js';
import {knownPath, readCachedPath, refreshPath} from './user-path.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const NAME = 'whispertext';
// The window around the row under the notch; the row itself is much smaller and says how big it is.
const WINDOW_SIZE = {width: 480, height: 420};
const HOVER_OPEN_MS = NOTCH_TIMINGS.hoverDwell, LEAVE_CLOSE_MS = NOTCH_TIMINGS.leaveDelay, POLL_MS = 33;
// Testing aids: a hidden copy with its own profile, driven over the debugging port.
const HIDDEN_PREVIEW = process.argv.includes('--hidden-preview') && process.argv.some(arg => arg.startsWith('--dictation-test-profile='));
const KEEP_OPEN = process.argv.includes('--keep-open');
const NO_KEYS = process.argv.includes('--no-global-keys');
// The intro, one step after the other: hold fn, fn twice (and fn to end), ⌃⌘V, the emoji key, the history, the words.
const INTRO_STEPS = 6;

class Notch {
  constructor({origin, settings}) {
    this.origin = origin;
    this.settings = settings;
    // rest | dictate | row (the two icons) | open (history or words) | setup (a missing permission, then the intro)
    this.mode = 'rest';
    this.page = 'history';
    this.hoverSince = null;
    this.leftSince = null;
    this.permissions = {input: null, accessibility: null};
    this.permissionState = {microphone: 'unknown', input: null, accessibility: null, listening: null, step: 'microphone', polling: false};
    this.displayId = screen.getPrimaryDisplay().id;
    this.geometry = notchLayout(this.display(), WINDOW_SIZE);
    this.win = new BrowserWindow({
      width: this.geometry.window.width, height: this.geometry.window.height, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hasShadow: false,
      show: false, focusable: true, alwaysOnTop: true, type: process.platform === 'darwin' ? 'panel' : undefined,
      backgroundColor: '#00000000', title: NAME,
      webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true, preload: join(root, 'main', 'preload.cjs')},
    });
    this.win.setAlwaysOnTop(true, 'status');
    this.win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
    this.win.setIgnoreMouseEvents(true);
    this.ignoringMouse = true;
    this.win.webContents.on('will-navigate', event => event.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    // Opened and clicked into: the row stays until the person goes elsewhere.
    this.win.on('blur', () => { if (this.mode === 'open' && !this.interactionProtected && !KEEP_OPEN && !this.intro) this.setMode('rest'); });
    this.win.loadURL(this.origin + '/');
    // The first load right after launch once came up empty (20.11.2026, installed build): check that the strich is
    // there, and load again if not, at most three times.
    let reloads = 0;
    this.win.webContents.on('did-fail-load', (event, code, description, url, mainFrame) => { if (mainFrame && code !== -3 && reloads++ < 5) setTimeout(() => !this.win.isDestroyed() && this.win.loadURL(this.origin + '/'), 400); });
    this.win.webContents.on('did-finish-load', () => setTimeout(() => {
      if (this.win.isDestroyed()) return;
      this.win.webContents.executeJavaScript('!!document.getElementById("handle") && !!window.studymut').then(ok => {
        if (!ok && reloads++ < 3) this.win.webContents.reload();
      }, () => { if (reloads++ < 3) this.win.webContents.reload(); });
    }, 600));
    this.win.once('ready-to-show', () => { this.place(); if (!HIDDEN_PREVIEW) this.win.showInactive(); this.onReady?.(); });
    screen.on('display-metrics-changed', () => this.place());
    screen.on('display-added', () => this.place());
    screen.on('display-removed', () => this.place());
    this.poll = setInterval(() => this.#tick(), POLL_MS);
  }

  // A background panel only takes focus once the app itself is active.
  focus() { if (HIDDEN_PREVIEW) return; if (process.platform === 'darwin') app.focus({steal: true}); this.win.focus(); }
  display() { return screen.getAllDisplays().find(display => display.id === this.displayId) ?? screen.getPrimaryDisplay(); }

  // Top centre, directly under the menu bar (and so under a camera notch).
  place() {
    // Screen changes can still arrive while the app quits, after the window is gone.
    if (this.win.isDestroyed()) return;
    this.geometry = notchLayout(this.display(), WINDOW_SIZE);
    this.win.setBounds(this.geometry.window);
    this.publish();
  }

  state() {
    return {version: app.getVersion(), mode: this.mode, page: this.page, hushed: !!this.hushed, intro: this.intro ?? 0, introOk: !!this.introOk,
      missing: this.missing(), permissionState: this.permissionState, platform: process.platform, imported: this.imported ?? null};
  }
  // The permission a person still has to give, or null.
  missing() {
    const s = this.permissionState;
    if (s.microphone !== 'granted') return 'microphone';
    // Only a confirmed grant counts (after the password). While a check runs (every second during the setup) the
    // last known answer stands, so the row does not flicker between the step and nothing.
    if (s.helperStatus === 'checking' || s.accessibility == null) return this.accessibilityMissing ? 'accessibility' : null;
    this.accessibilityMissing = s.accessibility !== true;
    if (this.accessibilityMissing) return 'accessibility';
    return null;
  }

  // While something in the strich can be clicked (the hands-free pill, a message), a click there must not take
  // the focus from the app the person works in.
  syncFocusable() { if (process.platform === 'darwin' && !this.win.isDestroyed()) this.win.setFocusable(!(this.pillHitRect || this.noticeHitRect)); }
  sendHover(progress) { if (!progress && !this.hoverShown) return; this.hoverShown = progress > 0; this.send('studymut:hover', progress); }
  setHushed(hushed) { hushed = !!hushed; if (this.hushed === hushed) return; this.hushed = hushed; this.publish(); }
  send(channel, payload) { if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload); }
  publish() { if (this.win.isDestroyed()) return; this.send('studymut:state', this.state()); }

  setMode(mode, page = null) {
    if (page) this.page = page;
    if (this.mode === mode) { this.publish(); return; }
    // The setup does not go away by itself while something is missing or the intro runs: after a dictation in the
    // intro the row comes back with the next step.
    if (mode === 'rest' && this.intro) mode = this.intro >= 5 ? 'open' : 'setup';
    else if (mode === 'rest' && this.missing() && this.settings.get().permissionSetup.active) mode = 'setup';
    if (mode === 'open' && this.intro >= 5) this.page = this.intro === 5 ? 'history' : 'words';
    this.mode = mode;
    if (mode !== 'dictate') this.keys?.release();
    if (mode !== 'dictate' && this.pillHitRect) { this.pillHitRect = null; this.syncFocusable(); }
    const interactive = ['row', 'open', 'setup'].includes(mode);
    this.win.setIgnoreMouseEvents(!interactive, {forward: true});
    this.ignoringMouse = !interactive;
    if (mode === 'rest' && this.win.isFocused()) this.win.blur();
    if (mode === 'open') this.focus();
    this.hoverSince = null; this.sendHover(0);
    this.leftSince = null;
    if (mode === 'row' && this.settings.get().haptics) this.keys?.haptic();
    this.publish();
  }

  #tick() {
    if (this.win.isDestroyed()) return;
    const cursor = screen.getCursorScreenPoint();
    if (this.mode === 'rest') {
      const nearby = screen.getDisplayNearestPoint(cursor);
      const zone = {x: nearby.workArea.x + nearby.workArea.width / 2 - 70, y: nearby.bounds.y, width: 140, height: nearby.workArea.y - nearby.bounds.y + 28};
      if (nearby.id !== this.displayId && inside(cursor, zone)) { this.displayId = nearby.id; this.place(); }
    }
    const bounds = this.win.getBounds();
    const local = {x: cursor.x - bounds.x, y: cursor.y - bounds.y};
    // Only the row itself takes clicks; everything around it stays click-through.
    const region = ['row', 'open', 'setup'].includes(this.mode) ? this.rowHitRect : this.mode === 'dictate' ? this.pillHitRect : this.mode === 'rest' ? this.noticeHitRect : null;
    if (this.mode !== 'rest' || this.noticeHitRect) {
      const ignore = !region || !inside(local, region);
      if (ignore !== this.ignoringMouse) { this.win.setIgnoreMouseEvents(ignore, {forward: true}); this.ignoringMouse = ignore; }
      if (this.mode === 'rest' && !ignore) { this.hoverSince = null; this.sendHover(0); return; }
    }
    const now = Date.now();
    if (this.mode === 'rest') {
      // The handle zone reaches up into the menu bar, so the screen edge counts as on the handle.
      const {bounds: screenBounds} = this.display();
      const zone = {x: bounds.x + bounds.width / 2 - 48, y: screenBounds.y, width: 96, height: bounds.y - screenBounds.y + 12};
      // Resting, not passing: a pointer that still travels starts the wait again.
      const rest = this.hoverAt;
      const moving = rest && Math.hypot(cursor.x - rest.x, cursor.y - rest.y) > 10;
      if (!rest || moving) this.hoverAt = {x: cursor.x, y: cursor.y};
      if (inside(cursor, zone) && moving) this.hoverSince = now;
      if (inside(cursor, zone)) {
        this.hoverSince ??= now;
        this.sendHover(Math.max(.01, Math.min(1, (now - this.hoverSince) / HOVER_OPEN_MS)));
        if (now - this.hoverSince >= HOVER_OPEN_MS) this.setMode('row');
      } else { this.hoverSince = null; this.sendHover(0); }
      return;
    }
    // The row and an opened list close when the pointer has left them for a moment, unless clicked into.
    if (['row', 'open'].includes(this.mode) && !KEEP_OPEN && !this.intro && !this.interactionProtected && !(this.mode === 'open' && this.win.isFocused())) {
      const r = this.rowHitRect;
      const near = r && inside(local, {x: r.x - 16, y: -40, width: r.width + 32, height: r.y + r.height + 24 + 40});
      if (near) this.leftSince = null;
      else { this.leftSince ??= now; if (now - this.leftSince >= LEAVE_CLOSE_MS) this.setMode('rest'); }
    }
  }
}

// The practice field in the middle of the screen for the intro's first three steps: frosted glass with one text
// area, focused, so the first dictations land somewhere the person sees.
class Practice {
  constructor(origin) { this.origin = origin; this.win = null; }
  show() {
    if (HIDDEN_PREVIEW) return;
    if (!this.win || this.win.isDestroyed()) {
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      const width = 460, height = 370;
      this.win = new BrowserWindow({width, height, x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + area.height * .38 - height / 2),
        type: process.platform === 'darwin' ? 'panel' : undefined, frame: false, transparent: false, vibrancy: 'menu', visualEffectState: 'active', roundedCorners: true, hasShadow: true, resizable: false,
        minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: '#00000000',
        webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true}});
      this.win.setAlwaysOnTop(true, 'floating', 1);
      // On every desktop: switching spaces or apps in the intro still finds the field.
      this.win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
      this.win.webContents.on('will-navigate', event => event.preventDefault());
      this.win.loadURL(this.origin + '/practice.html');
      this.win.webContents.on('did-finish-load', () => this.step(this.current));
      this.win.once('ready-to-show', () => this.focus());
    } else this.focus();
  }
  focus() { if (!this.win || this.win.isDestroyed()) return; if (process.platform === 'darwin') app.focus({steal: true}); this.win.show(); this.win.focus(); this.win.webContents.focus(); this.win.webContents.executeJavaScript("document.getElementById('field').focus()").catch(() => {}); }
  // Under the field a small Mac keyboard shows where the keys of this step are and how to press them.
  step(step) { this.current = step; if (this.win && !this.win.isDestroyed()) this.win.webContents.executeJavaScript(`document.body.dataset.step = '${Number(step) || 0}'`).catch(() => {}); }
  hide() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

// Behind the intro the screen is a little darker and blurred, so the row and the practice field stand out. With a
// hole: everything but that place (System Settings while the app is dragged into the list). Clicks go through.
class Dim {
  constructor(origin) { this.origin = origin; this.wins = []; this.key = ''; }
  show(hole = null) {
    if (HIDDEN_PREVIEW) return;
    const {bounds} = screen.getDisplayNearestPoint(hole ? {x: hole.x + hole.width / 2, y: hole.y + hole.height / 2} : screen.getCursorScreenPoint());
    const pad = 10;
    const rects = !hole ? [bounds] : (() => {
      const left = Math.max(bounds.x, Math.round(hole.x - pad)), top = Math.max(bounds.y, Math.round(hole.y - pad));
      const right = Math.min(bounds.x + bounds.width, Math.round(hole.x + hole.width + pad)), bottom = Math.min(bounds.y + bounds.height, Math.round(hole.y + hole.height + pad));
      return [{x: bounds.x, y: bounds.y, width: bounds.width, height: top - bounds.y}, {x: bounds.x, y: bottom, width: bounds.width, height: bounds.y + bounds.height - bottom},
        {x: bounds.x, y: top, width: left - bounds.x, height: bottom - top}, {x: right, y: top, width: bounds.x + bounds.width - right, height: bottom - top}].filter(r => r.width > 0 && r.height > 0);
    })();
    const key = JSON.stringify(rects);
    if (key === this.key) return;
    this.key = key;
    while (this.wins.length > rects.length) this.wins.pop().destroy();
    rects.forEach((rect, index) => {
      let win = this.wins[index];
      if (!win || win.isDestroyed()) {
        win = new BrowserWindow({...rect, type: process.platform === 'darwin' ? 'panel' : undefined, frame: false, transparent: false, vibrancy: 'fullscreen-ui', visualEffectState: 'active', hasShadow: false, roundedCorners: false,
          resizable: false, movable: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, enableLargerThanScreen: true,
          backgroundColor: '#00000000', webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true}});
        win.setAlwaysOnTop(true, 'floating', 0);
        win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
        win.setIgnoreMouseEvents(true);
        win.loadURL(this.origin + '/dim.html');
        win.once('ready-to-show', () => { if (!win.isDestroyed()) { fadeIn(win, () => win.showInactive(), 260); this.onShown?.(); } });
        this.wins[index] = win;
      } else win.setBounds(rect);
    });
  }
  hide() { for (const win of this.wins) if (!win.isDestroyed()) win.destroy(); this.wins = []; this.key = ''; }
}

// macOS can use fn itself ("Press fn to …"). 0 = do nothing; anything else collides with dictation.
const FN_USES = {1: 'Eingabequelle wechseln', 2: 'Emoji anzeigen', 3: 'Diktat starten'};
function fnConflict() {
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('defaults', ['read', 'com.apple.HIToolbox', 'AppleFnUsageType'], {encoding: 'utf8', timeout: 2000});
  return FN_USES[Number(result.stdout?.trim())] ?? null;
}

// Resolves {ok, reason}: ok true when the text reached the field, false with a reason.
async function insertText(keys, text, targetId) {
  const value = String(text ?? '');
  if (!value.trim() || Buffer.byteLength(value) > 100000) return {ok: false, reason: 'empty'};
  if (process.platform === 'darwin') return keys.paste(value, {targetId});
  const previous = clipboard.availableFormats().every(format => format.startsWith('text/plain')) ? clipboard.readText() : null;
  clipboard.writeText(value);
  const pasted = await keys.paste();
  if (previous !== null) setTimeout(() => { if (clipboard.readText() === value) clipboard.writeText(previous); }, 800);
  return pasted;
}

// The speech model inside the app (packaged builds) or downloaded once into the app's folder.
function modelHome() {
  const bundled = app.isPackaged ? join(process.resourcesPath, 'models') : join(root, 'native', 'models');
  return existsSync(join(bundled, 'parakeet-tdt-0.6b-v3', '.fluidaudio-revision')) ? join(bundled, 'parakeet-v3') : join(app.getPath('userData'), 'parakeet-v3');
}

const testProfile = process.argv.find(arg => arg.startsWith('--dictation-test-profile='))?.split('=').slice(1).join('=');
if (testProfile) app.setPath('userData', testProfile);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(async () => {
    try {
      // A normal app with a Dock icon (a menu bar icon disappears behind the notch when the bar is full). The hidden
      // test copy stays out of the Dock. It starts with the Mac.
      if (process.platform === 'darwin' && HIDDEN_PREVIEW) app.dock?.hide();
      if (app.isPackaged && !testProfile) app.setLoginItemSettings({openAtLogin: true});
      const pathFile = join(app.getPath('userData'), 'shell-path.txt');
      process.env.PATH = knownPath(readCachedPath(pathFile));
      const settings = new Settings(join(app.getPath('userData'), 'settings.json'));
      const dictation = new DictationStore(join(app.getPath('userData'), 'dictation.json'));
      // Dictations brought over from Wispr Flow: text only, kept apart from the own history (which keeps 100).
      const importedFile = join(app.getPath('userData'), 'imported-history.json');
      let imported = []; try { imported = JSON.parse(readFileSync(importedFile, 'utf8')); } catch {}
      if (!Array.isArray(imported)) imported = [];
      let importNotice = null;
      // Once, on the first start: what the person has in Wispr Flow on this Mac comes along without a question.
      if (!settings.get().wisprImported) {
        try {
          const found = await readWispr();
          if (found) {
            const counted = applyWispr(dictation, found);
            imported = found.history.slice(0, 20000);
            writeFileSync(importedFile, JSON.stringify(imported), {mode: 0o600});
            if (counted.words || counted.history) importNotice = counted;
          }
        } catch (error) { console.error('wispr import', error.message); }
        settings.update({wisprImported: true, wisprCount: importNotice ?? {words: 0, history: 0}});
      }
      const historyRows = () => [...dictation.data.history.map(({id, createdAt, app: name, final}) => ({id, createdAt, app: name, final})), ...imported]
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      // The microphone follows the Mac's own choice (AirPods, a USB microphone), and noise is always filtered.
      if (dictation.data.deviceId || dictation.data.noiseSuppression === false) dictation.update({deviceId: '', noiseSuppression: true});
      const helper = name => app.isPackaged ? join(process.resourcesPath, name) : join(root, 'native', 'mac', 'bin', name.replace(/^whispertext/, 'studymut'));
      const parakeet = new Recognizer(helper('whispertext-parakeet'), modelHome());
      let dictationGeneration = 0;
      const targetCaptures = new Map();
      // The recognition of a speaking pause; when nothing more is said, the release uses it.
      let heardAhead = null;
      let recovery = '';
      // The last dictation stays in memory only, for ⌃⌘V, and only 10 minutes.
      let lastDictationText = '', lastDictationAt = 0, lastDictationUntil = null;
      const LAST_DICTATION_MS = 10 * 60_000;
      const {server, origin} = await startStaticServer(join(root, 'ui'), null);
      const fromUi = event => event.senderFrame?.url.startsWith(origin + '/');

      // Only the notch UI may use the microphone.
      session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) =>
        callback(['media', 'clipboard-sanitized-write'].includes(permission) && details.requestingUrl?.startsWith(origin + '/')));
      session.defaultSession.setPermissionCheckHandler((wc, permission, requestingOrigin) =>
        ['media', 'clipboard-sanitized-write'].includes(permission) && requestingOrigin === origin);

      // whispertext talks to nothing but its own page on this Mac: no system proxy in between (a proxy list that
      // could not be reached made the first load fail, 20.11.2026).
      await session.defaultSession.setProxy({mode: 'direct'}).catch(() => {});
      const notch = new Notch({origin, settings});
      const backing = new GlassBacking({hidden: HIDDEN_PREVIEW, material: 'menu'});
      const practice = new Practice(origin);
      const dim = new Dim(origin);
      let following = null;
      // Whatever stands on the dimmed screen comes back in front of it.
      dim.onShown = () => { practice.focus(); if (!notch.win.isDestroyed()) notch.win.moveTop(); };
      let settleFixes = null;
      parakeet.onProgress = progress => notch.send('studymut:dictation-progress', progress);

      let permissionFlow;
      let handsFreeRun = false, introAfterHandsFree = false;
      // The intro after the permissions: the three keys, pressed for real, one after the other.
      const introNext = step => {
        if (notch.intro !== step || notch.introOk) return;
        // A step that worked shows a small green check in the row for a moment, then the next one comes.
        if (step <= 4) { notch.introOk = true; notch.publish(); setTimeout(() => { notch.introOk = false; introGo(step); }, 1100); return; }
        introGo(step);
      };
      const introGo = step => {
        notch.intro = step >= INTRO_STEPS ? 0 : step + 1;
        // The emoji step only for those whose fn opened the emojis.
        if (notch.intro === 4 && !keys.emoji) notch.intro = 5;
        syncPractice();
        if (!notch.intro) { settings.update({introDone: true}); permissionFlow.passTest(); notch.setMode('rest'); notch.send('studymut:notice', {kind: 'done'}); }
        else if (notch.intro >= 5) notch.setMode('open', notch.intro === 5 ? 'history' : 'words');
        else if (notch.mode !== 'dictate') notch.setMode('setup');
        else notch.publish();
      };
      const syncPractice = () => {
        if (notch.intro >= 1 && notch.intro <= 4 && !notch.missing()) { practice.step(notch.intro); practice.show(); } else practice.hide();
        if (notch.intro >= 1 && !notch.missing()) dim.show(); else if (!following) dim.hide();
      };
      // Whenever something is missing, or the intro has not been done, the row shows that step.
      const checkSetup = () => {
        if (notch.missing()) { if (settings.get().permissionSetup.active && notch.mode === 'rest') notch.setMode('setup'); return; }
        if (!settings.get().introDone && !notch.intro && notch.permissionState.accessibility === true && notch.permissionState.listening === true) { notch.intro = 1; notch.setMode('setup'); syncPractice(); return; }
        if (notch.mode === 'setup' && !notch.intro) notch.setMode('rest');
      };

      const keys = new Keys({
        helperPath: helper('whispertext-keys'),
        talk: false,
        onGesture: effect => {
          if (effect.type === 'cancel') { handsFreeRun = false; dictationGeneration++; parakeet.cancel(); notch.setMode('rest'); }
          // A hands-free dictation that ended with fn or ✓ is the intro's second step.
          if (effect.type === 'begin') handsFreeRun = !!effect.locked;
          if (effect.type === 'finish' && handsFreeRun) { handsFreeRun = false; introAfterHandsFree = true; }
          // The microphone opens on 'arm'; the target field is remembered at the same moment.
          if (effect.type === 'arm' || (effect.type === 'begin' && effect.locked)) {
            // In the intro the dictation always goes into the practice field, wherever the person just was.
            const practising = notch.intro >= 1 && notch.intro <= 3 && practice.win && !practice.win.isDestroyed();
            if (practising) practice.focus();
            const targetId = practising ? `practice-${Date.now()}` : null;
            const capture = practising ? new Promise(resolve => setTimeout(() => resolve(keys.captureTarget()), 160)) : keys.captureTarget();
            effect = {...effect, targetId: targetId ?? keys.targetId};
            targetCaptures.set(targetId ?? keys.targetId, capture);
            while (targetCaptures.size > 32) targetCaptures.delete(targetCaptures.keys().next().value);
            parakeet.warm();
            settleFixes?.();
          }
          // Without the microphone a dictation cannot start: the row shows that step instead of nothing happening.
          if (effect.type === 'begin' && notch.missing() === 'microphone') { keys.cancel(); notch.setMode('setup'); return; }
          if (effect.type === 'begin') notch.setMode('dictate');
          notch.send('studymut:gesture', effect);
        },
        onEscape: () => {
          // Esc on a hands-free dictation is its ✕: thrown away, and ⌃⌘V still has it for half a minute.
          if (notch.mode === 'dictate' && keys.chord.state.name === 'locked') { notch.send('studymut:hands-free', {discard: true}); return; }
          if (notch.mode === 'dictate') { dictationGeneration++; parakeet.cancel(); keys.cancel(); notch.send('studymut:gesture', {type: 'cancel'}); notch.setMode('rest'); }
          else if (['row', 'open'].includes(notch.mode)) notch.setMode('rest');
        },
        onPermissions: permissions => { notch.permissions = permissions; permissionFlow?.setKeys(permissions); },
      });
      notch.keys = keys;
      // The key left of 1 now opens the emojis (fn belongs to dictation). Pressing it is the intro's fourth step; the
      // emoji picker opens over the practice field, so a chosen emoji lands there.
      keys.onEmojiKey = () => { if (notch.intro === 4) { practice.focus(); setTimeout(() => introNext(4), 1200); } };
      // With another app in front the strich is out of sight; it still hears the pointer at the top edge and shows
      // itself when it is needed. On the bare desktop it stays.
      const ownApp = front => !!front && (/whispertext/i.test(front.bundle ?? '') || front.bundle === 'com.github.Electron' || /^(whispertext|Electron)$/i.test(front.name ?? ''));
      keys.onFront = front => notch.setHushed(Boolean(front.bundle) && !ownApp(front) && front.bundle !== 'com.apple.finder' && front.windows !== false);
      // fn only, and fn belongs to dictation: the emoji picker moves to the key left of 1.
      // whispertext is a normal app with a Dock icon now: windows above another app's full screen must be panels.
      // Only for people who had the emojis on fn: they move to the key left of 1 (^ then comes with ⌘). Everyone else keeps ^.
      const checkKeys = () => { keys.holdKey = 'fn'; keys.ownFn(true); notch.fnConflict = fnConflict(); keys.emojiKey(notch.fnConflict === 'Emoji anzeigen'); };
      checkKeys();
      setInterval(checkKeys, 60_000).unref();
      const dragHelper = new DragHelper({origin, preload: join(root, 'main', 'preload.cjs'), root});
      permissionFlow = new PermissionFlow({
        readMicrophone: () => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('microphone') : 'granted',
        requestMicrophone: () => systemPreferences.askForMediaAccess('microphone'), keys,
        openExternal: url => shell.openExternal(url),
        onChange: value => { notch.permissionState = value; if (value.accessibility) dragHelper.hide(); reviveKeys(value); notch.publish(); checkSetup(); },
      });
      // Accessibility granted while the key helper runs only takes effect in a fresh process: restart it, at most twice.
      let revives = 0, reviving = false;
      function reviveKeys(value) {
        if (process.platform !== 'darwin' || NO_KEYS || reviving || revives >= 2) return;
        if (value.accessibility !== true || value.listening !== false || value.helperStatus !== 'responsive') return;
        reviving = true; revives++;
        keys.stop();
        setTimeout(() => { keys.start().catch(() => {}).finally(() => setTimeout(() => { reviving = false; void permissionFlow.refresh(); }, 1500)); }, 300);
      }
      setInterval(() => { if (!permissionFlow.timer) void permissionFlow.refresh(); }, 60_000).unref();
      if (!NO_KEYS) await keys.start();
      // ⌃⌘V pastes the last dictation again, wherever the cursor is now.
      const pasteAgain = async () => {
        if (!lastDictationText || Date.now() > (lastDictationUntil ?? lastDictationAt + LAST_DICTATION_MS)) { lastDictationText = ''; notch.send('studymut:notice', {kind: 'nothing-to-paste'}); return; }
        // In the intro it goes into the practice field, wherever the person just was.
        if (notch.intro === 3 && practice.win && !practice.win.isDestroyed()) { practice.focus(); await new Promise(resolve => setTimeout(resolve, 160)); }
        const target = await keys.captureTarget();
        await keys.modifiersReleased();
        const {ok, reason} = await insertText(keys, formatAtCursor(lastDictationText.trim(), target ?? {}, dictationContext(target ?? {}, dictation.data.styles).style), target?.targetId);
        if (ok) recovery = '';
        notch.send('studymut:notice', ok ? {kind: 'pasted-again'} : {kind: 'not-inserted', reason});
        if (ok) introNext(3);
      };
      if (!NO_KEYS) globalShortcut.register('Control+Command+V', pasteAgain);
      // The speech model loads in the background at launch, so the first dictation is fast. Only where it is not
      // inside the app (a development copy) is it downloaded once.
      if (process.platform === 'darwin' && process.arch === 'arm64') {
        parakeet.request('load').catch(() => parakeet.request('setup')).then(() => notch.publish(), () => notch.publish());
      }
      notch.onReady = () => { permissionFlow.refresh().then(checkSetup); };
      notch.win.on('focus', () => permissionFlow.refresh());

      const handle = (channel, fn) => ipcMain.handle('studymut:' + channel, (event, ...args) => {
        if (!fromUi(event)) throw new Error('Nicht erlaubt.');
        return fn(...args);
      });
      handle('state', () => notch.state());
      handle('paste-again', () => { void pasteAgain(); });
      handle('hands-free-done', () => keys.finishHandsFree());
      // The ✕ of the hands-free pill: what was said is dropped, as with Escape.
      handle('hands-free-cancel', () => {
        const capturing = keys.chord.capturing;
        keys.cancel();
        if (!capturing) { notch.send('studymut:gesture', {type: 'cancel'}); if (notch.mode === 'dictate') notch.setMode('rest'); }
      });
      // Where the hands-free pill is; a click on it must not take the focus from the text field. Enter is its ✓.
      handle('pill-region', rect => {
        const ok = rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
        notch.pillHitRect = ok ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null;
        if (!HIDDEN_PREVIEW) { if (ok) { if (!globalShortcut.isRegistered('Return')) globalShortcut.register('Return', () => keys.finishHandsFree()); } else globalShortcut.unregister('Return'); }
        notch.syncFocusable();
      });
      // A message that can be clicked (a learned word, to take it back): where it is, while it shows.
      handle('notice-region', rect => {
        const ok = rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
        notch.noticeHitRect = ok ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null;
        if (!ok && notch.mode === 'rest' && !notch.ignoringMouse) { notch.win.setIgnoreMouseEvents(true); notch.ignoringMouse = true; }
        notch.syncFocusable();
      });
      // Where the row is while it shows (hover icons, the open list, a setup step): only there it takes clicks.
      handle('row-region', rect => {
        const ok = rect && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0;
        notch.rowHitRect = ok ? {x: rect.x, y: rect.y, width: rect.width, height: rect.height} : null;
        // Real frosted glass behind the row: the Mac blurs whatever lies behind it, the page only draws on top.
        const bounds = notch.win.getBounds();
        backing.place(ok && notch.mode !== 'rest' ? {x: bounds.x + rect.x, y: bounds.y + rect.y, width: rect.width, height: rect.height} : null, notch.win);
      });
      handle('interaction-state', value => { notch.interactionProtected = value?.draft === true || value?.modal === true; });
      handle('mode', (mode, page) => { if (['rest', 'row', 'open', 'setup'].includes(mode)) notch.setMode(mode, ['history', 'words'].includes(page) ? page : null); });

      // One dictation, from recognised words to inserted text: dictionary, snippets, formatting in the target app's
      // style, inserting, and later learning from a word the person corrected.
      const tidy = (text, context) => polishDictation(text, {snippets: dictation.data.snippets, style: context.style, email: context.email, enabled: true, polish: null});
      const prepareDictation = (raw, target) => {
        const prepared = dictation.prepare(raw);
        // Terms the recogniser nearly got become the term: the person's words, the words at the cursor, the team's list.
        prepared.text = vocabularyFix(prepared.text, [...dictation.words(), ...termsIn(`${target.beforeText ?? ''} ${target.afterText ?? ''}`), ...TEAM_TERMS]);
        return prepared;
      };
      // A pause while dictating: what was said so far is recognised out of sight; when nothing more is said, the
      // release uses it and recognises nothing.
      handle('dictate-ahead', async (samples, early = {}) => {
        if (!(samples instanceof Float32Array) || samples.length > 16000 * 120 || samples.length < 16000 * 2) return false;
        const started = Date.now();
        const promise = parakeet.request('transcribe', samples).then(value => ({...value, recognizeMs: Date.now() - started})).catch(() => null);
        heardAhead = {targetId: early?.targetId ?? null, length: samples.length, promise};
        return !!(await promise)?.text?.trim();
      });
      // Did the person fix a word in what a dictation inserted? Looked at for ten minutes; a fix is learned once it
      // stands in two looks in a row or the message went off with it, and used from the next dictation on.
      const watchingFixes = new Map();
      settleFixes = () => { for (const settle of [...watchingFixes.values()]) settle(); };
      const watchCorrections = (entry, pasteId) => {
        watchingFixes.set(entry.id, () => look(true));
        while (watchingFixes.size > 8) watchingFixes.delete(watchingFixes.keys().next().value);
        let seen = '', last = [], looks = 0;
        const learn = fixes => {
          watchingFixes.delete(entry.id);
          const learned = [];
          for (const {from, to} of fixes) {
            try { if (dictation.learnRule(from, to, entry.id)) learned.push({title: `${from} → ${to}`, id: dictation.data.rules[0]?.id}); } catch {}
          }
          if (learned.length) notch.send('studymut:notice', {kind: 'learned', title: learned.map(item => item.title).join('\n'), id: learned.map(item => item.id).filter(Boolean).join(',') || null});
        };
        const look = async (settle = false) => {
          if (!watchingFixes.has(entry.id) || !dictation.data.learn) return;
          const field = await keys.readInserted(pasteId);
          if (!watchingFixes.has(entry.id)) return;
          const step = correctionStep({inserted: entry.final, field, seen, last});
          if (step.learn) return learn(step.learn);
          if (settle) { if (step.last?.length) learn(step.last); else if (!step.stop) ({seen, last} = step); return; }
          if (step.stop) { watchingFixes.delete(entry.id); return; }
          ({seen, last} = step);
          if (++looks < 180) setTimeout(look, looks < 30 ? 2000 : 4000); else watchingFixes.delete(entry.id);
        };
        setTimeout(look, 2000);
      };

      const finishDictation = async (raw, metrics, generation, target = null, {discard = false} = {}) => {
        const formattingStartedAt = Date.now();
        target ??= {};
        const context = dictationContext(target, dictation.data.styles);
        const prepared = prepareDictation(raw, target);
        const result = await tidy(prepared.text, context);
        const final = formatAtCursor(ownNames(result.text), target, context.style);
        if (generation !== undefined && generation !== dictationGeneration) return {cancelled: true};
        const formattedAt = Date.now();
        const entry = dictation.record(raw, {...metrics, formattingMs: formattedAt - formattingStartedAt, app: target.name ?? '', appId: target.app ?? '', domain: context.domain, targetId: target.targetId, mode: 'dictation', polishStatus: result.polishStatus, appliedRules: prepared.appliedRules, polished: final !== prepared.text}, final);
        recovery = entry.final;
        lastDictationText = entry.final; lastDictationAt = Date.now(); lastDictationUntil = null;
        // Thrown away with ✕: nothing is inserted, but ⌃⌘V still has it for half a minute.
        if (discard) { lastDictationUntil = Date.now() + 30_000; dictation.inserted(entry.id, false); Object.assign(entry, {insertionReason: 'discarded'}); dictation.save(); return {text: entry.final, inserted: false, discarded: true, historyId: entry.id}; }
        const insertion = await insertText(keys, entry.final, target.targetId);
        const {ok, reason, pasteId} = insertion;
        if (ok) recovery = '';
        dictation.inserted(entry.id, ok);
        Object.assign(entry, {insertionVerification: insertion.verification ?? 'unknown', insertionMethod: insertion.method ?? null, insertionReason: reason ?? null, pasteMs: Date.now() - formattedAt, stopToResultMs: metrics.stoppedAt ? Date.now() - metrics.stoppedAt : null});
        dictation.save();
        if (ok && dictation.data.learn) watchCorrections(entry, pasteId);
        if (entry.final.trim()) { const handsFree = introAfterHandsFree; introAfterHandsFree = false; if (notch.intro === 1) introNext(1); else if (handsFree) introNext(2); }
        return {text: entry.final, inserted: ok, reason, historyId: entry.id};
      };
      const captureMetrics = value => Object.fromEntries(['recordingStartedAt', 'stoppedAt', 'audioReadyAt', 'captureStartMs', 'captureConfigMs', 'micAcquireMs', 'graphPrepareMs', 'firstFrameAfterGraphMs'].filter(key => Number.isFinite(value?.[key]) && value[key] >= 0).map(key => [key, value[key]]));
      const recordings = new DictationAudio(app.getPath('userData'));
      // History and words for the row: the newest dictations, the person's words, corrections and snippets.
      handle('dictation-state', async () => ({history: historyRows().slice(0, 50),
        audio: [...await recordings.prune()], words: dictation.data.words, rules: dictation.data.rules.filter(rule => rule.source !== 'suggested'),
        snippets: dictation.data.snippets, modelStatus: parakeet.status, recovery}));
      // ⌘F searches everything, the dictations from Wispr Flow too.
      handle('history-search', query => {
        const needle = String(query ?? '').trim().toLowerCase().slice(0, 200);
        return needle ? historyRows().filter(entry => entry.final?.toLowerCase().includes(needle)).slice(0, 50) : historyRows().slice(0, 50);
      });
      handle('dictation-config', () => ({language: 'auto', deviceId: '', noiseSuppression: true, modelStatus: parakeet.status, engine: 'parakeet'}));
      // Two lines: what is heard and what whispertext writes. Only the second: a word. A long or multi-line text: a
      // snippet said by its first line. Otherwise a correction.
      handle('word-save', (heardRaw, textRaw) => {
        const heard = String(heardRaw ?? '').trim().slice(0, 200), text = String(textRaw ?? '').trim();
        if (!text) return {error: 'empty'};
        const saved = !heard ? dictation.addWord(text.slice(0, 200))
          : text.length > 60 || text.includes('\n') ? dictation.saveSnippet(heard.slice(0, 80), text, null)
          : dictation.addRule(heard, text.slice(0, 200), 'manual', null, null);
        if (notch.intro === 6) setTimeout(() => introNext(6), 900);
        return saved;
      });
      handle('word-remove', (kind, id) => {
        if (kind === 'snippet') return dictation.deleteSnippet(String(id));
        if (kind === 'rule') return dictation.action('delete-rule', {id: String(id)});
        return dictation.action('delete-word', {word: String(id)});
      });
      handle('dictation-action', (action, payload) => {
        if (action === 'delete-history') recordings.remove(String(payload?.id ?? '')).catch(() => {});
        if (action === 'clear-recovery') recovery = '';
        else dictation.action(action, payload);
      });
      handle('dictation-cancel', () => { dictationGeneration++; parakeet.cancel(); keys.cancel(); });
      // The recording stays a day on this Mac, so it can be heard and recognised again from the history.
      const keepAudio = (id, samples) => { if (id) recordings.save(id, samples).catch(() => {}); };
      handle('dictate', async (samples, early = {}) => {
        if (!(samples instanceof Float32Array) || samples.length > 16000 * 120 || samples.length < 4800 || !samples.every(Number.isFinite)) return {error: 'Ungültige Aufnahme.'};
        const cut = Number.isInteger(early?.cut) && early.cut > 0 && early.cut < samples.length ? early.cut : 0;
        const prefix = cut && typeof early?.prefix === 'string' ? early.prefix.slice(0, 20000) : '';
        const generation = ++dictationGeneration;
        const targetPromise = targetCaptures.get(early?.targetId) ?? Promise.resolve(null);
        const before = heardAhead;
        heardAhead = null;
        try {
          const started = Date.now();
          // Nothing said after the last pause: its recognition is the whole text (often already finished).
          const reused = reusesAhead(before, early, cut) ? await before.promise : null;
          const tail = reused?.text?.trim() ? reused
            : samples.length - cut >= 1600 ? await parakeet.request('transcribe', cut ? samples.slice(cut) : samples) : {text: '', processingMs: 0};
          const recognizeMs = Date.now() - started;
          const result = {...tail, text: [prefix, tail.text?.trim() ?? ''].filter(Boolean).join(' ')};
          if (generation !== dictationGeneration) return {cancelled: true};
          if (!result.text?.trim()) { keepAudio(dictation.failed({durationMs: samples.length / 16, app: keys.target?.name ?? ''})?.id, samples); return {error: 'Keine Sprache erkannt. Bitte erneut diktieren.'}; }
          const waitedAt = Date.now();
          const target = await targetPromise;
          const done = await finishDictation(result.text, {durationMs: samples.length / 16, processingMs: result.processingMs, recognizeMs, aheadReused: tail === reused, targetWaitMs: Date.now() - waitedAt, ...captureMetrics(early)}, generation, target, {discard: early?.discard === true});
          keepAudio(done.historyId, samples);
          return done;
        } catch (error) { keepAudio(dictation.failed({durationMs: samples.length / 16, app: keys.target?.name ?? ''})?.id, samples); return {error: error.message}; }
      });
      handle('dictation-audio', async id => { const samples = await recordings.load(String(id)).catch(() => null); return samples ? new Uint8Array(toWav(samples)) : null; });
      handle('dictation-retry', async id => {
        const entry = dictation.data.history.find(item => item.id === id);
        const samples = entry ? await recordings.load(String(id)).catch(() => null) : null;
        if (!samples) return {error: 'Die Aufnahme ist nicht mehr da (nur 24 Stunden).'};
        try {
          const result = await parakeet.request('transcribe', samples);
          if (!result.text?.trim()) return {error: 'Wieder keine Sprache erkannt.'};
          const prepared = dictation.prepare(result.text);
          prepared.text = vocabularyFix(prepared.text, [...dictation.words(), ...TEAM_TERMS]);
          const done = await polishDictation(prepared.text, {snippets: dictation.data.snippets, style: styleFor(entry.appId ?? entry.app, dictation.data.styles, entry.app), email: /(?:mail|outlook|spark)/i.test(entry.appId ?? ''), enabled: true, polish: null});
          dictation.retried(entry.id, result.text, done.text);
          lastDictationText = done.text; lastDictationAt = Date.now();
          return {text: done.text};
        } catch (error) { return {error: error.message}; }
      });
      handle('microphone', async (request = false) => process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted'
        || (request === true && systemPreferences.askForMediaAccess('microphone')));
      // The setup step in the row: the one missing permission, asked for with one click.
      handle('permission-action', async kind => {
        if (!['microphone', 'accessibility'].includes(kind)) throw Error('Unbekannter Freigabeschritt.');
        settings.update({permissionSetup: {active: true, completed: false}});
        // One click: System Settings opens at Accessibility and the app's icon waits beside it to be dragged into the
        // list; macOS then asks for the password once. No second "Allow" dialog from macOS.
        if (kind === 'accessibility') { const state = await permissionFlow.action(kind, true); followSettings(); return state; }
        return permissionFlow.action(kind, false);
      });
      // While the app is dragged into the list: the card stands beside System Settings, everything else is dimmed.
      const followSettings = () => {
        clearInterval(following);
        const started = Date.now();
        const step = async () => {
          if (notch.missing() !== 'accessibility' || Date.now() - started > 180_000) { clearInterval(following); following = null; dragHelper.hide(); syncPractice(); return; }
          const box = await keys.windowOf('com.apple.systempreferences').catch(() => null);
          if (!box) return;
          dragHelper.beside(box);
          dim.show(box);
        };
        following = setInterval(step, 400);
        step();
      };
      handle('permission-drag', () => followSettings());
      handle('permission-open', () => { settings.update({permissionSetup: {active: true, completed: false}}); permissionFlow.watch(true, true); notch.setMode('setup'); });
      ipcMain.on('studymut:drag-app', event => { if (event.senderFrame?.url.startsWith(origin + '/')) dragHelper.startDrag(event.sender); });
      handle('intro-skip', () => { notch.intro = INTRO_STEPS; introNext(INTRO_STEPS); });
      // The emoji key, the history and the words in the intro: "Weiter" goes on.
      handle('intro-next', () => { if (notch.intro >= 4) introNext(notch.intro); });
      // Diagnosis: remember the field in front as a dictation target, as the key does when it goes down.
      handle('target-now', async () => { const capture = keys.captureTarget(); const targetId = keys.targetId; targetCaptures.set(targetId, capture); await capture; return targetId; });

      // The app menu: the same few things, and Edit so ⌘C, ⌘V and ⌘A work in the fields. ⌘Q quits.
      const again = () => { settings.update({introDone: false, permissionSetup: {active: true, completed: false}}); permissionFlow.refresh().then(() => { notch.intro = 0; checkSetup(); }); };
      Menu.setApplicationMenu(Menu.buildFromTemplate([
        {label: NAME, submenu: [
          {label: 'Verlauf', click: () => openRow('history')},
          {label: 'Wörter', click: () => openRow('words')},
          {label: 'Einführung wiederholen', click: again},
          {type: 'separator'}, {role: 'hide', label: 'whispertext ausblenden'}, {type: 'separator'},
          {role: 'quit', label: 'whispertext beenden'},
        ]},
        {label: 'Bearbeiten', submenu: [{role: 'undo', label: 'Widerrufen'}, {role: 'redo', label: 'Wiederholen'}, {type: 'separator'},
          {role: 'cut', label: 'Ausschneiden'}, {role: 'copy', label: 'Kopieren'}, {role: 'paste', label: 'Einsetzen'}, {role: 'selectAll', label: 'Alles auswählen'}]},
      ]));
      app.dock?.setMenu(Menu.buildFromTemplate([{label: 'Verlauf', click: () => openRow('history')}, {label: 'Wörter', click: () => openRow('words')}]));
      // During the setup and the intro a click on the Dock icon brings that step back instead.
      const openRow = page => { if (notch.intro || notch.missing()) { checkSetup(); if (notch.mode === 'rest') notch.setMode('setup'); return; } notch.setMode('open', page); };
      // The intro's words step says what came over from Wispr Flow; on an app whose intro was already done it is a notice.
      notch.imported = settings.get().wisprCount;
      if (importNotice && settings.get().introDone) { setTimeout(() => { notch.send('studymut:notice', {kind: 'imported', title: importText(importNotice)}); importNotice = null; }, 2500); }
      // Opening the app again (Finder, Spotlight) opens the history.
      app.on('activate', () => openRow('history'));
      app.on('second-instance', () => openRow('history'));

      // Quitting never asks: a dictation lasts seconds, and a hidden question once kept an update from closing the app.
      app.on('before-quit', () => {
        permissionFlow.close(); practice.hide(); dim.hide(); backing.destroy(); dragHelper.destroy(); parakeet.stop(); globalShortcut.unregisterAll(); keys.stop(); clearInterval(notch.poll); server.close();
      });
      refreshPath(pathFile).catch(() => {});
    } catch (error) {
      dialog.showErrorBox('whispertext konnte nicht starten', error.message);
      app.quit();
    }
  });
  app.on('window-all-closed', () => app.quit());
}
