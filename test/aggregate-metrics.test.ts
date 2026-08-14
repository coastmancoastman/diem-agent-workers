import { describe, expect, it } from "vitest";
import { MemoryAggregateMetricsStore } from "../src/aggregate-metrics-store.js";
import { WORKERS } from "../src/constants.js";

describe("privacy-safe aggregate metrics", () => {
  it("keeps only lifetime bounded-cardinality counters", async () => {
    const store = new MemoryAggregateMetricsStore();
    await store.recordRun({
      worker: WORKERS.classifyText.id,
      outcome: "completed",
      durationMs: 2_400,
      estimatedDiemCost: 0.0012345678,
    });
    await store.recordRun({
      worker: WORKERS.classifyText.id,
      outcome: "failed",
      durationMs: 65_000,
      errorClass: "provider_timeout",
    });
    await store.recordSettlement({
      worker: WORKERS.classifyText.id,
      priceUsd: 0.01,
    });
    await store.recordReservation({
      worker: WORKERS.classifyText.id,
      reservedDiem: 0.01,
    });

    const result = await store.snapshot();
    expect(result).toMatchObject({
      available: true,
      scope: "lifetime",
      privacy: {
        timeSeries: false,
        callerIdentifiers: false,
        requestOrResponseContent: false,
      },
      totals: {
        runs: 2,
        completedRuns: 1,
        failedRuns: 1,
        completionRate: 0.5,
        settledJobs: 1,
        settledRevenueUsd: "0.010000",
        estimatedDiemCost: "0.001234568",
        computeReservations: 1,
        reservedDiem: "0.010000000",
        duration: { averageMs: 33_700 },
      },
    });
    const classification = result.workers.find(
      (worker) => worker.worker === WORKERS.classifyText.id,
    );
    expect(classification).toMatchObject({
      runs: 2,
      settledJobs: 1,
      duration: {
        buckets: { le_3000: 1, gt_60000: 1 },
      },
      failures: { provider_timeout: 1 },
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("timestamp");
    expect(serialized).not.toContain("address");
    expect(serialized).not.toContain("requestId");
    expect(serialized).not.toContain("userAgent");
  });
});
