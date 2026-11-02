import { NextResponse } from "next/server";
import { CampaignBuilderError } from "./campaign-builder-service";

/** Maps the builder's typed errors onto the JSON error shape every Growth route answers with. */
export function campaignBuilderErrorResponse(error: unknown): NextResponse {
  if (error instanceof CampaignBuilderError) {
    return NextResponse.json(
      { error: error.code, ...(error.problems ? { problems: error.problems } : {}) },
      { status: error.status },
    );
  }
  throw error;
}

/** A JSON object body, or `null` when the body is missing, malformed or not an object. */
export async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
