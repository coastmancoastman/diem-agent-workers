import "dotenv/config";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, rename, unlink } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { createX402Server } from "@coinbase/cdp-sdk/x402";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm";
import {
  paymentMiddlewareFromHTTPServer,
  type x402HTTPResourceServer,
} from "@x402/express";
import {
  decodePaymentResponseHeader,
  wrapFetchWithPaymentFromConfig,
} from "@x402/fetch";
import express from "express";
import {
  createPublicClient,
  erc20Abi,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { loadConfig } from "../src/config.js";
import {
  BASE_CAIP2,
  BASE_USDC_ADDRESS,
  WORKERS,
  type WorkerId,
} from "../src/constants.js";
import { workerContracts, workerPrice } from "../src/discovery.js";
import {
  resolveTreasuryPrivateKey,
  validatePrivateKey,
} from "../src/treasury/keychain.js";

const DEFAULT_MAINNET_RPC_URL = "https://mainnet.base.org";
const MAX_TEST_TOTAL = parseUnits("0.095000", 6);
const BALANCE_POLL_ATTEMPTS = 30;
const BALANCE_POLL_INTERVAL_MS = 2_000;
const TEST_BUYER_KEYCHAIN_SERVICE =
  "com.diem-agent-workers.x402-mainnet-test-buyer";
const TEST_BUYER_KEYCHAIN_ACCOUNT = "mainnet-acceptance";
const TEST_BUYER_KEYCHAIN_LABEL =
  "DIEM Agent Workers x402 Mainnet Test Buyer";
const KEYCHAIN_HELPER = path.resolve(
  ".local/bin/diem-x402-test-keychain-helper",
);
const KEYCHAIN_HELPER_SOURCE = path.resolve("scripts/keychain-helper.c");
const execFileAsync = promisify(execFile);

type StoredBuyer = {
  account: ReturnType<typeof privateKeyToAccount>;
  created: boolean;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSafeRequirement(
  requirement: PaymentRequirements,
  recipient: Address,
  expectedAmount: bigint,
): void {
  assert(requirement.scheme === "exact", "Refusing non-exact payment scheme");
  assert(requirement.network === BASE_CAIP2, "Refusing payment outside Base mainnet");
  assert(
    requirement.asset.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase(),
    "Refusing payment in an unexpected asset",
  );
  assert(
    requirement.payTo.toLowerCase() === recipient.toLowerCase(),
    "Refusing payment to an unexpected recipient",
  );
  assert(
    BigInt(requirement.amount) === expectedAmount,
    "Refusing payment with an unexpected amount",
  );
}

async function keychainItemExists(): Promise<boolean> {
  try {
    await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-a",
        TEST_BUYER_KEYCHAIN_ACCOUNT,
        "-s",
        TEST_BUYER_KEYCHAIN_SERVICE,
      ],
      { encoding: "utf8", maxBuffer: 4_096 },
    );
    return true;
  } catch {
    return false;
  }
}

async function keychainHelper(
  args: string[],
  secretInput?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(KEYCHAIN_HELPER, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.resume();
    child.on("error", () => reject(new Error("Unable to start local Keychain helper")));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error("Unable to access the mainnet test buyer in macOS Keychain"));
    });
    child.stdin.end(secretInput);
  });
}

async function ensureTestBuyerKeychainHelper(): Promise<void> {
  await mkdir(path.dirname(KEYCHAIN_HELPER), { recursive: true, mode: 0o700 });
  await chmod(path.resolve(".local"), 0o700);
  await chmod(path.dirname(KEYCHAIN_HELPER), 0o700);
  try {
    await access(KEYCHAIN_HELPER, fsConstants.X_OK);
    return;
  } catch {
    // Compile below. The helper binary contains no wallet data.
  }

  const temporaryPath = `${KEYCHAIN_HELPER}.${process.pid}.tmp`;
  try {
    await execFileAsync(
      "xcrun",
      [
        "clang",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wno-deprecated-declarations",
        "-framework",
        "Security",
        "-framework",
        "CoreFoundation",
        KEYCHAIN_HELPER_SOURCE,
        "-o",
        temporaryPath,
      ],
      { encoding: "utf8", maxBuffer: 16_384 },
    );
    await chmod(temporaryPath, 0o700);
    await rename(temporaryPath, KEYCHAIN_HELPER);
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("Unable to build the mainnet test buyer Keychain helper");
  }
}

