/**
 * Who may read a personnel file's sensitive fields (issue #947, TEAM-F01).
 *
 * ## The gap this closes
 *
 * `parties` is one record behind a customer, a supplier and a member of staff, and
 * every screen that lists people reads it through `/api/parties`. The gate on that
 * route is `parties.view`, and the cashier preset holds it — the till looks a
 * customer up a dozen times a shift. The same route also returns *Employee* rows,
 * and the projection carried the whole personnel file with them: the national and
 * economic identifiers, the home address, the HR notes, the contact documents and
 * the bank block.
 *
 * Hiding the personnel controls inside Team was therefore cosmetic: the data was one
 * query parameter (`?role=Employee`) away for anyone who could read a customer's
 * phone number. This module answers the missing question — «may this member read the
 * *sensitive* half of somebody's personnel file» — once, so the API projection, the
 * screens and the tests cannot disagree about it.
 *
 * ## Why these permissions and not a new key
 *
 * The data class is not new. Staff identity numbers and bank details are the same
 * trust as *running payroll* (the accountant's `payroll.view`, whose own routes are
 * documented as compensation data) and as *administering the team* (`team.view` /
 * `team.manage` — the keys that already open the roster, the member editor and this
 * very directory). Inventing a fifth key would have produced a second, wider answer
 * to a question two existing keys already answer, and a preset that grants one but
 * not the other.
 *
 * The union is deliberately the *administrative* one:
 *
 * | preset | personnel reads | why |
 * |---|---|---|
 * | owner | yes | everything, unconditionally |
 * | admin | yes | every delegatable capability |
 * | accountant | yes | `payroll.view` — payroll is this role's own work |
 * | manager | **no** | the manager preset holds neither `team.*` nor `payroll.*`; it is not a hiring or payroll role, and a business that wants it to be one grants `team.view` or `payroll.view` |
 * | cashier / waiter / kitchen | **no** | the till reads customers, not staff files |
 *
 * `SENSITIVE_PERSONNEL_PRESET_ROLES` is the same answer without the permissions in
 * hand (a screen that renders before/without the session's effective set). It mirrors
 * the presets in `permissions.ts` — the party section's existing convention
 * (`parties-scopes.ts`) — and `personnel-access.test.ts` pins the two together, so a
 * preset edit cannot silently reopen the hole.
 *
 * Framework-free and side-effect-free on purpose: both a client component (the party
 * form, which must not draw a field its caller cannot read) and a server route import
 * it, so it may reach nothing that touches the database.
 */
import { PERMISSIONS, type Permission } from "./permissions";

/**
 * Any one of these opens the sensitive half of an Employee file.
 *
 * Deliberately a list of *keys*, not of roles: a business may hand `team.view` to a
 * bookkeeper or revoke `payroll.view` from a member who should only see wages, and
 * both must take effect on the next request.
 */
export const SENSITIVE_PERSONNEL_PERMISSIONS: readonly Permission[] = [
  PERMISSIONS.teamView,
  PERMISSIONS.teamManage,
  PERMISSIONS.payrollView,
  PERMISSIONS.payrollManage,
];

/**
 * The same rule as a preset answer, for a caller with no effective permission set.
 *
 * `manager` is absent on purpose and documented above: the preset is not a staff
 * administrator, and the safe default for an unknown caller is the narrower one.
 */
export const SENSITIVE_PERSONNEL_PRESET_ROLES: readonly string[] = ["owner", "admin", "accountant"];

/**
 * The money-shaped half of a party — the bank block in the financial tab.
 *
 * Read with the *same* key the write already needs (`ledger.view`, see
 * `touchesAccountingFields` / `accountingFieldsIn` on the party routes), so the tab
 * can never be read by a member the server would refuse to save it for. Suppliers
 * and customers included: an IBAN is an IBAN whoever it belongs to.
 */
export const PARTY_FINANCIAL_PERMISSIONS: readonly Permission[] = [PERMISSIONS.ledgerView];

/**
 * The same rule as a preset answer for the financial half.
 *
 * Written as an *extension of the personnel list by exactly one role*, because that is
 * what it is: the bank block is read with `ledger.view`, which the presets that read
 * staff files all hold — owner, admin and accountant — plus the `manager` preset, which
 * does not administer staff but does keep the books. Spelling the four roles out again
 * would be a second copy of a taxonomy the codebase keeps in `roles.ts`, and
 * `roles.test.ts` refuses hand-copied copies of that taxonomy: a role added there would
 * have to be added here too, or the answer would silently narrow.
 *
 * Kept in step with the catalogue (every role named here holds `ledger.view`) and a
 * superset of `PARTIES_PRESET_LEDGER_ROLES` in `parties-scopes.ts`, which answers
 * this same question for the screen's buttons: if the two disagreed, a manager would
 * either be shown a bank tab the projection blanks or have a tab withheld they are
 * allowed to read. `personnel-access.test.ts` pins both directions.
 */
