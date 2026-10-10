/**
 * The payload a desktop install receives when it redeems a pairing code, and
 * the validation it runs before touching its database.
 *
 * Pure — its imports (`industries.ts`, and the account-tree rules in
 * `account-hierarchy.ts`, which are framework-free too) carry no db or next
 * dependency, so it is unit-tested directly and
 * can be used on both sides: the online server builds a value of this shape
 * (pairing-service.ts) and the local install validates one (pairing-apply.ts).
 *
 * IDs are carried verbatim rather than regenerated. The local install ends up
 * holding the same business_id, location_id and user ids as the online
 * business, which is what makes Phase 11's sync_events replay correctly in
 * both directions afterwards.
 *
 * Credential hashes cross as-is (bcrypt output, never plaintext), so staff sign
 * in on the laptop with the PIN they already know.
 */

import { isIndustry, type Industry } from "./industries";
import { AccountTreeError, orderAccountTree } from "./account-hierarchy";
import { ACCOUNT_TYPES, type AccountType } from "./coa-template";

/**
 * The version this build issues to a desktop that declares it can read it.
 *
 * Version 7 carries the whole chart with each account's `isActive` and
 * `isContra`. Version 6 is what the released desktop v1.0.28 reads: it exported
 * only ACTIVE accounts and carried no account state at all. Changing what 6
 * means would hand an unchanged desktop an archived account it would restore as
 * active, so the two are different contracts with different numbers.
 *
 * Which one a redeem gets is decided by the caller's declared capability (see
 * `redeemPairingCode`). A legacy caller receives v6 only when the chart can be
 * expressed in it losslessly; otherwise it is refused and told to update.
 */
export const PAIRING_SNAPSHOT_VERSION = 7;
export const LEGACY_PAIRING_SNAPSHOT_VERSION = 6;
const ACCEPTED_SNAPSHOT_VERSIONS: readonly number[] = [LEGACY_PAIRING_SNAPSHOT_VERSION, PAIRING_SNAPSHOT_VERSION];

/**
 * The redeem answer for a desktop that cannot read the chart as it stands: it
 * declared no capability (or an old one) and the chart holds an archived or
 * contra account, which v6 cannot say. Nothing is issued, and the one-time code
 * is not spent, so the same code works once the desktop is updated.
 */
export const PAIRING_REQUIRES_NEWER_CLIENT = "pairing_requires_newer_client";

/**
 * The capability a desktop declares when it redeems. It asks for the newest
 * version, so a cloud that can serve it does, and any other answer is judged on
 * its own terms (see `answersCapability`).
 */
export const DESKTOP_REDEEM_CAPABILITY = { maxSnapshotVersion: PAIRING_SNAPSHOT_VERSION } as const;

/**
 * Whether a redeem answer is the snapshot the desktop asked for. A version-6
 * answer to a version-7 request can only come from a cloud that predates
 * account-state support. That cloud exports active accounts only and has no
 * contra state, so accepting it would restore the chart silently wrong.
 */
export function answersCapability(snapshotVersion: number): boolean {
  return snapshotVersion === PAIRING_SNAPSHOT_VERSION;
}

/** Whether an account is state that v6 would silently lose: archived, or contra. */
export function accountNeedsNewerClient(account: { isActive: boolean; isContra: boolean }): boolean {
  return !account.isActive || account.isContra;
}

/** Thrown by the producer when a v6 build would have to drop account state. */
export class LegacySnapshotNotRepresentable extends Error {
  constructor() {
    super(PAIRING_REQUIRES_NEWER_CLIENT);
  }
}

/**
 * Explicit contract for what pairing seeds and what continuing sync does (or
 * does not) cover. Keeping this in the signed-in pairing response prevents a
 * successful bootstrap from being misrepresented as full-database sync.
 */
export interface PairingDataClassification {
  bootstrapMasterData: string[];
  ongoingDomainEvents: string[];
  siteLocalOperationalData: string[];
  centralOnlyData: string[];
  notYetReplicated: string[];
}

export interface SnapshotUser {
  id: string;
  role: string;
  customRoleId: string | null;
  fullName: string;
  email: string | null;
  permissions: Record<string, unknown>;
  isActive: boolean;
  membershipStatus: "invited" | "active" | "suspended" | "locked" | "inactive" | "offboarded";
  locationScope: "all" | "selected" | "home" | "none";
  defaultLocationId: string | null;
  locationIds: string[];
  membershipRevision: number;
  /** Opaque identity link only. Cloud credential material never crosses. */
  cloudIdentityRef: string | null;
  credentialMetadata: Array<{ type: string; status: string }>;
}

