import crypto from "node:crypto";
import { decodePaymentResponseHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { Request, RequestHandler, Response } from "express";
import type { AppConfig } from "./config.js";
import { WORKERS, type WorkerId } from "./constants.js";
import type { ComputeBudgetStore } from "./compute-budget-store.js";
import {
  recordAggregateMetric,
  type AggregateMetricsStore,
} from "./aggregate-metrics-store.js";
import { workerPrice } from "./discovery.js";
import type {
  DeliveryCreditContext,
  DeliveryCreditStore,
} from "./delivery-credit-store.js";
import {
  emitTelemetry,
  workerForPath,
  type DeliveryCreditRejectionReason,
  type TelemetrySink,
} from "./telemetry.js";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/;
const PAYMENT_HEADER_NAMES = ["payment-signature", "x-payment"] as const;
const WORKER_IDS = new Set<WorkerId>(
  Object.values(WORKERS).map((worker) => worker.id),
);

type ContextResult =
  | { kind: "ok"; context: DeliveryCreditContext }
  | { kind: "unpaid" }
  | { kind: "missing_idempotency_key" }
  | { kind: "invalid_idempotency_key" }
  | { kind: "invalid_payment_header" }
  | { kind: "unprotected_path" };

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function fingerprint(secret: string, domain: string, value: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(domain)
    .update("\0")
    .update(value)
    .digest("hex");
}

function a2aWorker(body: unknown): WorkerId | undefined {
  const candidate = (
    body as {
      params?: {
        message?: { parts?: Array<{ data?: { worker?: unknown } }> };
      };
    } | undefined
  )?.params?.message?.parts?.[0]?.data?.worker;
  return typeof candidate === "string" && WORKER_IDS.has(candidate as WorkerId)
    ? (candidate as WorkerId)
    : undefined;
}

function protectedWorker(path: string, body: unknown): WorkerId | undefined {
  return workerForPath(path) ?? (path === "/a2a" ? a2aWorker(body) : undefined);
}

function requestContext(
  config: AppConfig,
  path: string,
  body: unknown,
  paymentHeader: string | undefined,
  idempotencyKey: string | undefined,
): ContextResult {
  const worker = protectedWorker(path, body);
  if (!worker) return { kind: "unprotected_path" };
  if (!paymentHeader) return { kind: "unpaid" };
  if (!idempotencyKey) return { kind: "missing_idempotency_key" };
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return { kind: "invalid_idempotency_key" };
  }
  try {
    decodePaymentSignatureHeader(paymentHeader);
  } catch {
    return { kind: "invalid_payment_header" };
  }
  const secret = config.deliveryCreditHmacSecret;
  if (!secret) throw new Error("Delivery credit HMAC is not configured");
  const canonicalRequest = JSON.stringify(
    canonicalValue({ body, path, worker }),
  );
  return {
    kind: "ok",
    context: {
      worker,
      keyFingerprint: fingerprint(secret, "idempotency-key", idempotencyKey),
      paymentFingerprint: fingerprint(secret, "payment-signature", paymentHeader),
      requestFingerprint: fingerprint(secret, "request", canonicalRequest),
      reservedDiem:
        path === "/a2a" ? config.x402PriceUsd : workerPrice(config, worker),
    },
  };
}

function requestPaymentHeader(req: Request): string | undefined {
  for (const name of PAYMENT_HEADER_NAMES) {
    const value = req.header(name);
    if (value) return value;
  }
  return undefined;
}

function markDeliveryAfterFinish(
  store: DeliveryCreditStore,
  context: DeliveryCreditContext,
  res: Response,
): void {
  res.once("finish", () => {
    const workerCompleted =
      (res.locals.telemetryWorkerEvent as { event?: unknown } | undefined)?.event ===
      "worker_completed";
    if (res.locals.deliveryCreditRetry === true) {
      const update = res.statusCode >= 200 && res.statusCode < 400 && workerCompleted
        ? store.markDelivered(context, Date.now())
        : store.releaseRetry(context, Date.now());
      void update.catch(() => undefined);
      return;
    }
    const encoded = res.getHeader("payment-response");
    if (typeof encoded !== "string") return;
    try {
      const settlement = decodePaymentResponseHeader(encoded);
      if (settlement.success && res.statusCode >= 200 && res.statusCode < 400) {
        void store.markDelivered(context, Date.now()).catch(() => undefined);
      }
    } catch {
      // x402 owns response-header validation. A pending credit is safer than
      // incorrectly marking a delivery complete.
    }
  });
}

function noStore(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
}

/**
 * Require a strong idempotency key only once an x402 payment signature exists.
 * Unpaid discovery requests still receive the normal 402 payment instructions.
 */
