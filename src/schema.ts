import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { TEXT_SOURCE_LIMITS } from "./constants.js";

export type JsonSchema = Record<string, unknown>;

const MAX_SCHEMA_BYTES = 12_000;
const MAX_SCHEMA_DEPTH = 6;
const MAX_PROPERTIES = 60;
const FORBIDDEN_KEYS = new Set([
  "$ref",
  "$defs",
  "definitions",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
  "patternProperties",
  "unevaluatedProperties",
]);

export class InputError extends Error {
  constructor(
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "InputError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectExtraKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (extra) throw new InputError(`Unexpected request field: ${extra}`);
}

function visitSchema(
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  counter: { properties: number },
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new InputError(`Schema exceeds maximum depth at ${path}`);
  }
  for (const key of Object.keys(schema)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new InputError(`Unsupported schema keyword ${key} at ${path}`);
    }
  }

  const type = schema.type;
  const types = Array.isArray(type) ? type : [type];
  const supported = new Set([
    "object",
    "array",
    "string",
    "number",
    "integer",
    "boolean",
    "null",
  ]);
  if (types.length === 0 || types.some((item) => typeof item !== "string" || !supported.has(item))) {
    throw new InputError(`Unsupported or missing type at ${path}`);
  }

  if (types.includes("object")) {
    if (!isObject(schema.properties)) {
      throw new InputError(`Object schema needs properties at ${path}`);
    }
    if (schema.additionalProperties !== false) {
      throw new InputError(`Object schema must set additionalProperties=false at ${path}`);
    }
    const propertyNames = Object.keys(schema.properties);
    counter.properties += propertyNames.length;
    if (counter.properties > MAX_PROPERTIES) {
      throw new InputError(`Schema exceeds ${MAX_PROPERTIES} total properties`);
    }
    if (!Array.isArray(schema.required)) {
      throw new InputError(`Object schema needs a required array at ${path}`);
    }
    const required = new Set(schema.required);
    if (
      required.size !== propertyNames.length ||
      propertyNames.some((name) => !required.has(name))
    ) {
      throw new InputError(
        `Every property must appear in required at ${path}; use a type including null for optional values`,
      );
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      if (!isObject(child)) throw new InputError(`Invalid property schema at ${path}.${name}`);
      visitSchema(child, `${path}.${name}`, depth + 1, counter);
    }
  }

  if (types.includes("array")) {
    if (!isObject(schema.items)) throw new InputError(`Array schema needs items at ${path}`);
    visitSchema(schema.items, `${path}[]`, depth + 1, counter);
  }
}

export function validateStrictSchema(value: unknown): JsonSchema {
  if (!isObject(value)) throw new InputError("schema must be a JSON object");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_SCHEMA_BYTES) {
    throw new InputError(`schema exceeds ${MAX_SCHEMA_BYTES} bytes`);
  }
  if (value.type !== "object") {
    throw new InputError("Top-level schema type must be object");
  }
  visitSchema(value, "$", 0, { properties: 0 });

  const ajv = new Ajv2020({ allErrors: true, strict: false });
  try {
    ajv.compile(value);
  } catch (error) {
    throw new InputError("Schema is not valid JSON Schema", String(error));
  }
  return value;
}

export function compileOutputValidator(schema: JsonSchema): ValidateFunction {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  return ajv.compile(schema);
}

export function conciseAjvErrors(
  errors: ErrorObject[] | null | undefined,
): Array<{ path: string; message: string }> {
  return (errors ?? []).slice(0, 12).map((error) => ({
    path: error.instancePath || "$",
    message: error.message ?? "invalid value",
  }));
}

export interface ExtractJsonInput {
  source: string;
  schema: JsonSchema;
  instructions?: string;
}

