import { NextRequest, NextResponse } from "next/server";
import { withTenantScope } from "@/lib/auth";
import {
  acknowledgeTransmittal,
  issueTransmittal,
  transmittalProjectId,
} from "@/lib/aec-doc-service";
import { requireProjectCapability } from "@/lib/workspace";
import { PERMISSIONS, aecOwner, handleAecError, readBody } from "../../../guard";

const ACTIONS = ["issue", "acknowledge"] as const;
type Action = (typeof ACTIONS)[number];

/**
 * The two acts that move a transmittal (issue #799 §12).
 *
 * Two permissions, deliberately not one — §24's rule that an irreversible act
 * must not inherit ordinary project access:
 *
 *   * `issue` is the formal act: it freezes the transmittal, issues the
 *     revisions it carries and supersedes the ones they replace. It needs
 *     `workspace.documents_issue`, a key no preset below manager holds.
 *   * `acknowledge` records that somebody outside signed for a document they
 *     were sent. It is a receipt, not a decision — `workspace.manage` and the
 *     project role are enough, and the transmittal itself flips to
 *     `acknowledged` on the last required signature.
 *
 * The action decides which of the two the guard asks for, so the permission is
 * resolved in one place: `aecOwner` is called with the key the action needs and
 * the body is validated first, because a request that names no known action has
 * no permission to check yet. Both also pass the project-role check, so a
 * document controller of one project cannot issue another project's drawings.
 */
export const POST = withTenantScope(
  async (request: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const { id } = await context.params;
    const body = await readBody(request);
    const action = String(body.action ?? "") as Action;
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }

    const needed =
      action === "issue" ? PERMISSIONS.workspaceDocumentsIssue : PERMISSIONS.workspaceManage;
    const { owner, error } = await aecOwner(needed);
    if (error) return error;

    try {
      const projectId = await transmittalProjectId(owner.businessId, id);
      await requireProjectCapability(owner, projectId, "manage", true);
      if (action === "issue") {
        return NextResponse.json({ transmittal: await issueTransmittal(owner, id) });
      }
      return NextResponse.json({
        transmittal: await acknowledgeTransmittal(owner, id, body),
      });
    } catch (err) {
      return handleAecError(err);
    }
  },
);
