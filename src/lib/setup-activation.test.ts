import { describe, expect, it } from "vitest";
import { activatableApps } from "./setup-activation";
import type { SetupImportCandidate, SetupImportUnavailableReason } from "./setup-imports";

function candidate(
  appKey: SetupImportCandidate["appKey"],
  reason: SetupImportUnavailableReason | null,
  label = "برنامه",
): SetupImportCandidate {
  return {
    key: `entity-${label}`,
    module: "accounting",
    label: "داده",
    description: "",
    importable: true,
    granted: true,
    moduleLabel: "حسابداری",
    appKey,
    appLabel: appKey ? label : null,
    available: reason === null,
    stagingAllowed: true,
    reason,
    reasonLabel: null,
  };
}

describe("activatableApps", () => {
  it("offers only selected-but-inactive apps, once each, in first-seen order", () => {
    const apps = activatableApps([
      candidate("accounting", "awaiting_activation", "حسابداری"),
      candidate("accounting", "awaiting_activation", "حسابداری"),
      candidate("crm", "grant_inactive", "CRM"),
      candidate("website", "app_not_selected", "وب‌سایت"),
      candidate("growth", "service_suspended", "رشد"),
    ]);
    expect(apps).toEqual([
      { appKey: "accounting", label: "حسابداری" },
      { appKey: "crm", label: "CRM" },
    ]);
  });

  it("never treats a Workspace target as an app activation", () => {
    const workspace = {
      ...candidate(null, "awaiting_activation", "میز کار"),
      module: "workspace" as const,
    };
    expect(activatableApps([workspace])).toEqual([]);
  });

  it("offers nothing when everything is available or blocked for another reason", () => {
    expect(
      activatableApps([
        candidate("accounting", null),
        candidate("crm", "permission"),
        candidate("website", "industry_module"),
        candidate("growth", "service_disabled"),
      ]),
    ).toEqual([]);
  });
});
