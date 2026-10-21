import { describe, it, expect, vi, beforeEach } from "vitest";

// Replace the real Supabase-backed auth module with an observable stub. The
// factory runs before `apiAuth.ts` is imported, so no Supabase client is built
// and the test never touches the network.
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("./auth.tsx", () => ({ supabase: { auth: { getSession } } }));

import { authFetch } from "./apiAuth.ts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:54321/functions/v1/api";

function sessionWith(accessToken: string) {
  return { data: { session: { access_token: accessToken } } };
}

function headersOf(init: RequestInit): Headers {
  return init.headers as Headers;
}

describe("authFetch", () => {
  beforeEach(() => {
    getSession.mockReset();
  });

  it("attaches the Supabase access token as a bearer header", async () => {
    getSession.mockResolved(sessionWith("jwt-123"));
    const fetchMock = vi.fn().mockResolved(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/orders");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_BASE}/orders`);
    expect(headersOf(init).get("authorization")).toBe("Bearer jwt-123");
  });

  it("omits the bearer header when there is no active session", async () => {
    getSession.mockResolved({ data: { session: null } });
    const fetchMock = vi.fn().mockResolved(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/public");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(headersOf(init).get("authorization")).toBeNull();
  });

  it("surfaces a 401 response without retrying (single attempt, no loop)", async () => {
    getSession.mockResolved(sessionWith("expired-jwt"));
    const fetchMock = vi.fn().mockResolved(new Response("nope", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await authFetch("/orders");

    expect(res.status).toBe(401);
    // Exactly one attempt: an accidental retry/refresh loop would raise this.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("merges caller headers and forwards the request init", async () => {
    getSession.mockResolved(sessionWith("jwt-abc"));
    const fetchMock = vi.fn().mockResolved(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
    expect(headersOf(init).get("content-type")).toBe("application/json");
    expect(headersOf(init).get("authorization")).toBe("Bearer jwt-abc");
  });

  it("preserves a caller-supplied Headers instance", async () => {
    getSession.mockResolved(sessionWith("jwt-headers"));
    const fetchMock = vi.fn().mockResolved(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const callerHeaders = new Headers({
      "content-type": "application/json",
      "idempotency-key": "key-123",
    });

    await authFetch("/pay", { method: "POST", headers: callerHeaders, body: "{}" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = headersOf(init);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("key-123");
    expect(headers.get("authorization")).toBe("Bearer jwt-headers");
  });

  it("preserves an array-of-pairs headers input", async () => {
    getSession.mockResolved(sessionWith("jwt-pairs"));
    const fetchMock = vi.fn().mockResolved(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await authFetch("/pay", {
      method: "POST",
      headers: [
        ["content-type", "application/json"],
        ["idempotency-key", "key-456"],
      ],
      body: "{}",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = headersOf(init);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBe("key-456");
    expect(headers.get("authorization")).toBe("Bearer jwt-pairs");
  });

  it("treats all three header input forms identically", async () => {
    getSession.mockResolved(sessionWith("jwt-equal"));
    const fetchMock = vi.fn.mockResolved(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const entries: [string, string][] = [
      ["content-type", "application/json"],
      ["idempotency-key", "key-equal"],
    ];
    const inputs: RequestInit["headers"][] = [
      Object.fromEntries(entries),
      new Headers(entries),
      entries,
    ];

    for (const headers of inputs) {
      await authFetch("/pay", { method: "POST", headers, body: "{}" });
    }

    expect(fetchMock).toHaveBeenCalledTimes(inputs.length);
    const seen = fetchMock.mock.calls.map(([, init]) => {
      const h = headersOf(init as RequestInit);
      return {
        contentType: h.get("content-type"),
        idempotencyKey: h.get("idempotency-key"),
        authorization: h.get("authorization"),
      };
    });
    for (const result of seen) {
      expect(result).equals(seen[0]);
    }
    expect(seen[0]).equals({
      contentType: "application/json",
      idempotencyKey: "key-equal",
      authorization: "Bearer jwt-equal",
    });
  });

  it("propagates a network rejection instead of swallowing it", async () => {
    getSession.mockResolved(sessionWith("jwt"));
    const fetchMock = vi.fn().mockRejected(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(authFetch("/orders")).rejects.toThrow("network down");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("propagates a session-refresh failure and does not send the request", async () => {
    getSession.mockRejected(new Error("refresh failed"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(authFetch("/orders")).rejects.toThrow("refresh failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
