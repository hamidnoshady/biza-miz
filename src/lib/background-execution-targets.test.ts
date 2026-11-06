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

  // Issue #1004: one source of truth for the deployment role. `deploymentRole()`
  // infers "site" when DEPLOYMENT_ROLE is unset and trims/lower-cases what it
  // reads; a raw `process.env.DEPLOYMENT_ROLE !== "site"` test skips both, so a
  // site whose role came from inference — or was spelled " Site " — started the
  // central CMS ticks and queued cloud-side entitlement refreshes.
  it("gates central-only work on the resolved deployment role", () => {
    expect(server).toContain('if (runtimeRole !== "site") {');
    expect(server).not.toContain('process.env.DEPLOYMENT_ROLE !== "site"');
    const subscriptions = readFileSync("src/lib/subscription-service.ts", "utf8");
    expect(subscriptions).toContain('if (deploymentRole() !== "site") {');
    expect(subscriptions).not.toContain('process.env.DEPLOYMENT_ROLE !== "site"');
  });

  it("keeps local operational maintenance independent of Cloud", () => {
    for (const tick of ["crmScoringTick", "importQueueTick", "lowStockScan"]) {
      expect(server).toContain(`scheduleBackgroundTick(${tick},`);
    }
  });

  // Issue #807: scheduled tenant backups are two role-specific workers, not one
  // generic tick. A physical tenant `pg_dump` run on central would capture the
  // whole shared database, so the site worker and the central logical-snapshot
  // worker must both be selected at startup from the deployment role.
  it("splits the tenant backup workers by deployment role", () => {
    expect(server).toContain("scheduleSiteTick(siteBackupTick,");
    expect(server).toContain("scheduleCentralTick(tenantSnapshotTick,");
    expect(server).not.toContain("scheduleBackgroundTick(backupTick,");
    expect(server).not.toContain("scheduleBackgroundTick(tenantSnapshotTick,");
  });
});
