import { getAddress, isHex, type Address, type Hex } from "viem";
import type { AppConfig } from "../config.js";
import {
  BASE_CHAIN_ID,
  BASE_DIEM_ADDRESS,
  BASE_USDC_ADDRESS,
  ZEROX_ALLOWANCE_HOLDER,
  ZEROX_QUOTE_URL,
} from "../constants.js";

export interface ZeroExQuote {
  liquidityAvailable?: boolean;
  buyAmount: string;
  sellAmount: string;
  minBuyAmount?: string;
  buyToken?: string;
  sellToken?: string;
  allowanceTarget?: string;
  issues?: {
    allowance?: { actual?: string; spender?: string } | null;
    simulationIncomplete?: boolean;
    balance?: { actual?: string; expected?: string } | null;
  };
  transaction: {
    to: string;
    data: string;
    value?: string;
    gas?: string;
    gasPrice?: string;
  };
}

export interface ZeroExPrice {
  liquidityAvailable?: boolean;
  buyAmount: string;
  sellAmount: string;
  minBuyAmount?: string;
  buyToken?: string;
  sellToken?: string;
  issues?: { simulationIncomplete?: boolean };
}

export interface ValidatedZeroExPrice {
  buyAmount: bigint;
  minBuyAmount: bigint;
  sellAmount: bigint;
  raw: ZeroExPrice;
}

export interface ValidatedZeroExQuote {
  buyAmount: bigint;
  minBuyAmount: bigint;
  sellAmount: bigint;
  allowanceTarget: Address;
  transaction: {
    to: Address;
    data: Hex;
    value: bigint;
    gas?: bigint;
    gasPrice?: bigint;
  };
  raw: ZeroExQuote;
}

function checkedAddress(value: string | undefined, label: string): Address {
  if (!value) throw new Error(`0x quote missing ${label}`);
  try {
    return getAddress(value);
  } catch {
    throw new Error(`0x quote returned invalid ${label}`);
  }
}

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function validateZeroExQuote(
  quote: ZeroExQuote,
  expectedSellAmount: bigint,
  config: Pick<AppConfig, "treasuryMaxGas">,
): ValidatedZeroExQuote {
  if (quote.liquidityAvailable === false) throw new Error("No USDC/DIEM liquidity available");
  if (quote.issues?.simulationIncomplete) {
    throw new Error("0x quote simulation is incomplete");
  }

  const sellAmount = BigInt(quote.sellAmount);
  const buyAmount = BigInt(quote.buyAmount);
  const minBuyAmount = BigInt(quote.minBuyAmount ?? quote.buyAmount);
  if (sellAmount !== expectedSellAmount) throw new Error("0x quote changed the sell amount");
  if (buyAmount <= 0n || minBuyAmount <= 0n || minBuyAmount > buyAmount) {
    throw new Error("0x quote returned invalid buy amounts");
  }

  if (quote.sellToken) {
    const sellToken = checkedAddress(quote.sellToken, "sellToken");
    if (!sameAddress(sellToken, BASE_USDC_ADDRESS)) {
      throw new Error("0x quote sell token is not Base USDC");
    }
  }
  if (quote.buyToken) {
    const buyToken = checkedAddress(quote.buyToken, "buyToken");
    if (!sameAddress(buyToken, BASE_DIEM_ADDRESS)) {
      throw new Error("0x quote buy token is not Venice DIEM");
    }
  }

  const target = checkedAddress(quote.transaction.to, "transaction.to");
  if (!sameAddress(target, ZEROX_ALLOWANCE_HOLDER)) {
    throw new Error("0x transaction target is not the official AllowanceHolder");
  }
  const allowanceTarget = checkedAddress(
    quote.issues?.allowance?.spender ?? quote.allowanceTarget ?? quote.transaction.to,
    "allowance target",
  );
  if (!sameAddress(allowanceTarget, ZEROX_ALLOWANCE_HOLDER)) {
    throw new Error("0x allowance target is not the official AllowanceHolder");
  }
  if (!isHex(quote.transaction.data) || quote.transaction.data.length < 10) {
    throw new Error("0x quote returned invalid calldata");
  }

  const value = BigInt(quote.transaction.value ?? "0");
  if (value !== 0n) throw new Error("ERC-20 swap unexpectedly requests native ETH value");
  const gas = quote.transaction.gas ? BigInt(quote.transaction.gas) : undefined;
  if (gas !== undefined && gas > config.treasuryMaxGas) {
    throw new Error("0x quote exceeds configured gas limit");
  }

  return {
    buyAmount,
    minBuyAmount,
    sellAmount,
    allowanceTarget,
    transaction: {
      to: target,
      data: quote.transaction.data as Hex,
      value,
      ...(gas !== undefined ? { gas } : {}),
      ...(quote.transaction.gasPrice !== undefined
        ? { gasPrice: BigInt(quote.transaction.gasPrice) }
        : {}),
    },
    raw: quote,
  };
}

