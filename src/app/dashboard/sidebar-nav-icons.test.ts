/**
 * One glyph per navigation href, read by every surface the same way.
 *
 * Before this map was the single source, the bottom bar and its pin picker
 * looked up the href alone, so every Accounting section that is not a
 * business page (the ledger row, each ledger tool) drew the generic circle
 * while the sidebar drew the section's glyph. These tests pin the rule that
 * made that possible: an Accounting section's glyph comes from its section
 * definition, and `navIconFor` is the only reader.
 */
import { CalculatorIcon, CircleIcon, LayoutDashboardIcon, UsersIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_SECTION_KEYS,
  accountingSectionHref,
} from "@/app/(app)/accounting/accounting-routes";
import { ACCOUNTING_SECTION_ICONS } from "@/app/(app)/accounting/accounting-icons";
import { NAV_ICONS, navIconFor } from "./sidebar-nav-icons";

describe("Accounting section glyphs", () => {
  it("gives every section's canonical href the glyph its section is drawn with", () => {
    for (const key of ACCOUNTING_SECTION_KEYS) {
      expect(NAV_ICONS[accountingSectionHref(key)], key).toBe(ACCOUNTING_SECTION_ICONS[key]);
    }
  });

  it("draws «فضای کار حسابداری» with the calculator, not the generic circle", () => {
    expect(navIconFor("/accounting/ledger")).toBe(CalculatorIcon);
    expect(navIconFor("/accounting/ledger")).not.toBe(CircleIcon);
  });

  it("gives the overview one face everywhere: its section glyph, in the sidebar and the bottom bar", () => {
    expect(navIconFor("/accounting/overview")).toBe(ACCOUNTING_SECTION_ICONS.dashboard);
    expect(navIconFor("/accounting/overview")).toBe(LayoutDashboardIcon);
  });

  it("keeps the app door on the calculator, separate from its overview page", () => {
    expect(navIconFor("/accounting")).toBe(CalculatorIcon);
  });

  it("draws a ledger tool's directory views with the directory glyph", () => {
    expect(navIconFor("/accounting/directory?view=customers")).toBe(UsersIcon);
  });
});

describe("navIconFor", () => {
  it("uses an explicit iconKey in place of the entry's own href", () => {
    expect(navIconFor("/accounting/products/prices", "/accounting/products")).toBe(
      NAV_ICONS["/accounting/products"],
    );
  });

  it("falls back to the generic circle for an unmapped href, never to nothing", () => {
    expect(navIconFor("/no/such/page")).toBe(CircleIcon);
  });
});
