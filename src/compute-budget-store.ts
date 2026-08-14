import { Redis } from "@upstash/redis";
import type { AppConfig } from "./config.js";
import type { WorkerId } from "./constants.js";

const NANO_DIEM = 1_000_000_000;

export interface ComputeBudgetReservation {
  status: "reserved" | "exhausted";
  reservedDiem: number;
  spentDiem: number;
  remainingDiem: number;
  resetsAt: string;
  retryAfterSeconds: number;
}

export interface ComputeBudgetStore {
  reserve(
    worker: WorkerId,
    reservedDiem: number,
    nowMs: number,
  ): Promise<ComputeBudgetReservation>;
}

function toNanoDiem(value: number): number {
  const units = Math.ceil(value * NANO_DIEM);
  if (!Number.isSafeInteger(units) || units <= 0) {
    throw new Error("Compute budget reservation must be a positive safe integer");
  }
  return units;
}

function utcWindow(nowMs: number): {
  keySuffix: string;
  resetsAt: string;
  retryAfterSeconds: number;
  expiresAtSeconds: number;
} {
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid compute budget time");
  const start = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const reset = start + 86_400_000;
  return {
    keySuffix: new Date(start).toISOString().slice(0, 10),
    resetsAt: new Date(reset).toISOString(),
    retryAfterSeconds: Math.max(1, Math.ceil((reset - nowMs) / 1_000)),
    // Retain the aggregate counter for one additional day for incident review.
    expiresAtSeconds: Math.floor((reset + 86_400_000) / 1_000),
  };
}

function result(
  status: ComputeBudgetReservation["status"],
  reservedNano: number,
  spentNano: number,
  capNano: number,
  window: ReturnType<typeof utcWindow>,
): ComputeBudgetReservation {
  return {
    status,
    reservedDiem: reservedNano / NANO_DIEM,
    spentDiem: spentNano / NANO_DIEM,
    remainingDiem: Math.max(0, capNano - spentNano) / NANO_DIEM,
    resetsAt: window.resetsAt,
    retryAfterSeconds: window.retryAfterSeconds,
  };
}

/** Deterministic test/local implementation; production uses Upstash Redis. */
export class MemoryComputeBudgetStore implements ComputeBudgetStore {
  private readonly spentByDay = new Map<string, number>();

  constructor(private readonly capDiem: number) {}

  async reserve(
    _worker: WorkerId,
    reservedDiem: number,
    nowMs: number,
  ): Promise<ComputeBudgetReservation> {
    const window = utcWindow(nowMs);
    const capNano = toNanoDiem(this.capDiem);
    const reservedNano = toNanoDiem(reservedDiem);
    const spentNano = this.spentByDay.get(window.keySuffix) ?? 0;
    if (spentNano + reservedNano > capNano) {
      return result("exhausted", reservedNano, spentNano, capNano, window);
    }
    const nextSpent = spentNano + reservedNano;
    this.spentByDay.set(window.keySuffix, nextSpent);
    return result("reserved", reservedNano, nextSpent, capNano, window);
  }
}

const RESERVE_SCRIPT = `
local spent = tonumber(redis.call('GET', KEYS[1]) or '0')
local amount = tonumber(ARGV[1])
local cap = tonumber(ARGV[2])
if not spent or not amount or not cap or amount <= 0 or cap <= 0 then
  return redis.error_reply('invalid compute budget amount')
end
if spent + amount > cap then
  return {0, tostring(spent)}
end
local next = redis.call('INCRBY', KEYS[1], ARGV[1])
redis.call('EXPIREAT', KEYS[1], ARGV[3])
return {1, tostring(next)}
`;

export class UpstashComputeBudgetStore implements ComputeBudgetStore {
  private readonly redis: Redis;
  private readonly capNano: number;

  constructor(
    url: string,
    token: string,
    capDiem: number,
  ) {
    this.redis = new Redis({
      url,
      token,
      automaticDeserialization: false,
      enableTelemetry: false,
      readYourWrites: true,
    });
    this.capNano = toNanoDiem(capDiem);
  }

  async reserve(
    _worker: WorkerId,
    reservedDiem: number,
    nowMs: number,
  ): Promise<ComputeBudgetReservation> {
    const window = utcWindow(nowMs);
    const reservedNano = toNanoDiem(reservedDiem);
    const raw = await this.redis.eval<
      [string, string, string],
      [number | string, number | string]
    >(
      RESERVE_SCRIPT,
      [`diem:compute-budget:v1:${window.keySuffix}`],
      [
        String(reservedNano),
        String(this.capNano),
        String(window.expiresAtSeconds),
      ],
    );
    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error("Invalid compute budget storage response");
    }
    const accepted = Number(raw[0]) === 1;
    const spentNano = Number(raw[1]);
    if (!Number.isSafeInteger(spentNano) || spentNano < 0) {
      throw new Error("Invalid compute budget counter");
    }
    return result(
      accepted ? "reserved" : "exhausted",
      reservedNano,
      spentNano,
      this.capNano,
      window,
    );
  }
}

export function createComputeBudgetStore(
  config: AppConfig,
): ComputeBudgetStore | undefined {
  if (config.computeBudgetMode === "off") return undefined;
  if (!config.upstashRedisRestUrl || !config.upstashRedisRestToken) {
    throw new Error("Compute budget storage is not configured");
  }
  return new UpstashComputeBudgetStore(
    config.upstashRedisRestUrl,
    config.upstashRedisRestToken,
    config.computeBudgetDiemPerDay,
  );
}
