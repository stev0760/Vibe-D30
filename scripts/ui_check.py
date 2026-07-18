"""Headless regression sweep of the web editor.

Drives the editor in headless Chromium and checks every v1 feature:
fonts, text auto-fit, nudging, icons, dithered images, auto length,
persistence, deletion, and dry-run prints (including the exact header
bytes for a 40mm/12mm label). WARNING: clears the editor's saved
document (localStorage) as part of the run.

Usage:
    D30_DRY_RUN=1 .venv/bin/uvicorn server.app:app --port 8330 &
    .venv/bin/python scripts/ui_check.py

Needs playwright (`.venv/bin/pip install playwright`) with chromium
downloaded (`.venv/bin/playwright install chromium`).
"""
import asyncio
import json
import re

from playwright.async_api import async_playwright

URL = "http://127.0.0.1:8330/"

PASS = []
FAIL = []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append(name)
    print(("PASS " if ok else "FAIL ") + name + (f" — {detail}" if detail else ""))


async def wait_ready(page):
    await page.wait_for_selector("#addText")
    await page.wait_for_function("document.querySelectorAll('#fontSelect option').length > 0")


async def wait_print_done(page):
    await page.wait_for_function(
        "document.querySelector('#printStatus').textContent.length > 0"
        " && !document.querySelector('#printStatus').textContent.includes('…')"
    )
    return await page.text_content("#printStatus")


