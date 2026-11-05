// @vitest-environment jsdom
/**
 * Issue #903 §2 item 4 — the file-recovery panel.
 *
 * What matters here is not the layout but the two promises the panel makes: the
 * manifest file is what gets sent (not something derived in the browser), and a
 * refusal from the server is shown as the server's own reason rather than a
 * cheerful "done".
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECOVERY_IMPORT_ERRORS, RecoveryFilePanel, recoveryImportError } from "./recovery-file-panel";
import { IMPORT_REFUSALS, type ImportRefusal } from "@/lib/tenant-backup-import";

vi.mock("@/lib/restore-upload-client", () => ({
  uploadRestoreFile: vi.fn(async () => ({ ok: true, uploadId: "3f0b0c1a-0000-4000-8000-000000000001" })),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

/**
 * jsdom's `File` has no `text()` (browsers do). Give the fixture the method the
 * panel uses instead of weakening the panel for a test environment.
 */
function readable(file: File, text: string): File {
  Object.defineProperty(file, "text", { value: async () => text });
  return file;
}

function pickFiles() {
  const payload = new File(["ciphertext"], "backup.backup.enc", { type: "application/octet-stream" });
  const manifest = readable(
    new File(['{"kind":"biza-miz-backup-manifest"}'], "backup.manifest.json", { type: "application/json" }),
    '{"kind":"biza-miz-backup-manifest"}',
  );
  return { payload, manifest };
}

describe("RecoveryFilePanel", () => {
  it("sends the chosen manifest and the uploaded id, then hands over the new reference", async () => {
    const user = userEvent.setup();
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push({ url: String(url), body: init?.body });
        return new Response(JSON.stringify({ ref: "ref-imported", capturedAt: "2026-10-27T03:30:00.000Z" }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }),
    );
    const onImported = vi.fn();
    const { payload, manifest } = pickFiles();

    render(<RecoveryFilePanel onImported={onImported} />);
    await user.upload(screen.getByLabelText("فایل نسخهٔ پشتیبان"), payload);
    await user.upload(screen.getByLabelText("فایل شناسنامه (.manifest.json)"), manifest);
    await user.click(screen.getByRole("button", { name: "بارگذاری و بررسی فایل" }));

    await waitFor(() => expect(onImported).toHaveBeenCalledWith("ref-imported"));
    const importCall = bodies.find((entry) => (entry as { url: string }).url.endsWith("/api/backup/restores/import"));
    const body = JSON.parse(String((importCall as { body: string }).body)) as {
      uploadId: string;
      manifest: string;
      passphrase: string;
    };
    expect(body.uploadId).toBe("3f0b0c1a-0000-4000-8000-000000000001");
    // The manifest travels as it was saved: the browser never re-writes it.
    expect(body.manifest).toBe('{"kind":"biza-miz-backup-manifest"}');
    expect(body.passphrase).toBe("");
    expect(screen.getByText(/فایل پذیرفته و بررسی شد/)).toBeTruthy();
  });

  it("shows the server's refusal in the Owner's words and registers nothing", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "recovery_checksum_mismatch" }), {
            status: 422,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const onImported = vi.fn();
    const { payload, manifest } = pickFiles();

    render(<RecoveryFilePanel onImported={onImported} />);
    await user.upload(screen.getByLabelText("فایل نسخهٔ پشتیبان"), payload);
    await user.upload(screen.getByLabelText("فایل شناسنامه (.manifest.json)"), manifest);
    await user.click(screen.getByRole("button", { name: "بارگذاری و بررسی فایل" }));

    await waitFor(() => expect(screen.getByText(recoveryImportError("recovery_checksum_mismatch"))).toBeTruthy());
    expect(onImported).not.toHaveBeenCalled();
  });

  it("cannot be started without both files", () => {
    render(<RecoveryFilePanel onImported={vi.fn()} />);
    const button = screen.getByRole("button", { name: "بارگذاری و بررسی فایل" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it("has an Owner-facing sentence for every refusal the import engine can return", () => {
    // Pinned so a new refusal cannot ship as a generic "it failed": the map is
    // the only place the server's vocabulary becomes words an Owner can act on.
    for (const refusal of [...IMPORT_REFUSALS, "recovery_import_unavailable"] as ImportRefusal[]) {
      expect(RECOVERY_IMPORT_ERRORS[refusal], refusal).toBeTruthy();
      expect(RECOVERY_IMPORT_ERRORS[refusal]).not.toContain(refusal);
    }
  });

  it("falls back to a neutral refusal for a code it does not know", () => {
    expect(recoveryImportError("something_internal")).toContain("ناموفق");
    expect(recoveryImportError("something_internal")).not.toContain("something_internal");
  });
});
