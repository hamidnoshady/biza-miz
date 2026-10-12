# Visual regression — how the approved look is held

The design lints (`npm run test:design`) catch *code* drift: a cool neutral, a
hand-rolled table, a re-derived chip. They cannot catch a screen that uses all
the right primitives and still looks wrong — a card that lost its padding, a
table whose columns collapsed, a dark-mode surface that went white.

That is what this check is for. It renders representative screens of all four
apps and compares them, pixel by pixel, with committed baseline images.

## Running it

```bash
npm run db:dev:start && npm run db:migrate && npm run db:seed   # deterministic data
npm run build && npm start &                                    # or `npm run dev`
npm run test:visual
```

It also runs on every pull request (`.github/workflows/test.yml`, job
`visual-regression`) and is one of the jobs the `required` status check fans in.

### Running it from a sandbox that cannot reach Playwright's CDN

CI installs the browser pinned by `playwright@1.56.0` — Chromium 141. A sandbox
whose egress blocks `cdn.playwright.dev` and
`playwright.download.prss.microsoft.com` cannot do that, and pointing the harness
at *whatever* Chromium is lying around is not an option: it refuses a mismatched
major on purpose, because text rasterises differently between majors (that was
the first all-red CI run). The recipe that works is a **matching** build from an
npm package:

```bash
npm i --no-save --no-package-lock @sparticuz/chromium@141.0.0
# extract the browser and the shared libraries it links against
node -e 'import("@sparticuz/chromium").then(async (m) => console.log(await m.default.executablePath()))'
node -e 'const {brotliDecompressSync}=require("node:zlib");const {readFileSync,writeFileSync}=require("node:fs");writeFileSync("/tmp/al2023.tar",brotliDecompressSync(readFileSync("node_modules/@sparticuz/chromium/bin/al2023.tar.br")))'
mkdir -p /tmp/chromium-libs && tar -xf /tmp/al2023.tar -C /tmp/chromium-libs
LD_LIBRARY_PATH=/tmp/chromium-libs/lib VISUAL_CHROMIUM_PATH=/tmp/chromium npm run test:visual
```

That build calls itself `141.0.7390.0` (the package strips the last version
component), which satisfies the major check. What it does **not** change is
anything else on this page: seed the fixture, build for production, and serve the
seeded database — the two CRM baselines re-recorded through this recipe came out
at 2.9% and 3.3% against the old ones for exactly the reason the diff images
showed, and the other twelve screens matched to the pixel, which is the evidence
that the environment was not the variable.

## What is covered

| Baseline | App | What it establishes |
| --- | --- | --- |
| `accounting-trial-balance` | Accounting | Table hierarchy, header wash, numeric columns, status pill, amber eyebrow |
| `accounting-trial-balance-dark` | Accounting | The same screen in dark mode — the tokens must flip, nothing hardcoded |
| `accounting-orders` | Accounting | Page header, search + filter chips, order queue, rich empty states |
| `accounting-inventory` | Accounting | Section nav, form card, filters, data table, status badges |
| `accounting-chart-of-accounts` | Accounting | The widest migrated `DataTable`: seven columns, tree indentation, two badge kinds, row actions |
| `accounting-expenses` | Accounting | A migrated register below a form — money column, `—` fallbacks, totals footer |
| `accounting-receivables` | Accounting | Tab bar above a migrated table with an in-row action link |
| `crm-overview` | CRM | KPI tiles, section cards |
| `crm-deals` | CRM | Pipeline columns on the shared card skin |
| `growth-overview` | Growth and Marketing | KPI tiles |
| `growth-customers` | Growth and Marketing | Migrated data table |
| `websites-cms` | Website Management (Eshobe CMS) | Manager landing, stacked cards |
| `websites-wp` | Website Management (WP/Woo) | The peer manager — deliberately its own screen, not the CMS's |
| `settings-business` | Settings | Section nav, stacked form cards, selected money-unit control |

The last three were added *after* the table migration, and the reason is worth
keeping: the eleven screens above them all passed that migration byte-identical
— not because nothing changed, but because **not one of them rendered a
migrated table**. A green run over screens that do not include the code under
test is not evidence. When you change a surface, check it is actually in
`SCREENS` before reporting a pass, and open the PNG to check it is not
photographing an empty state.

## Determinism

A flaky snapshot gets ignored, and an ignored check is not a check. So the
harness pins everything that can move:

