import { randomBytes, scryptSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function hash(password) {
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${digest.toString("base64")}`;
}

const idx = process.argv.indexOf("--password");
const newPass = idx !== -1 ? process.argv[idx + 1] : "ZENOX_ADMIN_999!";

if (!newPass || newPass.length < 10) {
  console.error("Refusing: use at least 10 characters.");
  process.exit(1);
}

const ownerDir = process.env.ZENOX_OWNER_DIR?.trim() || join(homedir(), ".zenox-owner");
const target = resolve(process.env.OWNER_PASSWORD_FILE?.trim() || join(ownerDir, "credential.json"));
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify({ hash: hash(newPass), updatedAt: new Date().toISOString() }, null, 2), {
  mode: 0o600,
});
console.log(`Wrote ${target} with new password.`);
