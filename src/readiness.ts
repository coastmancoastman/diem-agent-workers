import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { PAID_WORKER_PATHS, WORKERS } from "./constants.js";

interface VeniceRateLimits {
  accessPermitted?: boolean;
}

interface VeniceRateLimitsResponse {
  data?: VeniceRateLimits;
  accessPermitted?: boolean;
}

interface VeniceModel {
  id?: string;
  type?: string;
  model_spec?: {
    offline?: boolean;
    privacy?: string;
    capabilities?: {
      supportsResponseSchema?: boolean;
    };
  };
}

interface VeniceModelsResponse {
  data?: VeniceModel[];
}

interface ReadinessSnapshot {
  checkedAt: number;
  models: Map<string, VeniceModel>;
}

type ReadinessCode =
  | "not_configured"
  | "provider_http"
  | "capacity_denied"
  | "catalog_invalid"
  | "model_unavailable"
  | "model_not_private"
  | "model_capability_missing"
  | "provider_request_failed";

export class ReadinessError extends Error {
  constructor(readonly code: ReadinessCode) {
    super(code);
    this.name = "ReadinessError";
  }
}

const REQUIRED_MODEL = {
  [WORKERS.extractJson.path]: { configKey: "veniceModel", type: "text", schema: true },
  [WORKERS.classifyText.path]: { configKey: "veniceModel", type: "text", schema: true },
  [WORKERS.summarizeText.path]: { configKey: "veniceModel", type: "text", schema: true },
  [WORKERS.textToSpeech.path]: { configKey: "veniceTtsModel", type: "tts", schema: false },
  [WORKERS.generateDraftImage.path]: { configKey: "veniceImageModel", type: "image", schema: false },
  [WORKERS.transcribeAudio.path]: { configKey: "veniceAsrModel", type: "asr", schema: false },
} as const;

type ModelConfigKey = (typeof REQUIRED_MODEL)[keyof typeof REQUIRED_MODEL]["configKey"];

export class VeniceReadiness {
  private snapshot?: ReadinessSnapshot;
  private inFlight: Promise<ReadinessSnapshot> | undefined;
  private lastFailureAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async refresh(): Promise<ReadinessSnapshot> {
    if (!this.config.veniceApiKey) throw new ReadinessError("not_configured");
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.min(this.config.veniceTimeoutMs, 5_000),
    );
    try {
      const headers = { authorization: `Bearer ${this.config.veniceApiKey}` };
      const [limitsResponse, modelsResponse] = await Promise.all([
        this.fetchImpl(`${this.config.veniceBaseUrl}/api_keys/rate_limits`, {
          headers,
          signal: controller.signal,
        }),
        this.fetchImpl(`${this.config.veniceBaseUrl}/models?type=all`, {
          headers,
          signal: controller.signal,
        }),
      ]);
      if (!limitsResponse.ok || !modelsResponse.ok) {
        throw new ReadinessError("provider_http");
      }
      const limitsResponseBody = (await limitsResponse.json()) as VeniceRateLimitsResponse;
      const limits = limitsResponseBody.data ?? limitsResponseBody;
      if (limits.accessPermitted !== true) {
        throw new ReadinessError("capacity_denied");
      }
      const response = (await modelsResponse.json()) as VeniceModelsResponse | VeniceModel[];
      const models = Array.isArray(response) ? response : response.data;
      if (!Array.isArray(models)) throw new ReadinessError("catalog_invalid");
      return {
        checkedAt: this.now(),
        models: new Map(
          models
            .filter((model): model is VeniceModel & { id: string } => Boolean(model.id))
            .map((model) => [model.id, model]),
        ),
      };
    } catch (error) {
      if (error instanceof ReadinessError) throw error;
      throw new ReadinessError("provider_request_failed");
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getSnapshot(): Promise<ReadinessSnapshot> {
    const now = this.now();
    if (
      this.snapshot &&
      now - this.snapshot.checkedAt < this.config.veniceReadinessCacheMs
    ) {
      return this.snapshot;
    }
    // Briefly cache failure state to prevent an unhealthy provider from turning
    // anonymous requests into an outbound request flood.
    if (now - this.lastFailureAt < Math.min(2_000, this.config.veniceReadinessCacheMs)) {
      throw new ReadinessError("provider_request_failed");
    }
    if (!this.inFlight) {
      this.inFlight = this.refresh()
        .then((snapshot) => {
          this.snapshot = snapshot;
          return snapshot;
        })
        .catch((error) => {
          this.lastFailureAt = this.now();
          throw error;
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }
    return this.inFlight;
  }

  async assertReady(path: string): Promise<void> {
    const requirement = REQUIRED_MODEL[path as keyof typeof REQUIRED_MODEL];
    if (!requirement) throw new ReadinessError("model_unavailable");
    const snapshot = await this.getSnapshot();
    const modelId = this.config[requirement.configKey as ModelConfigKey];
    const model = snapshot.models.get(modelId);
    if (!model || model.type !== requirement.type || model.model_spec?.offline !== false) {
      throw new ReadinessError("model_unavailable");
    }
    if (model.model_spec?.privacy !== "private") {
      throw new ReadinessError("model_not_private");
    }
    if (
      requirement.schema &&
      model.model_spec?.capabilities?.supportsResponseSchema !== true
    ) {
      throw new ReadinessError("model_capability_missing");
    }
  }
}

export function capacityMiddleware(readiness: VeniceReadiness) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const targetPath =
      typeof res.locals.workerPath === "string" ? res.locals.workerPath : req.path;
    if (
      req.method !== "POST" ||
      (req.path !== "/a2a" &&
        !PAID_WORKER_PATHS.includes(req.path as (typeof PAID_WORKER_PATHS)[number]))
    ) {
      next();
      return;
    }
    try {
      await readiness.assertReady(targetPath);
      next();
    } catch (error) {
      const reason = error instanceof ReadinessError
        ? error.code
        : "provider_request_failed";
      console.warn(
        JSON.stringify({
          event: "prepayment_readiness_blocked",
          path: targetPath,
          reason,
        }),
      );
      res.setHeader("retry-after", "15");
      res.status(503).json({
        error: "capacity_unavailable",
        message: "Provider capacity is unavailable; no payment was requested.",
      });
    }
  };
}
