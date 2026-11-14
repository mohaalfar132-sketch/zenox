import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * AI keys entered from the phone. The database is the primary store, but this
 * host is ephemeral: when the database is missing or reset, keys written here
 * still load on the next start because `.env` lives in the project folder.
 * The file is 0600 and the value is never logged or returned.
 */
const ENV_FILE = () => (process.env.ZENOX_ENV_FILE || "").trim() || join(process.cwd(), ".env");

export const PROVIDER_ENV: Record<string, string> = {
  groq: "GROQ_API_KEY",
  gemini: "GEMINI_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  mistral: "MISTRAL_API_KEY",
  sambanova: "SAMBANOVA_API_KEY",
  zai: "ZAI_API_KEY",
};

/**
 * Keys arrive from phones: pasted text can carry quotes, a "Bearer " prefix or
 * an invisible non-ASCII character. Those characters make the HTTP client throw
 * instead of the provider answering, so they are stripped before use.
 */
export function sanitizeApiKey(raw?: string | null): string {
  if (!raw) return "";
  return raw
    .replace(/^\uFEFF/, "")
    .replace(/^\s*bearer\s+/i, "")
    .replace(/[\u2018\u2019\u201C\u201D]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/[\s"']/g, "")
    .trim();
}

/** Upserts `NAME=value` in `.env`, sets it for this process and returns the name. */
export function saveKeyToEnvFile(provider: string, apiKey: string): string | null {
  const name = PROVIDER_ENV[provider];
  if (!name) return null;
  apiKey = sanitizeApiKey(apiKey);
  const file = ENV_FILE();
  const line = `${name}=${apiKey}`;
  let lines: string[] = [];
  if (existsSync(file)) {
    lines = readFileSync(file, "utf8").split("\n");
  }
  const index = lines.findIndex((item) => item.trim().startsWith(`${name}=`));
  if (index >= 0) lines[index] = line;
  else lines.push(line);
  writeFileSync(file, lines.filter((item, i) => item.length > 0 || i < lines.length - 1).join("\n").trimEnd() + "\n", "utf8");
  try {
    chmodSync(file, 0o600);
  } catch {
    // Permissions are best-effort on exotic filesystems.
  }
  process.env[name] = apiKey;
  return name;
}

/** Providers whose key is already present in the environment (names only). */
export function providersInEnv(): string[] {
  return Object.entries(PROVIDER_ENV)
    .filter(([, env]) => Boolean((process.env[env] || "").trim()))
    .map(([provider]) => provider);
}
