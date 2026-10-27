# TODO / Notes

Quick-and-dirty became actually useful. Tracking remaining work.

## Scaling (in progress / just landed)
- Interactive scale is now visual-only (canvas stretch). Pixel resample deferred 0.5s after set-down with fading border.
- Left-click outside the box also sets down.
- Possible further: switch final bake to canvas/OffscreenCanvas for consistency; investigate any pure-JS resize libs if needed.

## 3D features
- [x] Connected-component split: objects are separated if not connected by shared geometry (in mesh.js finish).
- [x] Temporary move of objects (MeshView: select object, Shift-drag in Move mode offsets it; Reset objects button).
- [x] Configuration toggle for shape brush behavior: wrapShapes (default on) continues shapes across seams; off = per-chart only.

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
