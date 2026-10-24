# UI design-system violation fixes — `src/app/dashboard/`

Branch `arena/01a090f1-cafe-restaurant-pos` · commit `d324763` · 41 files changed

## Starting point

The design lint (`src/app/dashboard/design-lint.test.ts`) already passed **14/14**, and it
keeps no baseline — so every violation fixed here was one its regexes could not see. Three
kinds of blind spot:

- **Rules that don't exist.** `rounded-md` and `type="date"` are banned by
  `docs/design-system.md` / `AGENTS.md` prose, but no rule greps for them.
- **Values one digit off.** The `heavy shadows` rule bans `shadow-sm|md|lg`; it says nothing
  about a hand-written `rgb(41_37_36/0.03)` where the canonical ink is `0.035`.
- **Patterns the rule's shape misses.** `CARD_SKIN` only matches `rounded-2xl …`, so a card
  skin restated at `rounded-xl` slipped through.

## What changed, by category

### 1. Radius scale — `rounded-md` eliminated (34 → 0)

Per §Radius scale, controls are `rounded-lg`, pills/chips are `rounded-xl`, cards are
`rounded-2xl`; "no `rounded-md` buttons" is explicit. Each site was classified by role:

| Role | → | Files |
| --- | --- | --- |
| Icon buttons, steppers, text actions, select triggers | `rounded-lg` | `jalali-date-picker`, `dashboard-grid`, `pos/cart-line-card`, `inventory/stock-counts-section`, `knowledge/kb-nav`, `branch-switcher` |
| Chips, count badges, status pills | `rounded-xl` | `kitchen/kds-board` (×4), `reservations-manager`, `jewelry/items-section`, `watch/units-section`, `products/barcode-templates-section`, `modifier-picker` |
| Inner panels inside a card | `rounded-xl` | `website/wp/woo-store-sections` (×5), `website/wp/woocommerce-connection-panel` (×4), `menu/menu-manager` |
| Calendar day cells | `rounded-lg` | `jalali-date-picker` |

