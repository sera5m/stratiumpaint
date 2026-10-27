# TODO / Notes

Quick-and-dirty became actually useful. Tracking remaining work.

## Scaling (in progress / just landed)
- Interactive scale is now visual-only (canvas stretch). Pixel resample deferred 0.5s after set-down with fading border.
- Left-click outside the box also sets down.
- Possible further: switch final bake to canvas/OffscreenCanvas for consistency; investigate any pure-JS resize libs if needed.

## 3D features
- [ ] Temporary move / hide / isolate of mesh parts so objects can be moved out of the way for painting behind them (with reset).
- [ ] Configuration toggle for shape brush behavior: wrap across seams for continual surface vs per-chart only. (wrap.pieces path already exists in shapes.js)

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
