/**
 * Issue #924 F10 — the bound is enforced on every writer, not just the screen.
 *
 * The HTTP route rejects an amount the price columns cannot hold; an AI caller
 * reached `quickUpdatePrices` through a different door. That door only checked
 * `Number.isFinite`, so an over-range amount fell out of the service as
 * `{ changed: 0 }`, which an autopilot reports as "nothing to do" rather than a
 * refused value.
 */
import { describe, expect, it } from "vitest";
import { AUTOPILOT_EXECUTORS } from "./ai-autopilot-executors";
import { MAX_AMOUNT } from "./price-lists-service";

/** The executor validates the payload before it resolves a branch or a DB row. */
function run(payload: Record<string, unknown>) {
  return AUTOPILOT_EXECUTORS.priceListQuickUpdate({
    businessId: "00000000-0000-4000-8000-000000000001",
    authorizedByUserId: "00000000-0000-4000-8000-000000000002",
    payload,
  });
}

describe("priceList.quick_update value bounds (F10)", () => {
  it("refuses an over-range amount instead of reporting a no-op", async () => {
    const result = await run({
      target: { kind: "sale" },
      mode: "amount",
      value: MAX_AMOUNT + 1,
      scope: { kind: "all" },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_value" });
  });

  it("refuses a percentage outside the documented window", async () => {
    const result = await run({
      target: { kind: "sale" },
      mode: "percent",
      value: -500,
      scope: { kind: "all" },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_value" });
  });

  it("refuses a fractional Rial amount", async () => {
    const result = await run({
      target: { kind: "sale" },
      mode: "amount",
      value: 1_500.5,
      scope: { kind: "all" },
    });
    expect(result).toMatchObject({ ok: false, errorCode: "invalid_value" });
  });
});
