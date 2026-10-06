import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { gnomeHex, parseKde, parseGtk, pickAccent, windowsHex } = require('../electron/accent.cjs');

test('gnome accent names become the Adwaita colours', () => {
  assert.equal(gnomeHex("'orange'\n"), '#ed5b00');
  assert.equal(gnomeHex('blue'), '#3584e4');
  assert.equal(gnomeHex('not-a-colour'), '');
});

test('kde AccentColor wins over the window decoration', () => {
  const text = '[General]\nAccentColor=30,146,255\n\n[Colors:Window]\nDecorationFocus=1,2,3\n';
  assert.equal(parseKde(text), '#1e92ff');
  assert.equal(parseKde('[Colors:Window]\nDecorationFocus=10,20,30\n'), '#0a141e');
  assert.equal(parseKde('[General]\nAccentColor=Plasma\n'), '');
});

test('a gtk css accent is read, and the desktop in use wins', () => {
  assert.equal(parseGtk('@define-color accent_color #fff;\n@define-color accent_bg_color rgb(233, 84, 32);'), '#e95420');
  assert.equal(windowsHex('#FF0078D4'), '#0078d4');
  const both = { desktop: 'GNOME', gnome: 'purple', kdeText: '[General]\nAccentColor=0,0,0\n', gtkCss: '', windows: '' };
  assert.equal(pickAccent(both), '#9141ac');
  assert.equal(pickAccent({ ...both, desktop: 'KDE' }), '#000000');
  assert.equal(pickAccent({ desktop: '', gnome: '', kdeText: '', gtkCss: '', windows: '' }), '');
});
