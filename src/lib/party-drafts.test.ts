import { describe, expect, it } from "vitest";
import {
  MAX_PARTY_DRAFTS,
  PARTY_DRAFT_STORAGE_KEY,
  clearPartyDrafts,
  deletePartyDraft,
  listPartyDrafts,
  loadPartyDraft,
  localStorageDraftStorage,
  partyDraftLabel,
  partyFormHasUnsavedChanges,
  savePartyDraft,
  type DraftStorage,
} from "./party-drafts";
import { PARTY_FORM_DEFAULTS, resetPartyForm } from "./parties";

/**
 * The draft store, against a fake `Storage`.
 *
 * Three properties are worth the test: a draft belongs to exactly one business and
 * is never readable from another (the browser is shared, the tenant is not); saving
 * the same draft twice is one row; and a browser that refuses to store anything
 * turns into no drafts rather than a broken form.
 */

function memoryStorage(initial: Record<string, string> = {}): DraftStorage & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
    dump: () => Object.fromEntries(data),
  };
}

const BUSINESS = "bbbbbbbb-1111-4111-8111-111111111111";
const OTHER = "cccccccc-1111-4111-8111-111111111111";

const state = (displayName: string) => ({ ...resetPartyForm(), displayName });

describe("saving a draft", () => {
  it("keeps one row per draft id", () => {
    const storage = memoryStorage();
    const first = savePartyDraft(storage, {
      businessId: BUSINESS,
      state: state("نانوایی شرق"),
      newId: () => "draft-1",
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(first?.id).toBe("draft-1");
    savePartyDraft(storage, {
      businessId: BUSINESS,
      state: state("نانوایی شرق و غرب"),
      draftId: "draft-1",
      now: () => "2026-01-01T00:05:00.000Z",
    });
    const drafts = listPartyDrafts(storage, BUSINESS);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].state.displayName).toBe("نانوایی شرق و غرب");
    expect(drafts[0].savedAt).toBe("2026-01-01T00:05:00.000Z");
  });

  it("stores the payload beside the state", () => {
    const storage = memoryStorage();
    const draft = savePartyDraft(storage, { businessId: BUSINESS, state: state("نانوایی") });
    // The document the form would have sent, so a restored draft shows what it
    // changes without re-deriving the rules a second time.
    expect(draft?.payload.displayName).toBe("نانوایی");
    expect(draft?.payload.general_info.taxPercentage).toBe(PARTY_FORM_DEFAULTS.generalInfo.taxPercentage);
  });

  it("names a draft by the party, not by a uuid", () => {
    expect(partyDraftLabel(state("مریم رضایی"))).toBe("مریم رضایی");
    expect(partyDraftLabel(resetPartyForm())).toBe("بی‌نام");
  });

  it("caps one business's drafts at the oldest leaving", () => {
    const storage = memoryStorage();
    for (let index = 0; index < MAX_PARTY_DRAFTS + 5; index += 1) {
      savePartyDraft(storage, {
        businessId: BUSINESS,
        state: state(`ذکره ${index}`),
        newId: () => `draft-${index}`,
        now: () => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      });
    }
    const drafts = listPartyDrafts(storage, BUSINESS);
    expect(drafts).toHaveLength(MAX_PARTY_DRAFTS);
    // Newest first, and the survivors are the newest twenty.
    expect(drafts[0].state.displayName).toBe(`ذکره ${MAX_PARTY_DRAFTS + 4}`);
    expect(drafts.map((draft) => draft.state.displayName)).not.toContain("ذکره 0");
  });

  it("evicts another business's rows never", () => {
    const storage = memoryStorage();
    savePartyDraft(storage, { businessId: OTHER, state: state("فروشگاه دیگر"), newId: () => "other-1" });
    for (let index = 0; index < MAX_PARTY_DRAFTS + 5; index += 1) {
      savePartyDraft(storage, { businessId: BUSINESS, state: state(`ذکره ${index}`), newId: () => `mine-${index}` });
    }
    expect(listPartyDrafts(storage, OTHER).map((draft) => draft.id)).toEqual(["other-1"]);
  });
});

