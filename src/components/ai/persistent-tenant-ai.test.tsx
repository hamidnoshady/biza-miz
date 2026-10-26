// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PersistentTenantAiProvider, TenantAiIdentity, usePersistentTenantAiChat } from "./persistent-tenant-ai";
let pathname = "/dashboard";
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
let chat: ReturnType<typeof usePersistentTenantAiChat>;
function Probe() { chat = usePersistentTenantAiChat(); return null; }
const view = (account: string) => <PersistentTenantAiProvider><TenantAiIdentity account={account} /><Probe /></PersistentTenantAiProvider>;
afterEach(() => { cleanup(); vi.unstubAllGlobals(); pathname = "/dashboard"; });
describe("tenant workspace persistence", () => {
  it("keeps the same stream, draft, task and response mode when the route changes", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, body: new ReadableStream<Uint8Array>({ start(controller) { stream = controller; } }) })));
    const ui = render(view("business-a:user-a"));
    act(() => { chat!.setRuntimeMode("thinking"); chat!.setTask("sales"); chat!.setInput("متن"); });
    let pending!: Promise<void>;
    await act(async () => { pending = chat!.sendMessage(); });
    pathname = "/accounting/overview";
    ui.rerender(view("business-a:user-a"));
    expect(chat!.busy).toBe(true);
    expect(chat!.runtimeMode).toBe("thinking");
    expect(chat!.task).toBe("sales");
    await act(async () => {
      stream.enqueue(new TextEncoder().encode('event: done\ndata: {"content":"پاسخ","conversationId":"conv-a"}\n\n'));
      stream.close(); await pending;
    });
    expect(chat!.conversationId).toBe("conv-a");
    expect(chat!.messages.at(-1)?.content).toBe("پاسخ");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("clears the previous tenant's draft and task context when the account changes", () => {
    const ui = render(view("business-a:user-a"));
    act(() => { chat!.setCustomTask("private instruction"); chat!.setRuntimeMode("thinking"); chat!.setInput("private draft"); });
    ui.rerender(view("business-b:user-b"));
    expect(chat!.input).toBe("");
    expect(chat!.customTask).toBe("");
    expect(chat!.runtimeMode).toBe("auto");
    expect(chat!.conversationId).toBeNull();
  });
});
