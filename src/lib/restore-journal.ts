/**
 * Issue #807 — the durable restore journal.
 *
 * A whole-system restore replaces the database that holds the audit table it
 * would write its own history into. The old flow inserted a `platform_restore_runs`
 * row, swapped the database, then updated that row — by which point the row
 * usually belonged to a snapshot that no longer existed. The most destructive
 * operation in the product could therefore succeed with no record of it, and its
 * audit write could fail *after* the database had already been replaced.
 *
 * The fix is a journal that lives **outside the target database**: one
 * append-only JSON Lines file per deployment, in a directory the restore never
 * touches, fsynced on every phase. It records the whole state machine — verify
 * started/failed/succeeded, apply started/failed-before-swap/rolled-back/
 * succeeded, post-restore reconnect succeeded/failed — keyed by a journal id
 * that also travels into the restored database's receipt row so the two halves
 * can be matched up.
 *
 * Guarantees the restore engine relies on:
 *
 *   • `appendRestoreJournal` either durably appends the line or throws. The
 *     engine refuses to start a destructive apply whose `apply_started` line
 *     could not be written — a destructive act that cannot be recorded does not
 *     happen.
 *   • The journal is append-only; nothing here ever rewrites or truncates it.
 *   • Reads tolerate a torn last line (a crash mid-append), so a partially
 *     written entry can never make the whole history unreadable.
 */
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Every state a restore can be observed in — the state machine, spelled out. */
export const RESTORE_PHASES = [
  "verify_started",
  "verify_failed",
  "verify_succeeded",
  "apply_started",
  "apply_failed_before_swap",
  "apply_rolled_back",
  "apply_succeeded",
  "post_restore_reconnect_succeeded",
  "post_restore_reconnect_failed",
] as const;

export type RestorePhase = (typeof RESTORE_PHASES)[number];

export interface RestoreJournalEntry {
  /** the journal id, also stored in the restored database's receipt row */
  id: string;
  at: string;
  phase: RestorePhase;
  /** "platform" (super-admin console) or the tenant scope it was run for */
  scope: string;
  source: string;
  artifact: string;
  mode: "verify" | "apply";
  /** `platform_admins.id` as seen *before* the swap, when there was one */
  actorId: string | null;
  /** human label that survives the actor row disappearing in the restore */
  actorLabel: string | null;
  /** free-form, small: refusal code, error text, summary numbers */
  detail?: Record<string, unknown>;
}

/** A journal read back: the entries plus an index of each id's latest phase. */
export interface RestoreJournalHistory {
  entries: RestoreJournalEntry[];
  /** id → the newest phase recorded for it */
  latestPhase: Map<string, RestorePhase>;
  /** ids whose latest phase is a success (a durable receipt exists somewhere) */
  succeeded: Set<string>;
}

/**
 * Where the journal lives. Deliberately *outside* the backup directory's
 * retention paths and never under the database's control:
 *
 *   1. `RESTORE_JOURNAL_DIR` when set (an operator can put it on another disk);
 *   2. `<PLATFORM_BACKUP_DIR or BACKUP_DIR>/journal`;
 *   3. `<tmpdir>/business-suite-restore-journal`.
 */
export function restoreJournalDir(env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const explicit = env.RESTORE_JOURNAL_DIR?.trim();
  if (explicit) return explicit;
  const backupDir = env.PLATFORM_BACKUP_DIR?.trim() || env.BACKUP_DIR?.trim();
  if (backupDir) return path.join(backupDir, "journal");
  return path.join(os.tmpdir(), "business-suite-restore-journal");
}

function journalFile(dir: string): string {
  return path.join(dir, "restore-journal.jsonl");
}

export function newRestoreJournalId(): string {
  return randomUUID();
}

/**
 * Append one phase. Throws when the line cannot be durably written — the
 * caller decides what that means (for `apply_started` it means "do not start").
 */
export async function appendRestoreJournal(
  entry: Omit<RestoreJournalEntry, "at"> & { at?: string },
  dir: string = restoreJournalDir(),
): Promise<RestoreJournalEntry> {
  const record: RestoreJournalEntry = { ...entry, at: entry.at ?? new Date().toISOString() };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = journalFile(dir);
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await fs.open(file, "a", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    return record;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Append a phase and swallow a write failure, returning whether it landed. */
export async function tryAppendRestoreJournal(
  entry: Omit<RestoreJournalEntry, "at"> & { at?: string },
  dir: string = restoreJournalDir(),
): Promise<boolean> {
  try {
    await appendRestoreJournal(entry, dir);
    return true;
  } catch (error) {
    console.error(
      "restore journal: could not append:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Read the journal back, oldest first. A torn trailing line (a crash mid-write)
 * is skipped rather than failing the read; every other unparsable line is
 * skipped too, because a journal that cannot be read is worse than one missing
 * a corrupt entry.
 */
export async function readRestoreJournal(
  dir: string = restoreJournalDir(),
  limit = 500,
): Promise<RestoreJournalHistory> {
  let raw: string;
  try {
    raw = await fs.readFile(journalFile(dir), "utf8");
  } catch {
    return { entries: [], latestPhase: new Map(), succeeded: new Set() };
  }
  const all: RestoreJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as RestoreJournalEntry;
      if (!parsed?.id || !parsed?.phase) continue;
      all.push(parsed);
    } catch {
      continue;
    }
  }
  const latestPhase = new Map<string, RestorePhase>();
  const succeeded = new Set<string>();
  for (const entry of all) {
    latestPhase.set(entry.id, entry.phase);
    if (entry.phase === "apply_succeeded") succeeded.add(entry.id);
  }
  return {
    entries: all.slice(Math.max(0, all.length - Math.max(1, limit))),
    latestPhase,
    succeeded,
  };
}

/**
 * A stable, non-secret digest of a restore's identifying fields — written into
 * both the journal and the post-restore receipt row so an operator can match a
 * receipt to the journal even after the actor and artifact rows are gone.
 */
export function restoreJournalFingerprint(entry: Pick<RestoreJournalEntry, "source" | "artifact" | "mode">): string {
  return createHash("sha256")
    .update(`${entry.source}\0${entry.artifact}\0${entry.mode}`)
    .digest("hex")
    .slice(0, 32);
}
