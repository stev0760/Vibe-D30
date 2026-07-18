// Element types: how each kind of label element measures and draws itself.
// All geometry is in document (printer-pixel) coordinates; drawing functions
// receive a ctx already scaled so they can draw in doc coordinates directly.

import { floydSteinberg, threshold } from "./dither.js";
import { isLoaded } from "./fonts.js";
import { encode128 } from "./barcode128.js";
import qrcodegen from "./vendor/qrcodegen.js";

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
  if (el.type === "qr") {
    // Size snaps to a whole number of pixels per module so every module is
    // a crisp integer square (pure black, untouched by the threshold pass).
    const qr = ensureQrMatrix(el);
    const n = qr ? qr.size : 21;
    const scale = Math.max(1, Math.floor((el.size || n) / n));
    const s = n * scale;
    return { x: el.x, y: el.y, w: s, h: s };
  }
  if (el.type === "barcode") {
    // Width is derived: modules × module width (resize adjusts height only).
    const enc = ensureBarcode(el);
    const w = enc ? enc.modules * (el.moduleW || 2) : 120;
    return { x: el.x, y: el.y, w, h: el.h };
  }
  // image / icon / shape / pencil: explicit box
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
  } else if (el.type === "shape") {
    drawShape(ctx, el);
  } else if (el.type === "pencil") {
    drawPencil(ctx, el);
  } else if (el.type === "qr") {
    drawQr(ctx, el);
  } else if (el.type === "barcode") {
    drawBarcode(ctx, el);
  } else if ((el.type === "image" || el.type === "icon") && el._bitmap) {
    // Multiply: ink accumulates. The bitmap's white background multiplies to
    // identity, so an element's bounding box doesn't erase what's under it.
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.drawImage(el._bitmap, el.x, el.y, el.w, el.h);
    ctx.restore();
  }
}

// Shapes are pure black geometry: axis-aligned strokes land on whole pixels
// (crisp through the global threshold pass); diagonals antialias and then
// threshold exactly like glyph edges do.
function drawShape(ctx, el) {
  const lw = Math.max(1, el.strokeW || 1);
  ctx.save();
  ctx.fillStyle = "#000";
  ctx.strokeStyle = "#000";
  if (el.kind === "rect") {
    const r = Math.max(0, Math.min(el.radius || 0, el.w / 2, el.h / 2));
    if (el.fill) {
      ctx.beginPath();
      ctx.roundRect(el.x, el.y, el.w, el.h, r);
      ctx.fill();
    } else {
      // Stroke inset by half the line width so ink stays inside the bbox.
      ctx.lineWidth = Math.min(lw, el.w / 2, el.h / 2);
      ctx.beginPath();
      ctx.roundRect(el.x + lw / 2, el.y + lw / 2, Math.max(1, el.w - lw), Math.max(1, el.h - lw), r);
      ctx.stroke();
    }
  } else if (el.kind === "line") {
    // Degenerate bbox = crisp horizontal/vertical rule (the common case);
    // otherwise a corner-to-corner diagonal, mirrored by `flip`.
    if (el.h <= lw + 1) {
      ctx.fillRect(el.x, el.y + Math.round((el.h - lw) / 2), el.w, lw);
    } else if (el.w <= lw + 1) {
      ctx.fillRect(el.x + Math.round((el.w - lw) / 2), el.y, lw, el.h);
    } else {
      const inset = lw / 2;
      ctx.lineWidth = lw;
      ctx.lineCap = "round";
      ctx.beginPath();
      if (el.flip) {
        ctx.moveTo(el.x + el.w - inset, el.y + inset);
        ctx.lineTo(el.x + inset, el.y + el.h - inset);
      } else {
        ctx.moveTo(el.x + inset, el.y + inset);
        ctx.lineTo(el.x + el.w - inset, el.y + el.h - inset);
      }
      ctx.stroke();
    }
  }
  ctx.restore();
}

