import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, chmod, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Keys} from '../main/keys.js';

async function fakeKeys(t, behavior) {
  const dir = await mkdtemp(join(tmpdir(), 'studymut-session-test-'));
  const path = join(dir, 'helper.mjs');
  await writeFile(path, `#!${process.execPath}\nimport readline from 'node:readline';\nconst emit=x=>console.log(JSON.stringify(x));\nemit({type:'permissions',id:0});\nreadline.createInterface({input:process.stdin}).on('line',line=>{if(line==='quit')process.exit(0);const p=line.split(' ');${behavior}});\n`);
  await chmod(path, 0o700);
  let ready;
  const initialized = new Promise(resolve => { ready = resolve; });
  const keys = new Keys({helperPath:path, onGesture(){}, onEscape(){}, onPermissions(){ready();}});
  await keys.start();
  const timeout = setTimeout(()=>ready(new Error('Fake helper startup timed out')),15000);
  const startup = await initialized; clearTimeout(timeout);
  if (startup instanceof Error) { keys.stop(); throw startup; }
  t.after(async()=>{keys.stop(); await rm(dir,{recursive:true,force:true});});
  return keys;
}
const mac = {skip:process.platform!=='darwin'};

test('out-of-order captures retain their own app and stale reply cannot replace newest target', mac, async t => {
  const keys = await fakeKeys(t, `if(p[0]==='capture-target'){const targetId=Number(p[1]);setTimeout(()=>emit({type:'target',targetId,app:'app-'+targetId,name:'Target '+targetId,domain:'mail.google.com',beforeText:'Hallo ',afterText:'!'}),targetId===1?70:5);}`);
  const [a,b] = await Promise.all([keys.captureTarget(),keys.captureTarget()]);
  assert.equal(a.app,'app-1'); assert.equal(b.app,'app-2');
  assert.equal(keys.target.targetId,b.targetId); assert.ok(Object.isFrozen(a));
  assert.equal(a.domain,'mail.google.com');assert.equal(a.beforeText,'Hallo ');assert.equal(a.afterText,'!');
});

test('overlapping paste is explicitly refused and the first promise still completes', mac, async t => {
  const keys = await fakeKeys(t, `if(p[0]==='paste-session')setTimeout(()=>emit({type:'paste',id:Number(p[1]),ok:true,verification:'field-confirmed'}),70);`);
  const first = keys.paste('first',{targetId:101});
  assert.deepEqual(await keys.paste('second',{targetId:102}),{ok:false,reason:'paste-busy'});
  const result = await first;
  assert.equal(result.ok,true);assert.equal(result.targetId,101);assert.equal(result.verification,'field-confirmed');
  assert.equal(keys.pasteWaiters.size,0);
});

test('learning reads are correlated by request and paste rather than the last global field', mac, async t => {
  const keys = await fakeKeys(t, `if(p[0]==='read-inserted')setTimeout(()=>emit({type:'field',id:Number(p[1]),pasteId:Number(p[2]),value:'corrected-'+p[2]}),p[2]==='11'?60:5);`);
  const [a,b] = await Promise.all([keys.readInserted(11),keys.readInserted(12)]);
  assert.equal(a,'corrected-11');assert.equal(b,'corrected-12');
});

test('cancellation settles a pending paste and ignores its late result', mac, async t => {
  const keys = await fakeKeys(t, `if(p[0]==='paste-session')setTimeout(()=>emit({type:'paste',id:Number(p[1]),ok:true}),50);`);
  const pending = keys.paste('cancelled',{targetId:101});
  keys.cancel();
  const result = await pending;assert.equal(result.ok,null);assert.equal(result.reason,'cancelled');
  await new Promise(resolve=>setTimeout(resolve,90));
  assert.equal(keys.lastPasteId,null);assert.equal(keys.pasteWaiters.size,0);
});

test('helper death settles outstanding paste as unknown and does not invent success', mac, async t => {
  const keys = await fakeKeys(t, `if(p[0]==='paste-session')process.exit(0);`);
  const result = await keys.paste('never confirmed',{targetId:101});
  assert.equal(result.ok,null);assert.equal(result.reason,'helper');
});

test('timed out capture cannot silently choose a newer field', mac, async t => {
  const keys = await fakeKeys(t, `if(p[0]==='capture-target'&&p[1]==='2')emit({type:'target',targetId:2,app:'new-app'});`);
  const missing = keys.captureTarget();
  const next = await keys.captureTarget();
  assert.equal(await missing,null);assert.equal(keys.target.targetId,next.targetId);
  assert.deepEqual(await keys.paste('unsafe',{targetId:null}),{ok:false,reason:'no-target'});
});
