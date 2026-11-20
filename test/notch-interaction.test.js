import test from 'node:test';
import assert from 'node:assert/strict';
import {HoverIntent, NOTCH_TIMINGS} from '../core/notch-interaction.js';

test('hover waits 500ms, then previews; full view requires explicit action', () => {
  const flow = new HoverIntent();
  flow.pointer(true, 100);
  assert.equal(flow.tick(599).mode, 'rest');
  assert.equal(flow.tick(600).mode, 'peek');
  assert.equal(flow.tick(2000).mode, 'peek');
  assert.equal(flow.openFull().mode, 'full');
});
test('brief hover and cancelled deadlines never open later', () => {
  const flow = new HoverIntent();
  flow.pointer(true, 0); flow.pointer(false, 600);
  assert.equal(flow.tick(1000).mode, 'rest');
  flow.pointer(true, 1100);
  assert.equal(flow.tick(1599).mode, 'rest');
  assert.equal(flow.tick(1600).mode, 'peek');
  flow.dismiss();
  assert.equal(flow.tick(3000).mode, 'rest');
});
test('leaves close quickly but quick re-entry cancels closure', () => {
  const flow = new HoverIntent();
  flow.pointer(true, 0); flow.tick(500);
  flow.pointer(false, 700);
  assert.equal(flow.tick(859).mode, 'peek');
  flow.pointer(true, 859);
  assert.equal(flow.tick(2000).mode, 'peek');
  flow.pointer(false, 2000);
  assert.equal(flow.tick(2160).mode, 'rest');
  assert.ok(NOTCH_TIMINGS.leaveDelay < NOTCH_TIMINGS.hoverDwell);
});
test('draft/recording/modal protection survives leaving until explicitly dismissed or released', () => {
  const flow = new HoverIntent();
  flow.openFull(); flow.setProtected(true, 0); flow.pointer(false, 0);
  assert.equal(flow.tick(10000).mode, 'full');
  flow.setProtected(false, 10000);
  assert.equal(flow.tick(10159).mode, 'full');
  assert.equal(flow.tick(10160).mode, 'rest');
  flow.openFull(); flow.setProtected(true, 11000);
  assert.equal(flow.dismiss().mode, 'rest');
});
