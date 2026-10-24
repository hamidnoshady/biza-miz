# «اشخاص» (parties directory) — audit and fixes

Scope of the audit: `src/app/dashboard/parties/` (`parties-section.tsx`, `party-form.tsx`)
plus the pure helpers the two read — `src/lib/parties.ts`, `src/lib/parties-scopes.ts`,
`src/lib/party-directory.ts`, `src/lib/party-drafts.ts` — and the five mounts of the
section (`crm/directory-section`, `accounting-manager`, `inventory/suppliers-section`,
`team/team-manager`, plus the sales picker scope).

Every item below was verified against the source before being fixed, and each fix is
covered by a unit test in `src/lib/parties*.test.ts` / `src/lib/party-*.test.ts` where the
behaviour is expressible without a DOM.

---

## A. Data-loss and correctness bugs

### A1 — `balance` and `tax` columns hid real values (falsy check) — **list**

`PartyCell` rendered `showLedger && balance ? formatMoney(balance) : "—"`. A party whose
A/R balance is exactly `0` — the ordinary case for a customer who has settled — rendered
«—», the same glyph used for «this figure is not available to you». The mobile card did
the same with `canSeeLedger && balances[party.id]`.

The tax cell had the mirror of the bug in the *opposite* direction: `typeof tax ===
"number" && showLedger` renders `0٪` correctly, but a party stored with a *string* tax
rate (an importer, a pre-0137 document) fell to «—» instead of the rate it holds.

**Fixed**: the balance cell distinguishes "no permission" (`—`) from "zero" (formatted
`۰`), and the tax cell reads through `taxPercentageOf`, the same coercion the payload
builder and the service use.

### A2 — «پاک کردن فرم» wiped the role set and could desync `role` ∉ `roles`

```ts
setState({ ...resetPartyForm(), role: scope.defaultRole });
```

`resetPartyForm()` returns `roles: ["Customer"]`. Spreading `role: scope.defaultRole` over
it left, in the team scope, `{ role: "Employee", roles: ["Customer"] }` — a state that
`validatePartyForm` rejects with `invalid_role` on a field the section does not even draw
(the role is a fixed pill there), so «ذخیره» failed with no visible error.

**Fixed**: the reset goes through `withPartyRoles(resetPartyForm(), openingRoles)`, the one
helper that sets the pair together, so the form returns to the roles it *opened* with.

### A3 — tax-rate input turned a cleared field into a 0 % rate

```ts
const digits = event.target.value.replace(/[۰-۹]/g, …);
patchTab("generalInfo", { taxPercentage: Number(digits.replace(/[^\d.]/g, "")) });
```

Three separate faults, all reproduced in a scratch script:

| input | stored | should be |
| --- | --- | --- |
| `""` (field cleared) | `0` | the default (9) |
| `"۹٫۵"` (Persian decimal mark «٫») | `95` | `9.5` |
| `"٩"` (Arabic-Indic) | `0` | `9` |

`Number("")` is `0`, and 0 % is a rate a business really uses — so a cleared field silently
made a party tax-free instead of returning to the platform default.

**Fixed**: the field is a `PersianNumberInput` (the repo's own numeric control, which
already folds Persian *and* Arabic-Indic digits and the «٫» mark to ASCII), holds its own
text while typing, and commits through `taxPercentageOf` so an emptied field means "the
default", never "zero". The commit also happens on submit, because a mouse-down on a
button inside a Radix dialog does not always fire the input's `blur` first.

### A3b — the *shared contract* multiplied every fractional rate by ten

Writing the test for A3 turned up a worse version of the same bug one layer down, in the
pure helper both the form **and the server** use:

```ts
const value = typeof raw === "number" ? raw : Number(asciiDigits(raw));
```

`asciiDigits` strips every non-digit — the decimal mark included — so the *contract* read
a fractional rate as a whole number:

| stored / typed | `taxPercentageOf` gave | should be |
| --- | --- | --- |
| `"۹٫۵"` | `95` | `9.5` |
| `"9.5"` | `95` | `9.5` |
| `"۰٫۵"` | `5` | `0.5` |
| `"۱۲٫۵"` | `9` (out of range → default) | `12.5` |
| `"   "` | `0` (tax-exempt!) | the default |