async function readTestBuyerPrivateKey(): Promise<Hex> {
  try {
    const { stdout } = await execFileAsync(
      "security",
      [
        "find-generic-password",
        "-a",
        TEST_BUYER_KEYCHAIN_ACCOUNT,
        "-s",
        TEST_BUYER_KEYCHAIN_SERVICE,
        "-w",
      ],
      { encoding: "utf8", maxBuffer: 4_096 },
    );
    return validatePrivateKey(stdout);
  } catch (error) {
    if (error instanceof Error && /valid 32-byte/.test(error.message)) throw error;
    throw new Error("Unable to read the mainnet test buyer from macOS Keychain");
  }
}

async function loadOrCreateTestBuyer(): Promise<StoredBuyer> {
  await ensureTestBuyerKeychainHelper();

  if (await keychainItemExists()) {
    const privateKey = await readTestBuyerPrivateKey();
    return { account: privateKeyToAccount(privateKey), created: false };
  }

  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  await keychainHelper(
    [
      "store",
      TEST_BUYER_KEYCHAIN_SERVICE,
      TEST_BUYER_KEYCHAIN_ACCOUNT,
      TEST_BUYER_KEYCHAIN_LABEL,
      `Disposable cents-only Base acceptance buyer ${account.address}; never share this secret`,
    ],
    privateKey,
  );
  const readback = await readTestBuyerPrivateKey();
  assert(
    privateKeyToAccount(readback).address.toLowerCase() ===
      account.address.toLowerCase(),
    "Test buyer Keychain readback did not match the created wallet",
  );
  return { account, created: true };
}

async function paidRequest(
  endpoint: string,
  request: RequestInit,
  payer: ReturnType<typeof privateKeyToAccount>,
  recipient: Address,
  expectedAmount: bigint,
): Promise<{ response: Response }> {
  const unpaid = await fetch(endpoint, request);
  assert(unpaid.status === 402, `Expected HTTP 402, received ${unpaid.status}`);
  const requiredHeader = unpaid.headers.get("payment-required");
  assert(requiredHeader, "Unpaid response omitted PAYMENT-REQUIRED");
  const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  assert(paymentRequired.x402Version === 2, "Unexpected x402 version");
  assert(paymentRequired.accepts.length === 1, "Expected exactly one payment option");
  assertSafeRequirement(paymentRequired.accepts[0]!, recipient, expectedAmount);

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: BASE_CAIP2, client: new ExactEvmScheme(payer) }],
    paymentRequirementsSelector: (_version, requirements) => {
      assert(requirements.length === 1, "Refusing multiple payment options");
      assertSafeRequirement(requirements[0]!, recipient, expectedAmount);
      return requirements[0]!;
    },
  });
  const paid = await fetchWithPayment(endpoint, request);
  if (paid.status !== 200) {
    let detail: string | undefined;
    const retryHeader = paid.headers.get("payment-required");
    if (retryHeader) {
      detail = decodePaymentRequiredHeader(retryHeader).error;
    }
    if (!detail) {
      const body = (await paid.clone().json().catch(() => undefined)) as
        | { error?: string; message?: string }
        | undefined;
      detail = body?.error ?? body?.message;
    }
    throw new Error(
      `Expected paid HTTP 200, received ${paid.status}: ${detail ?? "unknown error"}`,
    );
  }
  const responseHeader = paid.headers.get("payment-response");
  assert(responseHeader, "Paid response omitted PAYMENT-RESPONSE");
  const settlement = decodePaymentResponseHeader(responseHeader);
  assert(settlement.success, `Settlement failed: ${settlement.errorReason ?? "unknown"}`);
  assert(settlement.network === BASE_CAIP2, "Settlement used the wrong network");
  const settlementHash = settlement.transaction as Hex;
  assert(/^0x[0-9a-fA-F]{64}$/.test(settlementHash), "Settlement hash is invalid");
  return { response: paid };
}