export const PARTY_FINANCIAL_PRESET_ROLES: readonly string[] = [
  ...SENSITIVE_PERSONNEL_PRESET_ROLES,
  "manager",
];

/**
 * What one read of a party may return.
 *
 * Two booleans rather than a per-field map because the *policy* is two questions; the
 * field lists that answer them live in `parties-service.ts` next to the serializer
 * that applies them, so the wire projection has exactly one implementation.
 */
export interface PartyReadAudience {
  /** May read an Employee file's identity/HR fields (national ID, address, notes…). */
  personnel: boolean;
  /** May read the money-shaped fields (bank block). */
  financial: boolean;
}

/** The internal audience: a service-to-service read, or the record's own owner. */
export const FULL_PARTY_AUDIENCE: PartyReadAudience = { personnel: true, financial: true };

function holds(
  permissions: Iterable<string> | null | undefined,
  keys: readonly Permission[],
): boolean {
  const held = permissions ? new Set(permissions) : null;
  return held !== null && keys.some((key) => held.has(key));
}

/**
 * The audience for a caller whose *effective* permissions are known.
 *
 * Pass what `requirePermission` resolved (`membership.permissions`), not the JWT:
 * the token's copy lags a revocation, and this decides what data leaves the server.
 */
export function partyReadAudienceForPermissions(
  permissions: Iterable<string> | null | undefined,
): PartyReadAudience {
  return {
    personnel: holds(permissions, SENSITIVE_PERSONNEL_PERMISSIONS),
    financial: holds(permissions, PARTY_FINANCIAL_PERMISSIONS),
  };
}

/**
 * The audience for a caller known only by their role — the preset answer, for a
 * screen that renders before the effective set is in hand, and for tests.
 *
 * A caller with a *known but empty* permission set is not a preset caller: passing
 * `[]` answers «no, nothing», which is the difference between «we have not resolved
 * this yet» and «this member holds nothing».
 */
export function partyReadAudienceForRole(
  role: string,
  permissions?: readonly string[] | null,
): PartyReadAudience {
  if (permissions !== undefined && permissions !== null) return partyReadAudienceForPermissions(permissions);
  return {
    personnel: SENSITIVE_PERSONNEL_PRESET_ROLES.includes(role),
    financial: PARTY_FINANCIAL_PRESET_ROLES.includes(role),
  };
}

/** May this member read the sensitive half of a personnel file? */
export function canReadSensitivePersonnel(
  role: string,
  permissions?: readonly string[] | null,
): boolean {
  return partyReadAudienceForRole(role, permissions).personnel;
}

/**
 * The same withheld fields, named as *columns* rather than paths (issue #947, TEAM-F01).
 *
 * The party read speaks in tabs (`generalInfo.nationalId`), but the bulk readers — the
 * data-transfer adapters and the Holoo persons provider — read flattened SQL rows and
 * never build a `Party`. This list is the bridge, so the export seam withholds the same
 * fields the screen does instead of a hand-copied second opinion. Kept next to
 * `PERSONNEL_RESTRICTED_FIELDS` on purpose: the unit suite asserts the two name one set.
 */
export const PERSONNEL_RESTRICTED_COLUMNS: readonly string[] = [
  "nationalId",
  "economicCode",
  "address",
  "addressInfo",
  "contactInfo",
  "notes",
];

/**
 * Withhold them from a flat row — the bulk-read half of `partyForAudience`.
 *
 * `isEmployee` is passed rather than inferred, because the rule is the projection's own:
 * an Employee *file* is HR data, while the same columns on a customer are ordinary CRM
 * data that the caller legitimately exports. A caller that cannot see the personnel half
 * gets empty cells for those columns on Employee rows only, and the export keeps working
 * — a narrowed file, not a refused one.
 */
export function restrictPartyColumnsForAudience<T extends Record<string, unknown>>(
  row: T,
  audience: PartyReadAudience,
  isEmployee: boolean,
): T {
  if (!isEmployee || audience.personnel) return row;
  const withheld: Record<string, unknown> = { ...row };
  for (const column of PERSONNEL_RESTRICTED_COLUMNS) {
    if (column in withheld) withheld[column] = withheld[column] === null ? null : "";
  }
  return withheld as T;
}

/**
 * Which single capability a member may hand out to open the personnel half — used by
 * the refusal sentences («اطلاعات حساس پروندهٔ کارکنان») so a screen can name the key
 * the owner would have to grant instead of a generic 403.
 */
export const PERSONNEL_READ_PERMISSION_HINT = PERMISSIONS.teamView;
