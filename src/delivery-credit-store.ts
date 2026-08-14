import { Redis } from "@upstash/redis";
import type { AppConfig } from "./config.js";
import type { WorkerId } from "./constants.js";

export type DeliveryCreditState =
  | "verified_running"
  | "pending_delivery"
  | "retry_running"
  | "exhausted"
  | "delivered";

export interface DeliveryCreditContext {
  keyFingerprint: string;
  paymentFingerprint: string;
  requestFingerprint: string;
  worker: WorkerId;
  reservedDiem: number;
}

export type DeliveryCreditClaimResult =
  | "missing"
  | "retry"
  | "in_flight"
  | "exhausted"
  | "delivered"
  | "mismatch";

export type DeliveryCreditBeginResult =
  | "started"
  | "in_flight"
  | "exhausted"
  | "delivered"
  | "mismatch";

export interface DeliveryCreditStore {
  checkAndClaim(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<DeliveryCreditClaimResult>;
  beginVerified(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<DeliveryCreditBeginResult>;
  isSettlementReady(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<boolean>;
  markSettled(context: DeliveryCreditContext, nowMs: number): Promise<boolean>;
  markDelivered(context: DeliveryCreditContext, nowMs: number): Promise<void>;
  cancelVerified(
    context: DeliveryCreditContext,
    settledBeforeHandler: boolean,
    nowMs: number,
  ): Promise<void>;
  releaseRetry(context: DeliveryCreditContext, nowMs: number): Promise<void>;
  deferRetry(context: DeliveryCreditContext, nowMs: number): Promise<void>;
}

interface MemoryRecord extends DeliveryCreditContext {
  state: DeliveryCreditState;
  leaseUntilMs: number;
  expiresAtMs: number;
}

/** Deterministic test/local implementation; production uses Upstash Redis. */
export class MemoryDeliveryCreditStore implements DeliveryCreditStore {
  private readonly records = new Map<string, MemoryRecord>();

  constructor(
    private readonly ttlSeconds = 86_400,
    private readonly leaseSeconds = 180,
  ) {}

  private record(context: DeliveryCreditContext, nowMs: number): MemoryRecord | undefined {
    const record = this.records.get(context.keyFingerprint);
    if (record && record.expiresAtMs <= nowMs) {
      this.records.delete(context.keyFingerprint);
      return undefined;
    }
    return record;
  }

  private matches(record: MemoryRecord, context: DeliveryCreditContext): boolean {
    return (
      record.worker === context.worker &&
      record.paymentFingerprint === context.paymentFingerprint &&
      record.requestFingerprint === context.requestFingerprint
    );
  }

  private refresh(record: MemoryRecord, nowMs: number): void {
    record.expiresAtMs = nowMs + this.ttlSeconds * 1_000;
  }

  async checkAndClaim(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<DeliveryCreditClaimResult> {
    const record = this.record(context, nowMs);
    if (!record) return "missing";
    if (!this.matches(record, context)) return "mismatch";
    if (record.state === "delivered") return "delivered";
    if (record.state === "exhausted") return "exhausted";
    if (
      record.state === "pending_delivery" ||
      (record.state === "verified_running" && record.leaseUntilMs <= nowMs)
    ) {
      record.state = "retry_running";
      record.leaseUntilMs = nowMs + this.leaseSeconds * 1_000;
      this.refresh(record, nowMs);
      return "retry";
    }
    if (record.state === "retry_running" && record.leaseUntilMs <= nowMs) {
      record.state = "exhausted";
      record.leaseUntilMs = 0;
      this.refresh(record, nowMs);
      return "exhausted";
    }
    return "in_flight";
  }

  async beginVerified(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<DeliveryCreditBeginResult> {
    const existing = this.record(context, nowMs);
    if (existing) {
      if (!this.matches(existing, context)) return "mismatch";
      if (existing.state === "delivered") return "delivered";
      if (existing.state === "exhausted") return "exhausted";
      return "in_flight";
    }
    this.records.set(context.keyFingerprint, {
      ...context,
      state: "verified_running",
      leaseUntilMs: nowMs + this.leaseSeconds * 1_000,
      expiresAtMs: nowMs + this.ttlSeconds * 1_000,
    });
    return "started";
  }

  async isSettlementReady(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<boolean> {
    const record = this.record(context, nowMs);
    return Boolean(
      record && this.matches(record, context) && record.state === "verified_running",
    );
  }

  async markSettled(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<boolean> {
    const record = this.record(context, nowMs);
    if (!record || !this.matches(record, context)) return false;
    if (record.state !== "verified_running") return false;
    record.state = "pending_delivery";
    record.leaseUntilMs = 0;
    this.refresh(record, nowMs);
    return true;
  }

  async markDelivered(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<void> {
    const record = this.record(context, nowMs);
    if (!record || !this.matches(record, context)) return;
    record.state = "delivered";
    record.leaseUntilMs = 0;
    this.refresh(record, nowMs);
  }

  async cancelVerified(
    context: DeliveryCreditContext,
    settledBeforeHandler: boolean,
    nowMs: number,
  ): Promise<void> {
    const record = this.record(context, nowMs);
    if (!record || !this.matches(record, context)) return;
    if (settledBeforeHandler) {
      record.state = "pending_delivery";
      record.leaseUntilMs = 0;
      this.refresh(record, nowMs);
      return;
    }
    if (record.state === "verified_running") {
      this.records.delete(context.keyFingerprint);
    }
  }

  async releaseRetry(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<void> {
    const record = this.record(context, nowMs);
    if (!record || !this.matches(record, context)) return;
    if (record.state === "retry_running") {
      record.state = "exhausted";
      record.leaseUntilMs = 0;
      this.refresh(record, nowMs);
    }
  }

  async deferRetry(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<void> {
    const record = this.record(context, nowMs);
    if (!record || !this.matches(record, context)) return;
    if (record.state === "retry_running") {
      record.state = "pending_delivery";
      record.leaseUntilMs = 0;
      this.refresh(record, nowMs);
    }
  }
}

const CLAIM_SCRIPT = `
local worker = redis.call('HGET', KEYS[1], 'worker')
if not worker then return 'missing' end
if worker ~= ARGV[1] or redis.call('HGET', KEYS[1], 'request') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'payment') ~= ARGV[3] then
  return 'mismatch'
end
local state = redis.call('HGET', KEYS[1], 'state')
if state == 'delivered' then return 'delivered' end
if state == 'exhausted' then return 'exhausted' end
local lease = tonumber(redis.call('HGET', KEYS[1], 'lease') or '0')
local now = tonumber(ARGV[4])
if state == 'pending_delivery' or (state == 'verified_running' and lease <= now) then
  redis.call('HSET', KEYS[1], 'state', 'retry_running', 'lease', ARGV[5])
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  return 'retry'
end
if state == 'retry_running' and lease <= now then
  redis.call('HSET', KEYS[1], 'state', 'exhausted', 'lease', '0')
  redis.call('EXPIRE', KEYS[1], ARGV[6])
  return 'exhausted'
end
return 'in_flight'
`;

const BEGIN_SCRIPT = `
local worker = redis.call('HGET', KEYS[1], 'worker')
if worker then
  if worker ~= ARGV[1] or redis.call('HGET', KEYS[1], 'request') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'payment') ~= ARGV[3] then
    return 'mismatch'
  end
  if redis.call('HGET', KEYS[1], 'state') == 'delivered' then return 'delivered' end
  if redis.call('HGET', KEYS[1], 'state') == 'exhausted' then return 'exhausted' end
  return 'in_flight'
end
redis.call('HSET', KEYS[1], 'worker', ARGV[1], 'request', ARGV[2], 'payment', ARGV[3], 'state', 'verified_running', 'lease', ARGV[4])
redis.call('EXPIRE', KEYS[1], ARGV[5])
return 'started'
`;

const READY_SCRIPT = `
local worker = redis.call('HGET', KEYS[1], 'worker')
if not worker or worker ~= ARGV[1] or redis.call('HGET', KEYS[1], 'request') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'payment') ~= ARGV[3] then
  return 0
end
if redis.call('HGET', KEYS[1], 'state') ~= 'verified_running' then return 0 end
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

const TRANSITION_SCRIPT = `
local worker = redis.call('HGET', KEYS[1], 'worker')
if not worker or worker ~= ARGV[1] or redis.call('HGET', KEYS[1], 'request') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'payment') ~= ARGV[3] then
  return 0
end
local state = redis.call('HGET', KEYS[1], 'state')
if ARGV[4] ~= '*' and state ~= ARGV[4] then return 0 end
redis.call('HSET', KEYS[1], 'state', ARGV[5], 'lease', ARGV[6])
redis.call('EXPIRE', KEYS[1], ARGV[7])
return 1
`;

const CANCEL_SCRIPT = `
local worker = redis.call('HGET', KEYS[1], 'worker')
if not worker or worker ~= ARGV[1] or redis.call('HGET', KEYS[1], 'request') ~= ARGV[2] or redis.call('HGET', KEYS[1], 'payment') ~= ARGV[3] then
  return 0
end
if ARGV[4] == '1' then
  redis.call('HSET', KEYS[1], 'state', 'pending_delivery', 'lease', '0')
  redis.call('EXPIRE', KEYS[1], ARGV[5])
  return 1
end
if redis.call('HGET', KEYS[1], 'state') == 'verified_running' then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export class UpstashDeliveryCreditStore implements DeliveryCreditStore {
  private readonly redis: Redis;

  constructor(
    url: string,
    token: string,
    private readonly ttlSeconds: number,
    private readonly leaseSeconds: number,
  ) {
    this.redis = new Redis({
      url,
      token,
      automaticDeserialization: false,
      enableTelemetry: false,
      readYourWrites: true,
    });
  }

  private key(context: DeliveryCreditContext): string {
    return `diem:delivery:v1:${context.keyFingerprint}`;
  }

  private leaseUntil(nowMs: number): string {
    return String(nowMs + this.leaseSeconds * 1_000);
  }

  async checkAndClaim(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<DeliveryCreditClaimResult> {
    return this.redis.eval<
      [string, string, string, string, string, string],
      DeliveryCreditClaimResult
    >(CLAIM_SCRIPT, [this.key(context)], [
      context.worker,
      context.requestFingerprint,
      context.paymentFingerprint,
      String(nowMs),
      this.leaseUntil(nowMs),
      String(this.ttlSeconds),
    ]);
  }

  async beginVerified(
    context: DeliveryCreditContext,
    nowMs: number,
  ): Promise<DeliveryCreditBeginResult> {
    return this.redis.eval<
      [string, string, string, string, string],
      DeliveryCreditBeginResult
    >(BEGIN_SCRIPT, [this.key(context)], [
      context.worker,
      context.requestFingerprint,
      context.paymentFingerprint,
      this.leaseUntil(nowMs),
      String(this.ttlSeconds),
    ]);
  }

  async isSettlementReady(
    context: DeliveryCreditContext,
    _nowMs: number,
  ): Promise<boolean> {
    const result = await this.redis.eval<[string, string, string, string], number>(
      READY_SCRIPT,
      [this.key(context)],
      [
        context.worker,
        context.requestFingerprint,
        context.paymentFingerprint,
        String(this.ttlSeconds),
      ],
    );
    return result === 1;
  }

  async markSettled(
    context: DeliveryCreditContext,
    _nowMs: number,
  ): Promise<boolean> {
    return this.transition(context, "verified_running", "pending_delivery", 0);
  }

  async markDelivered(
    context: DeliveryCreditContext,
    _nowMs: number,
  ): Promise<void> {
    await this.transition(context, "*", "delivered", 0);
  }

  async cancelVerified(
    context: DeliveryCreditContext,
    settledBeforeHandler: boolean,
    _nowMs: number,
  ): Promise<void> {
    await this.redis.eval<[string, string, string, string, string], number>(
      CANCEL_SCRIPT,
      [this.key(context)],
      [
        context.worker,
        context.requestFingerprint,
        context.paymentFingerprint,
        settledBeforeHandler ? "1" : "0",
        String(this.ttlSeconds),
      ],
    );
  }

  async releaseRetry(
    context: DeliveryCreditContext,
    _nowMs: number,
  ): Promise<void> {
    await this.transition(context, "retry_running", "exhausted", 0);
  }

  async deferRetry(
    context: DeliveryCreditContext,
    _nowMs: number,
  ): Promise<void> {
    await this.transition(context, "retry_running", "pending_delivery", 0);
  }

  private async transition(
    context: DeliveryCreditContext,
    from: DeliveryCreditState | "*",
    to: DeliveryCreditState,
    leaseUntilMs: number,
  ): Promise<boolean> {
    const result = await this.redis.eval<
      [string, string, string, string, string, string, string],
      number
    >(
      TRANSITION_SCRIPT,
      [this.key(context)],
      [
        context.worker,
        context.requestFingerprint,
        context.paymentFingerprint,
        from,
        to,
        String(leaseUntilMs),
        String(this.ttlSeconds),
      ],
    );
    return result === 1;
  }
}

export function createDeliveryCreditStore(
  config: AppConfig,
): DeliveryCreditStore | undefined {
  if (config.deliveryCreditsMode === "off") return undefined;
  if (!config.upstashRedisRestUrl || !config.upstashRedisRestToken) {
    throw new Error("Delivery credit storage is not configured");
  }
  return new UpstashDeliveryCreditStore(
    config.upstashRedisRestUrl,
    config.upstashRedisRestToken,
    config.deliveryCreditTtlSeconds,
    config.deliveryCreditLeaseSeconds,
  );
}