async function startLocalFundingServer(
  recipient: Address,
  apiKeyId: string,
  apiKeySecret: string,
  amount: bigint,
): Promise<{ endpoint: string; server: Server }> {
  const x402Server = await createX402Server({
    apiKeyId,
    apiKeySecret,
    environment: "production",
    payToConfig: { type: "address", evm: recipient },
    builderCode: "diem_agent_workers",
    routes: {
      "POST /fund-test-buyer": {
        price: `$${formatUnits(amount, 6)}`,
        description:
          "One-time local-only funding hop for the DIEM Agent Workers mainnet acceptance buyer.",
        networks: [BASE_CAIP2],
      },
    },
  });
  const app = express();
  app.use(express.json({ limit: "2kb" }));
  app.use(
    paymentMiddlewareFromHTTPServer(
      x402Server as unknown as x402HTTPResourceServer,
    ),
  );
  app.post("/fund-test-buyer", (_request, response) => {
    response.status(200).json({ funded: true });
  });
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  assert(address && typeof address === "object", "Local funding server did not bind");
  return {
    endpoint: `http://127.0.0.1:${address.port}/fund-test-buyer`,
    server,
  };
}

function selectedWorkers(raw: string | undefined): WorkerId[] {
  if (!raw) return [WORKERS.classifyText.id];
  const allWorkers = Object.values(WORKERS).map((worker) => worker.id);
  if (raw === "all") return allWorkers;
  const requested = raw.split(",").map((value) => value.trim()).filter(Boolean);
  assert(requested.length > 0, "MAINNET_X402_TEST_WORKERS is empty");
  assert(new Set(requested).size === requested.length, "Duplicate test worker");
  for (const worker of requested) {
    assert(
      allWorkers.includes(worker as WorkerId),
      `Unknown mainnet test worker: ${worker}`,
    );
  }
  return requested as WorkerId[];
}

function assertWorkerResponse(worker: WorkerId, body: unknown): void {
  const result = body as {
    worker?: unknown;
    validation?: { valid?: unknown };
    result?: { base64?: unknown; mediaType?: unknown; bytes?: unknown };
  };
  assert(result.worker === worker, `Unexpected ${worker} response worker`);
  if (
    worker === WORKERS.extractJson.id ||
    worker === WORKERS.classifyText.id ||
    worker === WORKERS.summarizeText.id ||
    worker === WORKERS.transcribeAudio.id
  ) {
    assert(result.validation?.valid === true, `${worker} output was not validated`);
    return;
  }
  const expectedMediaType = worker === WORKERS.textToSpeech.id
    ? "audio/mpeg"
    : "image/webp";
  assert(
    typeof result.result?.base64 === "string" && result.result.base64.length > 0,
    `${worker} did not return base64 media`,
  );
  assert(
    result.result?.mediaType === expectedMediaType,
    `${worker} returned an unexpected media type`,
  );
  assert(
    typeof result.result?.bytes === "number" && result.result.bytes > 0,
    `${worker} returned an invalid byte count`,
  );
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function waitForUsdcBalance(
  readUsdc: (address: Address) => Promise<bigint>,
  address: Address,
  expected: bigint,
  label: string,
): Promise<void> {
  let actual = -1n;
  for (let attempt = 1; attempt <= BALANCE_POLL_ATTEMPTS; attempt += 1) {
    actual = await readUsdc(address);
    if (actual === expected) return;
    if (attempt < BALANCE_POLL_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, BALANCE_POLL_INTERVAL_MS));
    }
  }
  throw new Error(
    `${label} did not reach ${formatUnits(expected, 6)} USDC; current balance is ${formatUnits(actual, 6)}`,
  );
}

