import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSealedBlob, sealSecrets } from "../server/_core/ownerSecrets";

const envText = "JWT_SECRET=abc\nOPENAI_API_KEY=sk-test\n# comment\nPORT=3000\n";

describe("the sealed secrets file", () => {
  const key = randomBytes(32);

  it("round-trips the whole .env with AES-256-GCM", () => {
    const blob = sealSecrets(envText, key);
    expect(blob.alg).toBe("aes-256-gcm");
    expect(blob.data).not.toContain("sk-test");
    expect(openSealedBlob(blob, key)).toBe(envText);
  });

  it("refuses the wrong key and any tampering", () => {
    const blob = sealSecrets(envText, key);
    expect(() => openSealedBlob(blob, randomBytes(32))).toThrow();
    const tampered = { ...blob, data: Buffer.from("bm90IHRoZSBzZWNyZXQ=", "base64").toString("base64") };
    expect(() => openSealedBlob(tampered, key)).toThrow();
  });
});
