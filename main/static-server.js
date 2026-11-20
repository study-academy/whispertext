// Serves the notch UI from 127.0.0.1 only: the files in ui/ and the speech model under /models/.
// The model is fetched once from Hugging Face and kept on disk (the browser cache does not keep it),
// so later launches and offline use load it locally.
import http from 'node:http';
import {createReadStream, createWriteStream} from 'node:fs';
import {readFile, readdir, mkdir, rename, rm, stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {join, relative, sep, dirname} from 'node:path';

const TYPES = {html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8', wasm: 'application/wasm', png: 'image/png', svg: 'image/svg+xml'};
// WebAssembly needs 'wasm-unsafe-eval', and the ONNX runtime imports its own loader from a same-origin
// blob: copy inside the worker.
const CSP = `default-src 'self'; connect-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; `
  + `worker-src 'self' blob:; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; `
  + `frame-ancestors 'none'; form-action 'none'`;
export const PREFERRED_PORT = 4327;
// Only this model and these file kinds may be fetched through the app.
const MODEL_PATH = /^\/models\/(onnx-community\/whisper-small)\/resolve\/main\/((?:onnx\/)?[\w.-]+\.(?:json|onnx|onnx_data|txt))$/;
const MODEL_TYPES = {json: 'application/json', txt: 'text/plain', onnx: 'application/octet-stream', onnx_data: 'application/octet-stream'};

// Serves one model file from disk. A missing file is downloaded once and streamed to the page at the
// same time, so the page sees real progress; it lands on disk only when complete.
const downloads = new Map();
async function serveModel(res, modelDir, repo, file) {
  const target = join(modelDir, ...repo.split('/'), ...file.split('/'));
  const type = MODEL_TYPES[file.split('.').pop()];
  const fromDisk = async () => {
    const size = (await stat(target)).size;
    res.writeHead(200, {'Content-Type': type, 'Content-Length': size, 'Cache-Control': 'no-store'});
    createReadStream(target).pipe(res);
  };
  try {
    if (await stat(target).catch(() => null)) return await fromDisk();
    if (downloads.has(target)) { await downloads.get(target); return await fromDisk(); }
    const response = await fetch(`https://huggingface.co/${repo}/resolve/main/${file}`, {signal: AbortSignal.timeout(30 * 60_000)});
    if (!response.ok || !response.body) { res.writeHead(response.status === 404 ? 404 : 502); return res.end(); }
    await mkdir(dirname(target), {recursive: true});
    const partial = target + '.part';
    const length = response.headers.get('content-length');
    res.writeHead(200, {'Content-Type': type, 'Cache-Control': 'no-store', ...(length ? {'Content-Length': length} : {})});
    const body = Readable.fromWeb(response.body);
    const disk = createWriteStream(partial);
    body.pipe(res);
    const done = pipeline(body, disk).then(() => rename(partial, target));
    downloads.set(target, done.finally(() => downloads.delete(target)));
    await done.catch(async () => { await rm(partial, {force: true}).catch(() => {}); res.destroy(); });
  } catch {
    if (!res.headersSent) { res.writeHead(502); res.end(); } else res.destroy();
  }
}

async function listFiles(dir) {
  const entries = await readdir(dir, {withFileTypes: true, recursive: true});
  return entries.filter(entry => entry.isFile() && TYPES[entry.name.split('.').pop()])
    .map(entry => '/' + relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'));
}

export async function startStaticServer(dir, modelDir) {
  const files = new Set(await listFiles(dir));
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    let path;
    try { path = decodeURIComponent(new URL(req.url, `http://${host}`).pathname); }
    catch { res.writeHead(400); return res.end(); }
    const model = req.method === 'GET' && req.headers.host === host && modelDir ? path.match(MODEL_PATH) : null;
    if (model) return serveModel(res, modelDir, model[1], model[2]);
    const name = path === '/' ? '/index.html' : path;
    if (req.headers.host !== host || req.method !== 'GET' || !files.has(name)) { res.writeHead(404); return res.end(); }
    try {
      const data = await readFile(join(dir, ...name.split('/')));
      res.writeHead(200, {'Content-Type': TYPES[name.split('.').pop()], 'Cache-Control': 'no-cache'});
      res.end(data);
    } catch { res.writeHead(500); res.end(); }
  });
  for (const port of [PREFERRED_PORT, 0]) {
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return {server, origin: `http://127.0.0.1:${server.address().port}`};
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('Kein freier lokaler Port.');
}