export function parseExtractJsonInput(value: unknown): ExtractJsonInput {
  if (!isObject(value)) throw new InputError("Request body must be a JSON object");
  rejectExtraKeys(value, ["source", "schema", "instructions"]);
  if (typeof value.source !== "string" || value.source.trim().length === 0) {
    throw new InputError("source must be a non-empty string");
  }
  if (value.source.length > TEXT_SOURCE_LIMITS.extractJson.characters) {
    throw new InputError("source exceeds 40,000 characters");
  }
  if (Buffer.byteLength(value.source, "utf8") > TEXT_SOURCE_LIMITS.extractJson.utf8Bytes) {
    throw new InputError("source exceeds 48,000 UTF-8 bytes");
  }
  if (value.instructions !== undefined) {
    if (typeof value.instructions !== "string") {
      throw new InputError("instructions must be a string");
    }
    if (value.instructions.length > 500) {
      throw new InputError("instructions exceeds 500 characters");
    }
  }
  const schema = validateStrictSchema(value.schema);
  return {
    source: value.source,
    schema,
    ...(value.instructions ? { instructions: value.instructions } : {}),
  };
}

export interface ClassifyTextInput {
  source: string;
  labels: string[];
}

export function parseClassifyTextInput(value: unknown): ClassifyTextInput {
  if (!isObject(value)) throw new InputError("Request body must be a JSON object");
  rejectExtraKeys(value, ["source", "labels"]);
  if (typeof value.source !== "string" || value.source.trim().length === 0) {
    throw new InputError("source must be a non-empty string");
  }
  if (value.source.length > TEXT_SOURCE_LIMITS.classifyText.characters) {
    throw new InputError("source exceeds 20,000 characters");
  }
  if (Buffer.byteLength(value.source, "utf8") > TEXT_SOURCE_LIMITS.classifyText.utf8Bytes) {
    throw new InputError("source exceeds 24,000 UTF-8 bytes");
  }
  if (!Array.isArray(value.labels) || value.labels.length < 2 || value.labels.length > 12) {
    throw new InputError("labels must contain between 2 and 12 strings");
  }
  const labels = value.labels.map((label) => {
    if (typeof label !== "string" || label.trim().length === 0 || label.length > 50) {
      throw new InputError("each label must be a non-empty string of at most 50 characters");
    }
    return label.trim();
  });
  if (new Set(labels).size !== labels.length) throw new InputError("labels must be unique");
  return { source: value.source, labels };
}

export interface SummarizeTextInput {
  source: string;
  maxKeyPoints: number;
}

export function parseSummarizeTextInput(value: unknown): SummarizeTextInput {
  if (!isObject(value)) throw new InputError("Request body must be a JSON object");
  rejectExtraKeys(value, ["source", "maxKeyPoints"]);
  if (typeof value.source !== "string" || value.source.trim().length === 0) {
    throw new InputError("source must be a non-empty string");
  }
  if (value.source.length > TEXT_SOURCE_LIMITS.summarizeText.characters) {
    throw new InputError("source exceeds 40,000 characters");
  }
  if (Buffer.byteLength(value.source, "utf8") > TEXT_SOURCE_LIMITS.summarizeText.utf8Bytes) {
    throw new InputError("source exceeds 48,000 UTF-8 bytes");
  }
  const maxKeyPoints = value.maxKeyPoints ?? 5;
  if (!Number.isInteger(maxKeyPoints) || Number(maxKeyPoints) < 3 || Number(maxKeyPoints) > 10) {
    throw new InputError("maxKeyPoints must be an integer from 3 through 10");
  }
  return { source: value.source, maxKeyPoints: Number(maxKeyPoints) };
}

const KOKORO_VOICES = new Set([
  "af_heart",
  "af_sky",
  "am_adam",
  "am_michael",
  "bf_emma",
  "bm_george",
]);

export interface TextToSpeechInput {
  text: string;
  voice: string;
  speed: number;
}

export function parseTextToSpeechInput(value: unknown): TextToSpeechInput {
  if (!isObject(value)) throw new InputError("Request body must be a JSON object");
  rejectExtraKeys(value, ["text", "voice", "speed"]);
  if (typeof value.text !== "string" || value.text.trim().length === 0) {
    throw new InputError("text must be a non-empty string");
  }
  if (value.text.length > 1_000) throw new InputError("text exceeds 1,000 characters");
  const voice = value.voice ?? "af_heart";
  if (typeof voice !== "string" || !KOKORO_VOICES.has(voice)) {
    throw new InputError(`voice must be one of: ${[...KOKORO_VOICES].join(", ")}`);
  }
  const speed = value.speed ?? 1;
  if (typeof speed !== "number" || speed < 0.75 || speed > 1.5) {
    throw new InputError("speed must be between 0.75 and 1.5");
  }
  return { text: value.text, voice, speed };
}

