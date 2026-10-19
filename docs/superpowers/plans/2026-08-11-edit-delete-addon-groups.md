# Edit & Delete Add-on (Modifier) Groups — Implementation Plan

> **Historical note (2026-10-19, issue #910):** this plan was written against
> `/dashboard/menu/menu-manager.tsx`, which no longer exists — issue #844 moved
> menu management to `/accounting/menu` and the old addresses are permanent
> 308 redirects. The add-on group editor now lives in
> `src/app/(app)/accounting/menu/modifiers-panel.tsx` (`GroupDetailSheet`).
> The file paths and line numbers below are kept as the historical record; the
> behavior they describe is the behavior to verify in the current file.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner/manager rename an add-on (modifier) group, change its min/max selection bounds, or delete it — all inline in the menu manager, without leaving the page.

**Architecture:** Frontend-only change in `src/app/dashboard/menu/menu-manager.tsx`. The `PATCH` and `DELETE` API routes at `/api/menu/modifier-groups/[id]` already exist and already enforce tenant scope and validation — nothing changes server-side. `ModifierGroupRow` gets an `editing` state plus Edit/Delete buttons in its header; the edit form swaps only the header while the modifier list and add-modifier form stay visible. Save/delete go through the existing `run()` wrapper, which refreshes the loaded `MenuData` on success.

**Tech Stack:** Next.js 15 (App Router, TypeScript), React 19 client component, existing UI primitives (`Field`, `inputClass`, `PrimaryButton`, `SecondaryButton`, `run`), `toPersianDigits` from `@/lib/digits`.

## Global Constraints

- UI copy is Persian, RTL; numbers shown with `toPersianDigits`.
- Money in integer Rial; inputs of the max-select/min-select are plain integers, not money.
- Every mutation goes through the existing `run()` helper in `MenuManager` — never a raw `fetch` in this component.
- Validation mirrors the existing create form: name non-empty; min ≥ 0, max ≥ 1, min ≤ max. These must be checked **client-side in `save`** — unlike the `POST` route, the `PATCH` route does *not* re-validate them (it does `Number(x) || default` with no `min ≤ max` check).
- Follow the existing patterns in this file: `SecondaryButton` for secondary actions, `window.confirm` before delete (same phrasing style as `ItemRow`'s delete), `disabled={busy}` on all action buttons.
- No new dependencies. No schema change, no new migration.

---

### Task 1: Add Edit and Delete actions to `ModifierGroupRow`

**Files:**
- Modify: `src/app/dashboard/menu/menu-manager.tsx:587-656` (the `ModifierGroupRow` component)

**Interfaces:**
- Consumes: `ModifierGroup` (`{ id, name, min_select, max_select }`), `Runner`, `busy: boolean`, existing `run`, `api`, `Field`, `inputClass`, `PrimaryButton`, `SecondaryButton`, `toPersianDigits`.
- Produces: nothing consumed elsewhere — this is the final UI.

- [ ] **Step 1: Add the `editing` state and the `save`/`removeGroup` handlers**

Inside `ModifierGroupRow`, after the existing `const [delta, setDelta] = useState("0");` line, add:

```tsx
const [editing, setEditing] = useState(false);
```

Then, after the existing `addModifier` function, add a `save` handler and a `removeGroup` handler:

```tsx
async function save(event: React.FormEvent) {
  event.preventDefault();
  if (!name.trim()) return;
  const ok = await run(() =>
    api(`/api/menu/modifier-groups/${group.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: name.trim(), minSelect: Number(minSelect), maxSelect: Number(maxSelect) }),
    }),
  );
  if (ok) setEditing(false);
}

