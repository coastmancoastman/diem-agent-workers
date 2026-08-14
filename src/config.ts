import { isAddress, type Address, type Hex } from "viem";
import { TREASURY_LIVE_ACK, VENICE_DEFAULT_BASE_URL } from "./constants.js";

export type PaymentsMode = "off" | "development" | "production";
export type DeliveryCreditsMode = "off" | "enforced";
export type TreasuryMode = "disabled" | "quote" | "live";
export type TreasuryKeychainBackend = "security-cli" | "native-helper";

function enumValue<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = (raw ?? fallback) as T;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  }
  return value;
}

function numberValue(
  name: string,
  raw: string | undefined,
  fallback: number,
  options: { min?: number; max?: number } = {},
): number {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  if (options.min !== undefined && value < options.min) {
    throw new Error(`${name} must be >= ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    throw new Error(`${name} must be <= ${options.max}`);
  }
  return value;
}

function optionalAddress(name: string, raw: string | undefined): Address | undefined {
  if (!raw) return undefined;
  if (!isAddress(raw)) throw new Error(`${name} must be a valid EVM address`);
  return raw as Address;
}

function optionalPrivateKey(raw: string | undefined): Hex | undefined {
  if (!raw) return undefined;
  if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("TREASURY_PRIVATE_KEY must be a 32-byte 0x-prefixed key");
  }
  return raw as Hex;
}

function httpsBaseUrl(name: string, raw: string | undefined, fallback: string): string {
  const value = (raw ?? fallback).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment`);
  }
  return value;
}

function publicBaseUrl(env: NodeJS.ProcessEnv): string {
  const fallback = env.VERCEL_URL
    ? `https://${env.VERCEL_URL}`
    : "http://localhost:8402";
  const value = (env.PUBLIC_BASE_URL ?? fallback).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_BASE_URL must use HTTP or HTTPS");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "PUBLIC_BASE_URL must not contain credentials, a query, or a fragment",
    );
  }
  return value;
}

