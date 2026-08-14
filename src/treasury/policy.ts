import { parseUnits } from "viem";
import type { AppConfig } from "../config.js";

export interface TreasuryDecision {
  action: "skip" | "quote" | "execute";
  reason: string;
  sellAmount: bigint;
}

export function decideTreasuryAction(
  usdcBalance: bigint,
  ethBalance: bigint,
  config: AppConfig,
): TreasuryDecision {
  if (config.treasuryMode === "disabled") {
    return { action: "skip", reason: "treasury_disabled", sellAmount: 0n };
  }

  const holdback = parseUnits(config.treasuryUsdcHoldback.toString(), 6);
  const minimum = parseUnits(config.treasuryMinSwapUsdc.toString(), 6);
  const maximum = parseUnits(config.treasuryMaxSwapUsdc.toString(), 6);
  const minEth = parseUnits(config.treasuryMinEthReserve.toString(), 18);
  const available = usdcBalance > holdback ? usdcBalance - holdback : 0n;

  if (available < minimum) {
    return { action: "skip", reason: "below_minimum_usdc", sellAmount: 0n };
  }
  if (ethBalance < minEth) {
    return { action: "skip", reason: "below_eth_gas_reserve", sellAmount: 0n };
  }

  return {
    action: config.treasuryMode === "live" ? "execute" : "quote",
    reason: config.treasuryMode === "live" ? "live_policy_authorized" : "quote_only",
    sellAmount: available > maximum ? maximum : available,
  };
}
