import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { WORKERS } from "../src/constants.js";
import {
  MemoryDeliveryCreditStore,
  type DeliveryCreditContext,
  type DeliveryCreditStore,
} from "../src/delivery-credit-store.js";
import {
  deliveryCreditContextFromTransport,
  deliveryCreditMiddleware,
} from "../src/delivery-credits.js";
import { testConfig } from "./helpers.js";

const config = testConfig({
  DELIVERY_CREDITS_MODE: "enforced",
  DELIVERY_CREDIT_HMAC_SECRET: "test-only-hmac-secret-with-at-least-32-bytes",
  UPSTASH_REDIS_REST_URL: "https://example.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "test-only-token",
});

const context = (
  overrides: Partial<DeliveryCreditContext> = {},
): DeliveryCreditContext => ({
  keyFingerprint: "a".repeat(64),
  paymentFingerprint: "b".repeat(64),
  requestFingerprint: "c".repeat(64),
  worker: WORKERS.extractJson.id,
  ...overrides,
});

const paymentHeader = Buffer.from(
  JSON.stringify({ x402Version: 2, accepted: {}, payload: { signature: "test" } }),
).toString("base64");
const telemetry = { emit: vi.fn() };

function fakeStore(
  check: DeliveryCreditStore["checkAndClaim"],
): DeliveryCreditStore {
  return {
    checkAndClaim: check,
    beginVerified: vi.fn(async () => "started" as const),
    isSettlementReady: vi.fn(async () => true),
    markSettled: vi.fn(async () => true),
    markDelivered: vi.fn(async () => undefined),
    cancelVerified: vi.fn(async () => undefined),
    releaseRetry: vi.fn(async () => undefined),
  };
}

