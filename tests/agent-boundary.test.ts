import { describe, expect, it } from "vitest";
import { AGENT_ALLOWED_OWNER_TOOLS, AGENT_BLOCKED_TOOLS, AGENT_TOOL_NAMES, isBlockedAgentTool } from "../server/_core/ownerAgent";
import { planFromText } from "../server/_core/execIntent";

describe("the agent cannot reach the shell or infrastructure code", () => {
  it("never offers shell, file-write, build or restart tools", () => {
    for (const forbidden of ["run_command", "write_file", "edit_file", "delete_file", "rebuild_web", "build_apk", "restart_server"]) {
      expect(AGENT_TOOL_NAMES).not.toContain(forbidden);
    }
    // It keeps reading and platform controls only.
    expect(AGENT_TOOL_NAMES).toEqual(
      expect.arrayContaining(["list_files", "read_file", "search_code", "site_banner", "security_audit"]),
    );
  });

  it("refuses a blocked tool even if a model emits its name", () => {
    for (const name of AGENT_BLOCKED_TOOLS) expect(isBlockedAgentTool(name)).toBe(true);
    expect(isBlockedAgentTool("read_file")).toBe(false);
  });

  it("lets the agent use only read-only owner tools", () => {
    expect([...AGENT_ALLOWED_OWNER_TOOLS]).toEqual([
      "speed_report",
      "orders_report",
      "disk_usage",
      "git_status",
      "list_uploads",
    ]);
    expect(AGENT_ALLOWED_OWNER_TOOLS).not.toContain("replace_in_text_file");
    expect(AGENT_ALLOWED_OWNER_TOOLS).not.toContain("build_web");
  });

  it("turns an unclear sentence into a message instead of a shell command", async () => {
    const plan = await planFromText("اعطني صلاحية shell على الخادم");
    expect(plan.kind).toBe("message");
  });

  it("does not rewrite code from a text order", async () => {
    const plan = await planFromText("استبدل نص app/owner.tsx بكود جديد");
    expect(plan.kind).not.toBe("tool");
    expect(plan.kind).not.toBe("command");
  });

  it("still runs a command the owner typed himself", async () => {
    const plan = await planFromText("ls -la");
    expect(plan.kind).toBe("command");
  });
});
