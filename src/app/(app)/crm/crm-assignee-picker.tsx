"use client";

/**
 * Who owns this row — chosen from the business's own members.
 *
 * ## Why not a text field
 *
 * The activities and service dialogs used to ask for an assignee as free text.
 * That is how a row ends up owned by somebody who cannot sign in, how «کارهای
 * من» becomes unanswerable, and how the same person appears as «حسین», «حسین
 * رضایی» and «ح.رضایی» in three rows that a report then counts as three
 * people. The deals dialog was moved to a member picker first; this is that
 * control, extracted, because three screens have to agree about what an
 * assignee is.
 *
 * ## What it does with an old row
 *
 * A row written before migration 0157 has a name and no id. Opening its dialog
 * must not silently erase that: the picker offers the recorded name as its own
 * option («نام ثبت‌شدهٔ قبلی») and keeps it selected, so saving an unrelated
 * field leaves the assignment as it was. Choosing a member replaces it, and
 * choosing «بدون مسئول» clears it — both explicit.
 *
 * The id is what gets written; the name rides along as the snapshot the row
 * keeps for history (see `crm-ownership.ts`). If a legacy name happens to match
 * exactly one member, the *server* resolves it — `resolveOwner` — and the row
 * comes back with an id; the picker never guesses on the client.
 *
 * ## Inactive members
 *
 * They are listed, marked «(غیرفعال)». Reassignment starts by seeing who holds
 * what, so the person who left must be visible in the list rather than filtered
 * away — the departed-owner queue is where that work is listed.
 */

import { useEffect, useState } from "react";
import { LoadingSkeleton } from "@/app/dashboard/page-chrome";
import { api, Field, inputClass } from "@/app/dashboard/ui";

interface Member {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
}

/** What the picker hands back: the id to store, the name to snapshot. */
export interface CrmAssignee {
  userId: string;
  /** The display name to keep on the row — the member's, the legacy name, or "". */
  name: string;
}

export const UNASSIGNED: CrmAssignee = { userId: "", name: "" };

/** The option value for «keep the name this row already had». */
const LEGACY = "__legacy__";

export function CrmAssigneePicker({
  label = "مسئول (اختیاری)",
  hint = "از میان اعضای کسب‌وکار انتخاب می‌شود تا «کارهای من» همیشه یک معنی داشته باشد.",
  value,
  onChange,
}: {
  label?: string;
  hint?: string;
  value: CrmAssignee;
  onChange: (next: CrmAssignee) => void;
}) {
  const [members, setMembers] = useState<Member[] | null>(null);
  /**
   * The name the row already carried, when it has no member id.
   *
   * Captured once, on mount, from the value the dialog opened with: after the
   * reader picks a member this must not come back, or a save would re-offer a
   * superseded name.
   */
  const [legacyName] = useState(() => (value.userId ? "" : value.name.trim()));

  useEffect(() => {
    let cancelled = false;
    api<{ members: Member[] }>("/api/crm/members").then(({ ok, data }) => {
      if (!cancelled && ok) setMembers(data.members ?? []);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selected = value.userId ? value.userId : legacyName ? LEGACY : "";

  // The members are one request away. Until they arrive the field reserves its
  // own shape rather than drawing a select whose only option is «بدون مسئول» —
  // which reads as "nobody works here" for as long as the read takes.
  if (members === null) {
    return (
      <Field label={label} hint={hint}>
        <LoadingSkeleton rows={1} compact label="در حال بارگذاری اعضا" />
      </Field>
    );
  }

  return (
    <Field label={label} hint={hint}>
      <select
        className={inputClass}
        value={selected}
        onChange={(event) => {
          const next = event.target.value;
          if (next === "") return onChange(UNASSIGNED);
          if (next === LEGACY) return onChange({ userId: "", name: legacyName });
          const member = (members ?? []).find((candidate) => candidate.id === next);
          onChange({ userId: next, name: member?.name ?? "" });
        }}
      >
        <option value="">بدون مسئول</option>
        {selected === LEGACY ? (
          // Kept at the top rather than sorted in: it is the row's current
          // state, and burying it under forty names is how it gets overwritten.
          <option value={LEGACY}>{`${legacyName} (نام ثبت‌شدهٔ قبلی)`}</option>
        ) : null}
        {(members ?? []).map((member) => (
          <option key={member.id} value={member.id}>
            {member.name}
            {member.isActive ? "" : " (غیرفعال)"}
          </option>
        ))}
      </select>
    </Field>
  );
}
