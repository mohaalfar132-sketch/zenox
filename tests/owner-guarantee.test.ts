import { describe, expect, it } from "vitest";
import { appRouter } from "../server/routers";
import { AGENT_TOOL_NAMES } from "../server/_core/ownerAgent";
import { OWNER_CORE_CAPABILITIES, missingOwnerCore, ownerCoreReport } from "../server/_core/ownerGuarantee";

const procedures = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);

describe("the owner's shell and code powers are a fixed part of the platform", () => {
  it("keeps every core owner procedure mounted", () => {
    expect(missingOwnerCore(procedures)).toEqual([]);
    for (const capability of OWNER_CORE_CAPABILITIES) {
      for (const name of capability.procedures) expect(procedures).toContain(name);
    }
  });

  it("still gives the owner a real shell and code editing", () => {
    expect(procedures).toContain("owner.terminal.exec");
    expect(procedures).toContain("owner.code.write");
    expect(procedures).toContain("owner.code.read");
  });

  it("reports the contract as intact, with no agent shell", () => {
    const report = ownerCoreReport(procedures);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.agentHasShell).toBe(false);
    expect(AGENT_TOOL_NAMES).not.toContain("run_command");
  });

  it("names what is missing when a power is removed", () => {
    const without = procedures.filter((name) => name !== "owner.code.write" && name !== "owner.terminal.exec");
    expect(missingOwnerCore(without)).toEqual(
      expect.arrayContaining(["owner.terminal.exec", "owner.code.write"]),
    );
    expect(ownerCoreReport(without).ok).toBe(false);
  });
});
