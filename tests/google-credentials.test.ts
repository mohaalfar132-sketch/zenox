import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { googleConfigured } from "../server/google";
import {
  ensureGoogleCredentials,
  googleCredentialFile,
  googleCredentialSource,
  resetGoogleCredentialsCache,
  saveGoogleCredentials,
} from "../server/googleCredentials";

const original = {
  ownerDir: process.env.ZENOX_OWNER_DIR,
  ownerSecret: process.env.OWNER_SESSION_SECRET,
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  credentialFile: process.env.ZENOX_GOOGLE_CREDENTIAL_FILE,
};

let dir = "";

describe("encrypted Google OAuth credentials", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zenox-google-"));
    process.env.ZENOX_OWNER_DIR = dir;
    process.env.OWNER_SESSION_SECRET = "test-owner-session-secret-for-google-oauth";
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.ZENOX_GOOGLE_CREDENTIAL_FILE;
    resetGoogleCredentialsCache();
  });

  afterEach(() => {
    resetGoogleCredentialsCache();
    for (const [key, value] of [
      ["ZENOX_OWNER_DIR", original.ownerDir],
      ["OWNER_SESSION_SECRET", original.ownerSecret],
      ["GOOGLE_CLIENT_ID", original.clientId],
      ["GOOGLE_CLIENT_SECRET", original.clientSecret],
      ["ZENOX_GOOGLE_CREDENTIAL_FILE", original.credentialFile],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves the client secret encrypted, not readable in the file", () => {
    const clientId = "1234567890-test.apps.googleusercontent.com";
    const clientSecret = "GOCSPX-test-secret-1234567890";

    expect(saveGoogleCredentials({ clientId, clientSecret }).saved).toBe(true);
    expect(googleConfigured()).toBe(true);
    expect(process.env.GOOGLE_CLIENT_ID).toBe(clientId);
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe(clientSecret);

    const file = googleCredentialFile();
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain(clientId);
    expect(raw).not.toContain(clientSecret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("loads the encrypted credentials again after a restart", () => {
    const clientId = "9876543210-restart.apps.googleusercontent.com";
    const clientSecret = "GOCSPX-restart-secret-9876543210";
    saveGoogleCredentials({ clientId, clientSecret });

    resetGoogleCredentialsCache();
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    ensureGoogleCredentials();

    expect(process.env.GOOGLE_CLIENT_ID).toBe(clientId);
    expect(process.env.GOOGLE_CLIENT_SECRET).toBe(clientSecret);
    expect(googleCredentialSource()).toBe("file");
  });
});
