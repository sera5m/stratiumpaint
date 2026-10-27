# TODO / Notes

Quick-and-dirty became actually useful. Tracking remaining work.

## Scaling (in progress / just landed)
- Interactive scale is now visual-only (canvas stretch). Pixel resample deferred 0.5s after set-down with fading border.
- Left-click outside the box also sets down.
- Possible further: switch final bake to canvas/OffscreenCanvas for consistency; investigate any pure-JS resize libs if needed.

## 3D features
- [x] Connected-component split: a group that does not share vertices becomes separate objects (`body 1`, `body 2`). Named groups that are connected stay as named.
- [x] Temporary object move: object list on the model pane when there are 2+ objects. Move mode, Shift-drag slides the selected object. Hide/Show drops it from the view and the raycast. Reset puts them back.
- [x] Shape option **Wrap seams** (on by default). Off stops a shape at the UV chart instead of continuing across the weld.

## Shape brushes
Current: curve, rect, roundrect, ellipse, triangle, diamond, pentagon, hexagon, polygon, star, arrow (fill/outline/both, radius, sides).

Add as needed:
- Explicit Line
- Capsule / pill
- Heart
- Cross / plus
- Rounded triangle / other rounded variants
- Stamp-along-stroke mode for any shape

## Context
Substance 3D Painter comparison noted as useful reference for traditional 3D paint features (polygon fill, projection, path, symmetry, object isolation, etc.). Free/open subset first.