function removeGroup() {
  if (!window.confirm(`گروه افزودنی «${group.name}» و همهٔ افزودنی‌هایش حذف شود؟`)) return;
  void run(() => api(`/api/menu/modifier-groups/${group.id}`, { method: "DELETE" }));
}
```

Note: `name`, `minSelect`, `maxSelect` here refer to new per-group state added in Step 2, not the `ModifierSection` ones.

- [ ] **Step 2: Rename the existing add-modifier state to avoid clashing with the group edit form**

The component currently declares `const [name, setName]` and `const [delta, setDelta]` for the "add modifier" form, but the group edit form also needs `name`/`minSelect`/`maxSelect` state. Rename the add-modifier state to `modifierName`/`modifierDelta`:

- Change `const [name, setName] = useState("");` → `const [modifierName, setModifierName] = useState("");`
- Change `const [delta, setDelta] = useState("0");` → `const [modifierDelta, setModifierDelta] = useState("0");`
- In `addModifier`, change every reference: `if (!name.trim()) return;` → `if (!modifierName.trim()) return;`, `parseToRial(delta || "0", "toman")` → `parseToRial(modifierDelta || "0", "toman")`, `setName("")` → `setModifierName("")`, `setDelta("0")` → `setModifierDelta("0")`, and in the JSX `value={name}` → `value={modifierName}`, `onChange={(e) => setName(e.target.value)}` → `onChange={(e) => setModifierName(e.target.value)}`, `value={delta}` → `value={modifierDelta}`, `onChange={(e) => setDelta(e.target.value)}` → `onChange={(e) => setModifierDelta(e.target.value)}`.

- [ ] **Step 3: Add the group edit state and the new header**

Add group edit state inside `ModifierGroupRow`:

```tsx
const [editName, setEditName] = useState(group.name);
const [editMin, setEditMin] = useState(String(group.min_select));
const [editMax, setEditMax] = useState(String(group.max_select));
```

`save` in Step 1 must read these instead of the add-modifier names:

```tsx
async function save(event: React.FormEvent) {
  event.preventDefault();
  if (!editName.trim()) return;
  const ok = await run(() =>
    api(`/api/menu/modifier-groups/${group.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: editName.trim(), minSelect: Number(editMin), maxSelect: Number(editMax) }),
    }),
  );
  if (ok) setEditing(false);
}
```

Replace the existing header `<p className="mb-2 text-sm font-medium">…</p>` block (the group name + `(انتخاب X تا Y)` line) with a version that renders either the read-only header or the edit form, and always shows Edit/Delete buttons:

```tsx
{editing ? (
  <form
    className="mb-2 grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3"
    onSubmit={save}
  >
    <Field label="نام گروه">
      <input className={inputClass} value={editName} onChange={(e) => setEditName(e.target.value)} required />
    </Field>
    <Field label="حداقل انتخاب">
      <input className={inputClass} dir="ltr" inputMode="numeric" value={editMin} onChange={(e) => setEditMin(e.target.value)} required />
    </Field>
    <Field label="حداکثر انتخاب">
      <input className={inputClass} dir="ltr" inputMode="numeric" value={editMax} onChange={(e) => setEditMax(e.target.value)} required />
    </Field>
    <div className="flex items-end gap-2">
      <PrimaryButton disabled={busy}>ذخیره</PrimaryButton>
      <SecondaryButton disabled={busy} onClick={() => setEditing(false)}>انصراف</SecondaryButton>
    </div>
  </form>
) : (
  <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
    <p className="text-sm font-medium">
      {group.name}{" "}
      <span className="text-xs text-muted-foreground">
        (انتخاب {toPersianDigits(group.min_select)} تا {toPersianDigits(group.max_select)})
      </span>
    </p>
    <div className="flex flex-wrap items-center gap-2">
      <SecondaryButton disabled={busy} onClick={() => { setEditName(group.name); setEditMin(String(group.min_select)); setEditMax(String(group.max_select)); setEditing(true); }}>ویرایش</SecondaryButton>
      <SecondaryButton disabled={busy} onClick={removeGroup}>حذف</SecondaryButton>
    </div>
  </div>
)}
```

Note the `save` function from Step 1 has been folded into the version above that uses `editName`/`editMin`/`editMax` — use exactly one `save`. The Edit button re-initializes the edit state from the group before opening, so a cancelled edit never shows stale values next time.

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors. If the project shows unrelated pre-existing errors, confirm none reference `menu-manager.tsx`.

- [ ] **Step 5: Manual smoke test**

Start the app (`npm run dev`), open the Menu page, and:
1. Click «ویرایش» on an existing group — the header becomes three inputs pre-filled with the group's name/min/max; the modifier list stays visible below.
2. Change the name and max, click «ذخیره» — the header returns to read-only showing the new name and bounds, and the list (loaded from the API) reflects it.
3. Click «ویرایش», change a value, click «انصراف» — nothing changed.
4. Click «حذف» on a group — confirm dialog appears; accept — the whole group card (and its modifiers) disappears.
5. Confirm no console errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/dashboard/menu/menu-manager.tsx
git commit -m "feat: edit and delete add-on groups in menu manager"
```

**No unit test:** this change is UI-only (`menu-manager.tsx` is a client component; nothing under `src/lib/` changed), matching the project convention that `*.test.ts` covers `src/lib/*` pure logic. Manual smoke test in Step 5 covers it.
