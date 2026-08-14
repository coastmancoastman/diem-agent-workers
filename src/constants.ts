import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;
export const BASE_CAIP2 = "eip155:8453";
export const BASE_SEPOLIA_CAIP2 = "eip155:84532";

// Circle USDC on Base, documented by Base and 0x.
export const BASE_USDC_ADDRESS: Address =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// Venice DIEM ERC-20 on Base. This is intentionally not configurable: the
// treasury is incapable of buying an arbitrary asset.
export const BASE_DIEM_ADDRESS: Address =
  "0xF4d97F2da56e8c3098f3a8D538DB630A2606a024";

// 0x AllowanceHolder entry point for Base and other Cancun EVM chains.
export const ZEROX_ALLOWANCE_HOLDER: Address =
  "0x0000000000001fF3684f28c67538d4D072C22734";

export const ZEROX_QUOTE_URL =
  "https://api.0x.org/swap/allowance-holder/quote";
export const VENICE_DEFAULT_BASE_URL = "https://api.venice.ai/api/v1";

export const TREASURY_LIVE_ACK = "BUY_DIEM_ONLY_ON_BASE";
export const SERVICE_VERSION = "0.6.1";

// Text routes keep their useful ASCII character ceilings while separately
// bounding UTF-8 bytes. Byte ceilings prevent hostile Unicode from expanding
// into a token bill that exceeds the fixed x402 price.
export const TEXT_SOURCE_LIMITS = {
  extractJson: { characters: 40_000, utf8Bytes: 48_000 },
  classifyText: { characters: 20_000, utf8Bytes: 24_000 },
  summarizeText: { characters: 40_000, utf8Bytes: 48_000 },
} as const;

export const WORKERS = {
  extractJson: {
    id: "extract_text_to_json",
    path: "/v1/jobs/extract-json",
    description:
      "Extract facts from supplied text into a caller-provided strict JSON Schema. Use for bounded text-to-JSON normalization when every output field must be machine-validated.",
  },
  classifyText: {
    id: "classify_text",
    path: "/v1/jobs/classify-text",
    description:
      "Classify bounded text into exactly one caller-supplied label and return a short evidence-grounded rationale.",
  },
  summarizeText: {
    id: "summarize_text",
    path: "/v1/jobs/summarize-text",
    description:
      "Summarize bounded source text into a structured abstract and key points without web access or invented facts.",
  },
  textToSpeech: {
    id: "text_to_speech",
    path: "/v1/jobs/text-to-speech",
    description:
      "Convert up to 1,000 characters of text into MP3 speech using a bounded private Venice voice model.",
  },
  generateDraftImage: {
    id: "generate_draft_image",
    path: "/v1/jobs/generate-draft-image",
    description:
      "Generate one safe-mode 1024px WebP draft image from a bounded prompt, with search and prompt enhancement disabled.",
  },
  transcribeAudio: {
    id: "transcribe_audio",
    path: "/v1/jobs/transcribe-audio",
    description:
      "Transcribe a base64-encoded PCM WAV clip of at most 60 seconds into text. Input duration is verified before payment.",
  },
} as const;

export type WorkerKey = keyof typeof WORKERS;
export type WorkerId = (typeof WORKERS)[WorkerKey]["id"];
export type WorkerPath = (typeof WORKERS)[WorkerKey]["path"];

// Backward-compatible names used by the original extraction worker.
export const WORKER_ID = WORKERS.extractJson.id;
export const WORKER_PATH = WORKERS.extractJson.path;
export const WORKER_DESCRIPTION = WORKERS.extractJson.description;

export const PAID_WORKER_PATHS = Object.values(WORKERS).map(
  (worker) => worker.path,
) as WorkerPath[];
