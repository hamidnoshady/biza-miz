import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { normalizeNumericText } from "@/lib/digits";
import { DEFAULT_TAX_PERCENTAGE, taxPercentageOf } from "@/lib/parties";

/**
 * The «اشخاص» directory's fixed defects, pinned so they stay fixed.
 *
 * Two kinds of assertion live here, and the split is deliberate.
 *
 * The behavioural half exercises real functions — the tax coercion, the digit
 * normaliser — because those are pure and a test can simply call them. That is
 * always the better test and it is used wherever it is possible.
 *
 * The structural half greps the two client sources, which is the approach
 * `design-lint.test.ts` and `accounting-nav-rtl.test.ts` already take in this
 * repo: vitest runs in Node here with no jsdom and no `@testing-library`, so a
 * client component cannot be mounted. A grep cannot prove the screen behaves,
 * but it does hold the exact lines that were wrong — a request with no abort, a
 * `Number()` over a cleared field, a raw ISO date rendered to a Persian user —
 * and it fails loudly if somebody reintroduces one.
 */

const SECTION_SOURCE = readFileSync(
  fileURLToPath(new URL("./parties-section.tsx", import.meta.url)),
  "utf8",
);
const FORM_SOURCE = readFileSync(
  fileURLToPath(new URL("./party-form.tsx", import.meta.url)),
  "utf8",
);
const UI_SOURCE = readFileSync(fileURLToPath(new URL("../ui.tsx", import.meta.url)), "utf8");
const SUPPLIERS_SOURCE = readFileSync(
  fileURLToPath(new URL("../inventory/suppliers-section.tsx", import.meta.url)),
  "utf8",
);

describe("the tax rate a party is saved with", () => {
  /*
   * The field used to be a raw input whose handler was
   * `Number(digits.replace(/[^\d.]/g, ""))`. Every case below silently wrote a
   * wrong VAT rate onto a counterparty — the field the invoices then use.
   */
  it("reads a cleared field as the default rate, never as zero", () => {
    // The original bug: `Number("")` is 0, and 0% is a rate a business really
    // charges, so nothing downstream could tell a cleared field from a
    // deliberate exemption.
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "" } })).toBe(DEFAULT_TAX_PERCENTAGE);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "   " } })).toBe(DEFAULT_TAX_PERCENTAGE);
  });

  it("still honours a deliberate zero", () => {
    // The other side of the same coin: an exempt party must be able to say so.
    expect(taxPercentageOf({ generalInfo: { taxPercentage: "0" } })).toBe(0);
    expect(taxPercentageOf({ generalInfo: { taxPercentage: 0 } })).toBe(0);
  });

  it("keeps the Persian decimal mark instead of multiplying the rate by ten", () => {
    // «۹٫۵» became 95 — the handler stripped «٫» as punctuation and then read
    // the remaining digits as one number.
    expect(normalizeNumericText("۹٫۵", { allowDecimal: true })).toBe("9.5");
    expect(taxPercentageOf({ generalInfo: { taxPercentage: normalizeNumericText("۹٫۵") } })).toBe(9.5);
  });

  it("accepts Arabic-Indic digits, which the old handler dropped entirely", () => {
    // «٩» (U+0669) is not «۹» (U+06F9); the old fold only knew the second, so
    // an Arabic keyboard produced 0.
    expect(normalizeNumericText("٩٫٥")).toBe("9.5");
    expect(taxPercentageOf({ generalInfo: { taxPercentage: normalizeNumericText("٩") } })).toBe(9);
  });

  it("uses the shared numeric control rather than a hand-rolled digit fold", () => {
    expect(FORM_SOURCE).toMatch(/<PersianNumberInput[\s\S]{0,400}data-field="generalInfo\.taxPercentage"/);
    // The exact expression that caused all four faults above.
    expect(FORM_SOURCE).not.toMatch(/Number\(digits\.replace/);
  });

  it("commits the typed rate even when «ذخیره» is pressed before the field blurs", () => {
    // A mouse-down on a button inside a Radix dialog can move focus without
    // firing blur, which would have submitted the previous rate.
    expect(FORM_SOURCE).toMatch(/taxPercentage: taxPercentageOf\(\{ generalInfo: \{ taxPercentage: taxInput \} \}\)/);
  });
});

