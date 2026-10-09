import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@/lib/permissions";

/**
 * Who may settle a subledger balance, and where that decision is allowed to
 * live — pinned so it stays where the fix put it.
 *
 * Issue #825 found the screen and the API disagreeing: `receivePayment` has
 * always been gated on `finance.receivables_manage`, but `/accounting/
 * receivables` is readable with `ledger.view` alone — and it still drew a live
 * «دریافت وجه» button for everyone. A member who clicked it typed an amount and
 * got a 403. The capability now travels down as one prop, derived once from the
 * same permission constant the routes enforce.
 *
 * The behavioural half of this (a `canSettle={false}` screen draws no action,
 * while the read models still work) lives in `subledger-section.test.tsx`, which
 * needs jsdom. This file is the structural half: a grep cannot prove the screen
 * behaves, but it does fail loudly if somebody reintroduces a capability check
 * inside the shared component — which is how the A/R-specific rule would leak
 * into A/P.
 */

function read(name: string): string {
  return readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");
}

const SECTION_SOURCE = read("./subledger-section.tsx");
const MANAGER_SOURCE = read("./accounting-manager.tsx");
const AR_SOURCE = read("./ar-section.tsx");
const AP_SOURCE = read("./ap-section.tsx");

describe("the capability the settle action is drawn from", () => {
  it("is the same permission the receipts endpoint enforces", () => {
    const receiptsRoute = readFileSync(
      fileURLToPath(new URL("../../api/ledger/ar/receipts/route.ts", import.meta.url)),
      "utf8",
    );
    const paymentsRoute = readFileSync(
      fileURLToPath(new URL("../../api/ledger/ap/payments/route.ts", import.meta.url)),
      "utf8",
    );

    expect(PERMISSIONS.financeReceivablesManage).toBe("finance.receivables_manage");
    expect(PERMISSIONS.financePayablesManage).toBe("finance.payables_manage");
    // The write half only; reading the list stays on ledger.view.
    // The POST handler is gated on the manage permission and is the only thing
    // that reaches the writing service (the A/P route validates an idempotency
    // key in between, so the gate is asserted on the handler, not on a
    // character distance to the call).
    expect(receiptsRoute).toMatch(/requirePermission\(PERMISSIONS\.financeReceivablesManage\)[\s\S]{0,1200}receivePayment/);
    expect(paymentsRoute).toMatch(/POST = withTenantScope\([\s\S]{0,400}requirePermission\(PERMISSIONS\.financePayablesManage\)/);
    expect(paymentsRoute).toMatch(/payBill\(/);
    expect(receiptsRoute).toMatch(/GET = withTenantScope\([\s\S]{0,400}requirePermission\(PERMISSIONS\.ledgerView\)/);
  });

  it("is derived once, in the manager, and handed down as a prop", () => {
    expect(MANAGER_SOURCE).toMatch(/permissions\.includes\(PERMISSIONS\.financeReceivablesManage\)/);
    expect(MANAGER_SOURCE).toMatch(/permissions\.includes\(PERMISSIONS\.financePayablesManage\)/);
    expect(MANAGER_SOURCE).toMatch(/<ArSection canSettle=\{canManageReceivables\}/);
    expect(MANAGER_SOURCE).toMatch(/<ApSection canSettle=\{canManagePayables\}/);
    // The two sides never derive it from a role of their own.
    expect(AR_SOURCE).not.toMatch(/permissions|role ===/);
    expect(AP_SOURCE).not.toMatch(/permissions|role ===/);
  });

  it("is never re-derived inside the shared screen, where one side's rule would leak into the other", () => {
    // The screen may *document* the permission in a comment, but it must not
    // import the permission registry or read a role/user identity.
    expect(SECTION_SOURCE).not.toMatch(/from "@\/lib\/permissions"/);
    expect(SECTION_SOURCE).not.toMatch(/PERMISSIONS\./);
    expect(SECTION_SOURCE).not.toMatch(/role\s*===\s*["']/);
    // Everything the actions hang off is the one prop.
    expect(SECTION_SOURCE).toMatch(/\{ side, canSettle \}: \{ side: SubledgerSide; canSettle: boolean \}/);
    expect(SECTION_SOURCE).toMatch(/canSettle && settleTarget \?/);
    expect(SECTION_SOURCE).toMatch(/\{canSettle \? <Th>اقدام<\/Th> : null\}/);
  });

  it("keeps one screen for both sides — no second balance table, no shared logic in the side files", () => {
    expect(AR_SOURCE).toMatch(/<SubledgerSection side=\{RECEIVABLES_SIDE\} canSettle=\{canSettle\} \/>/);
    expect(AP_SOURCE).toMatch(/<SubledgerSection side=\{PAYABLES_SIDE\} canSettle=\{canSettle\} \/>/);
    for (const side of [AR_SOURCE, AP_SOURCE]) {
      expect(side).not.toMatch(/DataTable|useEffect|fetch\(/);
    }
  });
});
