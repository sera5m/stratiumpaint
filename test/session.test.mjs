import assert from 'node:assert/strict';
import test from 'node:test';
import { beginSession, joinSession, leaveSession, placeToPixel, retarget } from '../src/js/ui/session.js';

const doc = (w, h) => ({ width: w, height: h });

test('images stack on one mesh and the mesh survives losing one of them', () => {
  const atlas = doc(64, 32);
  const mount = { id: 'm' };
  const session = beginSession(atlas, mount);
  const overlay = doc(32, 32);
  joinSession(session, overlay);
  assert.equal(session.members.length, 2);
  assert.equal(overlay.mount, mount);
  assert.equal(atlas.atlas, true);
  assert.equal(leaveSession(overlay), session);
  assert.equal(overlay.mount, null);
  assert.equal(session.members.length, 1);
  assert.equal(leaveSession(atlas), null);
});

test('a hit maps through the image rectangle', () => {
  const atlas = doc(100, 50);
  beginSession(atlas, {});
  assert.deepEqual(placeToPixel(atlas, 0.5, 0.5), { x: 50, y: 25 });
  const sticker = doc(10, 10);
  sticker.place = { u: 0.25, v: 0.5, w: 0.5, h: 0.25 };
  assert.equal(placeToPixel(sticker, 0.1, 0.1), null);
  assert.deepEqual(placeToPixel(sticker, 0.5, 0.625), { x: 5, y: 5 });
});

test('replacing the mesh updates every image on it', () => {
  const a = doc(8, 8);
  const session = beginSession(a, { id: 1 });
  const b = doc(8, 8);
  joinSession(session, b);
  const next = { id: 2 };
  retarget(session, next);
  assert.equal(a.mount, next);
  assert.equal(b.mount, next);
});
