// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ApprovalsSection } from "./approvals-section";

vi.mock("./workspace-entity-drawer", () => ({ WorkspaceEntityDrawer: () => null }));
vi.mock("./use-paged-list", () => ({ usePagedList: () => ({
  rows: [{ id:"approval",subjectType:"vendor_purchase",subjectId:"quote",subjectTitle:"VP-001 — خرید رسانه",projectId:"project",projectName:"کمپین",
    title:"خرید",status:"pending",requestedByName:"مدیر",approverName:null,dueDate:null,note:"",requestedByMe:false,assignedToMe:false,canDecideUnassigned:true }],
  page:{ total:1,offset:0,limit:50,hasMore:false },summary:{total:1,pending:1,approved:0,overdue:0},error:"",loadingMore:false,reload:()=>{},loadMore:()=>{},
}) }));
afterEach(cleanup);
it("links a vendor approval to the scoped project quote, not an unsupported generic entity drawer", () => {
  render(<ApprovalsSection canApprove/>);
  expect(screen.getByRole("link",{ name:"VP-001 — خرید رسانه" }).getAttribute("href")).toBe("/workspace/projects/project?tab=finance#vendor-purchase-quote");
});
