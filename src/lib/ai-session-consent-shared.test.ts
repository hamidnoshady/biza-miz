import { describe, expect, it } from "vitest";
import { AI_SESSION_CONSENT_ACTIONS, canGrantAiSessionConsent } from "./ai-session-consent-shared";

describe("session-bound consent never broadens business authority", () => {
  it("only supports explicitly reviewed low-risk actions", () => {
    expect(AI_SESSION_CONSENT_ACTIONS).toEqual(["task.status"]);
    expect(canGrantAiSessionConsent("task.status")).toBe(true);
  });

  it("denies financial, deletion and role changes even if proposed by an agent", () => {
    for (const action of [
      "payment.create", "crm.note.delete", "branch.lifecycle",
      "payroll.run", "settings.role.update", "", null,
    ]) {
      expect(canGrantAiSessionConsent(action)).toBe(false);
    }
  });
});
