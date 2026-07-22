import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

describe("GA4 Ravi App contract", () => {
  const manifest = JSON.parse(readFileSync(join(root, "ravi.app.json"), "utf8")) as {
    id: string;
    interfaces: { cli: { command: string; health: string } };
    operations: Record<
      string,
      {
        interface: string;
        command?: string;
        mutating?: boolean;
        permission?: string;
        risk?: string;
        inputSchema?: string;
        outputSchema?: string;
        safety?: {
          dryRunSupported?: boolean;
          confirmationRequired?: boolean;
          liveExecution?: boolean;
          risk?: string;
        };
        reliability?: { maxAttempts?: number };
      }
    >;
    permissions: { required: string[]; optional: string[]; mutating: string[] };
    storage: { sqlite: unknown[]; files: unknown[] };
  };

  it("uses only native Ravi commands and a safe builtin health check", () => {
    const commands = Object.values(manifest.operations).flatMap((operation) =>
      operation.command ? [operation.command] : [],
    );
    expect(commands.length).toBeGreaterThanOrEqual(20);
    expect(manifest.id).toBe("google-analytics-4");
    expect(manifest.interfaces.cli.command).toBe("ravi ga4");
    expect(manifest.interfaces.cli.health).toBe("ravi apps check google-analytics-4 --json");
    expect(commands.every((command) => command.startsWith("ravi ga4 "))).toBe(true);
    expect(commands.every((command) => !command.startsWith("ravi google-analytics-4 "))).toBe(true);
    expect(commands.some((command) => command.includes("sde"))).toBe(false);
    expect(manifest.operations["google-analytics-4.check"]).toMatchObject({
      interface: "builtin",
      mutating: false,
    });
  });

  it("declares hardened runtime contracts for CLI operations", () => {
    const cliOperations = Object.values(manifest.operations).filter((operation) => operation.interface === "cli");
    expect(cliOperations.length).toBeGreaterThanOrEqual(20);

    for (const operation of cliOperations) {
      expect(operation.inputSchema).toBe("schemas/cli-invocation.v1.json");
      expect(operation.outputSchema).toBe("schemas/result.v1.json");
      expect(operation.reliability?.maxAttempts).toBe(1);
    }

    const read = manifest.operations["google-analytics-4.report"];
    expect(read.safety).toMatchObject({
      dryRunSupported: false,
      confirmationRequired: false,
      liveExecution: true,
      risk: "low",
    });

    const write = manifest.operations["google-analytics-4.admin-create"];
    expect(write.safety).toMatchObject({
      dryRunSupported: true,
      confirmationRequired: true,
      liveExecution: false,
      risk: "high",
    });

    const destructive = manifest.operations["google-analytics-4.admin-delete"];
    expect(destructive.safety).toMatchObject({
      dryRunSupported: true,
      confirmationRequired: true,
      liveExecution: false,
      risk: "destructive",
    });
  });

  it("separates read, write and destructive permissions", () => {
    const mutations = Object.values(manifest.operations).filter((operation) => operation.mutating);
    const destructive = mutations.filter((operation) => operation.risk === "destructive");
    const writes = mutations.filter((operation) => operation.risk === "write");

    expect(manifest.permissions.required).toContain("ga4:data:read");
    expect(manifest.permissions.optional).toContain("ga4:admin:read");
    expect(writes.length).toBeGreaterThan(0);
    expect(destructive.length).toBeGreaterThan(0);
    expect(writes.every((operation) => operation.permission?.endsWith(":write"))).toBe(true);
    expect(destructive.every((operation) => operation.permission === "ga4:admin:destructive")).toBe(true);
  });

  it("declares no financial operation and no persisted credentials", () => {
    expect(Object.values(manifest.operations).some((operation) => operation.risk === "financial")).toBe(false);
    expect(manifest.storage).toEqual({ sqlite: [], files: [] });
  });
});