// Pencil strokes are vectors: points normalized 0..1 inside the element bbox,
// re-rendered at any size (resize stays crisp, edges threshold like glyphs).
function drawPencil(ctx, el) {
  if (!el.strokes?.length || !el.natW || !el.natH) return;
  const ws = (el.w / el.natW + el.h / el.natH) / 2; // width follows avg scale
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.fillStyle = "#000";
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const s of el.strokes) {
    const lw = Math.max(1, s.w * ws);
    const pts = s.pts;
    if (!pts.length) continue;
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(el.x + pts[0][0] * el.w, el.y + pts[0][1] * el.h, lw / 2, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(el.x + pts[0][0] * el.w, el.y + pts[0][1] * el.h);
    for (let i = 1; i < pts.length; i++) {
      ctx.lineTo(el.x + pts[i][0] * el.w, el.y + pts[i][1] * el.h);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Ramer–Douglas–Peucker polyline simplification (points in doc px).
export function simplifyStroke(pts, epsilon = 0.5) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = a + 1; i < b; i++) {
      const dist = Math.abs(dx * (ay - pts[i][1]) - (ax - pts[i][0]) * dy) / len;
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon) {
      keep[maxIdx] = 1;
      stack.push([a, maxIdx], [maxIdx, b]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---- QR / barcode -----------------------------------------------------------
// Both cache their computed matrix/encoding under `_`-prefixed fields (the
// serializer strips those) and draw pure-black integer-aligned fills, so the
// global 1-bpp threshold pass provably leaves them untouched.

const QR_ECC = {
  L: () => qrcodegen.QrCode.Ecc.LOW,
  M: () => qrcodegen.QrCode.Ecc.MEDIUM,
  Q: () => qrcodegen.QrCode.Ecc.QUARTILE,
  H: () => qrcodegen.QrCode.Ecc.HIGH,
};

function ensureQrMatrix(el) {
  const sig = `${el.data}|${el.ecc}`;
  if (el._qrSig !== sig) {
    el._qrSig = sig;
    try {
      el._qr = qrcodegen.QrCode.encodeText(el.data || "", (QR_ECC[el.ecc] || QR_ECC.M)());
    } catch {
      el._qr = null; // data too long for any version: placeholder instead
    }
  }
  return el._qr;
}

function ensureBarcode(el) {
  if (el._bcSig !== el.data) {
    el._bcSig = el.data;
    el._bc = encode128(el.data || "");
  }
  return el._bc;
}

// Hatched box: an invalid element stays visible/selectable without throwing.
function drawInvalid(ctx, x, y, w, h) {
  ctx.save();
  ctx.strokeStyle = "#000";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.beginPath();
  for (let d = -h; d < w; d += 6) {
    ctx.moveTo(x + Math.max(0, d), y + Math.max(0, -d));
    ctx.lineTo(x + Math.min(w, d + h), y + Math.min(h, w - d));
  }
  ctx.stroke();
  ctx.restore();
}

function drawQr(ctx, el) {
  const qr = ensureQrMatrix(el);
  const b = measure(el);
  if (!qr) {
    drawInvalid(ctx, el.x, el.y, b.w, b.h);
    return;
  }
  const scale = b.w / qr.size;
  ctx.save();
  ctx.fillStyle = "#000";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.getModule(x, y)) {
        ctx.fillRect(el.x + x * scale, el.y + y * scale, scale, scale);
      }
    }
  }
  ctx.restore();
}

const BARCODE_TEXT_PX = 12;

function drawBarcode(ctx, el) {
  const enc = ensureBarcode(el);
  const b = measure(el);
  if (!enc) {
    drawInvalid(ctx, el.x, el.y, b.w, b.h);
    return;
  }
  const mw = el.moduleW || 2;
  const barH = Math.max(4, b.h - (el.showText ? BARCODE_TEXT_PX + 2 : 0));
  ctx.save();
  ctx.fillStyle = "#000";
  let x = el.x;
  for (let i = 0; i < enc.widths.length; i++) {
    const w = enc.widths[i] * mw;
    if (i % 2 === 0) ctx.fillRect(x, el.y, w, barH); // even = bar, odd = space
    x += w;
  }
  if (el.showText) {
    ctx.font = `${BARCODE_TEXT_PX}px system-ui, sans-serif`;
    ctx.textBaseline = "bottom";
    ctx.textAlign = "center";
    ctx.fillText(el.data, el.x + b.w / 2, el.y + b.h);
  }
  ctx.restore();
}

export function makeQr(data, x, y, size = 80) {
  return { id: newId(), type: "qr", data, ecc: "M", x, y, size, userMoved: true };
}

export function makeBarcode(data, x, y, h = 60) {
  return { id: newId(), type: "barcode", data, x, y, h, moduleW: 2, showText: false, userMoved: true };
}

export function makeShape(kind, x, y, w, h) {
  return { id: newId(), type: "shape", kind, x, y, w, h, strokeW: 2, fill: false, radius: 0, flip: false, userMoved: true };
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
