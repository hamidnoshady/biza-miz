/**
 * Request-local authorization facts that must travel to Postgres.
 *
 * The fiscal-period trigger is a final integrity boundary, so it cannot infer
 * permissions from raw role names. `authorize()` supplies this snapshot after
 * resolving the live membership; db.ts only forwards it when its business
 * matches the active tenant scope. A fresh authorization boundary starts
 * empty, and callers outside one never acquire DB privileges accidentally.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { TenantScope } from "./tenant-context";

export interface AuthorizationSnapshot {
  businessId: string;
  userId: string;
  membershipActive: boolean;
  businessActive: boolean;
  canCloseFiscalPeriod: boolean;
}

export interface DatabaseAuthorizationSettings {
  actorId: string;
  canCloseFiscalPeriod: string;
}

interface AuthorizationContext {
  snapshot: AuthorizationSnapshot | null;
}

const globalForAuthorizationContext = globalThis as unknown as {
  authorizationSnapshotStorage?: AsyncLocalStorage<AuthorizationContext | null>;
};
const storage =
  globalForAuthorizationContext.authorizationSnapshotStorage ??
  new AsyncLocalStorage<AuthorizationContext | null>();
globalForAuthorizationContext.authorizationSnapshotStorage = storage;

/** Isolate authorization state for a request, including anonymous requests. */
export function withAuthorizationContext<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run({ snapshot: null }, fn);
}

/**
 * Replace the current request's snapshot with facts returned by the canonical
 * evaluator. Outside an authorization boundary this intentionally does
 * nothing, so a server component or background callback cannot leak a grant
 * into another async task. The mutable request-local holder makes the update
 * visible to the caller's continuation after `authorize()` resolves.
 */
export function setAuthorizationSnapshot(snapshot: AuthorizationSnapshot): void {
  const context = storage.getStore();
  if (context) context.snapshot = snapshot;
}

export function getAuthorizationSnapshot(): AuthorizationSnapshot | null {
  return storage.getStore()?.snapshot ?? null;
}

/**
 * Values applied to each DB connection checkout. A permission is usable only
 * for the same live business scope and a current active member/business.
 */
export function databaseAuthorizationSettings(
  scope: TenantScope,
  snapshot: AuthorizationSnapshot | null = getAuthorizationSnapshot(),
): DatabaseAuthorizationSettings {
  const matches =
    scope.kind === "business" &&
    snapshot !== null &&
    scope.businessId === snapshot.businessId &&
    scope.userId === snapshot.userId &&
    snapshot.membershipActive &&
    snapshot.businessActive;
  return {
    actorId: matches ? snapshot.userId : "",
    canCloseFiscalPeriod: matches && snapshot.canCloseFiscalPeriod ? "on" : "",
  };
}
