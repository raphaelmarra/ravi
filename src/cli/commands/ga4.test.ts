import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { Ga4Client } from "../../apps/google-analytics-4/client.js";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { Ga4Commands } from "./ga4.js";

afterEach(() => {
  spyOn(console, "log").mockRestore();
});

describe("GA4 CLI contract", () => {
  it("declares access, typed returns and --json for every finite command", () => {
    const commands = getCommandsMetadata(Ga4Commands);
    const access = getCommandAccessMetadata(Ga4Commands);
    const returns = getReturnsMetadata(Ga4Commands);

    expect(commands.length).toBeGreaterThanOrEqual(25);
    expect(access.size).toBe(commands.length);
    expect(returns.size).toBe(commands.length);
    for (const command of commands) {
      expect(
        getOptionsMetadata(Ga4Commands.prototype, command.method).some((option) => option.flags === "--json"),
      ).toBe(true);
    }
  });

  it("separates read, write and destructive command access", () => {
    const access = getCommandAccessMetadata(Ga4Commands);

    expect(access.get("report")).toMatchObject({ kind: "read", risk: "low" });
    expect(access.get("audienceExportCreate")).toMatchObject({
      kind: "mutate",
      risk: "medium",
      requiresConfirmation: true,
    });
    expect(access.get("adminCreate")).toMatchObject({
      kind: "mutate",
      risk: "high",
      requiresConfirmation: true,
    });
    expect(access.get("adminDelete")).toMatchObject({
      kind: "mutate",
      risk: "destructive",
      requiresConfirmation: true,
    });
  });

  it("builds a bounded runReport body with a fake client only", async () => {
    const requests: Array<{ property: string; body: Record<string, unknown> }> = [];
    const commands = new Ga4Commands();
    Object.defineProperty(commands, "client", {
      value: () =>
        ({
          runReport: async (property: string, body: Record<string, unknown>) => {
            requests.push({ property, body });
            return { rowCount: 0 };
          },
        }) as unknown as Ga4Client,
    });
    spyOn(console, "log").mockImplementation(() => {});

    const result = await commands.report(
      "123",
      "pagePath",
      "screenPageViews,sessions",
      "30daysAgo",
      "yesterday",
      "50",
      "0",
    );
    expect(result as unknown).toEqual({ result: { rowCount: 0 } });
    expect(requests).toEqual([
      {
        property: "123",
        body: {
          dimensions: [{ name: "pagePath" }],
          metrics: [{ name: "screenPageViews" }, { name: "sessions" }],
          dateRanges: [{ startDate: "30daysAgo", endDate: "yesterday" }],
          limit: "50",
          offset: "0",
        },
      },
    ]);
  });

  it("rejects invalid report input before resolving a client", async () => {
    let clientResolved = false;
    const commands = new Ga4Commands();
    Object.defineProperty(commands, "client", {
      value: () => {
        clientResolved = true;
        return {} as Ga4Client;
      },
    });

    await expect(commands.report("123", "", "sessions", undefined, undefined, "50", "0")).rejects.toThrow(
      "--dimensions is required",
    );
    expect(clientResolved).toBe(false);
  });

  it("keeps write commands dry-run-only before resolving credentials", async () => {
    let clientResolved = false;
    const commands = new Ga4Commands();
    Object.defineProperty(commands, "client", {
      value: () => {
        clientResolved = true;
        return {} as Ga4Client;
      },
    });
    spyOn(console, "log").mockImplementation(() => {});

    await expect(
      commands.adminCreate("key-events", "properties/123", '{"eventName":"purchase"}', false),
    ).rejects.toThrow("dry-run-only");
    expect(clientResolved).toBe(false);

    const result = await commands.adminCreate("key-events", "properties/123", '{"eventName":"purchase"}', true);
    expect(result).toMatchObject({
      result: {
        ok: true,
        dryRun: true,
        liveExecution: false,
        networkCalled: false,
        operation: "admin-create",
      },
    });
    expect(clientResolved).toBe(false);
  });
});
