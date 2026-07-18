// Named-document library: saved label designs in localStorage, separate from
// the live working copy (`d30doc`) and device calibration (`d30cal`).
// Export/import wraps a document in a versioned envelope for .d30.json files.

const LIB_KEY = "d30library";
export const EXPORT_FORMAT = "d30-label";
export const KNOWN_TYPES = new Set(["text", "image", "icon", "shape", "pencil", "qr", "barcode"]);

export function loadLibrary() {
  try {
    const lib = JSON.parse(localStorage.getItem(LIB_KEY));
    if (lib?.version === 1 && lib.docs) return lib;
  } catch {
    /* corrupted: start a fresh library */
  }
  return { version: 1, docs: {} };
}

export function saveLibrary(lib) {
  localStorage.setItem(LIB_KEY, JSON.stringify(lib));
}

export function listDocs(lib) {
  return Object.entries(lib.docs)
    .map(([id, d]) => ({ id, name: d.name, updatedAt: d.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function upsertDoc(lib, id, name, doc) {
  const docId = id ?? `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  lib.docs[docId] = { name, updatedAt: Date.now(), doc };
  saveLibrary(lib);
  return docId;
}

export function deleteDoc(lib, id) {
  delete lib.docs[id];
  saveLibrary(lib);
}

export function exportEnvelope(doc, appVersion) {
  return JSON.stringify(
    { format: EXPORT_FORMAT, version: 1, app: appVersion, doc },
    null,
    2
  );
}

/**
 * Parse an exported file. Returns { doc, dropped } where dropped counts
 * elements of unknown type (forward compatibility: newer exports load with
 * their unknown elements stripped rather than failing).
 * Throws with a readable message on invalid input.
 */
export function parseEnvelope(text) {
  const env = JSON.parse(text);
  if (env?.format !== EXPORT_FORMAT || !env.doc?.elements) {
    throw new Error("not a d30 label file");
  }
  const total = env.doc.elements.length;
  env.doc.elements = env.doc.elements.filter((e) => KNOWN_TYPES.has(e.type));
  return { doc: env.doc, dropped: total - env.doc.elements.length };
}
