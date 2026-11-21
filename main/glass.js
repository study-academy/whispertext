// Frosted glass under the row (taken from Studymut, where it was one recipe for every small surface (asked for on 14 and 15 November 2026:
// "überall mehr Transparenz, also frosted Glass"). A surface is a window of its own, exactly as large as
// what it shows, with the Mac's blur of whatever lies behind it. The Mac's materials are all rather milky,
// so the window itself is a little see-through as well: that is what lets the place behind show.
import {BrowserWindow} from 'electron';

// Compared on 14 November 2026 over a full calendar: 'hud' lets the colours behind through best; below 0.9 the
// text behind shows sharply and disturbs what is written on the glass.
export const GLASS = {material: 'hud', opacity: 0.95};
const MATERIALS = ['popover', 'menu', 'sidebar', 'under-window', 'fullscreen-ui', 'hud', 'content', 'under-page', 'window', 'sheet', 'tooltip', 'header', 'titlebar', 'selection'];

// Options every glass window shares.
export const glassOptions = () => ({transparent: false, vibrancy: GLASS.material, visualEffectState: 'active', roundedCorners: true, hasShadow: true, backgroundColor: '#00000000'});

const windows = new Set();
// Called once per glass window: it gets the recipe now and whenever it is changed for a comparison.
export function asGlass(win) {
  windows.add(win);
  win.on('closed', () => windows.delete(win));
  if (process.platform === 'darwin') win.setOpacity(GLASS.opacity);
  return win;
}
// A glass surface comes softly (ui/motion.css, docs/bewegung.md): a window can only be there or not, so its
// opacity rises over a moment instead. `show` puts the window on the screen (inactive by default).
const fading = new WeakMap();
export function fadeIn(win, show = () => win.showInactive(), ms = 180) {
  if (!win || win.isDestroyed()) return;
  if (process.platform !== 'darwin') { show(); return; }
  clearInterval(fading.get(win));
  win.setOpacity(0);
  show();
  const started = Date.now();
  const timer = setInterval(() => {
    if (win.isDestroyed()) { clearInterval(timer); return; }
    const t = Math.min(1, (Date.now() - started) / ms);
    win.setOpacity(GLASS.opacity * (1 - Math.pow(1 - t, 3)));
    if (t >= 1) clearInterval(timer);
  }, 16);
  fading.set(win, timer);
}
// Diagnosis: another material or strength on every glass surface at once.
export function tryGlass(material, opacity) {
  if (MATERIALS.includes(material)) GLASS.material = material;
  if (Number.isFinite(opacity) && opacity >= 0.5 && opacity <= 1) GLASS.opacity = opacity;
  for (const win of windows) { if (win.isDestroyed()) continue; win.setVibrancy(GLASS.material); win.setOpacity(GLASS.opacity); }
  return {...GLASS};
}

// The glass under a surface that lives inside another window (the grey pill under the notch): a window with
// nothing in it but the glass, kept exactly behind that surface. The page above only tints it.
export class GlassBacking {
  // material: the Mac's own glass; 'menu' is the light frosted glass of macOS menus.
  constructor({hidden = false, material = null} = {}) { this.hidden = hidden; this.material = material; this.win = null; this.shown = false; }

  #window() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = asGlass(new BrowserWindow({...glassOptions(), ...(this.material ? {vibrancy: this.material} : {}), width: 290, height: 32, type: process.platform === 'darwin' ? 'panel' : undefined, frame: false, resizable: false, movable: false, focusable: false,
      minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, show: false, alwaysOnTop: true,
      type: process.platform === 'darwin' ? 'panel' : undefined, webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true}}));
    this.win.setAlwaysOnTop(true, 'status');
    this.win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
    this.win.setIgnoreMouseEvents(true);
    return this.win;
  }

  // bounds: where the surface is on the screen, or null when there is none. above: the window that draws on it.
  place(bounds, above) {
    if (process.platform !== 'darwin' || this.hidden) return;
    if (!bounds) { if (this.shown && this.win && !this.win.isDestroyed()) this.win.hide(); this.shown = false; return; }
    const win = this.#window();
    win.setBounds({x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.max(20, Math.round(bounds.width)), height: Math.max(10, Math.round(bounds.height))}, false);
    if (!this.shown) { fadeIn(win, () => { win.showInactive(); if (above && !above.isDestroyed()) above.moveTop(); }, 240); this.shown = true; }
  }

  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); }
}
