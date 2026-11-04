// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { buildPreviewDocument, ContentPreview, escapePreviewText } from "./content-preview";

afterEach(cleanup);

describe("preview document", () => {
  it("draws the owner's HTML verbatim, inside a right-to-left Persian document", () => {
    const html = buildPreviewDocument({
      title: "نگهداری فرش",
      content: "<p>متن <strong>اصلی</strong></p>",
    });

    expect(html).toContain('dir="rtl"');
    expect(html).toContain("<p>متن <strong>اصلی</strong></p>");
    expect(html).toContain("<h1>نگهداری فرش</h1>");
  });

  it("escapes the title and the excerpt so a stray angle bracket cannot become markup", () => {
    const html = buildPreviewDocument({
      title: "<script>alert(1)</script>",
      excerpt: 'خلاصه "با" نقل‌قول & نشانه',
      content: "<p>safe</p>",
    });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&quot;با&quot;");
    expect(html).toContain("&amp;");
  });

  it("carries a policy that forbids scripts and forms while allowing images", () => {
    const html = buildPreviewDocument({ title: "t", content: "<p>c</p>" });

    expect(html).toContain("script-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("img-src https:");
    expect(html).toContain('name="referrer" content="no-referrer"');
  });

  it("falls back to a visible placeholder for an untitled draft and skips an empty excerpt", () => {
    const html = buildPreviewDocument({ title: "   ", content: "<p>c</p>", excerpt: "  " });

    expect(html).toContain("<h1>بدون عنوان</h1>");
    expect(html).not.toContain('class="lead"');
  });

  it("escapes every character that could close an attribute", () => {
    expect(escapePreviewText(`a"b<c>d&e`)).toBe("a&quot;b&lt;c&gt;d&amp;e");
  });
});

describe("preview panel", () => {
  it("keeps the frame closed until the owner asks for it, and seals it when open", async () => {
    const user = userEvent.setup();
    const { container } = render(<ContentPreview title="t" content="<p>c</p>" editable />);

    expect(container.querySelector("iframe")).toBeNull();

    await user.click(screen.getByRole("button", { name: "نمایش پیش‌نمایش" }));
    const frame = container.querySelector("iframe");
    expect(frame).toBeTruthy();
    // The three seals: no scripts/forms (sandbox), no referrer, and content
    // delivered as srcdoc rather than a remote URL.
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.getAttribute("srcdoc")).toContain("<p>c</p>");

    await user.click(screen.getByRole("button", { name: "بستن پیش‌نمایش" }));
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("says why there is nothing to preview when the raw body never arrived", async () => {
    const user = userEvent.setup();
    const { container } = render(<ContentPreview title="t" content="" editable={false} />);

    await user.click(screen.getByRole("button", { name: "نمایش پیش‌نمایش" }));
    expect(screen.getByText(/پیش‌نمایشی برای نمایش وجود ندارد/)).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
  });
});
