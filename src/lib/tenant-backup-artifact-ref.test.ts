import { expect, it } from "vitest";
import { tenantBackupArtifactRef, tenantRestoreError } from "./tenant-backup-artifact-ref";

it("binds opaque references to business, destination and exact artifact", () => {
  const ref = tenantBackupArtifactRef("a", "cloud", "private-prefix/backup.enc");
  expect(ref).toMatch(/^[a-f0-9]{64}$/);
  expect(ref).toBe(tenantBackupArtifactRef("a", "cloud", "private-prefix/backup.enc"));
  expect(ref).not.toBe(tenantBackupArtifactRef("b", "cloud", "private-prefix/backup.enc"));
  expect(ref).not.toBe(tenantBackupArtifactRef("a", "local", "private-prefix/backup.enc"));
  expect(ref).not.toBe(tenantBackupArtifactRef("a", "cloud", "private-prefix/other.enc"));
});
it("only returns explicitly safe restore errors", () => {
  expect(tenantRestoreError("artifact_not_found")).toBe("artifact_not_found");
  expect(tenantRestoreError("download_failed:https://vendor/secret")).toBe("backup_operation_failed");
  expect(tenantRestoreError("password=secret")).toBe("backup_operation_failed");
});
