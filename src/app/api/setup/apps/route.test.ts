/**
 * Issue #1239 / ESH-90 — the gallery endpoint's write is a draft selection.
 *
 * The route-level guard is worth its own test because the product promise is
 * negative: selecting an app must not call the paid activation path or move
 * wallet money. A future "just activate it here" shortcut fails this file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import * as auth from "@/lib/auth";
import * as setupState from "@/lib/setup-state";
import * as service from "@/lib/setup-apps-service";
import * as activation from "@/lib/service-activation/activation-service";
import * as wallet from "@/lib/wallet-service";
import { GET, PUT } from "./route";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    withTenantScope: (handler: (...args: unknown[]) => Promise<NextResponse>) => handler,
  };
});
vi.mock("@/lib/setup-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/setup-state")>();
  return { ...actual, requireManager: vi.fn() };
});
vi.mock("@/lib/setup-apps-service", () => ({
  getSetupAppCatalog: vi.fn(),
  saveSelectedSetupApps: vi.fn(),
}));
vi.mock("@/lib/service-activation/activation-service", () => ({
  activateService: vi.fn(),
}));
vi.mock("@/lib/wallet-service", () => ({
  postWalletEntryTx: vi.fn(),
  chargeFeatureUse: vi.fn(),
}));

const SESSION = { businessId: "biz-1", sub: "user-1" };
const CATALOG = {
  industry: "food_service",
  deploymentProfile: "cloud",
  currencyDisplay: "toman",
  walletBalanceRial: 0,
  selected: ["accounting"],
  cards: [],
  totals: { setupRial: 0, estimated24hRial: 0 },
};

function request(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(setupState.requireManager).mockResolvedValue({ session: SESSION, error: null } as never);
  vi.mocked(service.getSetupAppCatalog).mockResolvedValue(CATALOG as never);
  vi.mocked(service.saveSelectedSetupApps).mockResolvedValue({
    ok: true,
    selected: ["accounting"],
  });
});

describe("/api/setup/apps", () => {
  it("saves the draft selection without activating or debiting", async () => {
    const response = await PUT(request({ apps: ["accounting"] }));

    expect(response.status).toBe(200);
    expect(service.saveSelectedSetupApps).toHaveBeenCalledWith("biz-1", ["accounting"]);
    expect(activation.activateService).not.toHaveBeenCalled();
    expect(wallet.postWalletEntryTx).not.toHaveBeenCalled();
    expect(wallet.chargeFeatureUse).not.toHaveBeenCalled();
  });

  it("rejects an unknown app key and writes nothing", async () => {
    const response = await PUT(request({ apps: ["accounting", "not-an-app"] }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_app" });
    expect(service.saveSelectedSetupApps).not.toHaveBeenCalled();
    expect(activation.activateService).not.toHaveBeenCalled();
  });

  it("returns the live catalogue on GET", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(CATALOG);
    expect(service.getSetupAppCatalog).toHaveBeenCalledWith("biz-1");
  });
});
