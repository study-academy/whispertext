import test from 'node:test';
import assert from 'node:assert/strict';
import {KeyChord, HOLD_DELAY} from '../core/keychord.js';

const F = (hold = false, control = false, other = false, option = false) => ({hold, control, other, option});
const CO = () => F(false, true, false, true);

test('holding fn dictates and release finishes', () => {
  const k = new KeyChord();
  assert.deepEqual(k.flagsChanged(F(true), 0), {type: 'arm', mode: 'dictate', deadline: HOLD_DELAY});
  assert.deepEqual(k.tick(0.1), {type: 'none'});
  assert.deepEqual(k.tick(0.25), {type: 'begin', mode: 'dictate'});
  assert.deepEqual(k.flagsChanged(F(), 1), {type: 'finish', mode: 'dictate'});
});

test('Control and Option held talk to Studymut, in either order; fn plus Control is no longer talk', () => {
  let k = new KeyChord();
  k.flagsChanged(F(false, true), 0);
  assert.deepEqual(k.flagsChanged(CO(), 0.05), {type: 'arm', mode: 'talk', deadline: 0.05 + HOLD_DELAY});
  assert.deepEqual(k.tick(0.3), {type: 'begin', mode: 'talk'});
  assert.deepEqual(k.flagsChanged(F(false, true), 1), {type: 'finish', mode: 'talk'});
  assert.deepEqual(k.flagsChanged(F(), 1.1), {type: 'none'});

  k = new KeyChord();
  k.flagsChanged(F(true), 0);
  k.tick(0.25);
  assert.deepEqual(k.flagsChanged(F(true, true), 0.6), {type: 'cancel'});
});

test('a short tap of fn alone does nothing', () => {
  const k = new KeyChord();
  k.flagsChanged(F(true), 0);
  assert.deepEqual(k.flagsChanged(F(), 0.1), {type: 'disarm'});
  assert.deepEqual(k.tick(0.25), {type: 'none'});
  assert.deepEqual(k.tick(1), {type: 'none'});
});

test('fn twice dictates hands-free until the next fn tap; typing goes on normally', () => {
  const k = new KeyChord();
  k.flagsChanged(F(true), 0); k.flagsChanged(F(), 0.1);
  assert.equal(k.flagsChanged(F(true), 0.3).type, 'arm');
  assert.deepEqual(k.flagsChanged(F(), 0.38), {type: 'begin', mode: 'dictate', locked: true});
  assert.deepEqual(k.keyDown(), {type: 'none'});
  k.flagsChanged(F(false, false, true), 2); assert.deepEqual(k.flagsChanged(F(), 2.1), {type: 'none'});
  k.flagsChanged(F(true), 5);
  assert.deepEqual(k.flagsChanged(F(), 5.1), {type: 'finish', mode: 'dictate'});
  assert.equal(k.flagsChanged(F(true), 6).type, 'arm');
});

test('Control twice talks hands-free; a tap of Control or fn ends it, shortcuts do not', () => {
  const k = new KeyChord();
  k.flagsChanged(F(false, true), 0); k.flagsChanged(F(), 0.08);
  k.flagsChanged(F(false, true), 0.25);
  assert.deepEqual(k.flagsChanged(F(), 0.33), {type: 'begin', mode: 'talk', locked: true});
  k.flagsChanged(F(false, true), 1); k.keyDown();
  assert.deepEqual(k.flagsChanged(F(), 1.1), {type: 'none'});
  // Control and Option together are not a tap: hands-free goes on.
  k.flagsChanged(F(false, true, false, true), 2); assert.deepEqual(k.flagsChanged(F(), 2.1), {type: 'none'});
  k.flagsChanged(F(false, true), 3);
  assert.deepEqual(k.flagsChanged(F(), 3.1), {type: 'finish', mode: 'talk'});
  // fn ends what Control began.
  k.flagsChanged(F(false, true), 10); k.flagsChanged(F(), 10.08); k.flagsChanged(F(false, true), 10.25); k.flagsChanged(F(), 10.33);
  k.flagsChanged(F(true), 12);
  assert.deepEqual(k.flagsChanged(F(), 12.1), {type: 'finish', mode: 'talk'});
});

