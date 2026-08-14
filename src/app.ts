import crypto from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmetModule from "helmet";
import { rateLimit } from "express-rate-limit";
import { loadConfig, type AppConfig } from "./config.js";
import { agentCard, catalog, llmsText, openApiDocument } from "./discovery.js";
import { attachPaymentMiddleware } from "./payments.js";
import {
  InputError,
  parseClassifyTextInput,
  parseExtractJsonInput,
  parseGenerateDraftImageInput,
  parseSummarizeTextInput,
  parseTextToSpeechInput,
  parseTranscribeAudioInput,
} from "./schema.js";
import {
  classifyTextWithVenice,
  extractJsonWithVenice,
  generateDraftImageWithVenice,
  ProviderError,
  summarizeTextWithVenice,
  textToSpeechWithVenice,
  transcribeAudioWithVenice,
} from "./venice.js";
import {
  SERVICE_VERSION,
  WORKERS,
  WORKER_ID,
  WORKER_PATH,
  PAID_WORKER_PATHS,
  type WorkerId,
} from "./constants.js";
import { capacityMiddleware, VeniceReadiness } from "./readiness.js";
import { a2aInternalError, a2aSuccess, parseA2ARequest, type A2AJob } from "./a2a.js";
import { handleMcpRequest } from "./mcp.js";
import {
  JsonConsoleTelemetry,
  NoopTelemetry,
  classifySurface,
  emitTelemetry,
  type TelemetryErrorClass,
  type TelemetryEvent,
  type TelemetrySink,
} from "./telemetry.js";
import {
  VeniceCatalogCostEstimator,
  type CostEstimateInput,
  type CostEstimator,
} from "./costs.js";
import {
  createDeliveryCreditStore,
  type DeliveryCreditStore,
} from "./delivery-credit-store.js";
import {
  createComputeBudgetStore,
  type ComputeBudgetStore,
} from "./compute-budget-store.js";
import { termsDocument } from "./terms.js";

export type Extractor = typeof extractJsonWithVenice;

export interface AppDependencies {
  extractor?: Extractor;
  classifier?: typeof classifyTextWithVenice;
  summarizer?: typeof summarizeTextWithVenice;
  speaker?: typeof textToSpeechWithVenice;
  imageGenerator?: typeof generateDraftImageWithVenice;
  transcriber?: typeof transcribeAudioWithVenice;
  readiness?: VeniceReadiness;
  telemetry?: TelemetrySink;
  costEstimator?: CostEstimator;
  deliveryCreditStore?: DeliveryCreditStore;
  computeBudgetStore?: ComputeBudgetStore;
}

// Helmet publishes a callable ESM default, but some NodeNext build hosts
// resolve its `.d.cts` conditional export as the module namespace. Keep the
// runtime default and narrow it to the package's declared callable type.
const helmet = helmetModule as unknown as typeof import("helmet").default;

