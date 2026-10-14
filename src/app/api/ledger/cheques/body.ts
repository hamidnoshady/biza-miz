/**
 * Reading the body of a money-moving request.
 *
 * Most cheque actions need no payload — clearing a cheque needs nothing but the
 * cheque — so the obvious `try { await request.json() } catch {}` looks
 * harmless. It is not: it cannot tell "no body" from "a body the client failed
 * to serialise", so a truncated or malformed payload executes the action with
 * default values. For an endpoint that posts a journal entry, the only safe
 * reading of broken JSON is a refusal.
 *
 * So: no body at all is an empty object, anything else must parse to a JSON
 * object, and everything in between is `bad_request`.
 */
import type { NextRequest } from "next/server";

export class MalformedBodyError extends Error {
  constructor() {
    super("bad_request");
  }
}

/** The request's JSON object, `{}` for an empty body, `MalformedBodyError` otherwise. */
export async function readJsonObjectBody(request: NextRequest): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    throw new MalformedBodyError();
  }
  if (raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new MalformedBodyError();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new MalformedBodyError();
  }
  return parsed as Record<string, unknown>;
}
