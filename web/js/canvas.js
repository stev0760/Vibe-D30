// The two rendering surfaces and pointer interaction.
//
// Editing canvas: zoomed, antialiased, with selection chrome — the pleasant
// view. Print canvas: rendered at true 1x and forced to 1-bpp — the honest
// view; its pixels are exactly what gets printed. The preview strip shows
// the print canvas scaled up with image-rendering: pixelated.
//
// Zoom is not fixed: each render fits the label into the canvas area, so the
// whole label — including the selection's resize handle — is always on
// screen, on any window size. Same for the preview strip's integer scale.

import { draw, measure } from "./elements.js";
import { threshold } from "./dither.js";

const HANDLE_PX = 14; // screen px
const AREA_PAD = 16; // breathing room inside #canvasArea

export class LabelCanvas {
  constructor(editCanvas, previewCanvas, callbacks) {
    this.edit = editCanvas;
    this.preview = previewCanvas;
    this.cb = callbacks; // { onSelect(id), onChange(), getDoc(), getSelection(), getLengthPx() }
    this._drag = null;
    this.zoom = 4; // recomputed every render

    editCanvas.addEventListener("pointerdown", (e) => this._pointerDown(e));
    editCanvas.addEventListener("pointermove", (e) => this._pointerMove(e));
    editCanvas.addEventListener("pointerup", (e) => this._pointerUp(e));

    // Refit when the window/panel geometry changes.
    this._lastFit = "";
    new ResizeObserver(() => {
      const area = this.edit.parentElement;
      const fit = `${area.clientWidth}x${area.clientHeight}`;
      if (fit !== this._lastFit) {
        this._lastFit = fit;
        this.render();
      }
    }).observe(this.edit.parentElement);
  }

  // ---- rendering ----------------------------------------------------------

  _fitZoom(lengthPx, H) {
    const area = this.edit.parentElement;
    const availW = Math.max(80, area.clientWidth - 2 * AREA_PAD);
    const availH = Math.max(60, area.clientHeight - 2 * AREA_PAD);
    return Math.max(0.5, Math.min(10, availW / lengthPx, availH / H));
  }

  render() {
    const doc = this.cb.getDoc();
    const lengthPx = this.cb.getLengthPx();
    const H = doc.tapeWidthPx;
    const zoom = (this.zoom = this._fitZoom(lengthPx, H));

    // Editing canvas: backing store at devicePixelRatio for crisp text.
    const c = this.edit;
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.round(lengthPx * zoom);
    const cssH = Math.round(H * zoom);
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    c.style.width = `${cssW}px`;
    c.style.height = `${cssH}px`;
    const ctx = c.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS px from here on
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, cssW, cssH);
    ctx.save();
    ctx.scale(zoom, zoom);
    for (const el of doc.elements) draw(ctx, el);
    ctx.restore();

    // Selection chrome (drawn in screen space over the scaled content)
    const sel = this._selected();
    if (sel) {
      const b = measure(sel);
      ctx.strokeStyle = "#2563eb";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x * zoom - 2, b.y * zoom - 2, b.w * zoom + 4, b.h * zoom + 4);
      ctx.setLineDash([]);
      // Resize handle: filled square with a white outline so it reads over ink
      const hx = (b.x + b.w) * zoom - HANDLE_PX / 2;
      const hy = (b.y + b.h) * zoom - HANDLE_PX / 2;
      ctx.fillStyle = "#2563eb";
      ctx.fillRect(hx, hy, HANDLE_PX, HANDLE_PX);
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.strokeRect(hx, hy, HANDLE_PX, HANDLE_PX);
    }

    // Preview strip = the real print pixels, integer-scaled to the room it has
    const printCanvas = this.renderPrintCanvas();
    const wrap = this.preview.parentElement;
    const scale = Math.max(
      1,
      Math.min(
        3,
        Math.floor((wrap.clientWidth - 4) / printCanvas.width) || 1,
        Math.floor((window.innerHeight * 0.28) / printCanvas.height) || 1
      )
    );
    this.preview.width = printCanvas.width;
    this.preview.height = printCanvas.height;
    this.preview.style.width = `${printCanvas.width * scale}px`;
    this.preview.style.height = `${printCanvas.height * scale}px`;
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
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  _onHandle(p, sel) {
    const b = measure(sel);
    const hx = (b.x + b.w) * this.zoom;
    const hy = (b.y + b.h) * this.zoom;
    return Math.abs(p.x * this.zoom - hx) <= HANDLE_PX && Math.abs(p.y * this.zoom - hy) <= HANDLE_PX;
  }

  _hitTest(p) {
    const doc = this.cb.getDoc();
    for (let i = doc.elements.length - 1; i >= 0; i--) {
      const el = doc.elements[i];
      const b = measure(el);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) return el;
    }
    return null;
  }

  _pointerDown(e) {
    const p = this._docPos(e);

    // Resize handle of current selection first
    const sel = this._selected();
    if (sel && this._onHandle(p, sel)) {
      this._drag = { mode: "resize", el: sel, startY: p.y, startBox: measure(sel), startFontPx: sel.fontPx };
      this.edit.setPointerCapture(e.pointerId);
      return;
    }

    const el = this._hitTest(p);
    if (el) {
      this.cb.onSelect(el.id);
      this._drag = { mode: "move", el, offX: p.x - el.x, offY: p.y - el.y };
      this.edit.setPointerCapture(e.pointerId);
      return;
    }
    this.cb.onSelect(null);
  }

  _pointerMove(e) {
    const p = this._docPos(e);
    if (!this._drag) {
      // Hover feedback: make the handle and draggable elements discoverable.
      const sel = this._selected();
      this.edit.style.cursor =
        sel && this._onHandle(p, sel) ? "nwse-resize" : this._hitTest(p) ? "move" : "default";
      return;
    }
    const d = this._drag;
    if (!d.committed) {
      // Snapshot the pre-drag state exactly once, on first real movement —
      // a click that never moves must not create an empty undo step.
      this.cb.onCommit?.();
      d.committed = true;
    }
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
