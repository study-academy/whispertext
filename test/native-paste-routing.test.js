import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, writeFile, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The actual Swift routing policy is compiled: no AX access, keystrokes or clipboard changes.
test('Codex and web editors use clipboard before any AX write; known native fields retain direct insertion', {skip:process.platform!=='darwin'}, async t => {
  const source = await readFile(new URL('../native/mac/StudymutKeys.swift',import.meta.url),'utf8');
  const start = source.indexOf('func usesNativeTextInsertion(');
  assert.ok(start >= 0,'native route policy must exist before insertion');
  const end = source.indexOf('\nenum DirectInsertion',start);
  assert.ok(end > start,'native route policy must be independently compilable');
  const dir = await mkdtemp(join(tmpdir(),'studymut-native-routing-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const swift = join(dir,'routing.swift');
  await writeFile(swift,source.slice(start,end)+`\n
precondition(!usesNativeTextInsertion(bundleID: "com.openai.codex"))
precondition(!usesNativeTextInsertion(bundleID: "com.openai.chat"))
precondition(!usesNativeTextInsertion(bundleID: "com.google.Chrome"))
precondition(!usesNativeTextInsertion(bundleID: "company.thebrowser.Browser"))
precondition(!usesNativeTextInsertion(bundleID: "notion.id"))
precondition(!usesNativeTextInsertion(bundleID: "com.tinyspeck.slackmacgap"))
precondition(!usesNativeTextInsertion(bundleID: "com.microsoft.VSCode"))
precondition(!usesNativeTextInsertion(bundleID: nil))
precondition(!usesNativeTextInsertion(bundleID: "unknown.editor"))
precondition(usesNativeTextInsertion(bundleID: "com.apple.TextEdit"))
precondition(usesNativeTextInsertion(bundleID: "com.apple.mail"))
precondition(usesNativeTextInsertion(bundleID: "com.apple.Notes"))
`);
  const binary = join(dir,'routing');
  const compiled = spawnSync('xcrun',['swiftc','-swift-version','5',swift,'-o',binary],{encoding:'utf8',timeout:120000});
  assert.equal(compiled.status,0,compiled.stderr||compiled.error?.message);
  const executed = spawnSync(binary,[],{encoding:'utf8',timeout:10000});
  assert.equal(executed.status,0,executed.stderr||executed.error?.message);
  // Ensure the production paste call site gates the actual mutating path, not only an unused policy.
  assert.match(source,/if let current, usesNativeTextInsertion\(bundleID: NSWorkspace\.shared\.frontmostApplication\?\.bundleIdentifier\)\s*\{\s*switch insertDirectly\(text, into: current\)/);
});
