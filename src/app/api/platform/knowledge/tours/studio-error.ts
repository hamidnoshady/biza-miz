import { NextResponse } from "next/server";
import { StudioTourServiceError } from "@/lib/tour-studio-service";

/**
 * The console's tour routes all answer a service refusal the same way, so the
 * status codes live in one place: a missing tour is a 404, a stale editor is a
 * 409 (it read an older revision), and anything the validation refused is a
 * 400 with the sentence the panel shows.
 */
export function studioError(err: unknown): NextResponse {
  if (!(err instanceof StudioTourServiceError)) throw err;
  const status =
    err.code === "not_found"
      ? 404
      : err.code === "version_conflict" || err.code === "not_draft"
        ? 409
        : 400;
  return NextResponse.json({ error: err.code, detail: err.detail }, { status });
}
