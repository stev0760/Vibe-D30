// App orchestration: document state, selection, panels, persistence, print.

import { LabelCanvas } from "./canvas.js";
import { autoFitFontPx, ensureImageBitmap, makeImage, makeText, measure, seedIds } from "./elements.js";
import { defaultFontId, listFonts, loadFont } from "./fonts.js";

const $ = (sel) => document.querySelector(sel);

const DOTS_PER_MM = 8;
// 1mm safe margin: these die-cut labels have rounded corners that
// physically clip ink placed tighter than this (confirmed on a real print).
const AUTO_MARGIN_PX = 8;
const STORAGE_KEY = "d30doc";

let doc = { tapeWidthPx: 96, lengthMode: "fixed", lengthMm: 40, elements: [] };
let selectedId = null;
let canvas;

// ---- length ---------------------------------------------------------------

function getLengthPx() {
  if (doc.lengthMode === "fixed") return doc.lengthMm * DOTS_PER_MM;
  let maxRight = 0;
  for (const el of doc.elements) {
    const b = measure(el);
    maxRight = Math.max(maxRight, b.x + b.w);
  }
  const mm = Math.ceil((maxRight + AUTO_MARGIN_PX) / DOTS_PER_MM);
  return Math.min(300, Math.max(16, mm)) * DOTS_PER_MM;
}

// ---- persistence ----------------------------------------------------------

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const clean = {
      ...doc,
      elements: doc.elements.map((el) => {
        const { _bitmap, ...rest } = el;
        return rest;
      }),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  }, 300);
}

function restore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.elements) {
        doc = parsed;
        seedIds(doc.elements);
      }
    }
  } catch {
    /* corrupted state: start fresh */
  }
}

// ---- rendering pipeline ---------------------------------------------------

function update() {
  // In fixed-length mode auto-size must respect the label length too, or
  // long strings overflow the right edge (the original PoC's clipping bug).
  // Until the user manually moves an element (userMoved), auto-sized text
  // is also kept centered — otherwise a stale y from before a text edit
  // leaves it pinned to an edge, where the label's rounded die-cut corners
  // physically clip the ink (seen on a real print). For moved elements the
  // width cap is the room right of their own x anchor instead.
  for (const el of doc.elements) {
    if (el.type === "text" && el.autoSize) {
      const fixed = doc.lengthMode === "fixed";
      const fullW = doc.lengthMm * DOTS_PER_MM - 2 * AUTO_MARGIN_PX;
      const maxW = !fixed
        ? Infinity
        : el.userMoved
          ? Math.max(8, doc.lengthMm * DOTS_PER_MM - AUTO_MARGIN_PX - el.x)
          : fullW;
      el.fontPx = autoFitFontPx(el, doc.tapeWidthPx - 2 * AUTO_MARGIN_PX, maxW);
      if (!el.userMoved) {
        const b = measure(el);
        if (fixed) el.x = Math.max(AUTO_MARGIN_PX, Math.round((doc.lengthMm * DOTS_PER_MM - b.w) / 2));
        el.y = Math.round((doc.tapeWidthPx - b.h) / 2);
      }
    } else if (el.type === "image") {
      // async on first build/restore; the guard in ensureImageBitmap makes
      // the re-entrant update() a no-op for already-current bitmaps.
      ensureImageBitmap(el, update);
    }
  }
  canvas.render();
  renderElementList();
  // Auto-size may have just recomputed the selected element's font size;
  // keep the panel's number honest without clobbering active typing.
  const sel = selectedEl();
  if (sel?.type === "text" && sel.autoSize && document.activeElement !== $("#fontPx")) {
    $("#fontPx").value = sel.fontPx;
  }
  $("#lengthReadout").textContent = `${getLengthPx() / DOTS_PER_MM} mm × 12 mm  (${getLengthPx()}×96 px)`;
  persist();
}

function selectedEl() {
  return doc.elements.find((e) => e.id === selectedId) ?? null;
}

function setSelection(id) {
  selectedId = id;
  syncPropsPanel();
  update();
}

// ---- element list panel ---------------------------------------------------