export function deliveryCreditMiddleware(
  config: AppConfig,
  store: DeliveryCreditStore,
  telemetry: TelemetrySink,
  computeBudgetStore?: ComputeBudgetStore,
  aggregateMetricsStore?: AggregateMetricsStore,
): RequestHandler {
  return async (req, res, next) => {
    const result = requestContext(
      config,
      req.path,
      req.body,
      requestPaymentHeader(req),
      req.header(IDEMPOTENCY_KEY_HEADER),
    );
    if (result.kind === "unpaid" || result.kind === "unprotected_path") {
      next();
      return;
    }
    if (result.kind === "missing_idempotency_key") {
      noStore(res);
      res.status(428).json({
        error: "idempotency_key_required",
        header: "Idempotency-Key",
        format: "16-128 characters: letters, digits, dot, underscore, colon, or dash",
      });
      return;
    }
    if (result.kind === "invalid_idempotency_key") {
      noStore(res);
      res.status(400).json({ error: "invalid_idempotency_key" });
      return;
    }
    if (result.kind === "invalid_payment_header") {
      next();
      return;
    }

    let claim;
    try {
      claim = await store.checkAndClaim(result.context, Date.now());
    } catch {
      emitTelemetry(telemetry, {
        event: "delivery_credit_rejected",
        worker: result.context.worker,
        reason: "store_unavailable",
      });
      noStore(res);
      res.setHeader("Retry-After", "5");
      res.status(503).json({ error: "delivery_credit_protection_unavailable" });
      return;
    }
    if (claim === "mismatch") {
      emitCreditRejection(telemetry, result.context.worker, "conflict");
      noStore(res);
      res.status(409).json({ error: "idempotency_key_conflict" });
      return;
    }
    if (claim === "delivered") {
      emitCreditRejection(telemetry, result.context.worker, "consumed");
      noStore(res);
      res.status(409).json({ error: "idempotency_key_consumed" });
      return;
    }
    if (claim === "exhausted") {
      emitCreditRejection(telemetry, result.context.worker, "exhausted");
      noStore(res);
      res.status(409).json({ error: "delivery_credit_exhausted" });
      return;
    }
    if (claim === "in_flight") {
      emitCreditRejection(telemetry, result.context.worker, "in_flight");
      noStore(res);
      res.setHeader("Retry-After", "2");
      res.status(409).json({ error: "request_already_in_flight" });
      return;
    }

    res.locals.deliveryCreditContext = result.context;
    if (claim === "retry") {
      if (computeBudgetStore) {
        try {
          const reservation = await computeBudgetStore.reserve(
            result.context.worker,
            result.context.reservedDiem,
            Date.now(),
          );
          if (reservation.status === "exhausted") {
            await store.deferRetry(result.context, Date.now());
            emitTelemetry(telemetry, {
              event: "compute_budget_blocked",
              worker: result.context.worker,
              reason: "exhausted",
            });
            noStore(res);
            res.setHeader("Retry-After", String(reservation.retryAfterSeconds));
            res.status(503).json({
              error: "compute_budget_exhausted",
              resetsAt: reservation.resetsAt,
            });
            return;
          }
          if (aggregateMetricsStore) {
            await recordAggregateMetric(() =>
              aggregateMetricsStore.recordReservation({
                worker: result.context.worker,
                reservedDiem: reservation.reservedDiem,
              }),
            );
          }
          emitTelemetry(telemetry, {
            event: "compute_budget_reserved",
            worker: result.context.worker,
            reservedDiem: reservation.reservedDiem,
          });
        } catch {
          try {
            await store.deferRetry(result.context, Date.now());
          } catch {
            // The retry lease remains bounded even if both stores are unavailable.
          }
          emitTelemetry(telemetry, {
            event: "compute_budget_blocked",
            worker: result.context.worker,
            reason: "store_unavailable",
          });
          noStore(res);
          res.setHeader("Retry-After", "5");
          res.status(503).json({ error: "compute_budget_unavailable" });
          return;
        }
      }
      res.locals.deliveryCreditRetry = true;
      res.setHeader("x-delivery-credit", "redeemed");
      emitTelemetry(telemetry, {
        event: "delivery_credit_redeemed",
        worker: result.context.worker,
      });
    }
    markDeliveryAfterFinish(store, result.context, res);
    next();
  };
}

function emitCreditRejection(
  telemetry: TelemetrySink,
  worker: WorkerId,
  reason: DeliveryCreditRejectionReason,
): void {
  emitTelemetry(telemetry, { event: "delivery_credit_rejected", worker, reason });
}

interface TransportRequest {
  path?: unknown;
  paymentHeader?: unknown;
  adapter?: {
    getPath?: () => unknown;
    getHeader?: (name: string) => unknown;
    getBody?: () => unknown;
  };
}

/** Rebuild the same privacy-preserving context inside x402 lifecycle hooks. */
export function deliveryCreditContextFromTransport(
  config: AppConfig,
  transportContext: unknown,
): DeliveryCreditContext | undefined {
  const transport = transportContext as
    | (TransportRequest & { request?: TransportRequest })
    | undefined;
  const request = transport?.request ?? transport;
  if (!request) return undefined;
  let path = request.path;
  let body: unknown;
  let idempotencyKey: string | undefined;
  let paymentHeader =
    typeof request.paymentHeader === "string" ? request.paymentHeader : undefined;
  try {
    if (typeof path !== "string") path = request.adapter?.getPath?.();
    body = request.adapter?.getBody?.();
    const rawKey = request.adapter?.getHeader?.(IDEMPOTENCY_KEY_HEADER);
    idempotencyKey = typeof rawKey === "string" ? rawKey : undefined;
    if (!paymentHeader) {
      for (const name of PAYMENT_HEADER_NAMES) {
        const raw = request.adapter?.getHeader?.(name);
        if (typeof raw === "string" && raw) {
          paymentHeader = raw;
          break;
        }
      }
    }
  } catch {
    return undefined;
  }
  if (typeof path !== "string") return undefined;
  const result = requestContext(
    config,
    path,
    body,
    paymentHeader,
    idempotencyKey,
  );
  return result.kind === "ok" ? result.context : undefined;
}
