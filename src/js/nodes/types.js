// Node catalogue for the compositor. Sockets are value | color | vector | image.
// Kinds convert on their own: a number fills an image, an image used as a number is its average.
// This is a raster compositor plus texture nodes, not a path tracer. Shader BSDFs, movie
// clips, render layers, cryptomatte, tracking and physical defocus are intentionally absent.

export const CATEGORIES = [
  ['input', 'Input', '#6aa2ff'],
  ['output', 'Output', '#e2a24a'],
  ['color', 'Color', '#d46ad4'],
  ['converter', 'Converter', '#5ec8c4'],
  ['texture', 'Texture', '#7dba5a'],
  ['filter', 'Filter', '#e06a6a'],
  ['transform', 'Transform', '#d4a24a'],
  ['matte', 'Matte', '#8a84e0'],
  ['layout', 'Layout', '#8b919c'],
];

const num = (id, label, def, min, max, step = 0.01) => ({ id, label, type: 'number', default: def, min, max, step });
const sel = (id, label, def, options) => ({ id, label, type: 'select', default: def, options });
const txt = (id, label, def) => ({ id, label, type: 'text', default: def });
const col = (id, label, r, g, b, a = 1) => ({ id, label, type: 'color', default: { r, g, b, a } });
const bool = (id, label, def = false) => ({ id, label, type: 'bool', default: def });

const sock = (id, name, kind) => ({ id, name, kind });

