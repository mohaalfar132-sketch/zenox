import { describe, expect, it } from "vitest";
import { OWNER_THROTTLE, loginBlockedFor, recordLoginFailure, recordLoginSuccess } from "../server/_core/ownerThrottle";

describe("owner login throttle", () => {
  it("locks an address after the allowed failures", () => {
    const key = `test-${Math.random()}`;
    for (let attempt = 1; attempt < OWNER_THROTTLE.maxFailures; attempt += 1) {
      expect(recordLoginFailure(key).lockedSeconds).toBe(0);
      expect(loginBlockedFor(key)).toBe(0);
    }
    expect(recordLoginFailure(key).lockedSeconds).toBeGreaterThan(0);
    expect(loginBlockedFor(key)).toBeGreaterThan(0);
  });

  it("never locks a successful sign-in and clears the counter", () => {
    const key = `test-${Math.random()}`;
    recordLoginFailure(key);
    recordLoginFailure(key);
    recordLoginSuccess(key);
    expect(loginBlockedFor(key)).toBe(0);
    expect(recordLoginFailure(key).lockedSeconds).toBe(0);
  });

  it("keeps addresses independent", () => {
    const locked = `locked-${Math.random()}`;
    for (let attempt = 0; attempt < OWNER_THROTTLE.maxFailures; attempt += 1) recordLoginFailure(locked);
    expect(loginBlockedFor(locked)).toBeGreaterThan(0);
    expect(loginBlockedFor(`other-${Math.random()}`)).toBe(0);
  });
});
