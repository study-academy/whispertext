// "Drag whispertext into the list": beside System Settings › Accessibility, a small window shows the
// app's icon, and dragging it drops the real app bundle into the list (as HeyClicky does). It closes
// by itself once macOS reports the permission.
import {BrowserWindow, app, nativeImage, screen} from 'electron';
import {dirname, join} from 'node:path';

const WIDTH = 300, HEIGHT = 112;

// The .app bundle that is running (packaged), else the Electron app used in development.
export const appBundle = () => dirname(dirname(dirname(app.getPath('exe'))));

export class DragHelper {
  constructor({origin, preload, root}) { Object.assign(this, {origin, preload, root}); this.win = null; }

  show() {
    if (process.platform !== 'darwin') return;
    if (!this.win || this.win.isDestroyed()) {
      // The same frosted glass as the row under the notch.
      this.win = new BrowserWindow({width: WIDTH, height: HEIGHT, type: process.platform === 'darwin' ? 'panel' : undefined, frame: false, transparent: false, vibrancy: 'menu', visualEffectState: 'active', roundedCorners: true,
        resizable: false, movable: true, focusable: true, skipTaskbar: true, alwaysOnTop: true, hasShadow: true, show: false, backgroundColor: '#00000000',
        webPreferences: {contextIsolation: true, nodeIntegration: false, sandbox: true, preload: this.preload}});
      this.win.setAlwaysOnTop(true, 'floating', 1);
      // System Settings may open on another desktop or beside a full-screen app: the card goes along.
      this.win.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true, skipTransformProcessType: true});
      this.win.webContents.on('will-navigate', event => event.preventDefault());
      this.win.loadURL(this.origin + '/drag.html');
    }
    // Bottom right of the screen with the pointer, clear of the System Settings window in the middle.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.win.setPosition(area.x + area.width - WIDTH - 24, area.y + area.height - HEIGHT - 24);
    this.win.showInactive();
  }

  // Called from the page when the icon is dragged: the system drags the app bundle itself.
  startDrag(contents) {
    const icon = nativeImage.createFromPath(join(this.root, 'build', 'icon.png')).resize({width: 64, height: 64});
    contents.startDrag({file: appBundle(), icon: icon.isEmpty() ? nativeImage.createFromPath(join(this.root, 'ui', 'assets', 'app-icon.png')).resize({width: 64, height: 64}) : icon});
  }

  // Right beside the System Settings window, at the height of its list; the arrow on the card points to it.
  beside(box) {
    if (process.platform !== 'darwin') return;
    if (!this.win || this.win.isDestroyed()) this.show();
    const area = screen.getDisplayNearestPoint({x: box.x + box.width / 2, y: box.y + box.height / 2}).workArea;
    const x = Math.min(area.x + area.width - WIDTH - 12, Math.round(box.x + box.width + 16));
    const y = Math.max(area.y + 12, Math.min(area.y + area.height - HEIGHT - 12, Math.round(box.y + box.height * 0.42 - HEIGHT / 2)));
    const [cx, cy] = this.win.getPosition();
    if (cx !== x || cy !== y) this.win.setPosition(x, y);
    if (!this.win.isVisible()) this.win.showInactive();
  }

  hide() { if (this.win && !this.win.isDestroyed()) this.win.hide(); }
  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); }
}
