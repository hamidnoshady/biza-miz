# Depreciation methods and projected schedules (issue #1325)

The fixed-asset register supports three accountant-selected methods. Straight-line
is the default and its arithmetic is unchanged from before this feature; existing
assets keep `straight_line` through the additive migration, so their historical and
future amounts are identical.

The chosen method is stored on the asset and snapshotted on every posted
depreciation row. A change is **prospective**: it is recorded in the effective-dated
estimate history, posted history is never rewritten, and the projected schedule is
recomputed from the change forward.

## Straight line

```
monthly charge = round((cost − residual value) ÷ useful life in months)
```

The last open month of the schedule absorbs the rounding remainder, so the lifetime
total is exactly `cost − residual value`.

Example: 1,200,000 Rial, no residual, 12 months → 100,000 per month.

## Declining balance

An explicit **annual** rate (stored in basis points, so 2500 = 25% p.a.) is charged
against the opening carrying amount, one twelfth per month:

```
declining charge = opening carrying amount × annual rate ÷ 12
```

Two documented switch policies:

- **`none`** — the declining charge is used for every month. The final month of the
  schedule still absorbs whatever is left, so the asset lands exactly on the residual
  value by the end of its useful life. This is a schedule close-out, not a mid-life
  method change.
- **`straight_line`** — from the first month in which straight-line over the
  remaining scheduled months (on the remaining carrying amount above the residual
  value) is at least the declining charge, the larger straight-line amount is
  charged instead:

```
remaining months = this month … the schedule's last month (inclusive)
SL charge        = (opening carrying − residual) ÷ remaining months
charge           = round(max(declining charge, SL charge))
```

Example: 1,200,000 Rial, no residual, 12 months, 25% p.a., same-month posting →
1,200,000 × 25% ÷ 12 = **25,000**. A catch-up posting for the second month with the
first month already posted opens at 1,175,000 → **24,479** (rounded).

No method can take the carrying amount below the residual value or the lifetime
total above `cost − residual value`; both are enforced in the pure planner and
again by the row lock plus the journal service.

## Units of production

The accountant approves a **total lifetime capacity** (a positive whole number) and
a unit label (`عدد`, `کیلوگرم`, `ساعت کارکرد`, …). Each posting supplies the actual
production for its period:

```
per-unit rate = (cost − final residual value) ÷ approved total capacity
charge        = round(period units × per-unit rate)
```

Rules:

- A period with **zero** production charges nothing and is refused as a posting
  (`fully_depreciated`) rather than silently creating a zero-value journal.
- Cumulative production **above** approved capacity is refused
  (`production_exceeds_capacity`); revise capacity with a prospective estimate
  change first.
- The month in which cumulative production reaches capacity absorbs the per-unit
  rounding remainder exactly.
- A schedule whose life ends before capacity is exhausted leaves a carrying amount
  above the residual value; that is an estimate to revise, not a rounding leftover.

Example: 1,000,000 Rial, no residual, capacity 1,000 units → 1,000 Rial per unit.
250 units in a month → **250,000**.

## Projected schedules

The asset-level and portfolio schedules list one row per Jalali month from the
in-service month to the schedule's end (or an earlier horizon):

| Column | Meaning |
| --- | --- |
| opening carrying amount | cost − accumulated depreciation before the month |
| period depreciation | the posted amount (posted rows) or the method's projection (forecast rows) |
| accumulated depreciation | running total after the month |
| closing carrying amount | cost − accumulated after the month |
| remaining depreciable base | `max(0, cost − residual − accumulated)` |

Every row is labelled **posted** or **forecast**:

- **posted** rows are the register's live (non-reversed) depreciation rows and their
  real journal entries;
- **forecast** rows are pure arithmetic. They never create a journal entry, are not
  read by the ledger, and cannot affect the trial balance or financial statements;
- a past month without a posting is shown as a forecast (unposted), not invented as
  history.

Units-of-production forecasts use the remaining approved capacity spread evenly
over the remaining scheduled months unless actual planned production is supplied.
Reversing a posting removes it from the posted rows and restores the schedule, as
the posting path already does.

Exports include the same projection as a dedicated sheet, alongside the register,
posted schedule, remaining schedule, disposals, transfers, estimate changes and the
move report.