export interface AppConfig {
  appEnv: "development" | "production" | "test";
  port: number;
  publicBaseUrl: string;
  veniceApiKey?: string;
  veniceBaseUrl: string;
  veniceModel: string;
  veniceImageModel: string;
  veniceTtsModel: string;
  veniceAsrModel: string;
  veniceTimeoutMs: number;
  veniceDiemEpochCap: number;
  veniceReadinessCacheMs: number;
  cdpApiKeyId?: string;
  cdpApiKeySecret?: string;
  paymentsMode: PaymentsMode;
  deliveryCreditsMode: DeliveryCreditsMode;
  deliveryCreditHmacSecret?: string;
  deliveryCreditTtlSeconds: number;
  deliveryCreditLeaseSeconds: number;
  upstashRedisRestUrl?: string;
  upstashRedisRestToken?: string;
  x402PriceUsd: number;
  x402ClassifyPriceUsd: number;
  x402SummarizePriceUsd: number;
  x402TtsPriceUsd: number;
  x402ImagePriceUsd: number;
  x402TranscribePriceUsd: number;
  treasuryAddress?: Address;
  treasuryMode: TreasuryMode;
  baseRpcUrl: string;
  zeroExApiKey?: string;
  treasuryPrivateKey?: Hex;
  treasuryKeychainService?: string;
  treasuryKeychainAccount?: string;
  treasuryKeychainBackend: TreasuryKeychainBackend;
  treasuryMinSwapUsdc: number;
  treasuryMaxSwapUsdc: number;
  treasuryUsdcHoldback: number;
  treasuryMaxSlippageBps: number;
  treasuryMinEthReserve: number;
  treasuryMaxGas: bigint;
  treasuryAuditPath: string;
  treasuryLockPath: string;
  treasuryStatePath: string;
  treasuryLiveAck?: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): AppConfig {
  const appEnv = enumValue(
    "APP_ENV",
    env.APP_ENV,
    ["development", "production", "test"] as const,
    "development",
  );
  const paymentsMode = enumValue(
    "PAYMENTS_MODE",
    env.PAYMENTS_MODE,
    ["off", "development", "production"] as const,
    "off",
  );
  const treasuryMode = enumValue(
    "TREASURY_MODE",
    env.TREASURY_MODE,
    ["disabled", "quote", "live"] as const,
    "disabled",
  );
  const deliveryCreditsMode = enumValue(
    "DELIVERY_CREDITS_MODE",
    env.DELIVERY_CREDITS_MODE,
    ["off", "enforced"] as const,
    "off",
  );
  const upstashRedisRestUrlValue =
    env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
  const upstashRedisRestToken =
    env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
  const treasuryAddress = optionalAddress("TREASURY_ADDRESS", env.TREASURY_ADDRESS);
  const treasuryPrivateKey = optionalPrivateKey(env.TREASURY_PRIVATE_KEY);
  const treasuryKeychainBackend = enumValue(
    "TREASURY_KEYCHAIN_BACKEND",
    env.TREASURY_KEYCHAIN_BACKEND,
    ["security-cli", "native-helper"] as const,
    "security-cli",
  );

  const config: AppConfig = {
    appEnv,
    port: numberValue("PORT", env.PORT, 8402, { min: 1, max: 65535 }),
    publicBaseUrl: publicBaseUrl(env),
    ...(env.VENICE_API_KEY ? { veniceApiKey: env.VENICE_API_KEY } : {}),
    veniceBaseUrl: httpsBaseUrl(
      "VENICE_BASE_URL",
      env.VENICE_BASE_URL,
      VENICE_DEFAULT_BASE_URL,
    ),
    veniceModel:
      env.VENICE_TEXT_MODEL ?? env.VENICE_MODEL ?? "venice-uncensored-1-2",
    veniceImageModel: env.VENICE_IMAGE_MODEL ?? "venice-sd35",
    veniceTtsModel: env.VENICE_TTS_MODEL ?? "tts-kokoro",
    veniceAsrModel: env.VENICE_ASR_MODEL ?? "openai/whisper-large-v3",
    veniceTimeoutMs: numberValue(
      "VENICE_TIMEOUT_MS",
      env.VENICE_TIMEOUT_MS,
      45_000,
      { min: 1_000, max: 120_000 },
    ),
    veniceDiemEpochCap: numberValue(
      "VENICE_DIEM_EPOCH_CAP",
      env.VENICE_DIEM_EPOCH_CAP,
      1.69,
      { min: 0.01, max: 1_000 },
    ),
    veniceReadinessCacheMs: numberValue(
      "VENICE_READINESS_CACHE_MS",
      env.VENICE_READINESS_CACHE_MS,
      15_000,
      { min: 1_000, max: 60_000 },
    ),
    ...(env.CDP_API_KEY_ID ? { cdpApiKeyId: env.CDP_API_KEY_ID } : {}),
    ...(env.CDP_API_KEY_SECRET ? { cdpApiKeySecret: env.CDP_API_KEY_SECRET } : {}),
    paymentsMode,
    deliveryCreditsMode,
    ...(env.DELIVERY_CREDIT_HMAC_SECRET
      ? { deliveryCreditHmacSecret: env.DELIVERY_CREDIT_HMAC_SECRET }
      : {}),
    deliveryCreditTtlSeconds: numberValue(
      "DELIVERY_CREDIT_TTL_SECONDS",
      env.DELIVERY_CREDIT_TTL_SECONDS,
      86_400,
      { min: 300, max: 604_800 },
    ),
    deliveryCreditLeaseSeconds: numberValue(
      "DELIVERY_CREDIT_LEASE_SECONDS",
      env.DELIVERY_CREDIT_LEASE_SECONDS,
      180,
      { min: 60, max: 900 },
    ),
    ...(upstashRedisRestUrlValue
      ? {
          upstashRedisRestUrl: httpsBaseUrl(
            "UPSTASH_REDIS_REST_URL",
            upstashRedisRestUrlValue,
            upstashRedisRestUrlValue,
          ),
        }
      : {}),
    ...(upstashRedisRestToken ? { upstashRedisRestToken } : {}),
    x402PriceUsd: numberValue("X402_PRICE_USD", env.X402_PRICE_USD, 0.02, {
      min: 0.001,
      max: 10,
    }),
    x402ClassifyPriceUsd: numberValue(
      "X402_CLASSIFY_PRICE_USD",
      env.X402_CLASSIFY_PRICE_USD,
      0.005,
      { min: 0.001, max: 10 },
    ),
    x402SummarizePriceUsd: numberValue(
      "X402_SUMMARIZE_PRICE_USD",
      env.X402_SUMMARIZE_PRICE_USD,
      0.005,
      { min: 0.001, max: 10 },
    ),
    x402TtsPriceUsd: numberValue(
      "X402_TTS_PRICE_USD",
      env.X402_TTS_PRICE_USD,
      0.01,
      { min: 0.001, max: 10 },
    ),
    x402ImagePriceUsd: numberValue(
      "X402_IMAGE_PRICE_USD",
      env.X402_IMAGE_PRICE_USD,
      0.02,
      { min: 0.001, max: 10 },
    ),
    x402TranscribePriceUsd: numberValue(
      "X402_TRANSCRIBE_PRICE_USD",
      env.X402_TRANSCRIBE_PRICE_USD,
      0.015,
      { min: 0.001, max: 10 },
    ),
    ...(treasuryAddress ? { treasuryAddress } : {}),
    treasuryMode,
    baseRpcUrl: env.BASE_RPC_URL ?? "https://mainnet.base.org",
    ...(env.ZEROX_API_KEY ? { zeroExApiKey: env.ZEROX_API_KEY } : {}),
    ...(treasuryPrivateKey ? { treasuryPrivateKey } : {}),
    ...(env.TREASURY_KEYCHAIN_SERVICE
      ? { treasuryKeychainService: env.TREASURY_KEYCHAIN_SERVICE }
      : {}),
    ...(env.TREASURY_KEYCHAIN_ACCOUNT
      ? { treasuryKeychainAccount: env.TREASURY_KEYCHAIN_ACCOUNT }
      : {}),
    treasuryKeychainBackend,
    treasuryMinSwapUsdc: numberValue(
      "TREASURY_MIN_SWAP_USDC",
      env.TREASURY_MIN_SWAP_USDC,
      5,
      { min: 0.01, max: 1_000_000 },
    ),
    treasuryMaxSwapUsdc: numberValue(
      "TREASURY_MAX_SWAP_USDC",
      env.TREASURY_MAX_SWAP_USDC,
      25,
      { min: 0.01, max: 1_000_000 },
    ),
    treasuryUsdcHoldback: numberValue(
      "TREASURY_USDC_HOLDBACK",
      env.TREASURY_USDC_HOLDBACK,
      0,
      { min: 0, max: 1_000_000 },
    ),
    treasuryMaxSlippageBps: numberValue(
      "TREASURY_MAX_SLIPPAGE_BPS",
      env.TREASURY_MAX_SLIPPAGE_BPS,
      100,
      { min: 1, max: 500 },
    ),
    treasuryMinEthReserve: numberValue(
      "TREASURY_MIN_ETH_RESERVE",
      env.TREASURY_MIN_ETH_RESERVE,
      0.0005,
      { min: 0.00001, max: 10 },
    ),
    treasuryMaxGas: BigInt(
      numberValue("TREASURY_MAX_GAS", env.TREASURY_MAX_GAS, 500_000, {
        min: 21_000,
        max: 5_000_000,
      }),
    ),
    treasuryAuditPath: env.TREASURY_AUDIT_PATH ?? "data/treasury-audit.jsonl",
    treasuryLockPath: env.TREASURY_LOCK_PATH ?? "data/treasury.lock",
    treasuryStatePath: env.TREASURY_STATE_PATH ?? "data/treasury-state.json",
    ...(env.TREASURY_LIVE_ACK ? { treasuryLiveAck: env.TREASURY_LIVE_ACK } : {}),
  };

  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  if (config.appEnv === "production" && config.paymentsMode !== "production") {
    throw new Error("Production service must use PAYMENTS_MODE=production");
  }
  if (
    config.paymentsMode === "production" &&
    config.deliveryCreditsMode !== "enforced"
  ) {
    throw new Error(
      "Production payments require DELIVERY_CREDITS_MODE=enforced",
    );
  }
  if (config.deliveryCreditsMode === "enforced") {
    if (
      !config.deliveryCreditHmacSecret ||
      Buffer.byteLength(config.deliveryCreditHmacSecret, "utf8") < 32
    ) {
      throw new Error(
        "DELIVERY_CREDIT_HMAC_SECRET must contain at least 32 bytes",
      );
    }
    if (!config.upstashRedisRestUrl || !config.upstashRedisRestToken) {
      throw new Error(
        "Enforced delivery credits require Upstash Redis REST credentials",
      );
    }
  }
  if (config.paymentsMode !== "off" && !config.treasuryAddress) {
    throw new Error("TREASURY_ADDRESS is required when x402 payments are enabled");
  }
  if (config.paymentsMode !== "off") {
    if (!config.veniceApiKey) {
      throw new Error("VENICE_API_KEY is required before x402 payments are enabled");
    }
    if (!config.cdpApiKeyId || !config.cdpApiKeySecret) {
      throw new Error("CDP_API_KEY_ID and CDP_API_KEY_SECRET are required for x402 payments");
    }
  }
  if (config.treasuryMinSwapUsdc > config.treasuryMaxSwapUsdc) {
    throw new Error("TREASURY_MIN_SWAP_USDC cannot exceed TREASURY_MAX_SWAP_USDC");
  }
  if (Boolean(config.treasuryKeychainService) !== Boolean(config.treasuryKeychainAccount)) {
    throw new Error(
      "TREASURY_KEYCHAIN_SERVICE and TREASURY_KEYCHAIN_ACCOUNT must be configured together",
    );
  }
  if (config.treasuryMode !== "disabled") {
    if (!config.treasuryAddress) throw new Error("Treasury mode requires TREASURY_ADDRESS");
    if (!config.zeroExApiKey) throw new Error("Treasury mode requires ZEROX_API_KEY");
  }
  if (config.treasuryMode === "live") {
    if (
      !config.treasuryPrivateKey &&
      !(config.treasuryKeychainService && config.treasuryKeychainAccount)
    ) {
      throw new Error("Live treasury requires TREASURY_PRIVATE_KEY or macOS Keychain storage");
    }
    if (config.treasuryLiveAck !== TREASURY_LIVE_ACK) {
      throw new Error(`Live treasury requires TREASURY_LIVE_ACK=${TREASURY_LIVE_ACK}`);
    }
  }
}
