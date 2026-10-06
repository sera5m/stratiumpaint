'use strict';
// The desktop accent, as a #rrggbb string. Chromium's AccentColor follows
// Windows and macOS. On Linux it usually stays a generic blue, so the shell
// reads GNOME's named accent and KDE's AccentColor instead.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GNOME = {
  blue: '#3584e4',
  teal: '#2190a4',
  green: '#3a944a',
  yellow: '#c88800',
  orange: '#ed5b00',
  red: '#e62d42',
  pink: '#d56199',
  purple: '#9141ac',
  slate: '#6f8396',
};

function parseColor(raw) {
  const s = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s || /^none$/i.test(s) || /^plasma$/i.test(s)) return '';
  const hex = /^#?([0-9a-f]{6})$/i.exec(s);
  if (hex) return `#${hex[1].toLowerCase()}`;
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(s)
    || /^(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(s);
  if (!rgb) return '';
  const n = [rgb[1], rgb[2], rgb[3]].map((x) => Math.min(255, parseInt(x, 10)));
  if (n.some((v) => Number.isNaN(v))) return '';
  return `#${n.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function gnomeHex(raw) {
  const name = String(raw || '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  return GNOME[name] || '';
}

function windowsHex(raw) {
  const s = String(raw || '').trim().replace(/^#/, '');
  if (/^[0-9a-f]{8}$/i.test(s)) return `#${s.slice(2).toLowerCase()}`;
  return parseColor(raw);
}

function section(text, name) {
  const re = new RegExp(`(?:^|\\n)\\[${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]([^\\[]*)`, 'i');
  const m = re.exec(String(text || ''));
  return m ? m[1] : '';
}

function keyColor(block, key) {
  const re = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'mi');
  const m = re.exec(block);
  return m ? parseColor(m[1]) : '';
}

function parseKde(text) {
  const src = String(text || '');
  return keyColor(section(src, 'General'), 'AccentColor')
    || keyColor(section(src, 'Colors:Window'), 'DecorationFocus')
    || keyColor(section(src, 'WM'), 'activeBackground')
    || '';
}

function parseGtk(css) {
  const src = String(css || '');
  const pick = (name) => {
    const re = new RegExp(`@define-color\\s+${name}\\s+([^;]+);`, 'i');
    const m = re.exec(src);
    return m ? parseColor(m[1]) : '';
  };
  return pick('accent_bg_color') || pick('accent_color');
}

/** First real desktop accent. An empty string means "leave the CSS AccentColor". */
function pickAccent({ desktop = '', gnome = '', kdeText = '', gtkCss = '', windows = '' } = {}) {
  const win = windowsHex(windows);
  if (win) return win;
  const de = String(desktop || '').toLowerCase();
  const kde = parseKde(kdeText);
  const gn = gnomeHex(gnome);
  const gtk = parseGtk(gtkCss);
  if (/kde|plasma/.test(de) && kde) return kde;
  if (/gnome|unity|pantheon|budgie/.test(de) && gn) return gn;
  return gn || kde || gtk || '';
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function gnomeName() {
  return new Promise((resolve) => {
    execFile('gsettings', ['get', 'org.gnome.desktop.interface', 'accent-color'], { timeout: 800 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

function windowsAccent(systemPreferences) {
  if (process.platform !== 'win32' || !systemPreferences?.getAccentColor) return '';
  try { return systemPreferences.getAccentColor() || ''; } catch { return ''; }
}

function readDesktopAccent(systemPreferences) {
  const home = os.homedir();
  const kdeText = readText(path.join(home, '.config', 'kdeglobals'));
  const gtkCss = [
    readText(path.join(home, '.config', 'gtk-4.0', 'gtk.css')),
    readText(path.join(home, '.config', 'gtk-3.0', 'gtk.css')),
  ].filter(Boolean).join('\n');
  return gnomeName().then((gnome) => pickAccent({
    desktop: process.env.XDG_CURRENT_DESKTOP || '',
    gnome, kdeText, gtkCss,
    windows: windowsAccent(systemPreferences),
  }));
}

module.exports = { parseColor, gnomeHex, windowsHex, parseKde, parseGtk, pickAccent, readDesktopAccent };
