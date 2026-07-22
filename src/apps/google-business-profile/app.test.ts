import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

describe("Google Business Profile App contract", () => {
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
        inputSchema?: string;
        outputSchema?: string;
        help?: {
          complete?: boolean;
          missing?: string[];
          examples?: string[];
          provenance?: { verifiedAt?: string };
          quota?: { status?: string; throttle?: unknown };
        };
        safety?: { liveExecution?: boolean; dryRunSupported?: boolean };
        reliability?: { maxAttempts?: number };
      }
    >;
    permissions: { required: string[]; mutating: string[] };
    operationClasses: { read: string[]; write: string[]; destructive: string[]; financial: string[] };
    skills: string[];
  };

  it("uses a non-recursive native CLI and credential-free health check", () => {
    expect(manifest.id).toBe("google-business-profile");
    expect(manifest.interfaces.cli.command).toBe("ravi google-business-profile");
    expect(manifest.interfaces.cli.health).toBe("ravi gbp health --json");
    expect(manifest.interfaces.cli.health).not.toContain("accounts");
  });

  it("declares the implemented native operations without wrapping SDE", () => {
    const commands = Object.values(manifest.operations).flatMap((operation) =>
      operation.command ? [operation.command] : [],
    );
    expect(commands).toHaveLength(33);
    expect(commands.every((command) => command.startsWith("ravi gbp "))).toBe(true);
    expect(commands.some((command) => command.includes("sde"))).toBe(false);
  });

  it("declares versioned schemas and fail-closed safety for every CLI operation", () => {
    const cliOperations = Object.entries(manifest.operations).filter(([, operation]) => operation.interface === "cli");
    expect(cliOperations).toHaveLength(33);

    for (const [operationId, operation] of cliOperations) {
      expect(operation.inputSchema).toBe("schemas/operation-input.v1.json");
      expect(operation.outputSchema).toMatch(/^schemas\/.*\.v1\.json$/);
      expect(operation.help?.complete).toBe(true);
      expect(operation.help?.missing).toEqual([]);
      expect(operation.help?.examples?.join(" ")).toContain("ravi google-business-profile");
      expect(operation.help?.provenance?.verifiedAt).toBe("2026-07-22");
      expect(operation.help?.quota?.status).toBe("unknown-numeric-limits");
      expect(operation.help?.quota?.throttle).toBeDefined();
      expect(operation.reliability?.maxAttempts).toBe(1);
      if (operation.mutating) {
        expect(operation.safety).toMatchObject({ liveExecution: false, dryRunSupported: false });
        expect([...manifest.operationClasses.write, ...manifest.operationClasses.destructive]).toContain(operationId);
      }
    }
  });

  it("separates reads, writes and destructive permissions with no financial surface", () => {
    const operations = Object.values(manifest.operations);
    const readPermissions = operations
      .filter((operation) => !operation.mutating && operation.permission)
      .map((operation) => operation.permission as string);
    const mutatingPermissions = operations
      .filter((operation) => operation.mutating)
      .map((operation) => operation.permission as string);

    expect(readPermissions.every((permission) => permission.endsWith(":read"))).toBe(true);
    expect(mutatingPermissions.some((permission) => permission.endsWith(":write"))).toBe(true);
    expect(mutatingPermissions.some((permission) => permission.endsWith(":delete"))).toBe(true);
    expect([...readPermissions, ...mutatingPermissions].some((permission) => permission.includes("financial"))).toBe(
      false,
    );
    expect(new Set(manifest.permissions.required)).toEqual(new Set(readPermissions));
    expect(new Set(manifest.permissions.mutating)).toEqual(new Set(mutatingPermissions));
    expect(manifest.operationClasses.financial).toEqual([]);
  });

  it("keeps agent teaching changes outside this implementation task", () => {
    expect(manifest.skills).toEqual([]);
  });
});
