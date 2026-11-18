/**
 * ESH-184 — the Superadmin playground's SSE reader.
 *
 * The server emits `event: <name>` / `data: <json>` blocks while LiteLLM
 * streams. Keeping the framing in this small, browser-only module lets the
 * component focus on state and lets a test drive real chunk boundaries (an
 * event split across two reads is the bug class this parser exists to avoid).
 */

export interface PlatformAiPromptVersions {
  base: number | null;
  mode: number | null;
}

export interface PlatformAiToolGrant {
  name: string;
  allowed: boolean;
}

export interface PlatformAiDiagnostics {
  requestId?: string;
  mode?: string;
  modelAlias?: string;
  promptVersions?: PlatformAiPromptVersions;
  /** Tools the request explicitly authorised (never inferred client-side). */
  authorizedTools?: string[];
  tokens?: number | null;
  costUsd?: number | null;
  toolsUsed?: string[];
  toolGrants?: PlatformAiToolGrant[];
  latencyMs?: number | null;
  finishReason?: string | null;
}

export interface PlatformAiStreamEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Parse one complete SSE block. Malformed blocks are ignored, never thrown. */
export function parsePlatformAiEvent(block: string): PlatformAiStreamEvent | null {
  let event = "message";
  let data = "";
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).replace(/^ /, "");
  }
  if (!data) return null;
  try {
    const parsed: unknown = JSON.parse(data);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { event, data: parsed as Record<string, unknown> };
  } catch {
    return null;
  }
}

/**
 * Read an SSE body to its terminal event. `onEvent` returns true once the
 * stream is finished (`done` or `error`); the reader then stops promptly even
 * if the server has not closed the connection yet.
 */
export async function readPlatformAiStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (event: PlatformAiStreamEvent) => boolean,
): Promise<{ terminal: boolean }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let terminal = false;
  const dispatch = (block: string): boolean => {
    const parsed = parsePlatformAiEvent(block);
    return parsed ? onEvent(parsed) : false;
  };

  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (dispatch(block)) {
          terminal = true;
          break;
        }
      }
    }
    if (!terminal) {
      buffer += decoder.decode();
      if (buffer.trim()) terminal = dispatch(buffer);
    }
  } finally {
    reader.releaseLock();
  }
  return { terminal };
}