export interface GenerateDraftImageInput {
  prompt: string;
  negativePrompt?: string;
}

export function parseGenerateDraftImageInput(value: unknown): GenerateDraftImageInput {
  if (!isObject(value)) throw new InputError("Request body must be a JSON object");
  rejectExtraKeys(value, ["prompt", "negativePrompt"]);
  if (typeof value.prompt !== "string" || value.prompt.trim().length === 0) {
    throw new InputError("prompt must be a non-empty string");
  }
  if (value.prompt.length > 1_500) throw new InputError("prompt exceeds 1,500 characters");
  if (
    value.negativePrompt !== undefined &&
    (typeof value.negativePrompt !== "string" || value.negativePrompt.length > 500)
  ) {
    throw new InputError("negativePrompt must be a string of at most 500 characters");
  }
  return {
    prompt: value.prompt,
    ...(value.negativePrompt ? { negativePrompt: value.negativePrompt } : {}),
  };
}

export interface TranscribeAudioInput {
  audio: Buffer;
  durationSeconds: number;
  language?: string;
}

function parsePcmWav(audio: Buffer): number {
  if (
    audio.length < 44 ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new InputError("audioBase64 must contain a PCM WAV file");
  }
  let offset = 12;
  let byteRate: number | undefined;
  let dataBytes: number | undefined;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > audio.length) throw new InputError("WAV chunk length is invalid");
    if (id === "fmt ") {
      if (size < 16) throw new InputError("WAV format chunk is invalid");
      const encoding = audio.readUInt16LE(start);
      const channels = audio.readUInt16LE(start + 2);
      const sampleRate = audio.readUInt32LE(start + 4);
      byteRate = audio.readUInt32LE(start + 8);
      const bitsPerSample = audio.readUInt16LE(start + 14);
      if (
        encoding !== 1 ||
        ![1, 2].includes(channels) ||
        sampleRate < 8_000 ||
        sampleRate > 48_000 ||
        ![8, 16, 24, 32].includes(bitsPerSample) ||
        byteRate === 0
      ) {
        throw new InputError("WAV must be PCM, mono/stereo, 8-48 kHz, and 8-32 bit");
      }
    }
    if (id === "data") dataBytes = size;
    offset = end + (size % 2);
  }
  if (!byteRate || dataBytes === undefined) throw new InputError("WAV is missing audio data");
  const durationSeconds = dataBytes / byteRate;
  if (durationSeconds < 0.1 || durationSeconds > 60) {
    throw new InputError("WAV duration must be between 0.1 and 60 seconds");
  }
  return durationSeconds;
}

export function parseTranscribeAudioInput(value: unknown): TranscribeAudioInput {
  if (!isObject(value)) throw new InputError("Request body must be a JSON object");
  rejectExtraKeys(value, ["audioBase64", "language"]);
  if (
    typeof value.audioBase64 !== "string" ||
    value.audioBase64.length === 0 ||
    value.audioBase64.length > 3_800_000 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value.audioBase64) ||
    value.audioBase64.length % 4 !== 0
  ) {
    throw new InputError("audioBase64 must be canonical base64 no larger than 3.8 MB");
  }
  const audio = Buffer.from(value.audioBase64, "base64");
  if (audio.length > 2_850_000) throw new InputError("decoded WAV exceeds 2.85 MB");
  const durationSeconds = parsePcmWav(audio);
  if (
    value.language !== undefined &&
    (typeof value.language !== "string" || !/^[a-z]{2}$/.test(value.language))
  ) {
    throw new InputError("language must be a lowercase ISO 639-1 code");
  }
  return {
    audio,
    durationSeconds,
    ...(value.language ? { language: value.language } : {}),
  };
}
