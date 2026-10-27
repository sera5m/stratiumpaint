// Which renderer draws the main 2D view. Pure functions so the choice is testable in node.
//
// The WebGPU renderer is experimental and OFF unless asked for:
//   - URL query      ?renderer=webgpu   (or ?renderer=canvas to force the old path)
//   - localStorage   stratum.renderer = 'webgpu' | 'canvas'
//   - Electron       start with --webgpu (or STRATUM_WEBGPU=1); main.cjs adds the Chromium
//                    switches Linux needs and passes ?renderer=webgpu to the page.
// Anything missing (no navigator.gpu, no adapter, device creation fails, document larger than the
// GPU allows, device lost later) falls back to the Canvas 2D renderer, which stays the default.

export const RENDERERS = ['canvas', 'webgpu'];
export const STORAGE_KEY = 'stratum.renderer';

/** The renderer the user asked for: 'webgpu' or 'canvas' (default). URL beats storage. */
export function requestedRenderer({ search = '', storage = null } = {}) {
  let q = null;
  try { q = new URLSearchParams(search).get('renderer'); } catch { q = null; }
  if (RENDERERS.includes(q)) return q;
  let saved = null;
  try { saved = storage?.getItem?.(STORAGE_KEY) ?? null; } catch { saved = null; }
  return RENDERERS.includes(saved) ? saved : 'canvas';
}

/**
 * Final choice once we know what the platform offers.
 * env: { requested, hasGPU (navigator.gpu exists), adapter (bool), device (bool),
 *        maxTexture (device limit), docSize (largest side of the open document), failed (bool) }
 * Returns { renderer: 'webgpu'|'canvas', reason }.
 */
export function chooseRenderer(env = {}) {
  const { requested = 'canvas', hasGPU = false, adapter = false, device = false, maxTexture = 0, docSize = 0, failed = false } = env;
  if (requested !== 'webgpu') return { renderer: 'canvas', reason: 'default' };
  if (failed) return { renderer: 'canvas', reason: 'webgpu failed earlier this session' };
  if (!hasGPU) return { renderer: 'canvas', reason: 'navigator.gpu is missing' };
  if (!adapter) return { renderer: 'canvas', reason: 'no WebGPU adapter' };
  if (!device) return { renderer: 'canvas', reason: 'could not create a WebGPU device' };
  if (docSize > 0 && maxTexture > 0 && docSize > maxTexture) return { renderer: 'canvas', reason: `document is larger than the GPU limit (${maxTexture}px)` };
  return { renderer: 'webgpu', reason: 'ok' };
}
