// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgencyVendorPurchases } from "./agency-vendor-purchases";

vi.mock("@/app/(app)/crm/customer-search", () => ({ CustomerSearchField: ({ onPick }: { onPick: (c: {id:string;name:string}) => void }) => <button type="button" onClick={() => onPick({ id:"client",name:"کارفرما" })}>انتخاب کارفرما</button> }));
vi.mock("@/app/(app)/accounting/supplier-party-picker", () => ({ SupplierPartyPicker: ({ onPick }: { onPick: (id:string,name:string) => void }) => <button type="button" onClick={() => onPick("supplier","رسانه")}>انتخاب فروشنده</button> }));
vi.mock("@/app/dashboard/jalali-date-picker", () => ({ JalaliDatePicker: ({ value, onChange, ariaLabel }: {value:string;onChange:(v:string)=>void;ariaLabel:string}) => <input aria-label={ariaLabel} value={value} onChange={e=>onChange(e.target.value)} /> }));
const row=(status="approved",id="p1") => ({id,client_name:"کارفرمای فعلی",vendor_name:"تأمین‌کنندهٔ فعلی",purchase_number:"VP-001",quote_reference:"Q-123",description:"خرید رسانه",amount_rial:"5000000",quoted_on:"2026-10-05",status,cost_id:status==="booked"?"c1":null});
function stub(rows: unknown[]=[]) {
  const writes: {url:string;body:Record<string,unknown>}[]=[];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if(init?.method === "POST") { writes.push({ url:String(url), body:JSON.parse(String(init.body)) }); return new Response(JSON.stringify({ costId:"c1" }),{status:200}); }
    return new Response(JSON.stringify({ purchases:rows }),{status:200});
  }));
  return writes;
}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe("project vendor purchase card",()=>{
  it("is read-only without management and finance capabilities; approval is not a purchase shortcut",async()=>{
    stub([row()]);render(<AgencyVendorPurchases projectId="project" canManage={false} canBook={false}/>);
    await screen.findByText("Q-123");
    expect(screen.getByText("تأمین‌کنندهٔ فعلی")).toBeTruthy();
    expect(screen.getByText("کارفرمای فعلی")).toBeTruthy();
    expect(screen.queryByRole("button",{name:"ثبت هزینه در پرداختنی"})).toBeNull();
    expect(screen.queryByRole("button",{name:"ثبت پیش‌نویس پیشنهاد فروشنده"})).toBeNull();
    expect(screen.getByRole("link",{name:"صف تأییدهای مشترک"}).getAttribute("href")).toBe("/workspace/approvals");
    expect(screen.queryByRole("button",{name:"تأیید خرید"})).toBeNull();
  });
  it("requires an explicit occurrence date and sends only book, never approve or a presentation guess",async()=>{
    const writes=stub([row()]);render(<AgencyVendorPurchases projectId="project" canManage={false} canBook/>);
    const button=await screen.findByRole("button",{name:"ثبت هزینه در پرداختنی"});
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("تاریخ وقوع هزینه برای ثبت پرداختنی"),{target:{value:"2026-10-06"}});
    await userEvent.click(button);
    await waitFor(()=>expect(writes).toEqual([{ url:"/api/agency/vendor-purchases/p1",body:{action:"book",spentOn:"2026-10-06"} }]));
  });
  it("creates a project-bound canonical quote in rial using the business's display unit",async()=>{
    const writes=stub();render(<AgencyVendorPurchases projectId="project" canManage canBook={false}/>);
    await userEvent.click(await screen.findByRole("button",{name:"انتخاب کارفرما"}));
    await userEvent.click(screen.getByRole("button",{name:"انتخاب فروشنده"}));
    fireEvent.change(screen.getByLabelText("مرجع پیشنهاد فروشنده"),{target:{value:"Q-123"}});
    fireEvent.change(screen.getByLabelText("شرح خرید"),{target:{value:"خرید رسانه"}});
    fireEvent.change(screen.getByLabelText(/مبلغ کل پیشنهاد/),{target:{value:"۵۰۰٬۰۰۰"}});
    fireEvent.change(screen.getByLabelText("تاریخ پیشنهاد فروشنده"),{target:{value:"2026-10-05"}});
    await userEvent.click(screen.getByRole("button",{name:"ثبت پیش‌نویس پیشنهاد فروشنده"}));
    await waitFor(()=>expect(writes).toHaveLength(1));
    expect(writes[0].body).toEqual({projectId:"project",partyId:"client",vendorPartyId:"supplier",description:"خرید رسانه",quoteReference:"Q-123",amountRial:5000000,quotedOn:"2026-10-05"});
  });
  it("never presents a booked cost as a second commitment or offers another booking button",async()=>{
    stub([row("booked")]);render(<AgencyVendorPurchases projectId="project" canManage={false} canBook/>);
    await screen.findByText("Q-123");
    expect(screen.queryByRole("button",{name:"ثبت هزینه در پرداختنی"})).toBeNull();
    expect(screen.getByText(/تعهد تأییدشدهٔ ثبت‌نشده/).textContent).toContain("۰ تومان");
  });
});
