// App orchestration: document state, selection, panels, persistence, print.

import { LabelCanvas } from "./canvas.js";
import { autoFitFontPx, ensureImageBitmap, makeIcon, makeImage, makeText, measure, newId, seedIds } from "./elements.js";
import { defaultFontId, listFonts, loadFont } from "./fonts.js";
import { History } from "./history.js";

const $ = (sel) => document.querySelector(sel);

const DOTS_PER_MM = 8;
// 1mm safe margin: these die-cut labels have rounded corners that
// physically clip ink placed tighter than this (confirmed on a real print).
const AUTO_MARGIN_PX = 8;
const STORAGE_KEY = "d30doc";
// Device calibration (print-start offset) is persisted separately from the
// document: it belongs to the printer/spool, not the design.
const CAL_KEY = "d30cal";

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

// Runtime-only fields (bitmap/image caches, signatures) use a `_` prefix and
// are stripped generically on every serialization — persisted documents and
// undo snapshots carry only the declarative element state.
function stripRuntime(el) {
  const clean = {};
  for (const [k, v] of Object.entries(el)) {
    if (!k.startsWith("_")) clean[k] = v;
  }
  return clean;
}

function serializeDoc(d = doc) {
  return JSON.stringify({ ...d, elements: d.elements.map(stripRuntime) });
}

let saveTimer = null;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORAGE_KEY, serializeDoc());
  }, 300);
}

// ---- undo/redo --------------------------------------------------------------

const history = new History();
let clipboard = null; // in-app element clipboard (serialized, runtime-free)

// Snapshot the pre-mutation state; call right before every document change.
function commit(coalesceKey = null) {
  history.commit(serializeDoc(), coalesceKey);
}

function applySnapshot(json) {
  doc = JSON.parse(json);
  seedIds(doc.elements);
  if (!doc.elements.some((e) => e.id === selectedId)) selectedId = null;
  // Fonts referenced by the restored state may not be loaded yet; re-render
  // once they are (draw() skips unloaded fonts, so this is safe either way).
  Promise.allSettled(
    doc.elements.filter((e) => e.type === "text").map((e) => loadFont(e.fontId))
  ).then(update);
  syncPropsPanel();
  update();
}

function doUndo() {
  const s = history.undo(serializeDoc());
  if (s != null) applySnapshot(s);
}

function doRedo() {
  const s = history.redo(serializeDoc());
  if (s != null) applySnapshot(s);
}

function pasteElement(src) {
  if (!src) return;
  commit();
  const copy = JSON.parse(JSON.stringify(src));
  copy.id = newId();
  copy.x = (copy.x ?? 0) + 8;
  copy.y = (copy.y ?? 0) + 8;
  copy.userMoved = true;
  doc.elements.push(copy);
  if (copy.type === "text") loadFont(copy.fontId);
  setSelection(copy.id);
}

function duplicateSelected() {
  const el = selectedEl();
  if (el) pasteElement(stripRuntime(el));
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

function currentOffsetMm() {
  const v = Number($("#offsetMm").value);
  return Number.isFinite(v) ? Math.max(-8, Math.min(8, v)) : 0;
}

function restoreCal() {
  try {
    const cal = JSON.parse(localStorage.getItem(CAL_KEY));
    if (typeof cal?.offsetMm === "number") $("#offsetMm").value = cal.offsetMm;
  } catch {
    /* corrupted state: keep default */
  }
}

function persistCal() {
  localStorage.setItem(CAL_KEY, JSON.stringify({ offsetMm: currentOffsetMm() }));
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
    } else if (el.type === "image" || el.type === "icon") {
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
        commit();
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
        commit();
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
  $("#imageProps").style.display = el?.type === "image" || el?.type === "icon" ? "" : "none";
  $("#arrangeProps").style.display = el ? "" : "none";
  if (el?.type === "text") {
    $("#propText").value = el.text;
    $("#fontSelect").value = el.fontId;
    $("#fontPx").value = el.fontPx;
    $("#autoSize").checked = el.autoSize;
    $("#boldToggle").checked = el.bold;
    $("#italicToggle").checked = el.italic;
  } else if (el?.type === "image" || el?.type === "icon") {
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
      commit(`text:${el.id}`);
      el.text = e.target.value;
      update();
    }
  });
  $("#fontFilter").addEventListener("input", (e) => fillFontSelect(e.target.value));
  $("#fontSelect").addEventListener("change", async (e) => {
    const el = selectedEl();
    if (el?.type === "text") {
      commit();
      el.fontId = e.target.value;
      await loadFont(el.fontId);
      update();
      syncPropsPanel(); // autoSize may have recomputed fontPx
    }
  });
  $("#fontPx").addEventListener("input", (e) => {
    const el = selectedEl();
    if (el?.type === "text") {
      commit(`fontPx:${el.id}`);
      el.fontPx = Math.max(4, Number(e.target.value) || 4);
      el.autoSize = false;
      $("#autoSize").checked = false;
      update();
    }
  });
  $("#autoSize").addEventListener("change", (e) => {
    const el = selectedEl();
    if (el?.type === "text") {
      commit();
      el.autoSize = e.target.checked;
      update();
      $("#fontPx").value = el.fontPx;
    }
  });
  for (const [id, key] of [["#boldToggle", "bold"], ["#italicToggle", "italic"]]) {
    $(id).addEventListener("change", (e) => {
      const el = selectedEl();
      if (el?.type === "text") {
        commit();
        el[key] = e.target.checked;
        update();
      }
    });
  }
  $("#deleteEl").addEventListener("click", deleteSelected);

  $("#imgMode").addEventListener("change", (e) => {
    const el = selectedEl();
    if (el?.type === "image" || el?.type === "icon") {
      commit();
      el.mode = e.target.value;
      update();
    }
  });
  $("#imgThreshold").addEventListener("input", (e) => {
    const el = selectedEl();
    if (el?.type === "image" || el?.type === "icon") {
      commit(`thr:${el.id}`);
      el.threshold = Number(e.target.value);
      update();
    }
  });
  $("#deleteImgEl").addEventListener("click", deleteSelected);
}