function renderElementList() {
  const ul = $("#elementList");
  ul.innerHTML = "";
  for (let i = doc.elements.length - 1; i >= 0; i--) {
    const el = doc.elements[i];
    const li = document.createElement("li");
    li.className = el.id === selectedId ? "selected" : "";
    const label = document.createElement("span");
    label.textContent =
      el.type === "text" ? `T “${(el.text || "").slice(0, 18)}”` : el.type === "icon" ? `◆ ${el.name}` : "▣ image";
    label.addEventListener("click", () => setSelection(el.id));
    const up = document.createElement("button");
    up.textContent = "↑";
    up.title = "Bring forward";
    up.addEventListener("click", () => {
      const idx = doc.elements.indexOf(el);
      if (idx < doc.elements.length - 1) {
        [doc.elements[idx], doc.elements[idx + 1]] = [doc.elements[idx + 1], doc.elements[idx]];
        update();
      }
    });
    const down = document.createElement("button");
    down.textContent = "↓";
    down.title = "Send backward";
    down.addEventListener("click", () => {
      const idx = doc.elements.indexOf(el);
      if (idx > 0) {
        [doc.elements[idx], doc.elements[idx - 1]] = [doc.elements[idx - 1], doc.elements[idx]];
        update();
      }
    });
    li.append(label, up, down);
    ul.appendChild(li);
  }
}

// ---- properties panel -----------------------------------------------------

let fontsCache = [];

function syncPropsPanel() {
  const el = selectedEl();
  $("#textProps").style.display = el?.type === "text" ? "" : "none";
  $("#imageProps").style.display = el?.type === "image" ? "" : "none";
  if (el?.type === "text") {
    $("#propText").value = el.text;
    $("#fontSelect").value = el.fontId;
    $("#fontPx").value = el.fontPx;
    $("#autoSize").checked = el.autoSize;
    $("#boldToggle").checked = el.bold;
    $("#italicToggle").checked = el.italic;
  } else if (el?.type === "image") {
    $("#imgMode").value = el.mode;
    $("#imgThreshold").value = el.threshold;
  }
}

function fillFontSelect(filter = "") {
  const sel = $("#fontSelect");
  const current = selectedEl()?.fontId ?? sel.value;
  sel.innerHTML = "";
  const needle = filter.toLowerCase();
  let shown = 0;
  for (const f of fontsCache) {
    const label = `${f.family} ${f.style}`;
    if (needle && !label.toLowerCase().includes(needle)) continue;
    if (++shown > 400) break;
    const opt = document.createElement("option");
    opt.value = f.id;
    opt.textContent = label;
    sel.appendChild(opt);
  }
  if (current && [...sel.options].some((o) => o.value === current)) sel.value = current;
}

function wirePropsPanel() {
  $("#propText").addEventListener("input", (e) => {
    const el = selectedEl();
    if (el?.type === "text") {
      el.text = e.target.value;
      update();
    }
  });
  $("#fontFilter").addEventListener("input", (e) => fillFontSelect(e.target.value));
  $("#fontSelect").addEventListener("change", async (e) => {
    const el = selectedEl();
    if (el?.type === "text") {
      el.fontId = e.target.value;
      await loadFont(el.fontId);
      update();
      syncPropsPanel(); // autoSize may have recomputed fontPx
    }
  });
  $("#fontPx").addEventListener("input", (e) => {
    const el = selectedEl();
    if (el?.type === "text") {
      el.fontPx = Math.max(4, Number(e.target.value) || 4);
      el.autoSize = false;
      $("#autoSize").checked = false;
      update();
    }
  });
  $("#autoSize").addEventListener("change", (e) => {
    const el = selectedEl();
    if (el?.type === "text") {
      el.autoSize = e.target.checked;
      update();
      $("#fontPx").value = el.fontPx;
    }
  });
  for (const [id, key] of [["#boldToggle", "bold"], ["#italicToggle", "italic"]]) {
    $(id).addEventListener("change", (e) => {
      const el = selectedEl();
      if (el?.type === "text") {
        el[key] = e.target.checked;
        update();
      }
    });
  }
  $("#deleteEl").addEventListener("click", deleteSelected);

  $("#imgMode").addEventListener("change", (e) => {
    const el = selectedEl();
    if (el?.type === "image") {
      el.mode = e.target.value;
      update();
    }
  });
  $("#imgThreshold").addEventListener("input", (e) => {
    const el = selectedEl();
    if (el?.type === "image") {
      el.threshold = Number(e.target.value);
      update();
    }
  });
  $("#deleteImgEl").addEventListener("click", deleteSelected);
}

function deleteSelected() {
  const idx = doc.elements.findIndex((e) => e.id === selectedId);
  if (idx >= 0) {
    doc.elements.splice(idx, 1);
    setSelection(null);
  }
}

// ---- toolbar / print bar --------------------------------------------------

async function addText() {
  const fontId = $("#fontSelect").value || (await defaultFontId());
  await loadFont(fontId);
  const el = makeText("Text", fontId, 8, 20);
  doc.elements.push(el);
  setSelection(el.id); // update() auto-fits and centers it (not userMoved yet)
}

