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


async def main():
    async with async_playwright() as pw:
        browser = await pw.chromium.launch()
        page = await browser.new_page(viewport={"width": 1400, "height": 900})
        errors = []
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: errors.append(str(e)))

        await page.goto(URL)
        await wait_ready(page)
        n_fonts = await page.eval_on_selector_all("#fontSelect option", "os => os.length")
        check("boot + fonts enumerated", n_fonts > 100, f"{n_fonts} fonts")

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

        # arrow nudge hands position control to the user (userMoved)
        box = await (await page.query_selector("#editCanvas")).bounding_box()
        await page.mouse.click(box["x"] + 200, box["y"] + 240)  # select element
        await page.keyboard.press("ArrowRight")
        await page.wait_for_timeout(600)  # persist() debounces 300ms
        moved = await page.evaluate(
            "JSON.parse(localStorage.getItem('d30doc')).elements[0].userMoved === true"
        )
        check("arrow nudge sets userMoved", bool(moved))

        # --- dry-run print of the text label -----------------------------------
        await page.click("#printBtn")
        status = await wait_print_done(page)
        check("dry-run print (text)", "dry run ok" in status, status.strip())
        check("header bytes 40mm/12mm", "1b401d7630000c004001" in status)

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
        stats = await page.evaluate(
            """() => {
                const p = document.querySelector('#preview');
                const d = p.getContext('2d').getImageData(0, 0, p.width, p.height).data;
                let black = 0;
                for (let i = 0; i < d.length; i += 4) if (d[i] < 128) black++;
                return { black, total: p.width * p.height };
            }"""
        )
        frac = stats["black"] / stats["total"]
        check("preview has ink", 0.02 < frac < 0.9, f"{frac:.1%} black")

        await page.click("#printBtn")
        status = await wait_print_done(page)
        check("dry-run print (showcase)", "dry run ok" in status, status.strip())

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
