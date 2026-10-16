/**
 * The one guard + error mapping every `/api/data/*` route uses.
 *
 * Shaped after `src/app/api/workspace/guard.ts` for the same reason it exists:
 * a dozen route files would otherwise repeat the same permission check, owner
 * construction and error mapping, and the twelfth would be the one that
 * quietly returned 500 for a validation error — or, worse, forgot the second
 * half of the permission check below.
 *
 * ## The two-key rule
 *
 * This module is one screen that reaches every app, so it must never become a
 * way around any app's own gate. Every operation is therefore authorized
 * TWICE, and `entityAccess` is the only place that is expressed:
 *
 *   1. the engine key — `data.export` / `data.import`, held by the member; and
 *   2. the entity's own key from the registry — `crm.export`, `menu.edit`,
 *      `ledger.post` — the same key the module's own screens are gated on.
 *
 * An owner holds everything, so nothing changes for them. A CRM manager
 * without `menu.edit` can export customers here and cannot import a menu, at
 * this route, for the same reason they cannot at `/api/menu/items`.
 *
 * Note what this file does NOT do: it never invents authorization. Both checks
 * go through `requirePermission` from `@/lib/auth`, so per-member overrides
 * apply exactly as they do everywhere else, and `api-guards.test.ts` sees a
 * real guard in every route that imports it.
 */
import { NextResponse } from "next/server";
import { requirePermission, type SessionPayload } from "@/lib/auth";
import { memberAccessFor } from "@/lib/member-access";
import { PERMISSIONS, type Permission } from "@/lib/permissions";
import { findEntity } from "@/lib/data-transfer/registry";
import { ExportError } from "@/lib/data-transfer/export-service";
import { ImportError } from "@/lib/data-transfer/import-service";
import { ScheduleError } from "@/lib/data-transfer/schedule-service";
import { TemplateError } from "@/lib/data-transfer/templates-service";
import type { EntityDefinition } from "@/lib/data-transfer/types";

export { PERMISSIONS };

/** Who is asking, and on behalf of which business and branch. */
export interface DataOwner {
  businessId: string;
  locationId: string | null;
  actorUserId: string;
  actorName: string;
  /**
   * The verified session itself, carried so `entityAccess` can resolve the
   * member's effective permissions through `memberAccessFor` without a second
   * hand-written membership read.
   */
  session: SessionPayload;
}

/**
 * Resolves the session behind an engine permission (`data.import` /
 * `data.export`) and shapes it into the owner every service function takes.
 */
export async function dataOwner(
  permission: Permission,
): Promise<{ owner: DataOwner; error: null } | { owner: null; error: NextResponse }> {
  const { session, error } = await requirePermission(permission);
  if (error) return { owner: null, error };
  return {
    owner: {
      businessId: session.businessId,
      locationId: session.locationId ?? null,
      actorUserId: session.sub,
      actorName: session.fullName ?? "",
      session,
    },
    error: null,
  };
}

/**
 * The second half of the two-key rule: the entity exists, and this member
 * holds the entity's own permission for the direction they asked for.
 *
 * Returns the entity so the caller does not look it up twice.
 */
export async function entityAccess(
  owner: DataOwner,
  entityKey: string | null,
  direction: "import" | "export",
): Promise<{ entity: EntityDefinition; error: null } | { entity: null; error: NextResponse }> {
  const entity = findEntity(entityKey);
  if (!entity) {
    return {
      entity: null,
      error: NextResponse.json({ error: "unknown_entity" }, { status: 404 }),
    };
  }
  const required =
    direction === "import" ? entity.importPermission : entity.exportPermission;
  if (!required) {
    return {
      entity: null,
      error: NextResponse.json({ error: "entity_not_importable" }, { status: 400 }),
    };
  }

  // Read through `memberAccessFor`, the product's one copy of "what may this
  // member do" — a second hand-written membership read here is how a screen
  // and its route end up disagreeing.
  const access = await memberAccessFor(owner.session);
  if (!access?.isActive || !access.permissions.has(required)) {
    return {
      entity: null,
      error: NextResponse.json({ error: "forbidden", requires: required }, { status: 403 }),
    };
  }
  return { entity, error: null };
}

/**
 * The status each service error code deserves. Anything absent is a bug in the
 * service, not a client error, so it falls through to the rethrow in
 * `handleDataError` and surfaces as a 500 with a stack trace rather than being
 * silently dressed up as a 400.
 */
const ERROR_STATUS: Record<string, number> = {
  unknown_entity: 404,
  job_not_found: 404,
  schedule_not_found: 404,
  template_not_found: 404,
  entity_not_importable: 400,
  location_required: 409,
  empty_file: 400,
  no_rows: 400,
  no_fields: 400,
  no_failed_rows: 400,
  unsupported_format: 415,
  too_many_rows: 413,
  missing_required_fields: 400,
  has_invalid_rows: 400,
  already_completed: 409,
  job_running: 409,
  name_required: 400,
  name_taken: 409,
  invalid_email: 400,
  no_delivery: 400,
  /*
   * Issue #947 — the stored file was produced under a wider audience than the caller
   * holds now. 403, not 410: the file is still there, it is the *permission* that
   * changed, and the body carries `requires` so the screen can name the key instead of
   * showing «دسترسی ندارید» with no next step.
   */
  export_requires_regeneration: 403,
};

/** Maps a thrown engine error onto a response; rethrows anything else. */
export function handleDataError(error: unknown): NextResponse {
  if (
    error instanceof ImportError ||
    error instanceof ExportError ||
    error instanceof TemplateError ||
    error instanceof ScheduleError
  ) {
    const status = ERROR_STATUS[error.code] ?? 400;
    // The refusal names what is missing when the error carries it (issue #947's stored
    // export, the provider scope checks) — the same `{ error, requires }` shape
    // `entityAccess` answers with, so one screen reader handles both.
    const requires = error instanceof ExportError ? error.requires : undefined;
    const reason = error instanceof ExportError ? error.reason : undefined;
    return NextResponse.json(
      {
        error: error.code,
        ...(requires && requires.length > 0 ? { requires } : {}),
        ...(reason ? { reason } : {}),
      },
      { status },
    );
  }
  throw error;
}

/** Reads a JSON body, returning `{}` rather than throwing on a malformed one. */
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
}

/**
 * A downloadable-file response.
 *
 * The filename carries Persian text, and a bare `filename=` header value must
 * be a ByteString (ASCII), so it is RFC 5987-encoded with an ASCII fallback
 * for older clients — the same shape `/api/reports/export` uses. `no-store`
 * because the body is the business's own data and a shared cache holding it is
 * a leak.
 */
export function fileResponse(
  body: Buffer | string,
  contentType: string,
  fileName: string,
  extra: Record<string, string> = {},
): NextResponse {
  const dot = fileName.lastIndexOf(".");
  const ext = dot >= 0 ? fileName.slice(dot) : "";
  return new NextResponse(typeof body === "string" ? body : new Uint8Array(body), {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `attachment; filename="export${ext}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}
