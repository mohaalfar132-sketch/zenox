import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
const routers = read("server/routers.ts");
const ownerAuth = read("server/_core/ownerAuth.ts");
const ownerAgent = read("server/_core/ownerAgent.ts");
const server = read("server/_core/index.ts");

describe("nobody but the owner can take the owner access away", () => {
  it("keeps the shell and the code editor behind the owner procedure, never public", () => {
    for (const anchor of ["terminal: router({", "code: router({", "tools: router({"]) {
      const block = routers.slice(routers.indexOf(anchor), routers.indexOf(anchor) + 260);
      expect(block, anchor).toContain("adminProcedure");
      expect(block, anchor).not.toContain("publicProcedure");
    }
  });

  it("has no route that clears the owner password", () => {
    for (const source of [routers, server, read("server/db.ts")]) {
      expect(source).not.toContain("clearOwnerPassword");
    }
  });

  it("cannot replace an existing password from the panel", () => {
    const setup = routers.slice(routers.indexOf("setup: publicProcedure"), routers.indexOf("login: publicProcedure"));
    expect(setup).toContain("CONFLICT");
    expect(setup).toMatch(/resolveOwnerHash\(\)/);
  });

  it("only opens a session after the password is verified", () => {
    const loginStart = routers.indexOf("login: publicProcedure");
    const login = routers.slice(loginStart, routers.indexOf("logout: publicProcedure", loginStart));
    expect(login).toContain("verifyOwnerGatePassword");
    expect(login).toContain("loginBlockedFor");
    expect(login).toContain("createOwnerSession");
  });

  it("keeps every owner HTTP route behind an owner session check", () => {
    for (const route of ["/api/owner/terminal/state", "/api/owner/terminal/stop", "/api/owner/terminal/stream", "/api/owner/upload", "/api/owner/file"]) {
      const at = server.indexOf(route);
      expect(at, route).toBeGreaterThan(-1);
      const block = server.slice(at, at + 700);
      expect(block, route).toContain("readOwnerSession");
    }
  });

  it("keeps the credential file outside the project and readable by the owner only", () => {
    expect(ownerAuth).toContain("homedir()");
    expect(ownerAuth).toContain(".zenox-owner");
    expect(ownerAuth).toContain("mode: 0o600");
    expect(ownerAuth).toMatch(/mkdirSync\(dirname\(file\), \{ recursive: true, mode: 0o700 \}\)/);
  });

  it("keeps the agent without shell, file writing or owner tools", () => {
    const blocked = ownerAgent.slice(ownerAgent.indexOf("AGENT_BLOCKED_TOOLS = ["), ownerAgent.indexOf("] as const"));
    for (const tool of ["run_command", "write_file", "edit_file", "delete_file", "restart_server", "rebuild_web", "build_apk"]) {
      expect(blocked, tool).toContain(`"${tool}"`);
    }
    const start = ownerAgent.indexOf("AGENT_ALLOWED_OWNER_TOOLS = [");
    const allowed = ownerAgent.slice(start, ownerAgent.indexOf("] as const", start));
    const names = [...allowed.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(["speed_report", "orders_report", "disk_usage", "git_status", "list_uploads"]);
  });
});