export async function buildApp(
  config: AppConfig,
  dependencies: AppDependencies = {},
): Promise<Express> {
  const app = express();
  const extractor = dependencies.extractor ?? extractJsonWithVenice;
  const classifier = dependencies.classifier ?? classifyTextWithVenice;
  const summarizer = dependencies.summarizer ?? summarizeTextWithVenice;
  const speaker = dependencies.speaker ?? textToSpeechWithVenice;
  const imageGenerator = dependencies.imageGenerator ?? generateDraftImageWithVenice;
  const transcriber = dependencies.transcriber ?? transcribeAudioWithVenice;
  const telemetry =
    dependencies.telemetry ??
    (config.appEnv === "test" ? new NoopTelemetry() : new JsonConsoleTelemetry());
  const costEstimator =
    dependencies.costEstimator ?? new VeniceCatalogCostEstimator(config);
  const deliveryCreditStore =
    dependencies.deliveryCreditStore ?? createDeliveryCreditStore(config);
  const computeBudgetStore =
    dependencies.computeBudgetStore ?? createComputeBudgetStore(config);
  try {
    costEstimator.warm?.();
  } catch {
    // Pricing metadata is best-effort and never gates a worker.
  }
  const workerPrices = new Map<WorkerId, number>([
    [WORKERS.extractJson.id, config.x402PriceUsd],
    [WORKERS.classifyText.id, config.x402ClassifyPriceUsd],
    [WORKERS.summarizeText.id, config.x402SummarizePriceUsd],
    [WORKERS.textToSpeech.id, config.x402TtsPriceUsd],
    [WORKERS.generateDraftImage.id, config.x402ImagePriceUsd],
    [WORKERS.transcribeAudio.id, config.x402TranscribePriceUsd],
  ]);

  const telemetryErrorClass = (error: unknown): TelemetryErrorClass => {
    if (error instanceof InputError) return "invalid_request";
    if (error instanceof SyntaxError) return "invalid_json";
    if (
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 413
    ) {
      return "payload_too_large";
    }
    if (error instanceof ProviderError) {
      if (error.status === 504) return "provider_timeout";
      if (error.status >= 500) return "provider_unavailable";
      return "provider_rejected";
    }
    return "internal_error";
  };

  const costInput = (
    worker: WorkerId,
    input: unknown,
    result: unknown,
  ): CostEstimateInput => {
    const resultRecord = result as {
      provider?: { model?: unknown };
      usage?: {
        inputTokens?: unknown;
        outputTokens?: unknown;
        totalTokens?: unknown;
      };
    };
    const inputRecord = input as {
      text?: unknown;
      durationSeconds?: unknown;
    };
    const numeric = (value: unknown): number | undefined =>
      typeof value === "number" && Number.isFinite(value) && value >= 0
        ? value
        : undefined;
    const model =
      typeof resultRecord.provider?.model === "string"
        ? resultRecord.provider.model
        : worker === WORKERS.textToSpeech.id
          ? config.veniceTtsModel
          : worker === WORKERS.generateDraftImage.id
            ? config.veniceImageModel
            : worker === WORKERS.transcribeAudio.id
              ? config.veniceAsrModel
              : config.veniceModel;
    const inputTokens = numeric(resultRecord.usage?.inputTokens);
    const outputTokens = numeric(resultRecord.usage?.outputTokens);
    const totalTokens = numeric(resultRecord.usage?.totalTokens);
    return {
      worker,
      model,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(worker === WORKERS.textToSpeech.id && typeof inputRecord.text === "string"
        ? { inputCharacters: inputRecord.text.length }
        : {}),
      ...(worker === WORKERS.transcribeAudio.id
        ? { audioSeconds: numeric(inputRecord.durationSeconds) ?? 0 }
        : {}),
    };
  };

  const runWorker = async <T>(
    worker: WorkerId,
    input: unknown,
    res: Response,
    invoke: () => Promise<T>,
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      const result = await invoke();
      const metrics = costInput(worker, input, result);
      let estimatedDiemCost: number | undefined;
      try {
        estimatedDiemCost = costEstimator.estimate(metrics);
      } catch {
        estimatedDiemCost = undefined;
      }
      const priceUsd = workerPrices.get(worker) ?? 0;
      const workerEvent: TelemetryEvent = {
        event: "worker_completed",
        worker,
        model: metrics.model,
        durationMs: Date.now() - startedAt,
        priceUsd,
        ...(estimatedDiemCost !== undefined
          ? {
              estimatedDiemCost,
              estimatedGrossMarginUsd: priceUsd - estimatedDiemCost,
            }
          : {}),
      };
      res.locals.telemetryWorkerEvent = workerEvent;
      return result;
    } catch (error) {
      const workerEvent: TelemetryEvent = {
        event: "worker_failed",
        worker,
        durationMs: Date.now() - startedAt,
        errorClass: telemetryErrorClass(error),
      };
      res.locals.telemetryWorkerEvent = workerEvent;
      throw error;
    }
  };

  // Vercel terminates TLS before invoking Express. Trust exactly that proxy
  // hop so x402 advertises the public HTTPS resource instead of an internal
  // http:// URL that Bazaar will reject.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "same-site" },
    }),
  );
  app.use((req, res, next) => {
    const startedAt = Date.now();
    const classified = classifySurface(req.path);
    res.on("finish", () => {
      const workerEvent = res.locals.telemetryWorkerEvent as
        | TelemetryEvent
        | undefined;
      if (
        res.locals.telemetryWorkerBundled !== true &&
        (workerEvent?.event === "worker_completed" ||
          workerEvent?.event === "worker_failed")
      ) {
        emitTelemetry(telemetry, workerEvent);
      }
      const method = req.method === "GET" || req.method === "POST"
        ? req.method
        : "OTHER";
      emitTelemetry(telemetry, {
        event: "request_completed",
        surface: classified.surface,
        method,
        statusCode: res.statusCode,
        durationMs: Date.now() - startedAt,
        paymentsMode: config.paymentsMode,
        ...(classified.worker ? { worker: classified.worker } : {}),
        ...(res.locals.telemetryErrorClass
          ? { errorClass: res.locals.telemetryErrorClass as TelemetryErrorClass }
          : {}),
      });
    });
    next();
  });
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
    }),
  );
  const smallJson = express.json({ limit: "64kb", strict: true });
  app.use((req, res, next) => {
    if (req.path === WORKERS.transcribeAudio.path) {
      next();
      return;
    }
    smallJson(req, res, next);
  });
  app.use(
    WORKERS.transcribeAudio.path,
    express.json({ limit: "4mb", strict: true }),
  );
  app.use((req, res, next) => {
    const supplied = req.header("x-request-id");
    const requestId = supplied && /^[A-Za-z0-9._:-]{1,80}$/.test(supplied)
      ? supplied
      : crypto.randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-payments-mode", config.paymentsMode);
    res.setHeader(
      "Link",
      `<${config.publicBaseUrl}/terms>; rel="terms-of-service"`,
    );
    next();
  });

  // Parse and validate paid work before x402. Invalid or oversized jobs never
  // receive a payment request and therefore cannot be charged.
  app.post(WORKERS.extractJson.path, (req, res, next) => {
    try {
      res.locals.input = parseExtractJsonInput(req.body);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.classifyText.path, (req, res, next) => {
    try {
      res.locals.input = parseClassifyTextInput(req.body);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.summarizeText.path, (req, res, next) => {
    try {
      res.locals.input = parseSummarizeTextInput(req.body);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.textToSpeech.path, (req, res, next) => {
    try {
      res.locals.input = parseTextToSpeechInput(req.body);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.generateDraftImage.path, (req, res, next) => {
    try {
      res.locals.input = parseGenerateDraftImageInput(req.body);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.transcribeAudio.path, (req, res, next) => {
    try {
      res.locals.input = parseTranscribeAudioInput(req.body);
      next();
    } catch (error) {
      next(error);
    }
  });
  app.post("/a2a", (req, res, next) => {
    const job = parseA2ARequest(req, res);
    if (!job) return;
    res.locals.a2aJob = job;
    res.locals.workerPath = job.workerPath;
    next();
  });

  if (config.paymentsMode !== "off") {
    app.use((req, res, next) => {
      const paidPath =
        req.path === "/a2a" ||
        PAID_WORKER_PATHS.includes(
          req.path as (typeof PAID_WORKER_PATHS)[number],
        );
      if (req.method === "POST" && paidPath && !config.storefrontEnabled) {
        res.setHeader("Retry-After", "300");
        res.status(503).json({
          error: "storefront_disabled",
          message: "Paid work is temporarily disabled; no payment was requested.",
        });
        return;
      }
      next();
    });
    app.use(capacityMiddleware(dependencies.readiness ?? new VeniceReadiness(config)));
  }
  await attachPaymentMiddleware(
    app,
    config,
    telemetry,
    deliveryCreditStore,
    computeBudgetStore,
  );

  app.get("/", (_req, res) => {
    res.json({
      service: "DIEM Agent Workers",
      version: SERVICE_VERSION,
      status: config.paymentsMode === "production" ? "production" : "beta",
      discovery: {
        catalog: `${config.publicBaseUrl}/v1/catalog`,
        openapi: `${config.publicBaseUrl}/openapi.json`,
        llms: `${config.publicBaseUrl}/llms.txt`,
        agentCard: `${config.publicBaseUrl}/.well-known/agent-card.json`,
        mcp: `${config.publicBaseUrl}/mcp`,
        terms: `${config.publicBaseUrl}/terms`,
      },
    });
  });
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: SERVICE_VERSION,
      workerReady: Boolean(config.veniceApiKey),
      paymentsMode: config.paymentsMode,
      deliveryCredits: config.deliveryCreditsMode,
      storefrontEnabled: config.storefrontEnabled,
      computeBudget: {
        provider: {
          currency: "DIEM",
          cap: config.veniceDiemEpochCap,
          period: "EPOCH",
          resetsAt: "00:00 UTC",
        },
        software: {
          mode: config.computeBudgetMode,
          currency: "DIEM",
          cap: config.computeBudgetDiemPerDay,
          period: "UTC_DAY",
          resetsAt: "00:00 UTC",
        },
      },
    });
  });
  app.get("/v1/catalog", (_req, res) => res.json(catalog(config)));
  app.get("/.well-known/agent-catalog.json", (_req, res) => res.json(catalog(config)));
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument(config)));
  app.get("/.well-known/agent-card.json", (_req, res) => res.json(agentCard(config)));
  app.get("/llms.txt", (_req, res) => res.type("text/markdown").send(llmsText(config)));
  app.get("/terms", (_req, res) => res.json(termsDocument(config)));
  app.get("/robots.txt", (_req, res) =>
    res.type("text/plain").send("User-agent: *\nAllow: /\n"),
  );
  app.all("/mcp", (req, res) => {
    void handleMcpRequest(config, req, res);
  });
  const sendQuote = (workerId: WorkerId, res: Response) => {
    const worker = Object.values(WORKERS).find((item) => item.id === workerId);
    const price = workerPrices.get(workerId);
    if (!worker || price === undefined) {
      res.status(404).json({ error: "worker_not_found" });
      return;
    }
    res.json({
      worker: worker.id,
      price: {
        amount: price.toFixed(3),
        currency: "USDC",
        protocol: "x402",
        exact: true,
      },
      endpoint: `${config.publicBaseUrl}${worker.path}`,
      expires: null,
    });
  };
  app.post("/v1/quote/extract-json", (_req, res) => {
    sendQuote(WORKER_ID, res);
  });
  app.post("/v1/quote/:workerId", (req, res) => {
    sendQuote(req.params.workerId as WorkerId, res);
  });
  app.get("/v1/treasury/status", (_req, res) => {
    res.json({
      mode: config.treasuryMode,
      policy: "USDC_TO_OFFICIAL_DIEM_ON_BASE_ONLY",
      live: config.treasuryMode === "live",
      autoStake: false,
    });
  });

  app.post(WORKER_PATH, async (req, res, next) => {
    try {
      const result = await runWorker(WORKERS.extractJson.id, res.locals.input, res, () =>
        extractor(res.locals.input, config),
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.classifyText.path, async (_req, res, next) => {
    try {
      res.json(
        await runWorker(WORKERS.classifyText.id, res.locals.input, res, () =>
          classifier(res.locals.input, config),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.summarizeText.path, async (_req, res, next) => {
    try {
      res.json(
        await runWorker(WORKERS.summarizeText.id, res.locals.input, res, () =>
          summarizer(res.locals.input, config),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.textToSpeech.path, async (_req, res, next) => {
    try {
      res.json(
        await runWorker(WORKERS.textToSpeech.id, res.locals.input, res, () =>
          speaker(res.locals.input, config),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.generateDraftImage.path, async (_req, res, next) => {
    try {
      res.json(
        await runWorker(WORKERS.generateDraftImage.id, res.locals.input, res, () =>
          imageGenerator(res.locals.input, config),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.transcribeAudio.path, async (_req, res, next) => {
    try {
      res.json(
        await runWorker(WORKERS.transcribeAudio.id, res.locals.input, res, () =>
          transcriber(res.locals.input, config),
        ),
      );
    } catch (error) {
      next(error);
    }
  });
  app.post("/a2a", async (_req, res) => {
    const job = res.locals.a2aJob as A2AJob;
    try {
      let result: unknown;
      switch (job.workerId) {
        case WORKERS.extractJson.id:
          result = await runWorker(job.workerId, job.input, res, () =>
            extractor(job.input as Parameters<typeof extractor>[0], config),
          );
          break;
        case WORKERS.classifyText.id:
          result = await runWorker(job.workerId, job.input, res, () =>
            classifier(job.input as Parameters<typeof classifier>[0], config),
          );
          break;
        case WORKERS.summarizeText.id:
          result = await runWorker(job.workerId, job.input, res, () =>
            summarizer(job.input as Parameters<typeof summarizer>[0], config),
          );
          break;
        case WORKERS.textToSpeech.id:
          result = await runWorker(job.workerId, job.input, res, () =>
            speaker(job.input as Parameters<typeof speaker>[0], config),
          );
          break;
        case WORKERS.generateDraftImage.id:
          result = await runWorker(job.workerId, job.input, res, () =>
            imageGenerator(job.input as Parameters<typeof imageGenerator>[0], config),
          );
          break;
      }
      res.json(a2aSuccess(job, result));
    } catch {
      res.locals.telemetryErrorClass = "provider_unavailable";
      res.status(503).json(a2aInternalError(job));
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      res.locals.telemetryErrorClass = telemetryErrorClass(error);
      if (error instanceof InputError) {
        res.status(400).json({ error: "invalid_request", message: error.message });
        return;
      }
      if (error instanceof ProviderError) {
        res.status(error.status).json({ error: "provider_error", message: error.message });
        return;
      }
      if (error instanceof SyntaxError) {
        res.status(400).json({ error: "invalid_json" });
        return;
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "status" in error &&
        error.status === 413
      ) {
        res.status(413).json({ error: "payload_too_large" });
        return;
      }
      res.status(500).json({ error: "internal_error" });
    },
  );

  return app;
}

// Vercel's zero-config Express detection selects src/app.ts as the function
// entrypoint. Export the fully initialized Express server for that runtime;
// local startup still happens in src/server.ts.
const app = await buildApp(loadConfig());

export default app;
