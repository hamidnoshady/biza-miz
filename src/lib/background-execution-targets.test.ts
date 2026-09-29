import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const server = readFileSync("server.ts", "utf8");

describe("background execution targets", () => {
  it("keeps site-authoritative durability workers on site runtimes", () => {
    for (const tick of ["rollupTick", "serverSyncTick", "cloudExceptionTick"]) {
      expect(server).toContain(`scheduleSiteTick(${tick},`);
    }
  });

  it("never starts cloud provider workers on Local or Hybrid site runtimes", () => {
    for (const tick of [
      "platformBackupTick", "aiProactiveTick", "wooSyncTick", "websiteSyncTick",
      "websiteBillingTick", "mediaBillingTick", "cmsControlTick", "holooSyncTick",
      "holooPushTick", "holooReconciliationTick", "notificationTick", "messagingTick",
      "scheduledExportTick", "centralSyncTick",
    ]) {
      expect(server).toContain(`scheduleCentralTick(${tick},`);
      expect(server).not.toContain(`scheduleBackgroundTick(${tick},`);
    }
  });

  it("keeps local operational maintenance independent of Cloud", () => {
    for (const tick of ["backupTick", "crmScoringTick", "importQueueTick", "lowStockScan"]) {
      expect(server).toContain(`scheduleBackgroundTick(${tick},`);
    }
  });
});
