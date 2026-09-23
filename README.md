# Stratum

A layered raster image editor in the spirit of Paint.NET — layers, selections,
undo history, adjustments, effects, and OpenRaster (.ora) support. Built for
Linux (Electron), with a standalone browser build as a bonus.

warning: only tested on arch linux, and heavily written by ai to match a 4 page fully human written spec, then tested and tweaked by sleepy humans

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
