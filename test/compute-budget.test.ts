import { describe, expect, it } from "vitest";
import { MemoryComputeBudgetStore } from "../src/compute-budget-store.js";
import { WORKERS } from "../src/constants.js";

describe("global compute budget", () => {
  it("atomically stops reservations before the daily cap is exceeded", async () => {
    const store = new MemoryComputeBudgetStore(0.05);
    const now = Date.UTC(2026, 7, 14, 12);
    expect(
      await store.reserve(WORKERS.extractJson.id, 0.02, now),
    ).toMatchObject({ status: "reserved", spentDiem: 0.02, remainingDiem: 0.03 });
    expect(
      await store.reserve(WORKERS.summarizeText.id, 0.02, now + 1),
    ).toMatchObject({ status: "reserved", spentDiem: 0.04, remainingDiem: 0.01 });
    expect(
      await store.reserve(WORKERS.generateDraftImage.id, 0.02, now + 2),
    ).toMatchObject({ status: "exhausted", spentDiem: 0.04, remainingDiem: 0.01 });
  });

  it("resets on a UTC-day boundary", async () => {
    const store = new MemoryComputeBudgetStore(0.02);
    const beforeMidnight = Date.UTC(2026, 7, 14, 23, 59, 59);
    expect(
      await store.reserve(WORKERS.extractJson.id, 0.02, beforeMidnight),
    ).toMatchObject({ status: "reserved" });
    expect(
      await store.reserve(WORKERS.extractJson.id, 0.02, beforeMidnight + 1_001),
    ).toMatchObject({ status: "reserved", spentDiem: 0.02 });
  });
});
