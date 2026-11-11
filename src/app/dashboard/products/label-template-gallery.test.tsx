// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { ReadOnlyLabelGallery } from "./label-template-gallery";

vi.mock("@/app/(app)/settings/printing/template-preview", () => ({ TemplatePreview: ({ data }: { data: { title: string } }) => <div data-testid="preview">{data.title}</div> }));
afterEach(cleanup);

describe("read-only label gallery", () => {
  it("uses the trade-specific catalogue and does not expose mutation or weight-encoding controls", () => {
    render(<MoneyProvider unit="rial"><ReadOnlyLabelGallery industry="cosmetics" /></MoneyProvider>);
    expect(screen.getAllByTestId("preview").length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain("بچ");
    expect(document.body.textContent).not.toContain("الگوی بارکد وزنی");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
  it("does not show a jewelry tag to a watch business", () => {
    render(<MoneyProvider unit="rial"><ReadOnlyLabelGallery industry="watch" /></MoneyProvider>);
    expect(screen.getAllByTestId("preview").length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain("تگ جواهر ۵۷×۴۰");
  });
});