describe("requests the directory starts", () => {
  it("never lets a stale search answer overwrite a newer one", () => {
    // Three independent loads (list, balances, categories) each take a signal
    // and each ignore an aborted reply.
    expect(SECTION_SOURCE).toMatch(/new AbortController\(\)/);
    expect(SECTION_SOURCE).toMatch(/if \(aborted\) return;/);
    expect(SECTION_SOURCE.match(/controller\.abort\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("waits for the typing to stop before it searches", () => {
    expect(SECTION_SOURCE).toMatch(/const SEARCH_DEBOUNCE_MS = \d+/);
    expect(SECTION_SOURCE).toMatch(/setTimeout\(\(\) => setAppliedQuery\(query\), SEARCH_DEBOUNCE_MS\)/);
    // The request reads the debounced value, not the keystroke-by-keystroke one.
    expect(SECTION_SOURCE).toMatch(/params\.set\("q", appliedQuery\.trim\(\)\)/);
  });

  it("debounces the branch supplier picker the same way", () => {
    // The same defect lived in the store's «افزودن تأمین‌کننده به این شعبه»
    // box, which searched the same endpoint on every keystroke.
    expect(SUPPLIERS_SOURCE).toMatch(/SEARCH_DEBOUNCE_MS/);
    expect(SUPPLIERS_SOURCE).toMatch(/if \(aborted\) return;/);
  });

  it("does not leave the pager past the end after the last row of a page goes", () => {
    expect(SECTION_SOURCE).toMatch(/if \(page > pages\) setPage\(pages\)/);
  });

  it("abandons the form's record load when the dialog closes", () => {
    // Otherwise a slow answer for the party they navigated away from replaced
    // the one they opened next.
    expect(FORM_SOURCE).toMatch(/signal: controller\.signal/);
    expect(FORM_SOURCE).toMatch(/if \(aborted\) return;/);
  });

  it("never rejects out of api(), so a dropped connection is a message and not a blank screen", () => {
    expect(UI_SOURCE).toMatch(/aborted/);
    expect(UI_SOURCE).toMatch(/catch/);
  });
});

describe("what the list says about money and contact details", () => {
  it("shows a settled balance as zero rather than as «no access»", () => {
    /*
     * `listCustomerBalances` omits parties whose balance is zero, so
     * `balances[id]` is `undefined` for a customer who owes nothing. The cell
     * used a falsy check, so a settled customer rendered the same dash as one
     * whose balance the member may not see.
     */
    expect(SECTION_SOURCE).toMatch(/balances\[party\.id\] \?\? 0|balance \?\? 0/);
  });

  it("does not hide a zero-percent tax rate behind a dash", () => {
    // Same falsy-check family: `taxPercentage` of 0 is a real answer.
    expect(SECTION_SOURCE).toMatch(/taxPercentageOf/);
  });

  it("makes a phone number callable and an address mailable", () => {
    expect(SECTION_SOURCE).toMatch(/href=\{`tel:\$\{party\.phone\}`\}/);
    expect(SECTION_SOURCE).toMatch(/href=\{`mailto:/);
  });
});

describe("destructive actions in the list", () => {
  it("names the person in the confirm, not just «این شخص»", () => {
    expect(SECTION_SOURCE).toMatch(/window\.confirm\([\s\S]{0,200}party\.displayName/);
  });

  it("reports which row is working instead of freezing the whole list", () => {
    // A single boolean `busy` disabled every button on the page for the length
    // of one request.
    expect(SECTION_SOURCE).toMatch(/const \[pendingKey, setPendingKey\]/);
    expect(SECTION_SOURCE).toMatch(/pending=\{pendingKey === party\.id\}/);
    expect(SECTION_SOURCE).not.toMatch(/const \[busy, setBusy\] = useState/);
  });

  it("lets an archived category be brought back", () => {
    // The route has always accepted `isActive: true` and the list already asks
    // for inactive rows; only the button was missing, so a mis-click was final.
    expect(SECTION_SOURCE).toMatch(/isActive: !category\.isActive/);
  });

  it("puts a duplicate category name on the field that caused it", () => {
    expect(SECTION_SOURCE).toMatch(/fieldErrors\?\.name/);
    expect(SECTION_SOURCE).toMatch(/party-category-name-error/);
  });
});

describe("dates and digits shown to a Persian user", () => {
  it("renders a draft's timestamp in Jalali, not as a raw ISO string", () => {
    // `savedAt.slice(0, 16).replace("T", " ")` printed «۲۰۲۶-۰۹-۱۷ ۱۰:۲۴» — a
    // Gregorian date, in UTC, to a user whose calendar is Shamsi and whose
    // clock is Tehran.
    expect(FORM_SOURCE).toMatch(/formatJalali\(draft\.savedAt, \{ withTime: true \}\)/);
    expect(FORM_SOURCE).not.toMatch(/savedAt\.slice/);
  });

  it("shows the identity codes in Persian digits like every other number", () => {
    for (const field of [
      "state.generalInfo.nationalId",
      "state.generalInfo.economicCode",
      "state.addressInfo.zipCode",
      "state.financialInfo.cardNumber",
    ]) {
      expect(FORM_SOURCE, field).toContain(`toPersianDigits(${field})`);
    }
  });

  it("does not let maxLength truncate a pasted code before its punctuation is stripped", () => {
    /*
     * `maxLength={10}` on a field whose handler strips dashes meant a pasted
     * «۰۰۱۲-۳۴۵-۶۷۸۹» was cut to ten *characters* first, losing three digits
     * with no sign that anything had been dropped. The slice in the handler is
     * the real limit and it counts digits.
     */
    expect(FORM_SOURCE).not.toMatch(/maxLength=\{10\}[\s\S]{0,200}nationalId/);
    expect(FORM_SOURCE).toMatch(/asciiDigits\(event\.target\.value\)\.slice\(0, 10\)/);
  });
});

describe("the form's own lifecycle", () => {
  it("keeps role and roles consistent when the form is reset", () => {
    /*
     * `{ ...resetPartyForm(), role: scope.defaultRole }` left
     * `roles: ["Customer"]` behind the new `role`, so a reset in the team scope
     * produced `role: "Employee"` with `roles: ["Customer"]` — which fails
     * validation on «نقش‌ها», a field a single-role section never draws. The
     * save button then refused with nothing on screen to explain it.
     */
    expect(FORM_SOURCE).toMatch(/withPartyRoles\(resetPartyForm\(\), openingRoles\)/);
    expect(FORM_SOURCE).not.toMatch(/\.\.\.resetPartyForm\(\), role: scope\.defaultRole/);
  });

  it("does not fork a new draft row on every autosave tick", () => {
    // The interval's closure captured `draftId` from state, so the tick after
    // the first save still saw null and created a second draft, and so on.
    expect(FORM_SOURCE).toMatch(/draftIdRef/);
    expect(FORM_SOURCE).toMatch(/draftId: draftIdRef\.current/);
  });

  it("does not autosave before it knows which business the draft belongs to", () => {
    // Drafts are namespaced per tenant; one saved under "" would be readable by
    // the next business on a shared browser.
    expect(FORM_SOURCE).toMatch(/if \(!businessId\) return;/);
  });

  it("clears the dirty flag after a successful save", () => {
    // Otherwise the unload guard kept firing over changes already stored.
    expect(FORM_SOURCE).toMatch(/setBaseline\(submitted\)/);
  });

  it("asks before replacing a filled form with a draft", () => {
    expect(FORM_SOURCE).toMatch(/partyFormHasUnsavedChanges\(stateRef\.current, baseline\)/);
  });

  it("keeps the save button reachable on a short screen", () => {
    // The dialog is four tabs tall; as one scroller, «ذخیره» sat below the fold
    // on every phone.
    expect(FORM_SOURCE).toMatch(/min-h-0 flex-1 overflow-y-auto/);
    expect(FORM_SOURCE).toMatch(/<DialogFooter className="[^"]*shrink-0/);
  });

  it("describes the dialog for assistive technology", () => {
    // Radix warns at runtime without this, and the warning was earned: the
    // dialog announced only its title.
    expect(FORM_SOURCE).toMatch(/<DialogDescription>/);
  });

  it("never points aria-describedby at an element that is not rendered", () => {
    /*
     * The roles hint was swapped out for the error message, so whenever the
     * group was invalid — the one moment the description matters —
     * `aria-describedby="party-form-roles-hint"` referred to nothing.
     */
    const described = FORM_SOURCE.includes('aria-describedby="party-form-roles-hint"');
    expect(described).toBe(true);
    expect(FORM_SOURCE).toMatch(/<span id="party-form-roles-hint"/);
    // The id lives outside the error/hint ternary, so it always exists.
    expect(FORM_SOURCE).not.toMatch(/\) : roleLocked \? null : \(\s*<span id="party-form-roles-hint"/);
  });

  it("offers the accounting-code hint as a placeholder, not as a value", () => {
    // As a value, «با ذخیره ساخته می‌شود» was Persian prose in a dir="ltr" box
    // that looked like real content and vanished when the mode changed.
    expect(FORM_SOURCE).toMatch(/placeholder=\{state\.accountingCodeMode === "Automatic" \? "با ذخیره ساخته می‌شود"/);
    expect(FORM_SOURCE).not.toMatch(/\? "با ذخیره ساخته می‌شود"\s*: state\.accountingCode/);
  });

  it("uploads a new avatar through the canonical Media Library, not a second client-side base64 encoder (migration 0181)", () => {
    // The form used to read a picked file into a `data:` URL by hand
    // (its own FileReader, its own type/size checks) and store the base64
    // text directly on the party row — a second, unmanaged image store
    // living inside `parties`, duplicating validation the Media Library
    // already does once, centrally, for every other upload in the app.
    // A *new* avatar now always goes through the same `MediaImageField` /
    // `MediaPickerDialog` every catalogue item's photo uses, so this file
    // must not reintroduce its own FileReader-based pick path.
    expect(FORM_SOURCE).toMatch(/MediaImageField/);
    expect(FORM_SOURCE).toMatch(/MediaPickerDialog/);
    expect(FORM_SOURCE).not.toMatch(/new FileReader\(\)/);
    expect(FORM_SOURCE).not.toMatch(/readAsDataURL/);
  });

  it("still renders a legacy inline/linked avatar saved before migration 0181, with a path to move it onto the library", () => {
    // Old rows are never force-migrated (no data loss for an existing
    // `data:`/`https://` value) — the form must keep an `<img>` fallback for
    // `state.profileImage` when no canonical asset id is set yet, alongside
    // an explicit way to replace it with one.
    expect(FORM_SOURCE).toMatch(/state\.profileImage \? \(/);
    expect(FORM_SOURCE).toMatch(/src=\{state\.profileImage\}/);
    expect(FORM_SOURCE).toMatch(/setPickingAvatar\(true\)/);
  });
});

describe("the statement the directory can open", () => {
  it("mounts both ledgers, not only receivables", () => {
    // A supplier row offered «صورتحساب» and opened the *customer* statement,
    // which is an empty table for somebody who only exists in payables.
    expect(SECTION_SOURCE).toMatch(/<ArStatementPanel/);
    expect(SECTION_SOURCE).toMatch(/<ApStatementPanel/);
    expect(SECTION_SOURCE).toMatch(/partyStatementKind/);
  });

  it("offers the button only where the route would answer", () => {
    expect(SECTION_SOURCE).toMatch(/canOpenStatement/);
  });

  it("addresses the A/P statement by the branch alias, not by the party id", () => {
    /*
     * The two ledgers are keyed differently, which is invisible until it is
     * wrong. `arLines` joins `parties` directly, so an A/R statement takes the
     * party id the directory already holds. `apLines` selects `suppliers.id` —
     * the per-branch alias — and carries the party separately as `party_id`.
     *
     * Passing a party id to the A/P panel therefore returns *no rows* rather
     * than an error: a supplier with a full purchase history would have opened
     * a statement reading «رکوردی نیست», which looks like lost data. The map
     * built from `?scope=directory` is the translation.
     */
    expect(SECTION_SOURCE).toMatch(/supplierId=\{supplierAliases\[statement\.id\] \?\? statement\.id\}/);
    expect(SECTION_SOURCE).toMatch(/supplierPartyId=\{statement\.id\}/);
    // The directory scope is the one that lists every supplier, not only those
    // carrying a nonzero balance — a settled supplier still has a statement.
    expect(SECTION_SOURCE).toMatch(/ap\/suppliers\?scope=directory/);
  });

  it("withholds the A/P button when this branch has no supplier row for the party", () => {
    // No alias means the payables ledger has nothing filed under them; better
    // no button than one that opens an empty panel.
    expect(SECTION_SOURCE).toMatch(/if \(kind === "ap" && !supplierAliases\[party\.id\]\) return null;/);
  });

  it("does not request the supplier map for members who cannot open a statement", () => {
    // `/api/ledger/ap/suppliers` is role-gated exactly like the statement, so
    // asking unconditionally would be a guaranteed 403 on a cashier's screen.
    expect(SECTION_SOURCE).toMatch(/if \(!canOpenStatement \|\| !listedRoles\.includes\("Supplier"\)\)/);
  });
});

describe("api() after both fixes for it landed", () => {
  /*
   * `main` fixed this function at the same time and in the same spirit — it
   * stopped rejecting and started returning a `network_error` body. This branch
   * added the `aborted` flag. The merge has to keep both, and in particular
   * must not report a deliberately cancelled request as a network failure.
   */
  it("gives a dropped connection a Persian-mappable error code", () => {
    expect(UI_SOURCE).toMatch(/error: "network_error"/);
  });

  it("does not label a deliberate cancellation as a network failure", () => {
    // Every superseded search would otherwise raise «ارتباط با سرور برقرار
    // نشد» — the normal path, reported as an outage.
    expect(UI_SOURCE).toMatch(/aborted \? \{\} : \{ error: "network_error" \}/);
  });
});
