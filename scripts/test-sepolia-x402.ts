import "dotenv/config";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { CdpClient } from "@coinbase/cdp-sdk";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm";
import {
  decodePaymentResponseHeader,
  wrapFetchWithPaymentFromConfig,
} from "@x402/fetch";
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
import { baseSepolia } from "viem/chains";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { BASE_SEPOLIA_CAIP2, WORKER_PATH } from "../src/constants.js";
import { extractJsonExample } from "../src/discovery.js";

const BASE_SEPOLIA_USDC = getAddress(
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
);
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const BASESCAN_TX = "https://sepolia.basescan.org/tx/";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function assertSafeRequirement(
  requirement: PaymentRequirements,
  treasury: Address,
  expectedAmount: bigint,
): void {
  assert(requirement.scheme === "exact", "Refusing non-exact payment scheme");
  assert(
    requirement.network === BASE_SEPOLIA_CAIP2,
    "Refusing payment outside Base Sepolia",
  );
  assert(
    requirement.asset.toLowerCase() === BASE_SEPOLIA_USDC.toLowerCase(),
    "Refusing payment in an unexpected asset",
  );
  assert(
    requirement.payTo.toLowerCase() === treasury.toLowerCase(),
    "Refusing payment to an unexpected recipient",
  );
  assert(
    BigInt(requirement.amount) === expectedAmount,
    "Refusing payment with an unexpected amount",
  );
}

