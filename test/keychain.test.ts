import { describe, expect, it } from "vitest";
import { validatePrivateKey } from "../src/treasury/keychain.js";

describe("treasury Keychain secret validation", () => {
  it("accepts only a 32-byte EVM private key", () => {
    expect(validatePrivateKey(`0x${"12".repeat(32)}\n`)).toBe(`0x${"12".repeat(32)}`);
    expect(() => validatePrivateKey("not-a-key")).toThrow(/32-byte/);
  });
});
