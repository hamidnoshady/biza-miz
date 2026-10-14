/**
 * Does a *stored* export file still match the permissions of the member asking for it?
 * (issue #947, TEAM-F01.)
 *
 * ## The hole this closes
 *
 * An export is produced once and then kept for thirty days, and the history's
 * «دانلود دوباره» is a real read: the same bytes are handed out again on demand. The
 * first pass narrowed the *production* per caller, which is not the same guarantee,
 * because the thing that decides what may be read is a permission that can change
 * afterwards:
 *
 *   - a member exports the customer list with their own keys;
 *   - the owner revokes `team.view` from them (or they are moved to a narrower role);
 *   - the same file is re-downloadable from the history — and any other member who holds
 *     the bulk export keys can fetch it too.
 *
 * A PDF or a workbook cannot be re-projected: its columns are positional and its headers
 * are labels, so «blank the sensitive cells» is not an operation a narrowing pass can
 * perform. The engine therefore refuses rather than redacts, and the file that cannot be
 * shown is *regenerated* by the member who is allowed to see it — a fresh production is
 * projected with current fields under current permissions, and that is exactly the
 * behaviour a reader wants («دانلود دوباره» producing a file they may hold), while
 * privileged bytes are never handed to a narrower reader.
 *
 * ## What is stored, and what «unknown» means
 *
 * A job row remembers two things (`0222_export_job_audience.sql`):
 *
 *   - `partyAudience` — the {@link PartyReadAudience} the party-shaped rows were
 *     produced under (the personnel / financial halves);
 *   - `domainKeys` — the permission keys the production was authorized against, which is
 *     how the provider contracts (Holoo scopes) are re-checked.
 *
 * Both are nullable, and null is a *date*, not a permission: rows written before this
 * column existed, and files produced by a schedule with no requesting member, carry no
 * provenance. Those files were produced by an engine that returned everything, so null
 * is read as «the widest audience, and no key waives it» — the conservative direction,
 * which can only ever refuse more than it grants. A legacy file an owner genuinely needs
 * is one click away: the export screen regenerates it.
 *
 * Framework-free and side-effect-free so the decision can be unit-tested exhaustively
 * (every combination of recorded/current audience and held/missing keys) rather than
 * only through a route.
 */
import {
  PARTY_FINANCIAL_PERMISSIONS,
  SENSITIVE_PERSONNEL_PERMISSIONS,
  type PartyReadAudience,
} from "../personnel-access";

/** What a job row recorded about the file it holds. Null = «not recorded» (legacy). */
export interface RecordedExportAudience {
  partyAudience: PartyReadAudience | null;
  domainKeys: string[] | null;
}

/** What the member asking for the file may read right now. */
export interface CurrentExportAccess {
  partyAudience: PartyReadAudience;
  permissions: ReadonlySet<string>;
}

export type ExportDownloadDecision =
  | { allowed: true }
  /**
   * The file holds more than the caller may read. `requires` names the permission keys
   * whose absence caused it — the same vocabulary the rest of the data-transfer guards
   * answer with (`{ error, requires }`), so a screen can say which key is missing and an
   * owner can grant exactly that.
   */
  | { allowed: false; requires: string[]; reason: "legacy_provenance" | "audience_revoked" | "domain_keys_revoked" };

/**
 * The audience a *legacy* file has to be treated as: both halves open.
 *
 * Named rather than inlined so the reasoning above lives in one place — and so a test can
 * assert the pair rather than a literal.
 */
export const LEGACY_EXPORT_AUDIENCE: PartyReadAudience = { personnel: true, financial: true };

function missingPermissions(
  required: readonly string[],
  held: ReadonlySet<string>,
): string[] {
  return required.filter((key) => !held.has(key));
}

/**
 * The decision, for one download.
 *
 * The order of the checks is the order of the damage they prevent: keys first (a caller
 * without the domain keys never sees the file at all), then the party halves.
 */
export function decideExportDownload(
  recorded: RecordedExportAudience,
  current: CurrentExportAccess,
): ExportDownloadDecision {
  // 1. The provider/domain contract. A row with no recorded keys is a row whose
  //    production predates this column; its requirements are re-derived by the caller
  //    (the route re-checks the scope contract from `providerMetadata`), so nothing to
  //    add here — but a row that *did* record keys must satisfy all of them.
  const domainKeys = recorded.domainKeys ?? [];
  const missingKeys = missingPermissions(domainKeys, current.permissions);
  if (missingKeys.length > 0) {
    return { allowed: false, requires: missingKeys, reason: "domain_keys_revoked" };
  }

  // 2. The party-shaped halves. `null` means «produced before provenance was recorded»,
  //    and those files were produced with the full record in them.
  const recordedAudience = recorded.partyAudience ?? LEGACY_EXPORT_AUDIENCE;
  const requires: string[] = [];
  if (recordedAudience.personnel && !current.partyAudience.personnel) {
    requires.push(...SENSITIVE_PERSONNEL_PERMISSIONS);
  }
  if (recordedAudience.financial && !current.partyAudience.financial) {
    requires.push(...PARTY_FINANCIAL_PERMISSIONS);
  }
  return requires.length > 0
    ? {
        allowed: false,
        requires,
        reason: recorded.partyAudience === null ? "legacy_provenance" : "audience_revoked",
      }
    : { allowed: true };
}

/**
 * The audience to *record* for a job about to be produced.
 *
 * A producer with no requesting member (a test, a migration script) must not be able to
 * launder the wide read into a narrow-looking file, so an audience that was not resolved
 * is recorded honestly as absent rather than defaulted to the narrow one: the download
 * path then treats it as legacy and refuses it to anybody who cannot read everything.
 */
export function recordedAudienceFor(
  audience: PartyReadAudience | undefined,
): PartyReadAudience | null {
  if (!audience) return null;
  return { personnel: audience.personnel, financial: audience.financial };
}
