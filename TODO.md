# TODO / Notes

Quick-and-dirty became actually useful. Tracking remaining work.

## Scaling
- [x] Interactive scale (handles, wheel, W/H fields) is visual only: a `drawImage` stretch of the lifted pixels in the overlay, no `resizeImage` per event.
- [x] Real resample runs once: after set-down (Enter / right-click) and 0.5s idle since the last size change, with a thin border fading out meanwhile. The resampled result is the history step.
- [x] Left-click outside the box sets down immediately. Tool switch, undo and menu commands (`Editor#commitPending`) land a waiting scale at once instead of dropping it; Escape after set-down lands it too.
- [x] Preview now composites in place (layers above, opacity and blend mode show while dragging).
- Possible further: switch final bake to canvas/OffscreenCanvas for consistency; investigate any pure-JS resize libs if needed.

## Move / rotate
- [x] Drag, scale and rotate of lifted pixels are a float drawn with a transform each frame (no per-event CPU blend, layer write or recomposite). See docs/WEBGPU_PLAN.md "Move / drag performance" and `npm run bench:move`.
- [x] Rotate knob above the box (Shift snaps to 15°), Angle ° field, one combined scale+rotate resample at set-down / 0.5 s idle, one undo step; the selection outline turns too. Move Selection rotates the mask.
- [x] Shapes: Rotate option (degrees about the shape's centre). Already-drawn shapes: select and use Move Selected Pixels.
- [ ] Rotate on the GPU at set-down (resample is CPU, once).

## Uninstall
- [x] `scripts/uninstall.sh` (`--dry-run`, `--purge`, `--yes`), `make uninstall`, `npm run uninstall:app`. README covers NSIS / deb / AppImage.
- Not adding Help → Uninstall: removing the Arch package needs root (`pacman -R`) and would delete the running app; the terminal command is clearer.

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
- [x] Phase 3 (part): move/scale/rotate preview as a GPU float texture, dirty-rect scissored recomposite, cached below/above stacks.
- [ ] Phase 3 (rest): GPU resample at set-down.
- [ ] Phase 4: GPU filters and adjustments.
- [ ] Phase 5: GPU-authoritative painting, GPU undo textures.
- [ ] Phase 6: default on.

## Context
Substance 3D Painter comparison noted as useful reference for traditional 3D paint features (polygon fill, projection, path, symmetry, object isolation, etc.). Free/open subset first.