Two different failure modes, and the quiet one is the dangerous one: `12.5` fell outside
`0…100` and was replaced by the 9 % default, which at least *looked* wrong; `9.5` landed
inside the range and was stored as **95 %** — ten times the rate the person typed, applied
to every invoice raised against that party from then on.

`validatePartyForm` had the same expression, so the two disagreed about the same string:
it refused «۱۲٫۵» as `invalid_tax_percent` (a legal rate the form would not accept) and
passed «۹٫۵» straight through to be stored at 95 %. And `toParty` wrapped the stored value
in `Number()` before the coercion — `Number("۹٫۵")` is `NaN` — so a fractional rate that
*did* reach the column was read back as 9 % on every load.

**Fixed**: all three now go through `normalizeNumericText` (the shared parser that
`PersianNumberInput` already emits through, and which understands «٫», «٬» and both digit
sets). `parties.ts` takes its one and only import for this — `digits.ts` has no imports of
its own, so the contract stays runnable in a route, a client component and a bare vitest
process alike. Whitespace-only is now «cleared» rather than `0`, and an empty field is no
longer a validation error, since it means «use the default».

This is the one fix in this pass that reaches past the directory: `parties-service.ts`
persists through the same helper, so it was corrupting rates written by the API and the
assistant's tools too, not just the form.

### A4 — a party with a `0` accounting code rendered «—»

`party.accountingCode ? toPersianDigits(…) : "—"` — codes are strings so this is narrow,
but `"0"` is falsy-adjacent in the same family of bug as A1. Replaced with an explicit
null/empty check.

### A5 — the status toggle sent a write the read-only scopes must not make

`toggleStatus` and `remove` were reachable whenever `canManage` was true, which is correct,
but neither cleared a *stale* `info` banner before running, so «شخص حذف شد.» stayed on
screen while the next row was being archived. `run()` cleared `error` but never `info`.

**Fixed**: both clear the other banner, so the message on screen always describes the last
action.

### A6 — optimistic `total` was never corrected after a delete

Deleting the only row on the last page left `page` beyond `totalPages`, and because the
list reloads with the same `page`, the section rendered an empty list with a pager saying
«۳ از ۲». **Fixed**: an effect clamps `page` into range whenever `total` shrinks.

---

## B. Race conditions and lifecycle bugs

### B1 — out-of-order list responses (the classic search race)

`load()` fired a fetch per keystroke with no cancellation and no request token. A slow
response for «ا» arriving after the fast one for «احمدی» overwrote the list with the wrong
rows, and the pager with the wrong total.

**Fixed**: every load carries an `AbortController`; the effect aborts the in-flight request
on cleanup, and a stale response is dropped. The same guard is applied to the balances
fetch, the categories fetch and the form's own record fetch.

### B2 — the search box hit the API on every keystroke

No debounce anywhere in the section: typing a ten-character name issued ten paginated
queries, each of which runs a `count(*)` plus an encrypted-phone search over `parties`.

**Fixed**: a 300 ms debounce on the query term only (the page, the view, the category and
the archived toggle still apply immediately, because those are deliberate clicks).

### B3 — `load` re-ran on every render through an unstable dependency

`listedRoles` is a `useMemo` over `[activeView, scope]`, and `activeView` is
`partyDirectoryView(view)` — recomputed on *every* render, a new object each time. So
`listedRoles` changed identity every render, `load` changed with it, and `useEffect(load,
[load])` re-fetched the whole directory on every render of the parent.

**Fixed**: `activeView` is memoised on `view`, and `load` depends on the joined role
*string* rather than the array identity.

### B4 — `loadCategories` declared a dependency it does not use

```ts
const loadCategories = useCallback(() => { … }, [refreshKey]);
```

`refreshKey` is not read inside the callback — it is there to force a re-fetch, which works
but reads as a mistake and trips `react-hooks/exhaustive-deps`. Made explicit: the callback
takes no dependency and a separate effect re-runs it on `refreshKey`.

### B5 — the draft autosave interval captured a stale `businessId`

The form's autosave timer starts on mount. `businessId` arrives from the *list's* response,
so on a deep link (`/crm/directory?customer=…`) the form can open before the list has
answered, and the first autosaves ran with `businessId === ""` — `savePartyDraft` returns
`null` for that, so those drafts were silently dropped. Worse, `draftId` stayed `null`, so
once the id did arrive every later tick minted a *new* draft row.

