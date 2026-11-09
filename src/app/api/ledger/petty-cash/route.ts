import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireMember, withTenantScope } from "@/lib/auth";
import { branchAccessForSession } from "@/lib/automotive-access";
import { ExpenseError } from "@/lib/expense-service";
import { PERMISSIONS } from "@/lib/permissions";
import { MAX_RECEIPT_IMAGE_BYTES } from "@/lib/ai-receipt";
import { hasMatchingMediaSignature } from "@/lib/media";
import { getActiveMediaAssetWithStorageKey, getMediaConfig, isMediaStorageReady, storeMediaAsset, streamMediaObject } from "@/lib/media-service";
import { openMirroredMediaStream } from "@/lib/media-mirror";
import {
  assertCanUploadPettyCashReceipt, canReadPettyCashReceipt, configurePettyCashFund, createPettyCashOperation,
  decidePettyCashExpense, listPettyCashFunds, listPettyCashOperations, pettyCashConfigurationOptions,
  PettyCashError, type PettyCashAccess,
} from "@/lib/petty-cash-service";
import { financialErrorResponse, MalformedBodyError, readJsonObjectBody } from "../financial/support";

async function requestAccess() {
  const { session, membership, error } = await requireMember();
  if (error) return { error, access: null };
  const scope = await branchAccessForSession(session);
  const access: PettyCashAccess = {
    businessId: session.businessId,
    actorId: session.sub,
    role: membership.role,
    locationIds: scope.allowedLocationIds,
    canViewLedger: membership.permissions.has(PERMISSIONS.ledgerView),
    canManage: membership.permissions.has(PERMISSIONS.financeAccountsManage) && membership.permissions.has(PERMISSIONS.financeTransfersManage),
    canApprove: membership.permissions.has(PERMISSIONS.ledgerApprove) && membership.permissions.has(PERMISSIONS.financeExpensesManage),
  };
  return { error: null, access };
}

function errorResponse(err: unknown): NextResponse {
  if (err instanceof PettyCashError || err instanceof ExpenseError) return NextResponse.json({ error: err.message }, { status: err.status });
  if (err instanceof MalformedBodyError) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  return financialErrorResponse(err);
}

async function receiptResponse(request: NextRequest, access: PettyCashAccess, fundId: string, receiptId: string) {
  if (!(await canReadPettyCashReceipt(access, fundId, receiptId))) throw new PettyCashError("receipt_asset_not_found", 404);
  const meta = await getActiveMediaAssetWithStorageKey(access.businessId, receiptId);
  if (!meta) throw new PettyCashError("receipt_asset_not_found", 404);
  const config = await getMediaConfig();
  let body: ReadableStream<Uint8Array> | null = null;
  try {
    if (isMediaStorageReady(config)) {
      body = (await streamMediaObject(access.businessId, meta.storageKey, config, { signal: request.signal }))?.stream ?? null;
    }
    body ??= (await openMirroredMediaStream(access.businessId, receiptId, { signal: request.signal }))?.stream ?? null;
  } catch {
    throw new PettyCashError("storage_error", 502);
  }
  if (!body) throw new PettyCashError("receipt_asset_not_found", 404);
  return new NextResponse(body, {
    headers: {
      "Content-Type": meta.asset.mimeType,
      "Content-Disposition": "inline",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function uploadReceipt(request: NextRequest, access: PettyCashAccess, fundId: string) {
  await assertCanUploadPettyCashReceipt(access, fundId);
  const mimeType = request.headers.get("content-type") ?? "";
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) || !request.body) {
    throw new PettyCashError("petty_cash_receipt_invalid");
  }
  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RECEIPT_IMAGE_BYTES) {
        await reader.cancel();
        throw new PettyCashError("petty_cash_receipt_too_large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  if (!hasMatchingMediaSignature(mimeType, bytes)) throw new PettyCashError("petty_cash_receipt_invalid");
  const config = await getMediaConfig();
  if (!isMediaStorageReady(config)) throw new PettyCashError("storage_error", 503);
  const asset = await storeMediaAsset({
    businessId: access.businessId,
    userId: access.actorId,
    config,
    kind: "image",
    fileName: request.nextUrl.searchParams.get("fileName")?.trim().slice(0, 200) || "receipt",
    mimeType,
    contentType: mimeType,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source: "upload",
  });
  return NextResponse.json({ asset: { id: asset.id, fileName: asset.fileName } }, { status: 201 });
}

export const GET = withTenantScope(async (request: NextRequest) => {
  const { access, error } = await requestAccess();
  if (error) return error;
  try {
    const search = request.nextUrl.searchParams;
    const fundId = search.get("fundId");
    const receiptId = search.get("receipt");
    if (fundId && receiptId) return await receiptResponse(request, access, fundId, receiptId);
    if (fundId) {
      const offset = Number(search.get("offset") ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new PettyCashError("bad_request");
      return NextResponse.json(await listPettyCashOperations(access, fundId, offset));
    }
    const funds = await listPettyCashFunds(access);
    return NextResponse.json({ funds, canManage: access.canManage, ...(await pettyCashConfigurationOptions(access, funds)) });
  } catch (err) {
    return errorResponse(err);
  }
});

export const POST = withTenantScope(async (request: NextRequest) => {
  const { access, error } = await requestAccess();
  if (error) return error;
  try {
    const uploadFund = request.nextUrl.searchParams.get("uploadReceipt");
    if (uploadFund) return await uploadReceipt(request, access, uploadFund);
    const body = await readJsonObjectBody(request);
    if (body.action === "configure") return NextResponse.json({ fund: await configurePettyCashFund(access, body) }, { status: 201 });
    if (typeof body.fundId !== "string") throw new PettyCashError("petty_cash_fund_not_found", 404);
    const key = body.idempotencyKey ?? request.headers.get("idempotency-key");
    const operation = body.action === "approve" || body.action === "reject"
      ? await decidePettyCashExpense(access, body.fundId, body, key)
      : await createPettyCashOperation(access, body.fundId, body, key);
    return NextResponse.json({ operation }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
});