describe("reading and removing", () => {
  it("shows nothing of another business's drafts", () => {
    const storage = memoryStorage();
    savePartyDraft(storage, { businessId: BUSINESS, state: state("این کسب‌وکار"), newId: () => "a" });
    savePartyDraft(storage, { businessId: OTHER, state: state("کسب‌وکار دیگر"), newId: () => "b" });
    expect(listPartyDrafts(storage, BUSINESS).map((draft) => draft.label)).toEqual(["این کسب‌وکار"]);
    expect(loadPartyDraft(storage, BUSINESS, "b")).toBeNull();
    expect(loadPartyDraft(storage, OTHER, "b")?.label).toBe("کسب‌وکار دیگر");
  });

  it("survives a body of JSON someone else wrote", () => {
    // An older extension, a half-written quota failure, a person pasting into
    // devtools: none of them may take the form down with them.
    const storage = memoryStorage({ [PARTY_DRAFT_STORAGE_KEY]: "{not json" });
    expect(listPartyDrafts(storage, BUSINESS)).toEqual([]);
    expect(savePartyDraft(storage, { businessId: BUSINESS, state: state("دوباره") })).not.toBeNull();
  });

  it("deletes one and returns what is left", () => {
    const storage = memoryStorage();
    savePartyDraft(storage, { businessId: BUSINESS, state: state("اول"), newId: () => "one" });
    savePartyDraft(storage, { businessId: BUSINESS, state: state("دوم"), newId: () => "two" });
    const rest = deletePartyDraft(storage, BUSINESS, "one");
    expect(rest.map((draft) => draft.id)).toEqual(["two"]);
    expect(loadPartyDraft(storage, BUSINESS, "one")).toBeNull();
  });

  it("clears a business without touching another's", () => {
    const storage = memoryStorage();
    savePartyDraft(storage, { businessId: BUSINESS, state: state("اول"), newId: () => "one" });
    savePartyDraft(storage, { businessId: OTHER, state: state("دیگری"), newId: () => "two" });
    clearPartyDrafts(storage, BUSINESS);
    expect(listPartyDrafts(storage, BUSINESS)).toEqual([]);
    expect(listPartyDrafts(storage, OTHER)).toHaveLength(1);
  });

  it("does nothing at all without storage", () => {
    expect(listPartyDrafts(null, BUSINESS)).toEqual([]);
    expect(savePartyDraft(null, { businessId: BUSINESS, state: state("x") })).toBeNull();
    expect(loadPartyDraft(null, BUSINESS, "one")).toBeNull();
    expect(deletePartyDraft(null, BUSINESS, "one")).toEqual([]);
    expect(() => clearPartyDrafts(null, BUSINESS)).not.toThrow();
    // A business id that is empty is the same as no storage: nothing is keyed.
    expect(listPartyDrafts(memoryStorage(), "")).toEqual([]);
  });

  it("refuses a browser that will not keep anything", () => {
    // Safari's private mode throws on `setItem` even though `localStorage`
    // exists; the probe is what turns that into "no drafts" instead of a throw
    // inside the form's render.
    const original = globalThis.window;
    const define = (value: unknown) =>
      Object.defineProperty(globalThis, "window", { value, configurable: true, writable: true });
    define({
      localStorage: {
        setItem: () => {
          throw new Error("quota");
        },
        getItem: () => null,
        removeItem: () => undefined,
      },
    });
    try {
      expect(localStorageDraftStorage()).toBeNull();
    } finally {
      define(original);
    }
    // No window at all (a server render) is the same answer.
    expect(localStorageDraftStorage()).toBeNull();
  });
});

describe("unsaved changes", () => {
  it("is false for a form nobody typed in", () => {
    expect(partyFormHasUnsavedChanges(resetPartyForm(), PARTY_FORM_DEFAULTS)).toBe(false);
  });

  it("is false when the only change is the default written back as itself", () => {
    // Clearing the tax field (back to «follows the business rate»), or moving
    // through a tab and leaving it as it was, must not create a draft or prompt
    // to restore one.
    const touched = { ...resetPartyForm(), generalInfo: { ...resetPartyForm().generalInfo, taxPercentage: null } };
    expect(partyFormHasUnsavedChanges(touched, PARTY_FORM_DEFAULTS)).toBe(false);
  });

  it("is true when a rate is typed, since a new party assumes none (audit F05)", () => {
    const touched = { ...resetPartyForm(), generalInfo: { ...resetPartyForm().generalInfo, taxPercentage: 9 } };
    expect(partyFormHasUnsavedChanges(touched, PARTY_FORM_DEFAULTS)).toBe(true);
  });

  it("is true on the first character of a name", () => {
    expect(partyFormHasUnsavedChanges(state("م"), PARTY_FORM_DEFAULTS)).toBe(true);
  });

  it("is true when only a tab changed", () => {
    const touched = {
      ...resetPartyForm(),
      contactInfo: { ...resetPartyForm().contactInfo, mobile: "09123456789" },
    };
    expect(partyFormHasUnsavedChanges(touched, PARTY_FORM_DEFAULTS)).toBe(true);
  });
});
