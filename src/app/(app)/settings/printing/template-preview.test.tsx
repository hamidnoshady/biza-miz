// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
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
