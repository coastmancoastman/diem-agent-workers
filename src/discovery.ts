import {
  BASE_CAIP2,
  BASE_SEPOLIA_CAIP2,
  SERVICE_VERSION,
  TEXT_SOURCE_LIMITS,
  WORKERS,
  type WorkerId,
} from "./constants.js";
import type { AppConfig } from "./config.js";

export const strictExampleSchema = {
  type: "object",
  properties: {
    name: { type: ["string", "null"] },
    category: { type: ["string", "null"] },
    price_usd: { type: ["number", "null"] },
  },
  required: ["name", "category", "price_usd"],
  additionalProperties: false,
} as const;

interface WorkerContract {
  inputSchema: Record<string, unknown>;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  limits: Record<string, unknown>;
  tags: readonly string[];
}

function silentPcmWavExample(): string {
  // 0.1 seconds of unsigned 8-bit mono silence at 8 kHz. Keeping the
  // discovery example runnable lets an agent validate the complete payment
  // flow without first sourcing or uploading media.
  const audio = Buffer.alloc(44 + 800, 0x80);
  audio.write("RIFF", 0);
  audio.writeUInt32LE(audio.length - 8, 4);
  audio.write("WAVE", 8);
  audio.write("fmt ", 12);
  audio.writeUInt32LE(16, 16);
  audio.writeUInt16LE(1, 20);
  audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8_000, 24);
  audio.writeUInt32LE(8_000, 28);
  audio.writeUInt16LE(1, 32);
  audio.writeUInt16LE(8, 34);
  audio.write("data", 36);
  audio.writeUInt32LE(800, 40);
  return audio.toString("base64");
}

