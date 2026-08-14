import { describe, expect, it } from "vitest";
import { BASE_CAIP2, WORKERS } from "../src/constants.js";
import { paymentRoutes } from "../src/payments.js";
import { testConfig } from "./helpers.js";

describe("x402 discovery route metadata", () => {
  it("publishes full Base mainnet resource metadata for every worker", () => {
    const config = testConfig({
      PUBLIC_BASE_URL: "https://diem-agent-workers.vercel.app",
    });
    const routes = paymentRoutes(config, BASE_CAIP2);

    for (const worker of Object.values(WORKERS)) {
      const route = routes[`POST ${worker.path}`];
      expect(route).toBeDefined();
      expect(route).toMatchObject({
        resource: `https://diem-agent-workers.vercel.app${worker.path}`,
        serviceName: "DIEM Agent Workers",
        iconUrl: "https://diem-agent-workers.vercel.app/icon.svg",
        mimeType: "application/json",
      });
      expect(route?.tags).toHaveLength(5);
      expect(route?.tags).toContain("private-ai");
      expect(route?.tags).toContain("x402");
      expect(route?.accepts).toMatchObject({
        scheme: "exact",
        payTo: "",
        network: BASE_CAIP2,
        maxTimeoutSeconds: 300,
      });
      expect(route?.extensions).toHaveProperty("bazaar");
    }
  });
});