export const NODE_TYPES = {
  value: {
    category: 'input', label: 'Value',
    inputs: [], outputs: [sock('value', 'Value', 'value')],
    params: [num('value', 'Value', 0.5, -1000, 1000, 0.01)],
  },
  rgb: {
    category: 'input', label: 'RGB',
    inputs: [], outputs: [sock('color', 'Color', 'color')],
    params: [col('color', 'Color', 0.8, 0.2, 0.15, 1)],
  },
  image: {
    category: 'input', label: 'Image',
    inputs: [], outputs: [sock('image', 'Image', 'image')],
    params: [
      sel('source', 'Source', 'active', [['active', 'Active layer'], ['index', 'Layer index']]),
      num('index', 'Layer', 0, 0, 64, 1),
    ],
  },
  texcoord: {
    category: 'input', label: 'Texture Coordinate',
    inputs: [], outputs: [sock('uv', 'UV', 'image'), sock('u', 'U', 'value'), sock('v', 'V', 'value')],
    params: [],
  },
  time: {
    category: 'input', label: 'Time',
    inputs: [], outputs: [sock('value', 'Time', 'value')],
    params: [],
  },
  viewer: {
    category: 'output', label: 'Viewer',
    inputs: [sock('image', 'Image', 'image')], outputs: [sock('image', 'Image', 'image')],
    params: [],
  },
  composite: {
    category: 'output', label: 'Composite',
    inputs: [sock('image', 'Image', 'image')], outputs: [sock('image', 'Image', 'image')],
    params: [],
  },
  mix: {
    category: 'color', label: 'Mix',
    inputs: [sock('fac', 'Fac', 'value'), sock('a', 'A', 'color'), sock('b', 'B', 'color')],
    outputs: [sock('color', 'Color', 'color')],
    params: [
      sel('mode', 'Mode', 'mix', [
        ['mix', 'Mix'], ['add', 'Add'], ['subtract', 'Subtract'], ['multiply', 'Multiply'],
        ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten'],
        ['difference', 'Difference'], ['divide', 'Divide'], ['hue', 'Hue'], ['saturation', 'Saturation'],
        ['color', 'Color'], ['luminosity', 'Luminosity'],
      ]),
      num('fac', 'Fac', 1, 0, 1, 0.01),
    ],
  },
  brightcontrast: {
    category: 'color', label: 'Bright / Contrast',
    inputs: [sock('color', 'Color', 'color'), sock('bright', 'Bright', 'value'), sock('contrast', 'Contrast', 'value')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('bright', 'Bright', 0, -1, 1, 0.01), num('contrast', 'Contrast', 0, -1, 4, 0.01)],
  },
  gamma: {
    category: 'color', label: 'Gamma',
    inputs: [sock('color', 'Color', 'color'), sock('gamma', 'Gamma', 'value')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('gamma', 'Gamma', 1, 0.01, 10, 0.01)],
  },
  exposure: {
    category: 'color', label: 'Exposure',
    inputs: [sock('color', 'Color', 'color'), sock('exposure', 'Exposure', 'value')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('exposure', 'Exposure', 0, -8, 8, 0.01)],
  },
  invert: {
    category: 'color', label: 'Invert',
    inputs: [sock('fac', 'Fac', 'value'), sock('color', 'Color', 'color')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('fac', 'Fac', 1, 0, 1, 0.01)],
  },
  hsv: {
    category: 'color', label: 'Hue Saturation Value',
    inputs: [sock('color', 'Color', 'color'), sock('hue', 'Hue', 'value'), sock('sat', 'Sat', 'value'), sock('val', 'Val', 'value')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('hue', 'Hue', 0.5, 0, 1, 0.01), num('sat', 'Saturation', 1, 0, 4, 0.01), num('val', 'Value', 1, 0, 4, 0.01)],
  },
  alphaover: {
    category: 'color', label: 'Alpha Over',
    inputs: [sock('fac', 'Fac', 'value'), sock('bg', 'Background', 'color'), sock('fg', 'Foreground', 'color')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('fac', 'Fac', 1, 0, 1, 0.01)],
  },
  setalpha: {
    category: 'color', label: 'Set Alpha',
    inputs: [sock('color', 'Color', 'color'), sock('alpha', 'Alpha', 'value')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('alpha', 'Alpha', 1, 0, 1, 0.01)],
  },
  separatecolor: {
    category: 'color', label: 'Separate Color',
    inputs: [sock('color', 'Color', 'color')],
    outputs: [sock('r', 'R', 'value'), sock('g', 'G', 'value'), sock('b', 'B', 'value'), sock('a', 'A', 'value')],
    params: [sel('mode', 'Mode', 'rgb', [['rgb', 'RGB'], ['hsv', 'HSV']])],
  },
  combinecolor: {
    category: 'color', label: 'Combine Color',
    inputs: [sock('r', 'R', 'value'), sock('g', 'G', 'value'), sock('b', 'B', 'value'), sock('a', 'A', 'value')],
    outputs: [sock('color', 'Color', 'color')],
    params: [sel('mode', 'Mode', 'rgb', [['rgb', 'RGB'], ['hsv', 'HSV']]), num('a', 'Alpha', 1, 0, 1, 0.01)],
  },
  colorramp: {
    category: 'color', label: 'Color Ramp',
    inputs: [sock('fac', 'Fac', 'value')],
    outputs: [sock('color', 'Color', 'color'), sock('alpha', 'Alpha', 'value')],
    params: [txt('stops', 'Stops', '0 #000000, 1 #ffffff')],
  },
  curves: {
    category: 'color', label: 'Curves',
    inputs: [sock('color', 'Color', 'color')],
    outputs: [sock('color', 'Color', 'color')],
    params: [txt('curve', 'Curve', '0,0 1,1')],
  },
  colorbalance: {
    category: 'color', label: 'Color Balance',
    inputs: [sock('color', 'Color', 'color')],
    outputs: [sock('color', 'Color', 'color')],
    params: [num('lift', 'Lift', 0, -1, 1, 0.01), num('gamma', 'Gamma', 1, 0.01, 4, 0.01), num('gain', 'Gain', 1, 0, 4, 0.01)],
  },
  rgb2bw: {
    category: 'color', label: 'RGB to BW',
    inputs: [sock('color', 'Color', 'color')],
    outputs: [sock('value', 'Value', 'value')],
    params: [],
  },
  math: {
    category: 'converter', label: 'Math',
    inputs: [sock('a', 'A', 'value'), sock('b', 'B', 'value'), sock('c', 'C', 'value')],
    outputs: [sock('value', 'Value', 'value')],
    params: [sel('op', 'Operation', 'add', [
      ['add', 'Add'], ['subtract', 'Subtract'], ['multiply', 'Multiply'], ['divide', 'Divide'],
      ['power', 'Power'], ['log', 'Log'], ['sqrt', 'Square Root'], ['abs', 'Absolute'],
      ['min', 'Minimum'], ['max', 'Maximum'], ['round', 'Round'], ['floor', 'Floor'], ['ceil', 'Ceil'],
      ['fract', 'Fraction'], ['modulo', 'Modulo'], ['snap', 'Snap'], ['pingpong', 'Ping-Pong'],
      ['sin', 'Sine'], ['cos', 'Cosine'], ['tan', 'Tangent'], ['asin', 'Arcsine'], ['acos', 'Arccosine'],
      ['atan', 'Arctangent'], ['atan2', 'Arctan2'], ['sinh', 'Hyperbolic Sine'], ['sign', 'Sign'],
      ['smoothmin', 'Smooth Minimum'], ['clamp', 'Clamp'], ['compare', 'Less Than'],
    ])],
  },
  maprange: {
    category: 'converter', label: 'Map Range',
    inputs: [sock('value', 'Value', 'value')],
    outputs: [sock('value', 'Value', 'value')],
    params: [
      num('fromMin', 'From Min', 0, -1000, 1000), num('fromMax', 'From Max', 1, -1000, 1000),
      num('toMin', 'To Min', 0, -1000, 1000), num('toMax', 'To Max', 1, -1000, 1000),
      bool('clamp', 'Clamp', true),
    ],
  },
  clamp: {
    category: 'converter', label: 'Clamp',
    inputs: [sock('value', 'Value', 'value')],
    outputs: [sock('value', 'Value', 'value')],
    params: [num('min', 'Min', 0, -1000, 1000), num('max', 'Max', 1, -1000, 1000)],
  },
  formula: {
    category: 'converter', label: 'Formula',
    inputs: [sock('a', 'A', 'color'), sock('b', 'B', 'value'), sock('c', 'C', 'value')],
    outputs: [sock('value', 'Value', 'value')],
    params: [txt('latex', 'LaTeX', '\\frac{u + v}{2}')],
  },
  switch: {
    category: 'converter', label: 'Switch',
    inputs: [sock('fac', 'Switch', 'value'), sock('a', 'Off', 'color'), sock('b', 'On', 'color')],
    outputs: [sock('out', 'Output', 'color')],
    params: [num('fac', 'Switch', 0, 0, 1, 0.01)],
  },
  compare: {
    category: 'converter', label: 'Compare',
    inputs: [sock('a', 'A', 'value'), sock('b', 'B', 'value')],
    outputs: [sock('value', 'Value', 'value')],
    params: [
      sel('op', 'Operation', 'greater', [['less', 'Less Than'], ['greater', 'Greater Than'], ['equal', 'Equal'], ['notequal', 'Not Equal']]),
      num('epsilon', 'Epsilon', 0.001, 0, 1, 0.0001),
    ],
  },
  separatexyz: {
    category: 'converter', label: 'Separate XYZ',
    inputs: [sock('vector', 'Vector', 'vector')],
    outputs: [sock('x', 'X', 'value'), sock('y', 'Y', 'value'), sock('z', 'Z', 'value')],
    params: [],
  },
  combinexyz: {
    category: 'converter', label: 'Combine XYZ',
    inputs: [sock('x', 'X', 'value'), sock('y', 'Y', 'value'), sock('z', 'Z', 'value')],
    outputs: [sock('vector', 'Vector', 'vector')],
    params: [num('x', 'X', 0, -1000, 1000), num('y', 'Y', 0, -1000, 1000), num('z', 'Z', 0, -1000, 1000)],
  },
  vectormath: {
    category: 'converter', label: 'Vector Math',
    inputs: [sock('a', 'A', 'vector'), sock('b', 'B', 'vector'), sock('scale', 'Scale', 'value')],
    outputs: [sock('vector', 'Vector', 'vector'), sock('value', 'Value', 'value')],
    params: [sel('op', 'Operation', 'add', [
      ['add', 'Add'], ['subtract', 'Subtract'], ['multiply', 'Multiply'], ['divide', 'Divide'],
      ['cross', 'Cross Product'], ['dot', 'Dot Product'], ['normalize', 'Normalize'], ['length', 'Length'], ['scale', 'Scale'],
    ])],
  },
  noise: {
    category: 'texture', label: 'Noise',
    inputs: [sock('vector', 'Vector', 'vector'), sock('scale', 'Scale', 'value')],
    outputs: [sock('color', 'Color', 'color'), sock('fac', 'Fac', 'value')],
    params: [num('scale', 'Scale', 5, 0.01, 200, 0.1), num('detail', 'Detail', 4, 1, 8, 1), num('seed', 'Seed', 0, 0, 999, 1)],
  },
  voronoi: {
    category: 'texture', label: 'Voronoi',
    inputs: [sock('vector', 'Vector', 'vector')],
    outputs: [sock('distance', 'Distance', 'value'), sock('color', 'Color', 'color')],
    params: [num('scale', 'Scale', 5, 0.01, 200, 0.1), num('seed', 'Seed', 0, 0, 999, 1)],
  },
  wave: {
    category: 'texture', label: 'Wave',
    inputs: [sock('vector', 'Vector', 'vector')],
    outputs: [sock('color', 'Color', 'color'), sock('fac', 'Fac', 'value')],
    params: [
      sel('kind', 'Type', 'bands', [['bands', 'Bands'], ['rings', 'Rings']]),
      num('scale', 'Scale', 8, 0.01, 200, 0.1), num('phase', 'Phase', 0, -10, 10, 0.01),
    ],
  },
  checker: {
    category: 'texture', label: 'Checker',
    inputs: [sock('vector', 'Vector', 'vector'), sock('color1', 'Color 1', 'color'), sock('color2', 'Color 2', 'color')],
    outputs: [sock('color', 'Color', 'color'), sock('fac', 'Fac', 'value')],
    params: [num('scale', 'Scale', 8, 0.1, 200, 0.1), col('color1', 'Color 1', 0.05, 0.05, 0.05, 1), col('color2', 'Color 2', 0.85, 0.85, 0.88, 1)],
  },
  gradient: {
    category: 'texture', label: 'Gradient',
    inputs: [sock('vector', 'Vector', 'vector')],
    outputs: [sock('color', 'Color', 'color'), sock('fac', 'Fac', 'value')],
    params: [sel('kind', 'Type', 'linear', [['linear', 'Linear'], ['radial', 'Quadratic / Radial'], ['diagonal', 'Diagonal']])],
  },
  brick: {
    category: 'texture', label: 'Brick',
    inputs: [sock('vector', 'Vector', 'vector'), sock('color1', 'Brick', 'color'), sock('color2', 'Mortar', 'color')],
    outputs: [sock('color', 'Color', 'color'), sock('fac', 'Fac', 'value')],
    params: [
      num('scale', 'Scale', 6, 0.5, 80, 0.1), num('mortar', 'Mortar', 0.08, 0, 0.4, 0.01),
      col('color1', 'Brick', 0.55, 0.18, 0.12, 1), col('color2', 'Mortar', 0.75, 0.75, 0.72, 1),
    ],
  },
  whitenoise: {
    category: 'texture', label: 'White Noise',
    inputs: [sock('vector', 'Vector', 'vector')],
    outputs: [sock('color', 'Color', 'color'), sock('value', 'Value', 'value')],
    params: [num('seed', 'Seed', 0, 0, 999, 1)],
  },
  blur: {
    category: 'filter', label: 'Blur',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [num('radius', 'Size', 4, 0, 32, 0.5)],
  },
  sharpen: {
    category: 'filter', label: 'Sharpen',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [num('amount', 'Amount', 0.5, 0, 4, 0.05), num('radius', 'Size', 1, 0, 8, 0.5)],
  },
  pixelate: {
    category: 'filter', label: 'Pixelate',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [num('cells', 'Cells', 16, 1, 256, 1)],
  },
  glare: {
    category: 'filter', label: 'Glare',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [num('threshold', 'Threshold', 0.7, 0, 1, 0.01), num('size', 'Size', 6, 0, 32, 0.5), num('mix', 'Mix', 0.6, 0, 2, 0.01)],
  },
  dilate: {
    category: 'filter', label: 'Dilate / Erode',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [sel('mode', 'Mode', 'dilate', [['dilate', 'Dilate'], ['erode', 'Erode']]), num('radius', 'Distance', 1, 0, 5, 1)],
  },
  transform: {
    category: 'transform', label: 'Transform',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [
      num('x', 'X', 0, -2, 2, 0.01), num('y', 'Y', 0, -2, 2, 0.01),
      num('angle', 'Angle', 0, -360, 360, 1), num('scale', 'Scale', 1, 0.01, 8, 0.01),
    ],
  },
  flip: {
    category: 'transform', label: 'Flip',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [bool('x', 'Flip X', true), bool('y', 'Flip Y', false)],
  },
  crop: {
    category: 'transform', label: 'Crop',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image')],
    params: [num('x', 'X', 0, 0, 1, 0.01), num('y', 'Y', 0, 0, 1, 0.01), num('w', 'Width', 1, 0, 1, 0.01), num('h', 'Height', 1, 0, 1, 0.01)],
  },
  displace: {
    category: 'transform', label: 'Displace',
    inputs: [sock('image', 'Image', 'image'), sock('vector', 'Vector', 'vector')],
    outputs: [sock('image', 'Image', 'image')],
    params: [num('strength', 'Scale', 0.1, -2, 2, 0.01)],
  },
  boxmask: {
    category: 'matte', label: 'Box Mask',
    inputs: [], outputs: [sock('mask', 'Mask', 'value')],
    params: [num('x', 'X', 0.5, 0, 1, 0.01), num('y', 'Y', 0.5, 0, 1, 0.01), num('w', 'Width', 0.5, 0, 2, 0.01), num('h', 'Height', 0.5, 0, 2, 0.01), num('soft', 'Softness', 0, 0, 1, 0.01)],
  },
  ellipsemask: {
    category: 'matte', label: 'Ellipse Mask',
    inputs: [], outputs: [sock('mask', 'Mask', 'value')],
    params: [num('x', 'X', 0.5, 0, 1, 0.01), num('y', 'Y', 0.5, 0, 1, 0.01), num('w', 'Width', 0.6, 0, 2, 0.01), num('h', 'Height', 0.6, 0, 2, 0.01), num('soft', 'Softness', 0, 0, 1, 0.01)],
  },
  chromakey: {
    category: 'matte', label: 'Chroma Key',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image'), sock('matte', 'Matte', 'value')],
    params: [col('key', 'Key', 0, 1, 0, 1), num('threshold', 'Threshold', 0.25, 0, 2, 0.01), num('soft', 'Falloff', 0.1, 0, 1, 0.01)],
  },
  lumakey: {
    category: 'matte', label: 'Luminance Key',
    inputs: [sock('image', 'Image', 'image')],
    outputs: [sock('image', 'Image', 'image'), sock('matte', 'Matte', 'value')],
    params: [num('low', 'Low', 0.2, 0, 1, 0.01), num('high', 'High', 0.8, 0, 1, 0.01), num('soft', 'Falloff', 0.05, 0, 1, 0.01)],
  },
  frame: { category: 'layout', label: 'Frame', inputs: [], outputs: [], params: [num('w', 'Width', 280, 40, 4000, 1), num('h', 'Height', 180, 40, 4000, 1), txt('title', 'Title', 'Frame')] },
  reroute: { category: 'layout', label: 'Reroute', inputs: [sock('in', '', 'value')], outputs: [sock('out', '', 'value')], params: [] },
  group: { category: 'layout', label: 'Group', inputs: [], outputs: [], params: [txt('title', 'Title', 'Group')] },
  group_in: { category: 'layout', label: 'Group Input', inputs: [], outputs: [], params: [] },
  group_out: { category: 'layout', label: 'Group Output', inputs: [], outputs: [], params: [] },
};

