// One mesh, several image tabs. The first image is the unwrap. Later images stack
// on top of it in UV space, each still its own document.

export function beginSession(doc, mount) {
  const session = { mount, members: [] };
  joinSession(session, doc);
  doc.atlas = true;
  return session;
}

export function joinSession(session, doc, place = { u: 0, v: 0, w: 1, h: 1 }) {
  doc.session = session;
  doc.mount = session.mount;
  doc.place = place;
  if (!session.members.includes(doc)) session.members.push(doc);
}

/** Drop this image off the model. The mesh stays with whatever images remain. */
export function leaveSession(doc) {
  const session = doc.session;
  doc.session = null;
  doc.place = null;
  doc.atlas = false;
  doc.mount = null;
  if (!session) return null;
  session.members = session.members.filter((d) => d !== doc);
  return session.members.length ? session : null;
}

export function retarget(session, mount) {
  session.mount = mount;
  for (const doc of session.members) doc.mount = mount;
}

/** UV (0–1, v down) → pixel on this image, or null if the hit misses its rectangle. */
export function placeToPixel(doc, u, v) {
  const p = doc.place || { u: 0, v: 0, w: 1, h: 1 };
  if (p.w <= 0 || p.h <= 0) return null;
  if (u < p.u || v < p.v || u > p.u + p.w || v > p.v + p.h) return null;
  return {
    x: ((u - p.u) / p.w) * doc.width,
    y: ((v - p.v) / p.h) * doc.height,
  };
}
