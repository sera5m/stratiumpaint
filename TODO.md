# TODO / Notes

Quick-and-dirty became actually useful. Tracking remaining work.

## Scaling
- [x] Interactive scale (handles, wheel, W/H fields) is visual only: a `drawImage` stretch of the lifted pixels in the overlay, no `resizeImage` per event.
- [x] Real resample runs once: after set-down (Enter / right-click) and 0.5s idle since the last size change, with a thin border fading out meanwhile. The resampled result is the history step.
- [x] Left-click outside the box sets down immediately. Tool switch, undo and menu commands (`Editor#commitPending`) land a waiting scale at once instead of dropping it; Escape after set-down lands it too.
- Preview is drawn on top of the overlay, so layers above, layer opacity and blend mode are not reflected until it lands.
- Possible further: switch final bake to canvas/OffscreenCanvas for consistency; investigate any pure-JS resize libs if needed.

## 3D features
- [x] Connected-component split: a group that does not share vertices becomes separate objects (`body 1`, `body 2`). Named groups that are connected stay as named.
- [x] Temporary object move: object list on the model pane when there are 2+ objects. Move mode, Shift-drag slides the selected object. Hide/Show drops it from the view and the raycast. Isolate hides every other object (press again to show all). Reset puts them back. Offsets are view-only and never saved.
- [x] Shape option **Wrap seams** (on by default). Off clips a shape to the UV chart the drag started on instead of continuing across the weld. (Clip is the chart's UV bounding box, so a neighbouring chart packed inside that box can still catch paint.)

## Shape brushes
Current (`src/js/tools/shapes.js`): line/curve, rect, roundrect, ellipse, triangle, diamond, pentagon, hexagon, polygon, star, arrow (fill/outline/both, radius, sides).

Add as needed:
- Explicit Line
- Capsule / pill
- Heart
- Cross / plus
- Rounded triangle / other rounded variants
- Stamp-along-stroke mode for any shape
- More as needed: keep adding to this list when a shape comes up.

## WebGPU (see docs/WEBGPU_PLAN.md)
- [x] Phase 1: shared device, layer textures, WebGPU 2D compositor (all 16 blend modes), behind `?renderer=webgpu` / `--webgpu`, with automatic Canvas 2D fallback.
- [ ] Phase 2: 3D view on WebGPU, sampling the composite texture directly (no per-stroke readback/upload), GPU pick pass.
- [ ] Phase 3: GPU resample + move/scale preview.
- [ ] Phase 4: GPU filters and adjustments.
- [ ] Phase 5: GPU-authoritative painting, GPU undo textures.
- [ ] Phase 6: default on.

## Context
Substance 3D Painter comparison noted as useful reference for traditional 3D paint features (polygon fill, projection, path, symmetry, object isolation, etc.). Free/open subset first.
