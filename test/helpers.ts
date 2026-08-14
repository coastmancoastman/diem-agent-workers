import { loadConfig, type AppConfig } from "../src/config.js";

export function testConfig(overrides: NodeJS.ProcessEnv = {}): AppConfig {
  return loadConfig({
    APP_ENV: "test",
    PAYMENTS_MODE: "off",
    TREASURY_MODE: "disabled",
    PUBLIC_BASE_URL: "http://test.local",
    ...overrides,
  });
}

export const validSchema = {
  type: "object",
  properties: {
    name: { type: ["string", "null"] },
    count: { type: ["integer", "null"] },
  },
  required: ["name", "count"],
  additionalProperties: false,
};
