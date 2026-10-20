/** Pure helpers for migrating and reconciling local product-variant drafts. */
import {
  attributeComparisonKey,
  isAttributeDefinitionId,
} from "./product-attributes";

export interface AttributeDefinitionView {
  id: string;
  name: string;
  options: string[];
  isActive: boolean;
}

export interface AttributeDefinitionSnapshot {
  name: string;
  options: string[];
  isActive: boolean;
}

export interface DraftVariantAttributes {
  id: string | number;
  values: Record<string, string>;
  unresolvedValues?: Record<string, string>;
}

export interface DraftAttributeReconciliationIssue {
  variantId: string | number;
  definitionId: string | null;
  previousName: string;
  currentName: string | null;
  value: string;
  reason: "definition_removed" | "definition_inactive" | "schema_changed" | "option_removed" | "unmapped_legacy_value";
  sourceKey: string;
  source: "values" | "unresolvedValues";
}

export function snapshotAttributeDefinitions(
  definitions: readonly AttributeDefinitionView[],
): Record<string, AttributeDefinitionSnapshot> {
  return Object.fromEntries(definitions.map((definition) => [definition.id, {
    name: definition.name,
    options: [...definition.options],
    isActive: definition.isActive,
  }]));
}

/** Convert the v2 name-keyed draft format without dropping unmatched values. */
export function migrateDraftAttributeValues<T extends DraftVariantAttributes>(
  variants: readonly T[],
  definitions: readonly AttributeDefinitionView[],
): (T & { unresolvedValues: Record<string, string> })[] {
  const byName = new Map<string, AttributeDefinitionView[]>();
  for (const definition of definitions) {
    const key = attributeComparisonKey(definition.name);
    byName.set(key, [...(byName.get(key) ?? []), definition]);
  }
  const byId = new Set(definitions.map((definition) => definition.id));
  return variants.map((variant) => {
    const values: Record<string, string> = {};
    const unresolvedValues = { ...(variant.unresolvedValues ?? {}) };
    for (const [key, value] of Object.entries(variant.values ?? {})) {
      if (byId.has(key) || isAttributeDefinitionId(key)) {
        values[key] = value;
        continue;
      }
      const matches = byName.get(attributeComparisonKey(key)) ?? [];
      if (matches.length === 1) values[matches[0].id] = value;
      else unresolvedValues[key] = value;
    }
    return { ...variant, values, unresolvedValues };
  });
}

/**
 * Any schema change that could make a populated value disappear or become
 * invalid is surfaced before a draft can be submitted. Reordering options is
 * not a semantic change; the comparison treats option lists as sets.
 */
export function draftAttributeReconciliationIssues(
  variants: readonly DraftVariantAttributes[],
  snapshot: Readonly<Record<string, AttributeDefinitionSnapshot>>,
  definitions: readonly AttributeDefinitionView[],
): DraftAttributeReconciliationIssue[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const issues: DraftAttributeReconciliationIssue[] = [];
  for (const variant of variants) {
    for (const [definitionId, value] of Object.entries(variant.values ?? {})) {
      if (!value.trim()) continue;
      const previous = snapshot[definitionId];
      const current = byId.get(definitionId);
      const previousName = previous?.name ?? current?.name ?? definitionId;
      if (!current) {
        issues.push({ variantId: variant.id, definitionId, previousName, currentName: null, value, reason: "definition_removed", sourceKey: definitionId, source: "values" });
        continue;
      }
      if (!current.isActive) {
        issues.push({ variantId: variant.id, definitionId, previousName, currentName: current.name, value, reason: "definition_inactive", sourceKey: definitionId, source: "values" });
        continue;
      }
      if (previous && (
        attributeComparisonKey(previous.name) !== attributeComparisonKey(current.name) ||
        previous.isActive !== current.isActive ||
        !sameOptionSet(previous.options, current.options)
      )) {
        issues.push({ variantId: variant.id, definitionId, previousName, currentName: current.name, value, reason: "schema_changed", sourceKey: definitionId, source: "values" });
      }
      if (current.options.length > 0 && !current.options.some((option) => attributeComparisonKey(option) === attributeComparisonKey(value))) {
        issues.push({ variantId: variant.id, definitionId, previousName, currentName: current.name, value, reason: "option_removed", sourceKey: definitionId, source: "values" });
      }
    }
    for (const [name, value] of Object.entries(variant.unresolvedValues ?? {})) {
      if (!value.trim()) continue;
      issues.push({ variantId: variant.id, definitionId: null, previousName: name, currentName: null, value, reason: "unmapped_legacy_value", sourceKey: name, source: "unresolvedValues" });
    }
  }
  return issues;
}

function sameOptionSet(left: readonly string[], right: readonly string[]): boolean {
  const leftKeys = left.map(attributeComparisonKey).sort();
  const rightKeys = right.map(attributeComparisonKey).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index]);
}
