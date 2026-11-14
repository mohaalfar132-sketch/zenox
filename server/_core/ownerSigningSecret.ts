import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

type SecretSource = "env" | "file" | "memory" | "none";

let lastSource: SecretSource = "none";
let ephemeralSecret: string | null = null;

/**
 * The owner session must survive a missing JWT_SECRET. A generated key is kept
 * outside the project (0600), so a correct owner password can always open the
 * panel even when the environment is incomplete. If the filesystem is readonly
 * too, an in-memory key still lets the owner in for this process lifetime.
 */
export function ownerSessionDir() {
  const configured = process.env.ZENOX_OWNER_DIR?.trim();
  return configured && configured.length > 0 ? configured : join(homedir(), ".zenox-owner");
}

function environmentSecret() {
  return (
    process.env.OWNER_GATE_SECRET?.trim() ||
    process.env.OWNER_SESSION_SECRET?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    process.env.MANUS_JWT_SECRET?.trim() ||
    ""
  );
}

export function ownerSigningSecretSource(): SecretSource {
  if (environmentSecret()) return "env";
  // Reading is idempotent and creates the key on first use, so status and
  // login never disagree about whether the gateway can sign a session.
  ownerSigningSecret();
  return lastSource;
}

export function ownerSigningSecret(): Uint8Array | null {
  const fromEnv = environmentSecret();
  if (fromEnv) {
    lastSource = "env";
    return new TextEncoder().encode(fromEnv);
  }

  try {
    const dir = ownerSessionDir();
    const file = join(dir, "owner-gate.key");
    if (existsSync(file)) {
      const saved = readFileSync(file, "utf8").trim();
      if (saved.length >= 32) {
        lastSource = "file";
        return new TextEncoder().encode(saved);
      }
    }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const generated = randomBytes(48).toString("base64url");
    writeFileSync(file, generated, { mode: 0o600 });
    chmodSync(file, 0o600);
    lastSource = "file";
    console.warn("[owner-gate] generated a persistent owner session key outside the project");
    return new TextEncoder().encode(generated);
  } catch {
    ephemeralSecret ??= randomBytes(48).toString("base64url");
    lastSource = "memory";
    console.warn("[owner-gate] using an in-memory owner session key; sessions end on restart");
    return new TextEncoder().encode(ephemeralSecret);
  }
}
