import { parseEther, parseUnits } from "viem";
import { describe, expect, it } from "vitest";
import {
  BASE_DIEM_ADDRESS,
  BASE_USDC_ADDRESS,
  ZEROX_ALLOWANCE_HOLDER,
} from "../src/constants.js";
import { decideTreasuryAction } from "../src/treasury/policy.js";
import {
  validateZeroExPrice,
  validateZeroExQuote,
  type ZeroExQuote,
} from "../src/treasury/zerox.js";
import { testConfig } from "./helpers.js";

function quote(overrides: Partial<ZeroExQuote> = {}): ZeroExQuote {
  return {
    liquidityAvailable: true,
    buyAmount: parseUnits("2", 18).toString(),
    minBuyAmount: parseUnits("1.98", 18).toString(),
    sellAmount: parseUnits("5", 6).toString(),
    sellToken: BASE_USDC_ADDRESS,
    buyToken: BASE_DIEM_ADDRESS,
    allowanceTarget: ZEROX_ALLOWANCE_HOLDER,
    transaction: {
      to: ZEROX_ALLOWANCE_HOLDER,
      data: "0x1234567890",
      value: "0",
      gas: "200000",
    },
    ...overrides,
  };
}

describe("DIEM-only treasury", () => {
  it("caps each purchase and preserves the configured USDC holdback", () => {
    const config = testConfig({
      TREASURY_MODE: "quote",
      TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
      ZEROX_API_KEY: "test",
      TREASURY_USDC_HOLDBACK: "2",
      TREASURY_MAX_SWAP_USDC: "25",
    });
    const decision = decideTreasuryAction(
      parseUnits("100", 6),
      parseEther("0.01"),
      config,
    );
    expect(decision.action).toBe("quote");
    expect(decision.sellAmount).toBe(parseUnits("25", 6));
  });

  it("halts when the gas reserve is too low", () => {
    const config = testConfig({
      TREASURY_MODE: "quote",
      TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
      ZEROX_API_KEY: "test",
    });
    expect(
      decideTreasuryAction(parseUnits("20", 6), 0n, config).reason,
    ).toBe("below_eth_gas_reserve");
  });

  it("accepts only exact USDC-to-DIEM quotes through the allowlisted entry point", () => {
    const config = testConfig();
    expect(validateZeroExQuote(quote(), parseUnits("5", 6), config).buyAmount).toBe(
      parseUnits("2", 18),
    );
    expect(() =>
      validateZeroExQuote(
        quote({ buyToken: "0x1111111111111111111111111111111111111111" }),
        parseUnits("5", 6),
        config,
      ),
    ).toThrow(/not Venice DIEM/);
    expect(() =>
      validateZeroExQuote(
        quote({
          transaction: {
            to: "0x1111111111111111111111111111111111111111",
            data: "0x1234567890",
            value: "0",
          },
        }),
        parseUnits("5", 6),
        config,
      ),
    ).toThrow(/official AllowanceHolder/);
  });

  it("validates read-only indicative prices without transaction calldata", () => {
    expect(
      validateZeroExPrice(
        {
          buyAmount: parseUnits("2", 18).toString(),
          sellAmount: parseUnits("5", 6).toString(),
          sellToken: BASE_USDC_ADDRESS,
          buyToken: BASE_DIEM_ADDRESS,
        },
        parseUnits("5", 6),
      ).buyAmount,
    ).toBe(parseUnits("2", 18));
  });
});