export interface SnapshotTenantRole {
  id: string;
  name: string;
  description: string;
  permissions: string[];
  defaultLocationScope: "all" | "selected" | "home" | "none";
  isActive: boolean;
  roleRevision: number;
}

export interface SnapshotAccount {
  id: string;
  parentCode: string | null;
  code: string;
  name: string;
  /** Checked against ACCOUNT_TYPES by validateSnapshot before anything reads it. */
  type: AccountType;
  /**
   * Version 7: required. Restore writes it verbatim, so an archived account stays
   * archived. Version 6 has no such field and every account in it was active.
   */
  isActive?: boolean;
  /**
   * Version 7: required. Restore writes it verbatim. Without it a contra account
   * (accumulated depreciation, sales returns) comes back as an ordinary one with
   * the opposite balance rule. Version 6 has no such field, and no version 6
   * snapshot is issued with a contra account.
   */
  isContra?: boolean;
}

export interface SnapshotMenuCategory {
  id: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
}

export interface SnapshotMenuItem {
  id: string;
  categoryId: string | null;
  name: string;
  description: string | null;
  sku: string | null;
  /** Integer Rial as a decimal string, preserving PostgreSQL bigint exactly. */
  price: string;
  imageUrl: string | null;
  /**
   * v4. The catalogue photo from the business media library (0149). The row
   * itself travels in `menu.mediaAssets`; the *bytes* do not — the local
   * install fetches them from the central server on demand and shows the
   * placeholder when it cannot.
   */
  imageMediaId: string | null;
  isActive: boolean;
  sortOrder: number;
}

/**
 * v4. Minimal replication of a media_assets row — just enough for the local
 * install to satisfy the foreign key, serve the right content type and know
 * where the bytes live. The file itself is pulled from the server lazily, so
 * pairing never stalls on image bytes.
 */
export interface SnapshotMediaAsset {
  id: string;
  kind: string;
  fileName: string;
  mimeType: string;
  /** bigint as a decimal string. */
  byteSize: string;
  storageKey: string;
  sha256: string;
}

export interface SnapshotModifierGroup {
  id: string;
  name: string;
  minSelect: number;
  maxSelect: number;
  /** v4 (0165): a group can be parked inactive or reordered at the source. */
  isActive: boolean;
  sortOrder: number;
}

export interface SnapshotModifier {
  id: string;
  groupId: string;
  name: string;
  /** Signed integer Rial as a decimal string. */
  priceDelta: string;
  isActive: boolean;
  sortOrder: number;
}

export interface SnapshotDiningTable {
  id: string;
  name: string;
  zone: string | null;
  capacity: number;
  sortOrder: number;
  isActive: boolean;
}

export interface SnapshotInventoryItem {
  id: string;
  name: string;
  sku: string | null;
  unit: string;
  reorderLevel: string | null;
  averageCost: string;
  purchaseUnit: string | null;
  purchaseUnitFactor: string;
  carryingValueRial: string | null;
  isProduced: boolean;
  isActive: boolean;
}

export interface SnapshotPaymentMethod {
  id: string;
  code: string;
  name: string;
  settlement: string;
  sortOrder: number;
  isActive: boolean;
  isBuiltin: boolean;
  opensDrawer: boolean;
  requiresReference: boolean;
}

export interface SnapshotSetting {
  key: string;
  value: unknown;
}

