// Element types: how each kind of label element measures and draws itself.
// All geometry is in document (printer-pixel) coordinates; drawing functions
// receive a ctx already scaled so they can draw in doc coordinates directly.

import { floydSteinberg, threshold } from "./dither.js";
import { isLoaded } from "./fonts.js";

let nextId = 1;
export function newId() {
  return String(nextId++);
}

export function seedIds(elements) {
  const max = Math.max(0, ...elements.map((e) => Number(e.id) || 0));
  nextId = max + 1;
}

// Bold/italic are synthesized by hand: fonts arrive via the FontFace API as
// single faces, so canvas "bold"/"italic" font specs silently fall back to
// the regular face (2D canvas doesn't synthesize styles). Instead: bold =
// stroke the glyphs with a weight-proportional line, italic = skew around
// the baseline. Pure canvas drawing, so preview and print stay identical.
const ITALIC_SLANT = 0.21; // ~12 degrees

function fontSpec(el) {
  return `${el.fontPx}px "${el.fontId}"`;
}

function boldStrokePx(el) {
  return el.bold ? Math.max(1, el.fontPx / 24) : 0;
}

// ---- measuring ------------------------------------------------------------

const measureCtx = document.createElement("canvas").getContext("2d");

export function measure(el) {
  if (el.type === "text") {
    measureCtx.font = fontSpec(el);
    const m = measureCtx.measureText(el.text || " ");
    let ascent = m.actualBoundingBoxAscent;
    let descent = m.actualBoundingBoxDescent;
    let left = m.actualBoundingBoxLeft;
    let right = m.actualBoundingBoxRight;
    // Faux-bold stroke thickens ink by lw/2 in every direction; faux-italic
    // skew pushes the above-baseline part right and below-baseline part left.
    const lw = boldStrokePx(el);
    ascent += lw / 2;
    descent += lw / 2;
    left += lw / 2;
    right += lw / 2;
    if (el.italic) {
      left += ITALIC_SLANT * descent;
      right += ITALIC_SLANT * ascent;
    }
    return {
      x: el.x, y: el.y,
      w: Math.max(1, left + right),
      h: Math.max(1, ascent + descent),
      ascent, left,
    };
  }
  // image / icon: explicit box
  return { x: el.x, y: el.y, w: el.w, h: el.h };
}

// Fit a text element's font size to a target ink height, optionally also
// capped by a maximum ink width (fixed-length labels). Mirrors the CLI's
// auto-fit: measure at a reference size, scale by the tighter constraint.
export function autoFitFontPx(el, targetH, maxW = Infinity) {
  const probe = { ...el, fontPx: 100 };
  const m = measure(probe);
  const scale = Math.min(targetH / m.h, maxW / m.w);
  return Math.max(4, Math.floor(100 * scale));
}

// ---- drawing --------------------------------------------------------------

export function draw(ctx, el) {
  if (el.type === "text") {
    if (!isLoaded(el.fontId)) return; // will re-render once loaded
    const m = measure(el);
    const penX = el.x + m.left;
    const baseY = el.y + m.ascent;
    ctx.save();
    ctx.font = fontSpec(el);
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    if (el.italic) {
      // Skew around the baseline: x' = x - SLANT*(y - baseY), baseline fixed.
      ctx.transform(1, 0, -ITALIC_SLANT, 1, ITALIC_SLANT * baseY, 0);
    }
    ctx.fillText(el.text, penX, baseY);
    const lw = boldStrokePx(el);
    if (lw) {
      ctx.strokeStyle = "#000";
      ctx.lineWidth = lw;
      ctx.lineJoin = "round";
      ctx.strokeText(el.text, penX, baseY);
    }
    ctx.restore();
  } else if ((el.type === "image" || el.type === "icon") && el._bitmap) {
    // Multiply: ink accumulates. The bitmap's white background multiplies to
    // identity, so an element's bounding box doesn't erase what's under it.
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(el._bitmap, el.x, el.y, el.w, el.h);
    ctx.restore();
  }
}

export function makeText(text, fontId, x, y, fontPx = 48) {
  return { id: newId(), type: "text", text, fontId, fontPx, autoSize: true, bold: false, italic: false, x, y };
}

export function makeImage(dataUrl, w, h, x, y) {
  return { id: newId(), type: "image", dataUrl, w, h, x, y, mode: "dither", threshold: 128 };
}

// Icons are image elements with a vector (SVG data-URL) source: the browser
// re-rasterizes the SVG at whatever size it's drawn, so resizing stays crisp
// and the whole image bitmap/dither pipeline is reused unchanged. Threshold
// default suits line art; 160 keeps antialiased stroke edges from thinning.
export function makeIcon(name, svg, size, x, y) {
  const dataUrl = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  return { id: newId(), type: "icon", name, dataUrl, w: size, h: size, x, y, mode: "threshold", threshold: 160 };
}

// ---- image element bitmap cache --------------------------------------------
// Each image element carries a pre-dithered pure-B/W bitmap at its current
// size. Because it's already 1-bpp, the print canvas's global threshold pass
// leaves it untouched — the dithering you see in the preview is exactly what
// prints. Rebuilt whenever size/mode/level/source change.

function imageSig(el) {
  return `${el.w}x${el.h}|${el.mode}|${el.threshold}|${el.dataUrl.length}`;
}

export function ensureImageBitmap(el, onReady) {
  const sig = imageSig(el);
  if (el._sig === sig) return;
  el._sig = sig;

  const build = () => {
    const c = document.createElement("canvas");
    c.width = Math.max(1, el.w);
    c.height = Math.max(1, el.h);
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(el._img, 0, 0, c.width, c.height);
    const data = ctx.getImageData(0, 0, c.width, c.height);
    (el.mode === "dither" ? floydSteinberg : threshold)(data, el.threshold);
    ctx.putImageData(data, 0, 0);
    el._bitmap = c;
    onReady();
  };

  if (el._img && el._img._src === el.dataUrl) {
    build();
  } else {
    const img = new Image();
    img.onload = () => {
      img._src = el.dataUrl;
      el._img = img;
      build();
    };
    img.src = el.dataUrl;
  }
}