export const workerContracts: Record<WorkerId, WorkerContract> = {
  [WORKERS.extractJson.id]: {
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          minLength: 1,
          maxLength: TEXT_SOURCE_LIMITS.extractJson.characters,
          description: "Untrusted source text, treated as data rather than instructions.",
        },
        schema: {
          type: "object",
          description:
            "Strict JSON Schema: object root, every property required, and additionalProperties=false on every object.",
        },
        instructions: { type: "string", maxLength: 500 },
      },
      required: ["source", "schema"],
      additionalProperties: false,
    },
    input: {
      source: "The Acme Trail Mug is drinkware and costs $18.50.",
      schema: strictExampleSchema,
      instructions: "Use the displayed price.",
    },
    output: {
      worker: WORKERS.extractJson.id,
      result: { name: "Acme Trail Mug", category: "drinkware", price_usd: 18.5 },
      validation: { valid: true },
      provider: { name: "venice", model: "venice-uncensored-1-2" },
      usage: { inputTokens: 200, outputTokens: 35, totalTokens: 235 },
    },
    limits: {
      sourceCharacters: TEXT_SOURCE_LIMITS.extractJson.characters,
      sourceUtf8Bytes: TEXT_SOURCE_LIMITS.extractJson.utf8Bytes,
      schemaBytes: 12_000,
      schemaProperties: 60,
    },
    tags: ["extraction", "json", "normalization", "structured-output"],
  },
  [WORKERS.classifyText.id]: {
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          minLength: 1,
          maxLength: TEXT_SOURCE_LIMITS.classifyText.characters,
        },
        labels: {
          type: "array",
          minItems: 2,
          maxItems: 12,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 50 },
        },
      },
      required: ["source", "labels"],
      additionalProperties: false,
    },
    input: {
      source: "The customer asks for a refund after receiving a damaged mug.",
      labels: ["billing", "refund", "technical_support"],
    },
    output: {
      worker: WORKERS.classifyText.id,
      result: { label: "refund", rationale: "The customer explicitly requests a refund.", confidence: 0.98 },
      validation: { valid: true },
    },
    limits: {
      sourceCharacters: TEXT_SOURCE_LIMITS.classifyText.characters,
      sourceUtf8Bytes: TEXT_SOURCE_LIMITS.classifyText.utf8Bytes,
      labels: 12,
    },
    tags: ["classification", "routing", "triage"],
  },
  [WORKERS.summarizeText.id]: {
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          minLength: 1,
          maxLength: TEXT_SOURCE_LIMITS.summarizeText.characters,
        },
        maxKeyPoints: { type: "integer", minimum: 3, maximum: 10, default: 5 },
      },
      required: ["source"],
      additionalProperties: false,
    },
    input: {
      source: "A short product meeting transcript discussing launch timing, risks, and owners.",
      maxKeyPoints: 5,
    },
    output: {
      worker: WORKERS.summarizeText.id,
      result: { abstract: "The team reviewed launch timing and risks.", keyPoints: ["Launch owner assigned", "Risk review scheduled"] },
      validation: { valid: true },
    },
    limits: {
      sourceCharacters: TEXT_SOURCE_LIMITS.summarizeText.characters,
      sourceUtf8Bytes: TEXT_SOURCE_LIMITS.summarizeText.utf8Bytes,
      keyPoints: 10,
    },
    tags: ["summarization", "abstract", "key-points"],
  },
  [WORKERS.textToSpeech.id]: {
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", minLength: 1, maxLength: 1_000 },
        voice: {
          type: "string",
          enum: ["af_heart", "af_sky", "am_adam", "am_michael", "bf_emma", "bm_george"],
          default: "af_heart",
        },
        speed: { type: "number", minimum: 0.75, maximum: 1.5, default: 1 },
      },
      required: ["text"],
      additionalProperties: false,
    },
    input: { text: "Your report is ready.", voice: "af_heart", speed: 1 },
    output: {
      worker: WORKERS.textToSpeech.id,
      result: { base64: "<base64 mp3>", mediaType: "audio/mpeg", bytes: 12345 },
      provider: { name: "venice", model: "tts-kokoro" },
    },
    limits: { textCharacters: 1_000, outputFormat: "mp3" },
    tags: ["audio", "speech", "tts", "mp3"],
  },
  [WORKERS.generateDraftImage.id]: {
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", minLength: 1, maxLength: 1_500 },
        negativePrompt: { type: "string", maxLength: 500 },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    input: { prompt: "A clean isometric robot storefront icon on a white background." },
    output: {
      worker: WORKERS.generateDraftImage.id,
      result: { base64: "<base64 webp>", mediaType: "image/webp", bytes: 234567 },
      provider: { name: "venice", model: "venice-sd35" },
    },
    limits: { promptCharacters: 1_500, images: 1, width: 1024, height: 1024, safeMode: true },
    tags: ["image", "generation", "draft", "webp"],
  },
  [WORKERS.transcribeAudio.id]: {
    inputSchema: {
      type: "object",
      properties: {
        audioBase64: {
          type: "string",
          minLength: 1,
          maxLength: 3_800_000,
          pattern: "^[A-Za-z0-9+/]+={0,2}$",
          description: "Canonical base64 containing a PCM WAV file of at most 60 seconds.",
        },
        language: { type: "string", pattern: "^[a-z]{2}$" },
      },
      required: ["audioBase64"],
      additionalProperties: false,
    },
    input: { audioBase64: silentPcmWavExample(), language: "en" },
    output: {
      worker: WORKERS.transcribeAudio.id,
      result: { text: "Your report is ready.", durationSeconds: 1.4 },
      validation: { valid: true },
    },
    limits: { seconds: 60, decodedBytes: 2_850_000, format: "PCM WAV" },
    tags: ["audio", "transcription", "speech-to-text", "asr"],
  },
};

// Compatibility exports for the original worker and the OpenAPI generator.
export const extractJsonRequestSchema = workerContracts.extract_text_to_json.inputSchema;
export const extractJsonExample = workerContracts.extract_text_to_json.input;
export const extractJsonOutputExample = workerContracts.extract_text_to_json.output;

export function workerPrice(config: AppConfig, id: WorkerId): number {
  const prices: Record<WorkerId, number> = {
    [WORKERS.extractJson.id]: config.x402PriceUsd,
    [WORKERS.classifyText.id]: config.x402ClassifyPriceUsd,
    [WORKERS.summarizeText.id]: config.x402SummarizePriceUsd,
    [WORKERS.textToSpeech.id]: config.x402TtsPriceUsd,
    [WORKERS.generateDraftImage.id]: config.x402ImagePriceUsd,
    [WORKERS.transcribeAudio.id]: config.x402TranscribePriceUsd,
  };
  return prices[id];
}

