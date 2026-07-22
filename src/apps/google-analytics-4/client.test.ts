import { describe, expect, it } from "bun:test";
import { Ga4Client, parseAdminResource, parseGa4Credential } from "./client.js";

describe("Ga4Client", () => {
  it("fails closed before fetch when no credential can be resolved", async () => {
    let fetched = false;
    const client = new Ga4Client({
      fetch: (async () => {
        fetched = true;
        return Response.json({});
      }) as unknown as typeof globalThis.fetch,
      credentialResolver: async () => {
        throw new Error("Connection not found: google-analytics:default");
      },
    });

    await expect(client.getMetadata("123")).rejects.toThrow("Connection not found");
    expect(fetched).toBe(false);
  });

  it("calls the confirmed Data API runReport endpoint with a bounded fake credential", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const client = new Ga4Client({
      credential: { accessToken: "test-token" },
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        requests.push({ url: String(input), init });
        return Response.json({ rowCount: 0 });
      }) as unknown as typeof globalThis.fetch,
    });

    await expect(
      client.runReport("123", {
        dimensions: [{ name: "pagePath" }],
        metrics: [{ name: "screenPageViews" }],
        dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      }),
    ).resolves.toEqual({ rowCount: 0 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://analyticsdata.googleapis.com/v1beta/properties/123:runReport");
    expect(requests[0]?.init.method).toBe("POST");
    expect((requests[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer test-token");
  });

  it("routes stable and preview Admin resources through their documented channels", async () => {
    const urls: string[] = [];
    const client = new Ga4Client({
      credential: { accessToken: "test-token" },
      fetch: (async (input: string | URL | Request) => {
        urls.push(String(input));
        return Response.json({});
      }) as unknown as typeof globalThis.fetch,
    });

    await client.listAdmin("key-events", "properties/123", 50);
    await client.listAdmin("audiences", "properties/123", 50);

    expect(urls[0]).toBe("https://analyticsadmin.googleapis.com/v1beta/properties/123/keyEvents?pageSize=50");
    expect(urls[1]).toBe("https://analyticsadmin.googleapis.com/v1alpha/properties/123/audiences?pageSize=50");
  });

  it("keeps writes and destructive requests explicit", async () => {
    const requests: Array<{ url: string; method: string | undefined }> = [];
    const client = new Ga4Client({
      credential: { accessToken: "test-token" },
      fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        requests.push({ url: String(input), method: init.method });
        return Response.json({});
      }) as unknown as typeof globalThis.fetch,
    });

    await client.createAdmin("key-events", "properties/123", { eventName: "signup" });
    await client.deleteAdmin("key-events", "properties/123/keyEvents/456");
    await client.archiveAdmin("custom-dimensions", "properties/123/customDimensions/7");

    expect(requests).toEqual([
      {
        url: "https://analyticsadmin.googleapis.com/v1beta/properties/123/keyEvents",
        method: "POST",
      },
      {
        url: "https://analyticsadmin.googleapis.com/v1beta/properties/123/keyEvents/456",
        method: "DELETE",
      },
      {
        url: "https://analyticsadmin.googleapis.com/v1beta/properties/123/customDimensions/7:archive",
        method: "POST",
      },
    ]);
  });

  it("requests distinct broker actions for read, write and destructive classes", async () => {
    const actions: string[] = [];
    const client = new Ga4Client({
      credentialResolver: async (_connection, action) => {
        actions.push(action);
        return { accessToken: "test-token" };
      },
      fetch: (async () => Response.json({})) as unknown as typeof globalThis.fetch,
    });

    await client.getMetadata("123");
    await client.createAudienceExport("123", { audience: "properties/123/audiences/4" });
    await client.createAdmin("key-events", "properties/123", { eventName: "signup" });
    await client.deleteAdmin("key-events", "properties/123/keyEvents/456");

    expect(actions).toEqual(["data.read", "audience-exports.write", "admin.write", "admin.destructive"]);
  });

  it("aborts provider requests at the configured timeout", async () => {
    let signal: AbortSignal | undefined;
    const client = new Ga4Client({
      credential: { accessToken: "test-token" },
      timeoutMs: 1,
      fetch: (async (_input: string | URL | Request, init: RequestInit = {}) => {
        signal = init.signal as AbortSignal;
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        return Response.json({});
      }) as unknown as typeof globalThis.fetch,
    });

    await expect(client.getMetadata("123")).rejects.toThrow("timed out after 1ms");
    expect(signal?.aborted).toBe(true);
  });

  it("requires the official parent filter before listing properties", async () => {
    let fetched = false;
    const client = new Ga4Client({
      credential: { accessToken: "test-token" },
      fetch: (async () => {
        fetched = true;
        return Response.json({});
      }) as unknown as typeof globalThis.fetch,
    });

    expect(() => client.listAdmin("properties")).toThrow("--parent accounts/<id> is required");
    expect(fetched).toBe(false);
  });

  it("rejects unsupported resource/capability pairs instead of inventing endpoints", async () => {
    expect(() => parseAdminResource("invented-resource")).toThrow("Unsupported GA4 admin resource");
    const client = new Ga4Client({ credential: { accessToken: "test-token" } });
    expect(() => client.getAdmin("firebase-links", "properties/1/firebaseLinks/2")).toThrow("does not support get");
  });

  it("parses only the Phase-1 broker envelope and redacts provider errors", async () => {
    expect(parseGa4Credential('{"accessToken":"fake"}')).toEqual({ accessToken: "fake" });
    expect(() => parseGa4Credential('{"refreshToken":"not-supported"}')).toThrow("accessToken");

    const client = new Ga4Client({
      credential: { accessToken: "test-token" },
      fetch: (async () =>
        new Response('{"access_token":"sensitive-provider-value"}', {
          status: 401,
        })) as unknown as typeof globalThis.fetch,
    });
    await expect(client.getMetadata("123")).rejects.toThrow("[redacted]");
    await expect(client.getMetadata("123")).rejects.not.toThrow("sensitive-provider-value");
  });
});
