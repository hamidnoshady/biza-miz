// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MoneyProvider } from "@/components/money/money-context";
import { toPersianDigits } from "@/lib/digits";
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
    const onChanged=vi.fn();
    const writes=stub([row()]);render(<AgencyVendorPurchases projectId="project" canManage={false} canBook onChanged={onChanged}/>);
    const button=await screen.findByRole("button",{name:"ثبت هزینه در پرداختنی"});
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("تاریخ وقوع هزینه برای ثبت پرداختنی"),{target:{value:"2026-10-06"}});
    await userEvent.click(button);
    await waitFor(()=>expect(writes).toEqual([{ url:"/api/agency/vendor-purchases/p1",body:{action:"book",spentOn:"2026-10-06"} }]));
    expect(onChanged).toHaveBeenCalledTimes(1);
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
  it("does not offer cancellation without its independently resolved approval capability",async()=>{
    stub([row()]);render(<AgencyVendorPurchases projectId="project" canManage canBook/>);
    await screen.findByText("Q-123");
    expect(screen.queryByRole("button",{name:"لغو خرید تأییدشده"})).toBeNull();
  });
  it("requires a reason and explicit confirmation, then refreshes the financial report",async()=>{
    const writes=stub([row()]),onChanged=vi.fn();
    render(<AgencyVendorPurchases projectId="project" canManage={false} canBook={false} canCancel onChanged={onChanged}/>);
    await userEvent.click(await screen.findByRole("button",{name:"لغو خرید تأییدشده"}));
    const confirm=screen.getByRole("button",{name:"تأیید لغو خرید ثبت‌نشده"});
    expect((confirm as HTMLButtonElement).disabled).toBe(true);expect(writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("دلیل لغو خرید"),{target:{value:"توقف همکاری با فروشنده"}});
    await userEvent.click(confirm);
    await waitFor(()=>expect(onChanged).toHaveBeenCalledTimes(1));
    expect(writes).toEqual([{url:"/api/agency/vendor-purchases/p1",body:{action:"cancel",reason:"توقف همکاری با فروشنده"}}]);
  });
  it("keeps cancelled history visible and offers no cancellation or booking for closed purchases",async()=>{
    stub([{...row("cancelled"),cancellation_reason:"انصراف فروشنده",cancelled_by_name:"مدیر",cancelled_at:"2026-10-06T12:00:00Z"},row("booked","p2")]);
    render(<AgencyVendorPurchases projectId="project" canManage canBook canCancel/>);
    await screen.findByText("لغوشده پیش از ثبت حسابداری");
    expect(screen.getByText(/انصراف فروشنده/).textContent).toContain("مدیر");
    expect(screen.queryByRole("button",{name:"لغو خرید تأییدشده"})).toBeNull();
    expect(screen.queryByRole("button",{name:"ثبت هزینه در پرداختنی"})).toBeNull();
  });

  it("keeps exact page totals above safe integer range and excludes cancelled amounts",async()=>{
    stub([{...row(),amount_rial:"9000000000000000"},{...row("approved","p2"),amount_rial:"8999999999999999"},{...row("cancelled","p3"),amount_rial:"999"}]);
    render(<MoneyProvider unit="rial"><AgencyVendorPurchases projectId="project" canManage={false} canBook={false}/></MoneyProvider>);
    await screen.findByText(/تعهد تأییدشدهٔ ثبت‌نشده/);
    expect(screen.getByText(/تعهد تأییدشدهٔ ثبت‌نشده/).textContent).toContain(toPersianDigits("17٬999٬999٬999٬999٬999"));
  });
  it("retains the entered reason and does not invalidate the report when cancellation is refused",async()=>{
    const onChanged=vi.fn();
    vi.stubGlobal("fetch",vi.fn(async(_url:string,init?:RequestInit)=>new Response(JSON.stringify(init?.method==="POST"?{error:"invalid_purchase_state"}:{purchases:[row()]}),{status:init?.method==="POST"?409:200})));
    render(<AgencyVendorPurchases projectId="project" canManage={false} canBook={false} canCancel onChanged={onChanged}/>);
    await userEvent.click(await screen.findByRole("button",{name:"لغو خرید تأییدشده"}));
    fireEvent.change(screen.getByLabelText("دلیل لغو خرید"),{target:{value:"انصراف"}});
    await userEvent.click(screen.getByRole("button",{name:"تأیید لغو خرید ثبت‌نشده"}));
    await screen.findByText(/عملیات انجام نشد/);
    expect(onChanged).not.toHaveBeenCalled();
    expect((screen.getByLabelText("دلیل لغو خرید") as HTMLTextAreaElement).value).toBe("انصراف");
  });

});
