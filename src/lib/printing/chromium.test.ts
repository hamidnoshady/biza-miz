/**
 * chromium.ts — the rasteriser's security contract (issue #815's "Chromium
 * network/script blocking" item).
 *
 * The app server renders documents the product itself built, so the browser
 * context it launches must be closed by construction: no JavaScript, no
 * network, no navigation, and hard ceilings on document size and image
 * height. These tests pin that contract at both ends — the pure predicate that
 * decides what a page may load, and the arguments the context is actually
 * created with.
 *
 * `playwright-core` is mocked, so no browser binary is needed here; the
 * assertions are about what this code asks Chromium to do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PNG } from "pngjs";
import { chromium } from "playwright-core";
import {
  MAX_RENDER_HEIGHT_PX,
  MAX_DOCUMENT_BYTES,
  closeBrowser,
  isAllowedRenderRequest,
  pngHeightOf,
  renderHtmlToPng,
} from "./chromium";

vi.mock("playwright-core", () => ({ chromium: { launch: vi.fn() } }));

vi.mock("../chromium-executable", () => ({
  findChromiumExecutable: () => "/usr/bin/chromium",
  chromiumLaunchArgs: () => ["--no-sandbox"],
}));

interface FakeRoute {
  request: () => { url: () => string };
  continue: () => Promise<void>;
  abort: (reason?: string) => Promise<void>;
}

function pngOf(width: number, height: number): Buffer {
  return PNG.sync.write(new PNG({ width, height }));
}

let routeHandlers: ((route: FakeRoute) => Promise<void>)[];
let context: {
  route: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};
let screenshot: ReturnType<typeof vi.fn>;

function installBrowser(): void {
  routeHandlers = [];
  screenshot = vi.fn(async () => pngOf(8, 20));
  context = {
    route: vi.fn(async (_pattern: string, handler: (route: FakeRoute) => Promise<void>) => {
      routeHandlers.push(handler);
    }),
    newPage: vi.fn(async () => ({
      setDefaultTimeout: vi.fn(),
      setContent: vi.fn(async () => undefined),
      screenshot,
    })),
    close: vi.fn(async () => undefined),
  };
  vi.mocked(chromium.launch).mockResolvedValue({
    newContext: vi.fn(async () => context),
    close: vi.fn(async () => undefined),
  } as never);
}

beforeEach(() => {
  installBrowser();
});

afterEach(async () => {
  // chromium.ts caches its browser promise per module instance.
  await closeBrowser();
  vi.clearAllMocks();
});

describe("isAllowedRenderRequest — the one rule about what a document may load", () => {
  it("allows the blank page and inline data only", () => {
    expect(isAllowedRenderRequest("about:blank")).toBe(true);
    expect(isAllowedRenderRequest("")).toBe(true);
    expect(isAllowedRenderRequest("data:image/png;base64,AAAA")).toBe(true);
    expect(isAllowedRenderRequest("data:font/woff2;base64,AAAA")).toBe(true);
  });

  it("refuses every way a document could reach the network or the disk", () => {
    for (const url of [
      "http://10.0.0.9/admin",
      "https://example.com/track.png",
      "//example.com/x",
      "file:///etc/passwd",
      "blob:https://app.example/1234",
      "ws://127.0.0.1:9123/health",
      "ftp://example.com/x",
      "javascript:alert(1)",
      "dataX:image/png;base64,AAAA",
      "DATA:image/png;base64,AAAA",
    ]) {
      expect(isAllowedRenderRequest(url), url).toBe(false);
    }
  });
});

describe("pngHeightOf", () => {
  it("reads the height out of the PNG's own header", () => {
    expect(pngHeightOf(pngOf(4, 37))).toBe(37);
  });

  it("returns null for anything that is not a PNG", () => {
    expect(pngHeightOf(Buffer.from("not a png at all, really"))).toBeNull();
    expect(pngHeightOf(Buffer.alloc(0))).toBeNull();
    expect(pngHeightOf(Buffer.from([0x89, 0x50, 0x4e]))).toBeNull();
  });
});

describe("renderHtmlToPng — the context is hostile-by-default", () => {
  it("renders with JavaScript off, offline, service workers blocked, at the paper's own width", async () => {
    await renderHtmlToPng("<html><head></head><body>رسید</body></html>", 372);
    const browser = (await vi.mocked(chromium.launch).mock.results[0].value) as unknown as {
      newContext: ReturnType<typeof vi.fn>;
    };
    expect(browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({
        javaScriptEnabled: false,
        serviceWorkers: "block",
        offline: true,
        deviceScaleFactor: 1,
        viewport: { width: 372, height: 200 },
      }),
    );
  });

  it("aborts every request that is not an inline data resource, and allows the ones that are", async () => {
    await renderHtmlToPng("<html><head></head><body>x</body></html>", 512);
    expect(routeHandlers).toHaveLength(1);
    const handler = routeHandlers[0];

    const aborted = { continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    await handler({ request: () => ({ url: () => "http://192.168.1.50/steal" }), ...aborted });
    expect(aborted.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(aborted.continue).not.toHaveBeenCalled();

    const allowed = { continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    await handler({ request: () => ({ url: () => "data:image/png;base64,AAAA" }), ...allowed });
    expect(allowed.continue).toHaveBeenCalledOnce();
    expect(allowed.abort).not.toHaveBeenCalled();
  });

  it("refuses an oversized document before it ever launches a browser", async () => {
    await expect(renderHtmlToPng("x".repeat(MAX_DOCUMENT_BYTES + 1), 512)).rejects.toThrow("document_too_large");
    expect(chromium.launch).not.toHaveBeenCalled();
  });

  it("refuses a page taller than the ceiling instead of returning a huge raster", async () => {
    screenshot.mockResolvedValue(pngOf(8, MAX_RENDER_HEIGHT_PX + 1));
    await expect(renderHtmlToPng("<html><head></head><body>x</body></html>", 512)).rejects.toThrow("document_too_tall");
  });

  it("always closes the context, even when the screenshot fails", async () => {
    screenshot.mockRejectedValue(new Error("render blew up"));
    await expect(renderHtmlToPng("<html><head></head><body>x</body></html>", 512)).rejects.toThrow("render blew up");
    expect(context.close).toHaveBeenCalledOnce();
  });
});
