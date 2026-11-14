/**
 * Mints one owner session cookie for local verification of owner-only routes.
 * Run: npx tsx scripts/mint-owner-cookie.ts
 * It prints only the cookie header; nothing else is exposed.
 */
import { createOwnerSession } from "../server/_core/ownerAuth";

async function main() {
  const token = await createOwnerSession();
  if (!token) {
    console.error("owner session unavailable");
    process.exit(1);
  }
  process.stdout.write(`zx_owner=${token}`);
}

void main();
