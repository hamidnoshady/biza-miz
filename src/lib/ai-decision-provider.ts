/** Server-side transport for already authorized, minimized decision state. */

type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> }
  | { type: "score"; instructions: string; criteria: readonly string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } };

type DecisionAnswer =
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: "score"; score: number; confidence: number; probabilities: Record<string, number>; legend: Record<string, string> }
  | { type: "noul"; probabilityYes: number };

type DecisionRequest = {
  state: string;
  questions: Readonly<Record<string, DecisionQuestion>>;
};

type DecisionResult =
  | { status: "evaluated"; model: string; answers: Record<string, DecisionAnswer>; usage: { inputTokens: number; outputTokens: number } }
  | { status: "unavailable"; reason: "not_configured" | "invalid_request" | "aborted" | "timeout" | "network" | "provider_error" | "invalid_response"; httpStatus?: number };

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MAX_STATE_BYTES = 8_192;
const MAX_REQUEST_BYTES = 16_384;
const MAX_RESPONSE_BYTES = 65_536;
const MAX_QUESTIONS = 8;
const TIMEOUT_MS = 5_000;
const KEY = /^(?!constructor$|prototype$)[a-z][a-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit && value.trim().length > 0;
}

function validRequest(request: DecisionRequest): boolean {
  if (!boundedText(request.state, MAX_STATE_BYTES) || Buffer.byteLength(request.state) > MAX_STATE_BYTES) return false;
  if (!isRecord(request.questions)) return false;
  const questions = Object.entries(request.questions);
  if (questions.length < 1 || questions.length > MAX_QUESTIONS) return false;
  return questions.every(([key, question]) => {
    if (!KEY.test(key) || !isRecord(question) || !boundedText(question.instructions, 512)) return false;
    switch (question.type) {
      case "choice": {
        if (!isRecord(question.criteria)) return false;
        const choices = Object.entries(question.criteria);
        return choices.length >= 2 && choices.length <= 16 &&
          choices.every(([name, description]) => KEY.test(name) && boundedText(description, 256));
      }
      case "score":
        return Array.isArray(question.criteria) && question.criteria.length >= 2 &&
          question.criteria.length <= 10 &&
          Array.from(question.criteria).every((label) => boundedText(label, 256));
      case "noul":
        return question.criteria === undefined || (
          isRecord(question.criteria) &&
          Object.keys(question.criteria).length === 2 &&
          boundedText(question.criteria.true, 256) && boundedText(question.criteria.false, 256)
        );
      default:
        return false;
    }
  });
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function hasExactKeys(data: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(data).length === keys.length && keys.every((key) => Object.hasOwn(data, key));
}

function readProbabilities(value: unknown, keys: readonly string[]): Record<string, number> | null {
  if (!isRecord(value) || !hasExactKeys(value, keys)) return null;
  const entries: [string, number][] = [];
  let sum = 0;
  for (const key of keys) {
    const probability = value[key];
    if (!isProbability(probability)) return null;
    entries.push([key, probability]);
    sum += probability;
  }
  return Math.abs(sum - 1) <= 0.01 ? Object.fromEntries(entries) : null;
}

function readAnswer(value: unknown, question: DecisionQuestion): DecisionAnswer | null {
  if (!isRecord(value) || value.type !== question.type) return null;
  if (question.type === "noul") {
    return isProbability(value.noul) ? { type: "noul", probabilityYes: value.noul } : null;
  }
  if (!isProbability(value.confidence)) return null;
  const confidence = value.confidence;
  if (question.type === "choice") {
    const probabilities = readProbabilities(value.probabilities, Object.keys(question.criteria));
    const choice = value.choice;
    if (!probabilities || typeof choice !== "string" || !Object.hasOwn(probabilities, choice) ||
        probabilities[choice] < Math.max(...Object.values(probabilities))) return null;
    return { type: "choice", choice, confidence, probabilities };
  }
  const levels = question.criteria.map((_, index) => String(index));
  const probabilities = readProbabilities(value.probabilities, levels);
  const legend = value.legend;
  const score = value.score;
  if (!probabilities || !isRecord(legend) || !hasExactKeys(legend, levels) ||
      !levels.every((level, index) => legend[level] === question.criteria[index]) ||
      typeof score !== "number" || !Number.isFinite(score) || score < 0 ||
      score > levels.length - 1) return null;
  return {
    type: "score", score, confidence, probabilities,
    legend: Object.fromEntries(levels.map((level, index) => [level, question.criteria[index]])),
  };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readResult(value: unknown, model: string, questions: DecisionRequest["questions"]): DecisionResult {
  const invalid = { status: "unavailable", reason: "invalid_response" } as const;
  if (!isRecord(value) || value.model !== model ||
      !isRecord(value.answers) || !hasExactKeys(value.answers, Object.keys(questions)) ||
      !isRecord(value.usage)) return invalid;
  const inputTokens = value.usage.input_tokens;
  const outputTokens = value.usage.output_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) return invalid;
  const answers: [string, DecisionAnswer][] = [];
  for (const [name, question] of Object.entries(questions)) {
    const answer = readAnswer(value.answers[name], question);
    if (!answer) return invalid;
    answers.push([name, answer]);
  }
  return { status: "evaluated", model, answers: Object.fromEntries(answers), usage: { inputTokens, outputTokens } };
}

async function readResponse(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    try {
      return JSON.parse(text + decoder.decode()) as unknown;
    } catch {
      return null;
    }
  } finally {
    reader.releaseLock();
  }
}

export async function evaluateSystemOne(
  request: DecisionRequest,
  config: { apiKey: string; model: string },
  signal?: AbortSignal,
): Promise<DecisionResult> {
  if (!config.apiKey.trim() || !/^[a-zA-Z0-9_.-]{1,128}$/.test(config.model)) {
    return { status: "unavailable", reason: "not_configured" };
  }
  if (!validRequest(request)) return { status: "unavailable", reason: "invalid_request" };
  // Project the wire fields explicitly. Context/credentials belong to the caller;
  // a transport request must never serialize additional caller or policy fields.
  const questions = Object.fromEntries<DecisionQuestion>(Object.entries(request.questions).map(([name, question]) => {
    switch (question.type) {
      case "choice":
        return [name, { type: question.type, instructions: question.instructions, criteria: { ...question.criteria } }];
      case "score":
        return [name, { type: question.type, instructions: question.instructions, criteria: [...question.criteria] }];
      case "noul":
        return [name, {
          type: question.type, instructions: question.instructions,
          criteria: question.criteria && { true: question.criteria.true, false: question.criteria.false },
        }];
    }
  }));
  const body = JSON.stringify({ model: config.model, state: request.state, questions });
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) return { status: "unavailable", reason: "invalid_request" };
  if (signal?.aborted) return { status: "unavailable", reason: "aborted" };
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      redirect: "error",
      cache: "no-store",
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { status: "unavailable", reason: "provider_error", httpStatus: response.status };
    }
    return readResult(await readResponse(response), config.model, questions);
  } catch {
    if (signal?.aborted) return { status: "unavailable", reason: "aborted" };
    if (timeout.aborted) return { status: "unavailable", reason: "timeout" };
    return { status: "unavailable", reason: "network" };
  }
}
