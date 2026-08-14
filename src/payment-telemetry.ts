import { decodePaymentResponseHeader } from "@x402/core/http";
import type { RequestHandler } from "express";
import type { AppConfig } from "./config.js";
import type { WorkerId } from "./constants.js";
import { workerPrice } from "./discovery.js";
import {
  emitTelemetry,
  workerForPath,
  type TelemetryEvent,
  type TelemetrySink,
} from "./telemetry.js";

export type PaymentTelemetryContext =
  | { surface: "worker"; worker: WorkerId; priceUsd: number }
  | { surface: "a2a"; priceUsd: number };

const X402_EXTENSION_DIAGNOSTIC_PREFIX = "[x402] extension responses:";
const filteredConsoles = new WeakSet<object>();

/**
 * The x402 client logs Bazaar extension status during verification, before a
 * payment is settled. Some serverless log views retain only that first
 * console.log call. Suppress exactly that redundant diagnostic so the final,
 * structured settlement event is the first console.log for a paid request.
 */
export function suppressX402ExtensionResponseDiagnostics(
  target: Pick<Console, "log"> = console,
): void {
  if (filteredConsoles.has(target)) return;
  const originalLog = target.log.bind(target);
  target.log = (...data: Parameters<Console["log"]>) => {
    if (
      typeof data[0] === "string" &&
      data[0].startsWith(X402_EXTENSION_DIAGNOSTIC_PREFIX)
    ) {
      return;
    }
    originalLog(...data);
  };
  filteredConsoles.add(target);
}

export function paymentTelemetryContextForPath(
  config: AppConfig,
  path: string,
): PaymentTelemetryContext | undefined {
  const worker = workerForPath(path);
  if (worker) {
    return {
      surface: "worker",
      worker,
      priceUsd: workerPrice(config, worker),
    };
  }
  if (path === "/a2a") {
    return { surface: "a2a", priceUsd: config.x402PriceUsd };
  }
  return undefined;
}

export function paymentTelemetryContextFromTransport(
  config: AppConfig,
  transportContext: unknown,
): PaymentTelemetryContext | undefined {
  const request = (
    transportContext as {
      request?: {
        path?: unknown;
        adapter?: { getPath?: unknown };
      };
    } | undefined
  )?.request;
  let path = request?.path;
  if (typeof path !== "string" && typeof request?.adapter?.getPath === "function") {
    try {
      path = request.adapter.getPath();
    } catch {
      path = undefined;
    }
  }
  return typeof path === "string"
    ? paymentTelemetryContextForPath(config, path)
    : undefined;
}

/**
 * Observe the protocol's successful settlement response without retaining its
 * sensitive payer or transaction fields. This runs immediately before the
 * x402 Express middleware, so it sees the authoritative PAYMENT-RESPONSE
 * header even on hosts that stop collecting earlier hook logs.
 */
export function paymentResponseTelemetryMiddleware(
  config: AppConfig,
  telemetry: TelemetrySink,
): RequestHandler {
  return (req, res, next) => {
    const context = paymentTelemetryContextForPath(config, req.path);
    if (!context) {
      next();
      return;
    }

    const originalSetHeader = res.setHeader;
    let settlementRecorded = false;
    let settlementEvent:
      | Extract<
          TelemetryEvent,
          { event: "x402_payment_settled" | "x402_payment_failed" }
        >
      | undefined;
    // The storefront's request_completed listener was registered earlier, so
    // this listener runs afterward and leaves the payment result as the final
    // structured line for hosts that retain one log message per invocation.
    res.once("finish", () => {
      if (settlementEvent) emitTelemetry(telemetry, settlementEvent);
    });
    res.setHeader = function setHeaderWithSettlementTelemetry(name, value) {
      if (!settlementRecorded && name.toLowerCase() === "payment-response") {
        const encoded = typeof value === "string"
          ? value
          : Array.isArray(value)
            ? value.find((item): item is string => typeof item === "string")
            : undefined;
        if (encoded) {
          try {
            const result = decodePaymentResponseHeader(encoded);
            settlementRecorded = true;
            if (result.success) {
              settlementEvent = {
                event: "x402_payment_settled",
                surface: context.surface,
                network: result.network,
                phase: "after-handler",
                priceUsd: context.priceUsd,
                ...(context.surface === "worker"
                  ? { worker: context.worker }
                  : {}),
              };
            } else {
              settlementEvent = {
                event: "x402_payment_failed",
                surface: context.surface,
                phase: "after-handler",
                ...(context.surface === "worker"
                  ? { worker: context.worker }
                  : {}),
              };
            }
          } catch {
            // The protocol middleware owns header validation. Telemetry must
            // remain best-effort and must never alter the paid response.
          }
        }
      }
      return originalSetHeader.call(this, name, value);
    };
    next();
  };
}
