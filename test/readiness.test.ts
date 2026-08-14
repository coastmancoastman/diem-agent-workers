import { describe, expect, it, vi } from "vitest";
import { WORKERS } from "../src/constants.js";
import { VeniceReadiness } from "../src/readiness.js";
import { testConfig } from "./helpers.js";

function model(id: string, type: string, schema = false) {
  return {
    id,
    type,
    model_spec: {
      offline: false,
      privacy: "private",
      capabilities: { supportsResponseSchema: schema },
    },
  };
}

describe("pre-payment Venice readiness", () => {
  it("checks capacity and required model capabilities, then caches success", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api_keys/rate_limits")) {
        return new Response(JSON.stringify({ data: { accessPermitted: true } }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          data: [
            model("venice-uncensored-1-2", "text", true),
            model("tts-kokoro", "tts"),
            model("venice-sd35", "image"),
            model("openai/whisper-large-v3", "asr"),
          ],
        }),
        { status: 200 },
      );
    });
    const readiness = new VeniceReadiness(
      testConfig({ VENICE_API_KEY: "secret", VENICE_READINESS_CACHE_MS: "60000" }),
      fetchMock as typeof fetch,
    );
    await readiness.assertReady(WORKERS.extractJson.path);
    await readiness.assertReady(WORKERS.textToSpeech.path);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/models?type=all");
  });

  it("fails closed when the provider denies epoch access", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api_keys/rate_limits")
        ? new Response(JSON.stringify({ accessPermitted: false }), { status: 200 })
        : new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const readiness = new VeniceReadiness(
      testConfig({ VENICE_API_KEY: "secret" }),
      fetchMock as typeof fetch,
    );
    await expect(readiness.assertReady(WORKERS.extractJson.path)).rejects.toMatchObject({
      code: "capacity_denied",
    });
  });

  it("refuses an offline, non-private, or capability-incompatible model", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      String(url).endsWith("/api_keys/rate_limits")
        ? new Response(JSON.stringify({ accessPermitted: true }), { status: 200 })
        : new Response(
            JSON.stringify({
              data: [
                {
                  id: "venice-uncensored-1-2",
                  type: "text",
                  model_spec: {
                    offline: true,
                    privacy: "private",
                    capabilities: { supportsResponseSchema: true },
                  },
                },
              ],
            }),
            { status: 200 },
          ),
    );
    const readiness = new VeniceReadiness(
      testConfig({ VENICE_API_KEY: "secret" }),
      fetchMock as typeof fetch,
    );
    await expect(readiness.assertReady(WORKERS.extractJson.path)).rejects.toMatchObject({
      code: "model_unavailable",
    });
  });
});
