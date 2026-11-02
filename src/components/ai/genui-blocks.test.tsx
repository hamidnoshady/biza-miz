// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { GenUiBlocks } from "./genui-blocks";

afterEach(cleanup);

const blocks = [
  { type: "kpi_row", items: [{ label: "جمع مانده", kind: "money", value: 1_250_000 }] },
  { type: "table", title: "بدهکارترین مشتریان", columns: [{ key: "name", label: "مشتری", kind: "text" }, { key: "total", label: "جمع", kind: "money" }], rows: [{ name: "<b>علی</b>", total: 50_000 }] },
];

describe("GenUiBlocks", () => {
  it("shows money in the business's chosen unit", () => {
    render(<MoneyProvider unit="rial"><GenUiBlocks blocks={blocks} /></MoneyProvider>);
    expect(screen.getByText("۱٬۲۵۰٬۰۰۰ ریال")).toBeTruthy();
    cleanup();
    render(<MoneyProvider unit="toman"><GenUiBlocks blocks={blocks} /></MoneyProvider>);
    expect(screen.getByText("۱۲۵٬۰۰۰ تومان")).toBeTruthy();
  });

  it("renders values as text, never as markup", () => {
    const { container } = render(<GenUiBlocks blocks={blocks} />);
    expect(screen.getByText("<b>علی</b>")).toBeTruthy();
    expect(container.querySelector("b")).toBeNull();
  });

  it("renders nothing for a payload that fails the allowlist", () => {
    const { container } = render(<GenUiBlocks blocks={[{ type: "iframe", src: "https://evil" }]} />);
    expect(container.innerHTML).toBe("");
  });
});
