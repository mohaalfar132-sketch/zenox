import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export const ENV = {
  appId: process.env.MANUS_PROJECT_ID ?? process.env.VITE_APP_ID ?? "",
  cookieSecret: process.env.MANUS_JWT_SECRET ?? process.env.JWT_SECRET ?? "",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.MANUS_OAUTH_API_URL ?? process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  ownerEmail: process.env.OWNER_EMAIL ?? "",
  isProduction: process.env.NODE_ENV === "production",
  manusApiUrl: process.env.MANUS_API_URL ?? "",
  manusApiKey: process.env.MANUS_API_KEY ?? "",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
};

/**
 * A world-readable .env is a password leak on a shared machine: fix it at boot
 * and say so, once, without printing any value.
 */
export function lockDownSecretFiles(root = process.cwd()) {
  for (const name of [".env", ".zenox-owner.json"]) {
    const file = join(root, name);
    try {
      if (!existsSync(file)) continue;
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o077) !== 0) {
        chmodSync(file, 0o600);
        console.warn(`[security] tightened ${name} permissions from ${mode.toString(8)} to 600`);
      }
    } catch {
      // A read-only volume is a valid deployment: nothing to tighten.
    }
  }
}
