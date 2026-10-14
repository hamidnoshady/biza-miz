import { NextRequest, NextResponse } from "next/server";
import { requirePermission, withTenantScope } from "@/lib/auth";
import { PERMISSIONS } from "@/lib/permissions";
import { buildDraftTestPrint } from "@/lib/printing/render-service";
import { isPaperKey } from "@/lib/print-template";
import { paperAllowedForPurpose } from "@/lib/printing/routing";
import { isPrinterPurpose } from "@/lib/printing/types";

/**
 * The add-printer wizard's «چاپ آزمایشی» for a printer that is not saved yet:
 * the server renders the canonical sample document for the chosen purpose and
 * paper through the same template pipeline a saved printer uses, and the
 * browser delivers it locally to the target the operator picked.
 *
 * No hardware address is sent here — rendering never needs one — and only
 * settings-managing roles may ask for it. The purpose/paper pair is validated
 * with the same matrix the write boundary uses, so the wizard cannot test a
 * combination it would refuse to save.
 */
export const runtime = "nodejs";

export const POST = withTenantScope(async (request: NextRequest) => {
  const { error } = await requirePermission(PERMISSIONS.settingsManage);
  if (error) return error;

  let body: { purpose?: unknown; kind?: unknown; paper?: unknown; paperWidthMm?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const purpose = isPrinterPurpose(body.purpose) ? body.purpose : isPrinterPurpose(body.kind) ? body.kind : null;
  // `paperWidthMm` is the pre-unification spelling of the same choice.
  const paper = isPaperKey(body.paper)
    ? body.paper
    : Number(body.paperWidthMm) === 58
      ? "thermal58"
      : Number(body.paperWidthMm) === 80
        ? "thermal80"
        : null;
  if (!purpose || !paper || !paperAllowedForPurpose(purpose, paper)) {
    return NextResponse.json({ ok: false, error: "incompatible_printer" }, { status: 400 });
  }

  try {
    const prepared = await buildDraftTestPrint(purpose, paper);
    return NextResponse.json({
      ok: true,
      delivery: prepared.delivery,
      dataBase64: Buffer.from(prepared.bytes).toString("base64"),
    });
  } catch (err) {
    console.error("draft test render failed", err);
    return NextResponse.json({ ok: false, error: "render_failed" }, { status: 502 });
  }
});
