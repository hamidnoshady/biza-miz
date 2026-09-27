"use client";

/**
 * The party form — the one place a «شخص» is created or edited.
 *
 * One component, every app: the CRM opens it with the customer scope (so the role
 * arrives preset and the accounting tab is read-only), the store opens it with the
 * supplier scope, the team tab with the personnel scope, and Accounting with the
 * full scope. The *scope* changes what is shown and what is claimed for it; the
 * fields, the validation and the request body are this file's business alone. That
 * is the whole point of the rename — before it, the directory, the inventory
 * supplier tab and the ledger each had their own shorter form over their own
 * subset of the facts, and the facts disagreed.
 *
 * The state is flat (`PartyFormState`) and the request is nested
 * (`buildPartyPayload`): a form that holds its tabs in nested objects is a form
 * where «ذخیره» half-updates an address because one input wrote to the wrong level.
 * The nesting is a serialisation step at submit time, exactly once.
 *
 * Drafts are saved to `localStorage` per business and per party (`party-drafts.ts`)
 * — autosaved on a timer so a closed tab costs nothing, and never autosaved into
 * the record itself, which is the other thing a screen like this gets wrong.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ACCOUNTING_CODE_MODES,
  ACCOUNTING_CODE_MODE_LABELS,
  DEFAULT_TAX_PERCENTAGE,
  MAX_PARTY_DISPLAY_NAME,
  MAX_PARTY_NAME_PART,
  MAX_PARTY_NOTES,
  PARTY_PERSON_TYPES,
  PARTY_PERSON_TYPE_LABELS,
  PARTY_ROLES,
  PARTY_ROLE_LABELS,
  asciiDigits,
  buildNonAccountingPayload,
  buildPartyPayload,
  formStateFromParty,
  partyFieldErrorMessage,
  hasPartyRole,
  resetPartyForm,
  taxPercentageOf,
  togglePartyRole,
  validatePartyForm,
  withPartyRoles,
  type PartyApiRecord,
  type PartyFormState,
  type PartyRole,
} from "@/lib/parties";
import {
  deletePartyDraft,
  listPartyDrafts,
  localStorageDraftStorage,
  partyDraftLabel,
  partyFormHasUnsavedChanges,
  savePartyDraft,
  type PartyDraft,
} from "@/lib/party-drafts";
import {
  canEditAccountingInScope,
  canSeeAccountingInScope,
  type PartyScopeDef,
} from "@/lib/parties-scopes";
import { toPersianDigits } from "@/lib/digits";
import { formatJalali } from "@/lib/jalali";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PersianNumberInput } from "@/components/ui/persian-number-input";
import { Switch } from "@/components/ui/switch";
import { MediaImageField, MediaPickerDialog } from "../media/media-picker";
import { LoadingSkeleton, TabBar, TabPanel } from "../page-chrome";
import { api, errorMessage, ErrorBox, Field, InfoBox, inputClass } from "../ui";

const TAB_KEYS = ["general", "address", "contact", "financial"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const TAB_LABELS: Record<TabKey, string> = {
  general: "اطلاعات عمومی",
  address: "نشانی",
  contact: "راه‌های ارتباطی",
  financial: "اطلاعات مالی",
};

/** Which tab a field error belongs to, so the first error is the one you see. */
function tabForField(path: string): TabKey {
  if (path.startsWith("addressInfo")) return "address";
  if (path.startsWith("contactInfo")) return "contact";
  if (path.startsWith("financialInfo")) return "financial";
  return "general";
}

/** The draft autosave interval. Long enough that typing is not a write per keystroke. */
const DRAFT_AUTOSAVE_MS = 4_000;

export interface PartyFormDialogProps {
  scope: PartyScopeDef;
  /** The party being edited; absent for a new one. */
  partyId?: string | null;
  /** The record to hydrate from, when the caller already has it (the directory row). */
  initial?: PartyApiRecord | null;
  businessId: string;
  /**
   * The roles a *new* person starts with ticked — the directory's current view
   * («تأمین‌کنندگان» ticks تأمین‌کننده). Falls back to the scope's own default
   * role, which is what a single-role section always wants.
   */
  defaultRoles?: readonly PartyRole[];
  onClose: () => void;
  onSaved: (party: PartyApiRecord) => void;
}

