import "dotenv/config";
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
import { loadConfig } from "../src/config.js";
import { BASE_SEPOLIA_CAIP2, WORKERS, type WorkerId } from "../src/constants.js";

const BASE_SEPOLIA_USDC = getAddress("0x036CbD53842c5426634e7929541eC2318f3dCF7e");
const BASE_SEPOLIA_RPC = "https://sepolia.base.org";
const BASESCAN_TX = "https://sepolia.basescan.org/tx/";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function silentPcmWavBase64(): string {
  const wav = Buffer.alloc(44 + 3_200);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(3_200, 40);
  return wav.toString("base64");
}

function assertSafeRequirement(
  requirement: PaymentRequirements,
  treasury: Address,
  expectedAmount: bigint,
): void {
  assert(requirement.scheme === "exact", "Refusing non-exact payment scheme");
  assert(requirement.network === BASE_SEPOLIA_CAIP2, "Refusing payment outside Base Sepolia");
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

function assertWorkerResponse(
  worker: WorkerId,
  body: Record<string, unknown>,
): { output: Record<string, unknown> } {
  assert(body.worker === worker, `Worker response mismatch for ${worker}`);
  const result = body.result;
  assert(typeof result === "object" && result !== null, `Missing result for ${worker}`);
  const resultObject = result as Record<string, unknown>;
  if (worker === WORKERS.textToSpeech.id) {
    assert(resultObject.mediaType === "audio/mpeg", "Speech result is not MP3");
    assert(Number(resultObject.bytes) > 0, "Speech result is empty");
    return { output: { mediaType: resultObject.mediaType, bytes: resultObject.bytes } };
  }
  if (worker === WORKERS.generateDraftImage.id) {
    assert(resultObject.mediaType === "image/webp", "Image result is not WebP");
    assert(Number(resultObject.bytes) > 0, "Image result is empty");
    return { output: { mediaType: resultObject.mediaType, bytes: resultObject.bytes } };
  }
  const validation = body.validation as { valid?: boolean } | undefined;
  assert(validation?.valid === true, `Worker output was not validated for ${worker}`);
  return { output: resultObject };
}

async function main(): Promise<void> {
  assert(process.env.PAYMENTS_MODE === "off", "Saved PAYMENTS_MODE must be off");
  assert(process.env.TREASURY_MODE === "disabled", "Saved TREASURY_MODE must be disabled");
  const publicBaseUrl = process.env.X402_TEST_BASE_URL?.replace(/\/$/, "");
  assert(publicBaseUrl, "X402_TEST_BASE_URL is required");
  const target = new URL(publicBaseUrl);
  assert(target.protocol === "https:", "Test target must use HTTPS");
  assert(!target.username && !target.password && !target.search && !target.hash, "Unsafe test target URL");

  const config = loadConfig({
    ...process.env,
    APP_ENV: "development",
    PAYMENTS_MODE: "development",
    TREASURY_MODE: "disabled",
    PUBLIC_BASE_URL: publicBaseUrl,
    BASE_RPC_URL: BASE_SEPOLIA_RPC,
  });
  assert(config.treasuryAddress, "TREASURY_ADDRESS is not configured");
  assert(config.cdpApiKeyId && config.cdpApiKeySecret, "CDP facilitator credentials are missing");

  const allCases: Array<{
    worker: WorkerId;
    path: string;
    priceUsd: number;
    body: Record<string, unknown>;
  }> = [
    {
      worker: WORKERS.classifyText.id,
      path: WORKERS.classifyText.path,
      priceUsd: config.x402ClassifyPriceUsd,
      body: { source: "The package arrived broken; please issue a refund.", labels: ["refund", "sales", "technical_support"] },
    },
    {
      worker: WORKERS.summarizeText.id,
      path: WORKERS.summarizeText.path,
      priceUsd: config.x402SummarizePriceUsd,
      body: { source: "The team approved the launch. Ada owns release operations. Testing finishes Friday, and the main risk is documentation readiness.", maxKeyPoints: 3 },
    },
    {
      worker: WORKERS.textToSpeech.id,
      path: WORKERS.textToSpeech.path,
      priceUsd: config.x402TtsPriceUsd,
      body: { text: "The agent storefront is ready.", voice: "af_sky", speed: 1 },
    },
    {
      worker: WORKERS.generateDraftImage.id,
      path: WORKERS.generateDraftImage.path,
      priceUsd: config.x402ImagePriceUsd,
      body: { prompt: "A clean isometric robot storefront icon on a white background" },
    },
    {
      worker: WORKERS.transcribeAudio.id,
      path: WORKERS.transcribeAudio.path,
      priceUsd: config.x402TranscribePriceUsd,
      body: { audioBase64: silentPcmWavBase64(), language: "en" },
    },
  ];
  const requestedWorker = process.env.X402_TEST_WORKER;
  const cases = requestedWorker
    ? allCases.filter(testCase => testCase.worker === requestedWorker)
    : allCases;
  assert(cases.length > 0, `Unknown X402_TEST_WORKER: ${requestedWorker ?? ""}`);
  const amounts = cases.map(testCase => parseUnits(testCase.priceUsd.toFixed(6), 6));
  const totalAmount = amounts.reduce((sum, amount) => sum + amount, 0n);
  assert(totalAmount <= 55_000n, "Acceptance test is hard-capped at 0.055000 test USDC");
  if (!requestedWorker) {
    assert(totalAmount === 55_000n, "All-worker test must total 0.055000 test USDC");
  }

  const buyer = privateKeyToAccount(generatePrivateKey());
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(BASE_SEPOLIA_RPC) });
  const readUsdcBalance = (address: Address) =>
    publicClient.readContract({
      address: BASE_SEPOLIA_USDC,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [address],
    });
  const cdp = new CdpClient({ apiKeyId: config.cdpApiKeyId, apiKeySecret: config.cdpApiKeySecret });
  const treasuryBefore = await readUsdcBalance(config.treasuryAddress);
  const faucet = await cdp.evm.requestFaucet({
    address: buyer.address,
    network: "base-sepolia",
    token: "usdc",
    idempotencyKey: crypto.randomUUID(),
  });
  console.info(JSON.stringify({
    event: "test_usdc_faucet_requested",
    network: BASE_SEPOLIA_CAIP2,
    ephemeralBuyer: buyer.address,
    transaction: faucet.transactionHash,
    explorer: `${BASESCAN_TX}${faucet.transactionHash}`,
  }));
  await publicClient.waitForTransactionReceipt({ hash: faucet.transactionHash, timeout: 120_000 });
  let buyerBefore = await readUsdcBalance(buyer.address);
  for (let attempt = 0; buyerBefore < totalAmount && attempt < 30; attempt += 1) {
    await delay(1_000);
    buyerBefore = await readUsdcBalance(buyer.address);
  }
  assert(buyerBefore >= totalAmount, "Faucet balance is too small for all worker tests");

  const settlements: Array<Record<string, unknown>> = [];
  for (const [index, testCase] of cases.entries()) {
    const expectedAmount = amounts[index]!;
    const endpoint = `${publicBaseUrl}${testCase.path}`;
    const request = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(testCase.body),
    } satisfies RequestInit;
    const unpaid = await fetch(endpoint, request);
    assert(unpaid.status === 402, `Expected unpaid HTTP 402 for ${testCase.worker}`);
    const requiredHeader = unpaid.headers.get("payment-required");
    assert(requiredHeader, `Missing PAYMENT-REQUIRED for ${testCase.worker}`);
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader);
    assert(paymentRequired.x402Version === 2 && paymentRequired.accepts.length === 1, "Unexpected payment options");
    assertSafeRequirement(paymentRequired.accepts[0]!, config.treasuryAddress, expectedAmount);

    const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
      schemes: [{ network: BASE_SEPOLIA_CAIP2, client: new ExactEvmScheme(buyer) }],
      paymentRequirementsSelector: (_version, requirements) => {
        assert(requirements.length === 1, "Refusing multiple payment options");
        assertSafeRequirement(requirements[0]!, config.treasuryAddress!, expectedAmount);
        return requirements[0]!;
      },
    });
    const paid = await fetchWithPayment(endpoint, request);
    const body = (await paid.json()) as Record<string, unknown>;
    assert(paid.status === 200, `Paid worker ${testCase.worker} returned HTTP ${paid.status}`);
    const checked = assertWorkerResponse(testCase.worker, body);
    const responseHeader = paid.headers.get("payment-response");
    assert(responseHeader, `Missing PAYMENT-RESPONSE for ${testCase.worker}`);
    const settlement = decodePaymentResponseHeader(responseHeader);
    assert(settlement.success && settlement.network === BASE_SEPOLIA_CAIP2, `Settlement failed for ${testCase.worker}`);
    const hash = settlement.transaction as Hex;
    assert(/^0x[0-9a-fA-F]{64}$/.test(hash), "Settlement hash is invalid");
    await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
    settlements.push({
      worker: testCase.worker,
      amount: formatUnits(expectedAmount, 6),
      paidStatus: paid.status,
      output: checked.output,
      settlementTransaction: hash,
      settlementExplorer: `${BASESCAN_TX}${hash}`,
    });
  }

  const [treasuryAfter, buyerAfter] = await Promise.all([
    readUsdcBalance(config.treasuryAddress),
    readUsdcBalance(buyer.address),
  ]);
  assert(treasuryAfter - treasuryBefore === totalAmount, "Treasury did not receive the exact total");
  assert(buyerBefore - buyerAfter === totalAmount, "Buyer did not spend the exact total");
  console.info(JSON.stringify({
    result: "PASS",
    network: BASE_SEPOLIA_CAIP2,
    asset: "test USDC",
    totalAmount: formatUnits(totalAmount, 6),
    treasury: config.treasuryAddress,
    treasuryTestUsdcBefore: formatUnits(treasuryBefore, 6),
    treasuryTestUsdcAfter: formatUnits(treasuryAfter, 6),
    treasuryTestUsdcDelta: formatUnits(treasuryAfter - treasuryBefore, 6),
    savedPaymentsMode: process.env.PAYMENTS_MODE,
    savedTreasuryMode: process.env.TREASURY_MODE,
    faucetTransaction: faucet.transactionHash,
    faucetExplorer: `${BASESCAN_TX}${faucet.transactionHash}`,
    settlements,
  }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "All-worker Base Sepolia test failed");
  process.exitCode = 1;
});
