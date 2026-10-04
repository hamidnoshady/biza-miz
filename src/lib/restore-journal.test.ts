import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RESTORE_PHASES,
  appendRestoreJournal,
  newRestoreJournalId,
  readRestoreJournal,
  restoreJournalDir,
  restoreJournalFingerprint,
  tryAppendRestoreJournal,
} from "./restore-journal";

/**
 * Issue #807 — the journal that has to survive the database being replaced.
 *
 * The audit's finding was that a whole-system restore recorded its own history
 * in the database it then replaced, so the record could vanish. These tests pin
 * the two properties the engine now depends on: an append either lands durably
 * or throws, and a read never fails because of one bad line.
 */
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "pos-restore-journal-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const entry = (id: string, phase: (typeof RESTORE_PHASES)[number], extra: Record<string, unknown> = {}) =>
  ({
    id,
    phase,
    scope: "platform",
    source: "local",
    artifact: "pos-backup-20260101-000000-abcdef01.dump",
    mode: phase.startsWith("verify") ? ("verify" as const) : ("apply" as const),
    actorId: "11111111-2222-3333-4444-555555555555",
    actorLabel: "owner@example.com",
    ...extra,
  });

describe("restoreJournalDir", () => {
  it("prefers the explicit setting, then the platform dir, then the backup dir", () => {
    expect(restoreJournalDir({ RESTORE_JOURNAL_DIR: "/var/journal" })).toBe("/var/journal");
    expect(
      restoreJournalDir({ PLATFORM_BACKUP_DIR: "/srv/platform", BACKUP_DIR: "/srv/site" }),
    ).toBe(path.join("/srv/platform", "journal"));
    expect(restoreJournalDir({ BACKUP_DIR: "/srv/site" })).toBe(path.join("/srv/site", "journal"));
    expect(restoreJournalDir({})).toBe(path.join(os.tmpdir(), "business-suite-restore-journal"));
    // Blank values are not settings.
    expect(restoreJournalDir({ RESTORE_JOURNAL_DIR: "   ", BACKUP_DIR: " /srv/site " })).toBe(
      path.join("/srv/site", "journal"),
    );
  });
});

describe("appendRestoreJournal", () => {
  it("appends one durable line per phase, oldest first, and reads them back", async () => {
    const id = newRestoreJournalId();
    await appendRestoreJournal(entry(id, "apply_started"), dir);
    await appendRestoreJournal(entry(id, "apply_succeeded", { detail: { tables: 12 } }), dir);

    const history = await readRestoreJournal(dir);
    const mine = history.entries.filter((e) => e.id === id);
    expect(mine.map((e) => e.phase)).toEqual(["apply_started", "apply_succeeded"]);
    expect(mine[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mine[1].detail).toEqual({ tables: 12 });
    expect(history.latestPhase.get(id)).toBe("apply_succeeded");
    expect(history.succeeded.has(id)).toBe(true);
  });

  it("is append-only: a second phase never rewrites the first line", async () => {
    const id = newRestoreJournalId();
    await appendRestoreJournal(entry(id, "verify_started"), dir);
    const before = await readFile(path.join(dir, "restore-journal.jsonl"), "utf8");
    await appendRestoreJournal(entry(id, "verify_failed", { detail: { error: "checksum" } }), dir);
    const after = await readFile(path.join(dir, "restore-journal.jsonl"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.split("\n").filter(Boolean).length).toBeGreaterThan(before.split("\n").filter(Boolean).length);
  });

  it("restricts the file to the owner, and only calls apply_succeeded a success", async () => {
    const mode = (await stat(path.join(dir, "restore-journal.jsonl"))).mode & 0o777;
    expect(mode).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);

    const id = newRestoreJournalId();
    await appendRestoreJournal(entry(id, "apply_rolled_back"), dir);
    expect((await readRestoreJournal(dir)).succeeded.has(id)).toBe(false);
  });

  it("throws — rather than silently dropping a line — when it cannot write", async () => {
    // A *file* where the journal directory should be: mkdir fails, so an
    // `apply_started` that cannot be recorded must never look recorded.
    const blocked = path.join(dir, "blocked");
    await writeFile(blocked, "not a directory");
    await expect(appendRestoreJournal(entry(newRestoreJournalId(), "apply_started"), blocked)).rejects.toThrow();
    expect(await tryAppendRestoreJournal(entry(newRestoreJournalId(), "apply_started"), blocked)).toBe(false);
  });

  it("uses a fresh id per restore and keeps every phase of a state machine", async () => {
    const ids = new Set([newRestoreJournalId(), newRestoreJournalId(), newRestoreJournalId()]);
    expect(ids.size).toBe(3);
    const id = newRestoreJournalId();
    const phases: (typeof RESTORE_PHASES)[number][] = [
      "verify_started",
      "verify_succeeded",
      "apply_started",
      "apply_failed_before_swap",
      "post_restore_reconnect_failed",
    ];
    for (const phase of phases) await appendRestoreJournal(entry(id, phase), dir);
    const history = await readRestoreJournal(dir);
    expect(history.entries.filter((e) => e.id === id).map((e) => e.phase)).toEqual(phases);
    expect(history.latestPhase.get(id)).toBe("post_restore_reconnect_failed");
  });

  it("skips a torn last line instead of failing the whole read", async () => {
    const tornDir = await mkdtemp(path.join(os.tmpdir(), "pos-restore-journal-torn-"));
    try {
      const id = newRestoreJournalId();
      await appendRestoreJournal(entry(id, "apply_started"), tornDir);
      const file = path.join(tornDir, "restore-journal.jsonl");
      await fs.appendFile(file, '{"id":"torn","phase":"apply_succ');
      const history = await readRestoreJournal(tornDir);
      expect(history.entries.map((e) => e.id)).toEqual([id]);
      expect(history.latestPhase.get(id)).toBe("apply_started");
    } finally {
      await rm(tornDir, { recursive: true, force: true });
    }
  });

  it("returns an empty history for a directory that does not exist", async () => {
    const history = await readRestoreJournal(path.join(dir, "never-created"));
    expect(history.entries).toEqual([]);
    expect(history.succeeded.size).toBe(0);
  });

  it("caps how much history it hands back, newest entries first", async () => {
    const manyDir = await mkdtemp(path.join(os.tmpdir(), "pos-restore-journal-many-"));
    try {
      for (let i = 0; i < 5; i += 1) {
        await appendRestoreJournal(entry(`id-${i}`, "verify_started"), manyDir);
      }
      const history = await readRestoreJournal(manyDir, 2);
      expect(history.entries.map((e) => e.id)).toEqual(["id-3", "id-4"]);
    } finally {
      await rm(manyDir, { recursive: true, force: true });
    }
  });
});

describe("restoreJournalFingerprint", () => {
  it("is stable and distinguishable without leaking the artifact name", () => {
    const base = { source: "cloud", artifact: "pos-backup-20260101-000000-abcdef01.dump.enc", mode: "apply" as const };
    const first = restoreJournalFingerprint(base);
    expect(first).toBe(restoreJournalFingerprint(base));
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(restoreJournalFingerprint({ ...base, mode: "verify" })).not.toBe(first);
    expect(restoreJournalFingerprint({ ...base, source: "peer" })).not.toBe(first);
    expect(restoreJournalFingerprint({ ...base, artifact: "pos-backup-20260102-000000-abcdef01.dump.enc" })).not.toBe(first);
    expect(first).not.toContain("pos-backup");
  });
});
