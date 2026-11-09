// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
import { AgencyBillingCard } from "./agency-billing-panel";

function payload(amount = "5000000", count = 1) {
  return { commercial: { engagement: { customerName:"کارفرما",title:"قرارداد" },milestones:[],changeRequests:[],schedule:{count:0,unallocatedPercent:100},
    report:{ commitments:{approvedVendorPurchaseRial:amount,approvedVendorPurchaseCount:count},
      booked:{contractedRial:10000000,approvedChangeRial:0,revisedContractRial:10000000,invoicedRial:0,scheduledRial:0,unscheduledRial:10000000},
      posted:{revenueRial:10000000,collectedRial:0,receivableRial:10000000,actualCostRial:2000000},grossMarginRial:8000000,grossMarginPercent:80,
      passThrough:{spentRial:0,rechargedRial:0,unrechargedRial:0},hours:{contractedHours:null,actualHours:null,revenuePerContractedHourRial:null},
    } },lookups:{bases:[],kinds:[],revenueAccounts:[]} };
}
const figure = (label: string) => screen.getByText(label).parentElement?.querySelector("dd")?.textContent;
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe("commitment-aware project P&L",()=>{
  it("labels whole-project commitments separately and never subtracts them from the served posted margin",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(payload()),{status:200})));
    render(<MoneyProvider unit="rial"><AgencyBillingCard projectId="project" canManage={false} canApprove={false}/></MoneyProvider>);
    await screen.findByText("تعهد خرید — هنوز ثبت حسابداری نشده");
    expect(figure("خریدهای تأییدشدهٔ ثبت‌نشده")).toBe(toPersianDigits("5٬000٬000 ریال"));
    expect(figure("تعداد خریدهای متعهدشده")).toBe("۱");
    expect(figure("حاشیهٔ ناویژه")).toContain(toPersianDigits("8٬000٬000"));
    expect(screen.getByText(/کل پروژه؛ بدون محدودیت/)).toBeTruthy();
    expect(screen.queryByRole("button",{name:"ثبت هزینه در پرداختنی"})).toBeNull();
  });
  it("refreshes after a purchase change without remounting the financial card",async()=>{
    const fetchMock=vi.fn(async()=>new Response(JSON.stringify(payload()),{status:200}));vi.stubGlobal("fetch",fetchMock);
    const {rerender}=render(<AgencyBillingCard projectId="project" canManage={false} canApprove={false} refreshRevision={0}/>);
    await screen.findByText("تعهد خرید — هنوز ثبت حسابداری نشده");
    fetchMock.mockImplementation(async()=>new Response(JSON.stringify(payload("0",0)),{status:200}));
    rerender(<AgencyBillingCard projectId="project" canManage={false} canApprove={false} refreshRevision={1}/>);
    await waitFor(()=>expect(figure("تعداد خریدهای متعهدشده")).toBe("۰"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("renders decimal-text totals exactly even above safe integer range",async()=>{
    vi.stubGlobal("fetch",vi.fn(async()=>new Response(JSON.stringify(payload("17999999999999999",2)),{status:200})));
    render(<MoneyProvider unit="rial"><AgencyBillingCard projectId="project" canManage={false} canApprove={false}/></MoneyProvider>);
    await screen.findByText("تعهد خرید — هنوز ثبت حسابداری نشده");
    expect(figure("خریدهای تأییدشدهٔ ثبت‌نشده")).toBe(toPersianDigits("17٬999٬999٬999٬999٬999 ریال"));
  });
});
