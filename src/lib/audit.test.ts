import { describe, expect, it } from "vitest";
import { auditActionLabel, auditEntityLabel, credentialKindFromId, credentialKindLabel } from "./audit";

describe("auditActionLabel", () => {
  it("labels a known action", () => {
    expect(auditActionLabel("shift.opened")).toBe("شروع شیفت");
    expect(auditActionLabel("employee.session_created")).toBe("ورود به سیستم");
    expect(auditActionLabel("employee.login_failed")).toBe("تلاش ورود ناموفق");
    expect(auditActionLabel("employee.login_unlocked")).toBe("رفع قفل ورود");
    expect(auditActionLabel("device.renamed")).toBe("تغییر نام دستگاه");
  });

  it("falls back to the raw action for an unrecognised value", () => {
    expect(auditActionLabel("future.thing_happened")).toBe("future.thing_happened");
  });

  it("labels the account change-history actions (issue #160 §7.5)", () => {
    expect(auditActionLabel("account.created")).toBe("ایجاد حساب");
    expect(auditActionLabel("account.renamed")).toBe("تغییر نام حساب");
    expect(auditActionLabel("account.reparented")).toBe("جابه‌جایی حساب در ساختار");
    expect(auditActionLabel("account.archived")).toBe("بایگانی حساب");
    expect(auditActionLabel("account.reactivated")).toBe("بازگردانی حساب از بایگانی");
    expect(auditActionLabel("account.contra_changed")).toBe("تغییر وضعیت حساب کاهنده");
    expect(auditActionLabel("account.deleted")).toBe("حذف حساب");
  });

  it("labels the settings writers, whose rows the audit tab renders", () => {
    expect(auditActionLabel("settings.business.update")).toBe("تغییر اطلاعات کسب‌وکار");
    expect(auditActionLabel("settings.mfa_policy.update")).toBe("تغییر سیاست ورود دومرحله‌ای");
  });

  it("labels fiscal-year and fiscal-period lifecycle events", () => {
    expect(auditActionLabel("fiscal_year.created")).toBe("تعریف سال مالی");
    expect(auditActionLabel("fiscal_period.soft_closed")).toBe("بستن موقت دورهٔ مالی");
    expect(auditActionLabel("fiscal_period.locked")).toBe("قفل‌کردن دورهٔ مالی");
    expect(auditActionLabel("fiscal_period.reopened")).toBe("بازگشایی دورهٔ مالی");
    expect(auditActionLabel("fiscal_year.closed")).toBe("بستن نهایی سال مالی");
  });
});

describe("auditEntityLabel", () => {
  it("labels a known entity", () => {
    expect(auditEntityLabel("shift")).toBe("شیفت");
  });

  it("falls back to a dash when entity is null", () => {
    expect(auditEntityLabel(null)).toBe("—");
  });

  it("falls back to the raw entity for an unrecognised value", () => {
    expect(auditEntityLabel("widget")).toBe("widget");
  });

  it("labels the account entity (issue #160 §7.5)", () => {
    expect(auditEntityLabel("account")).toBe("حساب");
  });

  it("labels fiscal-year and fiscal-period entities", () => {
    expect(auditEntityLabel("fiscal_year")).toBe("سال مالی");
    expect(auditEntityLabel("fiscal_period")).toBe("دورهٔ مالی");
  });

  it("labels commission settlement entities", () => {
    expect(auditEntityLabel("commission_run")).toBe("دورهٔ تسویه پورسانت");
    expect(auditEntityLabel("commission_payout")).toBe("پرداخت پورسانت");
  });
});

describe("credentialKindFromId", () => {
  it("is pin when no credential id is present", () => {
    expect(credentialKindFromId(null)).toBe("pin");
    expect(credentialKindFromId(undefined)).toBe("pin");
  });

  it("is webauthn when a credential id is present", () => {
    expect(credentialKindFromId("11111111-1111-1111-1111-111111111111")).toBe("webauthn");
  });
});

describe("credentialKindLabel", () => {
  it("labels each kind in Persian", () => {
    expect(credentialKindLabel("pin")).toBe("پین");
    expect(credentialKindLabel("webauthn")).toBe("بیومتریک");
  });
});
