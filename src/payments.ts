import type { Express } from "express";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import {
  paymentMiddlewareFromHTTPServer,
  type x402HTTPResourceServer,
} from "@x402/express";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  WORKERS,
  type WorkerId,
} from "./constants.js";
import type { AppConfig } from "./config.js";
import { workerContracts, workerPrice } from "./discovery.js";
import { emitTelemetry, type TelemetrySink } from "./telemetry.js";
import {
  paymentResponseTelemetryMiddleware,
  paymentTelemetryContextFromTransport,
  suppressX402ExtensionResponseDiagnostics,
} from "./payment-telemetry.js";
import {
  deliveryCreditContextFromTransport,
  deliveryCreditMiddleware,
} from "./delivery-credits.js";
import type { DeliveryCreditStore } from "./delivery-credit-store.js";

export async function attachPaymentMiddleware(
  app: Express,
  config: AppConfig,
  telemetry: TelemetrySink,
  deliveryCreditStore?: DeliveryCreditStore,
): Promise<void> {
  if (config.paymentsMode === "off") return;
  if (!config.treasuryAddress) {
    throw new Error("Payment middleware requires TREASURY_ADDRESS");
  }
  if (!config.cdpApiKeyId || !config.cdpApiKeySecret) {
    throw new Error("Payment middleware requires CDP facilitator credentials");
  }
  suppressX402ExtensionResponseDiagnostics();

  const network =
    config.paymentsMode === "development" ? BASE_SEPOLIA_CAIP2 : BASE_CAIP2;
  // CDP injects minimal Bazaar metadata on every route. Add our richer schema
  // metadata only for public HTTPS deployments; CDP rejects local HTTP URLs
  // during discovery validation, so local settlements cannot be indexed.
  const workerRoutes = Object.values(WORKERS).map((worker) => {
      const contract = workerContracts[worker.id];
      const extensions = config.publicBaseUrl.startsWith("https://")
        ? declareDiscoveryExtension({
            bodyType: "json",
            input: contract.input,
            inputSchema: contract.inputSchema,
            output: { example: contract.output },
          })
        : {};
      return [
        `POST ${worker.path}`,
        {
          price: `$${workerPrice(config, worker.id).toFixed(3)}`,
          description: worker.description,
          networks: [network],
          extensions,
        },
      ] as const;
    });
  const routes = Object.fromEntries([
    ...workerRoutes,
    [
      "POST /a2a",
      {
        price: `$${config.x402PriceUsd.toFixed(3)}`,
        description:
          "A2A 1.0 JSON-RPC adapter for synchronous DIEM Agent Workers. SendMessage accepts one JSON data part containing worker and input.",
        networks: [network],
      },
    ],
  ]);
  const server = await createX402Server({
    apiKeyId: config.cdpApiKeyId,
    apiKeySecret: config.cdpApiKeySecret,
    environment: config.paymentsMode,
    payToConfig: { type: "address", evm: config.treasuryAddress },
    builderCode: "diem_agent_workers",
    routes,
  });

  if (deliveryCreditStore) {
    server.resourceServer.onAfterVerify(async ({ transportContext }) => {
      const context = deliveryCreditContextFromTransport(config, transportContext);
      if (!context) {
        return {
          abort: true,
          reason: "delivery_credit_context_missing",
          message: "A valid Idempotency-Key is required",
        };
      }
      try {
        const result = await deliveryCreditStore.beginVerified(context, Date.now());
        if (result === "started") return;
        return {
          abort: true,
          reason: `delivery_credit_${result}`,
          message: "The idempotency key cannot start another paid request",
        };
      } catch {
        return {
          abort: true,
          reason: "delivery_credit_store_unavailable",
          message: "Paid delivery protection is temporarily unavailable",
        };
      }
    });
    server.resourceServer.onBeforeSettle(async ({ transportContext }) => {
      const context = deliveryCreditContextFromTransport(config, transportContext);
      if (!context) {
        return {
          abort: true,
          reason: "delivery_credit_context_missing",
          message: "Paid delivery protection is unavailable",
        };
      }
      try {
        if (await deliveryCreditStore.isSettlementReady(context, Date.now())) return;
      } catch {
        // Fall through to the fail-closed settlement abort below.
      }
      return {
        abort: true,
        reason: "delivery_credit_not_ready",
        message: "Paid delivery protection is unavailable",
      };
    });
    server.resourceServer.onAfterSettle(async ({ transportContext }) => {
      const context = deliveryCreditContextFromTransport(config, transportContext);
      if (!context) throw new Error("Delivery credit context missing after settlement");
      const recorded = await deliveryCreditStore.markSettled(context, Date.now());
      if (!recorded) {
        throw new Error("Delivery credit settlement transition failed");
      }
    });
    server.resourceServer.onVerifiedPaymentCanceled(
      async ({ transportContext, settledPhases }) => {
        const context = deliveryCreditContextFromTransport(config, transportContext);
        if (!context) return;
        await deliveryCreditStore.cancelVerified(
          context,
          settledPhases.length > 0,
          Date.now(),
        );
      },
    );
  }

  server.resourceServer.onSettleFailure(async ({ phase, transportContext }) => {
    if (deliveryCreditStore) {
      const creditContext = deliveryCreditContextFromTransport(
        config,
        transportContext,
      );
      if (creditContext) {
        try {
          await deliveryCreditStore.cancelVerified(
            creditContext,
            false,
            Date.now(),
          );
        } catch {
          // The short lease prevents a storage outage from permanently
          // consuming a retry. Payment failure telemetry still proceeds.
        }
      }
    }
    if (phase === "cancel") return;
    const context = paymentTelemetryContextFromTransport(config, transportContext);
    if (!context) return;
    emitTelemetry(telemetry, {
      event: "x402_payment_failed",
      surface: context.surface,
      phase,
      ...(context.surface === "worker" ? { worker: context.worker } : {}),
    });
  });
  // The CDP class extends this exact x402 server at runtime. Its published
  // declarations currently resolve the private base field through a separate
  // type path, so TypeScript cannot prove the documented compatibility.
  app.use(paymentResponseTelemetryMiddleware(config, telemetry));
  if (deliveryCreditStore) {
    app.use(deliveryCreditMiddleware(config, deliveryCreditStore, telemetry));
  }
  const paymentHandler = paymentMiddlewareFromHTTPServer(
    server as unknown as x402HTTPResourceServer,
  );
  app.use((req, res, next) => {
    if (res.locals.deliveryCreditRetry === true) {
      next();
      return;
    }
    return paymentHandler(req, res, next);
  });
}
