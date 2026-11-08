// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/components/ui/searchable-select", () => ({
  SearchableSelect: ({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) =>
    <select aria-label="supplier" value={value} onChange={e => onChange(e.target.value)}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>,
}));
import { SupplierPartyPicker } from "./supplier-party-picker";
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("supplier party picker", () => {
  it("queries only the canonical Supplier directory and returns the chosen identity", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ parties: [{ id: "vendor", displayName: "رسانه" }] })));
    vi.stubGlobal("fetch", fetcher); const picked = vi.fn();
    render(<SupplierPartyPicker value="" name="" onPick={picked} />);
    await screen.findByText("رسانه");
    expect(fetcher.mock.calls[0][0]).toBe("/api/parties?role=Supplier&q=&limit=20");
    fireEvent.change(screen.getByLabelText("supplier"), { target: { value: "vendor" } });
    expect(picked).toHaveBeenCalledWith("vendor", "رسانه");
  });
  it("does not invent a party when directory access is refused", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
    vi.stubGlobal("fetch", fetcher); const picked = vi.fn();
    render(<SupplierPartyPicker value="" name="" onPick={picked} />);
    await screen.findByText(/جست‌وجوی تأمین‌کنندگان ممکن نشد/);
    expect(picked).not.toHaveBeenCalled();
    expect((screen.getByLabelText("supplier") as HTMLSelectElement).options).toHaveLength(1);
  });
  it("keeps a selected supplier visible outside the current search page", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ parties: [] })));
    vi.stubGlobal("fetch", fetcher);
    render(<SupplierPartyPicker value="selected" name="انتخاب قبلی" onPick={() => {}} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    expect((screen.getByLabelText("supplier") as HTMLSelectElement).value).toBe("selected");
    expect(screen.getByText("انتخاب قبلی")).toBeTruthy();
  });
});
