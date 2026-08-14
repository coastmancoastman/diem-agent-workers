import type { AppConfig } from "./config.js";
import type { WorkerId } from "./constants.js";
import { WORKERS } from "./constants.js";

interface PriceUnit {
  diem?: number;
  usd?: number;
}

interface VeniceModel {
  id?: string;
  model_spec?: {
    pricing?: {
      input?: PriceUnit;
      output?: PriceUnit;
      generation?: PriceUnit;
      per_audio_second?: PriceUnit;
    };
  };
}

interface VeniceModelsResponse {
  data?: VeniceModel[];
}

export interface CostEstimateInput {
  worker: WorkerId;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputCharacters?: number;
  audioSeconds?: number;
}

export interface CostEstimator {
  estimate(input: CostEstimateInput): number | undefined;
  warm?(): void;
}

function unitDiem(unit: PriceUnit | undefined): number | undefined {
  const value = unit?.diem ?? unit?.usd;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function roundDiem(value: number): number {
  return Math.round(value * 1_000_000_000) / 1_000_000_000;
}

/**
 * Estimates provider cost from Venice's live model catalog. It never reads or
 * logs account balances, billing history, prompts, outputs, or provider IDs.
 * A catalog outage simply omits the estimate and never blocks worker output.
 */
export class VeniceCatalogCostEstimator implements CostEstimator {
  private modelsCache?: Map<string, VeniceModel>;
  private refreshPromise: Promise<void> | undefined;
  private loadedAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  warm(): void {
    this.refresh();
  }

  estimate(input: CostEstimateInput): number | undefined {
    if (!this.config.veniceApiKey) return undefined;
    const refreshAfterMs = this.modelsCache ? 60 * 60 * 1_000 : 5 * 60 * 1_000;
    if (Date.now() - this.loadedAt >= refreshAfterMs) {
      this.refresh();
    }
    const pricing = this.modelsCache?.get(input.model)?.model_spec?.pricing;
    if (!pricing) return undefined;

    let cost: number | undefined;
    if (
      input.worker === WORKERS.extractJson.id ||
      input.worker === WORKERS.classifyText.id ||
      input.worker === WORKERS.summarizeText.id
    ) {
      const inputRate = unitDiem(pricing.input);
      const outputRate = unitDiem(pricing.output);
      if (
        inputRate !== undefined &&
        outputRate !== undefined &&
        input.inputTokens !== undefined &&
        input.outputTokens !== undefined
      ) {
        cost =
          (input.inputTokens * inputRate + input.outputTokens * outputRate) /
          1_000_000;
      }
    } else if (input.worker === WORKERS.textToSpeech.id) {
      const rate = unitDiem(pricing.input);
      if (rate !== undefined && input.inputCharacters !== undefined) {
        cost = (input.inputCharacters * rate) / 1_000_000;
      }
    } else if (input.worker === WORKERS.generateDraftImage.id) {
      cost = unitDiem(pricing.generation);
    } else if (input.worker === WORKERS.transcribeAudio.id) {
      const rate = unitDiem(pricing.per_audio_second);
      if (rate !== undefined && input.audioSeconds !== undefined) {
        cost = input.audioSeconds * rate;
      }
    }
    return cost === undefined ? undefined : roundDiem(cost);
  }

  private refresh(): void {
    if (this.refreshPromise) return;
    this.loadedAt = Date.now();
    this.refreshPromise = this.fetchModels()
      .then((models) => {
        this.modelsCache = models;
        this.loadedAt = Date.now();
      })
      .catch(() => undefined)
      .finally(() => {
        this.refreshPromise = undefined;
      });
  }

  private async fetchModels(): Promise<Map<string, VeniceModel>> {
    if (!this.config.veniceApiKey) return new Map();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3_000);
    try {
      const response = await this.fetchImpl(`${this.config.veniceBaseUrl}/models?type=all`, {
        headers: { authorization: `Bearer ${this.config.veniceApiKey}` },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Venice model catalog unavailable");
      const body = (await response.json()) as VeniceModelsResponse;
      return new Map(
        (body.data ?? [])
          .filter((model): model is VeniceModel & { id: string } => Boolean(model.id))
          .map((model) => [model.id, model]),
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
