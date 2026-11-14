import { AGENT_TOOL_NAMES, isBlockedAgentTool } from "./ownerAgent";

/**
 * The owner's own powers over the platform: a real shell and the whole project
 * code, plus file upload and the console. They belong to the owner's session and
 * to nothing else, and nothing inside the app may switch them off — no setting,
 * no maintenance mode, no agent. This module states that contract and checks it.
 */
export const OWNER_CORE_CAPABILITIES = [
  {
    id: "shell",
    label: "Terminal",
    procedures: ["owner.terminal.exec", "owner.terminal.status"],
    routes: ["/api/owner/terminal/stream", "/api/owner/terminal/stop", "/api/owner/terminal/state"],
  },
  {
    id: "code",
    label: "كود البنية التحتية",
    procedures: ["owner.code.tree", "owner.code.read", "owner.code.write"],
    routes: [],
  },
  {
    id: "files",
    label: "الملفات والرفع",
    procedures: ["owner.uploads.list"],
    routes: ["/api/owner/upload", "/api/owner/file"],
  },
  {
    id: "console",
    label: "مركز الأوامر",
    procedures: ["owner.tools.list", "owner.tools.run"],
    routes: ["/api/owner/exec-intent"],
  },
  {
    id: "site",
    label: "التحكم في المنصة",
    procedures: ["owner.site.get", "owner.site.set"],
    routes: ["/api/site/state"],
  },
] as const;

const requiredProcedures = OWNER_CORE_CAPABILITIES.flatMap((capability) => [...capability.procedures]);

/** Anything missing from the live router — this should always be empty. */
export function missingOwnerCore(available: Iterable<string>): string[] {
  const present = new Set(available);
  return requiredProcedures.filter((name) => !present.has(name));
}

export function ownerCoreReport(available: Iterable<string>) {
  const missing = missingOwnerCore(available);
  const agentHasShell = AGENT_TOOL_NAMES.includes("run_command") || !isBlockedAgentTool("run_command");
  return {
    ok: missing.length === 0 && !agentHasShell,
    missing,
    agentHasShell,
    capabilities: OWNER_CORE_CAPABILITIES.map((capability) => ({
      id: capability.id,
      label: capability.label,
      procedures: [...capability.procedures],
      routes: [...capability.routes],
    })),
  };
}

/** Startup line: loud if the owner ever loses a core power. */
export function ownerCoreStartupLine(available: Iterable<string>) {
  const report = ownerCoreReport(available);
  return report.ok
    ? `[owner] core powers intact: ${OWNER_CORE_CAPABILITIES.map((capability) => capability.label).join(" · ")}`
    : `[owner] CORE POWER MISSING: ${report.missing.join(", ") || "agent shell"} — restore it before anything else`;
}
