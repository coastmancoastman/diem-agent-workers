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
  type WorkerId,
} from "./constants.js";
import { capacityMiddleware, VeniceReadiness } from "./readiness.js";
import { a2aInternalError, a2aSuccess, parseA2ARequest, type A2AJob } from "./a2a.js";
import { handleMcpRequest } from "./mcp.js";

export type Extractor = typeof extractJsonWithVenice;

export interface AppDependencies {
  extractor?: Extractor;
  classifier?: typeof classifyTextWithVenice;
  summarizer?: typeof summarizeTextWithVenice;
  speaker?: typeof textToSpeechWithVenice;
  imageGenerator?: typeof generateDraftImageWithVenice;
  transcriber?: typeof transcribeAudioWithVenice;
  readiness?: VeniceReadiness;
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
    app.use(capacityMiddleware(dependencies.readiness ?? new VeniceReadiness(config)));
  }
  await attachPaymentMiddleware(app, config);

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
      },
    });
  });
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      version: SERVICE_VERSION,
      workerReady: Boolean(config.veniceApiKey),
      paymentsMode: config.paymentsMode,
      computeBudget: {
        currency: "DIEM",
        cap: config.veniceDiemEpochCap,
        period: "EPOCH",
        resetsAt: "00:00 UTC",
      },
    });
  });
  app.get("/v1/catalog", (_req, res) => res.json(catalog(config)));
  app.get("/.well-known/agent-catalog.json", (_req, res) => res.json(catalog(config)));
  app.get("/openapi.json", (_req, res) => res.json(openApiDocument(config)));
  app.get("/.well-known/agent-card.json", (_req, res) => res.json(agentCard(config)));
  app.get("/llms.txt", (_req, res) => res.type("text/markdown").send(llmsText(config)));
  app.get("/robots.txt", (_req, res) =>
    res.type("text/plain").send("User-agent: *\nAllow: /\n"),
  );
  app.all("/mcp", (req, res) => {
    void handleMcpRequest(config, req, res);
  });
  const workerPrices = new Map<WorkerId, number>([
    [WORKERS.extractJson.id, config.x402PriceUsd],
    [WORKERS.classifyText.id, config.x402ClassifyPriceUsd],
    [WORKERS.summarizeText.id, config.x402SummarizePriceUsd],
    [WORKERS.textToSpeech.id, config.x402TtsPriceUsd],
    [WORKERS.generateDraftImage.id, config.x402ImagePriceUsd],
    [WORKERS.transcribeAudio.id, config.x402TranscribePriceUsd],
  ]);
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
      const result = await extractor(res.locals.input, config);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.classifyText.path, async (_req, res, next) => {
    try {
      res.json(await classifier(res.locals.input, config));
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.summarizeText.path, async (_req, res, next) => {
    try {
      res.json(await summarizer(res.locals.input, config));
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.textToSpeech.path, async (_req, res, next) => {
    try {
      res.json(await speaker(res.locals.input, config));
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.generateDraftImage.path, async (_req, res, next) => {
    try {
      res.json(await imageGenerator(res.locals.input, config));
    } catch (error) {
      next(error);
    }
  });
  app.post(WORKERS.transcribeAudio.path, async (_req, res, next) => {
    try {
      res.json(await transcriber(res.locals.input, config));
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
          result = await extractor(job.input as Parameters<typeof extractor>[0], config);
          break;
        case WORKERS.classifyText.id:
          result = await classifier(job.input as Parameters<typeof classifier>[0], config);
          break;
        case WORKERS.summarizeText.id:
          result = await summarizer(job.input as Parameters<typeof summarizer>[0], config);
          break;
        case WORKERS.textToSpeech.id:
          result = await speaker(job.input as Parameters<typeof speaker>[0], config);
          break;
        case WORKERS.generateDraftImage.id:
          result = await imageGenerator(job.input as Parameters<typeof imageGenerator>[0], config);
          break;
      }
      res.json(a2aSuccess(job, result));
    } catch {
      res.status(503).json(a2aInternalError(job));
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
      console.error(JSON.stringify({ event: "request_failed", error: String(error) }));
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