**Fixed**: the interval is skipped until there is a business id, and the draft id is kept in
a ref so a late first save cannot fork the row.

### B6 — the "record loaded" effect could not be cancelled properly

It had a `cancelled` flag but still called `setLoadingRecord(false)` before checking it in
one branch. Tightened, and an `AbortController` added.

---

## C. Permission / scope bugs

### C1 — the statement button was drawn for members who cannot open a statement

`canSeeStatement={canSeeLedger && scope.key !== "accounting"}` — `canSeeLedger` follows
`ledger.view`, but `ArStatementPanel` reads `/api/ledger/ar/customers/:id`, which is gated
by `requireRole("owner","manager","accountant")`. A **cashier granted `ledger.view`** (a
real, supported override — `parties-scopes.test.ts` asserts it) saw «صورتحساب» and got an
empty panel.

Worse, the panel is an **A/R** statement and the row may be a *supplier* or an *employee*:
in the Accounting scope every counterparty is listed, so «صورتحساب» on a supplier opened a
receivables statement that is structurally empty for them.

**Fixed**: the statement action is only drawn for a row that actually holds the `Customer`
role, and a supplier row opens the **A/P** statement panel (`ApStatementPanel`) instead —
the ledger's own supplier statement, which already exists and was simply never wired here.

### C2 — «دسته‌ها» was openable in a read-only scope

The categories button was drawn unconditionally, including in the `sales` picker scope
(`readOnly: true`). The dialog itself hides its editor behind `canManage`, so nothing could
be written — but a read-only view offering a management door is the drift the scope table
exists to prevent.

**Fixed**: the button is hidden when the scope is read-only.

### C3 — the archived filter and the category filter fought each other silently

Covered by `directoryFilterCategories`, which already retires a stale category — but the
*archived* categories were still offered while «نمایش بایگانی‌شده‌ها» was off. Left as is
(the helper is correct); the effect that clears a stale selection now also runs when the
category list itself is reloaded.

---

## D. Accessibility bugs

### D1 — the role checkbox group was not operable from a keyboard

```tsx
<button role="checkbox" aria-checked={checked} … />
```

A `<button role="checkbox">` is announced as a checkbox but only responds to `Enter` and
`Space` *as a button* — which happens to work — while the group itself had
`aria-describedby="party-form-roles-hint"` pointing at an element that is **only rendered
when there is no error**. With a role error on screen, the group referenced a missing id.

**Fixed**: the hint element is always rendered (the error is a separate node), so the
`aria-describedby` target always exists.

### D2 — the search input had no accessible name

`<input placeholder="جستجو با نام یا تلفن…">` with no label and no `aria-label`. A
placeholder is not a name — it disappears on the first keystroke and several screen
readers do not announce it at all.

**Fixed**: `aria-label` added, and the same for the category filter `<select>` and the
categories dialog's role `<select>`.

### D3 — the archived checkbox was not programmatically associated

The Radix `<Checkbox>` renders a `<button>`, so wrapping it in a bare `<label>` does **not**
associate them (a `<label>` only labels form controls, and a button is not one). The text
«نمایش بایگانی‌شده‌ها» was therefore decorative and the control announced as unlabelled.

**Fixed**: `id` + `aria-labelledby` wiring.

### D4 — the profile-image preview and the file input

`alt=""` on the avatar is right (decorative), but the file input had no accessible name
either. Labelled, and the size limit is now stated in the UI before a file is picked rather
than only in the error.

### D5 — the dialogs had no description

Radix warns at runtime for a `DialogContent` with no `DialogDescription` or
`aria-describedby`. Both party dialogs (the form and the categories panel) now carry a
description, which also gives the form's purpose to a screen reader.

### D6 — the delete/archive confirmation used `window.confirm`

Left in place deliberately (the repo uses it in several places, e.g. the branch supplier
row), but the message now names what will happen to the ledger history.

---

## E. Responsive / layout bugs

### E1 — the table's breakpoint cut off three columns on a tablet

