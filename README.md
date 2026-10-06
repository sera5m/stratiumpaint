# Stratum

A layered raster image editor in the spirit of Paint.NET — layers, selections,
undo history, adjustments, effects, and OpenRaster (.ora) support. Built for
Linux (Electron), with a standalone browser build as a bonus. The highlight
colour follows the system accent: GNOME and KDE on Linux, and the system
colour on Windows and macOS.

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

Move Selected Pixels (M) drags what you selected, or the whole layer when
nothing is. Drag any edge or corner of the box to scale it — not only the
knobs — or type a width and height in the options bar. Shift (or Lock) keeps
the proportions, and the scroll wheel scales from the centre. Move Selection
resizes the outline the same way and leaves the pixels where they are.
Enter or a right-click sets it down; Esc puts it back.

View → Node Editor (Shift+N) is a third way to build a picture: a function
graph in the spirit of Blender's compositor and shader editor. Textures,
colour, blur, masks and math nodes mix together. Gradient takes a start
and an end vector, plus two colours, so the ramp is not stuck as grey.
Add, Subtract, XOR and Intersect combine two pictures: opaque colours mix
per channel, and a transparent edge behaves like a shape boolean. Circle,
Oval, Triangle, N-Gon, Line and Curve draw a fill and an outline. The
Formula node takes a small slice of LaTeX (`\frac{u}{2}`, `\sin(u \cdot \pi)`,
`u^2+v^2`, or a bare `sin(u)`). With Pixels off, u and v run from 0 to 1
across the picture; with Pixels on they are pixel coordinates. x and y are
always pixels. A, B and C are the node's inputs. An RGB node's title is
the colour itself, checkerboard showing through where alpha is low, and
the body takes hex or 0–255 channels including alpha. Apply writes the
Composite node onto the active layer, and a selection limits that write.
Ctrl+Z in the node editor undoes the graph, not the paint.

The editor copies the Blender interactions that matter for a raster graph:
Shift+A search, drag sockets (drop on empty ground to search), box select,
Alt-drag to cut links, Shift+D duplicate, copy and paste, mute (M),
collapse (H), delete and delete-with-reconnect (Ctrl+X), reroute on a
double-clicked wire, frames (Ctrl+J), groups (Ctrl+G, Tab in, Shift+Tab
out), a viewer with a backdrop (V, or Ctrl+Shift-click a node), a sidebar
(N), colour tags, Ctrl to snap, and G to grab. It is not a path tracer, so
there are no BSDF shaders, movie clips, render layers, Cryptomatte,
tracking or physical defocus.

The same graph can be driven from a pipe, including a compiled desktop
build, which is there so a local model can use it:

```text
stratum --script
{"cmd":"help"}
{"cmd":"new","width":256,"height":256}
{"cmd":"add","type":"formula","id":"fx","params":{"latex":"\\\\sin(u \\\\cdot \\\\pi)"}}
{"cmd":"link","from":"fx","out":"value","to":"comp","in":"image"}
{"cmd":"apply"}
```

One JSON object per line, one JSON result per line. If Stratum is already
open, the pipe is handed to that copy. Nodes → Run Script uses the same
language in the browser. `{"cmd":"types"}` lists every node and socket.

The node editor also has a short Ask row. Type an Ollama model name
(`qwen2.5-coder:7b`, or a small thinking model such as a DeepSeek distill)
and a sentence. Stratum calls `http://127.0.0.1:11434` and runs the JSON
lines that come back. The current graph is listed with each node's socket ids, and a
close name (`image`, `color`, `out`, `in`) still connects when the node has
one matching socket. Generation is not cut off at a short token cap. While
it waits, a small box shows the model, the token just produced, tokens per
second, how many commands have arrived, and the harness name (`Ollama`, or
`script pipe` when something writes the pipe). The whole prompt, the raw
reply, the commands, and the errors are written to `agent.txt` inside the
saved job (the `.2dlayered` zip). Unzip that and the text is there to copy.
The model stays in Ollama, so its video memory is not Stratum's. Retry asks
one more time if a line fails; leave it off when the model spends a long
time thinking. Any other harness can still pipe into `stratum --script`
instead of using Ask. A line may include `"source":"my harness"` to put
that name on the second line of the box.

Model → Unwrap Demo, Model → Open Model, or dropping an `.obj` lays the
surface out as one texture and mounts it beside the canvas. Charts stay
joined while the bend between faces is under the angle you set; sharper
edges become seams. Each chart is turned so the top of the texture is up
on the model, which keeps text upright. Areas and objects are separated by
64 pixels unless you change that. If the file is in
metres, pixels-per-metre sets the texel density (0 just fits the atlas).
JSON `{ "positions": [...], "indices": [...] }` works too, with optional
`uvs` (one pair per corner, v = 0 at the bottom). STL and FBX (ASCII or
binary) are read as triangles and unwrapped, since those files have no UVs.
A binary STL may start with the word `solid` and may have a short trailer
after the triangles; both still count. Curves and NURBS in an FBX are
skipped. GLB (and a glTF that does not point at a separate file) is read
the same way: parts stay where the scene put them, and existing UVs can be
kept. A Draco or meshopt GLB has to be exported as a plain GLB first.
Paint the flat image or the model — both write the active layer. A GLB often
puts every object on the same 0–1 texture square; when those squares overlap,
each object is given its own patch, so a stroke on one part does not appear
on the others. Parts that were already laid out apart are left where they
are. Scroll zooms, the middle button slides the view, and Alt-drag turns it.
The cube in the corner of the model snaps to Front, Back, Left, Right, Top
or Bottom (drag the cube to orbit). Solid shows the shape. Flat lays the
same triangles out as the unwrap. A rectangle, ellipse or line dragged
across a seam on the model continues over that weld, from one lip of the
unwrap to the other, instead of stretching the long way across the chart.
The flat sheet stays flat and does not wrap.
Right-drag is still the secondary
colour. Alt+drag still turns the view. Split / texture only / model
only is in the Model menu. The mount lasts for the session; the texture
saves like any other image. Unwrap Again opens a fresh atlas so the current
painting is not thrown away.

Several images can sit on the same model, each in its own tab. Add Image to
Model, New Image on Model, or a drop on the model pane places that picture
on the object. It starts as a patch, not a full wrap. **Move** drags it
across the surface and scroll changes its size. **Limit to Faces** moves it
onto those parts and keeps it there, such as the sensor or the pull tab. Editing the picture redraws
it onto the object's texture. Painting the model writes a separate Model
paint layer. The source image is never painted back into.

While a job has unsaved changes, a working copy is written about every eight
seconds under the program's own data, not next to the picture:

```text
internal / <name-id> / <savepoint> / structure.2dlayered
internal / <name-id> / <savepoint> / structure.3dlayered
```

Each file is a zip: `job.json`, one PNG per layer, and for a mounted model
the mesh buffers. The last three savepoints are kept. Inactive layers drop
their extra screen copy after a savepoint, and a very large image keeps a
shorter undo history so old strokes are not all held in memory. Closing
deletes that tree. The close popup is **Save unfinished work as** — save
writes the zip out under the name you give it; discard deletes the working
copy; cancel stays open. File → Save Unfinished Work As does the same without
closing. Open accepts `.2dlayered` and `.3dlayered`.

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

On the desktop app, Help → Check for Updates looks for a newer version a
moment after launch as well. A git checkout is fast-forwarded. A copy
installed somewhere it cannot write, such as `/usr/lib/stratum`, is updated
into the home folder (`~/.local/share/stratum/app`) and the app menu opens
that copy afterwards. A browser tab just needs a refresh.

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