- **viewport** 1440×900 at DPR 1, set on the browser context;
- **timezone** `Asia/Tehran` and **locale** `fa-IR`, so Jalali dates and Persian
  digits render identically regardless of the machine;
- **`prefers-reduced-motion: reduce`** — the app honours this globally, which
  parks every transition, skeleton shimmer and staggered entry at its final
  frame instead of photographing it mid-animation;
- **seeded demo data** (`npm run db:seed`), never production data;
- **waits for the loaded state**: every data region in this app renders an
  `aria-busy="true"` skeleton while fetching, so the harness waits for those to
  clear, then for `document.fonts.ready` (Vazirmatn reflows text if it is early).

Per-pixel tolerance is 0.5% of pixels, with a per-channel threshold of 64/255 and
a symmetric two-pixel neighbourhood check. That absorbs CI font antialiasing and
sub-pixel glyph shifts while still failing on real structural changes — a wrong
colour, missing content, or a shifted card moves whole percent, not tenths.
(0.3% held until 2026-09-20, when a runner-side library update pushed the
untouched, densest-text screen `crm-deals` to 0.36% — measured while the same
commit rendered byte-identical under the baseline-recording Chromium. 0.5%
clears the measured noise ceiling without approaching the structural floor; see
the comment on `MAX_DIFF_RATIO`. A failure between 0.3% and 0.5% deserves its
diff image opened before assuming either way.)

## Reviewing a failure — read this before touching a baseline

When the job fails it writes `docs/design/visual/__diff__/<id>.actual.png` and
`<id>.diff.png` (changed pixels in red) and uploads them as a CI artifact.

**A diff is either a bug you introduced or a design change you can describe.**

1. Open the diff image. Find *what* moved.
2. If it is a regression — fix the code. Do not touch the baseline.
3. If it is an intended design change — say so in the pull request body, in
   words: which screens change, what changes about them, and why. Then
   re-record with `npm run test:visual:update`, and **commit the new images as
   part of that same reviewed change** so a human sees the before and after
   side by side in the diff.

**Never run `--update` to make a red run go green.** A baseline is an approval,
not a cache. Re-recording without reading the diff silently converts a
regression into the new normal, which is exactly the failure mode this check
exists to prevent.

## Framing: the `anchor` option

A screen entry may carry `anchor: "<css selector>"`, which scrolls that element
to the top of the viewport before the shot. `accounting-chart-of-accounts` and
`accounting-expenses` use it: both registers sit under an entry form, so the
default viewport frames the form and one row of the table the baseline exists to
protect. The harness throws if the
selector matches nothing, rather than silently recording the unscrolled frame.

## Adding a screen

Add an entry to `SCREENS` in `scripts/visual-regression.mjs`, run
`npm run test:visual` once to record it, look at the resulting PNG, and commit
it with the change. Prefer screens that are the canonical example of a shared
pattern over screens that merely look good. Keep the list short: this check is
valuable in proportion to how seriously each failure is taken, and a
fifty-screen suite trains people to skim.

## How the harness avoids flake (and how that was verified)

A visual check that fails at random gets ignored, and an ignored check is worse
than none — it costs CI minutes and teaches people to re-record. Four things
were wrong in the first draft, each found by running the suite rather than by
reading it:

1. **`networkidle` never fires.** The app holds an open WebSocket for live sync,
   so every navigation timed out. The harness waits for `domcontentloaded` and
   then for the app's own readiness signals.
2. **`aria-busy` is not enough.** Only *standalone* skeletons set it; a
   `KpiRowSkeleton` composed inside a larger fallback deliberately omits it, so
   a screen could be mid-load with no busy attribute anywhere. The wait also
   requires zero `[data-slot="skeleton"]` nodes, which every skeleton carries.
3. **Loaded is not settled.** A screen whose data arrives in two waves passes
   the condition above during the gap. The harness then waits for the DOM to
   stop changing across three consecutive polls.
4. **The dev server compiles on demand.** Baselines must be recorded against a
   production build; `next dev` races a webpack compile on first visit to each
   route and photographs a half-rendered page.

Before (1)–(4), a 5-run loop produced two failures with diffs up to 42%. After,
**8 consecutive runs passed with zero diffs**. If you change the wait logic,
re-run that loop; one green run proves nothing.

## Deterministic data

