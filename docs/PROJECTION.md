# Projection painting (3D shape mode "Projection")

Shape tools have a **3D** option: Surface (per chart), Surface (wrap seams) and Projection.
The first two map the drag through the UV under the cursor (as before). Projection uses a
**projector**, an object like a Blender camera or spot light. The shape is drawn on its plane and
fired along its direction; every surface it hits first gets paint.

## The projector
- **Location** (world units, X / Y / Z) and **Rotation XYZ°** (Euler degrees in Blender's
  default XYZ order: turn about X, then Y, then Z, all world axes; R = Rz·Ry·Rx). The world is Y-up
  (glTF). The projector fires along its local **−Z**; its local +X is the shape's right and +Y its
  up. Rotation (0, 0, 0) fires along −Z (Front).
- **Place it**: in Projection mode, the first click on the model puts it on the surface under the
  cursor. **Ctrl+click** on the model or the **Place** button (then a click) moves it again.
  **Offset** lifts it that far off the surface along the surface normal.
- **Fields**: type a value (Enter, Tab or leaving the field sets it; bad text reverts), Tab walks
  Location X Y Z → Rotation X Y Z, and dragging the coloured X / Y / Z letter scrubs (0.01 units or
  1° per pixel; Shift snaps to 0.1 / 15°). Rotations wrap to ±180°.
- **Gizmo** (in the 3D view whenever Projection mode is active): red / green / blue arrows move it
  along world X / Y / Z, the rings turn the matching Euler angle (gimbal, as Blender's Gimbal
  orientation: the X ring turns about the projector's own X after Y and Z, the Z ring about world
  Z). Shift snaps to 0.1 units / 15°. The yellow square is its image plane, the yellow arrow the
  firing direction; point sources are drawn as dots with lines to the square, extra parallel
  origins as dashed lines.
- **Preset**: View (align to the camera, same as **Set from view**), Down (−Y), Up (+Y), Front
  (−Z), Back (+Z), Right (−X), Left (+X). They only set the rotation; the field shows the preset a
  rotation matches, or Custom.
- **Origin**: **Parallel** (orthographic rays; they come from far behind the plane, so the plane
  only positions the shape) or **Point** (perspective: rays from a point **Distance** behind the
  projector, % of the model size, so the outline grows with distance).
- **Points** 1–8 and **Spread** 0–60°: fire from that many origins evenly in a ring tilted by the
  spread around the direction (point sources turned about the projector's location). A texel gets
  paint if any origin sees it first inside that origin's footprint (union); each origin has its
  own depth map, and max-angle fading uses the best origin. With 1 point (or spread 0) it is the
  single projection.
- **Max angle** (default 80°): surfaces turned further than that from an origin's rays get no
  paint from it, with an 8° fade.
- All of these persist between sessions (`localStorage`, with the 3D shape mode).

## Drawing
Pick a box shape (Rectangle … Arrow; Line / Curve stays on the surface). Drag anywhere that is not
a gizmo handle: the drag is traced onto the projector's plane (one shape pixel ≈ one screen pixel
at the projector), so Style, Size, Rotate, Opacity, Antialiasing, Shift (square) and right-drag
(secondary colour) work as in 2D. A decal previews it; on release it is fired and lands as one
history step over the changed rectangle (Model paint layer for a placed image). Hidden / isolated
objects neither take paint nor shadow; moved objects are painted where they are shown.

## How it works (`src/js/core/projection.js`, `src/js/gpu/projection.js`, `src/js/core/gizmo.js`)
Each origin is a projector: four rows over [x y z 1] giving image x, image y, depth and w, built
so a surface point lands where its ray from that origin crosses the projector's plane (oblique
orthographic for tilted parallel origins, perspective for point origins; `originProjector`).
1. **Candidates** (CPU, shared, per origin): visible faces in front of it whose image overlaps the
   shape, with a slope-scaled depth bias, flat normal and UV corners.
2. **Depth map** per origin. WebGPU: a depth-only pass (`depth32float`). CPU: a z-buffer.
3. **UV pass** per origin: each candidate rasterized in atlas space at texel centres; a texel takes
   its surface point, projects it, samples the shape, keeps it only if it is the first hit (within
   bias), and fades by facing. WebGPU: one pass per origin into its own layer of an array texture,
   then a combine pass keeping the strongest layer per texel (the first on a tie, the CPU rule);
   one readback.
4. **Gutter dilation** (CPU, shared): 2 texels into texels no face owns.
5. **Commit**: source-over onto the layer (clipped to a selection), `commitRegion`.
WebGPU runs when the 2D view does (`ed.gpuCompositor`), on its device; any failure falls back to
the CPU.

## Tests
- `test/projection.test.mjs`: projector math, stacked planes (only the top one), partial cover,
  multi-object, hidden / moved objects, grazing, opacity / AA, dilation, depth map, undo.
- `test/projection-object.test.mjs`: Euler order and presets (direction, image axes, round trip),
  View alignment vs the camera, gimbal axes, gizmo arrow and ring drags (with snapping) and hit
  tests, preset ↔ rotation fields, persistence, firing from a placed projector (lid protects the
  floor), point-source footprint (×2 at twice the distance), several origins (box sides covered,
  1 point = single), occlusion against every origin, aligned-to-view point source = camera.
- `test/browser/projection-parity.html`: GPU vs CPU on ten scenes (camera, axis, point, 3–6
  origins, custom rotations, hidden / moved objects). Tolerance: under 1% of texels off by more
  than 24 in alpha, mean |Δalpha| < 1, under 0.2% off in colour; and no paint under the lid.
- `test/browser/projection-view.html`: the 3D view end to end, WebGL (CPU) and WebGPU (GPU):
  placing by a click, presets, aligned to view, point, 4 origins, hidden lid, decal while dragging,
  one history step, exact undo, gizmo arrow drag (Shift snap) and ring drag (snap to 45°), surface
  mode unchanged.
- `test/browser/projector-fields.html`: typing, wrap, bad text, presets, scrubbing with Shift,
  Tab order, mode-only fields.

## Limits
- The drag preview is the centre origin only and has no occlusion; the paint on release is right.
- Parallel rays have no start: surfaces on the projector's back side along the ray line count too
  (the first one along the firing direction gets paint). Point origins only see what is in front of
  the source.
- Translate arrows are world-axis only (no local orientation), no free (view) rotation ring.
- The gizmo is drawn on a 2D overlay, so it is always on top of the model.
- Faces sharing UV space both get paint where both are visible; axis images cap at 4096 px.
- Brush strokes and Line / Curve are not projected.
