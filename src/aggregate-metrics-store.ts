import { Redis } from "@upstash/redis";
import type { AppConfig } from "./config.js";
import { WORKERS, type WorkerId } from "./constants.js";
import type { TelemetryErrorClass } from "./telemetry.js";

const METRICS_KEY = "diem:aggregate-metrics:v1";
const MICRO_USDC = 1_000_000;
const NANO_DIEM = 1_000_000_000;

const ERROR_CLASSES = [
  "invalid_request",
  "invalid_json",
  "payload_too_large",
  "provider_timeout",
  "provider_unavailable",
  "provider_rejected",
  "payment_failed",
  "internal_error",
] as const satisfies readonly TelemetryErrorClass[];

const DURATION_BUCKETS = [
  "le_1000",
  "le_3000",
  "le_10000",
  "le_30000",
  "le_60000",
  "gt_60000",
] as const;

type DurationBucket = (typeof DURATION_BUCKETS)[number];

export interface AggregateRunMetric {
  worker: WorkerId;
  outcome: "completed" | "failed";
  durationMs: number;
  estimatedDiemCost?: number;
  errorClass?: TelemetryErrorClass;
}

export interface AggregateSettlementMetric {
  worker: WorkerId;
  priceUsd: number;
}

export interface AggregateReservationMetric {
  worker: WorkerId;
  reservedDiem: number;
}

export interface AggregateDurationSnapshot {
  averageMs: number | null;
  buckets: Record<DurationBucket, number>;
}

export interface AggregateWorkerSnapshot {
  worker: WorkerId;
  runs: number;
  completedRuns: number;
  failedRuns: number;
  completionRate: number | null;
  settledJobs: number;
  settledRevenueUsd: string;
  estimatedDiemCost: string;
  computeReservations: number;
  reservedDiem: string;
  duration: AggregateDurationSnapshot;
  failures: Record<TelemetryErrorClass, number>;
}

export interface AggregateMetricsSnapshot {
  available: true;
  scope: "lifetime";
  privacy: {
    timeSeries: false;
    callerIdentifiers: false;
    requestOrResponseContent: false;
  };
  totals: Omit<AggregateWorkerSnapshot, "worker">;
  workers: AggregateWorkerSnapshot[];
}

export interface AggregateMetricsStore {
  recordRun(metric: AggregateRunMetric): Promise<void>;
  recordReservation(metric: AggregateReservationMetric): Promise<void>;
  recordSettlement(metric: AggregateSettlementMetric): Promise<void>;
  snapshot(): Promise<AggregateMetricsSnapshot>;
}

function safeUnits(name: string, value: number, scale: number): number {
  const units = Math.ceil(value * scale);
  if (!Number.isSafeInteger(units) || units < 0) {
    throw new Error(`${name} must convert to a non-negative safe integer`);
  }
  return units;
}

function safeDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Metric duration must be non-negative and finite");
  }
  return Math.min(120_000, Math.round(value));
}

function durationBucket(durationMs: number): DurationBucket {
  if (durationMs <= 1_000) return "le_1000";
  if (durationMs <= 3_000) return "le_3000";
  if (durationMs <= 10_000) return "le_10000";
  if (durationMs <= 30_000) return "le_30000";
  if (durationMs <= 60_000) return "le_60000";
  return "gt_60000";
}

function increment(
  values: Map<string, number>,
  field: string,
  amount: number,
): void {
  values.set(field, (values.get(field) ?? 0) + amount);
}

function runFields(metric: AggregateRunMetric): Array<[string, number]> {
  const durationMs = safeDuration(metric.durationMs);
  const estimatedDiemNano = metric.estimatedDiemCost === undefined
    ? 0
    : safeUnits("Estimated DIEM cost", metric.estimatedDiemCost, NANO_DIEM);
  const prefix = `worker:${metric.worker}`;
  const fields: Array<[string, number]> = [
    ["runs", 1],
    [`runs:${metric.outcome}`, 1],
    ["duration_ms", durationMs],
    [`duration:${durationBucket(durationMs)}`, 1],
    [`${prefix}:runs`, 1],
    [`${prefix}:runs:${metric.outcome}`, 1],
    [`${prefix}:duration_ms`, durationMs],
    [`${prefix}:duration:${durationBucket(durationMs)}`, 1],
  ];
  if (estimatedDiemNano > 0) {
    fields.push(
      ["estimated_diem_nano", estimatedDiemNano],
      [`${prefix}:estimated_diem_nano`, estimatedDiemNano],
    );
  }
  if (metric.outcome === "failed" && metric.errorClass) {
    fields.push(
      [`failure:${metric.errorClass}`, 1],
      [`${prefix}:failure:${metric.errorClass}`, 1],
    );
  }
  return fields;
}