The only `rounded-md` still reaching the DOM comes from the shadcn `Skeleton` primitive,
which the design system explicitly puts out of scope ("change a token or a variant there,
never a one-off class at a call site").

### 2. Shadows

- **Removed redundant overrides.** 10 files composed `cardClass` *and* appended their own
  `shadow-[…]`, silently re-declaring — and downgrading — the primitive's shadow. The
  override is deleted; `cardClass` is the single source.
- **Normalised forked inks** `0.03` and `0_1px_3px` → the canonical
  `shadow-[0_1px_2px_rgb(41_37_36/0.035)]`.
- **`TabBar`** (in `page-chrome.tsx` itself) restated the card skin at `0.03`; it now
  composes `cardClass`.
- **AI drawer** is a floating surface, so it composes `overlayPanelClass` (§Floating
  surfaces) rather than wearing a 1px card shadow.

### 3. Hand-rolled chrome → primitives

- **`pinned-reports.tsx`** composes `cardClass`, and its `// Counted drift` entry is
  **deleted from the lint's allow-list** — that rule now exempts only the file defining the
  class.
- **Card skins** in `kds-board`, `delivery-board`, `reservations-manager`,
  `operations-overview`, `floor-plan`, `support/page`, `dashboard-grid` now compose
  `cardClass` instead of restating border + bg + shadow.
- **KDS had no page frame at all** — the lint's frame check skips it because of its auth
  `redirect(`. It now mounts `<PageShell>`, per §Realms ("a full-screen operational surface
  (POS, KDS) still mounts `<PageShell>` around its dense chrome").
- **`branch-management-settings`** hand-rolled a `<header>` + `<h1>` that duplicated
  `PageHeader`'s spacing and put a **second `<h1>`** on the settings page. Removed — the
  settings rail already names the open section. Verified live: that page now serves exactly
  one `<h1>`.

### 4. Loading states — one skeleton dialect (`animate-pulse` 21 → 0)

`reservations-manager`, `floor-plan`, `kb-article`, `kb-browser` and `kb-nav` hand-rolled
`animate-pulse … motion-reduce:animate-none` bars — a second shimmer competing with the
shared `Skeleton` primitive. All now use `Skeleton`/`LoadingSkeleton`, so the shimmer, its
warm ink and the reduced-motion opt-out have one definition. The reservations skeleton also
gained the `role="status"` + `aria-label` the primitives expect.

*(There was no `animate-spin` left under `src/app/dashboard` to fix — the remaining ones are
in `src/app/platform/**`, a deliberately separate realm the design system excludes.)*

### 5. Colour and dark mode

- **Raw hex gone from the dashboard.** `floor-plan`'s edit-mode grid used `#ECE9E2`, which
  stayed light-grey in dark mode; it now uses `var(--border)`. Two doc comments naming dead
  hex values (`ops-styles.ts`, `order-detail-modal.tsx`) were rewritten in token language.
- **`floor-plan` table tiles** dropped light-only `bg-white/65` and `text-white` for tokens
  that flip.
- **WP content/customers avatar chips** paired only their *background* with a `dark:`
  variant, so the icon stayed dark-on-dark; they use the muted token pair now.

The 19 remaining unpaired `text-amber-950` instances are the **documented exception** — "A
solid amber fill intentionally keeps dark amber text in both themes."

### 6. Shamsi-only dates

`crm/deals-section.tsx` used a native `<input type="date">`, which opens a **Gregorian**
calendar — banned outright by `AGENTS.md`. Replaced with `JalaliDatePicker`.

### 7. A real bug found while fixing (worth flagging)

Composing `cardClass` means each card now always contributes `border-border/80`. Tailwind
emits `border-amber-500` **before** `border-border/80` in the stylesheet, so with plain
template strings the *selected*, *late* and *overdue* border colours would have silently lost
the cascade — a visual regression the tests would not have caught.

The three affected call sites (`kds-board`, `reservations-manager`, plus the pre-existing
same bug in `support/page.tsx`) now build their class list with `cn()`/`twMerge`, which drops
the conflicting class rather than relying on emission order. Confirmed against the built CSS
and by running `twMerge` on the exact inputs.

## Verification

| Check | Result |
| --- | --- |
| `npm test -- src/app/dashboard/design-lint.test.ts` | **14 passed** ✅ |
| `npm test` (full suite) | **242 files / 3708 tests passed** — identical to baseline ✅ |
| `npx tsc --noEmit` | clean ✅ |
| `npm run build` | succeeds, 495 pages ✅ |
| grep `shadow-sm\|shadow-md` (excl. page-chrome) | nothing ✅ |
| grep `mx-auto w-full max-w-\[` (excl. page-chrome) | nothing ✅ |
| grep `<h1` in `page.tsx` | nothing ✅ |
| grep `rounded-md` / `animate-spin` / `animate-pulse` | nothing ✅ |
| `scripts/dark-audit.mjs` (repo's own tool) | 306 → **301** tokens, 74 → 73 files, **no new findings** ✅ |

Screens were additionally loaded against a seeded local Postgres (`/dashboard`, `/kitchen`,
`/reservations`, `/settings`, `/orders`, `/floor`, `/pos`, `/knowledge`, `/crm`, `/support`)
— all HTTP 200, KDS confirmed rendering inside the `max-w-[1600px]` canvas, settings
confirmed at exactly one `<h1>`, and zero `animate-pulse`/`animate-spin` in the served HTML.

## Note on scope

Files listed in the task that needed **no changes** — `growth/*`, `crm/*` (beyond the date
picker), `cosmetics/batches-section.tsx` — were verified clean rather than edited. The
`jewelry`/`watch` "amber border chips" turned out to be a radius issue, not a dark-mode one;
they were already correctly paired.
