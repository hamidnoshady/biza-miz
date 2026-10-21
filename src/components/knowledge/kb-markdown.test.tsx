// @vitest-environment jsdom
/**
 * Issue #938 — embedded media and heading anchors.
 *
 * The editor may still hold URLs written before the hardening, so the renderer
 * is the last boundary: only a known video host (or a direct file) is framed,
 * unsupported links become an explicit card, and a non-http value renders
 * nothing. Headings must carry the same ids `kbHeadings` promised, because the
 * TOC, the copy-link button and the article's post-load scroll all use them.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { KbMarkdown, KbToc, KbVideo } from "./kb-markdown";
import { kbHeadings } from "@/lib/knowledge";

afterEach(cleanup);

describe("KbVideo", () => {
  it("plays a direct video file natively", () => {
    const { container } = render(<KbVideo url="https://cdn.example.com/pos.mp4" />);
    const video = container.querySelector("video");
    expect(video?.getAttribute("src")).toBe("https://cdn.example.com/pos.mp4");
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("frames a known host with a sandbox and strict referrer policy", () => {
    const { container } = render(
      <KbVideo url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" />,
    );
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute("src")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0",
    );
    expect(frame?.getAttribute("sandbox")).toContain("allow-scripts");
    expect(frame?.getAttribute("sandbox")).not.toContain("allow-top-navigation");
    expect(frame?.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
  });

  it("converts an Aparat page and a Vimeo page to their embed URLs", () => {
    const { container, rerender } = render(<KbVideo url="https://www.aparat.com/v/abc123" />);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://www.aparat.com/video/video/embed/videohash/abc123/vt/frame",
    );
    rerender(<KbVideo url="https://vimeo.com/123456789" />);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(
      "https://player.vimeo.com/video/123456789",
    );
  });

  it("never frames an arbitrary site — it offers a new-tab link instead", () => {
    const { container } = render(<KbVideo url="https://example.com/help/clip" />);
    expect(container.querySelector("iframe")).toBeNull();
    const link = screen.getByRole("link", { name: "باز کردن ویدیو در تب جدید" });
    expect(link.getAttribute("href")).toBe("https://example.com/help/clip");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
  });

  it("renders nothing for a non-http value", () => {
    const { container } = render(<KbVideo url="javascript:alert(1)" />);
    expect(container.innerHTML).toBe("");
  });
});

describe("KbMarkdown headings", () => {
  it("gives each heading the id kbHeadings computed and keeps the article title out of the h1 slot", () => {
    const body = "## بستن صندوق\nمتن\n\n### گزارش روزانه\nمتن";
    const { container } = render(<KbMarkdown content={body} />);
    const ids = kbHeadings(body).map((heading) => heading.id);
    expect(ids).toEqual(["بستن-صندوق", "گزارش-روزانه"]);
    expect(container.querySelector(`[id="${ids[0]}"]`)?.tagName).toBe("H2");
    expect(container.querySelector(`[id="${ids[1]}"]`)?.tagName).toBe("H3");
    expect(container.querySelector("h1")).toBeNull();
    // Each anchored heading exposes the copy-link control.
    expect(screen.getAllByRole("button", { name: "کپی پیوند این عنوان" })).toHaveLength(2);
  });

  it("links the table of contents to the same ids", () => {
    const headings = kbHeadings("## بستن صندوق\n### گزارش روزانه");
    render(<KbToc headings={headings} />);
    const links = screen.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      `#${encodeURIComponent("بستن-صندوق")}`,
      `#${encodeURIComponent("گزارش-روزانه")}`,
    ]);
  });
});
