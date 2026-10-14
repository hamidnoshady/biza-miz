import { describe, expect, it } from "vitest";
import {
  AUTOPILOT_NOTE_PREFIX,
  MCP_ACTOR_PREFIX,
  provenanceLabel,
  provenanceOfMemo,
} from "./ai-provenance";

/**
 * The mark is the only record an AI-written row carries, so the read-back has
 * to keep matching what the writer writes — a drift here silently relabels a
 * machine's draft as a person's, or the other way round.
 */
describe("provenanceOfMemo", () => {
  it("recognises an autopilot memo by its prefix", () => {
    expect(provenanceOfMemo(`${AUTOPILOT_NOTE_PREFIX}اجاره ماهانه`)).toBe("autopilot");
  });

  it("recognises an MCP connector memo by its prefix", () => {
    expect(provenanceOfMemo(`${MCP_ACTOR_PREFIX}تسویه حساب`)).toBe("mcp");
  });

  it("tolerates leading whitespace, since the prefix is what matters", () => {
    expect(provenanceOfMemo(`  ${AUTOPILOT_NOTE_PREFIX}اجاره`)).toBe("autopilot");
  });

  it("reads an unmarked memo as nothing at all, never as a guess", () => {
    // The failure mode of defaulting to "AI" is a manager's hand-typed journal
    // being discounted by the reviewer reading it.
    expect(provenanceOfMemo("اجاره ماهانه")).toBeNull();
    expect(provenanceOfMemo("")).toBeNull();
    expect(provenanceOfMemo(null)).toBeNull();
    expect(provenanceOfMemo(undefined)).toBeNull();
  });

  it("does not match a memo that merely mentions the assistant", () => {
    expect(provenanceOfMemo("یادداشت: دستیار پیشنهاد داد")).toBeNull();
  });
});

describe("provenanceLabel", () => {
  it("names the two sources and says nothing about a person's own entry", () => {
    expect(provenanceLabel("autopilot")).toContain("دستیار");
    expect(provenanceLabel("mcp")).toContain("اتصال هوش مصنوعی");
    expect(provenanceLabel(null)).toBeNull();
  });
});
