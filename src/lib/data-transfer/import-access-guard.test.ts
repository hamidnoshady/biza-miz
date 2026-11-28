/**
 * GitHub #1580 — the mutation boundaries are guarded in source.
 *
 * `import-access.test.ts` proves the decision matrix; this file proves the
 * engine actually *asks* it at each boundary the issue names (discovery is the
 * route's read model, approval/enqueue is `queueImportJob`, execution is
 * `runImportJob`, and a running job revalidates before each page of writes).
 *
 * Static source assertions are the same technique `api-guards.test.ts` uses for
 * route authorization: these are facts about *which caller passes what*, not a
 * behaviour a unit test can observe without standing up a database worker.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const IMPORT_SERVICE = source("src/lib/data-transfer/import-service.ts");

describe("Data Transfer import boundaries check effective access", () => {
  it("allows staging (upload/mapping/preview) but not applying", () => {
    const create = IMPORT_SERVICE.slice(
      IMPORT_SERVICE.indexOf("export async function createImportJob"),
      IMPORT_SERVICE.indexOf("export async function previewImportJob"),
    );
    expect(create).toContain("assertImportStagingAllowed(input.businessId, entity)");
    // Staging writes the engine's own rows only; it must not require the
    // destination service to be active.
    expect(create).not.toContain("assertImportServiceOperational");
  });

  it("revalidates on queue (approval/enqueue) and on execution", () => {
    const queue = IMPORT_SERVICE.slice(
      IMPORT_SERVICE.indexOf("export async function queueImportJob"),
      IMPORT_SERVICE.indexOf("export interface ImportRunResult"),
    );
    expect(queue).toContain("assertImportServiceOperational");

    const retry = IMPORT_SERVICE.slice(
      IMPORT_SERVICE.indexOf("export async function retryFailedRows"),
      IMPORT_SERVICE.indexOf("export async function cancelImportJob"),
    );
    expect(retry).toContain("assertImportServiceOperational");

    const run = IMPORT_SERVICE.slice(
      IMPORT_SERVICE.indexOf("export async function runImportJob"),
      IMPORT_SERVICE.indexOf("type ReconciledItemDecisionRow"),
    );
    // Once before the run, and once before every page's write boundary — the
    // "entitlement expires mid-import" contract.
    const calls = run.split("assertImportServiceOperational").length - 1;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(run).toContain("for (;;) {");
  });

  it("parks an access-denied mid-run job instead of retrying it hot", () => {
    expect(IMPORT_SERVICE).toContain("error instanceof ImportAccessDeniedError");
    expect(IMPORT_SERVICE).toContain("status = 'failed'");
  });

  it("maps the refusal to distinct API codes and a Persian message", () => {
    const guard = source("src/app/api/data/guard.ts");
    for (const code of [
      "service_not_selected",
      "service_not_activated",
      "service_grant_inactive",
      "service_suspended",
      "service_unavailable",
    ]) {
      expect(guard, code).toContain(code);
    }
    expect(guard).toContain("ImportAccessDeniedError");
    expect(guard).toContain("message: access.label");
  });
});

describe("the wizard's read model uses the canonical service axes", () => {
  it("resolves access from activation/grant/Workspace, not the saved selection alone", () => {
    const route = source("src/app/api/setup/imports/route.ts");
    expect(route).toContain("importAccessForTargets");
    expect(route).toContain("access: decisions[index]");
    // The old selection-only shortcut must not come back as the wizard's gate.
    expect(route).not.toContain("candidate.available).map((candidate) => candidate.key)");
  });

  it("the service reads the canonical tables, one axis each", () => {
    const service = source("src/lib/import-access-service.ts");
    expect(service).toContain("getSelectedSetupApps");
    expect(service).toContain("appServiceActivationState");
    expect(service).toContain("readActiveComplimentaryGrant");
    expect(service).toContain("workspaceAccessFor");
    expect(service).toContain("effectiveAppAvailability");
  });
});
