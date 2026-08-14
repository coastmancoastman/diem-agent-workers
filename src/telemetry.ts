import type { WorkerId } from "./constants.js";
import { WORKERS } from "./constants.js";

export const TELEMETRY_SCOPE = "diem_agent_storefront";
export const TELEMETRY_SCHEMA_VERSION = 1;

export type TelemetrySurface =
  | "worker"
  | "quote"
  | "a2a"
  | "mcp"
  | "discovery"
  | "health"
  | "treasury_status"
  | "other";

export type TelemetryErrorClass =
  | "invalid_request"
  | "invalid_json"
  | "payload_too_large"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rejected"
  | "payment_failed"
  | "internal_error";

export type TelemetryEvent =
  | {
      event: "request_completed";
      surface: TelemetrySurface;
      method: "GET" | "POST" | "OTHER";
      statusCode: number;
      durationMs: number;
      paymentsMode: "off" | "development" | "production";
      worker?: WorkerId;
      errorClass?: TelemetryErrorClass;
    }
  | {
      event: "worker_completed";
      worker: WorkerId;
      model: string;
      durationMs: number;
      priceUsd: number;
      estimatedDiemCost?: number;
      estimatedGrossMarginUsd?: number;
    }
  | {
      event: "worker_failed";
      worker: WorkerId;
      durationMs: number;
      errorClass: TelemetryErrorClass;
    }
  | {
      event: "x402_payment_settled";
      surface: "worker" | "a2a";
      network: string;
      phase: "before-handler" | "after-handler";
      priceUsd: number;
      worker?: WorkerId;
    }
  | {
      event: "x402_payment_failed";
      surface: "worker" | "a2a";
      phase: "before-handler" | "after-handler";
      worker?: WorkerId;
    };

export interface TelemetrySink {
  emit(event: TelemetryEvent): void;
}

export function emitTelemetry(sink: TelemetrySink, event: TelemetryEvent): void {
  try {
    sink.emit(event);
  } catch {
    // Metrics are deliberately best-effort and must never change a response.
  }
}

function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function duration(value: number): number {
  return Math.max(0, Math.round(finite(value)));
}

function money(value: number): number {
  return Math.max(0, Math.round(finite(value) * 1_000_000_000) / 1_000_000_000);
}

function signedMoney(value: number): number {
  return Math.round(finite(value) * 1_000_000_000) / 1_000_000_000;
}

function safeModel(value: string): string {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(value) ? value : "unknown";
}

function safeNetwork(value: string): string {
  return /^[A-Za-z0-9:_-]{1,80}$/.test(value) ? value : "unknown";
}

/**
 * Rebuild every event from an explicit allowlist. Even a caller that defeats
 * TypeScript cannot smuggle prompts, outputs, payer data, transaction hashes,
 * headers, IPs, or identifiers into the structured log line.
 */
export function sanitizeTelemetryEvent(event: TelemetryEvent): Record<string, unknown> {
  const base = {
    scope: TELEMETRY_SCOPE,
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    timestamp: new Date().toISOString(),
    event: event.event,
  };
  switch (event.event) {
    case "request_completed":
      return {
        ...base,
        surface: event.surface,
        method: event.method,
        statusCode: Math.max(100, Math.min(599, Math.round(event.statusCode))),
        durationMs: duration(event.durationMs),
        paymentsMode: event.paymentsMode,
        ...(event.worker ? { worker: event.worker } : {}),
        ...(event.errorClass ? { errorClass: event.errorClass } : {}),
      };
    case "worker_completed": {
      return {
        ...base,
        worker: event.worker,
        model: safeModel(event.model),
        durationMs: duration(event.durationMs),
        priceUsd: money(event.priceUsd),
        ...(event.estimatedDiemCost !== undefined
          ? { estimatedDiemCost: money(event.estimatedDiemCost) }
          : {}),
        ...(event.estimatedGrossMarginUsd !== undefined
          ? { estimatedGrossMarginUsd: signedMoney(event.estimatedGrossMarginUsd) }
          : {}),
      };
    }
    case "worker_failed":
      return {
        ...base,
        worker: event.worker,
        durationMs: duration(event.durationMs),
        errorClass: event.errorClass,
      };
    case "x402_payment_settled":
      return {
        ...base,
        surface: event.surface,
        network: safeNetwork(event.network),
        phase: event.phase,
        priceUsd: money(event.priceUsd),
        ...(event.worker ? { worker: event.worker } : {}),
      };
    case "x402_payment_failed":
      return {
        ...base,
        surface: event.surface,
        phase: event.phase,
        ...(event.worker ? { worker: event.worker } : {}),
      };
  }
}

export class JsonConsoleTelemetry implements TelemetrySink {
  emit(event: TelemetryEvent): void {
    console.info(JSON.stringify(sanitizeTelemetryEvent(event)));
  }
}

export class NoopTelemetry implements TelemetrySink {
  emit(_event: TelemetryEvent): void {
    // Intentionally empty.
  }
}

const workerByPath = new Map<string, WorkerId>(
  Object.values(WORKERS).map((worker) => [worker.path, worker.id] as const),
);

export function workerForPath(path: string): WorkerId | undefined {
  return workerByPath.get(path);
}

export function classifySurface(path: string): {
  surface: TelemetrySurface;
  worker?: WorkerId;
} {
  const worker = workerForPath(path);
  if (worker) return { surface: "worker", worker };
  if (path === "/a2a") return { surface: "a2a" };
  if (path === "/mcp") return { surface: "mcp" };
  if (path === "/health") return { surface: "health" };
  if (path === "/v1/treasury/status") return { surface: "treasury_status" };
  if (path === "/v1/quote/extract-json") {
    return { surface: "quote", worker: WORKERS.extractJson.id };
  }
  if (path.startsWith("/v1/quote/")) {
    const requested = path.slice("/v1/quote/".length);
    const quoted = Object.values(WORKERS).find((item) => item.id === requested);
    return quoted ? { surface: "quote", worker: quoted.id } : { surface: "quote" };
  }
  if (
    path === "/" ||
    path === "/v1/catalog" ||
    path === "/.well-known/agent-catalog.json" ||
    path === "/.well-known/agent-card.json" ||
    path === "/openapi.json" ||
    path === "/llms.txt" ||
    path === "/robots.txt"
  ) {
    return { surface: "discovery" };
  }
  return { surface: "other" };
}
