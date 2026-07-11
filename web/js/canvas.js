// The two rendering surfaces and pointer interaction.
//
// Editing canvas: zoomed, antialiased, with selection chrome — the pleasant
// view. Print canvas: rendered at true 1x and forced to 1-bpp — the honest
// view; its pixels are exactly what gets printed. The preview strip shows
// the print canvas scaled up with image-rendering: pixelated.

import { draw, measure } from "./elements.js";
import { threshold } from "./dither.js";

export const ZOOM = 5;
const PREVIEW_SCALE = 3;
const HANDLE_PX = 12; // screen px

export class LabelCanvas {
  constructor(editCanvas, previewCanvas, callbacks) {
    this.edit = editCanvas;
    this.preview = previewCanvas;
    this.cb = callbacks; // { onSelect(id), onChange(), getDoc(), getSelection(), getLengthPx() }
    this._drag = null;

    editCanvas.addEventListener("pointerdown", (e) => this._pointerDown(e));
    editCanvas.addEventListener("pointermove", (e) => this._pointerMove(e));
    editCanvas.addEventListener("pointerup", (e) => this._pointerUp(e));
  }

  // ---- rendering ----------------------------------------------------------

  render() {
    const doc = this.cb.getDoc();
    const lengthPx = this.cb.getLengthPx();
    const H = doc.tapeWidthPx;

    // Editing canvas
    const c = this.edit;
    c.width = lengthPx * ZOOM;
    c.height = H * ZOOM;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.save();
    ctx.scale(ZOOM, ZOOM);
    for (const el of doc.elements) draw(ctx, el);
    ctx.restore();

    // Selection chrome (drawn in screen space over the scaled content)
    const sel = this._selected();
    if (sel) {
      const b = measure(sel);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x * ZOOM - 2, b.y * ZOOM - 2, b.w * ZOOM + 4, b.h * ZOOM + 4);
      ctx.setLineDash([]);
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(
        (b.x + b.w) * ZOOM - HANDLE_PX / 2,
        (b.y + b.h) * ZOOM - HANDLE_PX / 2,
        HANDLE_PX,
        HANDLE_PX
      );
    }

    // Preview strip = the real print pixels
    const printCanvas = this.renderPrintCanvas();
    this.preview.width = printCanvas.width;
    this.preview.height = printCanvas.height;
    this.preview.style.width = `${printCanvas.width * PREVIEW_SCALE}px`;
    this.preview.style.height = `${printCanvas.height * PREVIEW_SCALE}px`;
    this.preview.getContext("2d").drawImage(printCanvas, 0, 0);
  }

  /** True 1x render, forced to 1-bpp. This is what prints. */
  renderPrintCanvas() {
    const doc = this.cb.getDoc();
    const lengthPx = this.cb.getLengthPx();
    const c = document.createElement("canvas");
    c.width = lengthPx;
    c.height = doc.tapeWidthPx;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    for (const el of doc.elements) draw(ctx, el);
    // Global threshold: text/icon edges get thresholded; image elements are
    // drawn pre-dithered (pure B/W) so this pass leaves them untouched.
    const data = ctx.getImageData(0, 0, c.width, c.height);
    threshold(data);
    ctx.putImageData(data, 0, 0);
    return c;
  }

  // ---- interaction --------------------------------------------------------

  _selected() {
    const doc = this.cb.getDoc();
    const id = this.cb.getSelection();
    return doc.elements.find((e) => e.id === id) ?? null;
  }

  _docPos(e) {
    const r = this.edit.getBoundingClientRect();
    return { x: (e.clientX - r.left) / ZOOM, y: (e.clientY - r.top) / ZOOM };
  }

  _pointerDown(e) {
    const doc = this.cb.getDoc();
    const p = this._docPos(e);

    // Resize handle of current selection first
    const sel = this._selected();
    if (sel) {
      const b = measure(sel);
      const hx = (b.x + b.w) * ZOOM;
      const hy = (b.y + b.h) * ZOOM;
      const sx = p.x * ZOOM;
      const sy = p.y * ZOOM;
      if (Math.abs(sx - hx) <= HANDLE_PX && Math.abs(sy - hy) <= HANDLE_PX) {
        this._drag = { mode: "resize", el: sel, startY: p.y, startBox: b, startFontPx: sel.fontPx };
        this.edit.setPointerCapture(e.pointerId);
        return;
      }
    }

    // Hit test top-down (last element = topmost)
    for (let i = doc.elements.length - 1; i >= 0; i--) {
      const el = doc.elements[i];
      const b = measure(el);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
        this.cb.onSelect(el.id);
        this._drag = { mode: "move", el, offX: p.x - el.x, offY: p.y - el.y };
        this.edit.setPointerCapture(e.pointerId);
        return;
      }
    }
    this.cb.onSelect(null);
  }

  _pointerMove(e) {
    if (!this._drag) return;
    const p = this._docPos(e);
    const d = this._drag;
    if (d.mode === "move") {
      d.el.x = Math.round(p.x - d.offX);
      d.el.y = Math.round(p.y - d.offY);
      d.el.userMoved = true; // hand position control to the user from now on
    } else if (d.mode === "resize") {
      const scale = Math.max(0.05, (d.startBox.h + (p.y - d.startY)) / d.startBox.h);
      if (d.el.type === "text") {
        d.el.fontPx = Math.max(4, Math.round(d.startFontPx * scale));
        d.el.autoSize = false;
      } else {
        d.el.w = Math.max(2, Math.round(d.startBox.w * scale));
        d.el.h = Math.max(2, Math.round(d.startBox.h * scale));
      }
    }
    this.cb.onChange();
  }

  _pointerUp(e) {
    if (this._drag) {
      this.edit.releasePointerCapture(e.pointerId);
      this._drag = null;
      this.cb.onChange();
    }
  }
}
