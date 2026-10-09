/**
 * HTML → PNG rendering for thermal printing. Uses a real browser engine
 * (Chromium via playwright-core) rather than any text-mode ESC/POS codepage
 * because no printer we can target reliably shapes/reorders Persian text —
 * see src/lib/escpos.ts's header comment. The screenshot is later packed
 * into an ESC/POS raster image by raster.ts + src/lib/escpos.ts.
 *
 * Server-only: this runs inside the app server (the /api/printing/* routes),
 * which owns the rendering pipeline. It never talks to restaurant hardware —
 * the rendered bytes travel back to the browser and out through the local
 * Cafe POS connector. Paths resolve from `process.cwd()` (the repo root under
 * `next start`/the custom server; `__dirname` is unreliable once Next bundles
 * a route handler).
 *
 * **The render context is hostile-by-default.** Chromium here is a rasteriser
 * for documents this product built, not a browser: JavaScript is off, every
 * request that is not an inline `data:` resource is aborted, navigation is
 * pinned to `about:blank`, and both the page and each render have a hard time
 * limit. Nothing about a print job — least of all a client-supplied one —
 * should be able to make the app server open a socket on someone's behalf.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { chromium, type Browser, type Route } from "playwright-core";
import { chromiumLaunchArgs, findChromiumExecutable } from "../chromium-executable";

const FONT_PATH = join(process.cwd(), "src", "app", "fonts", "Vazirmatn-Variable.woff2");
let fontDataUri: string | null = null;

/** A page may not grow past this; a runaway template must fail, not eat the server. */
export const MAX_RENDER_HEIGHT_PX = 20_000;

/** Wall-clock ceiling for one page load + screenshot. */
export const RENDER_TIMEOUT_MS = 20_000;

/** Ceiling for one inline document (the same 8 MB the print route accepts). */
export const MAX_DOCUMENT_BYTES = 8_000_000;

function getFontDataUri(): string {
  if (!fontDataUri) {
    const buf = readFileSync(FONT_PATH);
    fontDataUri = `data:font/woff2;base64,${buf.toString("base64")}`;
  }
  return fontDataUri;
}

/** The templates (src/lib/*-template.ts) set `font-family: "Vazirmatn"` but don't embed the font — done here so the pure templates stay dependency-free. */
function withEmbeddedFont(html: string): string {
  const style = `<style>@font-face{font-family:"Vazirmatn";src:url(${getFontDataUri()}) format("woff2");font-weight:100 900;font-style:normal;}</style>`;
  return html.replace("<head>", `<head>${style}`);
}

/**
 * Everything a rendered document is allowed to load. A print document is
 * self-contained by construction (the Persian font and any logo travel as
 * `data:` URLs — see business-logo.ts), so the answer is "no network, no
 * filesystem, no blob": the one rule that keeps a hostile document from
 * turning the app server into a request proxy for the café LAN.
 *
 * Exported because it is the security contract, and it is tested directly.
 */
export function isAllowedRenderRequest(url: string): boolean {
  if (url === "" || url === "about:blank") return true;
  if (url.startsWith("data:")) return true;
  return false;
}

/** The height of a PNG, read from its own IHDR chunk — no JS needed to ask the page. */
export function pngHeightOf(buffer: Buffer): number | null {
  if (buffer.length < 24 || buffer.toString("latin1", 1, 4) !== "PNG") return null;
  return buffer.readUInt32BE(20);
}

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: findChromiumExecutable(),
      args: chromiumLaunchArgs(),
    });
    // A failed launch must not poison every later print with the same
    // rejected promise — reset so the next job retries the launch.
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/**
 * Renders `html` at a fixed pixel width (from the paper preset) and returns a
 * full-height PNG screenshot.
 *
 * The page is a closed sandbox: no scripts, no navigation away from the
 * inline document, no request that leaves the process. `waitUntil: "load"`
 * rather than `networkidle` for the same reason — with every external request
 * blocked there is no network to go idle, so waiting for one only ever cost
 * time.
 */
export async function renderHtmlToPng(html: string, widthPx: number): Promise<Buffer> {
  if (Buffer.byteLength(html, "utf8") > MAX_DOCUMENT_BYTES) throw new Error("document_too_large");
  const browser = await getBrowser();
  const context = await browser.newContext({
    javaScriptEnabled: false,
    serviceWorkers: "block",
    offline: true,
    viewport: { width: widthPx, height: 200 },
    deviceScaleFactor: 1,
  });
  try {
    await context.route("**/*", async (route: Route) => {
      if (isAllowedRenderRequest(route.request().url())) {
        await route.continue().catch(() => undefined);
        return;
      }
      await route.abort("blockedbyclient").catch(() => undefined);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(RENDER_TIMEOUT_MS);
    await page.setContent(withEmbeddedFont(html), { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
    const buffer = await page.screenshot({ type: "png", fullPage: true, timeout: RENDER_TIMEOUT_MS });
    const height = pngHeightOf(buffer);
    if (height != null && height > MAX_RENDER_HEIGHT_PX) throw new Error("document_too_tall");
    return buffer;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}
