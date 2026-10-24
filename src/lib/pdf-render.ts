/**
 * HTML → PDF rendering for report export. Same reasoning and technique as
 * printing/chromium.ts (a real browser engine via playwright-core, since
 * Persian/RTL text needs real shaping — see src/lib/escpos.ts), running
 * inside this app's own server process, so paths are resolved from
 * `process.cwd()` (the project root under `next start`/the custom server),
 * not `__dirname` (unreliable once Next bundles this route handler for
 * production).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { chromium, type Browser } from "playwright-core";
import { chromiumLaunchArgs, findChromiumExecutable } from "./chromium-executable";

const FONT_PATH = join(process.cwd(), "src", "app", "fonts", "Vazirmatn-Variable.woff2");
let fontDataUri: string | null = null;

function getFontDataUri(): string {
  if (!fontDataUri) {
    const buf = readFileSync(FONT_PATH);
    fontDataUri = `data:font/woff2;base64,${buf.toString("base64")}`;
  }
  return fontDataUri;
}

function withEmbeddedFont(html: string): string {
  const style = `<style>@font-face{font-family:"Vazirmatn";src:url(${getFontDataUri()}) format("woff2");font-weight:100 900;font-style:normal;}</style>`;
  return html.replace("<head>", `<head>${style}`);
}

let browserPromise: Promise<Browser> | null = null;

function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      executablePath: findChromiumExecutable(),
      args: chromiumLaunchArgs(),
    });
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

export type PdfPaperFormat = "A4" | "A5" | "A6" | "A3" | "Letter" | "Legal";
export interface PdfRenderOptions {
  format?: PdfPaperFormat;
  landscape?: boolean;
  margin?: { top: string; bottom: string; left: string; right: string };
}

/** Renders `html` to a PDF buffer; format/landscape selectable (previously hard-coded A4). */
export async function renderHtmlToPdf(html: string, options: PdfRenderOptions = {}): Promise<Buffer> {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setContent(withEmbeddedFont(html), { waitUntil: "networkidle" });
    const buffer = await page.pdf({
      format: options.format ?? "A4",
      landscape: options.landscape ?? false,
      printBackground: true,
      margin: options.margin ?? { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" },
    });
    return buffer;
  } finally {
    await page.close();
  }
}

/** Convenience: resolve PDF options from print template paper/orientation */
export function pdfOptionsForPaper(paper: string, orientation?: string): PdfRenderOptions {
  const landscape = orientation === "landscape";
  if (paper === "a5" || paper === "A5") return { format: "A5", landscape };
  if (paper === "a6" || paper === "A6") return { format: "A6", landscape };
  return { format: "A4", landscape };
}

export async function closeBrowser(): Promise<void> {
  if (!browserPromise) return;
  const browser = await browserPromise;
  browserPromise = null;
  await browser.close();
}