export const ADDABLE = Object.entries(NODE_TYPES)
  .filter(([id]) => id !== 'group_in' && id !== 'group_out')
  .map(([id, t]) => ({ id, ...t }));

export function categoryColor(id) {
  return CATEGORIES.find((c) => c[0] === id)?.[2] || '#888';
}

export function defaultParams(type) {
  const params = {};
  for (const f of NODE_TYPES[type]?.params || []) {
    params[f.id] = f.type === 'color' && f.default ? { ...f.default } : f.default;
  }
  return params;
}

/** Sockets actually drawn and linked. Groups and reroutes derive theirs. */
export function socketsOf(node) {
  if (!node) return { inputs: [], outputs: [] };
  if (node.type === 'group') {
    const inner = node.params?.graph;
    const gin = inner?.nodes?.find((n) => n.type === 'group_in');
    const gout = inner?.nodes?.find((n) => n.type === 'group_out');
    return {
      inputs: (gin?.params?.sockets || []).map((s) => ({ ...s })),
      outputs: (gout?.params?.sockets || []).map((s) => ({ ...s })),
    };
  }
  if (node.type === 'group_in') return { inputs: [], outputs: (node.params?.sockets || []).map((s) => ({ ...s })) };
  if (node.type === 'group_out') return { inputs: (node.params?.sockets || []).map((s) => ({ ...s })), outputs: [] };
  if (node.type === 'reroute') {
    const kind = node.params?.kind || 'value';
    return { inputs: [sock('in', '', kind)], outputs: [sock('out', '', kind)] };
  }
  const t = NODE_TYPES[node.type];
  return { inputs: t?.inputs || [], outputs: t?.outputs || [] };
}

export function socketKind(node, dir, id) {
  const list = dir === 'in' ? socketsOf(node).inputs : socketsOf(node).outputs;
  return list.find((s) => s.id === id)?.kind || 'value';
}