export function PartyFormDialog({
  scope,
  partyId,
  initial,
  businessId,
  defaultRoles,
  onClose,
  onSaved,
}: PartyFormDialogProps) {
  const storage = useMemo(() => localStorageDraftStorage(), []);
  /**
   * The roles a new person opens with: the caller's (the directory's current
   * view), narrowed to what this scope may write, or the scope's default.
   */
  const openingRoles = useMemo(() => {
    const asked = (defaultRoles ?? []).filter((role) => scope.roles.includes(role));
    return asked.length > 0 ? asked : [scope.defaultRole];
  }, [defaultRoles, scope]);

  const [state, setState] = useState<PartyFormState>(() => {
    const hydrated = formStateFromParty(initial ?? null);
    // A new party starts from the app that opened the form (the store's «تأمین‌کننده
    // جدید» is not a customer with the label changed); an edit keeps its own roles.
    return partyId ? hydrated : withPartyRoles(hydrated, openingRoles);
  });
  /**
   * What the form looked like when it opened — the baseline «آیا تغییری ذخیره
   * نشده دارید؟» compares against. Kept as state and re-set on hydration so an
   * edit that loads its record from the server does not count the load itself
   * as an unsaved change.
   */
  const [baseline, setBaseline] = useState<PartyFormState>(state);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<TabKey>("general");
  const [busy, setBusy] = useState(false);
  /**
   * An edit opened by id (a deep link, a row that did not carry the record) has to
   * wait for the server's copy before it can show anything: rendering the empty
   * form for a beat and then swapping every field under the person reads as a
   * lost save.
   */
  const [loadingRecord, setLoadingRecord] = useState(Boolean(partyId && !initial));
  const [formError, setFormError] = useState("");
  const [info, setInfo] = useState("");
  const [draftId, setDraftId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<PartyDraft[]>([]);
  const [showDrafts, setShowDrafts] = useState(false);
  /** Replacing a legacy inline/linked avatar with one from the Media Library. */
  const [pickingAvatar, setPickingAvatar] = useState(false);
  /**
   * The tax field's own text, while it is being typed.
   *
   * The committed value lives in `state.generalInfo.taxPercentage` as a number,
   * but a number cannot represent «۹٫» — the moment somebody types the decimal
   * mark, coercing to a number and rendering it back deletes the character
   * under their caret. So the input holds text and commits on blur.
   */
  const [taxInput, setTaxInput] = useState(() =>
    String(taxPercentageOf(formStateFromParty(initial ?? null))),
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  const refreshDrafts = useCallback(() => {
    setDrafts(listPartyDrafts(storage, businessId));
  }, [storage, businessId]);

  useEffect(refreshDrafts, [refreshDrafts]);

  // An edit of a record that already exists starts from the server's copy, not
  // from whatever the row happened to render — the row shows two columns, the
  // record holds every tab.
  useEffect(() => {
    if (!partyId || initial) return;
    const controller = new AbortController();
    void api<{ party: PartyApiRecord }>(`/api/parties/${encodeURIComponent(partyId)}`, {
      signal: controller.signal,
    }).then(({ ok, aborted, data }) => {
      // A dialog the person closed mid-load must not write state back into a
      // form that is gone, and must not replace the *next* party's record with
      // the one they navigated away from.
      if (aborted) return;
      setLoadingRecord(false);
      if (!ok) {
        setFormError(errorMessage((data as { error?: string }).error));
        return;
      }
      const hydrated = formStateFromParty(data.party);
      setState(hydrated);
      setBaseline(hydrated);
      setTaxInput(String(taxPercentageOf(hydrated)));
    });
    return () => controller.abort();
  }, [partyId, initial]);

  /**
   * Autosave. Only once the form says something — a blank new party is not a draft,
   * and a list of them would be noise (`partyFormHasUnsavedChanges` is what says
   * so, comparing the *payload* rather than the state so a form that only reset a
   * number to its default does not count as edited).
   */
  /**
   * The draft id, in a ref as well as in state.
   *
   * The autosave runs on an interval whose closure captures `draftId`. Reading
   * it from state meant the first tick after a save still saw `null` and minted
   * a *second* draft for the same form; the ref is written synchronously, so
   * every tick continues the row the previous one created.
   */
  const draftIdRef = useRef(draftId);
  useEffect(() => {
    if (!storage) return;
    /*
     * No business id, no draft.
     *
     * `businessId` comes from the *list's* response, so on a deep link
     * (`?customer=…`) the form can open before the list has answered.
     * `savePartyDraft` returns null for an empty business — drafts are
     * namespaced per tenant and a draft with no tenant is one that could be
     * read by the next business on a shared browser — so those early ticks
     * did nothing but burn a timer. Waiting is the whole fix; the effect
     * re-runs when the id lands.
     */
    if (!businessId) return;
    const timer = window.setInterval(() => {
      const draft = savePartyDraft(storage, {
        businessId,
        state: stateRef.current,
        draftId: draftIdRef.current,
        partyId: partyId ?? null,
      });
      if (draft && !draftIdRef.current) {
        draftIdRef.current = draft.id;
        setDraftId(draft.id);
        // A draft that appeared on its own should appear in the list too,
        // otherwise «پیش‌نویس‌ها (۰)» contradicts the note beside it.
        setDrafts(listPartyDrafts(storage, businessId));
      }
    }, DRAFT_AUTOSAVE_MS);
    return () => window.clearInterval(timer);
  }, [storage, businessId, partyId]);

  function patch(next: Partial<PartyFormState>) {
    setState((current) => ({ ...current, ...next }));
  }
  function patchTab<K extends "generalInfo" | "addressInfo" | "contactInfo" | "financialInfo">(
    key: K,
    next: Partial<PartyFormState[K]>,
  ) {
    setState((current) => ({ ...current, [key]: { ...current[key], ...next } }));
  }
  function clearError(path: string) {
    setErrors((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }

  const accountingEditable = canEditAccountingInScope(scope);
  const accountingVisible = canSeeAccountingInScope(scope);
  // Which roles this section may assign at all. A single-role section (the
  // store's suppliers, the team's staff) shows the one role as a fixed pill;
  // the directory shows the whole set as checkboxes, because one person really
  // can be a customer and a supplier at once.
  const assignableRoles = PARTY_ROLES.filter((role) => scope.roles.includes(role));
  const roleLocked = assignableRoles.length <= 1;

  /**
   * The unsaved-changes guard.
   *
   * Compared on the *payload*, not the state, so a form that merely re-derived
   * a default does not claim to be dirty — the same rule the draft autosave
   * uses, from the same helper, so the two can never disagree about whether
   * there is anything to lose.
   */
  const dirty = partyFormHasUnsavedChanges(state, baseline);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const requestClose = useCallback(() => {
    if (
      dirtyRef.current &&
      !window.confirm("تغییرهای ذخیره‌نشده‌ای در این فرم دارید. بستن فرم آن‌ها را کنار می‌گذارد. ادامه می‌دهید؟")
    ) {
      return;
    }
    onClose();
  }, [onClose]);

  // The browser's own guard, for the other way out of a form: a refresh, a
  // closed tab, a link to another site. The dialog's Escape and «انصراف» go
  // through `requestClose` above.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // Chrome still requires the assignment; the string itself is never shown.
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /**
   * Focus management.
   *
   * When validation sends you to another tab, the point of the jump is the
   * field that is wrong — so the first invalid control is focused, not merely
   * scrolled to. Without this a keyboard user is moved to a tab and then has
   * to hunt for the red text with the Tab key.
   */
  const bodyRef = useRef<HTMLDivElement>(null);
  const [focusField, setFocusField] = useState<string | null>(null);
  useEffect(() => {
    if (!focusField) return;
    const target = bodyRef.current?.querySelector<HTMLElement>(`[data-field="${CSS.escape(focusField)}"]`);
    target?.focus();
    setFocusField(null);
  }, [focusField, tab]);

  /** Route an error set to the tab that owns its first field, and focus it. */
  const showFirstError = useCallback((found: Record<string, string>) => {
    const first = Object.keys(found)[0] ?? "displayName";
    setErrors(found);
    setTab(tabForField(first));
    setFocusField(first);
  }, []);

  /**
   * Submit.
   *
   * Three answers, each with its own place to appear: the client's own validation
   * (the same `validatePartyForm` the route runs, so a field is red before a
   * request leaves), the route's `fieldErrors` (which can know things the browser
   * cannot — a کد ملی already held by somebody else), and any other backend error
   * (a 403 from a permission the member lacks, a 404 on a stale edit) which is
   * shown whole.
   *
   * Outside the Accounting app the ledger's numbers are shown read-only (or not
   * at all), so they are not sent back either: the route gates those keys on
   * `ledger.view`, and a round-tripped tax rate would turn a cashier's
   * phone-number fix into a 403. An omitted key means «leave it» on the server,
   * so stripping them changes nothing that is stored.
   */
  async function submit() {
    if (busy) return;
    /*
     * Commit the tax field before validating.
     *
     * Pressing «ذخیره» with the caret still in the rate never fires its blur in
     * every browser (a mouse-down on a button inside a Radix dialog can move
     * focus without one), so the state could still hold the *previous* rate
     * while the input shows the new one — a silently discarded edit.
     */
    const submitted: PartyFormState = {
      ...state,
      generalInfo: {
        ...state.generalInfo,
        taxPercentage: taxPercentageOf({ generalInfo: { taxPercentage: taxInput } }),
      },
    };
    const found = validatePartyForm(submitted);
    if (Object.keys(found).length > 0) {
      setState(submitted);
      showFirstError(found);
      return;
    }
    setErrors({});
    setBusy(true);
    setFormError("");
    const payload = accountingEditable
      ? buildPartyPayload(submitted)
      : buildNonAccountingPayload(submitted);
    const { ok, data } = partyId
      ? await api<{ party?: PartyApiRecord; error?: string; fieldErrors?: Record<string, string> }>(
          `/api/parties/${encodeURIComponent(partyId)}`,
          { method: "PUT", body: JSON.stringify(payload) },
        )
      : await api<{ party?: PartyApiRecord; error?: string; fieldErrors?: Record<string, string> }>(
          "/api/parties",
          { method: "POST", body: JSON.stringify(payload) },
        );
    setBusy(false);
    if (!ok) {
      const fieldErrors = data.fieldErrors ?? {};
      if (Object.keys(fieldErrors).length > 0) showFirstError(fieldErrors);
      setFormError(errorMessage(data.error));
      return;
    }
    // The draft was the form's shadow; the record is now real, so it goes.
    if (draftId) deletePartyDraft(storage, businessId, draftId);
    setInfo("");
    /*
     * The saved state is the new baseline.
     *
     * Without this the dirty flag stayed true after a successful save, so the
     * `beforeunload` guard kept firing and — if the parent leaves the dialog
     * mounted for a beat — «انصراف» asked to discard changes that were already
     * stored.
     */
    setState(submitted);
    setBaseline(submitted);
    dirtyRef.current = false;
    onSaved(data.party ?? { id: partyId ?? "" });
  }

  /** The one writer of the draft id: the ref (which the timer reads) and the state stay one value. */
  function rememberDraft(id: string | null) {
    draftIdRef.current = id;
    setDraftId(id);
  }

  function saveDraftNow() {
    if (!businessId) {
      setFormError("هنوز فهرست بارگذاری نشده است؛ چند لحظه بعد دوباره تلاش کنید.");
      return;
    }
    const draft = savePartyDraft(storage, { businessId, state, draftId, partyId: partyId ?? null });
    if (!draft) {
      // `localStorage` refused (private mode, a full quota). Saying so beats a
      // button that looks like it worked.
      setFormError("ذخیرهٔ پیش‌نویس در این مرورگر ممکن نیست.");
      return;
    }
    rememberDraft(draft.id);
    setFormError("");
    setInfo(`پیش‌نویس «${partyDraftLabel(state)}» ذخیره شد.`);
    refreshDrafts();
  }

  function restoreDraft(draft: PartyDraft) {
    // A restore replaces everything on screen; if the person had typed
    // something into this form first, that is what they would lose.
    if (
      partyFormHasUnsavedChanges(stateRef.current, baseline) &&
      !window.confirm(`بازخوانی پیش‌نویس «${draft.label}» آنچه اکنون در فرم است را جایگزین می‌کند. ادامه می‌دهید؟`)
    ) {
      return;
    }
    setState(draft.state);
    setTaxInput(String(taxPercentageOf(draft.state)));
    rememberDraft(draft.id);
    setErrors({});
    setShowDrafts(false);
    setFormError("");
    setInfo(`پیش‌نویس «${draft.label}» بازخوانی شد.`);
  }

  function discardDraft(id: string) {
    deletePartyDraft(storage, businessId, id);
    if (id === draftId) rememberDraft(null);
    refreshDrafts();
  }

  const has = (path: string) => errors[path];

  if (loadingRecord) {
    return (
      <Dialog open onOpenChange={(next) => (next ? undefined : onClose())}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>در حال بارگذاری پرونده…</DialogTitle>
          </DialogHeader>
          <LoadingSkeleton rows={4} label="در حال بارگذاری پروندهٔ شخص" />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(next) => (next ? undefined : requestClose())}>
      {/*
        Header and footer stay put; only the middle scrolls.

        This form is four tabs tall. With the whole dialog as one scroller the
        «ذخیره» button sat below the fold on every phone and on any laptop in
        landscape — people filled the form, saw no way to submit, and closed it.
        `min-h-0` on the middle child is what lets a flex column actually shrink
        its scroller instead of overflowing the dialog.
      */}
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden sm:max-w-2xl lg:max-w-3xl">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {partyId
              ? `ویرایش ${state.displayName || "شخص"}`
              : `شخص جدید — ${state.roles.map((role) => PARTY_ROLE_LABELS[role]).join(" و ")}`}
          </DialogTitle>
          <DialogDescription>
            {partyId
              ? "تغییرها پس از «ذخیره» اعمال می‌شود. فیلدهای ستاره‌دار الزامی‌اند."
              : "فقط نام نمایشی و نقش الزامی است؛ بقیهٔ تب‌ها را بعداً هم می‌توانید کامل کنید."}
          </DialogDescription>
        </DialogHeader>

        {/* Kept out of the scroller on purpose: an error that scrolls away is an
            error nobody reads. */}
        <div className="shrink-0 empty:hidden">
          <ErrorBox>{formError}</ErrorBox>
          {info ? <InfoBox>{info}</InfoBox> : null}
        </div>

        <div className="-mx-4 min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {/* The scroller the focus lookup searches — every validated control,
            root fields and tabs alike, lives inside it. */}
        <div ref={bodyRef} className="min-w-0 space-y-4">

        {/* ---------------- root fields ---------------- */}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2 flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={state.status}
                onCheckedChange={(checked) => patch({ status: checked === true })}
                aria-label="وضعیت"
              />
              <span className={state.status ? "font-medium text-foreground" : "text-muted-foreground"}>
                {state.status ? "فعال" : "غیرفعال"}
              </span>
            </label>
            <span className="text-xs text-muted-foreground">
              شخص غیرفعال در انتخاب‌گرهای فروش و خرید نمایش داده نمی‌شود؛ سوابق او دست‌نخورده می‌ماند.
            </span>
          </div>

          {/*
            Roles, plural.

            One person can be a customer and a supplier at the same time — the
            café that buys its beans from a regular, the workshop that sells to
            the shop it buys from — and before this the only way to record that
            was two files, two accounting codes and two balances for one human
            being. So this is a checkbox group over the set, not a `<select>`
            over one value, and the first ticked role (by the product's own
            order: مشتری، تأمین‌کننده، کارکنان) is the primary one that decides
            the accounting-code prefix. A section that lists exactly one role
            still shows a fixed pill — there is nothing to choose there.
          */}
          <div className="sm:col-span-2">
            <Field label="نقش‌ها (الزامی)">
              {roleLocked ? (
                <div className="flex min-h-10 items-center">
                  <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-950 dark:bg-amber-500/20 dark:text-amber-200">
                    {PARTY_ROLE_LABELS[assignableRoles[0] ?? scope.defaultRole]}
                  </span>
                  <span className="ms-2 text-xs text-muted-foreground">در این بخش نقش ثابت است.</span>
                </div>
              ) : (
                <div
                  role="group"
                  aria-label="نقش‌های این شخص"
                  aria-describedby="party-form-roles-hint"
                  className="flex flex-wrap gap-2"
                >
                  {assignableRoles.map((role, index) => {
                    const checked = hasPartyRole(state, role);
                    // The last remaining role cannot be unticked: a party with
                    // no role is not a party, and refusing it here explains
                    // itself better than a 400 after «ذخیره».
                    const last = checked && state.roles.length === 1;
                    return (
                      <button
                        key={role}
                        type="button"
                        role="checkbox"
                        aria-checked={checked}
                        /*
                         * `aria-disabled`, not `disabled`. A truly disabled
                         * button leaves the tab order, so a keyboard or screen
                         * reader user tabbing through the group simply never
                         * met the ticked role and got no hint as to why it
                         * would not untick. This way it is still reachable and
                         * announced, and the click explains the refusal.
                         */
                        aria-disabled={last || undefined}
                        data-field={index === 0 ? "roles" : undefined}
                        onClick={() => {
                          if (last) {
                            setErrors((current) => ({ ...current, roles: "role_required" }));
                            return;
                          }
                          setState((current) => togglePartyRole(current, role));
                          clearError("roles");
                          clearError("role");
                        }}
                        className={`min-h-10 rounded-xl border px-3 text-sm font-medium transition-colors aria-disabled:cursor-not-allowed ${
                          checked
                            ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                            : "border-border bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground"
                        }`}
                      >
                        {PARTY_ROLE_LABELS[role]}
                      </button>
                    );
                  })}
                </div>
              )}
              {/*
                The hint always renders, because `aria-describedby` above points
                at it unconditionally: when an error replaced it, the reference
                dangled and assistive tech announced nothing at all for the
                group. The error is appended rather than substituted.
              */}
              <span id="party-form-roles-hint" className="mt-1 block text-xs">
                {has("roles") ? (
                  <span className="block text-destructive">{partyFieldErrorMessage(has("roles"))}</span>
                ) : null}
                {roleLocked ? null : (
                  <span className="block text-muted-foreground">
                    می‌توانید چند نقش را هم‌زمان انتخاب کنید. کد حسابداری بر پایهٔ «
                    {PARTY_ROLE_LABELS[state.role]}» ساخته می‌شود.
                  </span>
                )}
              </span>
            </Field>
          </div>

          <Field label="نوع شخص">
            <div className="flex gap-2">
              {PARTY_PERSON_TYPES.map((personType) => (
                <button
                  key={personType}
                  type="button"
                  onClick={() => patch({ personType })}
                  aria-pressed={state.personType === personType}
                  className={`min-h-10 flex-1 rounded-xl border px-3 text-sm font-medium transition-colors ${
                    state.personType === personType
                      ? "border-amber-200 bg-amber-100 text-amber-950 dark:border-amber-500/30 dark:bg-amber-500/20 dark:text-amber-200"
                      : "border-transparent bg-transparent text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {PARTY_PERSON_TYPE_LABELS[personType]}
                </button>
              ))}
            </div>
          </Field>

          <Field label="نام نمایشی (الزامی)">
            <input
              data-field="displayName"
              autoFocus
              className={inputClass}
              maxLength={MAX_PARTY_DISPLAY_NAME}
              value={state.displayName}
              onChange={(event) => {
                patch({ displayName: event.target.value });
                clearError("displayName");
              }}
              placeholder="نامی که در فهرست‌ها دیده می‌شود"
            />
            {has("displayName") ? (
              <span className="mt-1 block text-xs text-destructive">{partyFieldErrorMessage(has("displayName"))}</span>
            ) : null}
          </Field>

          <Field label="دسته‌بندی">
            <CategorySelect
              value={state.categoryId}
              role={state.role}
              onChange={(value) => patch({ categoryId: value })}
            />
          </Field>

          <Field label="نام">
            <input
              className={inputClass}
              maxLength={MAX_PARTY_NAME_PART}
              value={state.firstName}
              onChange={(event) => patch({ firstName: event.target.value })}
            />
          </Field>
          <Field label="نام خانوادگی">
            <input
              className={inputClass}
              maxLength={MAX_PARTY_NAME_PART}
              value={state.lastName}
              onChange={(event) => patch({ lastName: event.target.value })}
            />
          </Field>

          <div className="sm:col-span-2">
            {state.profileImageAssetId ? (
              // Migration 0181: an uploaded avatar is a canonical Media
              // Library asset, picked/replaced/removed through the same
              // dialog every catalogue item's photo uses.
              <MediaImageField
                label="تصویر پروفایل"
                value={state.profileImageAssetId}
                onChange={(id) => patch({ profileImageAssetId: id ?? "" })}
              />
            ) : state.profileImage ? (
              // A legacy `data:`/`https://` value already on this record
              // (saved before migration 0181, or an external link) — kept
              // exactly as it renders today, with an offer to move it onto
              // the Media Library instead of a client-side FileReader pick.
              <>
                <p className="mb-1 text-sm font-medium text-foreground">تصویر پروفایل</p>
                <div className="flex flex-wrap items-center gap-3">
                  <img
                    src={state.profileImage}
                    alt=""
                    className="size-12 rounded-full border border-border object-cover"
                  />
                  <Button type="button" variant="ghost" size="xs" onClick={() => patch({ profileImage: "" })}>
                    برداشتن تصویر
                  </Button>
                  <Button type="button" variant="outline" size="xs" onClick={() => setPickingAvatar(true)}>
                    جایگزینی با تصویر از کتابخانه
                  </Button>
                </div>
              </>
            ) : (
              <MediaImageField
                label="تصویر پروفایل"
                value={null}
                onChange={(id) => patch({ profileImageAssetId: id ?? "" })}
              />
            )}
            {pickingAvatar ? (
              <MediaPickerDialog
                title="تصویر پروفایل"
                onClose={() => setPickingAvatar(false)}
                onPick={(asset) => {
                  patch({ profileImageAssetId: asset.id, profileImage: "" });
                  setPickingAvatar(false);
                }}
              />
            ) : null}
            {has("profileImage") ? (
              <span className="mt-1 block text-xs text-destructive">{partyFieldErrorMessage(has("profileImage"))}</span>
            ) : null}
          </div>

          {accountingVisible ? (
            <div className="sm:col-span-2 grid min-w-0 gap-3 rounded-xl border border-border/80 bg-muted/40 p-3 sm:grid-cols-2">
              <Field label="کد حسابداری">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <select
                    className={`${inputClass} sm:max-w-32 sm:shrink-0`}
                    value={state.accountingCodeMode}
                    disabled={!accountingEditable}
                    onChange={(event) =>
                      patch({ accountingCodeMode: event.target.value as (typeof ACCOUNTING_CODE_MODES)[number] })
                    }
                  >
                    {ACCOUNTING_CODE_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {ACCOUNTING_CODE_MODE_LABELS[mode]}
                      </option>
                    ))}
                  </select>
                  {/*
                    «با ذخیره ساخته می‌شود» is a placeholder, not a value.

                    As a value it was Persian prose inside a `dir="ltr"` box, so
                    it rendered flush-left with its punctuation adrift; worse,
                    it *looked* like content — anyone switching the mode back to
                    «دستی» expected to find the sentence there and instead got
                    an empty field. A placeholder greys out, aligns with the
                    field's own direction and never reaches the payload.
                  */}
                  <input
                    data-field="accountingCode"
                    className={`${inputClass} sm:flex-1`}
                    dir={state.accountingCodeMode === "Automatic" && !state.accountingCode ? "auto" : "ltr"}
                    inputMode="numeric"
                    aria-label="کد حسابداری"
                    maxLength={24}
                    disabled={!accountingEditable || state.accountingCodeMode === "Automatic"}
                    placeholder={state.accountingCodeMode === "Automatic" ? "با ذخیره ساخته می‌شود" : "مثلاً ۱۰۰۴"}
                    value={state.accountingCode}
                    onChange={(event) => {
                      patch({ accountingCode: event.target.value });
                      clearError("accountingCode");
                    }}
                  />
                </div>
                {has("accountingCode") ? (
                  <span className="mt-1 block text-xs text-destructive">{partyFieldErrorMessage(has("accountingCode"))}</span>
                ) : (
                  !accountingEditable && (
                    <span className="mt-1 block text-xs text-muted-foreground">
                      کد حسابداری در برنامهٔ حسابداری ویرایش می‌شود.
                    </span>
                  )
                )}
              </Field>
              <div className="mb-4 flex flex-col justify-end text-xs text-muted-foreground">
                <span>
                  در حالت خودکار، شماره را سامانه می‌دهد: ۱ برای مشتری، ۲ برای تأمین‌کننده، ۳ برای کارکنان.
                </span>
              </div>
            </div>
          ) : null}
        </div>

        {/* ---------------- tabs ---------------- */}
        <TabBar
          idPrefix="party-form"
          label="بخش‌های فرم شخص"
          tabs={TAB_KEYS.map((key) => ({ key, label: TAB_LABELS[key] }))}
          active={tab}
          onChange={setTab}
          className="mt-2"
        />
        <TabPanel idPrefix="party-form" active={tab}>
          {tab === "general" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label="کد ملی">
                {/*
                  Persian digits in the box, ASCII in the state — the rule the
                  rest of the app follows. It also drops `maxLength`: the
                  browser applies that to the *raw* text before this handler
                  strips the punctuation, so pasting a dashed «۰۰۱۲-۳۴۵-۶۷۸۹»
                  lost the last three digits silently. The slice is the real
                  limit and it counts digits, not characters.
                */}
                <input
                  data-field="generalInfo.nationalId"
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={state.personType === "Legal"}
                  value={toPersianDigits(state.generalInfo.nationalId)}
                  onChange={(event) => {
                    patchTab("generalInfo", { nationalId: asciiDigits(event.target.value).slice(0, 10) });
                    clearError("generalInfo.nationalId");
                  }}
                  placeholder="۱۰ رقم"
                />
                {has("generalInfo.nationalId") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("generalInfo.nationalId"))}
                  </span>
                ) : state.personType === "Legal" ? (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    شخص حقوقی کد ملی ندارد؛ شمارهٔ ثبت شرکت در یادداشت‌ها ثبت شود.
                  </span>
                ) : null}
              </Field>
              <Field label="کد اقتصادی">
                <input
                  data-field="generalInfo.economicCode"
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="off"
                  value={toPersianDigits(state.generalInfo.economicCode)}
                  onChange={(event) => {
                    patchTab("generalInfo", { economicCode: asciiDigits(event.target.value).slice(0, 11) });
                    clearError("generalInfo.economicCode");
                  }}
                  placeholder="۱۱ رقم"
                />
                {has("generalInfo.economicCode") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("generalInfo.economicCode"))}
                  </span>
                ) : null}
              </Field>
              <Field label="نرخ مالیات (٪)">
                {/*
                  `PersianNumberInput`, not a raw input with a hand-rolled digit
                  fold. The old handler had three faults, each of which wrote a
                  wrong number into the ledger's own field:

                    - `Number("")` is 0, so *clearing* the box set the party's
                      VAT rate to zero — a rate businesses really use, so
                      nothing downstream could tell it from a deliberate one.
                    - it folded Persian digits but not the Persian decimal mark
                      «٫», so «۹٫۵» became 95.
                    - it did not fold Arabic-Indic digits at all, so «٩» became
                      0.

                  The shared control handles all three, and the value is held as
                  text while typing so «۹٫» is not rewritten to «۹» under the
                  caret.
                */}
                <PersianNumberInput
                  data-field="generalInfo.taxPercentage"
                  className={inputClass}
                  inputMode="decimal"
                  allowNegative={false}
                  grouping={false}
                  disabled={!accountingEditable}
                  value={taxInput}
                  onChange={(event) => {
                    setTaxInput(event.target.value);
                    clearError("generalInfo.taxPercentage");
                  }}
                  onBlur={(event) => {
                    // Commit through the same coercion the payload builder and
                    // the service use, so an emptied field means «the default»
                    // and never «zero».
                    const value = taxPercentageOf({ generalInfo: { taxPercentage: event.target.value } });
                    patchTab("generalInfo", { taxPercentage: value });
                    setTaxInput(String(value));
                  }}
                />
                {has("generalInfo.taxPercentage") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("generalInfo.taxPercentage"))}
                  </span>
                ) : (
                  <span className="mt-1 block text-xs text-muted-foreground">
                    خالی گذاشتن این فیلد یعنی نرخ پیش‌فرض {toPersianDigits(String(DEFAULT_TAX_PERCENTAGE))}٪.
                  </span>
                )}
              </Field>
              <div className="hidden sm:block" />
              <Field label="یادداشت">
                <textarea
                  className={inputClass}
                  rows={3}
                  maxLength={MAX_PARTY_NOTES}
                  value={state.notes}
                  onChange={(event) => patch({ notes: event.target.value })}
                />
              </Field>
            </div>
          ) : null}

          {tab === "address" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label="استان">
                <input
                  className={inputClass}
                  value={state.addressInfo.province}
                  onChange={(event) => patchTab("addressInfo", { province: event.target.value })}
                />
              </Field>
              <Field label="شهر">
                <input
                  className={inputClass}
                  value={state.addressInfo.city}
                  onChange={(event) => patchTab("addressInfo", { city: event.target.value })}
                />
              </Field>
              <div className="sm:col-span-2">
                <Field label="نشانی پستی">
                  <textarea
                    className={inputClass}
                    rows={2}
                    value={state.addressInfo.street}
                    onChange={(event) => patchTab("addressInfo", { street: event.target.value })}
                  />
                </Field>
              </div>
              <Field label="کد پستی">
                <input
                  data-field="addressInfo.zipCode"
                  className={inputClass}
                  dir="ltr"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  placeholder="۱۰ رقم"
                  value={toPersianDigits(state.addressInfo.zipCode)}
                  onChange={(event) => {
                    patchTab("addressInfo", { zipCode: asciiDigits(event.target.value).slice(0, 10) });
                    clearError("addressInfo.zipCode");
                  }}
                />
                {has("addressInfo.zipCode") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("addressInfo.zipCode"))}
                  </span>
                ) : null}
              </Field>
              <Field label="صندوق پستی">
                <input
                  className={inputClass}
                  dir="ltr"
                  maxLength={20}
                  value={state.addressInfo.postalBox}
                  onChange={(event) => patchTab("addressInfo", { postalBox: event.target.value })}
                />
              </Field>
            </div>
          ) : null}

          {tab === "contact" ? (
            <div className="grid min-w-0 gap-3 sm:grid-cols-2">
              <Field label="تلفن همراه">
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="tel"
                  maxLength={32}
                  value={state.contactInfo.mobile}
                  onChange={(event) => patchTab("contactInfo", { mobile: event.target.value })}
                  placeholder="0912…"
                />
              </Field>
              <Field label="تلفن ثابت">
                <input
                  className={inputClass}
                  dir="ltr"
                  inputMode="tel"
                  maxLength={32}
                  value={state.contactInfo.phone}
                  onChange={(event) => patchTab("contactInfo", { phone: event.target.value })}
                />
              </Field>
              <Field label="پست الکترونیکی">
                <input
                  data-field="contactInfo.email"
                  className={inputClass}
                  dir="ltr"
                  type="email"
                  maxLength={200}
                  value={state.contactInfo.email}
                  onChange={(event) => {
                    patchTab("contactInfo", { email: event.target.value });
                    clearError("contactInfo.email");
                  }}
                />
                {has("contactInfo.email") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("contactInfo.email"))}
                  </span>
                ) : null}
              </Field>
              <Field label="وب‌سایت">
                <input
                  data-field="contactInfo.website"
                  className={inputClass}
                  dir="ltr"
                  maxLength={200}
                  value={state.contactInfo.website}
                  onChange={(event) => {
                    patchTab("contactInfo", { website: event.target.value });
                    clearError("contactInfo.website");
                  }}
                  placeholder="https://"
                />
                {has("contactInfo.website") ? (
                  <span className="mt-1 block text-xs text-destructive">
                    {partyFieldErrorMessage(has("contactInfo.website"))}
                  </span>
                ) : null}
              </Field>
            </div>
          ) : null}

          {tab === "financial" ? (
            accountingVisible ? (
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <Field label="نام بانک">
                  <input
                    className={inputClass}
                    disabled={!accountingEditable}
                    value={state.financialInfo.bankName}
                    onChange={(event) => patchTab("financialInfo", { bankName: event.target.value })}
                  />
                </Field>
                <Field label="شماره حساب">
                  <input
                    className={inputClass}
                    dir="ltr"
                    disabled={!accountingEditable}
                    maxLength={40}
                    value={state.financialInfo.accountNumber}
                    onChange={(event) => patchTab("financialInfo", { accountNumber: event.target.value })}
                  />
                </Field>
                <Field label="شماره کارت">
                  {/*
                    Shown in the four-by-four grouping that is printed on the
                    card itself. Sixteen unbroken digits are genuinely hard to
                    check against a physical card, and this field is the one
                    people verify digit by digit before paying somebody.
                  */}
                  <input
                    data-field="financialInfo.cardNumber"
                    className={inputClass}
                    dir="ltr"
                    inputMode="numeric"
                    autoComplete="off"
                    disabled={!accountingEditable}
                    placeholder="۱۶ رقم"
                    value={toPersianDigits(state.financialInfo.cardNumber).replace(/(.{4})(?=.)/g, "$1 ")}
                    onChange={(event) => {
                      patchTab("financialInfo", { cardNumber: asciiDigits(event.target.value).slice(0, 16) });
                      clearError("financialInfo.cardNumber");
                    }}
                  />
                  {has("financialInfo.cardNumber") ? (
                    <span className="mt-1 block text-xs text-destructive">
                      {partyFieldErrorMessage(has("financialInfo.cardNumber"))}
                    </span>
                  ) : null}
                </Field>
                <Field label="شبا (IBAN)">
                  <input
                  data-field="financialInfo.iban"
                    className={inputClass}
                    dir="ltr"
                    disabled={!accountingEditable}
                    maxLength={26}
                    value={state.financialInfo.iban}
                    onChange={(event) => {
                      patchTab("financialInfo", { iban: event.target.value.toUpperCase().replace(/\s/g, "") });
                      clearError("financialInfo.iban");
                    }}
                    placeholder="IR…"
                  />
                  {has("financialInfo.iban") ? (
                    <span className="mt-1 block text-xs text-destructive">
                      {partyFieldErrorMessage(has("financialInfo.iban"))}
                    </span>
                  ) : null}
                </Field>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">این بخش در این برنامه نمایش داده نمی‌شود.</p>
            )
          ) : null}
        </TabPanel>
        </div>

        {/* ---------------- drafts ---------------- */}
        <div className="mt-4 rounded-xl border border-border/80 bg-muted/40 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Button type="button" variant="outline" size="xs" onClick={saveDraftNow} disabled={busy}>
              ذخیرهٔ پیش‌نویس
            </Button>
            {/*
              Hidden rather than disabled when there is nothing to show: a
              greyed «پیش‌نویس‌ها (۰)» is a control that explains nothing and
              takes a tap target on a phone.
            */}
            {drafts.length > 0 ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-expanded={showDrafts}
                onClick={() => setShowDrafts((show) => !show)}
              >
                پیش‌نویس‌ها ({toPersianDigits(String(drafts.length))})
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => {
                /*
                 * Back to the defaults this form *opened* with.
                 *
                 * It used to spread `role: scope.defaultRole` over
                 * `resetPartyForm()`, whose `roles` is always `["Customer"]` —
                 * so in the team scope the reset produced
                 * `{ role: "Employee", roles: ["Customer"] }`. That fails
                 * `validatePartyForm` with `invalid_role` on «نقش‌ها», a field
                 * a single-role section does not draw, so «ذخیره» refused with
                 * nothing on screen to explain it. `withPartyRoles` is the one
                 * helper that sets the pair together.
                 */
                if (
                  partyFormHasUnsavedChanges(stateRef.current, baseline) &&
                  !window.confirm("فرم به مقادیر اولیه برمی‌گردد و آنچه وارد کرده‌اید پاک می‌شود. ادامه می‌دهید؟")
                ) {
                  return;
                }
                const fresh = withPartyRoles(resetPartyForm(), openingRoles);
                setState(fresh);
                setTaxInput(String(taxPercentageOf(fresh)));
                rememberDraft(null);
                setErrors({});
                setFormError("");
                setInfo("فرم به مقادیر اولیه بازگشت.");
              }}
            >
              پاک کردن فرم
            </Button>
            {draftId ? <span className="text-xs text-muted-foreground">پیش‌نویس این فرم خودکار ذخیره می‌شود.</span> : null}
          </div>
          {showDrafts ? (
            <ul className="mt-2 divide-y divide-border/80">
              {drafts.map((draft) => (
                <li key={draft.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5 text-sm">
                  {/* `min-w-0` alone does nothing; the truncation has to be on
                      the text itself, or a long company name pushes the two
                      buttons off the dialog. */}
                  <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                    <span className="min-w-0 truncate font-medium text-foreground">{draft.label}</span>
                    {/*
                      Shamsi and Tehran-local. This printed the raw ISO string
                      («۲۰۲۶-۰۹-۱۷T۱۰:۲۴» with the T swapped for a space) —
                      a Gregorian date shown to a user, and in UTC, so a draft
                      saved after 03:30 Tehran time claimed the wrong day.
                    */}
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {toPersianDigits(formatJalali(draft.savedAt, { withTime: true }))}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => restoreDraft(draft)}
                      aria-label={`بازخوانی پیش‌نویس «${draft.label}»`}
                    >
                      بازخوانی
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => discardDraft(draft.id)}
                      aria-label={`حذف پیش‌نویس «${draft.label}»`}
                    >
                      حذف
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        </div>

        <DialogFooter className="mt-4 shrink-0 border-t border-border/80 pt-3">
          <Button type="button" variant="outline" onClick={requestClose} disabled={busy}>
            انصراف
          </Button>
          <Button type="button" onClick={submit} disabled={busy}>
            {busy ? "در حال ذخیره…" : "ذخیره"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The category picker, with its own inline «دستهٔ جدید».
 *
 * Categories are data, not settings: the person who needs the group is the person
 * filling this form, and making them leave to a settings tab and come back is how
 * a grouping ends up half-used.
 */
function CategorySelect({
  value,
  role,
  onChange,
}: {
  value: string;
  role: PartyRole;
  onChange: (value: string) => void;
}) {
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    void api<{ categories: { id: string; name: string }[] }>(
      `/api/parties/categories?role=${encodeURIComponent(role)}`,
    ).then(({ ok, data }) => {
      if (ok) setCategories(data.categories ?? []);
    });
  }, [role]);
  useEffect(load, [load]);

  async function addCategory() {
    const name = newName.trim();
    if (!name) return;
    setError("");
    const { ok, data } = await api<{ category?: { id: string; name: string }; error?: string }>(
      "/api/parties/categories",
      { method: "POST", body: JSON.stringify({ name, role }) },
    );
    if (!ok) {
      setError(errorMessage((data as { error?: string }).error));
      return;
    }
    setNewName("");
    setAdding(false);
    load();
    if (data.category) onChange(data.category.id);
  }

  if (!adding) {
    return (
      <div className="flex flex-col gap-2 sm:flex-row">
        <select
          className={`${inputClass} sm:flex-1`}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">بدون دسته</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setAdding(true)}>
          + دسته
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          className={`${inputClass} sm:flex-1`}
          maxLength={80}
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="نام دستهٔ جدید"
        />
        <div className="flex gap-2">
          <Button type="button" size="sm" className="flex-1 sm:flex-none" onClick={addCategory} disabled={!newName.trim()}>
            افزودن
          </Button>
          <Button type="button" variant="ghost" size="sm" className="flex-1 sm:flex-none" onClick={() => setAdding(false)}>
            انصراف
          </Button>
        </div>
      </div>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
