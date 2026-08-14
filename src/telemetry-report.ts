import {
  TELEMETRY_SCHEMA_VERSION,
  TELEMETRY_SCOPE,
  type TelemetryErrorClass,
} from "./telemetry.js";

type StoredEvent = Record<string, unknown>;

export interface WorkerTelemetrySummary {
  completed: number;
  failed: number;
  settledPayments: number;
  settledRevenueUsd: number;
  estimatedDiemCost: number;
  estimatedGrossMarginUsd: number;
  pricedCostSamples: number;
  p50DurationMs: number | null;
  p95DurationMs: number | null;
  failures: Partial<Record<TelemetryErrorClass, number>>;
}

export interface TelemetrySummary {
  schemaVersion: number;
  generatedAt: string;
  inputEvents: number;
  requests: {
    total: number;
    successful: number;
    paymentRequired: number;
    clientErrors: number;
    serverErrors: number;
    bySurface: Record<string, number>;
  };
  payments: {
    settled: number;
    failed: number;
    settledRevenueUsd: number;
  };
  workers: Record<string, WorkerTelemetrySummary>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1),
  );
  return Math.round(sorted[index] ?? 0);
}

function emptyWorker(): WorkerTelemetrySummary & { durations: number[] } {
  return {
    completed: 0,
    failed: 0,
    settledPayments: 0,
    settledRevenueUsd: 0,
    estimatedDiemCost: 0,
    estimatedGrossMarginUsd: 0,
    pricedCostSamples: 0,
    p50DurationMs: null,
    p95DurationMs: null,
    failures: {},
    durations: [],
  };
}

/** Parse either a direct telemetry JSON line or a Vercel JSON log wrapper. */
export function parseTelemetryLine(line: string): StoredEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as StoredEvent;
  if (record.scope === TELEMETRY_SCOPE) return record;
  for (const field of ["message", "text"] as const) {
    const nested = record[field];
    if (typeof nested !== "string") continue;
    try {
      const event = JSON.parse(nested) as unknown;
      if (
        typeof event === "object" &&
        event !== null &&
        !Array.isArray(event) &&
        (event as StoredEvent).scope === TELEMETRY_SCOPE
      ) {
        return event as StoredEvent;
      }
    } catch {
      // Non-JSON platform log lines are outside this report.
    }
  }
  return undefined;
}

export function summarizeTelemetry(events: StoredEvent[]): TelemetrySummary {
  const workers = new Map<string, ReturnType<typeof emptyWorker>>();
  const workerSummary = (worker: string) => {
    const existing = workers.get(worker);
    if (existing) return existing;
    const created = emptyWorker();
    workers.set(worker, created);
    return created;
  };
  const requests = {
    total: 0,
    successful: 0,
    paymentRequired: 0,
    clientErrors: 0,
    serverErrors: 0,
    bySurface: {} as Record<string, number>,
  };
  const payments = { settled: 0, failed: 0, settledRevenueUsd: 0 };

  for (const event of events) {
    if (
      event.scope !== TELEMETRY_SCOPE ||
      event.schemaVersion !== TELEMETRY_SCHEMA_VERSION
    ) {
      continue;
    }
    if (event.event === "request_completed") {
      const status = finiteNumber(event.statusCode);
      const surface = typeof event.surface === "string" ? event.surface : "other";
      requests.total += 1;
      requests.bySurface[surface] = (requests.bySurface[surface] ?? 0) + 1;
      if (status !== undefined) {
        if (status >= 200 && status < 400) requests.successful += 1;
        if (status === 402) requests.paymentRequired += 1;
        if (status >= 400 && status < 500) requests.clientErrors += 1;
        if (status >= 500) requests.serverErrors += 1;
      }
      continue;
    }
    if (event.event === "worker_completed" && typeof event.worker === "string") {
      const summary = workerSummary(event.worker);
      summary.completed += 1;
      const duration = finiteNumber(event.durationMs);
      if (duration !== undefined && duration >= 0) summary.durations.push(duration);
      const cost = finiteNumber(event.estimatedDiemCost);
      const margin = finiteNumber(event.estimatedGrossMarginUsd);
      if (cost !== undefined) {
        summary.estimatedDiemCost += cost;
        summary.pricedCostSamples += 1;
      }
      if (margin !== undefined) summary.estimatedGrossMarginUsd += margin;
      continue;
    }
    if (event.event === "worker_failed" && typeof event.worker === "string") {
      const summary = workerSummary(event.worker);
      summary.failed += 1;
      const errorClass = typeof event.errorClass === "string"
        ? (event.errorClass as TelemetryErrorClass)
        : "internal_error";
      summary.failures[errorClass] = (summary.failures[errorClass] ?? 0) + 1;
      continue;
    }
    if (event.event === "x402_payment_settled") {
      payments.settled += 1;
      const price = finiteNumber(event.priceUsd) ?? 0;
      payments.settledRevenueUsd += price;
      if (typeof event.worker === "string") {
        const summary = workerSummary(event.worker);
        summary.settledPayments += 1;
        summary.settledRevenueUsd += price;
      }
      continue;
    }
    if (event.event === "x402_payment_failed") payments.failed += 1;
  }

  const publicWorkers: Record<string, WorkerTelemetrySummary> = {};
  for (const [worker, summary] of workers) {
    publicWorkers[worker] = {
      completed: summary.completed,
      failed: summary.failed,
      settledPayments: summary.settledPayments,
      settledRevenueUsd: roundMoney(summary.settledRevenueUsd),
      estimatedDiemCost: roundMoney(summary.estimatedDiemCost),
      estimatedGrossMarginUsd: roundMoney(summary.estimatedGrossMarginUsd),
      pricedCostSamples: summary.pricedCostSamples,
      p50DurationMs: percentile(summary.durations, 0.5),
      p95DurationMs: percentile(summary.durations, 0.95),
      failures: summary.failures,
    };
  }

  return {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    inputEvents: events.length,
    requests,
    payments: {
      ...payments,
      settledRevenueUsd: roundMoney(payments.settledRevenueUsd),
    },
    workers: publicWorkers,
  };
}