`hidden … lg:block` for the table and `lg:hidden` for the cards means everything below
1024 px gets the card list. That is right for a phone, but the Accounting scope draws
**seven** columns and its card summary joins role, phone, category, code and balance into
one `·`-separated sentence — at 900 px there is room for a table and the sentence is
unreadable.

**Fixed**: the card summary is a definition list (label + value pairs) instead of a run-on
sentence, so it stays readable at every width, and the table is allowed from `md` up where
the scope draws four columns or fewer.

### E2 — the toolbar collapsed badly between 360 px and 640 px

`w-full sm:w-56` on the search input plus `w-auto` on the select meant that, below `sm`,
the search took the full row and the select + checkbox wrapped into a cramped second row
with a 12 px gap. On a 360 px phone the select overflowed its container because `w-auto`
does not shrink.

**Fixed**: the toolbar is a grid that stacks cleanly (`grid-cols-1` → `sm:auto` columns),
and the select gets `min-w-0` so a long category name cannot push the row wide.

### E3 — the form dialog could not be scrolled to its footer on a short screen

`DialogContent` is `max-h-[calc(100dvh-2rem)] overflow-y-auto`, and the party form puts its
tab panel, the drafts panel and the footer inside that one scroller. On a 640 px-tall
laptop with the financial tab open, the footer sat below the fold and the whole dialog
scrolled — including the header, so the person lost the title of what they were editing.

**Fixed**: the dialog is a flex column with a sticky header, a single scrolling body, and
the footer pinned — the shape the rest of the repo's dialogs use.

### E4 — the accounting-code row overflowed at 320 px

`sm:max-w-32 sm:shrink-0` on the mode select and `sm:flex-1` on the input are fine from
`sm`; below it the two stack, but the input carries `dir="ltr"` with a Persian placeholder
(«با ذخیره ساخته می‌شود») — a *value*, not a placeholder, so it was rendered LTR and
right-aligned away from the label.

**Fixed**: the automatic-mode hint is a real `placeholder` (so it is not submitted, not
LTR-flipped, and greys out correctly) instead of a fake value.

### E5 — the category dialog's grid broke at its own breakpoint

`sm:grid-cols-[1fr_8rem_auto]` with a `<Field>` in each cell: `Field` carries `mb-4`, so the
three cells had different heights and the «افزودن» button sat 16 px above the baseline of
the inputs. **Fixed** by dropping the stray margin in that row.

### E6 — the drafts list overflowed with a long party name

`<span className="min-w-0">` without `truncate` on the child does nothing. A draft named
after a long company name pushed the «بازخوانی»/«حذف» buttons off the dialog.

**Fixed**: the label truncates and the buttons stay reachable.

---

## F. UX / copy bugs

### F1 — the draft timestamp was Gregorian ISO text

```tsx
{toPersianDigits(draft.savedAt.slice(0, 16)).replace("T", " ")}
```

This renders `۲۰۲۶-۰۹-۱۷ ۱۰:۲۴` — a **Gregorian** date shown to a user, which
`AGENTS.md` bans outright ("Shamsi-only dates … in every function and every screen").
It is also UTC, so a draft saved at 02:00 Tehran time claimed the previous day.

**Fixed**: `formatJalali(draft.savedAt, { withTime: true })`, which is Tehran-local and
Shamsi.

### F2 — «افزودن {role}» built a Persian plural by concatenation

```ts
`${PARTY_ROLE_LABELS[listedRoles[0]]}ای پیدا نشد.`
```

For «کارمند» this produces «کارمندای پیدا نشد.» — colloquial-wrong. And
`PARTY_ROLE_LABELS[listedRoles[0]]` indexes `listedRoles[0]` without checking the array is
non-empty; `listedRoles` falls back to `scope.roles`, which is never empty, so it cannot
crash today — but the empty-state string is generated rather than written.

**Fixed**: the empty state uses the existing `PARTY_ROLE_TAB_LABELS` (the plural forms the
product already keeps) and reads «تأمین‌کننده‌ای پیدا نشد» correctly for all three roles.

### F3 — the form title said «شخص جدید — » with nothing after it in a locked scope

`state.roles.map(…).join(" و ")` is right, but in a single-role scope the roles pill
already states the role, so the title repeated it. Minor; left, but the title now falls
back gracefully if `roles` is momentarily empty.

