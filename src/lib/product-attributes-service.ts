/**
 * The branch-scoped attribute master («ویژگی محصول»).
 *
 * `item_variant_attributes` keeps an immutable name/value snapshot for the
 * variant and, when available, a nullable link to the definition that
 * authorized it. Renaming/deactivating a definition never rewrites snapshots;
 * hard deletion is allowed only while it is unused.
 */
import { query, withTenantTransaction } from "./db";
import {
  ATTRIBUTE_NAME_MAX_LENGTH,
  ATTRIBUTE_OPTION_MAX_LENGTH,
  ATTRIBUTE_OPTIONS_MAX_COUNT,
  attributeComparisonKey,
  normalizeAttributeText,
} from "./product-attributes";
import { isUuid } from "./uuid";

export interface AttributeDefinition {
  id: string;
  locationId: string;
  name: string;
  options: string[];
  isActive: boolean;
  version: number;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

interface DefinitionRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  options: string[];
  is_active: boolean;
  version: number;
  usage_count?: number;
  created_at: string;
  updated_at: string;
}

export interface DefinitionMutationResult {
  definition?: AttributeDefinition;
  current?: AttributeDefinition;
  usageCount?: number;
  error?: "missing_fields" | "name_too_long" | "invalid_options" | "duplicate_name" | "not_found" | "invalid_id" | "version_conflict" | "in_use";
}

function mapDefinition(row: DefinitionRow): AttributeDefinition {
  return {
    id: row.id,
    locationId: row.location_id,
    name: row.name,
    options: row.options ?? [],
    isActive: row.is_active,
    version: row.version,
    usageCount: row.usage_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = normalizeAttributeText(value);
  if (!name || Array.from(name).length > ATTRIBUTE_NAME_MAX_LENGTH) return null;
  return name;
}

function normalizedOptions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > ATTRIBUTE_OPTIONS_MAX_COUNT) return null;
  const options: string[] = [];
  const keys = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const option = normalizeAttributeText(raw);
    if (!option || Array.from(option).length > ATTRIBUTE_OPTION_MAX_LENGTH) return null;
    const key = attributeComparisonKey(option);
    if (keys.has(key)) return null;
    keys.add(key);
    options.push(option);
  }
  return options;
}

async function lockNameSpace(locationId: string): Promise<void> {
  await query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`product_attribute_name:${locationId}`]);
}