async function main(): Promise<void> {
  const workers = selectedWorkers(process.env.MAINNET_X402_TEST_WORKERS);
  const multiWorker = process.env.MAINNET_X402_TEST_WORKERS !== undefined;
  const expectedAck = multiWorker
    ? "PAY_UP_TO_0_095_USDC_WITH_DISTINCT_BUYER_ON_BASE"
    : "PAY_0_01_USDC_WITH_DISTINCT_BUYER_ON_BASE";
  assert(
    process.env.MAINNET_X402_TEST_ACK === expectedAck,
    `Set MAINNET_X402_TEST_ACK=${expectedAck} for this bounded test`,
  );
  assert(
    process.env.TREASURY_MODE === "disabled",
    "Saved TREASURY_MODE must remain disabled",
  );
  const publicBaseUrl = process.env.X402_TEST_BASE_URL?.replace(/\/$/, "");
  assert(publicBaseUrl, "X402_TEST_BASE_URL is required");
  const target = new URL(publicBaseUrl);
  assert(target.protocol === "https:", "Mainnet test target must use HTTPS");
  assert(
    !target.username && !target.password && !target.search && !target.hash,
    "Unsafe mainnet test target URL",
  );
  const rpcUrl = process.env.MAINNET_X402_RPC_URL ?? DEFAULT_MAINNET_RPC_URL;
  const rpcTarget = new URL(rpcUrl);
  assert(rpcTarget.protocol === "https:", "Mainnet RPC URL must use HTTPS");
  assert(
    !rpcTarget.username &&
      !rpcTarget.password &&
      !rpcTarget.search &&
      !rpcTarget.hash,
    "Unsafe mainnet RPC URL",
  );

  const config = loadConfig({
    ...process.env,
    APP_ENV: "test",
    PAYMENTS_MODE: "off",
    PUBLIC_BASE_URL: publicBaseUrl,
    BASE_RPC_URL: rpcUrl,
  });
  assert(config.treasuryAddress, "TREASURY_ADDRESS is not configured");
  const jobs = workers.map((worker) => {
    const contract = workerContracts[worker];
    const amount = parseUnits(workerPrice(config, worker).toFixed(6), 6);
    const definition = Object.values(WORKERS).find((item) => item.id === worker);
    assert(definition, `Worker path is unavailable: ${worker}`);
    return { worker, amount, path: definition.path, input: contract.input };
  });
  const totalAmount = jobs.reduce((total, job) => total + job.amount, 0n);
  assert(totalAmount > 0n, "Mainnet acceptance total must be positive");
  assert(
    totalAmount <= MAX_TEST_TOTAL,
    `Refusing more than ${formatUnits(MAX_TEST_TOTAL, 6)} USDC`,
  );
  const recipient = getAddress(config.treasuryAddress);
  const testBuyer = await loadOrCreateTestBuyer();
  assert(
    testBuyer.account.address.toLowerCase() !== recipient.toLowerCase(),
    "Mainnet acceptance buyer must differ from the payment recipient",
  );

  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });
  const readUsdc = async (address: Address): Promise<bigint> =>
    await publicClient.readContract({
      address: BASE_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  const [treasuryBefore, buyerBefore, treasuryEthBefore, buyerEthBefore] =
    await Promise.all([
      readUsdc(recipient),
      readUsdc(testBuyer.account.address),
      publicClient.getBalance({ address: recipient }),
      publicClient.getBalance({ address: testBuyer.account.address }),
    ]);
  assert(
    buyerBefore === 0n || buyerBefore === totalAmount,
    `Refusing unexpected test buyer balance ${formatUnits(buyerBefore, 6)} USDC`,
  );
  assert(
    buyerBefore === totalAmount || treasuryBefore >= totalAmount,
    `Treasury needs at least ${formatUnits(totalAmount, 6)} Base USDC; current balance is ${formatUnits(treasuryBefore, 6)}`,
  );

  let fundingSettlementPerformed = false;
  if (buyerBefore === 0n) {
    assert(config.cdpApiKeyId, "CDP_API_KEY_ID is not configured");
    assert(config.cdpApiKeySecret, "CDP_API_KEY_SECRET is not configured");
    const treasuryPrivateKey = await resolveTreasuryPrivateKey(config);
    assert(
      treasuryPrivateKey,
      "The matching treasury macOS Keychain signer is unavailable",
    );
    const treasury = privateKeyToAccount(treasuryPrivateKey);
    assert(
      treasury.address.toLowerCase() === recipient.toLowerCase(),
      "Treasury Keychain signer does not match the payment recipient",
    );
    const funding = await startLocalFundingServer(
      testBuyer.account.address,
      config.cdpApiKeyId,
      config.cdpApiKeySecret,
      totalAmount,
    );
    try {
      const funded = await paidRequest(
        funding.endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ purpose: "mainnet-acceptance" }),
        },
        treasury,
        testBuyer.account.address,
        totalAmount,
      );
      assert(funded.response.status === 200, "Funding settlement response failed");
      fundingSettlementPerformed = true;
    } finally {
      await closeServer(funding.server);
    }
    await waitForUsdcBalance(
      readUsdc,
      testBuyer.account.address,
      totalAmount,
      "Mainnet test buyer",
    );
  }

  const liveResults: Array<{
    worker: WorkerId;
    amount: string;
    status: number;
  }> = [];
  for (const job of jobs) {
    const live = await paidRequest(
      `${publicBaseUrl}${job.path}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `mainnet-distinct-buyer-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(job.input),
      },
      testBuyer.account,
      recipient,
      job.amount,
    );
    const body = (await live.response.json()) as unknown;
    assertWorkerResponse(job.worker, body);
    liveResults.push({
      worker: job.worker,
      amount: formatUnits(job.amount, 6),
      status: live.response.status,
    });
  }
  const expectedTreasuryAfter =
    buyerBefore === 0n ? treasuryBefore : treasuryBefore + totalAmount;
  await Promise.all([
    waitForUsdcBalance(
      readUsdc,
      recipient,
      expectedTreasuryAfter,
      "Treasury",
    ),
    waitForUsdcBalance(
      readUsdc,
      testBuyer.account.address,
      0n,
      "Mainnet test buyer",
    ),
  ]);

  const [treasuryAfter, buyerAfter, treasuryEthAfter, buyerEthAfter] =
    await Promise.all([
      readUsdc(recipient),
      readUsdc(testBuyer.account.address),
      publicClient.getBalance({ address: recipient }),
      publicClient.getBalance({ address: testBuyer.account.address }),
    ]);
  assert(
    treasuryAfter === expectedTreasuryAfter,
    "Mainnet acceptance flow produced an unexpected treasury USDC balance",
  );
  assert(buyerAfter === 0n, "Mainnet acceptance buyer retained unexpected USDC");
  assert(
    treasuryEthAfter === treasuryEthBefore && buyerEthAfter === buyerEthBefore,
    "The gas-sponsored acceptance flow unexpectedly changed a wallet ETH balance",
  );

  console.info(
    JSON.stringify(
      {
        result: "PASS",
        network: BASE_CAIP2,
        asset: "USDC",
        liveAuthorizedAmount: formatUnits(totalAmount, 6),
        workers: workers,
        testBuyerCreated: testBuyer.created,
        fundingSettlementPerformed,
        storefrontTransactions: liveResults,
        treasuryUsdcReconciled: treasuryAfter === expectedTreasuryAfter,
        testBuyerUsdcReconciled: buyerAfter === 0n,
        walletEthBalancesUnchanged:
          treasuryEthAfter === treasuryEthBefore && buyerEthAfter === buyerEthBefore,
        treasuryMode: config.treasuryMode,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Mainnet x402 test failed");
  process.exitCode = 1;
});
