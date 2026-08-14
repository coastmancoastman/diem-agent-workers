import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { SERVICE_VERSION, WORKERS, WORKER_ID } from "../src/constants.js";
import { parseTranscribeAudioInput } from "../src/schema.js";
import type { ExtractJsonResult, JsonWorkerResult } from "../src/venice.js";
import { testConfig, validSchema } from "./helpers.js";

describe("machine-first HTTP API", () => {
  it("exposes an agent-first root discovery document", async () => {
    const app = await buildApp(testConfig());
    const response = await request(app).get("/").expect(200);
    expect(response.body.discovery.catalog).toBe("http://test.local/v1/catalog");
    expect(response.body.version).toBe(SERVICE_VERSION);
    expect(response.body.discovery.openapi).toBe("http://test.local/openapi.json");
    expect(response.body.discovery.agentCard).toBe(
      "http://test.local/.well-known/agent-card.json",
    );
  });

  it("publishes health, catalog, OpenAPI, and llms discovery", async () => {
    const app = await buildApp(testConfig());
    const health = await request(app).get("/health");
    expect(health.status).toBe(200);
    expect(health.body.computeBudget).toEqual({
      currency: "DIEM",
      cap: 1.69,
      period: "EPOCH",
      resetsAt: "00:00 UTC",
    });
    expect(health.body.version).toBe(SERVICE_VERSION);
    const catalog = await request(app).get("/v1/catalog");
    expect(catalog.body.workers[0].id).toBe(WORKER_ID);
    expect(catalog.body.workers).toHaveLength(6);
    const transcription = catalog.body.workers.find(
      (worker: { id: string }) => worker.id === WORKERS.transcribeAudio.id,
    );
    expect(() => parseTranscribeAudioInput(transcription.example)).not.toThrow();
    const wellKnownCatalog = await request(app).get("/.well-known/agent-catalog.json");
    expect(wellKnownCatalog.body).toEqual(catalog.body);
    expect(catalog.body.computeBudget).toEqual({
      provider: "venice",
      currency: "DIEM",
      cap: 1.69,
      period: "EPOCH",
      resetsAt: "00:00 UTC",
      enforcement: "provider_api_key",
    });
    expect((await request(app).get("/openapi.json")).body.openapi).toBe("3.1.0");
    const llms = (await request(app).get("/llms.txt")).text;
    expect(llms).toContain(WORKER_ID);
    expect(llms).toContain("1.69 DIEM per EPOCH");
    const card = await request(app).get("/.well-known/agent-card.json");
    expect(card.body.supportedInterfaces[0]).toMatchObject({
      url: "http://test.local/a2a",
      protocolBinding: "JSONRPC",
      protocolVersion: "1.0",
    });
    await request(app).post("/v1/quote/not-a-worker").expect(404, {
      error: "worker_not_found",
    });
  });

  it("runs the worker through an injected provider and returns validated output", async () => {
    const extractor = vi.fn(async (): Promise<ExtractJsonResult> => ({
      worker: WORKER_ID,
      result: { name: "Ada", count: 3 },
      validation: { valid: true as const },
      provider: { name: "venice" as const, model: "test" },
      usage: {},
    }));
    const app = await buildApp(testConfig(), { extractor });
    const response = await request(app)
      .post("/v1/jobs/extract-json")
      .send({ source: "Ada has 3 cats", schema: validSchema });
    expect(response.status).toBe(200);
    expect(response.body.result).toEqual({ name: "Ada", count: 3 });
    expect(extractor).toHaveBeenCalledOnce();
  });

  it("rejects an invalid schema before provider inference", async () => {
    const extractor = vi.fn();
    const app = await buildApp(testConfig(), { extractor });
    const response = await request(app)
      .post("/v1/jobs/extract-json")
      .send({
        source: "Ada has 3 cats",
        schema: { type: "object", properties: {}, required: [] },
      });
    expect(response.status).toBe(400);
    expect(extractor).not.toHaveBeenCalled();
  });

  it("runs classification directly and through the A2A 1.0 adapter", async () => {
    const classifier = vi.fn(async (): Promise<JsonWorkerResult> => ({
      worker: WORKERS.classifyText.id,
      result: { label: "refund", rationale: "Refund requested", confidence: 0.99 },
      validation: { valid: true },
      provider: { name: "venice", model: "test" },
      usage: {},
    }));
    const app = await buildApp(testConfig(), { classifier });
    const input = { source: "Please refund me", labels: ["refund", "other"] };
    const direct = await request(app).post(WORKERS.classifyText.path).send(input);
    expect(direct.status).toBe(200);
    expect(direct.body.result.label).toBe("refund");

    const a2a = await request(app)
      .post("/a2a")
      .set("A2A-Version", "1.0")
      .send({
        jsonrpc: "2.0",
        id: "request-1",
        method: "SendMessage",
        params: {
          message: {
            role: "ROLE_USER",
            messageId: "message-1",
            parts: [
              {
                data: { worker: WORKERS.classifyText.id, input },
                mediaType: "application/json",
              },
            ],
          },
        },
      });
    expect(a2a.status).toBe(200);
    expect(a2a.body.jsonrpc).toBe("2.0");
    expect(a2a.body.result.task.status.state).toBe("TASK_STATE_COMPLETED");
    expect(classifier).toHaveBeenCalledTimes(2);
  });

  it("rejects invalid A2A methods before provider work", async () => {
    const classifier = vi.fn();
    const app = await buildApp(testConfig(), { classifier });
    const response = await request(app).post("/a2a").send({
      jsonrpc: "2.0",
      id: 1,
      method: "DeleteEverything",
      params: {},
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(-32601);
    expect(classifier).not.toHaveBeenCalled();
  });

  it("serves a stateless Streamable HTTP MCP endpoint", async () => {
    const app = await buildApp(testConfig());
    const response = await request(app)
      .post("/mcp")
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      });
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.text).toContain('"serverInfo"');
    expect(response.text).toContain('"name":"diem-agent-workers"');
    expect(response.text).toContain('"version":"0.2.0"');
  });
});
