# Stratum

A layered raster image editor in the spirit of Paint.NET — layers, selections,
undo history, adjustments, effects, and OpenRaster (.ora) support. Built for
Linux (Electron), with a standalone browser build as a bonus.

Saving keeps the previous file (a `.bak` copy plus timestamped files in
`.stratum-backups/` next to it, and a copy in the browser). File → Save Backup
writes an extra OpenRaster snapshot. File → Restore Backup opens one without
overwriting the original. An autosave runs about once a minute while a
document has unsaved changes.

Remove Background (U, or Image → Remove Background) clears the colour on the
edges of the active layer. Tolerance is the same slider as the paint bucket.
Contiguous stops at the subject; Global clears every similar pixel.

Color Range (C, or Edit → Color Range) treats two RGBA colours as an inclusive
interval on each channel and deletes or replaces every pixel inside it.
Left-click sets colour A, right-click sets colour B and opens the dialog.
Primary and secondary are the starting ends.

Model → Unwrap Demo, Model → Open Model, or dropping an `.obj` lays the
surface out as one texture and mounts it beside the canvas. Charts stay
joined while the bend between faces is under the angle you set; sharper
edges become seams. Each chart is flattened and packed. If the file is in
metres, pixels-per-metre sets the texel density (0 just fits the atlas).
JSON `{ "positions": [...], "indices": [...] }` works too, with optional
`uvs` (one pair per corner, v = 0 at the bottom). Paint the flat image or
the model — both write the active layer. Right-drag is still the secondary
colour. Alt+drag, or Orbit, tumbles the view. Split / texture only / model
only is in the Model menu. The mount lasts for the session; the texture
saves like any other image. Unwrap Again opens a fresh atlas so the current
painting is not thrown away.

## Quick start (dev)

```sh
npm install          # pulls esbuild only
npm start             # builds + launches the Electron app
```

No network/npm? The bundler falls back to a system `esbuild` binary:

```sh
STRATUM_ESBUILD_CLI=1 node scripts/bundle-standalone.mjs
electron .
```

## Building

```sh
npm run build         # minified production build -> dist/
npm run build:dev      # unminified, inline sourcemap
npm test               # runs test/*.test.mjs (Node's built-in test runner)
```

`dist/index.html` + `app.js` + `app.css` is what Electron loads.
`dist/stratum.html` is everything inlined into one file — open it directly in
any modern browser, no install needed.

## Installing on Arch Linux

```sh
cd packaging/arch
makepkg -si
```

This builds from the checkout directly (no tarball/source download needed),
depends on `electron`, and falls back to the `esbuild` pacman package if you
haven't run `npm install`. It also runs the test suite as part of the build
(`check()`). Once installed, launch it as `stratum` or from your app menu;
it registers itself as a handler for common image formats plus `.ora`.

## Project layout

- `src/js/core/` — pure, dependency-free image-editing primitives (color,
  blend modes, compositing, history/undo, masks, flood fill, blur,
  adjustments, effects, OpenRaster read/write, zip).
- `src/js/doc/` — the document model built on top of core: layers, the `Doc`
  class (selection, transactions, geometry ops), file I/O.
- `src/js/tools/` — the 20 interactive tools (selection, move, nav, fill,
  brush family, shapes, text).
- `src/js/ui/` — DOM layer: editor session, canvas viewport, menus, panels,
  dialogs, command table, app bootstrap.
- `electron/` — main process + preload bridge (native dialogs, clipboard,
  file I/O; sandboxed, context-isolated, no node integration in the
  renderer).
- `scripts/bundle-standalone.mjs` — builds `dist/`.
- `packaging/arch/` — PKGBUILD, .desktop entry, launcher script.
- `test/` — unit tests for the core/doc/tools layers.

## License

MIT — see `LICENSE`.