export interface PairingSnapshot {
  version: number;
  business: {
    id: string;
    name: string;
    slug: string;
    /**
     * Phase 23. Optional so a snapshot minted by an older central server
     * still validates — the desktop side falls back to the slug, which is
     * what the column was backfilled from anyway (migration 0066).
     */
    subdomain?: string;
    /**
     * Phase 25. Optional for the same reason as `subdomain`: a snapshot minted
     * by an older central server carries none, and the desktop side then falls
     * back to `food_service` — the column's own default, which is exactly what
     * a paired install got before this field existed. Without it, pairing a
     * jewellery business produced a café on the laptop.
     */
    industry?: Industry;
    timezone: string;
  };
  location: {
    id: string;
    name: string;
    address: string | null;
    phone: string | null;
    timezone: string;
  };
  /**
   * Option A for cross-branch references: every desktop holds lightweight
   * identities for the business's locations, while operational data remains
   * limited to `location` above.
   */
  locationIdentities: Array<{ id: string; name: string; timezone: string }>;
  /** Independent, revocable identity of this Windows site. */
  siteDevice: {
    id: string;
    publicId: string;
    displayName: string;
  };
  users: SnapshotUser[];
  tenantRoles: SnapshotTenantRole[];
  iam: { schemaVersion: number; lastSequence: number; stateHash: string };
  accounts: SnapshotAccount[];
  menu: {
    categories: SnapshotMenuCategory[];
    items: SnapshotMenuItem[];
    /** v4: only the assets the menu's items actually reference. */
    mediaAssets: SnapshotMediaAsset[];
    modifierGroups: SnapshotModifierGroup[];
    modifiers: SnapshotModifier[];
    itemModifierGroups: Array<{
      menuItemId: string;
      modifierGroupId: string;
      /** v4: per-item bounds overrides and the 0165 link columns. */
      minSelectOverride: number | null;
      maxSelectOverride: number | null;
      sortOrder: number;
      isActive: boolean;
    }>;
  };
  diningTables: SnapshotDiningTable[];
  inventory: {
    items: SnapshotInventoryItem[];
    menuIngredients: Array<{ menuItemId: string; inventoryItemId: string; quantity: string }>;
    modifierIngredients: Array<{ modifierId: string; inventoryItemId: string; quantityDelta: string }>;
  };
  paymentMethods: SnapshotPaymentMethod[];
  settings: SnapshotSetting[];
  dataClassification: PairingDataClassification;
  features: Record<string, boolean>;
  /** Plaintext, delivered once — the local install stores only its hash via setServerSyncConfig. */
  syncToken: string;
}

export type SnapshotValidation =
  | { ok: true; snapshot: PairingSnapshot }
  | { ok: false; error: "snapshot_invalid" };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_SYNC_TOKEN_LENGTH = 16;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

