// One shared WebGPU device for the app. Resolves to null (never throws) when WebGPU is not usable,
// so callers can fall back. Later phases (3D view, filters) share this same device.
let pending = null;
let current = null;
const lostListeners = new Set();

/** { adapter, device, format } or null. Cached; a lost device is dropped so the next call retries once. */
export function getGPU() {
  if (current) return Promise.resolve(current);
  if (pending) return pending;
  pending = (async () => {
    const gpu = typeof navigator !== 'undefined' ? navigator.gpu : null;
    if (!gpu) return null;
    try {
      const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      const device = await adapter.requestDevice();
      const format = gpu.getPreferredCanvasFormat();
      current = { adapter, device, format, hasGPU: true };
      device.lost.then((info) => {
        console.warn('WebGPU device lost:', info?.message || info?.reason);
        if (current?.device === device) current = null;
        for (const fn of lostListeners) { try { fn(info); } catch (err) { console.error(err); } }
      });
      device.addEventListener?.('uncapturederror', (e) => console.error('WebGPU error:', e.error?.message || e.error));
      return current;
    } catch (err) {
      console.warn('WebGPU unavailable:', err);
      return null;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

/** Called with the loss info when the shared device is lost. Returns an unsubscribe function. */
export function onDeviceLost(fn) { lostListeners.add(fn); return () => lostListeners.delete(fn); }
