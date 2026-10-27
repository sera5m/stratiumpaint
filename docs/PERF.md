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