async function closeServer(server: ReturnType<import("express").Express["listen"]>) {
  await new Promise<void>((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

async function main(): Promise<void> {
  assert(
    process.env.PAYMENTS_MODE === "off",
    "Saved PAYMENTS_MODE must be off before running this test",
  );
  assert(
    process.env.TREASURY_MODE === "disabled",
    "Saved TREASURY_MODE must be disabled before running this test",
  );

  const publicTestBaseUrl = process.env.X402_TEST_BASE_URL?.replace(/\/$/, "");
  if (publicTestBaseUrl) {
    const url = new URL(publicTestBaseUrl);
    assert(url.protocol === "https:", "Public x402 test target must use HTTPS");
    assert(!url.username && !url.password, "Public x402 test target cannot contain credentials");
    assert(!url.search && !url.hash, "Public x402 test target cannot contain a query or fragment");
  }

  const config = loadConfig({
    ...process.env,
    APP_ENV: "development",
    PAYMENTS_MODE: "development",
    TREASURY_MODE: "disabled",
    PUBLIC_BASE_URL: publicTestBaseUrl ?? "http://127.0.0.1",
    BASE_RPC_URL: BASE_SEPOLIA_RPC,
  });
  assert(config.treasuryAddress, "TREASURY_ADDRESS is not configured");
  assert(config.cdpApiKeyId, "CDP_API_KEY_ID is not configured");
  assert(config.cdpApiKeySecret, "CDP_API_KEY_SECRET is not configured");

  const expectedAmount = parseUnits(config.x402PriceUsd.toFixed(6), 6);
  assert(expectedAmount === 20_000n, "This test is hard-capped at 0.020000 test USDC");

  // This key exists only in process memory and is intentionally never printed
  // or persisted. It controls faucet-only Base Sepolia assets.
  const buyer = privateKeyToAccount(generatePrivateKey());
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(BASE_SEPOLIA_RPC),
  });
  const readUsdcBalance = (address: Address) =>
    publicClient.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  const cdp = new CdpClient({
    apiKeyId: config.cdpApiKeyId,
    apiKeySecret: config.cdpApiKeySecret,
  });

  const treasuryBefore = await readUsdcBalance(config.treasuryAddress);
  const faucet = await cdp.evm.requestFaucet({
    address: buyer.address,
    network: "base-sepolia",
    token: "usdc",
    idempotencyKey: crypto.randomUUID(),
  });
  console.info(
    JSON.stringify({
      event: "test_usdc_faucet_requested",
      network: BASE_SEPOLIA_CAIP2,
      ephemeralBuyer: buyer.address,
      transaction: faucet.transactionHash,
      explorer: `${BASESCAN_TX}${faucet.transactionHash}`,
    }),
  );
  await publicClient.waitForTransactionReceipt({
    hash: faucet.transactionHash,
    timeout: 120_000,
  });
  let buyerBefore = await readUsdcBalance(buyer.address);
  for (let attempt = 0; buyerBefore < expectedAmount && attempt < 30; attempt += 1) {
    await delay(1_000);
    buyerBefore = await readUsdcBalance(buyer.address);
  }
  assert(
    buyerBefore >= expectedAmount,
    `Faucet balance ${formatUnits(buyerBefore, 6)} test USDC is too small for the test payment`,
  );

  let server: ReturnType<import("express").Express["listen"]> | undefined;
  let endpoint: string;
  if (publicTestBaseUrl) {
    endpoint = `${publicTestBaseUrl}${WORKER_PATH}`;
  } else {
    const app = await buildApp(config);
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo | null;
    assert(address, "Local test server did not bind");
    endpoint = `http://127.0.0.1:${address.port}${WORKER_PATH}`;
  }

  try {
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `x402-${buyer.address}`,
      },
      body: JSON.stringify(extractJsonExample),
    } satisfies RequestInit;

    const unpaid = await fetch(endpoint, request);
    assert(unpaid.status === 402, `Expected unpaid HTTP 402, received ${unpaid.status}`);
    const requiredHeader = unpaid.headers.get("payment-required");
    assert(requiredHeader, "Unpaid response omitted PAYMENT-REQUIRED");
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
    assert(paymentRequired.x402Version === 2, "Refusing an unexpected x402 version");
    assert(paymentRequired.accepts.length === 1, "Expected exactly one payment option");
    const quotedRequirement = paymentRequired.accepts[0];
    assert(quotedRequirement, "Payment requirement is missing");
    assertSafeRequirement(
      quotedRequirement,
      config.treasuryAddress,
      expectedAmount,
    );

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [
        {
          network: BASE_SEPOLIA_CAIP2,
          client: new ExactEvmScheme(buyer),
        },
      ],
      paymentRequirementsSelector: (_version, requirements) => {
        assert(requirements.length === 1, "Refusing multiple payment options");
        const requirement = requirements[0];
        assert(requirement, "Payment requirement is missing");
        assertSafeRequirement(requirement, config.treasuryAddress!, expectedAmount);
        return requirement;
      },
    });

    const paid = await fetchWithPayment(endpoint, request);
    const responseBody = (await paid.json()) as {
      worker?: string;
      result?: unknown;
      validation?: { valid?: boolean };
      error?: string;
      message?: string;
    };
    assert(
      paid.status === 200,
      `Expected paid HTTP 200, received ${paid.status}: ${responseBody.error ?? responseBody.message ?? "unknown error"}`,
    );
    assert(responseBody.validation?.valid === true, "Worker output was not schema-valid");

    const responseHeader = paid.headers.get("payment-response");
    assert(responseHeader, "Paid response omitted PAYMENT-RESPONSE");
    const settlement = decodePaymentResponseHeader(responseHeader);
    assert(settlement.success, `Settlement failed: ${settlement.errorReason ?? "unknown"}`);
    assert(settlement.network === BASE_SEPOLIA_CAIP2, "Settlement used the wrong network");

    const settlementHash = settlement.transaction as Hex;
    assert(/^0x[0-9a-fA-F]{64}$/.test(settlementHash), "Settlement hash is invalid");
    await publicClient.waitForTransactionReceipt({
      hash: settlementHash,
      timeout: 120_000,
    });

    const [treasuryAfter, buyerAfter] = await Promise.all([
      readUsdcBalance(config.treasuryAddress),
      readUsdcBalance(buyer.address),
    ]);
    const treasuryDelta = treasuryAfter - treasuryBefore;
    const buyerDelta = buyerBefore - buyerAfter;
    assert(
      treasuryDelta === expectedAmount,
      `Treasury delta was ${treasuryDelta}, expected ${expectedAmount}`,
    );
    assert(
      buyerDelta === expectedAmount,
      `Buyer delta was ${buyerDelta}, expected ${expectedAmount}`,
    );

    console.info(
      JSON.stringify(
        {
          result: "PASS",
          network: BASE_SEPOLIA_CAIP2,
          asset: "test USDC",
          amount: formatUnits(expectedAmount, 6),
          treasury: config.treasuryAddress,
          ephemeralBuyer: buyer.address,
          unpaidStatus: unpaid.status,
          paidStatus: paid.status,
          worker: responseBody.worker,
          output: responseBody.result,
          faucetTransaction: faucet.transactionHash,
          faucetExplorer: `${BASESCAN_TX}${faucet.transactionHash}`,
          settlementTransaction: settlementHash,
          settlementExplorer: `${BASESCAN_TX}${settlementHash}`,
          treasuryTestUsdcBefore: formatUnits(treasuryBefore, 6),
          treasuryTestUsdcAfter: formatUnits(treasuryAfter, 6),
          treasuryTestUsdcDelta: formatUnits(treasuryDelta, 6),
          savedPaymentsMode: process.env.PAYMENTS_MODE,
          savedTreasuryMode: process.env.TREASURY_MODE,
          publicEndpoint: publicTestBaseUrl ? endpoint : null,
          bazaarPublicationRequested: Boolean(publicTestBaseUrl),
        },
        null,
        2,
      ),
    );
  } finally {
    if (server) await closeServer(server);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Base Sepolia test failed");
  process.exitCode = 1;
});
