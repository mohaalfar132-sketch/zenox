import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { providersInEnv, saveKeyToEnvFile } from "../server/_core/keyVault";

let file: string;

beforeEach(() => {
  file = join(mkdtempSync(join(tmpdir(), "zenox-env-")), ".env");
  process.env.ZENOX_ENV_FILE = file;
});

afterEach(() => {
  delete process.env.ZENOX_ENV_FILE;
  delete process.env.GROQ_API_KEY;
});

describe("env-file key vault", () => {
  it("writes a key once and replaces it on rotation", () => {
    saveKeyToEnvFile("groq", "first-value-123");
    saveKeyToEnvFile("groq", "second-value-456");
    const lines = readFileSync(file, "utf8").trim().split("\n").filter((line) => line.startsWith("GROQ_API_KEY="));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("GROQ_API_KEY=second-value-456");
    expect(process.env.GROQ_API_KEY).toBe("second-value-456");
  });

  it("keeps the file private to the owner account", () => {
    saveKeyToEnvFile("groq", "value-1234567");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("reports which providers are configured without exposing values", () => {
    saveKeyToEnvFile("groq", "value-1234567");
    expect(providersInEnv()).toEqual(["groq"]);
  });

  it("ignores providers without a known environment variable", () => {
    expect(saveKeyToEnvFile("custom", "value-1234567")).toBeNull();
  });
});
