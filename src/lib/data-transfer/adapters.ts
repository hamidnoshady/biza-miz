/**
 * The adapter contract: what a module has to supply so the engine can move its
 * entity in either direction.
 *
 * Server-only (the implementations touch the database), and deliberately tiny:
 * two functions and an optional third. Everything else — parsing, mapping,
 * validation, duplicate policy, relationship policy, queueing, history,
 * templates, scheduling — is the engine's, written once.
 *
 * `read` and `write` run inside a tenant scope the caller already established
 * (`withTenant`/`withTenantScope`), so an adapter never passes a business id to
 * RLS; it passes it to the service functions that expect one.
 */

import type { PartyReadAudience } from "../personnel-access";
import type { EntityDefinition, RelationMissingStrategy } from "./types";

/** The tenant and branch an adapter is operating on. */
export interface AdapterContext {
  businessId: string;
  /** The active branch, for a `locationScoped` entity. Null otherwise. */
  locationId: string | null;
  /** Who asked, for the services that record an actor. */
  actorUserId: string | null;
  actorName: string;
  /**
   * What *this* caller may read of an Employee file (issue #947, TEAM-F01).
   *
   * An export is a read like any other, and one with a wider blast radius than a screen:
   * the file leaves the server and gets emailed around. The party entity therefore
   * narrows Employee rows the same way `/api/parties` does, using the audience the route
   * resolved from the actor's effective permissions. Left undefined by callers with no
   * requesting member (a test, a migration script), where the internal full read is
   * correct.
   */
  partyAudience?: PartyReadAudience;
}

export interface ReadOptions {
  /** Field keys the caller wants. The adapter may return more; extras are dropped. */
  fields: readonly string[];
  /** Entity-specific filters from the export builder. */
  filters: Record<string, unknown>;
  /** Hard ceiling. The engine always passes one. */
  limit: number;
  /** Export only these ids — the "selected rows" case. */
  ids?: readonly string[];
}

/**
 * The outcome of writing one row.
 *
 * `skipped` is a *successful* outcome: it is what a duplicate under the "skip"
 * strategy produces, and what a `warn` relation produces when the operator
 * asked for the row to land without its parent.
 */
export type WriteOutcome =
  | { status: "created"; id: string; warnings?: string[] }
  | { status: "updated"; id: string; warnings?: string[] }
  | { status: "skipped"; id?: string; reason: string }
  | { status: "failed"; reason: string };

export interface WriteOptions {
  /** How a row that matched an existing record is handled. */
  duplicateStrategy: "update" | "skip" | "create";
  /** Which duplicate rule to match on; the entity's first when absent. */
  duplicateRule: string | null;
  /** Per-reference-field override of the field's own default. */
  relationStrategy: Record<string, RelationMissingStrategy>;
}

/**
 * One module's implementation for one entity.
 *
 * `read` answers rows keyed by the entity's field keys, already
 * human-readable: `categoryName: "نوشیدنی گرم"`, never `category_id: 15`. That
 * is a requirement of the engine, not a nicety — an export whose foreign keys
 * are integers is one nobody can use and nobody can re-import.
 */
export interface EntityAdapter {
  entity: string;
  read(context: AdapterContext, options: ReadOptions): Promise<Record<string, unknown>[]>;
  /** Absent for an export-only entity. */
  write?(
    context: AdapterContext,
    values: Record<string, unknown>,
    options: WriteOptions,
  ): Promise<WriteOutcome>;
  /**
   * Resolve a reference this entity is the *target* of — "is there a category
   * called «نوشیدنی گرم», and if not, make one". Only entities that other
   * entities point at need this.
   */
  resolveReference?(
    context: AdapterContext,
    lookup: string,
    options: { create: boolean },
  ): Promise<{ id: string; label: string } | null>;
}

/** Thrown by an adapter to reject one row with a Persian explanation. */
export class RowRejection extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "RowRejection";
  }
}

/** The registry of adapters, filled by `entities/index.ts`. */
const ADAPTERS = new Map<string, EntityAdapter>();

export function registerAdapter(adapter: EntityAdapter): void {
  ADAPTERS.set(adapter.entity, adapter);
}

export function findAdapter(entityKey: string): EntityAdapter | null {
  return ADAPTERS.get(entityKey) ?? null;
}

export function requireAdapter(entityKey: string): EntityAdapter {
  const adapter = ADAPTERS.get(entityKey);
  if (!adapter) throw new Error(`no adapter registered for ${entityKey}`);
  return adapter;
}

/** Every registered adapter key — used by the registry-coverage test. */
export function registeredAdapterKeys(): string[] {
  return [...ADAPTERS.keys()].sort();
}

/**
 * The strategy in force for one reference field: the operator's override if
 * they set one, otherwise the field's own default from the registry.
 */
export function relationStrategyFor(
  entity: EntityDefinition,
  fieldKey: string,
  overrides: Record<string, RelationMissingStrategy>,
): RelationMissingStrategy {
  const override = overrides[fieldKey];
  if (override) return override;
  const field = entity.fields.find((candidate) => candidate.key === fieldKey);
  return field?.relation?.onMissing ?? "warn";
}