export function catalog(config: AppConfig) {
  return {
    service: "DIEM Agent Workers",
    version: SERVICE_VERSION,
    description:
      "Bounded, validated micro-work for software agents. Every paid request is validated and capacity-checked before x402 payment.",
    discovery: {
      openapi: `${config.publicBaseUrl}/openapi.json`,
      llms: `${config.publicBaseUrl}/llms.txt`,
      agentCard: `${config.publicBaseUrl}/.well-known/agent-card.json`,
      mcp: `${config.publicBaseUrl}/mcp`,
      terms: `${config.publicBaseUrl}/terms`,
    },
    payment: {
      protocol: "x402",
      mode: config.paymentsMode,
      enabled: config.storefrontEnabled,
      network: config.paymentsMode === "development" ? BASE_SEPOLIA_CAIP2 : BASE_CAIP2,
      currency: "USDC",
      prepaymentSafety: [
        "input_validation",
        "provider_capacity",
        "model_availability",
        "global_compute_budget",
      ],
      deliveryProtection: {
        mode: config.deliveryCreditsMode,
        header: "Idempotency-Key",
        retentionSeconds: config.deliveryCreditTtlSeconds,
        persistedContent: false,
      },
    },
    computeBudget: {
      provider: {
        name: "venice",
        currency: "DIEM",
        cap: config.veniceDiemEpochCap,
        period: "EPOCH",
        resetsAt: "00:00 UTC",
        enforcement: "provider_api_key",
      },
      software: {
        mode: config.computeBudgetMode,
        currency: "DIEM",
        cap: config.computeBudgetDiemPerDay,
        period: "UTC_DAY",
        resetsAt: "00:00 UTC",
        enforcement: "atomic_upstash_reservation_before_inference",
      },
    },
    workers: Object.values(WORKERS).map((worker) => {
      const contract = workerContracts[worker.id];
      return {
        id: worker.id,
        description: worker.description,
        method: "POST",
        endpoint: `${config.publicBaseUrl}${worker.path}`,
        quote: `${config.publicBaseUrl}/v1/quote/${worker.id}`,
        priceUsd: workerPrice(config, worker.id).toFixed(3),
        synchronous: true,
        inputSchema: contract.inputSchema,
        example: contract.input,
        limits: contract.limits,
        tags: contract.tags,
      };
    }),
    privacy: {
      providerRoute: "private_models_only",
      retention: "request bodies and provider bodies are not intentionally logged or persisted",
      webAccess: false,
    },
    treasury: {
      policy: "USDC revenue may only be swapped to the official Venice DIEM token on Base.",
      autoStake: false,
      mode: config.treasuryMode,
    },
  };
}

export function agentCard(config: AppConfig) {
  return {
    name: "DIEM Agent Workers",
    description: "x402-paid, bounded extraction, classification, summary, speech, and image workers over A2A; the catalog also exposes direct short-audio transcription.",
    supportedInterfaces: [
      {
        url: `${config.publicBaseUrl}/a2a`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      },
    ],
    version: SERVICE_VERSION,
    documentationUrl: `${config.publicBaseUrl}/openapi.json`,
    provider: {
      organization: "DIEM Agent Workers project",
      url: `${config.publicBaseUrl}/terms`,
    },
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["application/json", "text/plain", "audio/wav"],
    defaultOutputModes: ["application/json", "audio/mpeg", "image/webp"],
    skills: Object.values(WORKERS).filter(
      (worker) => worker.id !== WORKERS.transcribeAudio.id,
    ).map((worker) => ({
      id: worker.id,
      name: worker.id.replaceAll("_", " "),
      description: worker.description,
      tags: [...workerContracts[worker.id].tags, "x402", "venice"],
      examples: [JSON.stringify(workerContracts[worker.id].input)],
    })),
    securitySchemes: {
      x402: {
        apiKeySecurityScheme: {
          location: "header",
          name: "PAYMENT-SIGNATURE",
          description: "x402 exact-scheme USDC payment; an unpaid request returns HTTP 402 instructions.",
        },
      },
    },
    security: [{ x402: [] }],
  };
}

