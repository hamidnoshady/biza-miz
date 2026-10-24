import { NextRequest, NextResponse } from "next/server";
import { requirePlatformCapability, withPlatformScope } from "@/lib/platform-auth";
import { getMediaConfig } from "@/lib/media-service";
import { logMediaFailureRecord, mediaRequestId } from "@/lib/media-errors";
import { runMediaStorageHealthCheck } from "@/lib/media-storage-health";

/**
 * «آزمایش اتصال» — issue #1080.
 *
 * The check ALWAYS runs against the saved `platform_media_config` row: the same
 * record every tenant upload reads. An unsaved draft on the console is not
 * tested (that would report on a deployment state no tenant can reach), so the
 * console tells the operator to save first and the response says so explicitly
 * with `testedSavedConfiguration`.
 *
 * What is verified — in this order, and each one is shown to the operator:
 *   1. the saved configuration is complete and the library is enabled;
 *   2. a >1 MiB probe can be spooled to the server's temp directory;
 *   3. a small buffered write under a tenant-shaped key succeeds;
 *   4. it reads back byte-identical (SHA-256) and HEAD reports its size;
 *   5. the same key shape sent as a disk-streamed upload (`s3PutFile`) succeeds;
 *   6. that streamed object reads back byte-identical;
 *   7. both probes are deleted AND a HEAD confirms they are gone.
 *
 * Step 7 is part of the verdict, not a courtesy: a deployment that cannot delete
 * objects cannot clean up after a failed upload either. No tenant media record
 * is created or modified at any point.
 */
export const POST = withPlatformScope(async (request: NextRequest) => {
  const { error } = await requirePlatformCapability("media.manage");
  if (error) return error;

  const requestId = mediaRequestId(request?.headers?.get("x-request-id"));
  const startedAt = Date.now();
  const config = await getMediaConfig();

  const result = await runMediaStorageHealthCheck(config);

  if (!result.ok) {
    const failure = result.failure;
    const failedStep = result.steps.find((step) => !step.ok);
    logMediaFailureRecord(
      {
        stage: failure?.stage ?? "unknown",
        code: failure?.code ?? "internal_error",
        status: 502,
        retryable: false,
        providerStatus: failedStep?.providerStatus ?? null,
        providerCode: failedStep?.providerCode ?? null,
        detail: failedStep?.detail ?? failure?.message ?? "",
      },
      {
        operation: "platform.media.health_check",
        scope: "platform",
        requestId,
        durationMs: Date.now() - startedAt,
        extra: {
          failedStep: failedStep?.id ?? null,
          leftoverKeys: result.leftoverKeys.length,
        },
        objectKey: null,
      },
    );
    return NextResponse.json(
      {
        ok: false,
        testedSavedConfiguration: true,
        error: failure?.code ?? "internal_error",
        message: failure?.message ?? "آزمایش اتصال ناموفق بود.",
        reference: requestId,
        // The per-step breakdown is what turns "failed" into an actionable
        // answer: which capability worked and exactly where the chain broke.
        steps: result.steps,
        capabilities: result.capabilities,
        leftoverKeys: result.leftoverKeys,
      },
      { status: 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    testedSavedConfiguration: true,
    message:
      "اتصال سالم است: نوشتن، خواندن با راستی‌آزمایی SHA-256، بارگذاری جریانی بیش از ۱ مگابایت و حذف، هر چهار مورد روی همین پیکربندی ذخیره‌شده با موفقیت آزمایش شد.",
    reference: requestId,
    steps: result.steps,
    capabilities: result.capabilities,
    endpointHost: result.endpointHost,
    bucket: result.bucket,
    keyPrefix: result.keyPrefix,
  });
});
