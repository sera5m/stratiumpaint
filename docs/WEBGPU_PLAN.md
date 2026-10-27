# WebGPU plan

Goal: move Stratum's 2D and 3D rendering, and the heavy pixel work, onto WebGPU, without
breaking the "it just works" Canvas 2D app that exists today. Features and architecture come
first; UI polish comes later.

Status: **phase 1 has landed** (behind a flag, off by default). See [Phase 1](#phase-1--foundation-landed).

---

## 1. How rendering works today (audit, Oct 2026)

| Area | Today | Where |
| --- | --- | --- |
| Pixel storage | Every layer is a CPU `Uint8ClampedArray` RGBA buffer with straight alpha (`layer.img`). It is the source of truth. Each layer also has a lazily synced `<canvas>` mirror, updated with `putImageData` on the dirty rect. | `doc/layer.js` |
| Compositing | `Doc#composite()` draws every visible layer's canvas mirror into one cached canvas with `globalAlpha` (opacity) and `globalCompositeOperation` (blend mode). The 16 blend modes are Canvas 2D's W3C modes. Without a DOM (tests), a source-over-only CPU stack is used. | `doc/document.js`, `core/blend.js` |
| Main 2D view | Two stacked canvases. The base canvas draws a checkerboard, then `drawImage(doc.composite())` with pan/zoom (smoothing only below 100%). The overlay canvas draws the marching ants (CPU outline segments), pixel grid, UV wires, brush ring and each tool's `overlay()`. | `ui/view.js` |
| Move/scale preview | Drawn in the overlay with `drawImage` stretching the lifted pixels. The real resample (`resizeImage`, CPU separable triangle filter) runs once after set-down plus 0.5s idle. | `tools/move.js`, `core/transform.js` |
| Shapes | **Canvas 2D paths**, not hand-rolled raster. `tracePath()` builds the path on a 2D context, then `rasterize()` gets the pixels back with `getImageData` and they are composited into the layer on the CPU. Seam wrapping draws one clipped copy per UV piece. | `tools/shapes.js`, `doc/raster.js` |
| Brushes | **Hand-rolled CPU.** Per-pixel coverage dabs (hard, linear, smooth, gaussian, airbrush falloff), a coverage plane with max() so dabs never build up past the opacity, mirroring and repeat. Pencil, eraser and clone stamp share the engine. | `tools/brush.js`, `core/image.js` |
| Text | Canvas 2D `fillText`, rasterized back to pixels. | `tools/text.js` |
| Filters / adjustments | All CPU over `ImageData`: about 59 effects (blur, warps, noise, …) and 9 adjustments, plus the node graph evaluator. No workers. | `core/effects*.js`, `core/adjustments.js`, `core/blur.js`, `nodes/eval.js` |
| Flood fill / magic wand | CPU scanline flood over the layer or the flattened image. | `core/flood.js`, `core/fill.js` |
| Colour picker | `Doc#pixelAt`: a one-pixel `getImageData` from the composite canvas (image sampling) or a direct read of `layer.img`. | `doc/document.js`, `tools/extra.js` |
| Save / export | PNG/JPEG/WebP via `canvas.toBlob` on the composite canvas. ORA writes one PNG per layer canvas. Job files are zipped PNGs. | `doc/io.js`, `core/ora.js`, `core/job.js` |
| Undo | CPU: `commitRegion` stores before/after crops of the touched rect. | `doc/document.js`, `core/history.js` |
| **3D view** | **Hand-rolled WebGL 1**, with no three.js or other library. One shader program (Lambert-style lighting plus a texture), plain vertex buffers (non-indexed triangles), and a custom camera (perspective, lookAt, orbit, pan, view cube). Whenever the texture document re-renders, the **whole atlas composite is read back with `getImageData` and re-uploaded with `texImage2D`**, which is the biggest per-stroke cost in 3D. | `ui/meshview.js` |
| 3D painting | CPU raycast against a BVH (`buildBVH`/`raycastMesh`) gives a UV, and the UV becomes a document point. The ordinary 2D tools then paint the atlas document. Seam tracking (`seamStep`) and per-chart clipping handle welds. Object offsets and hiding rebuild a paint BVH. | `ui/meshview.js`, `core/mesh.js`, `core/seam.js` |
| Electron | Electron **33.4.11 = Chromium 130**. `navigator.gpu` exists without flags, but on Linux an adapter needs `--enable-unsafe-webgpu` and the `Vulkan` feature (Electron leaves Vulkan off on Linux). Checked on this box: under Xvfb with no GPU, `requestAdapter()` returns null with or without the switches, which is expected without a GPU, and the app falls back. On Windows/macOS, Chromium 130 ships WebGPU by default. | `electron/main.cjs` |

What this means: everything is CPU-first, and the GPU is used only implicitly through
Canvas 2D. The obvious costs are full CPU compositing through canvas mirrors (every layer gets a
`putImageData` per edit), the 3D texture round trip, CPU filters on big images, and CPU resampling.

---

## 2. Target architecture

```
            ┌──────────────── CPU (source of truth until phase 5) ────────────────┐
 tools ───▶ │ layer.img  ──touch(rect)──▶ dirty rects                              │
            └───────────────────────────────┬──────────────────────────────────────┘
                                            │ writeTexture(rect)
            ┌──────────────── GPU (one shared GPUDevice: gpu/device.js) ───────────┐
            │ layer textures (rgba8unorm)                                          │
            │   └─▶ compositor: blend shader, one pass per layer, ping-pong rgba16f │
            │          └─▶ composite texture ──▶ 2D present (pan/zoom/checker)     │
            │                              └──▶ 3D view samples it directly        │
            │ compute: resample, blur/filters, flood seeds, brush dabs (later)     │
            └──────────────────────────────────────────────────────────────────────┘
                  ▲ async readback (staging buffer, rect only) for picker/export/undo
```

* **One device** (`gpu/device.js`). It is shared by the 2D view, the 3D view and the compute
  passes, so textures move between them for free. Device loss is handled in one place.
* **GPU-resident layer textures.** In phases 1–4 the CPU buffer stays authoritative and the GPU
  mirrors it by dirty rect (`Layer#touch` → `_gpuDirty` → `writeTexture`). In phase 5 the GPU
  becomes authoritative for painting, and the CPU copy turns into a lazy cache.
* **Compositor with blend-mode shaders.** It works in premultiplied `rgba16float` for headroom,
  following the W3C compositing formula `Cs' = (1-ab)·Cs + ab·B(Cb,Cs)` and then source-over, so
  output matches Canvas 2D. Separable modes are defined once (`gpu/blendmath.js`) and generated
  into WGSL. The non-separable modes (hue, saturation, color, luminosity) are written in both
  languages and checked against each other. Later: tile/scissor recomposite of only the dirty
  region, and a cached "below active layer" texture so painting one layer costs one pass.
* **GPU resample and filters.** Compute shaders for `resizeImage` (the same separable triangle
  weights), Gaussian blur (separable), the adjustments (per-pixel, trivial), then the
  per-pixel effects. Each one keeps its CPU version as the fallback and as the test oracle.
* **3D on WebGPU.** Port `meshview.js` to the same device: an indexed vertex buffer, a depth
  buffer, MSAA, and the **composite texture bound directly** (no `getImageData`/`texImage2D`
  round trip). Picking moves to a GPU ID/UV pass (render triangle ID + UV into an `rg32float` /
  `r32uint` target, read back one pixel), with the CPU BVH kept as the fallback. That also makes
  object offsets and hiding cheap: they become uniforms, with no BVH rebuild.
* **CPU-needing tools read back efficiently.**
  * Colour picker: copy a 1×1 (or 3×3 for averaging) region to a `MAP_READ` buffer. It is async;
    the UI already tolerates a frame of latency.
  * Flood fill / magic wand: phase 1–4 use the CPU `layer.img` (already there). In phase 5, read
    back only the layer's bounding box once per click, or do a GPU jump-flood for global mode.
  * Save/export: one full readback per save (`copyTextureToBuffer`, 256-byte aligned rows), then
    the existing PNG/ORA encoders. Already prototyped as `GpuCompositor#readComposite`.
  * Undo: keep the CPU before/after rect crops. When the GPU is authoritative, the before crop is
    `copyTextureToTexture` into a pooled history texture (VRAM budget, spilling to CPU readback
    when over budget), so undo never blocks on readback.
* **Fallback.** `gpu/backend.js` picks the renderer. No `navigator.gpu`, no adapter, device
  failure, a document larger than `maxTextureDimension2D`, or device loss all mean Canvas 2D
  (today's path, unchanged). The 3D view keeps WebGL 1 as its fallback. Every GPU feature keeps
  its CPU implementation, which doubles as the oracle in parity tests (`npm run test:gpu`).

---

## 3. Phases (each one ships on its own, ordered by payoff and risk)

1. **Foundation: device, layer textures, 2D compositor (landed, behind a flag).**
   The shared device, dirty-rect layer textures, the WebGPU compositor for the main 2D view
   with all 16 blend modes and opacity, the present pass (pan/zoom, checker, minification taps),
   automatic fallback, and parity tests. Payoff: compositing leaves the CPU and canvas mirrors.
   Risk: low, since it is off by default and falls back.
2. **3D view on WebGPU with a shared composite texture.** Port the mesh renderer and sample the
   compositor's output directly (this removes the per-stroke full readback and upload). Add
   depth, MSAA and a GPU pick pass. Payoff: high for 3D painting. Risk: medium; WebGL stays
   as the fallback.
3. **GPU resample and the move/scale preview.** A compute `resizeImage`, the move tool's live
   preview as a GPU-sampled quad (it respects layer order, opacity and blend, unlike the overlay
   stretch), and instant final resample. Also layer resize and rotate. Payoff: medium-high.
   Risk: low; same weights as the CPU version, tested for parity.
4. **GPU filters and adjustments.** Adjustments first (per-pixel), then blur, sharpen, noise and
   warps; node-graph evaluation can schedule onto the same kernels. Live previews at
   full resolution. Payoff: high on big images. Risk: medium (59 effects; port them
   incrementally, with the CPU version as fallback per effect).
5. **GPU-authoritative painting.** Brush dabs, shapes (SDF or tessellated paths) and fills
   written straight into layer textures; the CPU copy becomes a lazy cache; undo moves to GPU
   history textures; the picker, flood and export use rect readback. Payoff: large-canvas and
   high-DPI painting stays at frame rate. Risk: highest. It changes the source of truth, so it
   ships per tool, behind its own flag.
6. **Default on.** After phases 1–3 have run without problems on real hardware (including
   Linux/Vulkan), make WebGPU the default with automatic fallback, and drop the Linux `--webgpu`
   requirement by enabling the switches when an adapter probe succeeds.

---

## Phase 1: foundation (landed)

* `src/js/gpu/device.js` shares one `GPUDevice` (`getGPU()`, resolves null instead of throwing)
  and handles device loss (`onDeviceLost`).
* `src/js/gpu/backend.js` holds the flag and the fallback choice (pure, tested in node).
* `src/js/gpu/blendmath.js` has the shared blend definitions, the JS reference compositor and
  mode indices.
* `src/js/gpu/shaders.js` holds the WGSL composite and present shaders (blend functions
  generated from blendmath).
* `src/js/gpu/compositor.js` (`GpuCompositor`) does dirty-rect layer textures, ping-pong
  compositing, the present pass and `readComposite()` readback.
* `ui/view.js` uses the GPU compositor when it is active and falls back to Canvas 2D on any
  failure or device loss. The overlay canvas (ants, handles, previews) is unchanged on top.
* `doc/layer.js` gains a GPU dirty rect, which is only tracked once a texture exists.

**Turning it on**

* Browser (`npm run web`): open `http://localhost:8080/?renderer=webgpu`, or run
  `localStorage['stratum.renderer'] = 'webgpu'`. Use `?renderer=canvas` to force the old path.
* Menu: **View → WebGPU Renderer (Experimental)** toggles the saved preference for the next start.
* Desktop app: start with `--webgpu` (or `STRATUM_WEBGPU=1`). That adds `enable-unsafe-webgpu`,
  plus `enable-features=Vulkan` on Linux, and asks the page for WebGPU.
* The console prints `Stratum: WebGPU renderer active`, or the reason it fell back.

**Tests**

* `npm test` includes `test/gpu.test.mjs`. It checks that the JS channel functions equal the
  expressions compiled into WGSL, the W3C reference points, the non-separable invariants,
  CPU-compositor parity, renderer selection and fallback, GPU dirty-rect bookkeeping, and that
  app code contains no `eval` (the CSP blocks it).
* `npm run test:gpu` runs `test/browser/webgpu-parity.html` in headless Chrome on SwiftShader
  WebGPU. It runs the real WGSL for all 16 modes against both the JS reference (max difference
  1/255) and Canvas 2D (max 5/255, which is 8-bit premultiplied rounding), plus dirty-rect upload
  and present-pass output (pixels, checkerboard, transparency outside the document). It is
  skipped when no Chrome is found.

**Known limits of phase 1**

* ~~Recompositing is whole-document per change~~: now dirty-rect, scissored (see below).
* Zoomed-out minification uses up to 4×4 bilinear taps, not mipmaps.
* Colour picker, export, flood fill and the 3D texture still use the Canvas 2D composite
  (`Doc#composite()` is built on demand when they ask).
* After device loss the session stays on Canvas 2D; re-creating the device is a later task.
* Not yet checked by eye on real GPU hardware or inside the Electron window.

## Move / drag performance (landed, Oct 2026)

**Why Move was slow.** Every pointer event (and Chrome sends several per frame) rebuilt the
moved pixels on the CPU: a fresh crop, a per-pixel blend back into the layer, then
`layer.touch()`. The touch pushed that rectangle into the layer canvas and recomposited
every layer of the whole document; on WebGPU it also re-uploaded the rectangle and ran one
full-document pass per layer. A mounted 3D model added a full `getImageData` + texture upload
per frame. Lift also cloned the whole layer.

**Now.** The lifted pixels are a *float* (`Doc#setFloat`): copied once at lift, the hole cut
once, then each event only changes `{box, angle}` and asks for one rAF-coalesced redraw.
No layer writes, history, readbacks or 3D uploads happen during the drag.

* Canvas 2D: layers below and above the active one are cached as two canvases; a frame is
  ~4 `drawImage` calls (below, layer, float with `setTransform`, above).
* WebGPU: the stacks below/above are resident textures, rebuilt only when a layer under them
  changes (and then only over the dirty rect, scissored). The float is one texture uploaded
  once per lift and drawn through its transform matrix (premultiplied bilinear), scissored to
  the union of last and current float bounds. Painting recomposites just the dirty rect.
* Resample (scale + rotate in one pass) runs once at set-down / 0.5 s idle.

`npm run bench:move` (headless Chrome, software only on the test box: no GPU, SwiftShader
WebGPU; a warm-up config runs first and is discarded). Medians per frame:

| 720×720, 3 layers           | before 2D | after 2D | before GPU | after GPU |
|-----------------------------|----------:|---------:|-----------:|----------:|
| 300×300 lift: drag          | 12.4 ms   | 0.9 ms   | 90.9 ms    | 15.1 ms   |
| 300×300 lift: scale         | 7.0       | 1.3      | 89.2       | 23.7      |
| 300×300 lift: rotate        | –         | 1.7      | –          | 40.0      |
| 300×300 lift: set-down      | 27.8      | 24.4     | 178.5      | 89.5      |
| full 720×720 lift: drag     | 33.1      | 1.0      | 129.9      | 45.1      |
| paint 64×64 per frame       | 6.1       | 0.8      | 86.2       | 8.6       |
| 4000×3000, 1500 lift: drag  | 177.3     | 25.7     | 1859.9     | 225.8     |

The WebGPU column is SwiftShader (CPU emulation of a GPU), so absolute GPU numbers mean
little; the drop is the point (no uploads and no full recomposites during the drag; the bench
prints the counters). Real hardware should be far faster.

**Moving after a scale (fixed Oct 27).** Two things made a scaled float slower to move than an
unscaled one, even though nothing was resampled before set-down:

1. *A different draw per frame.* Unscaled, the float is a plain pixel blit. Scaled or turned, every
   frame drew the lifted pixels stretched through a transform with `imageSmoothingQuality =
   'medium'` (mipmapped filtering; on GPU-rasterized canvases a filtered downscale of a canvas
   source can rebuild mipmaps on every draw). Now the transformed preview is drawn **once per
   size/angle** into a cached bitmap (`Doc.floatView`, keyed by `floatPlacement()`), and every
   move frame blits that bitmap at a whole-pixel offset, the same as an unscaled move. While
   actively resizing the bitmap is rebuilt per frame with plain bilinear (`'low'`), matching the
   GPU path; the real, supersampled resample still happens once at set-down.
2. *Per pointer sample UI work.* Each coalesced pointer sample emitted `overlay` synchronously;
   the status bar re-scanned the whole selection mask for its bounds and rewrote its text, the
   options bar re-synced, and the next sample's `getBoundingClientRect` then forced a layout.
   With a selection (wheel-scaling always has one, shapes are selected to move) that was ~0.3 ms
   per sample, ~5 ms/frame with a 1000 Hz mouse. Now the status bar and options bar update once
   per animation frame, mask bounds are cached per mask, text is only written when it changes,
   and the stage rect is read once per DOM event.

No idle timer runs while floating (the 0.5 s settle only starts after Enter / right-click), and
nothing re-lifts: `test/move-scale.test.mjs` asserts 0 resamples, layer writes, history steps and
timers across scale → drag → pause → drag → wheel → cycles, and exactly 1 resample at set-down.

`npm run bench:move` scale cases, Canvas 2D, 720×720, 300×300 lift, median per drag frame
(software / GPU-rasterized SwiftShader canvas):

| case                           | before        | after         |
|--------------------------------|---------------|---------------|
| plain drag (unscaled)          | 0.9 / 0.9 ms  | 0.9 / 0.9 ms  |
| scale 1.5×, then drag          | 2.0 / 2.0     | 0.9 / 0.9     |
| upscale 2×, then drag          | 1.8 / 2.6     | 1.0 / 0.9     |
| downscale 0.5×, then drag      | 1.0 / 1.1     | 0.9 / 0.9     |
| pause 0.7 s after scale, drag  | 1.7 / 1.5     | 1.0 / 0.9     |
| 6× (scale 3 fr + move 3 fr)    | 1.4 / 1.2     | 1.2 / 1.1     |

`npm run profile:ui` (the real app, ellipse selection, 16 pointer samples per frame, Canvas 2D):
frame 6.0–6.6 ms → 0.4–0.6 ms; synchronous event-handler time 4.6–5.2 ms → 0.0 ms per frame.
WebGPU was already the same shader path before and after a scale (0 uploads during drags); its
SwiftShader frame time grows with the area the float covers, not with the scale itself.

**Hot-path encoding audit.** No PNG/dataURL/toBlob in history (raw crops), previews or the
drag. Remaining encoders are deliberately debounced: the unfinished-work copy encodes each
layer to PNG 8 s after the last edit (`ui/scratch.js`), and autosave writes ORA every 60 s while
modified. The 3D texture now uploads straight from the composite canvas (no `getImageData`)
and refreshes at most every 100 ms during a drag.

**Still open:** lift on WebGPU is slower than before on SwiftShader (first float frame builds the
below/above stacks); the present pass redraws the whole view each frame; brushes are CPU with a
dirty-rect upload per stroke segment; shapes clone the layer at each shape start; the 3D view
is still WebGL fed from the Canvas 2D composite.

## Reference

Substance 3D Painter is the reference for the 3D painting feature set (projection painting,
polygon fill, object isolation, symmetry). See TODO.md.
