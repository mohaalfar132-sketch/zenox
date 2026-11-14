import { afterEach, describe, expect, it } from "vitest";

import { GOOGLE_SCOPES, googleAuthUrl, safeReturnTo } from "../server/google";

describe("google oauth", () => {
  const previousId = process.env.GOOGLE_CLIENT_ID;
  const previousSecret = process.env.GOOGLE_CLIENT_SECRET;

  afterEach(() => {
    if (previousId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousId;
    if (previousSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousSecret;
  });

  it("keeps only same-origin return paths", () => {
    expect(safeReturnTo("/google")).toBe("/google");
    expect(safeReturnTo("//evil.example")).toBe("/");
    expect(safeReturnTo("https://evil.example")).toBe("/");
    expect(safeReturnTo("/\\evil.example")).toBe("/");
  });

  it("requests Gmail and Drive scopes with offline access", () => {
    process.env.GOOGLE_CLIENT_ID = "test-client.apps.googleusercontent.com";
    process.env.GOOGLE_CLIENT_SECRET = "test-secret";
    const url = new URL(
      googleAuthUrl({ redirectUri: "https://example.test/api/google/callback", state: "signed-state" }),
    );
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("redirect_uri")).toBe("https://example.test/api/google/callback");
    const scopes = url.searchParams.get("scope")?.split(" ") ?? [];
    expect(scopes).toEqual(expect.arrayContaining([...GOOGLE_SCOPES]));
    expect(scopes).toEqual(
      expect.arrayContaining([
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/drive",
      ]),
    );
  });
});