function deleteSelected() {
  const idx = doc.elements.findIndex((e) => e.id === selectedId);
  if (idx >= 0) {
    commit();
    doc.elements.splice(idx, 1);
    setSelection(null);
  }
}

// ---- alignment --------------------------------------------------------------
// Snap the selection within the label, honoring the 1mm safe margin (the
// die-cut corners physically clip ink placed tighter than that).

function alignSelected(how) {
  const el = selectedEl();
  if (!el) return;
  const b = measure(el);
  const L = getLengthPx();
  const H = doc.tapeWidthPx;
  const M = AUTO_MARGIN_PX;
  commit();
  if (how === "left") el.x = M;
  else if (how === "centerH") el.x = Math.round((L - b.w) / 2);
  else if (how === "right") el.x = Math.max(M, L - M - Math.round(b.w));
  else if (how === "top") el.y = M;
  else if (how === "middleV") el.y = Math.round((H - b.h) / 2);
  else if (how === "bottom") el.y = Math.max(M, H - M - Math.round(b.h));
  el.userMoved = true;
  update();
}

// ---- toolbar / print bar --------------------------------------------------

async function addText() {
  const fontId = $("#fontSelect").value || (await defaultFontId());
  await loadFont(fontId);
  const el = makeText("Text", fontId, 8, 20);
  commit();
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
  commit();
  doc.elements.push(el);
  setSelection(el.id);
}

// ---- icon picker ------------------------------------------------------------

let iconsIndex = null;

async function openIconPicker() {
  if (!iconsIndex) {
    iconsIndex = await (await fetch("/icons.json")).json();
  }
  $("#iconPicker").style.display = "";
  $("#iconSearch").value = "";
  renderIconGrid("");
  $("#iconSearch").focus();
}

function closeIconPicker() {
  $("#iconPicker").style.display = "none";
}

function renderIconGrid(filter) {
  const grid = $("#iconGrid");
  grid.innerHTML = "";
  const needle = filter.trim().toLowerCase();
  let shown = 0;
  for (const [name, entry] of Object.entries(iconsIndex)) {
    if (needle && !name.includes(needle) && !entry.t.some((t) => t.includes(needle))) continue;
    if (++shown > 96) break;
    const cell = document.createElement("button");
    cell.className = "iconCell";
    cell.title = name;
    cell.innerHTML = entry.s; // inline SVG: currentColor strokes follow UI color
    cell.addEventListener("click", () => {
      addIcon(name, entry.s);
      closeIconPicker();
    });
    grid.appendChild(cell);
  }
  $("#iconCount").textContent = shown > 96 ? "96+ shown, refine search" : `${shown} icons`;
}

function addIcon(name, svg) {
  const size = 64;
  const el = makeIcon(
    name,
    svg,
    size,
    Math.round((getLengthPx() - size) / 2),
    Math.round((doc.tapeWidthPx - size) / 2)
  );
  commit();
  doc.elements.push(el);
  setSelection(el.id);
}

async function postPrintCanvas(printCanvas, { copies = 1 } = {}) {
  const status = $("#printStatus");
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
      copies,
      dryRun: $("#dryRun").checked,
      offsetMm: currentOffsetMm(),
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.detail ?? res.statusText);
  status.textContent = body.dryRun
    ? `dry run ok — ${body.packedBytes} bytes, header ${body.header}, offset ${body.offsetMm}mm`
    : `printed ✓ (${body.packedBytes} bytes; notify: ${(body.notifications ?? []).slice(-1)})`;
}

