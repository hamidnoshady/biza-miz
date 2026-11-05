/**
 * Issue #1207 §B/§D — the products screen's RTL desktop and mobile layout,
 * pinned at the source level (the same convention as
 * `product-add-responsive.test.ts`).
 *
 * The visual suite has no products baseline, and re-recording one needs the
 * owner's approval, so what can be asserted without touching a design artifact
 * is asserted here: the toolbar wraps instead of clipping, every row control is
 * full-width until `sm`, a long store name truncates *and* keeps its full text
 * for assistive tech, an expanded panel is capped to the table's visible width
 * and glued to its start edge (RTL-safe: no physical `left-`/`right-` at all),
 * and the touch targets stay at least 32–36px tall.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const here = fileURLToPath(new URL("./", import.meta.url));
const section = readFileSync(join(here, "products-list-section.tsx"), "utf8");
const editPanel = readFileSync(join(here, "product-edit-panel.tsx"), "utf8");
const publicationPanel = readFileSync(join(here, "product-publication-panel.tsx"), "utf8");

describe("the products screen on a phone and a desktop", () => {
  it("wraps the toolbar and gives every control its own phone row", () => {
    expect(section).toMatch(/data-tour-id="products\.toolbar"[\s\S]{0,120}flex flex-wrap/);
    // Each filter label is a full-width row until `sm`, then it sits inline.
    const labels = section.match(/className="flex w-full shrink-0 items-center gap-2 text-xs text-muted-foreground sm:w-auto"/g) ?? [];
    expect(labels.length).toBeGreaterThanOrEqual(4);
    // Search first, taking the wide area only from `sm` up.
    expect(section).toContain('className="w-full min-w-0 sm:w-auto sm:flex-1"');
  });

  it("does not clip a long store name — it truncates and keeps the full text", () => {
    expect(section).toContain("max-w-24 truncate text-foreground");
    // The chip's own title carries what the ellipsis hides.
    expect(section).toContain("title={`${link.storeName} · Woo ID ${link.remoteId}`}");
  });

  it("caps an expanded panel to the table's visible width and keeps it on screen (RTL)", () => {
    // Measured from the scrolling ancestor, not from viewport math: the
    // sidebar and page padding make those two different numbers.
    expect(section).toContain('ref.current?.closest("div.overflow-x-auto")');
    expect(section).toContain("new ResizeObserver(fit)");
    expect(section).toContain("style={available != null ? { maxWidth: available - 12 } : undefined}");
    // `start-0`, never `left-0`: the panel must hug the table's start edge in
    // an RTL document too.
    expect(section).toContain('"sticky start-0"');
    expect(section).not.toMatch(/\b(left|right)-[0-9]/);
    expect(section).not.toMatch(/\b(ml|mr|pl|pr)-[0-9]/);
    expect(editPanel).not.toMatch(/\b(left|right|ml|mr|pl|pr)-[0-9]/);
  });

  it("reserves LTR only for codes, never for the layout", () => {
    // Exactly the two code inputs (SKU, barcode) and the SKU line in the row.
    expect(editPanel.match(/dir="ltr"/g)).toHaveLength(2);
    expect(section.match(/dir="ltr"/g)).toHaveLength(2);
    expect(editPanel).toContain('aria-label="کد کالا"');
    expect(editPanel).toContain('aria-label="بارکد"');
  });

  it("keeps row and panel targets at touch size", () => {
    // Every control in the row and the panels is 32px or taller, and the
    // primary actions in the editors reach 36px.
    const small = section.match(/min-h-8/g) ?? [];
    expect(small.length).toBeGreaterThan(0);
    expect(editPanel).toContain("min-h-9 px-4 font-semibold");
    expect(publicationPanel).toContain("min-h-9 text-xs");
  });

  it("stacks the edit form until it has room for two columns", () => {
    expect(editPanel).toContain('className="grid min-w-0 gap-3 sm:grid-cols-2"');
    expect(editPanel).not.toMatch(/(?<![a-z]:)\bgrid-cols-2\b/);
  });

  it("lets the row's action cell wrap instead of pushing the table sideways", () => {
    // The primary store action and the «جزئیات» disclosure share one wrapping
    // cell: on a narrow window they stack instead of widening the table.
    expect(section).toMatch(
      /<div className="flex flex-wrap items-center gap-1\.5">\s*<ProductStoreActionButton/,
    );
    expect(section).toContain('className="min-h-8 whitespace-nowrap px-2 text-xs"');
  });
});