export function openApiDocument(config: AppConfig) {
  const idempotencyParameter = {
    name: "Idempotency-Key",
    in: "header",
    required: false,
    description:
      "Required on a signed paid attempt when delivery protection is enforced. Use one unpredictable 16-128 character value per logical job and reuse it only with the identical payment authorization and request.",
    schema: {
      type: "string",
      minLength: 16,
      maxLength: 128,
      pattern: "^[A-Za-z0-9._:-]+$",
    },
  };
  const paths: Record<string, unknown> = {
    "/health": {
      get: { operationId: "health", summary: "Check service health", responses: { "200": { description: "Healthy" } } },
    },
    "/v1/catalog": {
      get: { operationId: "listWorkers", summary: "List workers, prices, schemas, and constraints", responses: { "200": { description: "Worker catalog" } } },
    },
    "/.well-known/agent-catalog.json": {
      get: { operationId: "discoverWorkers", summary: "Well-known alias for the agent worker catalog", responses: { "200": { description: "Worker catalog" } } },
    },
    "/a2a": {
      post: {
        operationId: "a2aSendMessage",
        summary: "A2A 1.0 JSON-RPC SendMessage adapter",
        description: "Accepts one JSON data part containing worker and input. The adapter is fixed-price and excludes large base64 transcription jobs.",
        parameters: [idempotencyParameter],
        responses: {
          "200": { description: "A2A completed task" },
          "400": { description: "JSON-RPC or A2A validation error; no payment requested" },
          "402": { description: "x402 payment required" },
          "409": { description: "Idempotency key conflict, in flight, or already consumed" },
          "428": { description: "A signed paid attempt omitted Idempotency-Key" },
          "503": { description: "Provider unavailable" },
        },
      },
    },
    "/mcp": {
      post: {
        operationId: "mcp",
        summary: "Stateless Streamable HTTP MCP discovery server",
        description: "Free tools list workers, quote exact prices, and prepare x402 calls without receiving wallet private keys.",
        responses: { "200": { description: "MCP JSON-RPC response" } },
      },
    },
  };
  for (const worker of Object.values(WORKERS)) {
    const contract = workerContracts[worker.id];
    paths[worker.path] = {
      post: {
        operationId: worker.id,
        summary: worker.description,
        description: "Input and provider readiness are checked before x402 payment is requested.",
        parameters: [idempotencyParameter],
        requestBody: {
          required: true,
          content: { "application/json": { schema: contract.inputSchema, example: contract.input } },
        },
        responses: {
          "200": { description: "Completed worker result", content: { "application/json": { example: contract.output } } },
          "400": { description: "Invalid input; no payment requested" },
          "402": { description: "x402 payment required" },
          "409": { description: "Idempotency key conflict, in flight, or already consumed" },
          "413": { description: "Payload too large; no payment requested" },
          "428": { description: "A signed paid attempt omitted Idempotency-Key" },
          "503": { description: "Provider capacity or required model unavailable; no payment requested" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "DIEM Agent Workers API",
      version: SERVICE_VERSION,
      description: "Machine-first x402 micro-workers powered by private Venice models. Not affiliated with or endorsed by Venice.ai.",
      termsOfService: `${config.publicBaseUrl}/terms`,
    },
    servers: [{ url: config.publicBaseUrl }],
    paths,
  };
}

export function llmsText(config: AppConfig): string {
  const workers = Object.values(WORKERS)
    .map((worker) => `## ${worker.id}\n\n${worker.description}\n\n- Endpoint: POST ${config.publicBaseUrl}${worker.path}\n- Free quote: POST ${config.publicBaseUrl}/v1/quote/${worker.id}\n- Price: $${workerPrice(config, worker.id).toFixed(3)} USDC\n- Tags: ${workerContracts[worker.id].tags.join(", ")}`)
    .join("\n\n");
  return `# DIEM Agent Workers\n\n> Bounded micro-workers for autonomous software agents, paid with USDC through x402 and powered by private Venice models.\n\n## Discovery\n\n- [Catalog](${config.publicBaseUrl}/v1/catalog)\n- [Well-known catalog](${config.publicBaseUrl}/.well-known/agent-catalog.json)\n- [OpenAPI](${config.publicBaseUrl}/openapi.json)\n- [A2A Agent Card](${config.publicBaseUrl}/.well-known/agent-card.json)\n- [MCP Streamable HTTP server](${config.publicBaseUrl}/mcp)\n- [Health](${config.publicBaseUrl}/health)\n- [Terms](${config.publicBaseUrl}/terms)\n\nAccessing, paying for, or using the service constitutes acceptance of the published terms by the caller and its operator. Every job is input-validated, provider-capacity-checked, and atomically reserved against a global compute budget before inference. When delivery protection is enforced, signed paid attempts must carry an unpredictable Idempotency-Key and interrupted deliveries receive one matching retry. Only HMAC fingerprints and aggregate state are persisted; request and provider bodies are not logged or persisted. Web search and scraping are disabled.\n\n${workers}\n\nSoftware compute cap: ${config.computeBudgetDiemPerDay.toFixed(2)} DIEM per UTC day. Provider backstop: ${config.veniceDiemEpochCap.toFixed(2)} DIEM per EPOCH, reset at 00:00 UTC. Revenue policy: settled USDC is eligible only for conversion to the official Venice DIEM token on Base; conversion and staking remain disabled unless separately authorized.\n`;
}
