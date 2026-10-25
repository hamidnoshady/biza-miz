import { describe, expect, it } from "vitest";
import { errorMessage } from "./ui";

describe("order error messages", () => {
  // Issue #1123: a refusal the server names must never reach staff as the
  // generic «خطای غیرمنتظره».
  it.each([
    "manager_approval_required",
    "order_not_open",
    "order_not_found",
    "item_not_found",
    "item_not_available",
    "invalid_item",
    "invalid_modifier",
  ])("names %s", (code) => {
    expect(errorMessage(code)).not.toContain("غیرمنتظره");
  });

  it("explains that a post-kitchen change needs a manager", () => {
    expect(errorMessage("manager_approval_required")).toContain("مدیر");
  });
});
