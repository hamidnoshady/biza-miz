// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { samplePrintDocument } from "@/lib/print-sample";
import { BUILT_IN_TEMPLATES } from "@/lib/print-template";
import { TemplatePreview } from "./template-preview";

const PAGE_NONCE = "c".repeat(32);

beforeEach(() => {
  document.head.replaceChildren();
  const noncedScript = document.createElement("script");
  noncedScript.nonce = PAGE_NONCE;
  document.head.append(noncedScript);
});

afterEach(() => {
  cleanup();
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

    const frame = document.querySelector<HTMLIFrameElement>('iframe[aria-hidden="true"]');
    expect(frame).toBeTruthy();
    await waitFor(() => {
      const source = frame?.getAttribute("srcdoc") ?? "";
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
  it("never loads a frame without the page nonce, so the size bridge is not dead on arrival", () => {
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
    } finally {
      Element.prototype.setAttribute = original;
      if (descriptor) Object.defineProperty(HTMLIFrameElement.prototype, "srcdoc", descriptor);
    }
    expect(assigned.length).toBeGreaterThan(0);
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
    reportFrom(measure, 302, 400);
    await waitFor(() => expect(container.querySelector('[dir="ltr"] iframe[title^="پیش‌نمایش چاپ"]')).toBeTruthy());
  });
});