test('a hands-free lock never outlives its recording: the keys work again', () => {
  // The recording ran out or the notch went to rest: the caller releases the lock, Control + Option talks again.
  let k = new KeyChord();
  k.lockTalk(0);
  k.release();
  assert.equal(k.flagsChanged(F(false, true, false, true), 1).type, 'arm');
  assert.deepEqual(k.tick(1.25), {type: 'begin', mode: 'talk'});
  // Even without that call a lock is stale after two minutes.
  k = new KeyChord();
  k.flagsChanged(F(true), 0); k.flagsChanged(F(), 0.1); k.flagsChanged(F(true), 0.3); k.flagsChanged(F(), 0.38);
  assert.equal(k.state.name, 'locked');
  assert.equal(k.flagsChanged(F(false, true, false, true), 200).type, 'arm');
  // release() changes nothing outside a lock.
  k = new KeyChord();
  k.flagsChanged(F(true), 0); k.tick(0.25); k.release();
  assert.equal(k.state.name, 'capturing');
});

test('slow taps, a third tap, and shortcuts are not gestures', () => {
  let k = new KeyChord();
  k.flagsChanged(F(false, true), 0); k.flagsChanged(F(), 0.08);
  k.flagsChanged(F(false, true), 2);
  assert.deepEqual(k.flagsChanged(F(), 2.05), {type: 'none'});

  k = new KeyChord();
  k.flagsChanged(F(true), 0);
  assert.deepEqual(k.keyDown(), {type: 'disarm'});
  assert.deepEqual(k.tick(0.25), {type: 'none'});

  k = new KeyChord();
  k.flagsChanged(F(true), 0); k.tick(0.25);
  assert.deepEqual(k.flagsChanged(F(true, false, true), 0.5), {type: 'cancel'});
  assert.deepEqual(k.flagsChanged(F(), 0.6), {type: 'none'});

  k = new KeyChord();
  k.flagsChanged(F(true), 0);
  assert.deepEqual(k.flagsChanged(F(true, false, true), 0.1), {type: 'disarm'});
  assert.deepEqual(k.tick(0.25), {type: 'none'});
});

test('right Option or right Command can dictate instead of fn; left keys keep their roles', async () => {
  const {mapFlags} = await import('../main/keys.js');
  assert.deepEqual(mapFlags({hold: false, control: false, option: true, other: false, device: 0x40}, 'rightOption'), {hold: true, control: false, option: false, other: false});
  assert.deepEqual(mapFlags({hold: false, control: true, option: true, other: false, device: 0x20}, 'rightOption'), {hold: false, control: true, option: true, other: false});
  assert.deepEqual(mapFlags({hold: false, control: false, option: false, other: true, device: 0x10}, 'rightCommand'), {hold: true, control: false, option: false, other: false});
  assert.deepEqual(mapFlags({hold: true, control: false, option: false, other: false, device: 0}, 'fn'), {hold: true, control: false, option: false, other: false});
});

test('with VoiceOver running, talking needs Shift too', () => {
  const k = new KeyChord();
  k.voiceOver = true;
  assert.deepEqual(k.flagsChanged({hold: false, control: true, option: true, other: false}, 0), {type: 'none'});
  assert.equal(k.flagsChanged({hold: false, control: true, option: true, other: true}, 0.1).type, 'arm');
  k.tick(0.4);
  assert.deepEqual(k.flagsChanged({hold: false, control: true, option: false, other: true}, 1), {type: 'finish', mode: 'talk'});
});

test('Studymut hears its own name by sound, and leaves real words alone', async () => {
  const {ownNames} = await import('../core/vocabulary.js');
  assert.equal(ownNames('soll Stunny Mood länger brauchen'), 'soll Studymut länger brauchen');
  assert.equal(ownNames('sondern Studdy Mond hat da'), 'sondern Studymut hat da');
  assert.equal(ownNames('Stunny Moods Zuhause'), 'Studymuts Zuhause');
  for (const plain of ['am Studientag Montag', 'die Stunde Mut', 'Studi Montag', 'Studie Modell', 'Stille Mond']) assert.equal(ownNames(plain), plain);
});

test('whispertext leaves Control and Option to the Mac: no talk, fn still dictates', () => {
  const k = new KeyChord({talk: false});
  assert.deepEqual(k.flagsChanged(CO(), 0), {type: 'none'});
  assert.deepEqual(k.flagsChanged(F(), 0.1), {type: 'none'});
  assert.deepEqual(k.flagsChanged(F(false, true), 1), {type: 'none'});
  assert.deepEqual(k.flagsChanged(F(), 1.05), {type: 'none'});
  assert.deepEqual(k.flagsChanged(F(false, true), 1.2), {type: 'none'});
  assert.deepEqual(k.flagsChanged(F(), 1.25), {type: 'none'});
  assert.deepEqual(k.flagsChanged(F(true), 2), {type: 'arm', mode: 'dictate', deadline: 2 + HOLD_DELAY});
});