describe("durable delivery credits", () => {
  it("atomically progresses a settled credit through one retry", async () => {
    const store = new MemoryDeliveryCreditStore(3_600, 60);
    const credit = context();
    expect(await store.checkAndClaim(credit, 1_000)).toBe("missing");
    expect(await store.beginVerified(credit, 1_000)).toBe("started");
    expect(await store.checkAndClaim(credit, 1_001)).toBe("in_flight");
    expect(await store.isSettlementReady(credit, 1_002)).toBe(true);
    expect(await store.markSettled(credit, 1_003)).toBe(true);
    expect(await store.checkAndClaim(credit, 1_004)).toBe("retry");
    expect(await store.checkAndClaim(credit, 1_005)).toBe("in_flight");
    await store.markDelivered(credit, 1_006);
    expect(await store.checkAndClaim(credit, 1_007)).toBe("delivered");
  });

  it("never lets one idempotency key cross payment, worker, or request boundaries", async () => {
    const store = new MemoryDeliveryCreditStore();
    const original = context();
    expect(await store.beginVerified(original, 1_000)).toBe("started");
    for (const mismatch of [
      context({ paymentFingerprint: "d".repeat(64) }),
      context({ requestFingerprint: "e".repeat(64) }),
      context({ worker: WORKERS.classifyText.id }),
    ]) {
      expect(await store.checkAndClaim(mismatch, 1_001)).toBe("mismatch");
    }
  });

  it("releases unpaid handler failures and preserves already-settled cancellations", async () => {
    const store = new MemoryDeliveryCreditStore();
    const unpaid = context({ keyFingerprint: "1".repeat(64) });
    await store.beginVerified(unpaid, 1_000);
    await store.cancelVerified(unpaid, false, 1_001);
    expect(await store.checkAndClaim(unpaid, 1_002)).toBe("missing");

    const settled = context({ keyFingerprint: "2".repeat(64) });
    await store.beginVerified(settled, 1_000);
    await store.cancelVerified(settled, true, 1_001);
    expect(await store.checkAndClaim(settled, 1_002)).toBe("retry");
    await store.releaseRetry(settled, 1_003);
    expect(await store.checkAndClaim(settled, 1_004)).toBe("exhausted");
  });

  it("recovers an expired verified lease as a one-time customer credit", async () => {
    const store = new MemoryDeliveryCreditStore(3_600, 60);
    const credit = context();
    await store.beginVerified(credit, 1_000);
    expect(await store.checkAndClaim(credit, 61_001)).toBe("retry");
    expect(await store.checkAndClaim(credit, 121_002)).toBe("exhausted");
  });

  it("redeems only a matching paid retry and stores no request content", async () => {
    let observed: DeliveryCreditContext | undefined;
    const store = fakeStore(async (candidate) => {
      observed = candidate;
      return "retry";
    });
    const app = express();
    app.use(express.json());
    app.use(deliveryCreditMiddleware(config, store, telemetry));
    app.post(WORKERS.extractJson.path, (_req, res) => {
      res.locals.telemetryWorkerEvent = { event: "worker_completed" };
      res.json({ ok: true });
    });

    const privateSource = "private source must never reach storage";
    const response = await request(app)
      .post(WORKERS.extractJson.path)
      .set("payment-signature", paymentHeader)
      .set("idempotency-key", "agent-request-00000001")
      .send({ source: privateSource, schema: { type: "object" } })
      .expect(200, { ok: true });

    expect(response.headers["x-delivery-credit"]).toBe("redeemed");
    expect(store.markDelivered).toHaveBeenCalledOnce();
    expect(JSON.stringify(observed)).not.toContain(privateSource);
    expect(JSON.stringify(observed)).not.toContain("agent-request-00000001");
    expect(JSON.stringify(observed)).not.toContain(paymentHeader);
  });

  it("fails closed before payment when protection is unavailable", async () => {
    const handler = vi.fn((_req, res) => res.json({ ok: true }));
    const store = fakeStore(async () => {
      throw new Error("storage unavailable");
    });
    const app = express();
    app.use(express.json());
    app.use(deliveryCreditMiddleware(config, store, telemetry));
    app.post(WORKERS.extractJson.path, handler);

    const response = await request(app)
      .post(WORKERS.extractJson.path)
      .set("payment-signature", paymentHeader)
      .set("idempotency-key", "agent-request-00000002")
      .send({ source: "safe", schema: { type: "object" } })
      .expect(503);
    expect(response.body.error).toBe("delivery_credit_protection_unavailable");
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires a strong idempotency key only on the signed paid attempt", async () => {
    const store = fakeStore(async () => "missing");
    const app = express();
    app.use(express.json());
    app.use(deliveryCreditMiddleware(config, store, telemetry));
    app.post(WORKERS.extractJson.path, (_req, res) => res.json({ ok: true }));

    await request(app)
      .post(WORKERS.extractJson.path)
      .send({ source: "unpaid" })
      .expect(200, { ok: true });
    const paid = await request(app)
      .post(WORKERS.extractJson.path)
      .set("payment-signature", paymentHeader)
      .send({ source: "paid" })
      .expect(428);
    expect(paid.body.error).toBe("idempotency_key_required");
  });

  it("canonicalizes JSON before hashing without retaining it", async () => {
    const contexts: DeliveryCreditContext[] = [];
    const store = fakeStore(async (candidate) => {
      contexts.push(candidate);
      return "missing";
    });
    const app = express();
    app.use(express.json());
    app.use(deliveryCreditMiddleware(config, store, telemetry));
    app.post(WORKERS.extractJson.path, (_req, res) => res.json({ ok: true }));
    const send = (body: unknown) =>
      request(app)
        .post(WORKERS.extractJson.path)
        .set("payment-signature", paymentHeader)
        .set("idempotency-key", "agent-request-canonical")
        .send(body as object);

    await send({ source: "same", schema: { Z: 1, a: 2, required: ["a"], type: "object" } });
    await send({ schema: { type: "object", a: 2, required: ["a"], Z: 1 }, source: "same" });
    expect(contexts).toHaveLength(2);
    expect(contexts[0]?.requestFingerprint).toBe(contexts[1]?.requestFingerprint);
  });

  it("derives identical hook contexts before and after the handler", () => {
    const body = { source: "private", schema: { type: "object" } };
    const adapter = {
      getPath: () => WORKERS.extractJson.path,
      getBody: () => body,
      getHeader: (name: string) =>
        name === "idempotency-key"
          ? "agent-request-hook-context"
          : name === "payment-signature"
            ? paymentHeader
            : undefined,
    };
    const direct = deliveryCreditContextFromTransport(config, {
      path: WORKERS.extractJson.path,
      paymentHeader,
      adapter,
    });
    const afterHandler = deliveryCreditContextFromTransport(config, {
      request: {
        path: WORKERS.extractJson.path,
        paymentHeader,
        adapter,
      },
      responseBody: Buffer.from("private output"),
    });
    expect(direct).toEqual(afterHandler);
    expect(JSON.stringify(direct)).not.toContain("private");
  });
});