function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function addImage(file) {
  // Downscale on import: labels are 96px tall, so a 512px source is ample
  // and keeps the persisted document well inside localStorage limits.
  const rawUrl = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(file);
  });
  const src = await loadImg(rawUrl);
  const down = Math.min(1, 512 / Math.max(src.width, src.height));
  const dc = document.createElement("canvas");
  dc.width = Math.max(1, Math.round(src.width * down));
  dc.height = Math.max(1, Math.round(src.height * down));
  dc.getContext("2d").drawImage(src, 0, 0, dc.width, dc.height);
  const dataUrl = dc.toDataURL("image/png");

  const availH = doc.tapeWidthPx - 2 * AUTO_MARGIN_PX;
  const availW = getLengthPx() - 2 * AUTO_MARGIN_PX;
  const scale = Math.min(availH / dc.height, availW / dc.width);
  const w = Math.max(2, Math.round(dc.width * scale));
  const h = Math.max(2, Math.round(dc.height * scale));
  const el = makeImage(
    dataUrl,
    w,
    h,
    Math.round((getLengthPx() - w) / 2),
    Math.round((doc.tapeWidthPx - h) / 2)
  );
  doc.elements.push(el);
  setSelection(el.id);
}

async function doPrint() {
  const btn = $("#printBtn");
  const status = $("#printStatus");
  btn.disabled = true;
  status.textContent = "rendering…";
  try {
    const printCanvas = canvas.renderPrintCanvas();
    const blob = await new Promise((res) => printCanvas.toBlob(res, "image/png"));
    const dataUrl = await new Promise((res) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.readAsDataURL(blob);
    });
    const png = dataUrl.split(",", 2)[1];
    status.textContent = "printing…";
    const res = await fetch("/api/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        png,
        copies: Number($("#copies").value) || 1,
        dryRun: $("#dryRun").checked,
      }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.detail ?? res.statusText);
    status.textContent = body.dryRun
      ? `dry run ok — ${body.packedBytes} bytes, header ${body.header}`
      : `printed ✓ (${body.packedBytes} bytes; notify: ${(body.notifications ?? []).slice(-1)})`;
  } catch (err) {
    status.textContent = `error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function pollStatus() {
  try {
    const s = await (await fetch("/api/printer/status")).json();
    const dot = $("#statusDot");
    dot.className = s.bluezConnected ? "dot on" : "dot";
    $("#statusText").textContent =
      `${s.address}${s.forceDryRun ? " · SERVER DRY-RUN" : ""}`;
  } catch {
    $("#statusDot").className = "dot err";
  }
}

// ---- keyboard ---------------------------------------------------------------

function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    const el = selectedEl();
    if (!el) return;
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "Delete" || e.key === "Backspace") deleteSelected();
    else if (e.key === "ArrowLeft") { el.x -= step; el.userMoved = true; }
    else if (e.key === "ArrowRight") { el.x += step; el.userMoved = true; }
    else if (e.key === "ArrowUp") { el.y -= step; el.userMoved = true; }
    else if (e.key === "ArrowDown") { el.y += step; el.userMoved = true; }
    else return;
    e.preventDefault();
    update();
  });
}

// ---- boot -------------------------------------------------------------------

async function boot() {
  restore();

  canvas = new LabelCanvas($("#editCanvas"), $("#preview"), {
    getDoc: () => doc,
    getSelection: () => selectedId,
    getLengthPx,
    onSelect: setSelection,
    onChange: update,
  });

  fontsCache = await listFonts();
  fillFontSelect();
  wirePropsPanel();
  wireKeyboard();

  $("#addText").addEventListener("click", addText);
  $("#addImage").addEventListener("click", () => $("#imageFile").click());
  $("#imageFile").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) addImage(file);
    e.target.value = ""; // allow re-adding the same file
  });
  $("#printBtn").addEventListener("click", doPrint);
  $("#lengthMode").addEventListener("change", (e) => {
    doc.lengthMode = e.target.value;
    $("#lengthMm").disabled = doc.lengthMode !== "fixed";
    update();
  });
  $("#lengthMm").addEventListener("input", (e) => {
    doc.lengthMm = Math.max(16, Math.min(300, Number(e.target.value) || 40));
    update();
  });
  $("#lengthMode").value = doc.lengthMode;
  $("#lengthMm").value = doc.lengthMm;
  $("#lengthMm").disabled = doc.lengthMode !== "fixed";

  // Load fonts referenced by a restored document before first paint.
  await Promise.allSettled(
    doc.elements.filter((e) => e.type === "text").map((e) => loadFont(e.fontId))
  );

  update();
  pollStatus();
  setInterval(pollStatus, 8000);
}

boot();