`npm run db:seed` seeds only enough to log in, so every table photographs as its
empty state — a baseline that cannot catch a regression in how a row, an amount
or a badge renders. `npm run db:seed:visual` adds a fixed cast on top: four
accounts with two balanced journal entries, three stock items, three parties and
three CRM deals, plus three expenses and two receivable-raising cheques.

Those last two groups were added when the three ledger baselines were recorded:
both `accounting-expenses` and `accounting-receivables` first photographed their
empty states. Note that A/R balances are *derived* — `listCustomerBalances` sums
journal lines on the `1200` account and attributes each to a party through the
order, receipt or cheque its entry came from — so seeding a party is not enough;
the fixture posts a cheque and its journal entry.

Every value in that fixture is hard-coded. No `Math.random`, no `new Date()`, no
faker — a fixture that varies produces a baseline that disagrees with itself on
the next run. It is idempotent (keyed on natural keys), so running it twice
before a re-record does not double the data.

## The browser — the one thing most likely to break this

**Baselines are only comparable within a single Chromium major.** Text
rasterisation changes between majors, so the wrong browser reddens every screen
at once and the diff images are useless ("everything changed" tells you
nothing).

This is not hypothetical; it is what made the first CI run fail. Baselines had
been recorded locally with Chromium 153 while CI installed the Chromium pinned
by `playwright@1.56.0`, which is **141.0.7390.37**. Three different Chromiums
are reachable from this repository:

| Source | Chromium | Used for |
| --- | --- | --- |
| `playwright` (devDependency, pinned `1.56.0`) | **141.0.7390.37** | **the visual baselines** |
| `playwright-core` (runtime dependency, `^1.61.1`) | 149.x | PDF and receipt rendering — *not* visual tests |
| whatever a sandbox can obtain locally | anything | nothing, unless it matches 141 |

Two guards keep those apart:

1. **`playwright` is pinned to an exact version**, not `^1.56.0`. A caret there
   would let a `npm ci` months from now install a different Chromium and redden
   the suite for no reason anyone could see.
2. **The harness checks the browser it launched** and refuses to run —
   including with `--update` — if the major does not match
   `EXPECTED_CHROMIUM_VERSION`. It is deliberately impossible to *record* a
   baseline from the wrong browser, because that failure is invisible until CI
   disagrees.

`playwright-core` pins a different Chromium and that is fine: it is a real
runtime dependency for printing, nothing visual is recorded with it, and the
version check names what it wants rather than trusting whatever launched.

**If you upgrade `playwright`,** every baseline must be re-recorded in the same
commit and `EXPECTED_CHROMIUM_VERSION` updated to match. Say so in the PR — that
is a deliberate, reviewable re-record, not a silently accepted diff.

### Recording outside CI

If you cannot reach Playwright's CDN, set `VISUAL_CHROMIUM_PATH` to a Chromium
you obtained another way — but it must be the **same major**, or the check above
will stop you. (`@sparticuz/chromium@141.0.0` on npm is one such source, and is
how the committed baselines were produced.)

## Focused local review (without weakening CI)

For an already-inspected, intended change, select only the affected screens:

```sh
npm run test:visual -- --screens=accounting-receivables,accounting-expenses
npm run test:visual:update -- --screens=accounting-receivables
```

The selection is local-only: CI rejects `--screens`, and commands without it
still run the complete suite. Unknown/empty screen names fail rather than
silently skipping coverage. This avoids recording unrelated baselines during a
review. All browser, viewport, locale, loaded-state, comparison and tolerance
rules above remain unchanged. Local development captures are diagnostic evidence;
only the exact-head production CI comparison can establish that they also match
production rendering.

`npm run test:a11y:subledger` checks the seeded receivables surface with the same
Chromium major and locale, in light/dark at 1440 and 390 pixels. It requests a
one-row window from the real API to exercise pagination in the two-customer
fixture, tests keyboard entry/exit and focus containment/restoration, and runs
axe WCAG A/AA checks on search/summary/paging, statement and journal detail.
Actual violations fail. For axe's indeterminate transparent-cell contrast in
stacked mobile dialogs, it additionally measures rendered foreground/opaque
background colors, verifies text is not occluded, and requires at least 4.5:1;
unsupported compositing fails rather than being waived. Raw indeterminate
results and direct measurements remain in the log. Set `A11Y_SCREENSHOT_DIR`
locally to retain review screenshots. This focused audit is not a claim of
whole-application WCAG conformance.
