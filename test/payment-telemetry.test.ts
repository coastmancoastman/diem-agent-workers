import { encodePaymentResponseHeader } from "@x402/core/http";
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { BASE_SEPOLIA_CAIP2, WORKERS } from "../src/constants.js";
import { paymentResponseTelemetryMiddleware } from "../src/payment-telemetry.js";
import type { TelemetryEvent, TelemetrySink } from "../src/telemetry.js";
import { testConfig } from "./helpers.js";

describe("x402 payment response telemetry", () => {
  it("records one sanitized settlement event from the authoritative response header", async () => {
    const config = testConfig({ X402_PRICE_USD: "0.020" });
    const events: TelemetryEvent[] = [];
    const telemetry: TelemetrySink = {
      emit: (event) => events.push(event),
    };
    const encoded = encodePaymentResponseHeader({
      success: true,
      network: BASE_SEPOLIA_CAIP2,
      transaction: "0xprivate-transaction-hash",
      payer: "0xprivate-payer-address",
    });
    const app = express();
    app.use(paymentResponseTelemetryMiddleware(config, telemetry));
    app.post(WORKERS.extractJson.path, (_req, res) => {
      res.setHeader("PAYMENT-RESPONSE", encoded);
      res.setHeader("payment-response", encoded);
      expect(events).toEqual([]);
      res.json({ ok: true });
    });

    await request(app).post(WORKERS.extractJson.path).expect(200, { ok: true });

    expect(events).toEqual([
      {
        event: "x402_payment_settled",
        surface: "worker",
        network: BASE_SEPOLIA_CAIP2,
        phase: "after-handler",
        priceUsd: config.x402PriceUsd,
        worker: WORKERS.extractJson.id,
      },
    ]);
    expect(events[0]).not.toHaveProperty("payer");
    expect(events[0]).not.toHaveProperty("transaction");
  });

  it("does not let malformed settlement metadata change the response", async () => {
    const config = testConfig();
    const events: TelemetryEvent[] = [];
    const app = express();
    app.use(
      paymentResponseTelemetryMiddleware(config, {
        emit: (event) => events.push(event),
      }),
    );
    app.post(WORKERS.extractJson.path, (_req, res) => {
      res.setHeader("PAYMENT-RESPONSE", "not-valid-base64");
      res.json({ ok: true });
    });

    await request(app).post(WORKERS.extractJson.path).expect(200, { ok: true });
    expect(events).toEqual([]);
  });
});
