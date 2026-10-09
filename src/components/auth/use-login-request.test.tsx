// @vitest-environment jsdom
/**
 * Issue #885 L05 — the shared credential-request hook.
 *
 * The defect: both sign-in forms set `busy` and awaited a bare `fetch` with no
 * catch and no finally, so a network rejection left the submit button
 * permanently disabled with no message and no way back short of a reload.
 *
 * That is a *timing* contract — what happens when a request never resolves, or
 * resolves after the caller has moved on — so it cannot be proven by reading
 * the forms. Each case below is a behaviour a form relied on getting wrong.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOGIN_TIMEOUT_MS, networkErrorMessage, useLoginRequest } from "./use-login-request";

/** A response the hook can read a body off, without going near the network. */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Real timers throughout, with short timeouts.
 *
 * Fake timers would be the obvious choice for testing a timeout, but React's
 * own scheduler runs on them, and stubbing them globally leaves
 * `renderHook`'s `result.current` null — the hook never gets to render. A
 * 60ms real timeout is slow enough to be unambiguous and fast enough not to
 * matter, and it exercises the genuine `setTimeout`/`AbortController` path
 * rather than a mocked one.
 */
const SHORT_TIMEOUT_MS = 60;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLoginRequest — busy is always released", () => {
  it("releases it on a normal response", async () => {
    const { result } = renderHook(() => useLoginRequest());

    await act(async () => {
      const outcome = await result.current.send(() =>
        Promise.resolve(jsonResponse(200, { ok: true })),
      );
      expect(outcome).toMatchObject({ stale: false, ok: true, status: 200 });
    });

    expect(result.current.busy).toBe(false);
  });

  it("releases it on an HTTP error", async () => {
    const { result } = renderHook(() => useLoginRequest());

    await act(async () => {
      const outcome = await result.current.send(() =>
        Promise.resolve(jsonResponse(401, { error: "invalid_credentials" })),
      );
      expect(outcome).toMatchObject({ stale: false, ok: false, status: 401 });
    });

    expect(result.current.busy).toBe(false);
  });

  it("releases it when the network rejects — the actual regression", async () => {
    const { result } = renderHook(() => useLoginRequest());

    await act(async () => {
      const outcome = await result.current.send(() =>
        Promise.reject(new TypeError("Failed to fetch")),
      );

      // A rejection is reported, not rethrown: the form's submit handler has no
      // try/catch of its own, which is exactly how `busy` used to get stuck.
      expect(outcome).toMatchObject({
        stale: false,
        ok: false,
        status: 0,
        networkError: "unreachable",
      });
    });

    expect(result.current.busy).toBe(false);
  });

  it("releases it when the response body is not JSON", async () => {
    const { result } = renderHook(() => useLoginRequest());

    await act(async () => {
      const outcome = await result.current.send(() =>
        Promise.resolve(
          new Response("<html>502 from the proxy</html>", {
            status: 502,
            headers: { "Content-Type": "text/html" },
          }),
        ),
      );
      // A proxy error page must not become an unhandled rejection either.
      expect(outcome).toMatchObject({ stale: false, ok: false, status: 502, data: {} });
    });

    expect(result.current.busy).toBe(false);
  });
});

describe("useLoginRequest — a request cannot hang forever", () => {
  it("aborts at the timeout and says so", async () => {
    const { result } = renderHook(() => useLoginRequest(SHORT_TIMEOUT_MS));

    let outcome: unknown;
    await act(async () => {
      // A fetch that only ever settles by being aborted — the shape of a
      // black-holed connection on a flaky local network.
      outcome = await result.current.send(
        (signal) =>
          new Promise<Response>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              const err = new Error("aborted");
              err.name = "AbortError";
              reject(err);
            });
          }),
      );
    });

    expect(outcome).toMatchObject({ stale: false, ok: false, networkError: "timeout" });
    expect(result.current.busy).toBe(false);
  });

  it("hands the caller an abort signal wired to its own timeout", async () => {
    const { result } = renderHook(() => useLoginRequest(SHORT_TIMEOUT_MS));
    const seen: AbortSignal[] = [];

    await act(async () => {
      await result.current.send((signal) => {
        seen.push(signal);
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      });
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].aborted).toBe(true);
  });

  it("defaults to a bounded wait rather than waiting indefinitely", () => {
    expect(DEFAULT_LOGIN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_LOGIN_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("useLoginRequest — a late response cannot overwrite a newer one", () => {
  it("marks a superseded result stale", async () => {
    const { result } = renderHook(() => useLoginRequest());
    const gates: Array<() => void> = [];

    let first: unknown;
    let second: unknown;

    await act(async () => {
      const p1 = result.current
        .send(
          () =>
            new Promise<Response>((resolve) => {
              gates.push(() => resolve(jsonResponse(200, { which: "first" })));
            }),
        )
        .then((o) => {
          first = o;
        });

      // Start a newer request while the first is still outstanding.
      const p2 = result.current
        .send(() => Promise.resolve(jsonResponse(200, { which: "second" })))
        .then((o) => {
          second = o;
        });
      await p2;

      // Now let the older one land.
      gates[0]();
      await p1;
    });

    // This is what makes "cancel and go back" safe on the OTP step, where an
    // in-flight verify used to be able to land after the member had left.
    expect(first).toMatchObject({ stale: true });
    expect(second).toMatchObject({ stale: false, status: 200 });
  });

  it("cancel() releases busy and stale-ifies whatever is in flight", async () => {
    const { result } = renderHook(() => useLoginRequest());
    const gates: Array<() => void> = [];
    let outcome: unknown;

    // Started *outside* `act`, and observed with `waitFor`.
    //
    // Inside an `act` callback React defers flushing until the callback exits,
    // so reading `busy` between the send and the cancel there observes the
    // pre-render value however many ticks are awaited. Observing that
    // intermediate state is the whole point of this test, so it has to happen
    // outside.
    const pending = result.current
      .send(
        () =>
          new Promise<Response>((resolve) => {
            gates.push(() => resolve(jsonResponse(200, { ok: true })));
          }),
      )
      .then((o) => {
        outcome = o;
      });

    await waitFor(() => expect(result.current.busy).toBe(true));

    act(() => {
      result.current.cancel();
    });
    await waitFor(() => expect(result.current.busy).toBe(false));

    // Now let the abandoned request land. It must not be able to touch state.
    gates[0]();
    await pending;

    expect(outcome).toMatchObject({ stale: true });
  });
});

describe("networkErrorMessage", () => {
  it("distinguishes a dropped connection from a wrong credential", () => {
    // The whole point: reporting a network failure as "wrong password" sends
    // the user to re-type a credential that was never the problem.
    expect(networkErrorMessage("unreachable")).toContain("ارتباط با سرور برقرار نشد");
    expect(networkErrorMessage("timeout")).toContain("به موقع نرسید");
    expect(networkErrorMessage("unreachable")).not.toContain("نادرست");
    expect(networkErrorMessage("timeout")).not.toContain("نادرست");
  });
});
