# Projection painting (3D shape mode "Projection")

Shape tools have a **3D** option: Surface (per chart), Surface (wrap seams) and Projection.
The first two map the drag through the UV under the cursor (as before). Projection treats the
shape as a slide in a projector and paints every surface the projector sees first.

## Controls
- Pick a box shape (Rectangle, Rounded Rectangle, Ellipse, Triangle, Diamond, Pentagon, Hexagon,
  Polygon, Star, Arrow). Style, Size, Rotate, Opacity, Antialiasing and right-drag for the
  secondary colour all work as in 2D. Shift makes it square.
- **3D → Projection**. **Project from**: **View** (the camera: what you see is what gets paint),
  or a world axis: **Down (−Y)**, Up (+Y), Front (−Z), Back (+Z), Right (−X), Left (+X). For an
  axis, the shape is drawn on a plane facing that axis through the point under the cursor (one
  image pixel ≈ one screen pixel there). Turn the view so you look at that plane: when the view
  is edge-on to it you get a toast instead.
- **Max angle** (default 80°): surfaces turned further than that from the projection ray get no
  paint, with an 8° fade before it.
- While dragging, a decal previews the shape on the model. Paint lands once, on release, as one
  history step over the changed rectangle of the texture (Model paint layer for a placed image).
- Hide / Isolate / moved objects (model pane) are respected: hidden objects neither take paint
  nor shadow what is under them; moved objects are painted where they are shown.
- Line / Curve keeps painting on the surface (a toast says so).

## How it works (`src/js/core/projection.js`, `src/js/gpu/projection.js`)
A projector is four rows over [x y z 1]: image x, image y, depth, w (perspective camera: the
view-projection matrix; axis: orthographic).
1. **Candidates** (CPU, shared): visible faces, in front of the projector, whose image overlaps the
   shape, with a slope-scaled depth bias, flat normal and UV corners.
2. **Depth map**: the visible mesh rendered from the projector over the shape's rect (perspective
   correct). WebGPU: a depth-only pass (`depth32float`). CPU: a scanline z-buffer.
3. **UV pass**: each candidate rasterized in atlas space at texel centres. Every texel takes its
   surface point, projects it, samples the shape (premultiplied bilinear, nearest when AA is off),
   keeps it only if its depth is within bias of the map (first hit), and fades by facing.
   WebGPU: one render pass with max blending, one readback of that box.
4. **Gutter dilation** (CPU, shared): 2 texels into texels no face owns, with the largest
   neighbouring alpha and alpha-weighted colour, so bilinear filtering at seams shows no gap.
5. **Commit**: source-over onto the layer (clipped to a selection if there is one), `commitRegion`.
The WebGPU path runs when the 2D view does (`ed.gpuCompositor`), on its device; any failure falls
back to the CPU path.

## Tests
- `test/projection.test.mjs`: projector math (axis and camera vs the GL matrix), stacked planes
  (only the top one gets paint, Down and View), partial cover, multi-object, hidden and moved
  objects, grazing rejection, opacity/AA, dilation that does not spill onto other faces, depth
  map, history and undo.
- `test/browser/projection-parity.html`: GPU vs CPU on six scenes (both projector kinds, AA and
  hard edges, hidden/moved objects, opacity and max angle). Tolerance: under 1% of texels off by
  more than 24 in alpha, mean |Δalpha| < 1, under 0.2% off in colour. Differences are triangle
  edges (fill rule) and faces that meet their occluder exactly (f32 vs f64 depth).
- `test/browser/projection-view.html`: the 3D view end to end on WebGL (CPU) and WebGPU (GPU):
  decal visible while dragging, lid painted, floor under it clean, open floor painted, hidden lid,
  one history step, exact undo, and the surface mode unchanged.

## Limits
- The drag preview has no occlusion: the decal also shows on surfaces behind the first one (in
  View mode those are hidden by the view's own depth anyway). The paint on release is correct.
- The texture side is texel-exact; the projector side is sampled at the shape image's resolution
  (screen pixels for View), so a tiny object far away gets a coarse outline.
- Faces that share UV space (mirrored or stacked islands) both get paint where both are visible.
- Very large axis projections are capped at 4096 image pixels across (coarser shape then).
- Projection is a click-and-drag shape only; brush strokes and the Line / Curve tool are not
  projected yet.