function isIntegerAtLeastZero(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

function isIntegerAtLeastOne(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

function isDecimalString(v: unknown): v is string {
  return typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v);
}

function isIntegerString(v: unknown): v is string {
  return typeof v === "string" && /^-?\d+$/.test(v);
}

function isNonNegativeIntegerString(v: unknown): v is string {
  return typeof v === "string" && /^\d+$/.test(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((entry) => typeof entry === "string" && entry.length > 0);
}

/**
 * A shape check, deliberately not a trust check: the code already
 * authenticated the caller, so this only guards against a truncated
 * response, a version skew, or a bug on the issuing side writing garbage into
 * an empty local database.
 */
export function validateSnapshot(raw: unknown): SnapshotValidation {
  const fail = { ok: false, error: "snapshot_invalid" } as const;
  if (!isObject(raw)) return fail;
  if (typeof raw.version !== "number" || !ACCEPTED_SNAPSHOT_VERSIONS.includes(raw.version)) return fail;
  const version = raw.version;

  const business = raw.business;
  if (!isObject(business)) return fail;
  if (!isUuid(business.id)) return fail;
  if (typeof business.name !== "string" || !business.name) return fail;
  if (typeof business.slug !== "string" || !business.slug) return fail;
  if (business.subdomain !== undefined && (typeof business.subdomain !== "string" || !business.subdomain)) return fail;
  if (business.industry !== undefined && (typeof business.industry !== "string" || !isIndustry(business.industry))) {
    return fail;
  }
  if (typeof business.timezone !== "string" || !business.timezone) return fail;

  const location = raw.location;
  if (!isObject(location)) return fail;
  if (!isUuid(location.id)) return fail;
  if (typeof location.name !== "string" || !location.name) return fail;
  if (!isNullableString(location.address)) return fail;
  if (!isNullableString(location.phone)) return fail;
  if (typeof location.timezone !== "string" || !location.timezone) return fail;
  if (!Array.isArray(raw.locationIdentities) || raw.locationIdentities.length === 0) return fail;
  const locationIdentityIds = new Set<string>();
  for (const identity of raw.locationIdentities) {
    if (!isObject(identity) || !isUuid(identity.id) || typeof identity.name !== "string" || !identity.name) return fail;
    if (typeof identity.timezone !== "string" || !identity.timezone || locationIdentityIds.has(identity.id)) return fail;
    locationIdentityIds.add(identity.id);
  }
  if (!locationIdentityIds.has(location.id)) return fail;

  const siteDevice = raw.siteDevice;
  if (!isObject(siteDevice)) return fail;
  if (!isUuid(siteDevice.id) || !isUuid(siteDevice.publicId)) return fail;
  if (typeof siteDevice.displayName !== "string" || !siteDevice.displayName.trim()) return fail;

  if (!Array.isArray(raw.users) || raw.users.length === 0) return fail;
  for (const user of raw.users) {
    if (!isObject(user)) return fail;
    if (!isUuid(user.id)) return fail;
    if (typeof user.role !== "string" || !user.role) return fail;
    if (typeof user.fullName !== "string" || !user.fullName) return fail;
    if (!isNullableString(user.email)) return fail;
    if (!isObject(user.permissions)) return fail;
    // Fail closed if a producer accidentally reintroduces legacy secret fields.
    if (["passwordHash", "pinHash", "platformUserPasswordHash", "totpSecret", "recoveryCodes"].some((key) => key in user)) return fail;
    if (!isNullableString(user.customRoleId) || !isNullableString(user.defaultLocationId) || !isNullableString(user.cloudIdentityRef)) return fail;
    if (typeof user.isActive !== "boolean" || typeof user.membershipStatus !== "string") return fail;
    if (!["all", "selected", "home", "none"].includes(String(user.locationScope))) return fail;
    if (!Number.isSafeInteger(user.membershipRevision) || Number(user.membershipRevision) < 1) return fail;
    if (!Array.isArray(user.locationIds) || !user.locationIds.every(isUuid)) return fail;
    if (!Array.isArray(user.credentialMetadata) || !user.credentialMetadata.every((c) => isObject(c) && typeof c.type === "string" && typeof c.status === "string")) return fail;
  }
  if (!Array.isArray(raw.tenantRoles)) return fail;
  for (const role of raw.tenantRoles) {
    if (!isObject(role) || !isUuid(role.id) || typeof role.name !== "string" || !role.name) return fail;
    if (typeof role.description !== "string" || !isStringArray(role.permissions) || typeof role.isActive !== "boolean") return fail;
    if (!["all", "selected", "home", "none"].includes(String(role.defaultLocationScope))) return fail;
    if (!Number.isSafeInteger(role.roleRevision) || Number(role.roleRevision) < 1) return fail;
  }
  if (!isObject(raw.iam) || raw.iam.schemaVersion !== 1 || !Number.isSafeInteger(raw.iam.lastSequence) || typeof raw.iam.stateHash !== "string") return fail;

  // Without an owner the local install would have nobody to sign in as, which
  // is a dead end the wizard cannot recover from.
  if (!raw.users.some((u) => isObject(u) && u.role === "owner")) return fail;

  if (!Array.isArray(raw.accounts)) return fail;
  for (const account of raw.accounts) {
    if (!isObject(account)) return fail;
    if (!isUuid(account.id)) return fail;
    if (!isNullableString(account.parentCode)) return fail;
    if (typeof account.code !== "string" || !account.code) return fail;
    if (typeof account.name !== "string" || !account.name) return fail;
    if (typeof account.type !== "string" || !ACCOUNT_TYPES.includes(account.type as AccountType)) return fail;
    if (version === PAIRING_SNAPSHOT_VERSION) {
      // Fail closed: a v7 account without its state is refused, never defaulted.
      if (typeof account.isActive !== "boolean") return fail;
      if (typeof account.isContra !== "boolean") return fail;
    } else {
      // A v6 snapshot cannot say an account is archived or contra. Anything that
      // claims otherwise is a contradiction, and it is refused, not read as active.
      if (account.isActive !== undefined && account.isActive !== true) return fail;
      if (account.isContra !== undefined && account.isContra !== false) return fail;
    }
  }
  // The chart must be a tree a restore can place: unique codes, every parent
  // present, no cycles, no chain deeper than the four tiers, and every child's
  // type equal to its parent's. Checking it here refuses a bad snapshot before
  // the local install opens a transaction.
  try {
    orderAccountTree(raw.accounts as SnapshotAccount[]);
  } catch (err) {
    if (err instanceof AccountTreeError) return fail;
    throw err;
  }

  const menu = raw.menu;
  if (!isObject(menu)) return fail;
  if (!Array.isArray(menu.categories) || !Array.isArray(menu.items)) return fail;
  if (!Array.isArray(menu.mediaAssets)) return fail;
  const mediaAssetIds = new Set<string>();
  for (const asset of menu.mediaAssets) {
    if (!isObject(asset)) return fail;
    if (!isUuid(asset.id)) return fail;
    if (typeof asset.kind !== "string" || !asset.kind) return fail;
    if (typeof asset.fileName !== "string" || !asset.fileName) return fail;
    if (typeof asset.mimeType !== "string" || !asset.mimeType) return fail;
    if (!isNonNegativeIntegerString(asset.byteSize)) return fail;
    if (typeof asset.storageKey !== "string" || !asset.storageKey) return fail;
    if (typeof asset.sha256 !== "string" || !asset.sha256) return fail;
    mediaAssetIds.add(asset.id);
  }
  const categoryIds = new Set<string>();
  for (const category of menu.categories) {
    if (!isObject(category)) return fail;
    if (!isUuid(category.id)) return fail;
    if (typeof category.name !== "string" || !category.name) return fail;
    if (!Number.isInteger(category.sortOrder)) return fail;
    if (typeof category.isActive !== "boolean") return fail;
    categoryIds.add(category.id);
  }
  const menuItemIds = new Set<string>();
  for (const item of menu.items) {
    if (!isObject(item)) return fail;
    if (!isUuid(item.id)) return fail;
    if (item.categoryId !== null && !isUuid(item.categoryId)) return fail;
    // A dangling category reference would violate the FK on insert, so catch
    // it here where the error is still a clean "snapshot_invalid".
    if (typeof item.categoryId === "string" && !categoryIds.has(item.categoryId)) return fail;
    if (typeof item.name !== "string" || !item.name) return fail;
    if (!isNullableString(item.description)) return fail;
    if (!isNullableString(item.sku)) return fail;
    if (!isNonNegativeIntegerString(item.price)) return fail;
    if (!isNullableString(item.imageUrl)) return fail;
    if (item.imageMediaId !== null && !isUuid(item.imageMediaId)) return fail;
    // A dangling media reference would violate the FK on insert; the asset
    // rows must ride along in the same snapshot.
    if (typeof item.imageMediaId === "string" && !mediaAssetIds.has(item.imageMediaId)) {
      return fail;
    }
    if (typeof item.isActive !== "boolean") return fail;
    if (!Number.isInteger(item.sortOrder)) return fail;
    menuItemIds.add(item.id);
  }

  if (!Array.isArray(menu.modifierGroups) || !Array.isArray(menu.modifiers) || !Array.isArray(menu.itemModifierGroups)) {
    return fail;
  }
  const modifierGroupIds = new Set<string>();
  for (const group of menu.modifierGroups) {
    if (!isObject(group) || !isUuid(group.id) || typeof group.name !== "string" || !group.name) return fail;
    if (!isIntegerAtLeastZero(group.minSelect) || !isIntegerAtLeastOne(group.maxSelect)) return fail;
    if (group.minSelect > group.maxSelect) return fail;
    if (typeof group.isActive !== "boolean" || !Number.isInteger(group.sortOrder)) return fail;
    modifierGroupIds.add(group.id);
  }
  const modifierIds = new Set<string>();
  for (const modifier of menu.modifiers) {
    if (!isObject(modifier) || !isUuid(modifier.id) || !isUuid(modifier.groupId)) return fail;
    if (!modifierGroupIds.has(modifier.groupId)) return fail;
    if (typeof modifier.name !== "string" || !modifier.name || !isIntegerString(modifier.priceDelta)) return fail;
    if (typeof modifier.isActive !== "boolean" || !Number.isInteger(modifier.sortOrder)) return fail;
    modifierIds.add(modifier.id);
  }
  const isNullableInteger = (v: unknown): v is number | null =>
    v === null || (typeof v === "number" && Number.isInteger(v) && v >= 0);
  for (const link of menu.itemModifierGroups) {
    if (!isObject(link) || !isUuid(link.menuItemId) || !isUuid(link.modifierGroupId)) return fail;
    if (!menuItemIds.has(link.menuItemId) || !modifierGroupIds.has(link.modifierGroupId)) return fail;
    if (!isNullableInteger(link.minSelectOverride) || !isNullableInteger(link.maxSelectOverride)) return fail;
    if (
      link.minSelectOverride !== null &&
      link.maxSelectOverride !== null &&
      link.minSelectOverride > link.maxSelectOverride
    ) return fail;
    if (!Number.isInteger(link.sortOrder) || typeof link.isActive !== "boolean") return fail;
  }

  if (!Array.isArray(raw.diningTables)) return fail;
  for (const table of raw.diningTables) {
    if (!isObject(table) || !isUuid(table.id) || typeof table.name !== "string" || !table.name) return fail;
    if (!isNullableString(table.zone) || !isIntegerAtLeastOne(table.capacity)) return fail;
    if (!Number.isInteger(table.sortOrder) || typeof table.isActive !== "boolean") return fail;
  }

  const inventory = raw.inventory;
  if (!isObject(inventory) || !Array.isArray(inventory.items)) return fail;
  if (!Array.isArray(inventory.menuIngredients) || !Array.isArray(inventory.modifierIngredients)) return fail;
  const inventoryItemIds = new Set<string>();
  for (const item of inventory.items) {
    if (!isObject(item) || !isUuid(item.id) || typeof item.name !== "string" || !item.name) return fail;
    if (!isNullableString(item.sku) || typeof item.unit !== "string" || !item.unit) return fail;
    if (item.reorderLevel !== null && !isDecimalString(item.reorderLevel)) return fail;
    if (!isDecimalString(item.averageCost) || !isNullableString(item.purchaseUnit)) return fail;
    if (!isDecimalString(item.purchaseUnitFactor) || (item.carryingValueRial !== null && !isNonNegativeIntegerString(item.carryingValueRial))) return fail;
    if (typeof item.isProduced !== "boolean" || typeof item.isActive !== "boolean") return fail;
    inventoryItemIds.add(item.id);
  }
  for (const ingredient of inventory.menuIngredients) {
    if (!isObject(ingredient) || !isUuid(ingredient.menuItemId) || !isUuid(ingredient.inventoryItemId)) return fail;
    if (!menuItemIds.has(ingredient.menuItemId) || !inventoryItemIds.has(ingredient.inventoryItemId)) return fail;
    if (!isDecimalString(ingredient.quantity)) return fail;
  }
  for (const ingredient of inventory.modifierIngredients) {
    if (!isObject(ingredient) || !isUuid(ingredient.modifierId) || !isUuid(ingredient.inventoryItemId)) return fail;
    if (!modifierIds.has(ingredient.modifierId) || !inventoryItemIds.has(ingredient.inventoryItemId)) return fail;
    if (!isDecimalString(ingredient.quantityDelta)) return fail;
  }

  if (!Array.isArray(raw.paymentMethods)) return fail;
  for (const method of raw.paymentMethods) {
    if (!isObject(method) || !isUuid(method.id)) return fail;
    if (typeof method.code !== "string" || !method.code || typeof method.name !== "string" || !method.name) return fail;
    if (typeof method.settlement !== "string" || !method.settlement || !Number.isInteger(method.sortOrder)) return fail;
    if (typeof method.isActive !== "boolean" || typeof method.isBuiltin !== "boolean") return fail;
    if (typeof method.opensDrawer !== "boolean" || typeof method.requiresReference !== "boolean") return fail;
  }

  const classification = raw.dataClassification;
  if (!isObject(classification)) return fail;
  if (!isStringArray(classification.bootstrapMasterData)) return fail;
  if (!isStringArray(classification.ongoingDomainEvents)) return fail;
  if (!isStringArray(classification.siteLocalOperationalData)) return fail;
  if (!isStringArray(classification.centralOnlyData)) return fail;
  if (!isStringArray(classification.notYetReplicated)) return fail;

  if (!Array.isArray(raw.settings)) return fail;
  for (const setting of raw.settings) {
    if (!isObject(setting)) return fail;
    if (typeof setting.key !== "string" || !setting.key) return fail;
  }

  if (!isObject(raw.features)) return fail;
  if (!Object.values(raw.features).every((v) => typeof v === "boolean")) return fail;

  if (typeof raw.syncToken !== "string" || raw.syncToken.length < MIN_SYNC_TOKEN_LENGTH) return fail;

  return { ok: true, snapshot: raw as unknown as PairingSnapshot };
}
