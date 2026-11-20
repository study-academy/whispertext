import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startStaticServer} from '../main/static-server.js';

test('UI assets with spaces and Unicode load through encoded URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'notch-assets-'));
  await writeFile(join(dir, 'icon ä.png'), 'image');
  const {server, origin} = await startStaticServer(dir);
  try {
    const response = await fetch(origin + '/icon%20%C3%A4.png');
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'image');
    assert.equal((await fetch(origin + '/missing.js')).status, 404);
    assert.equal((await fetch(origin + '/bad%ZZ.js')).status, 400);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, {recursive: true}); }
});
