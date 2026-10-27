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

* Recompositing is whole-document per change (one pass per visible layer); there is no tile or
  scissor optimisation yet.
* Zoomed-out minification uses up to 4×4 bilinear taps, not mipmaps.
* Colour picker, export, flood fill and the 3D texture still use the Canvas 2D composite
  (`Doc#composite()` is built on demand when they ask).
* After device loss the session stays on Canvas 2D; re-creating the device is a later task.
* Not yet checked by eye on real GPU hardware or inside the Electron window.

## Reference

Substance 3D Painter is the reference for the 3D painting feature set (projection painting,
polygon fill, object isolation, symmetry). See TODO.md.
