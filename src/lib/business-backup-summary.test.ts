import { expect, it } from "vitest";
import { businessBackupSummary } from "./business-backup-summary";
import type { BackupRunRow } from "./backup-service";

const local: BackupRunRow = {
  id: "run-local", kind: "local", trigger: "manual", status: "success", scope: "physical",
  artifact: "/private/backup.dump", cloudKey: "secret-prefix/key", sizeBytes: 123,
  error: "secret provider details", startedAt: "2026-10-22T00:00:00Z", finishedAt: null,
};
it("does not turn generation into an availability or recovery guarantee", () => {
  const summary = businessBackupSummary("hybrid", [local]);
  expect(summary.deviceAvailability).toBe("unknown");
  expect(summary.runs[0].availability).toBe("unverified");
  expect(summary.runs[0].hasError).toBe(true);
  expect(JSON.stringify(summary)).not.toContain("secret");
  expect(JSON.stringify(summary)).not.toContain("/private");
});
it("hides cloud records for a local-only profile", () => {
  expect(businessBackupSummary("local", [local, { ...local, id: "cloud", kind: "cloud" }]).runs.map((r) => r.id)).toEqual(["run-local"]);
});
it("does not disguise historical cloud-local persistence", () => {
  expect(businessBackupSummary("cloud", [local]).runs[0].destination).toBe("local");
  expect(businessBackupSummary("cloud", []).deviceAvailability).toBe("not_applicable");
});