function settlementFields(
  metric: AggregateSettlementMetric,
): Array<[string, number]> {
  const revenueMicro = safeUnits("Settlement price", metric.priceUsd, MICRO_USDC);
  const prefix = `worker:${metric.worker}`;
  return [
    ["settled_jobs", 1],
    ["settled_revenue_micro_usdc", revenueMicro],
    [`${prefix}:settled_jobs`, 1],
    [`${prefix}:settled_revenue_micro_usdc`, revenueMicro],
  ];
}

function reservationFields(
  metric: AggregateReservationMetric,
): Array<[string, number]> {
  const reservedDiemNano = safeUnits(
    "Reserved DIEM",
    metric.reservedDiem,
    NANO_DIEM,
  );
  const prefix = `worker:${metric.worker}`;
  return [
    ["compute_reservations", 1],
    ["reserved_diem_nano", reservedDiemNano],
    [`${prefix}:compute_reservations`, 1],
    [`${prefix}:reserved_diem_nano`, reservedDiemNano],
  ];
}

function value(values: ReadonlyMap<string, number>, field: string): number {
  return values.get(field) ?? 0;
}

function durationSnapshot(
  values: ReadonlyMap<string, number>,
  prefix: string,
): AggregateDurationSnapshot {
  const runs = value(values, `${prefix}runs`);
  const durationMs = value(values, `${prefix}duration_ms`);
  return {
    averageMs: runs > 0 ? Math.round(durationMs / runs) : null,
    buckets: Object.fromEntries(
      DURATION_BUCKETS.map((bucket) => [
        bucket,
        value(values, `${prefix}duration:${bucket}`),
      ]),
    ) as Record<DurationBucket, number>,
  };
}

function failureSnapshot(
  values: ReadonlyMap<string, number>,
  prefix: string,
): Record<TelemetryErrorClass, number> {
  return Object.fromEntries(
    ERROR_CLASSES.map((errorClass) => [
      errorClass,
      value(values, `${prefix}failure:${errorClass}`),
    ]),
  ) as Record<TelemetryErrorClass, number>;
}

function workerSnapshot(
  values: ReadonlyMap<string, number>,
  worker: WorkerId,
): AggregateWorkerSnapshot {
  const prefix = `worker:${worker}:`;
  const runs = value(values, `${prefix}runs`);
  const completedRuns = value(values, `${prefix}runs:completed`);
  return {
    worker,
    runs,
    completedRuns,
    failedRuns: value(values, `${prefix}runs:failed`),
    completionRate: runs > 0 ? Number((completedRuns / runs).toFixed(4)) : null,
    settledJobs: value(values, `${prefix}settled_jobs`),
    settledRevenueUsd: (
      value(values, `${prefix}settled_revenue_micro_usdc`) / MICRO_USDC
    ).toFixed(6),
    estimatedDiemCost: (
      value(values, `${prefix}estimated_diem_nano`) / NANO_DIEM
    ).toFixed(9),
    computeReservations: value(values, `${prefix}compute_reservations`),
    reservedDiem: (
      value(values, `${prefix}reserved_diem_nano`) / NANO_DIEM
    ).toFixed(9),
    duration: durationSnapshot(values, prefix),
    failures: failureSnapshot(values, prefix),
  };
}

