import { describe, expect, it, vi } from "vitest";
import {
  classifyTextWithVenice,
  extractJsonWithVenice,
  generateDraftImageWithVenice,
  textToSpeechWithVenice,
} from "../src/venice.js";
import { testConfig, validSchema } from "./helpers.js";

describe("Venice worker", () => {
  it("uses structured output, disables search, and validates the result", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(String(_url)).toBe("https://api.venice.ai/api/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.response_format.json_schema.schema).toEqual(validSchema);
      expect(body.venice_parameters.enable_web_search).toBe("off");
      expect(body.venice_parameters.include_venice_system_prompt).toBe(false);
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          model: "venice-uncensored",
          choices: [{ message: { content: JSON.stringify({ name: "Ada", count: 3 }) } }],
          usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await extractJsonWithVenice(
      { source: "Ada has 3 cats", schema: validSchema },
      testConfig({ VENICE_API_KEY: "secret" }),
      fetchMock as typeof fetch,
    );
    expect(result.result).toEqual({ name: "Ada", count: 3 });
    expect(result.validation.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects a provider result that violates the caller schema", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ name: "Ada", count: "three" }) } }],
        }),
        { status: 200 },
      ),
    );
    await expect(
      extractJsonWithVenice(
        { source: "Ada has 3 cats", schema: validSchema },
        testConfig({ VENICE_API_KEY: "secret" }),
        fetchMock as typeof fetch,
      ),
    ).rejects.toThrow(/schema validation/);
  });
});

describe("Venice media and classification workers", () => {
  it("constrains classification to caller labels with search disabled", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.response_format.json_schema.schema.properties.label.enum).toEqual([
        "refund",
        "other",
      ]);
      expect(body.venice_parameters.enable_web_search).toBe("off");
      return new Response(
        JSON.stringify({
          model: "qwen3-5-9b",
          choices: [
            {
              message: {
                content: JSON.stringify({
                  label: "refund",
                  rationale: "A refund was requested.",
                  confidence: 0.99,
                }),
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const result = await classifyTextWithVenice(
      { source: "Refund this", labels: ["refund", "other"] },
      testConfig({ VENICE_API_KEY: "secret" }),
      fetchMock as typeof fetch,
    );
    expect(result.result).toMatchObject({ label: "refund" });
  });

  it("forces bounded MP3 speech settings", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/audio\/speech$/);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "tts-kokoro",
        response_format: "mp3",
        streaming: false,
        voice: "af_heart",
      });
      return new Response(Uint8Array.from([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "audio/mpeg" },
      });
    });
    const result = await textToSpeechWithVenice(
      { text: "hello", voice: "af_heart", speed: 1 },
      testConfig({ VENICE_API_KEY: "secret" }),
      fetchMock as typeof fetch,
    );
    expect(result.result).toEqual({ base64: "AQID", mediaType: "audio/mpeg", bytes: 3 });
  });

  it("forces draft images into one safe, non-search WebP generation", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toMatch(/\/image\/generate$/);
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        model: "venice-sd35",
        variants: 1,
        safe_mode: true,
        enable_web_search: false,
        enhance_prompt: false,
        format: "webp",
      });
      return new Response(JSON.stringify({ id: "image-1", images: ["AQID"] }), {
        status: 200,
      });
    });
    const result = await generateDraftImageWithVenice(
      { prompt: "a robot" },
      testConfig({ VENICE_API_KEY: "secret" }),
      fetchMock as typeof fetch,
    );
    expect(result.result.mediaType).toBe("image/webp");
    expect(result.result.bytes).toBe(3);
  });
});
