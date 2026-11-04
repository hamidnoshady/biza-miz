import { LIFECYCLE_STAGES, type LifecycleStage } from "@/lib/crm-scoring";
import { formatPersianNumber } from "@/lib/digits";

/**
 * Keep the Persian lifecycle name distinct from the recommendation and the
 * numeric total. Inline text previously made separate words look joined at
 * narrow widths, especially when Persian and monetary text shared a row.
 */
export function CrmLifecycleRow({
  stage,
  count,
  amountLabel,
}: {
  stage: string;
  count: number;
  amountLabel: string;
}) {
  const meta = LIFECYCLE_STAGES[stage as LifecycleStage];

  return (
    <li className="flex flex-col gap-1.5 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1" lang="fa" dir="rtl">
        <strong className="block text-sm font-semibold leading-7 text-foreground">
          {meta?.label ?? stage}
        </strong>
        {meta?.action ? (
          <p className="mt-0.5 text-sm leading-6 text-muted-foreground">{meta.action}</p>
        ) : null}
      </div>
      <span
        className="block max-w-full shrink-0 break-words text-sm leading-6 tabular-nums text-muted-foreground sm:max-w-[40%] sm:pt-0.5"
        dir="rtl"
      >
        {formatPersianNumber(count)} نفر <span aria-hidden="true">·</span>{" "}
        <bdi dir="auto">{amountLabel}</bdi>
      </span>
    </li>
  );
}
