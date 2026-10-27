# Performance notes (Oct 2026 pass)

Benchmarks run in headless Chrome on a box with **no GPU** (Canvas 2D is software-rasterized,
WebGPU is SwiftShader, i.e. a CPU emulation). Relative changes and the work counters are the
point; absolute GPU numbers on real hardware will be much lower.

* `npm run bench:brush | bench:shape | bench:3d` — `test/browser/paint-bench.html`: 720×720 and a
  large document, 40 frames × 4 pointer events. Canvas 2D uses the real View (and MeshView); a
  frame is the pointer events' JS plus every requestAnimationFrame callback that ran for it.
  WebGPU is the compositor's present pass into an offscreen target. Counters per frame: pixels
  uploaded (putImageData / WebGL tex uploads / WebGPU writeTexture + canvas copies) and read back.
* `npm run bench:move`, `npm run profile:ui` — see docs/WEBGPU_PLAN.md.

## 2. Brushes (paintbrush, pencil, eraser, clone)

**Was:** every mouse-down copied the whole layer (48 MB at 4000×3000) and zeroed a coverage plane
the size of the document (12 MB); release cropped the stroke's *bounding rectangle* twice (before
and after) for history, so one diagonal stroke across a big image stored and copied millions of
untouched pixels. Each dab also fired its own layer update / redraw request, and a stroke inside
a selection threw (`maskBounds` was never imported).

**Now:** the stroke's backup and coverage live in 64×64 tiles made the first time a dab reaches
them (nothing is copied at mouse-down). History stores only the painted tiles: their backups
*are* the "before" pixels (no copy) plus one copy of the tiles after (`Doc#commitPatches`; undo /
redo write back only those tiles). Cancel restores only those tiles. The dab kernel walks each row
tile-span by tile-span, uses a coverage function specialised per stroke (same arithmetic as
`coverage()`), skips pixels/rows outside the dab without a square root, and reuses cached dab masks
when the centre is on the half-pixel grid (pencil, snapped strokes) where reuse is exact. One
`layer.touch()` (one upload rect, one redraw request) per pointer event instead of per dab.

| bench:brush, median | 720 before | 720 after | 4000×3000 before | after |
|---|---|---|---|---|
| start (mouse-down) | 1.3–2.3 ms | 0.2–1.9 ms | 23–51 ms | 0.2–1.0 ms |
| release (commit + history) | 1.5–2.0 | 0.6–1.3 | 24–31 | 3.4–6.3 |
| Canvas 2D frame, brush 12 / 60 | 0.4 / 0.8 | 0.5 / 1.0 | 1.2 / 2.5 | 1.2 / 2.9 |
| WebGPU frame, brush 12 / 60 | 2.8 / 3.4 | 2.8 / 3.6 | 5.8 / 8.8 | 5.1 / 9.5 |
| pixels copied at stroke start | 518k | 0 | 12M | 0 |

(before = after item 4, commit 0d514df.) Engine alone in node (`npm run bench:brush-engine`, 160
events): mouse-down 25–38 ms → 0.05–0.2 ms, release 45–51 ms → 3–6 ms at 4000×3000; per event
unchanged (0.21 → 0.20 ms brush 12, 0.68 → 0.71 ms brush 60).

**GPU dab stamping: assessed, not done.** Per frame the CPU stamping is 0.2–0.8 ms at 720×720 and
0.6–2.3 ms at 4000×3000 (bench "pointer events"), and the WebGPU upload is just the touched rect
(1–21k px, ≤ 90 KB). The rest of a WebGPU frame here is SwiftShader compositing. Moving dabs to
the GPU would save at most that CPU time, but the CPU pixels are needed synchronously for
history, the colour picker, fill, selection tools and saving, so they would have to be read back
(async) at every stroke end — a correctness risk (undo racing a readback) for a gain smaller than
one frame. Worth revisiting only if profiling on real hardware shows the stamping kernel on top.

`test/brush-parity.test.mjs`: the old engine is kept verbatim in `test/fixtures/` and the new one
must produce the same bytes for brush / pencil / eraser / clone × every falloff × hardness ×
antialiasing, random sizes and opacities, odd (non-tile) document sizes, strokes off the edges,
selections, mirror, radial, repeat and 120 px dabs; plus undo, redo, cancel, history size for a long
diagonal stroke (< 1/5 of the old bounding-box copy) and one layer update per pointer event.

## 3. Shapes

**Was:** mouse-down copied the whole layer. Every drag frame restored the previous rectangle from
that copy, rasterized the shape on a fresh canvas, read it back with `getImageData`, blended it
into the layer pixel by pixel on the CPU and re-uploaded the rectangle.