async function nameExists(locationId: string, name: string, excludeId?: string): Promise<boolean> {
  const { rows } = await query<{ name: string }>(
    `SELECT name FROM item_attribute_definitions
      WHERE location_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [locationId, excludeId ?? null],
  );
  const key = attributeComparisonKey(name);
  return rows.some((row) => attributeComparisonKey(row.name) === key);
}

async function usageCountForDefinition(id: string): Promise<number> {
  const { rows } = await query<{ usage_count: number }>(
    `SELECT count(*)::int AS usage_count
       FROM item_variant_attributes
      WHERE attribute_definition_id = $1`,
    [id],
  );
  return rows[0]?.usage_count ?? 0;
}

async function definitionForLocation(id: string, locationId: string, lock = false): Promise<AttributeDefinition | null> {
  const { rows } = await query<DefinitionRow>(
    `SELECT d.*,
            (SELECT count(*)::int FROM item_variant_attributes a
              WHERE a.attribute_definition_id = d.id) AS usage_count
       FROM item_attribute_definitions d
      WHERE d.id = $1 AND d.location_id = $2${lock ? " FOR UPDATE OF d" : ""}`,
    [id, locationId],
  );
  return rows[0] ? mapDefinition(rows[0]) : null;
}

export async function listAttributeDefinitions(locationId: string): Promise<AttributeDefinition[]> {
  const { rows } = await query<DefinitionRow>(
    `SELECT d.*,
            (SELECT count(*)::int FROM item_variant_attributes a
              WHERE a.attribute_definition_id = d.id) AS usage_count
       FROM item_attribute_definitions d
      WHERE d.location_id = $1
      ORDER BY d.is_active DESC, d.created_at, d.id`,
    [locationId],
  );
  return rows.map(mapDefinition);
}

export async function getAttributeDefinition(id: string, locationId: string): Promise<AttributeDefinition | null> {
  if (!isUuid(id)) return null;
  return definitionForLocation(id, locationId);
}

export async function createAttributeDefinition(input: {
  businessId: string;
  locationId: string;
  name: string;
  options: string[];
  isActive: boolean;
}): Promise<DefinitionMutationResult> {
  const name = validName(input.name);
  if (!name) return { error: typeof input.name === "string" && input.name.trim() ? "name_too_long" : "missing_fields" };
  const options = normalizedOptions(input.options);
  if (!options) return { error: "invalid_options" };

  try {
    return await withTenantTransaction(input.businessId, async () => {
      await lockNameSpace(input.locationId);
      if (await nameExists(input.locationId, name)) return { error: "duplicate_name" };
      const { rows } = await query<DefinitionRow>(
        `INSERT INTO item_attribute_definitions (location_id, name, options, is_active)
         VALUES ($1, $2, $3, $4)
         RETURNING *, 0::int AS usage_count`,
        [input.locationId, name, options, input.isActive],
      );
      return { definition: mapDefinition(rows[0]) };
    }, { locationId: input.locationId });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function updateAttributeDefinition(
  id: string,
  locationId: string,
  patch: { name?: string; options?: string[]; isActive?: boolean; version: number },
  businessId: string,
): Promise<DefinitionMutationResult> {
  if (!isUuid(id)) return { error: "invalid_id" };
  if (!Number.isSafeInteger(patch.version) || patch.version < 1) return { error: "version_conflict" };
  const name = patch.name === undefined ? undefined : validName(patch.name);
  if (patch.name !== undefined && !name) {
    return { error: patch.name.trim() ? "name_too_long" : "missing_fields" };
  }
  const options = patch.options === undefined ? undefined : normalizedOptions(patch.options);
  if (patch.options !== undefined && !options) return { error: "invalid_options" };

  try {
    return await withTenantTransaction(businessId, async () => {
      await lockNameSpace(locationId);
      const current = await definitionForLocation(id, locationId, true);
      if (!current) return { error: "not_found" };
      if (current.version !== patch.version) return { error: "version_conflict", current };
      if (name !== undefined && name !== null && (await nameExists(locationId, name, id))) return { error: "duplicate_name" };

      const nextName = name ?? current.name;
      const nextOptions = options ?? current.options;
      const nextActive = patch.isActive ?? current.isActive;
      const { rows } = await query<DefinitionRow>(
        `UPDATE item_attribute_definitions
            SET name = $1, options = $2, is_active = $3, version = version + 1, updated_at = now()
          WHERE id = $4 AND location_id = $5 AND version = $6
          RETURNING *, (SELECT count(*)::int FROM item_variant_attributes a
                         WHERE a.attribute_definition_id = item_attribute_definitions.id) AS usage_count`,
        [nextName, nextOptions, nextActive, id, locationId, patch.version],
      );
      if (!rows[0]) {
        const latest = await definitionForLocation(id, locationId);
        return latest ? { error: "version_conflict", current: latest } : { error: "not_found" };
      }
      return { definition: mapDefinition(rows[0]) };
    }, { locationId });
  } catch (err) {
    if (isUniqueViolation(err)) return { error: "duplicate_name" };
    throw err;
  }
}

export async function deleteAttributeDefinition(
  id: string,
  locationId: string,
  businessId: string,
): Promise<DefinitionMutationResult> {
  if (!isUuid(id)) return { error: "invalid_id" };
  return withTenantTransaction(businessId, async () => {
    const current = await definitionForLocation(id, locationId, true);
    if (!current) return { error: "not_found" };
    const usageCount = await usageCountForDefinition(id);
    if (usageCount > 0) return { error: "in_use", usageCount };
    const { rowCount } = await query(
      `DELETE FROM item_attribute_definitions WHERE id = $1 AND location_id = $2`,
      [id, locationId],
    );
    return (rowCount ?? 0) > 0 ? {} : { error: "not_found" };
  }, { locationId });
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
