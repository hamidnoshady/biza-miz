import { beforeEach, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  permission: vi.fn(),
  config: vi.fn(),
  save: vi.fn(),
  aliased: vi.fn(),
  policy: vi.fn(),
  role: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  withTenantScope: (fn: unknown) => fn,
  requirePermission: mocks.permission,
}));
vi.mock("@/lib/backup-service", () => ({
  getBackupConfig: mocks.config,
  setBackupConfig: mocks.save,
  aliasedBackupDestination: mocks.aliased,
}));
vi.mock("@/lib/tenant-backup-storage", () => ({ resolveTenantBackupPolicy: mocks.policy }));
vi.mock("@/lib/deployment-role", () => ({ deploymentRole: mocks.role }));

import { GET, PUT } from "./route";

const session = { businessId: "business-a", sub: "user-a" };

function config(patch: Record<string, unknown> = {}) {
  return {
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    localRetention: 14,
    directory: "/srv/backups",
    secondaryDirectory: "",
    passphrase: "secret-passphrase",
    encryptLocal: true,
    cloud: {
      enabled: false,
      endpoint: "",
      region: "us-east-1",
      bucket: "",
      prefix: "pos-backups/",
      accessKeyId: "",
      secretAccessKey: "",
      passphrase: "",
      retention: 30,
    },
    ...patch,
  };
}

function put(body: unknown) {
  return PUT(
    new NextRequest("http://app/api/setup/backup", {
      method: "PUT",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.permission.mockResolvedValue({ session });
  mocks.config.mockResolvedValue(config());
  mocks.save.mockResolvedValue(undefined);
  mocks.aliased.mockReturnValue(false);
  mocks.policy.mockResolvedValue({
    intervalHours: 24,
    retentionDays: 30,
    maxRetentionDays: 365,
    keepCount: 30,
    source: "default",
    managedCloud: false,
  });
  mocks.role.mockReturnValue("site");
});

/**
 * The wizard is the only remaining writer of on-device backup defaults
 * (issue #903 §1: "safe on-device defaults"), and it only exists on a
 * single-business site install.
 */
it("refuses a central install, where the fleet policy is the only schedule", async () => {
  mocks.role.mockReturnValue("central");
  const response = await put({ enabled: true, intervalHours: 24, anchorTime: "03:30" });
  expect(response.status).toBe(403);
  await expect(response.json()).resolves.toEqual({ error: "not_site_install" });
  expect(mocks.save).not.toHaveBeenCalled();
});

it("requires the owner's configuration capability", async () => {
  mocks.permission.mockResolvedValue({
    error: NextResponse.json({ error: "forbidden" }, { status: 403 }),
  });
  expect((await GET()).status).toBe(403);
  expect(mocks.save).not.toHaveBeenCalled();
});

it("persists the wizard's local folder choices on a site install", async () => {
  const response = await put({
    enabled: true,
    intervalHours: 24,
    anchorTime: "04:00",
    localRetention: 21,
    directory: "/mnt/usb/backups",
    secondaryDirectory: "/mnt/nas/backups",
  });
  await expect(response.json()).resolves.toEqual({ ok: true });
  expect(mocks.save).toHaveBeenCalledWith(
    "business-a",
    expect.objectContaining({
      anchorTime: "04:00",
      localRetention: 21,
      directory: "/mnt/usb/backups",
      secondaryDirectory: "/mnt/nas/backups",
      // Not accepted in the body, so the existing secret is carried over.
      passphrase: "secret-passphrase",
    }),
  );
});

it("refuses a body that tries to set cloud credentials through the wizard", async () => {
  const response = await put({
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    cloud: { endpoint: "https://s3.example", bucket: "b" },
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "managed_backup_settings_only" });
  expect(mocks.save).not.toHaveBeenCalled();
});

it("refuses two destinations that are the same path", async () => {
  mocks.aliased.mockReturnValue(true);
  const response = await put({
    enabled: true,
    intervalHours: 24,
    anchorTime: "03:30",
    directory: "/mnt/one",
    secondaryDirectory: "/mnt/one",
  });
  expect(response.status).toBe(400);
  await expect(response.json()).resolves.toEqual({ error: "backup_directories_must_differ" });
});

it("reads the current defaults plus the policy in force", async () => {
  const body = await (await GET()).json();
  expect(body).toMatchObject({
    siteInstall: true,
    config: { anchorTime: "03:30", localRetention: 14, directory: "/srv/backups" },
    policy: { intervalHours: 24, retentionDays: 30 },
  });
});