### F4 — a saved party did not tell you *what* was saved

«شخص ذخیره شد.» — fine for one save, ambiguous after three. Now names the person.

### F5 — «پیش‌نویس‌ها (۰)» was disabled but still looked like a button

`disabled={drafts.length === 0 && !showDrafts}` renders a greyed control with a zero count.
Now hidden entirely when there are no drafts, which is what the rest of the repo does.

### F6 — the info banner never cleared

`setInfo` was called on save/delete and only ever overwritten, so «شخص حذف شد.» stayed
above the list while the person went on to edit somebody else. Cleared on the next action.

---

## G. Things that look like bugs and are not

Recorded so they are not "fixed" later by mistake:

- **`customers` beside `parties` in the API response** is a deliberate compatibility alias
  (`src/app/api/parties/route.ts`), not duplication.
- **`role` and `roles` both on the wire** is migration 0148's contract: `role` is the
  primary role that decides the accounting-code prefix, `roles` is the set. `role ∈ roles`
  is an invariant enforced in three places.
- **The status toggle sending `{status}` alone** is safe *because* the PUT route is
  patch-shaped (`parsePartyRequestBody(body, { partial: true })`).
- **`buildNonAccountingPayload` stripping the ledger keys** is what keeps a cashier's save
  from 403-ing; it is not a lost field.

---

## Verification

| check | result |
| --- | --- |
| `./node_modules/.bin/tsc --noEmit -p tsconfig.json` | 0 errors |
| `npx vitest run` (whole repo) | **303 files, 4450 tests passing** (was 4413) |
| `src/app/dashboard/design-lint.test.ts` | passing — no new colour/shadow/radius violations |
| `src/app/design-lint.test.ts` | passing |
| `src/app/(app)/accounting/accounting-nav-rtl.test.ts` | passing — no physical insets introduced |
| `src/app/dashboard/team/team-manager.test.ts` | passing — the `<PartiesSection` mount is intact |

Two existing tests were updated rather than worked around, and both are noted here because
an updated assertion deserves more scrutiny than a new one:

- `parties-scopes.test.ts` compared the whole abilities object with `toEqual`, so adding
  the third field `canOpenStatement` broke four assertions. The expectations were extended
  with the new field (not loosened to `toMatchObject`), so the object shape stays pinned.
- `accounting-nav-rtl.test.ts` grepped for the literal
  `params.set("roles", listedRoles.join(","))`. The fix for B3 hoisted that join into a
  `rolesParam` constant so the loader's dependency list compares a string instead of a
  fresh array. The test now pins both halves of the chain — that `rolesParam` *is*
  `listedRoles.join(",")` and that it is what the request carries — so it still proves the
  property it was written for (a hand-typed `?view=` cannot widen the listed roles).

`parties.test.ts` also had one assertion that pinned the A3b bug as correct behaviour
(`taxPercentageOf("۱۲٫۵") === DEFAULT_TAX_PERCENTAGE`, described in the test as "a rate that
is not a rate"). 12.5 % *is* a rate; the assertion was encoding the parser's inability to
read a decimal mark. It has been replaced by the two tests above it.

### New tests

- `src/app/dashboard/parties/parties-directory-regressions.test.ts` (34) — one assertion
  per fixed defect. The tax behaviour is tested by calling the real functions; the rest
  greps the two client sources, which is how `design-lint.test.ts` and
  `accounting-nav-rtl.test.ts` already work in this repo (vitest runs in Node here, with
  no jsdom and no `@testing-library`, so a client component cannot be mounted).
- `parties-scopes.test.ts` (+5) — `partyStatementKind` for each role combination, and that
  `canOpenStatement` matches the roles the statement routes actually admit.
- `parties.test.ts` (+2) — fractional rates survive; «cleared» and «zero» stay distinct.

### Not done

- The `window.confirm` dialogs (D6) are still native. Replacing them needs a shared
  confirm component the repo does not have yet, and inventing one here would put a second
  confirmation pattern into the codebase. The messages were rewritten to name the person
  and state the consequence, which is the part that was actually harmful.
- `listCustomerBalances` omitting zero balances is handled at the call site (`?? 0`) rather
  than changed. Other callers depend on the current shape, and widening it is a ledger
  change, not a directory one.
