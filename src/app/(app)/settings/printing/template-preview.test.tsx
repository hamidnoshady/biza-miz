// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { samplePrintDocument } from "@/lib/print-sample";
import { BUILT_IN_TEMPLATES } from "@/lib/print-template";
import { TemplatePreview } from "./template-preview";

const PAGE_NONCE = "c".repeat(32);

beforeEach(() => {
  // The preview fetches the Persian font; answer instantly (404 = fallback face).
  vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
  document.head.replaceChildren();
  const noncedScript = document.createElement("script");
  noncedScript.nonce = PAGE_NONCE;
  document.head.append(noncedScript);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.head.replaceChildren();
});

describe("TemplatePreview CSP bridge", () => {
  it("authorizes its srcDoc bridge with the inherited page nonce", async () => {
    render(
      <TemplatePreview
        template={BUILT_IN_TEMPLATES[0]}
        data={samplePrintDocument()}
        mode="expanded"
      />,
    );

    const frame = await waitFor(() => {
      const found = document.querySelector<HTMLIFrameElement>('iframe[aria-hidden="true"]');
      expect(found).toBeTruthy();
      return found!;
    });
    await waitFor(() => {
      const source = frame.getAttribute("srcdoc") ?? "";
      expect(source).toContain(`script-src 'nonce-${PAGE_NONCE}'`);
      expect(source).toContain(`<script nonce="${PAGE_NONCE}">`);
      expect(source).not.toContain("script-src 'unsafe-inline'");
    });
  });
});

function reportFrom(frame: HTMLIFrameElement, width: number, height: number) {
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      source: frame.contentWindow,
      data: { kind: "biza-print-preview-size", width, height, pageTops: [0], pageHeights: [height] },
    }));
  });
}

describe("TemplatePreview rendering", () => {
  it("never loads a frame without the page nonce, so the size bridge is not dead on arrival", async () => {
    // A frame that loads with `script-src 'none'` keeps its dead bridge when the
    // srcDoc changes afterwards, so no srcdoc may ever be assigned before the
    // nonce is known — not just the final one.
    const assigned: string[] = [];
    const original = Element.prototype.setAttribute;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc");
    Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
      if (this.tagName === "IFRAME" && name.toLowerCase() === "srcdoc") assigned.push(value);
      return original.call(this, name, value);
    };
    if (descriptor?.set) {
      Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", {
        ...descriptor,
        set(this: HTMLIFrameElement, value: string) {
          assigned.push(value);
          descriptor.set!.call(this, value);
        },
      });
    }
    try {
      render(<TemplatePreview template={BUILT_IN_TEMPLATES[0]} data={samplePrintDocument()} mode="expanded" />);
      await waitFor(() => expect(assigned.length).toBeGreaterThan(0));
    } finally {
      Element.prototype.setAttribute = original;
      if (descriptor) Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", descriptor);
    }
    for (const source of assigned) expect(source).toContain(`script-src 'nonce-${PAGE_NONCE}'`);
  });

  it("lays the scaled sheet out left-to-right so an RTL page cannot push it out of its box", async () => {
    const { container } = render(
      <TemplatePreview template={BUILT_IN_TEMPLATES[0]} data={samplePrintDocument()} mode="thumbnail" maxHeightPx={244} />,
    );
    const measure = await waitFor(() => {
      const frame = container.querySelector<HTMLIFrameElement>('iframe[aria-hidden="true"]');
      expect(frame).toBeTruthy();
      return frame!;
    });
    // Let the mount's own reset effect run before the frame reports, as it does in a browser.
    await act(async () => undefined);
    reportFrom(measure, 302, 400);
    await waitFor(() => expect(container.querySelector('[dir="ltr"] iframe[title^="پیش‌نمایش چاپ"]')).toBeTruthy());
  });
});

describe("TemplatePreview font", () => {
  it("carries the Persian font into the sandboxed frame, loaded once before any frame", async () => {
    vi.resetModules();
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([0, 1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const { TemplatePreview: Fresh } = await import("./template-preview");
      const first = render(<Fresh template={BUILT_IN_TEMPLATES[0]} data={samplePrintDocument()} mode="expanded" />);
      const frame = await waitFor(() => {
        const found = first.container.querySelector<HTMLIFrameElement>("iframe[srcdoc]");
        expect(found).toBeTruthy();
        return found!;
      });
      const source = frame.getAttribute("srcdoc") ?? "";
      expect(source).toContain('@font-face{font-family:"Vazirmatn"');
      expect(source).toContain("data:font/woff2;base64,AAECAw==");
      // The frame's own CSP already allows exactly that: data: fonts only.
      expect(source).toContain("font-src data:");
      first.unmount();
      const second = render(<Fresh template={BUILT_IN_TEMPLATES[1]} data={samplePrintDocument()} mode="expanded" />);
      await waitFor(() => expect(second.container.querySelector("iframe[srcdoc]")).toBeTruthy());
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    }
  });
});