function snapshot(values: ReadonlyMap<string, number>): AggregateMetricsSnapshot {
  const workers = Object.values(WORKERS).map((worker) =>
    workerSnapshot(values, worker.id),
  );
  const runs = value(values, "runs");
  const completedRuns = value(values, "runs:completed");
  return {
    available: true,
    scope: "lifetime",
    privacy: {
      timeSeries: false,
      callerIdentifiers: false,
      requestOrResponseContent: false,
    },
    totals: {
      runs,
      completedRuns,
      failedRuns: value(values, "runs:failed"),
      completionRate: runs > 0 ? Number((completedRuns / runs).toFixed(4)) : null,
      settledJobs: value(values, "settled_jobs"),
      settledRevenueUsd: (
        value(values, "settled_revenue_micro_usdc") / MICRO_USDC
      ).toFixed(6),
      estimatedDiemCost: (
        value(values, "estimated_diem_nano") / NANO_DIEM
      ).toFixed(9),
      computeReservations: value(values, "compute_reservations"),
      reservedDiem: (value(values, "reserved_diem_nano") / NANO_DIEM).toFixed(9),
      duration: durationSnapshot(values, ""),
      failures: failureSnapshot(values, ""),
    },
    workers,
  };
}

/** Deterministic test/local implementation with the same aggregate-only schema. */
export class MemoryAggregateMetricsStore implements AggregateMetricsStore {
  private readonly values = new Map<string, number>();

  async recordRun(metric: AggregateRunMetric): Promise<void> {
    for (const [field, amount] of runFields(metric)) {
      increment(this.values, field, amount);
    }
  }

  async recordSettlement(metric: AggregateSettlementMetric): Promise<void> {
    for (const [field, amount] of settlementFields(metric)) {
      increment(this.values, field, amount);
    }
  }

  async recordReservation(metric: AggregateReservationMetric): Promise<void> {
    for (const [field, amount] of reservationFields(metric)) {
      increment(this.values, field, amount);
    }
  }

  async snapshot(): Promise<AggregateMetricsSnapshot> {
    return snapshot(this.values);
  }
}

const INCREMENT_SCRIPT = `
for index = 1, #ARGV, 2 do
  local amount = tonumber(ARGV[index + 1])
  if not amount or amount < 0 then
    return redis.error_reply('invalid aggregate metric increment')
  end
  if amount > 0 then
    redis.call('HINCRBY', KEYS[1], ARGV[index], ARGV[index + 1])
  end
end
return 1
`;

export class UpstashAggregateMetricsStore implements AggregateMetricsStore {
  private readonly redis: Redis;

  constructor(url: string, token: string) {
    this.redis = new Redis({
      url,
      token,
      automaticDeserialization: false,
      enableTelemetry: false,
      readYourWrites: true,
    });
  }

  private async record(fields: Array<[string, number]>): Promise<void> {
    const args = fields.flatMap(([field, amount]) => [field, String(amount)]);
    await this.redis.eval<string[], number>(INCREMENT_SCRIPT, [METRICS_KEY], args);
  }

  async recordRun(metric: AggregateRunMetric): Promise<void> {
    await this.record(runFields(metric));
  }

  async recordSettlement(metric: AggregateSettlementMetric): Promise<void> {
    await this.record(settlementFields(metric));
  }

  async recordReservation(metric: AggregateReservationMetric): Promise<void> {
    await this.record(reservationFields(metric));
  }

  async snapshot(): Promise<AggregateMetricsSnapshot> {
    const raw = await this.redis.hgetall<Record<string, string | number>>(METRICS_KEY);
    const values = new Map<string, number>();
    for (const [field, rawValue] of Object.entries(raw ?? {})) {
      const parsed = Number(rawValue);
      if (Number.isSafeInteger(parsed) && parsed >= 0) values.set(field, parsed);
    }
    return snapshot(values);
  }
}

/** Keep observability fail-open and bounded on the paid response path. */
export async function recordAggregateMetric(
  operation: () => Promise<void>,
  timeoutMs = 750,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      operation().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
      }),
    ]);
  } catch {
    // A synchronous store failure is best-effort too.
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createAggregateMetricsStore(
  config: AppConfig,
): AggregateMetricsStore | undefined {
  if (config.aggregateMetricsMode === "off") return undefined;
  if (!config.upstashRedisRestUrl || !config.upstashRedisRestToken) {
    throw new Error("Aggregate metrics storage is not configured");
  }
  return new UpstashAggregateMetricsStore(
    config.upstashRedisRestUrl,
    config.upstashRedisRestToken,
  );
}
