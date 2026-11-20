import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keys} from '../main/keys.js';

async function fakeKeys(t, behavior) {
  const dir = await mkdtemp(join(tmpdir(), 'studymut-permission-test-'));
  const path = join(dir, 'helper.mjs');
  await writeFile(path, `#!${process.execPath}\nimport readline from 'node:readline';\nconsole.log(JSON.stringify({type:'permissions',id:0,input:false,accessibility:false,listening:false}));\nreadline.createInterface({input:process.stdin}).on('line', line => {\n if(line==='quit')process.exit(0);\n if(line.startsWith('permissions ')){const id=Number(line.split(' ')[1]);${behavior}}\n});\n`);
  await chmod(path, 0o700);
  const events = [];
  let ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const keys = new Keys({helperPath:path, onGesture(){}, onEscape(){}, onPermissions:e=>{ if(e.id===0)ready();else events.push(e); }});
  await keys.start();
  const startDeadline = setTimeout(() => ready(new Error('Fake helper startup timed out')), 8000);
  const startup = await initialized;
  clearTimeout(startDeadline);
  if (startup instanceof Error) { keys.stop(); throw startup; }
  t.after(async () => { keys.stop(); await rm(dir, {recursive:true,force:true}); });
  return {keys,events};
}

test('permission replies are correlated and retain read-only grant values', {skip:process.platform!=='darwin'}, async t => {
  const {keys,events} = await fakeKeys(t, `console.log(JSON.stringify({type:'permissions',id,input:false,accessibility:true,listening:false}));`);
  const [a,b] = await Promise.all([keys.refreshPermissions(),keys.refreshPermissions()]);
  assert.notEqual(a.id,b.id);
  assert.equal(a.input,false);
  assert.equal(a.accessibility,true);
  assert.ok(a.checkedAt>0);
  assert.equal(events.length,2);
});
test('silent helper times out without inventing a denial', {skip:process.platform!=='darwin'}, async t => {
  const {keys,events} = await fakeKeys(t, '');
  await assert.rejects(keys.refreshPermissions({timeoutMs:60}), {code:'PERMISSION_TIMEOUT'});
  assert.equal(events.length,0);
  assert.equal(keys.permissionWaiters.size,0);
});
test('stopping rejects pending checks and absent helper is explicit', {skip:process.platform!=='darwin'}, async t => {
  const {keys} = await fakeKeys(t, '');
  const pending = keys.refreshPermissions();
  const rejected = assert.rejects(pending,{code:'HELPER_UNAVAILABLE'});
  keys.stop();
  await rejected;
  await assert.rejects(keys.refreshPermissions(),{code:'HELPER_UNAVAILABLE'});
});
test('haptic debounce emits at most one command per activation burst without hardware access', () => {
  const writes=[];
  const keys=new Keys({onGesture(){},onEscape(){},onPermissions(){}});
  keys.helper={stdin:{write:s=>writes.push(s)}};
  assert.equal(keys.haptic(),process.platform==='darwin');
  assert.equal(keys.haptic(),false);
  assert.deepEqual(writes,process.platform==='darwin'?['haptic\n']:[]);
});