async function doPrint() {
  const btn = $("#printBtn");
  btn.disabled = true;
  $("#printStatus").textContent = "rendering…";
  try {
    await postPrintCanvas(canvas.renderPrintCanvas(), {
      copies: Number($("#copies").value) || 1,
    });
  } catch (err) {
    $("#printStatus").textContent = `error: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// Calibration ruler, drawn client-side like every label (one renderer).
// Printed with the current offset applied: when the offset is right, the
// "0" mark sits exactly on the physical label's left edge — any residual
// error is exactly the correction to add to the Offset field.
function drawRuler() {
  const w = getLengthPx();
  const h = doc.tapeWidthPx;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, w, 2); // top bar
  ctx.fillRect(0, h - 2, w, 2); // bottom bar
  ctx.fillRect(0, 0, 2, h); // left bar
  ctx.fillRect(w - 2, 0, 2, h); // right bar
  const lengthMm = Math.round(w / DOTS_PER_MM);
  for (let mm = 0; mm <= lengthMm; mm++) {
    const x = Math.min(mm * DOTS_PER_MM, w - 1);
    const tick = mm % 10 === 0 ? 26 : mm % 5 === 0 ? 16 : 8;
    ctx.fillRect(x, 2, 1, tick);
  }
  ctx.font = 'bold 22px "sans-serif"';
  ctx.textBaseline = "top";
  for (let mm = 0; mm <= lengthMm; mm += 10) {
    const label = String(mm);
    const tw = ctx.measureText(label).width;
    const tx = Math.min(Math.max(2, mm * DOTS_PER_MM - tw / 2), w - tw - 3);
    ctx.fillText(label, tx, 40);
  }
  ctx.fillText("<- left/0", 8, 68);
  return c;
}

async function doCalibrate() {
  const btn = $("#calBtn");
  btn.disabled = true;
  try {
    await postPrintCanvas(drawRuler());
  } catch (err) {
    $("#printStatus").textContent = `error: ${err.message}`;
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
      `v${s.version} · ${s.address}${s.forceDryRun ? " · SERVER DRY-RUN" : ""}`;
  } catch {
    $("#statusDot").className = "dot err";
  }
}

// ---- keyboard ---------------------------------------------------------------

function wireKeyboard() {
  document.addEventListener("keydown", (e) => {
    // Form fields keep their native keyboard behavior (incl. text undo).
    if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "z") {
      e.preventDefault();
      e.shiftKey ? doRedo() : doUndo();
      return;
    }
    if (mod && key === "y") {
      e.preventDefault();
      doRedo();
      return;
    }
    if (mod && key === "v") {
      e.preventDefault();
      pasteElement(clipboard);
      return;
    }
    const el = selectedEl();
    if (!el) return;
    if (mod && key === "d") {
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (mod && key === "c") {
      clipboard = stripRuntime(el);
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "Delete" || e.key === "Backspace") { deleteSelected(); e.preventDefault(); return; }
    if (!e.key.startsWith("Arrow")) return;
    commit(`nudge:${el.id}`);
    if (e.key === "ArrowLeft") { el.x -= step; el.userMoved = true; }
    else if (e.key === "ArrowRight") { el.x += step; el.userMoved = true; }
    else if (e.key === "ArrowUp") { el.y -= step; el.userMoved = true; }
    else if (e.key === "ArrowDown") { el.y += step; el.userMoved = true; }
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
    onCommit: commit,
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
  $("#addIcon").addEventListener("click", openIconPicker);
  $("#undoBtn").addEventListener("click", doUndo);
  $("#redoBtn").addEventListener("click", doRedo);
  $("#dupEl").addEventListener("click", duplicateSelected);
  for (const how of ["left", "centerH", "right", "top", "middleV", "bottom"]) {
    $(`#align-${how}`).addEventListener("click", () => alignSelected(how));
  }
  $("#iconSearch").addEventListener("input", (e) => renderIconGrid(e.target.value));
  $("#iconPickerClose").addEventListener("click", closeIconPicker);
  $("#iconPicker").addEventListener("click", (e) => {
    if (e.target === $("#iconPicker")) closeIconPicker();
  });
  $("#printBtn").addEventListener("click", doPrint);
  $("#calBtn").addEventListener("click", doCalibrate);
  $("#offsetMm").addEventListener("input", persistCal);
  restoreCal();
  $("#lengthMode").addEventListener("change", (e) => {
    commit();
    doc.lengthMode = e.target.value;
    $("#lengthMm").disabled = doc.lengthMode !== "fixed";
    update();
  });
  $("#lengthMm").addEventListener("input", (e) => {
    commit("lengthMm");
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
