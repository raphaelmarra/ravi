import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import {
  getCommandAccessMetadata,
  getCommandsMetadata,
  getOptionsMetadata,
  getReturnsMetadata,
} from "../decorators.js";
import { GoogleBusinessProfileCommands } from "./google-business-profile.js";

afterEach(() => mock.restore());

const readMethods = [
  "health",
  "accounts",
  "accountGet",
  "locations",
  "locationGet",
  "reviews",
  "reviewGet",
  "posts",
  "postGet",
  "media",
  "mediaGet",
  "performance",
  "searchKeywords",
  "categories",
  "attributes",
  "verifications",
  "verificationOptions",
  "admins",
] as const;

const highRiskMutations = [
  "locationUpdate",
  "reviewReply",
  "postCreate",
  "postUpdate",
  "mediaCreate",
  "mediaUpdate",
  "verify",
  "verificationComplete",
  "adminAdd",
  "adminUpdate",
] as const;

const destructiveMutations = [
  "locationDelete",
  "reviewReplyDelete",
  "postDelete",
  "mediaDelete",
  "adminDelete",
] as const;

describe("Google Business Profile CLI contract", () => {
  it("declares access, typed returns, rich help and --json for every command", () => {
    const commands = getCommandsMetadata(GoogleBusinessProfileCommands);
    const access = getCommandAccessMetadata(GoogleBusinessProfileCommands);
    const returns = getReturnsMetadata(GoogleBusinessProfileCommands);

    expect(commands).toHaveLength(33);
    expect(access.size).toBe(commands.length);
    expect(returns.size).toBe(commands.length);
    for (const command of commands) {
      expect(getOptionsMetadata(GoogleBusinessProfileCommands.prototype, command.method)).toContainEqual(
        expect.objectContaining({ flags: "--json" }),
      );
      expect(command.helpAfter).toContain("EXAMPLES");
      expect(command.helpAfter).toContain("ON ERROR");
      expect(command.helpAfter).toContain("SOURCES");
    }
  });

  it("separates reads, high-risk writes and destructive mutations", () => {
    const access = getCommandAccessMetadata(GoogleBusinessProfileCommands);

    for (const method of readMethods) expect(access.get(method)).toMatchObject({ kind: "read" });
    for (const method of highRiskMutations) {
      expect(access.get(method)).toMatchObject({
        kind: "mutate",
        risk: "high",
        requiresConfirmation: true,
      });
    }
    for (const method of destructiveMutations) {
      expect(access.get(method)).toMatchObject({
        kind: "mutate",
        risk: "destructive",
        requiresConfirmation: true,
      });
    }
    expect(Array.from(access.values()).some((entry) => entry.resource.includes("financial"))).toBe(false);
  });

  it("rejects malformed payloads and required options before credential access", async () => {
    const commands = new GoogleBusinessProfileCommands();

    await expect(commands.locationUpdate("456", "websiteUri", "not-json")).rejects.toThrow(
      "--payload must be a JSON object",
    );
    await expect(commands.performance("456", undefined, "2026-06-01", "2026-06-30")).rejects.toThrow(
      "--metrics is required",
    );
    await expect(commands.adminUpdate("admin-789", "OWNER")).rejects.toThrow("Admin name must be a full");
  });

  it("marks required options for generated SDK input schemas", () => {
    const locationUpdateOptions = getOptionsMetadata(GoogleBusinessProfileCommands.prototype, "locationUpdate");
    expect(locationUpdateOptions).toContainEqual(expect.objectContaining({ flags: "--mask <fields>", required: true }));
    expect(locationUpdateOptions).toContainEqual(
      expect.objectContaining({ flags: "--payload <json>", required: true }),
    );

    const performanceOptions = getOptionsMetadata(GoogleBusinessProfileCommands.prototype, "performance");
    expect(performanceOptions).toContainEqual(expect.objectContaining({ flags: "--metrics <csv>", required: true }));
    expect(performanceOptions).toContainEqual(expect.objectContaining({ flags: "--start <date>", required: true }));
    expect(performanceOptions).toContainEqual(expect.objectContaining({ flags: "--end <date>", required: true }));
  });

  it("prints health from credential metadata only", async () => {
    const log = spyOn(console, "log").mockImplementation(() => {});
    const commands = new GoogleBusinessProfileCommands();

    const result = await commands.health("missing-test-connection");

    expect(result).toMatchObject({
      ok: true,
      app: "google-business-profile",
      connection: "missing-test-connection",
      credentialConfigured: false,
      authenticated: false,
      externalCheckPerformed: false,
      writesEnabled: false,
    });
    expect(log).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
  });

  it("rejects impossible dates and inverted ranges before credential access", async () => {
    const commands = new GoogleBusinessProfileCommands();

    await expect(commands.performance("456", "CALL_CLICKS", "2026-99-99", "2026-12-31")).rejects.toThrow(
      "--start must be a real date",
    );
    await expect(commands.performance("456", "CALL_CLICKS", "2026-12-31", "2026-01-01")).rejects.toThrow(
      "--start must be before or equal to --end",
    );
    await expect(commands.searchKeywords("456", "2026-13", "2026-12")).rejects.toThrow(
      "--start-month must be a real month",
    );
    await expect(commands.searchKeywords("456", "2026-12", "2026-01")).rejects.toThrow(
      "--start-month must be before or equal to --end-month",
    );
  });
});
