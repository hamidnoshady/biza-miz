// @vitest-environment jsdom
/**
 * Issue #903 §2 item 4 — the Owner's recovery affordances on the inventory.
 *
 * Two things here are worth pinning: a download is authorised by a ticket minted
 * over `POST`, never by a plain link to the bytes, and the import panel is only
 * offered where the server can actually accept a file (managed profiles, Owner
 * only). Everything else on the card is older behaviour.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactInventoryCard } from "./artifact-inventory";

const assign = vi.fn();

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, assign, search: "", href: "http://localhost/dashboard/backup" },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function item(overrides: Record<string, unknown> = {}) {
  return {
    ref: "ref-abc",
    capturedAt: "2026-10-27T03:30:00.000Z",
    origin: "uploaded",
    format: "logical_snapshot",
    destinations: [{ destination: "local", state: "ready", storedBytes: 2048, available: true, verified: true }],
    payloadBytes: 2048,
    storedBytes: 2048,
    state: "ready",
    integrity: "verified",
    completeness: "complete",
    encryption: "managed",
    retentionUntil: null,
    lastRestoreAt: null,
    available: true,
    downloadable: true,
    restorable: true,
    ...overrides,
  };
}

function inventory(profile: "cloud" | "hybrid" | "local", overrides: Record<string, unknown> = {}) {
  return {
    profile,
    connectivity: "online",
    items: [item(overrides)],
    total: 1,
    page: 1,
    pageSize: 20,
    pages: 1,
    includedBytes: 2048,
    summary: {
      latestCompletedAt: "2026-10-27T03:30:00.000Z",
      latestVerifiedAt: "2026-10-27T03:30:00.000Z",
      readyCount: 1,
      partialCount: 0,
      failedCount: 0,
      expiredCount: 0,
      pendingCount: 0,
      cloudBytes: 0,
      includedBytes: 2048,
    },
    labels: {
      state: {
        ready: "آماده",
        uploading: "در حال بارگذاری",
        verifying: "در حال بررسی",
        failed: "ناموفق",
        expired: "منقضی",
        unavailable_offline: "در دسترس نیست",
      },
      format: { physical_dump: "نسخهٔ فیزیکی", logical_snapshot: "نسخهٔ منطقی" },
      origin: { scheduled: "زمان‌بندی‌شده", manual: "دستی", uploaded: "بارگذاری‌شده" },
      completeness: { complete: "کامل", partial: "ناقص" },
    },
  };
}

describe("artifact inventory — recovery affordances", () => {
  it("mints a download ticket before handing the browser to the bytes", async () => {
    const user = userEvent.setup();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        calls.push(String(url));
        if (String(url).endsWith("/api/backup/artifacts/ref-abc/download")) {
          return new Response(JSON.stringify({ ticket: "ticket-1", expiresIn: 120, destination: "local" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify(inventory("hybrid")), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );

    render(<ArtifactInventoryCard isOwner />);
    await user.click(await screen.findByRole("button", { name: "نسخه" }));

    await waitFor(() => expect(assign).toHaveBeenCalled());
    const posted = calls.filter((url) => url.endsWith("/api/backup/artifacts/ref-abc/download"));
    expect(posted).toHaveLength(1);
    expect(assign.mock.calls[0][0]).toBe("/api/backup/artifacts/ref-abc/download?ticket=ticket-1");
  });

  it("does not offer download for an artifact that is not downloadable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(inventory("cloud", { editable: false, downloadable: false })), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    render(<ArtifactInventoryCard isOwner />);
    expect(((await screen.findByRole("button", { name: "نسخه" })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers the file-recovery panel on managed profiles only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(inventory("local")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    render(<ArtifactInventoryCard isOwner />);
    await screen.findByRole("button", { name: "نسخه" });
    expect(screen.queryByText("بازگردانی از فایل پشتیبان")).toBeNull();
  });

  it("hides the panel from a non-Owner", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(inventory("hybrid")), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    render(<ArtifactInventoryCard isOwner={false} />);
    await screen.findByRole("row", { name: /آماده/ });
    // A Manager may see that the business is protected, but neither takes a copy
    // of its records nor starts a restore of them.
    expect(screen.queryByText("بازگردانی از فایل پشتیبان")).toBeNull();
    expect(screen.queryByRole("button", { name: "نسخه" })).toBeNull();
    expect(screen.queryByRole("button", { name: "شناسنامه" })).toBeNull();
  });
});
