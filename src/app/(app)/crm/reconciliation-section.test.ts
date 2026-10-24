import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/app/(app)/crm/reconciliation-section.tsx", "utf8");

describe("CRM reconciliation decisions", () => {
  it("requires an explicit confirmation before posting any identity decision", () => {
    expect(source).toContain("setPendingDecision({ profile, action, partyId, message })");
    expect(source).toContain("onDecide={requestDecision}");
    expect(source).toContain("<Dialog open={pendingDecision !== null}");
    expect(source).toContain("تأیید و ثبت تصمیم");
    expect(source).toContain("const decision = pendingDecision;");
  });

  it("warns that decisions do not merge people or create marketing consent", () => {
    expect(source).toContain("این پیوند به‌تنهایی مشتریان را ادغام نمی‌کند و رضایت بازاریابی ایجاد نمی‌کند");
  });
});
