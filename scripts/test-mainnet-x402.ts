import "dotenv/config";
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
  http,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { loadConfig } from "../src/config.js";
import {
  BASE_CAIP2,
  BASE_USDC_ADDRESS,
  WORKERS,
} from "../src/constants.js";
import { resolveTreasuryPrivateKey } from "../src/treasury/keychain.js";

const BASESCAN_TX = "https://basescan.org/tx/";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSafeRequirement(
  requirement: PaymentRequirements,
  treasury: Address,
  expectedAmount: bigint,
): void {
  assert(requirement.scheme === "exact", "Refusing non-exact payment scheme");
  assert(requirement.network === BASE_CAIP2, "Refusing payment outside Base mainnet");
  assert(
    requirement.asset.toLowerCase() === BASE_USDC_ADDRESS.toLowerCase(),
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

async function main(): Promise<void> {
  assert(
    process.env.MAINNET_X402_TEST_ACK === "PAY_0_01_USDC_TO_SELF_ON_BASE",
    "Set MAINNET_X402_TEST_ACK=PAY_0_01_USDC_TO_SELF_ON_BASE for this bounded test",
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

  const config = loadConfig({
    ...process.env,
    APP_ENV: "test",
    PAYMENTS_MODE: "off",
    PUBLIC_BASE_URL: publicBaseUrl,
    BASE_RPC_URL: "https://mainnet.base.org",
  });
  assert(config.treasuryAddress, "TREASURY_ADDRESS is not configured");
  const privateKey = await resolveTreasuryPrivateKey(config);
  assert(privateKey, "The matching macOS Keychain signer is unavailable");
  const buyer = privateKeyToAccount(privateKey);
  assert(
    buyer.address.toLowerCase() === config.treasuryAddress.toLowerCase(),
    "Keychain signer does not match the payment recipient",
  );

  const expectedAmount = parseUnits("0.010000", 6);
  const publicClient = createPublicClient({
    chain: base,
    transport: http("https://mainnet.base.org"),
  });
  const readBalance = () =>
    publicClient.readContract({
      address: BASE_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [buyer.address],
    });
  const before = await readBalance();
  assert(
    before >= expectedAmount,
    `Mainnet test wallet needs at least 0.010000 Base USDC; current balance is ${formatUnits(before, 6)}`,
  );

  const endpoint = `${publicBaseUrl}${WORKERS.classifyText.path}`;
  const request = {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": `mainnet-self-test-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({
      source: "The package arrived broken; route this request for a refund.",
      labels: ["refund", "sales", "technical_support"],
    }),
  } satisfies RequestInit;

  const unpaid = await fetch(endpoint, request);
  assert(unpaid.status === 402, `Expected HTTP 402, received ${unpaid.status}`);
  const requiredHeader = unpaid.headers.get("payment-required");
  assert(requiredHeader, "Unpaid response omitted PAYMENT-REQUIRED");
  const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
  assert(paymentRequired.x402Version === 2, "Unexpected x402 version");
  assert(paymentRequired.accepts.length === 1, "Expected exactly one payment option");
  assertSafeRequirement(
    paymentRequired.accepts[0]!,
    config.treasuryAddress,
    expectedAmount,
  );

  const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [{ network: BASE_CAIP2, client: new ExactEvmScheme(buyer) }],
    paymentRequirementsSelector: (_version, requirements) => {
      assert(requirements.length === 1, "Refusing multiple payment options");
      assertSafeRequirement(requirements[0]!, config.treasuryAddress!, expectedAmount);
      return requirements[0]!;
    },
  });
  const paid = await fetchWithPayment(endpoint, request);
  const body = (await paid.json()) as {
    worker?: string;
    validation?: { valid?: boolean };
    error?: string;
    message?: string;
  };
  assert(
    paid.status === 200,
    `Expected paid HTTP 200, received ${paid.status}: ${body.error ?? body.message ?? "unknown error"}`,
  );
  assert(body.worker === WORKERS.classifyText.id, "Unexpected worker response");
  assert(body.validation?.valid === true, "Worker output was not schema-valid");
  const responseHeader = paid.headers.get("payment-response");
  assert(responseHeader, "Paid response omitted PAYMENT-RESPONSE");
  const settlement = decodePaymentResponseHeader(responseHeader);
  assert(settlement.success, `Settlement failed: ${settlement.errorReason ?? "unknown"}`);
  assert(settlement.network === BASE_CAIP2, "Settlement used the wrong network");
  const settlementHash = settlement.transaction as Hex;
  assert(/^0x[0-9a-fA-F]{64}$/.test(settlementHash), "Settlement hash is invalid");
  await publicClient.waitForTransactionReceipt({ hash: settlementHash, timeout: 120_000 });
  const after = await readBalance();
  assert(
    after === before,
    "The bounded self-payment unexpectedly changed the wallet's Base USDC balance",
  );

  console.info(JSON.stringify({
    result: "PASS",
    network: BASE_CAIP2,
    asset: "USDC",
    authorizedAmount: "0.010000",
    buyerAndRecipient: buyer.address,
    unpaidStatus: unpaid.status,
    paidStatus: paid.status,
    settlementTransaction: settlementHash,
    settlementExplorer: `${BASESCAN_TX}${settlementHash}`,
    usdcBalanceBefore: formatUnits(before, 6),
    usdcBalanceAfter: formatUnits(after, 6),
    treasuryMode: config.treasuryMode,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Mainnet x402 test failed");
  process.exitCode = 1;
});
