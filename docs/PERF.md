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
