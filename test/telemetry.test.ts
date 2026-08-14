import { describe, expect, it, vi } from "vitest";
import { VeniceCatalogCostEstimator } from "../src/costs.js";
import { WORKERS } from "../src/constants.js";
import {
  TELEMETRY_SCOPE,
  classifySurface,
  sanitizeTelemetryEvent,
} from "../src/telemetry.js";
import {
  parseTelemetryLine,
  summarizeTelemetry,
} from "../src/telemetry-report.js";
import { testConfig } from "./helpers.js";

describe("privacy-preserving telemetry", () => {
  it("rebuilds events from an allowlist and drops identifying or content fields", () => {
    const event = {
      event: "worker_completed",
      worker: WORKERS.extractJson.id,
      model: "venice-uncensored-1-2",
      durationMs: 125.4,
      priceUsd: 0.02,
      estimatedDiemCost: 0.0002,
      estimatedGrossMarginUsd: 0.0198,
      prompt: "private customer text",
      output: { secret: true },
      payer: "0x1111111111111111111111111111111111111111",
      transaction: "0xdeadbeef",
      requestId: "customer-correlator",
      inputTokens: 999,
    } as never;
    const sanitized = sanitizeTelemetryEvent(event);
    expect(sanitized).toMatchObject({
      scope: TELEMETRY_SCOPE,
      event: "worker_completed",
      worker: WORKERS.extractJson.id,
      durationMs: 125,
      priceUsd: 0.02,
      estimatedDiemCost: 0.0002,
    });
    for (const forbidden of [
      "prompt",
      "output",
      "payer",
      "transaction",
      "requestId",
      "inputTokens",
    ]) {
      expect(sanitized).not.toHaveProperty(forbidden);
    }
  });

  it("classifies routes without retaining raw paths", () => {
    expect(classifySurface(WORKERS.classifyText.path)).toEqual({
      surface: "worker",
      worker: WORKERS.classifyText.id,
    });
    expect(classifySurface("/customer/private/path")).toEqual({ surface: "other" });
  });

  it("estimates DIEM cost from live-catalog pricing without blocking the call", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "text-model",
              model_spec: {
                pricing: {
                  input: { diem: 0.2 },
                  output: { diem: 0.9 },
                },
              },
            },
            {
              id: "image-model",
              model_spec: { pricing: { generation: { diem: 0.01 } } },
            },
          ],
        }),
      ),
    );
    const estimator = new VeniceCatalogCostEstimator(
      testConfig({ VENICE_API_KEY: "test-key" }),
      fetchMock as typeof fetch,
    );
    estimator.warm();
    expect(
      estimator.estimate({
        worker: WORKERS.extractJson.id,
        model: "text-model",
        inputTokens: 1_000,
        outputTokens: 500,
      }),
    ).toBeUndefined();
    await vi.waitFor(() => {
      expect(
        estimator.estimate({
          worker: WORKERS.extractJson.id,
          model: "text-model",
          inputTokens: 1_000,
          outputTokens: 500,
        }),
      ).toBe(0.00065);
    });
    expect(
      estimator.estimate({
        worker: WORKERS.generateDraftImage.id,
        model: "image-model",
      }),
    ).toBe(0.01);
  });

  it("summarizes direct and Vercel-wrapped events without content fields", () => {
    const direct = JSON.stringify({
      scope: TELEMETRY_SCOPE,
      schemaVersion: 1,
      event: "x402_payment_settled",
      worker: WORKERS.classifyText.id,
      priceUsd: 0.005,
    });
    const wrapped = JSON.stringify({
      message: JSON.stringify({
        scope: TELEMETRY_SCOPE,
        schemaVersion: 1,
        event: "worker_completed",
        worker: WORKERS.classifyText.id,
        durationMs: 200,
        estimatedDiemCost: 0.0001,
        estimatedGrossMarginUsd: 0.0049,
      }),
    });
    const events = [parseTelemetryLine(direct), parseTelemetryLine(wrapped)].filter(
      (event): event is Record<string, unknown> => event !== undefined,
    );
    const report = summarizeTelemetry(events);
    expect(report.payments).toMatchObject({
      settled: 1,
      settledRevenueUsd: 0.005,
    });
    expect(report.workers[WORKERS.classifyText.id]).toMatchObject({
      completed: 1,
      settledPayments: 1,
      estimatedDiemCost: 0.0001,
      p50DurationMs: 200,
    });
  });
});
