import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { TREASURY_LIVE_ACK } from "../src/constants.js";

describe("configuration safety", () => {
  it("defaults to unpaid development and a disabled treasury", () => {
    const config = loadConfig({ APP_ENV: "test" });
    expect(config.paymentsMode).toBe("off");
    expect(config.treasuryMode).toBe("disabled");
    expect(config.publicBaseUrl).toBe("http://localhost:8402");
    expect(config.veniceBaseUrl).toBe("https://api.venice.ai/api/v1");
    expect(config.veniceDiemEpochCap).toBe(1.69);
  });

  it("validates the declared Venice DIEM epoch cap", () => {
    expect(
      loadConfig({ APP_ENV: "test", VENICE_DIEM_EPOCH_CAP: "1.69" })
        .veniceDiemEpochCap,
    ).toBe(1.69);
    expect(() =>
      loadConfig({ APP_ENV: "test", VENICE_DIEM_EPOCH_CAP: "0" }),
    ).toThrow(/VENICE_DIEM_EPOCH_CAP/);
  });

  it("uses the HTTPS Vercel deployment URL when no explicit public URL is set", () => {
    const config = loadConfig({
      APP_ENV: "test",
      VERCEL_URL: "diem-agent-workers-preview.vercel.app",
    });
    expect(config.publicBaseUrl).toBe(
      "https://diem-agent-workers-preview.vercel.app",
    );
  });

  it("normalizes and requires HTTPS for the Venice base URL", () => {
    expect(
      loadConfig({ APP_ENV: "test", VENICE_BASE_URL: "https://api.venice.ai/api/v1/" })
        .veniceBaseUrl,
    ).toBe("https://api.venice.ai/api/v1");
    expect(() =>
      loadConfig({ APP_ENV: "test", VENICE_BASE_URL: "http://api.venice.ai/api/v1" }),
    ).toThrow(/must use HTTPS/);
  });

  it("refuses to serve production without production payments", () => {
    expect(() => loadConfig({ APP_ENV: "production", PAYMENTS_MODE: "off" })).toThrow(
      /PAYMENTS_MODE=production/,
    );
  });

  it("requires a signer and exact acknowledgement for live reinvestment", () => {
    const common = {
      APP_ENV: "test",
      TREASURY_MODE: "live",
      TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
      ZEROX_API_KEY: "test",
      TREASURY_PRIVATE_KEY: `0x${"11".repeat(32)}`,
    };
    expect(() => loadConfig(common)).toThrow(/TREASURY_LIVE_ACK/);
    expect(() =>
      loadConfig({ ...common, TREASURY_LIVE_ACK }),
    ).not.toThrow();
  });

  it("allows live signing through paired macOS Keychain labels", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "test",
        TREASURY_MODE: "live",
        TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
        ZEROX_API_KEY: "test",
        TREASURY_KEYCHAIN_SERVICE: "com.example.treasury",
        TREASURY_KEYCHAIN_ACCOUNT: "0x1111111111111111111111111111111111111111",
        TREASURY_LIVE_ACK,
      }),
    ).not.toThrow();
  });

  it("refuses to take x402 payments before inference and settlement are configured", () => {
    expect(() =>
      loadConfig({
        APP_ENV: "test",
        PAYMENTS_MODE: "development",
        TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
      }),
    ).toThrow(/VENICE_API_KEY/);
    expect(() =>
      loadConfig({
        APP_ENV: "test",
        PAYMENTS_MODE: "development",
        TREASURY_ADDRESS: "0x1111111111111111111111111111111111111111",
        VENICE_API_KEY: "test",
      }),
    ).toThrow(/CDP_API_KEY_ID/);
  });
});
