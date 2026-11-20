// Drive a running Electron app (or Chromium page) over the Chrome DevTools Protocol.
// Start the app with --remote-debugging-port=<port>, then:
//   node cdp.mjs <port> eval '<js expression>'            evaluate in the page (promises awaited)
//   node cdp.mjs <port> key <key> <code> <mods> [command] real key event; mods: 4 Meta, 2 Ctrl, 8 Shift, 1 Alt
//   node cdp.mjs <port> file '<css selector>' <path...>   feed files to an <input type=file>
//   node cdp.mjs <port> shot <out.png>                     screenshot of the page
const [port, action, ...args] = process.argv.slice(2);
let targets;
try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); }
catch { console.error(`No app listens for debugging on port ${port}. Start it with --remote-debugging-port=${port} (e.g. open -a "/Applications/<App>.app" --args --remote-debugging-port=${port}).`); process.exit(1); }
const page = targets.find(t => t.type === 'page' && /^https?:\/\/127\.0\.0\.1/.test(t.url) && new URL(t.url).pathname === '/') || targets.find(t => t.type === 'page' && /^https?:\/\/127\.0\.0\.1/.test(t.url)) || targets.find(t => t.type === 'page');
if (!page) { console.error('no page target', targets.map(t => t.url)); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, {once: true}));
let id = 0; const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); });
const send = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({id, method, params})); });
const KEYCODES = {Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowRight: 39, ',': 188};
let out;
if (action === 'eval') {
  const m = await send('Runtime.evaluate', {expression: args[0], awaitPromise: true, returnByValue: true});
  out = m.result?.result?.value ?? m.result?.exceptionDetails?.exception?.description ?? m;
} else if (action === 'key') {
  const [key, code, mods = '0', command] = args;
  const keyCode = KEYCODES[key] ?? key.toUpperCase().charCodeAt(0);
  await send('Page.bringToFront');
  await send('Input.dispatchKeyEvent', {type: 'rawKeyDown', key, code, modifiers: +mods, windowsVirtualKeyCode: keyCode, commands: command ? [command] : []});
  await send('Input.dispatchKeyEvent', {type: 'keyUp', key, code, modifiers: +mods, windowsVirtualKeyCode: keyCode});
  out = 'sent';
} else if (action === 'file') {
  const [selector, ...files] = args;
  const {root} = (await send('DOM.getDocument')).result;
  const {nodeId} = (await send('DOM.querySelector', {nodeId: root.nodeId, selector})).result;
  await send('DOM.setFileInputFiles', {nodeId, files});
  out = `set ${files.length} file(s)`;
} else if (action === 'shot') {
  const {writeFile} = await import('node:fs/promises');
  const m = await send('Page.captureScreenshot', {format: 'png'});
  await writeFile(args[0], Buffer.from(m.result.data, 'base64'));
  out = `saved ${args[0]}`;
} else {
  out = 'usage: eval | key | file | shot';
}
console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
ws.close();
