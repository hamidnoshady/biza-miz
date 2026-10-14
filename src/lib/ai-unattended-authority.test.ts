import { describe, expect, it } from "vitest";
import {
  isDeferrableDenial,
  UNATTENDED_DENIAL_FA,
  verifyUnattendedAuthority,
  type UnattendedAuthorityVerdict,
} from "./ai-unattended-authority";
import type { ActionType } from "./ai";

function verdict(partial: Partial<UnattendedAuthorityVerdict>): UnattendedAuthorityVerdict {
  return {
    ok: false,
    userId: "user-1",
    permissions: new Set(),
    reasonCode: "missing_permission",
    reasonFa: "…",
    targetLocationId: null,
    ...partial,
  };
}

describe("issue #812 §13 — the unattended authority gate", () => {
  describe("verifyUnattendedAuthority fails closed", () => {
    it("refuses a run with no stored authorizer at all", async () => {
      const result = await verifyUnattendedAuthority({
        businessId: "biz-1",
        authorizedByUserId: null,
        actionType: "order.discount.apply" as ActionType,
      });
      expect(result.ok).toBe(false);
      expect(result.reasonCode).toBe("no_authorizing_user");
      // A run that never had a delegation is not deferrable — nothing to undo.
      expect(isDeferrableDenial(result)).toBe(false);
    });
  });

  describe("the deferrable/failed distinction", () => {
    it("treats a revoked member as deferrable so a human can still apply it", () => {
      for (const reasonCode of [
        "authorizer_inactive",
        "business_not_active",
        "missing_permission",
        "location_forbidden",
        "feature_unavailable",
      ] as const) {
        const v = verdict({ reasonCode });
        expect(isDeferrableDenial(v), reasonCode).toBe(true);
      }
    });

    it("treats a vanished authorizer as a hard failure", () => {
      const v = verdict({ reasonCode: "authorizer_not_found" });
      expect(isDeferrableDenial(v)).toBe(true);
      const v2 = verdict({ reasonCode: "no_authorizing_user" });
      expect(isDeferrableDenial(v2)).toBe(false);
    });

    it("never defers an allowed verdict", () => {
      expect(isDeferrableDenial(verdict({ ok: true, reasonCode: null }))).toBe(false);
    });
  });

  describe("every denial has a Persian explanation", () => {
    it("covers each denial code", () => {
      for (const [code, message] of Object.entries(UNATTENDED_DENIAL_FA)) {
        expect(message.trim().length, code).toBeGreaterThan(0);
      }
    });
  });
});
