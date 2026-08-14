import { mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  clearTreasuryState,
  readTreasuryState,
  writeTreasuryState,
} from "../src/treasury/audit.js";

describe("treasury crash journal", () => {
  it("round-trips an owner-only pending transaction atomically", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "diem-state-"));
    const statePath = path.join(directory, "state.json");
    const pending = {
      version: 1 as const,
      status: "pending" as const,
      transaction: `0x${"12".repeat(32)}` as `0x${string}`,
      address: `0x${"34".repeat(20)}` as `0x${string}`,
      sellAmount: "5000000",
      usdcBefore: "10000000",
      diemBefore: "0",
      createdAt: new Date().toISOString(),
    };
    await writeTreasuryState(statePath, pending);
    expect(await readTreasuryState(statePath)).toEqual(pending);
    expect((await stat(statePath)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(pending);
    await clearTreasuryState(statePath);
    expect(await readTreasuryState(statePath)).toBeUndefined();
  });
});
