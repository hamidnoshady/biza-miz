import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { platformAudit } from "./platform-auth";
import { evaluateSystemOne } from "./ai-decision-provider";
import { checkRateLimit, type RateLimitEntry } from "./rate-limit";

const SMOKE_CASE = "support-triage-v1";
const CASE = {
  state: "Synthetic request: What are your store opening hours on Saturday? No complaint, missed deadline or request for a callback.",
  questions: {
    intent: {
      type: "choice",
      instructions: "Classify the support request by its stated intent.",
      criteria: { information: "An ordinary information request", complaint: "A complaint about a product or service", other: "Neither type" },
    },
    urgency: {
      type: "score",
      instructions: "Rate the urgency based on the details actually provided.",
      criteria: ["Routine informational question", "Time-sensitive issue", "Immediate escalation required"],
    },
    follow_up: {
      type: "noul",
      instructions: "Does the requester explicitly ask for a callback or another follow-up?",
    },
  },
} as const;
const smokeLimit = new Map<string, RateLimitEntry>();

/** Called only after the playground's platform capability check. */
export async function runDecisionSmoke(body: { decisionSmoke?: unknown }, adminId: string, signal: AbortSignal) {
  if (body.decisionSmoke !== SMOKE_CASE || Object.keys(body).length !== 1) {
    return NextResponse.json({ error: "invalid_decision_smoke" }, { status: 400 });
  }
  const apiKey = process.env.TYPESAFE_DECISION_SMOKE_KEY?.trim();
  const model = process.env.TYPESAFE_DECISION_SMOKE_MODEL?.trim();
  if (process.env.TYPESAFE_DECISION_SMOKE_ENABLED !== "1" || !apiKey || !model) {
    return NextResponse.json({ error: "decision_smoke_unavailable" }, { status: 409 });
  }
  const limit = await checkRateLimit(smokeLimit, "platform:ai:jev-smoke", 3, 60_000, Date.now());
  if (!limit.allowed) {
    return NextResponse.json({ error: "rate_limited" }, {
      status: 429, headers: { "Retry-After": String(Math.ceil(limit.retryAfterMs / 1000)) },
    });
  }

  const requestId = randomUUID();
  const audit = { adminId, entity: "platform_ai_modes", entityId: SMOKE_CASE };
  const diagnostics = { requestId, provider: "jev", testCase: SMOKE_CASE };
  await platformAudit({ ...audit, action: "ai.playground.requested", payload: diagnostics });

  const result = await evaluateSystemOne(CASE, { apiKey, model }, signal);
  if (result.status === "unavailable") {
    await platformAudit({
      ...audit, action: "ai.playground.failed",
      payload: { ...diagnostics, reason: result.reason, providerStatus: result.httpStatus ?? null },
    });
    return NextResponse.json({ ...diagnostics, error: result.reason }, {
      status: result.reason === "aborted" ? 499 : 502, headers: { "Cache-Control": "no-store" },
    });
  }

  const { intent, urgency, follow_up: followUp } = result.answers;
  const passed = intent?.type === "choice" && intent.choice === "information" &&
    urgency?.type === "score" && urgency.score <= 1 &&
    followUp?.type === "noul" && followUp.probabilityYes < 0.5;
  await platformAudit({
    ...audit, action: "ai.playground.test",
    payload: { ...diagnostics, model: result.model, usage: result.usage, passed },
  });
  return NextResponse.json({ ...diagnostics, passed, evaluation: result }, { headers: { "Cache-Control": "no-store" } });
}