**Now:** nothing is copied at mouse-down. The shape is drawn into a canvas the size of its bounds
and shown as a float over its layer (`Doc#setFloat({ canvas })`), so it previews in place (layers
above, blend mode, opacity, selection clip) without touching the layer. On release it is
rasterized once into the layer and history stores only that rectangle (snapshotted from the
untouched layer). Antialiasing off still reads the preview back (hard edges need the pixels).
WebGPU copies the preview canvas into a texture GPU-side (`copyExternalImageToTexture`).

| shape bench, median per frame | 720 before | 720 after | 4000×3000 before | after |
|---|---|---|---|---|
| Canvas 2D rect outline: frame | 3.4 ms | 0.5 ms | 56.1 ms | 9.2 ms |
| Canvas 2D ellipse fill: frame | 5.4 | 0.5 | 89.3 | 8.8 |
| start (mouse-down) | 1.3–1.4 | 0.0 | 27–46 | 0.0 |
| commit (release) | 0.9 | 8.0 | 17–20 | 55–88 |
| read back per frame | 273k px | 0 | 5.9M px | 0 |
| WebGPU rect outline: frame | 43.1 | 15.1 | 238 | 214 |

The commit now does the one rasterize + blend that used to run every frame. On WebGPU the
per-frame cost on SwiftShader is the float frame + present over the shape's area plus the preview
canvas copy; drawing shapes natively on the GPU would remove the copy (not done).
`test/browser/tools-parity.html` (in `npm run test:gpu`): committed shape = the old one-shot path
exactly (max diff 0), live preview = committed composite (max 2), 0 layer writes and 0 readbacks
while dragging, one history step, exact undo, Escape leaves nothing.

## 4. Screen pass (dirty regions)

**Was:** any change, even one brush dab, threw the whole picture away twice: `Doc#composite()`
redrew every layer over the full document, and the View cleared the screen and redrew the
checkerboard and the whole composite over the full window (1600×1000 = 1.6M px in the bench).
The WebGPU present pass shaded every screen pixel the same way.

**Now:** every change reports the rectangle it touched (`layer.touch(r)` → `Doc` 'render' with
`r`; float moves report old ∪ new bounds). Per frame (all requests coalesced into one
requestAnimationFrame) the rects are united and:

* `Doc#composite()` redraws only that rect of the composite (per-layer `drawImage` sub-rects;
  blend modes are per pixel, so this is exact). With a float the cached below/above split is kept
  and only old ∪ new float bounds are recomposited.
* The Canvas 2D View clips to the matching screen rect and redraws checker + only the matching
  part of the composite (sub-rect aligned to mip blocks when zoomed out).
* WebGPU draws into a resident view texture with a scissor rect and `loadOp: 'load'`, then copies
  it to the canvas (the canvas is configured with `COPY_DST`; targets without it keep the old
  full pass).
* Pan, zoom, resize, a different document or renderer: full redraw (a view key).
* Overlay (handles, marching ants): the ants outline is built once per mask/view as a `Path2D`
  instead of on every 130 ms animation tick. The overlay is a thin line layer, so it is still
  cleared and stroked whole; dirty-tracking it would cost more than it saves.

| bench, median per frame (1600×1000 view) | 720 item-3 | 720 now | 4000×3000 item-3 | now |
|---|---|---|---|---|
| screen px redrawn, brush 12 / 60 | 1.6M | 1.2k / 6.7k | 1.6M | 1.2k / 2.4k |
| composite px redrawn, brush 60 | 518k | 6.4k | 12M | 21k |
| WebGPU brush 12 frame | 9.9 ms | 2.8 ms | 51.7 ms | 5.8 ms |
| WebGPU brush 60 frame | 9.9 | 3.4 | 62.0 | 8.8 |
| WebGPU rect outline frame | 16.3 | 9.0 | 258 | 163 |
| Canvas 2D move: drag lifted 1500² (bench:move) | — | — | 28.8 | 7.3 |
| Canvas 2D move: scale / paint 64² | — | — | 38.5 / 27.8 | 21.6 / 3.6 |
| Canvas 2D move: paint 64² at 720 | 0.9 | 0.5 | | |

Canvas 2D *JS* frame times for brush/shape barely move: Chrome rasterizes the canvas later in the
GPU process, which the harness does not time; the pixel counters are the measure there.
`test/browser/view-damage.html` (in `npm run test:gpu`): brush stroke, layer edit, float lift /
move / scale / rotate / drop and undo at zoom 1, 0.37, 2, 2.5, 3 — every changed composite pixel is
inside the reported rect (exact), the partially redrawn screen equals a full redraw (exact at zoom
≥ 1 except pixels whose centre lands exactly on a doc-pixel edge, ≤ 8 levels at zoom < 1 where
Chrome's own downscale filter differs between two full redraws), WebGPU partial present equals a
full present exactly, small edits redraw ≤ 6.4% of the view, a pan redraws all, 20 changes in one
frame give one redraw.
