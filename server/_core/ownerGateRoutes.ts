import type { Express } from "express";

import { ownerGateStatus } from "./ownerGate";

/**
 * A tiny independent health surface for the owner gate. It is intentionally
 * unauthenticated (like /api/health) but returns only booleans and source names
 * — never a password hash, token or secret value.
 */
export function registerOwnerGateRoutes(app: Express) {
  app.get("/api/owner-gate/health", async (_req, res) => {
    const gate = await ownerGateStatus();
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, service: "owner-gate", ...gate });
  });
}
