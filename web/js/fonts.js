// System font access: list from the server, load on demand via FontFace.
// Each font is registered under a synthetic unique family name equal to its
// server id, so canvas code just does `ctx.font = `${px}px "${id}"``.

let fontList = null;
const loaded = new Set();
const loading = new Map();

export async function listFonts() {
  if (!fontList) {
    const res = await fetch("/api/fonts");
    fontList = await res.json();
  }
  return fontList;
}

export function isLoaded(id) {
  return loaded.has(id);
}

export async function loadFont(id) {
  if (loaded.has(id)) return;
  if (loading.has(id)) return loading.get(id);
  const promise = (async () => {
    const face = new FontFace(id, `url(/api/fonts/${encodeURIComponent(id)}/file)`);
    await face.load();
    document.fonts.add(face);
    loaded.add(id);
    loading.delete(id);
  })();
  loading.set(id, promise);
  return promise;
}

// A reasonable default: prefer DejaVu Sans Bold (what the CLI uses), then
// anything "sans" regular-ish, then the first font available.
export async function defaultFontId() {
  const fonts = await listFonts();
  const byId = (id) => fonts.find((f) => f.id === id);
  return (
    byId("dejavu-sans-bold")?.id ??
    fonts.find((f) => /sans/i.test(f.family) && /^(regular|book)$/i.test(f.style))?.id ??
    fonts[0]?.id ??
    null
  );
}
