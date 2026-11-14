import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OWNER_AGENT_TOOLS, OWNER_FULL_TOOL_NAMES, ownerChatPrompt } from "../server/_core/ownerAgent";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("the owner's chat is wired to every section", () => {
  it("offers the owner the full reach, and keeps the restricted list for everyone else", () => {
    for (const tool of ["run_command", "write_file", "edit_file", "delete_file", "restart_server", "rebuild_web", "build_apk"]) {
      expect(OWNER_FULL_TOOL_NAMES).toContain(tool);
    }
    expect(OWNER_AGENT_TOOLS).not.toContain("run_command");
    expect(OWNER_AGENT_TOOLS).not.toContain("write_file");
  });

  it("tells the owner's agent to execute instead of refusing", () => {
    const prompt = ownerChatPrompt(true);
    expect(prompt).toContain("run_command");
    expect(prompt).toContain("لا ترفض");
    expect(prompt).not.toBe(ownerChatPrompt(false));
  });

  it("grants full access only inside the verified owner session", () => {
    const server = read("server/_core/index.ts");
    expect(server).toContain("fullAccess: isOwner");
    const agent = read("server/_core/ownerAgent.ts");
    expect(agent).toContain("if (!fullAccess && isBlockedAgentTool(tool))");
    expect(agent).toContain("input.fullAccess ? ALL_TOOLS : TOOLS");
  });

  it("runs /run orders straight through the real shell without a model", () => {
    const server = read("server/_core/index.ts");
    expect(server).toMatch(/\(\?:run\|شغل\)/);
    expect(server).toContain("await runShell(command)");
  });
});
