// Element types: how each kind of label element measures and draws itself.
// All geometry is in document (printer-pixel) coordinates; drawing functions
// receive a ctx already scaled so they can draw in doc coordinates directly.

import { isLoaded } from "./fonts.js";

let nextId = 1;
export function newId() {
  return String(nextId++);
}

export function seedIds(elements) {
  const max = Math.max(0, ...elements.map((e) => Number(e.id) || 0));
  nextId = max + 1;
}

function fontSpec(el) {
  const style = el.italic ? "italic " : "";
  const weight = el.bold ? "bold " : "";
  return `${style}${weight}${el.fontPx}px "${el.fontId}"`;
}

// ---- measuring ------------------------------------------------------------

const measureCtx = document.createElement("canvas").getContext("2d");

export function measure(el) {
  if (el.type === "text") {
    measureCtx.font = fontSpec(el);
    const m = measureCtx.measureText(el.text || " ");
    const ascent = m.actualBoundingBoxAscent;
    const descent = m.actualBoundingBoxDescent;
    const left = m.actualBoundingBoxLeft;
    const right = m.actualBoundingBoxRight;
    return { x: el.x, y: el.y, w: Math.max(1, left + right), h: Math.max(1, ascent + descent), ascent, left };
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
    ctx.font = fontSpec(el);
    ctx.fillStyle = "#000";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(el.text, el.x + m.left, el.y + m.ascent);
  } else if (el.type === "image" && el._bitmap) {
    ctx.drawImage(el._bitmap, el.x, el.y, el.w, el.h);
  } else if (el.type === "icon" && el._bitmap) {
    ctx.drawImage(el._bitmap, el.x, el.y, el.w, el.h);
  }
}

export function makeText(text, fontId, x, y, fontPx = 48) {
  return { id: newId(), type: "text", text, fontId, fontPx, autoSize: true, bold: false, italic: false, x, y };
}