async def preview_ink(page):
    """Count black pixels in the preview strip (the true print pixels)."""
    return await page.evaluate(
        """() => {
            const p = document.querySelector('#preview');
            const d = p.getContext('2d').getImageData(0, 0, p.width, p.height).data;
            let black = 0;
            for (let i = 0; i < d.length; i += 4) if (d[i] < 128) black++;
            return { black, total: p.width * p.height };
        }"""
    )


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        # 1366x720: the smallest real screen this runs on; the layout must fit
        # entirely (fit-to-view canvas zoom, no cut-off handles or panels).
        page = await browser.new_page(viewport={"width": 1366, "height": 720})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(URL)
        await wait_ready(page)
        n_fonts = await page.eval_on_selector_all("#fontSelect option", "os => os.length")
        check("boot + fonts enumerated", n_fonts > 100, f"{n_fonts} fonts")

        # header status line shows the app version (from /api/printer/status)
        await page.wait_for_function(
            "document.querySelector('#statusText').textContent.length > 0"
        )
        status_text = await page.text_content("#statusText")
        check(
            "version shown in status",
            bool(re.search(r"v\d+\.\d+\.\d+", status_text or "")),
            (status_text or "").strip(),
        )

        # Start from a clean document
        await page.evaluate("localStorage.removeItem('d30doc'); location.reload()")
        await wait_ready(page)

        # --- text: add, edit, auto-fit, font switch ---------------------------
        await page.click("#addText")
        await page.wait_for_selector("#textProps", state="visible")
        await page.fill("#propText", "Hello D30!")
        await page.wait_for_timeout(300)
        await page.fill("#fontFilter", "liberation")
        await page.wait_for_timeout(200)
        opts = await page.eval_on_selector_all("#fontSelect option", "os => os.map(o => o.value)")
        check("font filter finds liberation", len(opts) > 0, f"{len(opts)} matches")
        if opts:
            await page.select_option("#fontSelect", opts[0])
            await page.wait_for_timeout(600)  # FontFace fetch + rerender
        auto_px = await page.input_value("#fontPx")
        check("auto-fit computed a size", int(auto_px) > 10, f"fontPx={auto_px}")

        # layout must fit: whole canvas and sidebar inside the viewport
        box = await (await page.query_selector("#editCanvas")).bounding_box()
        fits = (
            box["x"] >= 0 and box["y"] >= 0
            and box["x"] + box["width"] <= 1366 and box["y"] + box["height"] <= 720
        )
        check("canvas fully in viewport", fits, f"{box['width']:.0f}x{box['height']:.0f}")
        aside = await (await page.query_selector("aside")).bounding_box()
        check("sidebar fully in viewport", aside["x"] + aside["width"] <= 1366)

        # arrow nudge hands position control to the user (userMoved);
        # auto-sized text is centered, so the canvas center hits it
        await page.mouse.click(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        await page.keyboard.press("ArrowRight")
        await page.wait_for_timeout(600)  # persist() debounces 300ms
        moved = await page.evaluate(
            "JSON.parse(localStorage.getItem('d30doc')).elements[0].userMoved === true"
        )
        check("arrow nudge sets userMoved", bool(moved))

        # --- undo/redo ----------------------------------------------------------
        x_after_nudge = await page.evaluate(
            "JSON.parse(localStorage.getItem('d30doc')).elements[0].x"
        )
        await page.keyboard.press("Control+z")
        await page.wait_for_timeout(600)
        undone = await page.evaluate(
            "JSON.parse(localStorage.getItem('d30doc')).elements[0]"
        )
        check(
            "undo restores pre-nudge state",
            undone["x"] == x_after_nudge - 1 and not undone.get("userMoved"),
            f"x {x_after_nudge} -> {undone['x']}, userMoved={undone.get('userMoved')}",
        )
        await page.keyboard.press("Control+Shift+z")
        await page.wait_for_timeout(600)
        redone = await page.evaluate(
            "JSON.parse(localStorage.getItem('d30doc')).elements[0]"
        )
        check(
            "redo reapplies nudge",
            redone["x"] == x_after_nudge and redone.get("userMoved") is True,
            f"x={redone['x']}",
        )

        # drag the selection's corner handle: font size scales, auto-size off
        px_before = await page.evaluate(
            "JSON.parse(localStorage.getItem('d30doc')).elements[0].fontPx"
        )
        hpos = await page.evaluate(
            """() => {
                const el = JSON.parse(localStorage.getItem('d30doc')).elements[0];
                const r = document.querySelector('#editCanvas').getBoundingClientRect();
                const zoom = r.width / (40 * 8); // fixed 40mm doc
                const mctx = document.createElement('canvas').getContext('2d');
                mctx.font = `${el.fontPx}px "${el.fontId}"`;
                const m = mctx.measureText(el.text);
                const w = m.actualBoundingBoxLeft + m.actualBoundingBoxRight;
                const h = m.actualBoundingBoxAscent + m.actualBoundingBoxDescent;
                return { x: r.left + (el.x + w) * zoom, y: r.top + (el.y + h) * zoom };
            }"""
        )
        await page.mouse.move(hpos["x"], hpos["y"])
        await page.wait_for_timeout(100)
        cursor = await page.eval_on_selector("#editCanvas", "c => c.style.cursor")
        check("resize cursor over handle", cursor == "nwse-resize", cursor)
        await page.mouse.down()
        await page.mouse.move(hpos["x"] - 40, hpos["y"] - 40, steps=5)
        await page.mouse.up()
        await page.wait_for_timeout(600)
        after = await page.evaluate(
            "JSON.parse(localStorage.getItem('d30doc')).elements[0]"
        )
        check(
            "handle drag resizes text",
            after["fontPx"] < px_before and after["autoSize"] is False,
            f"fontPx {px_before} -> {after['fontPx']}, autoSize={after['autoSize']}",
        )

        # faux bold/italic: canvas can't synthesize styles for FontFace fonts,
        # so we stroke/skew by hand — bold must add ink at a fixed font size
        ink_plain = (await preview_ink(page))["black"]
        await page.check("#boldToggle")
        await page.wait_for_timeout(300)
        ink_bold = (await preview_ink(page))["black"]
        check("faux bold adds ink", ink_bold > ink_plain, f"{ink_plain} -> {ink_bold}")
        await page.check("#italicToggle")
        await page.wait_for_timeout(300)
        ink_bi = (await preview_ink(page))["black"]
        check("faux italic renders", ink_bi > 0, str(ink_bi))
        await page.uncheck("#boldToggle")
        await page.uncheck("#italicToggle")
        await page.wait_for_timeout(200)

        # --- dry-run print of the text label -----------------------------------
        await page.click("#printBtn")
        status = await wait_print_done(page)
        check("dry-run print (text)", "dry run ok" in status, status.strip())
        # 40mm label at the default 0mm offset = 320 rows = 0x0140 LE
        check("header bytes 40mm/12mm", "1b401d7630000c004001" in status, status.strip())

        # --- offset control + in-UI calibration ruler ---------------------------
        await page.fill("#offsetMm", "4")
        await page.click("#printBtn")
        status = await wait_print_done(page)
        # 320 rows + 4mm*8px = 352 rows = 0x0160 LE
        check("offset 4mm changes header", "1b401d7630000c006001" in status, status.strip())
        stored = await page.evaluate("JSON.parse(localStorage.getItem('d30cal')).offsetMm")
        check("offset persisted (d30cal)", stored == 4, str(stored))
        await page.click("#calBtn")
        status = await wait_print_done(page)
        check("calibration ruler dry-run", "dry run ok" in status, status.strip())
        await page.fill("#offsetMm", "0")
        await page.wait_for_timeout(150)

        # --- showcase: icon + text + dithered gradient image -------------------
        await page.evaluate("localStorage.removeItem('d30doc'); location.reload()")
        await wait_ready(page)

        await page.click("#addIcon")
        await page.wait_for_selector("#iconPicker", state="visible")
        await page.fill("#iconSearch", "coffee")
        await page.wait_for_timeout(300)
        cells = await page.eval_on_selector_all(".iconCell", "cs => cs.length")
        check("icon search 'coffee'", cells > 0, f"{cells} results")
        await page.click(".iconCell")
        await page.wait_for_timeout(400)
        hidden = await page.eval_on_selector("#iconPicker", "p => p.style.display === 'none'")
        check("picker closes after pick", bool(hidden))

        await page.click("#addText")
        await page.wait_for_selector("#textProps", state="visible")
        await page.fill("#propText", "Coffee")
        await page.wait_for_timeout(400)

        # dithered radial-gradient image element, generated in-page
        await page.evaluate(
            """() => {
                const c = document.createElement('canvas');
                c.width = c.height = 60;
                const ctx = c.getContext('2d');
                const g = ctx.createRadialGradient(30, 30, 2, 30, 30, 30);
                g.addColorStop(0, '#000');
                g.addColorStop(1, '#fff');
                ctx.fillStyle = g;
                ctx.fillRect(0, 0, 60, 60);
                const doc = JSON.parse(localStorage.getItem('d30doc'));
                doc.elements.push({ id: '99', type: 'image', dataUrl: c.toDataURL(),
                                    w: 60, h: 60, x: 254, y: 18, mode: 'dither', threshold: 128 });
                localStorage.setItem('d30doc', JSON.stringify(doc));
                location.reload();
            }"""
        )
        await wait_ready(page)
        await page.wait_for_timeout(900)
        items = await page.eval_on_selector_all("#elementList li span", "s => s.map(x => x.textContent)")
        check("showcase doc has 3 elements", len(items) == 3, json.dumps(items))

        # preview strip carries real ink (dithered mid-density pattern included)
        stats = await preview_ink(page)
        frac = stats["black"] / stats["total"]
        check("preview has ink", 0.02 < frac < 0.9, f"{frac:.1%} black")

        await page.click("#printBtn")
        status = await wait_print_done(page)
        check("dry-run print (showcase)", "dry run ok" in status, status.strip())

        # --- duplicate + alignment ----------------------------------------------
        await page.click("#elementList li span")  # select topmost element
        await page.wait_for_selector("#arrangeProps", state="visible")
        await page.click("#dupEl")
        await page.wait_for_timeout(300)
        n_dup = await page.eval_on_selector_all("#elementList li", "ls => ls.length")
        check("duplicate adds an element", n_dup == 4, f"{n_dup} elements")
        await page.keyboard.press("Control+z")
        await page.wait_for_timeout(300)
        n_undup = await page.eval_on_selector_all("#elementList li", "ls => ls.length")
        check("undo removes the duplicate", n_undup == 3, f"{n_undup} elements")

        await page.click("#elementList li span")
        await page.click("#align-left")
        await page.wait_for_timeout(600)
        aligned = await page.evaluate(
            """() => {
                const doc = JSON.parse(localStorage.getItem('d30doc'));
                return doc.elements[doc.elements.length - 1].x;  // topmost = selected
            }"""
        )
        check("align-left snaps to safe margin", aligned == 8, f"x={aligned}")

        # --- shapes ---------------------------------------------------------------
        ink_before_shape = (await preview_ink(page))["black"]
        await page.click("#addRect")
        await page.wait_for_timeout(400)
        ink_rect = (await preview_ink(page))["black"]
        check("rect frame adds ink", ink_rect > ink_before_shape,
              f"{ink_before_shape} -> {ink_rect}")
        await page.click("#addLine")
        await page.wait_for_timeout(400)
        ink_line = (await preview_ink(page))["black"]
        # a full-width 2px rule is ~ (320-16)*2 = 608px of ink, minus whatever
        # it overlaps of the showcase elements already on the label
        check("line adds a rule's worth of ink", 150 < ink_line - ink_rect < 900,
              f"delta {ink_line - ink_rect}")
        await page.keyboard.press("Control+z")
        await page.keyboard.press("Control+z")
        await page.wait_for_timeout(400)

        # --- freehand pencil --------------------------------------------------------
        box2 = await (await page.query_selector("#editCanvas")).bounding_box()
        await page.click("#drawToggle")
        cx, cy = box2["x"] + box2["width"] * 0.3, box2["y"] + box2["height"] * 0.4
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.mouse.move(cx + 120, cy + 40, steps=10)
        await page.mouse.move(cx + 200, cy - 20, steps=10)
        await page.mouse.up()
        await page.click("#drawToggle")  # exit draw mode
        await page.wait_for_timeout(600)
        pencil = await page.evaluate(
            """() => {
                const doc = JSON.parse(localStorage.getItem('d30doc'));
                return doc.elements.find(e => e.type === 'pencil') ?? null;
            }"""
        )
        check(
            "pencil stroke creates element",
            pencil is not None and len(pencil["strokes"][0]["pts"]) > 2,
            f"{len(pencil['strokes'][0]['pts']) if pencil else 0} pts",
        )
        await page.reload()
        await wait_ready(page)
        await page.wait_for_timeout(600)
        pencil2 = await page.evaluate(
            """() => {
                const doc = JSON.parse(localStorage.getItem('d30doc'));
                return doc.elements.some(e => e.type === 'pencil');
            }"""
        )
        check("pencil survives reload", bool(pencil2))
        # remove it again so downstream counts stay valid
        await page.evaluate(
            """() => {
                const doc = JSON.parse(localStorage.getItem('d30doc'));
                doc.elements = doc.elements.filter(e => e.type !== 'pencil');
                localStorage.setItem('d30doc', JSON.stringify(doc));
                location.reload();
            }"""
        )
        await wait_ready(page)
        await page.wait_for_timeout(600)

        # --- auto length --------------------------------------------------------
        await page.select_option("#lengthMode", "auto")
        await page.wait_for_timeout(400)
        readout = await page.text_content("#lengthReadout")
        check("auto length recomputes", "mm" in (readout or ""), (readout or "").strip())
        await page.select_option("#lengthMode", "fixed")
        await page.wait_for_timeout(300)

        # --- persistence + deletion --------------------------------------------
        await page.reload()
        await wait_ready(page)
        await page.wait_for_timeout(900)
        items2 = await page.eval_on_selector_all("#elementList li span", "s => s.map(x => x.textContent)")
        check("persistence after reload", len(items2) == 3, json.dumps(items2))

        await page.click("#elementList li span")
        await page.keyboard.press("Delete")
        await page.wait_for_timeout(300)
        items3 = await page.eval_on_selector_all("#elementList li span", "s => s.map(x => x.textContent)")
        check("delete removes element", len(items3) == 2, json.dumps(items3))

        check("zero console/page errors", not errors, "; ".join(errors[:5]))
        await browser.close()

    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    if FAIL:
        raise SystemExit(1)


asyncio.run(main())