export function validateZeroExPrice(
  price: ZeroExPrice,
  expectedSellAmount: bigint,
): ValidatedZeroExPrice {
  if (price.liquidityAvailable === false) throw new Error("No USDC/DIEM liquidity available");
  if (price.issues?.simulationIncomplete) throw new Error("0x price simulation is incomplete");
  const sellAmount = BigInt(price.sellAmount);
  const buyAmount = BigInt(price.buyAmount);
  const minBuyAmount = BigInt(price.minBuyAmount ?? price.buyAmount);
  if (sellAmount !== expectedSellAmount) throw new Error("0x price changed the sell amount");
  if (buyAmount <= 0n || minBuyAmount <= 0n || minBuyAmount > buyAmount) {
    throw new Error("0x price returned invalid buy amounts");
  }
  if (price.sellToken) {
    const sellToken = checkedAddress(price.sellToken, "sellToken");
    if (!sameAddress(sellToken, BASE_USDC_ADDRESS)) {
      throw new Error("0x price sell token is not Base USDC");
    }
  }
  if (price.buyToken) {
    const buyToken = checkedAddress(price.buyToken, "buyToken");
    if (!sameAddress(buyToken, BASE_DIEM_ADDRESS)) {
      throw new Error("0x price buy token is not Venice DIEM");
    }
  }
  return { buyAmount, minBuyAmount, sellAmount, raw: price };
}

function zeroExParams(taker: Address, sellAmount: bigint, config: AppConfig): URLSearchParams {
  return new URLSearchParams({
    chainId: String(BASE_CHAIN_ID),
    sellToken: BASE_USDC_ADDRESS,
    buyToken: BASE_DIEM_ADDRESS,
    sellAmount: sellAmount.toString(),
    taker,
    slippageBps: String(config.treasuryMaxSlippageBps),
  });
}

function zeroExHeaders(config: AppConfig): Record<string, string> {
  if (!config.zeroExApiKey) throw new Error("ZEROX_API_KEY is required");
  return {
    "0x-api-key": config.zeroExApiKey,
    "0x-version": "v2",
    accept: "application/json",
  };
}

export async function fetchZeroExPrice(
  taker: Address,
  sellAmount: bigint,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidatedZeroExPrice> {
  const response = await fetchImpl(
    `https://api.0x.org/swap/allowance-holder/price?${zeroExParams(taker, sellAmount, config)}`,
    {
      headers: zeroExHeaders(config),
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) throw new Error(`0x price failed with HTTP ${response.status}`);
  return validateZeroExPrice((await response.json()) as ZeroExPrice, sellAmount);
}

export async function fetchZeroExQuote(
  taker: Address,
  sellAmount: bigint,
  config: AppConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidatedZeroExQuote> {
  const response = await fetchImpl(`${ZEROX_QUOTE_URL}?${zeroExParams(taker, sellAmount, config)}`, {
    headers: zeroExHeaders(config),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`0x quote failed with HTTP ${response.status}`);
  }
  const quote = (await response.json()) as ZeroExQuote;
  return validateZeroExQuote(quote, sellAmount, config);
}
