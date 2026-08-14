import { describe, expect, it } from "vitest";
import {
  parseClassifyTextInput,
  parseExtractJsonInput,
  parseGenerateDraftImageInput,
  parseSummarizeTextInput,
  parseTextToSpeechInput,
  parseTranscribeAudioInput,
  validateStrictSchema,
} from "../src/schema.js";
import { validSchema } from "./helpers.js";

describe("strict extraction schemas", () => {
  it("accepts a bounded strict schema", () => {
    expect(validateStrictSchema(validSchema)).toEqual(validSchema);
    expect(
      parseExtractJsonInput({ source: "Ada has 3 cats", schema: validSchema }),
    ).toMatchObject({ source: "Ada has 3 cats" });
  });

  it("rejects objects that allow surprise properties", () => {
    expect(() =>
      validateStrictSchema({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      }),
    ).toThrow(/additionalProperties=false/);
  });

  it("rejects references and omitted required fields", () => {
    expect(() =>
      validateStrictSchema({
        type: "object",
        properties: { name: { $ref: "#/$defs/name" } },
        required: [],
        additionalProperties: false,
      }),
    ).toThrow();
  });

  it("bounds source length", () => {
    expect(() =>
      parseExtractJsonInput({ source: "x".repeat(40_001), schema: validSchema }),
    ).toThrow(/40,000/);
  });

  it("bounds UTF-8 bytes so hostile Unicode cannot evade fixed-price limits", () => {
    expect(() =>
      parseExtractJsonInput({ source: "€".repeat(16_001), schema: validSchema }),
    ).toThrow(/48,000 UTF-8 bytes/);
    expect(() =>
      parseClassifyTextInput({
        source: "€".repeat(8_001),
        labels: ["a", "b"],
      }),
    ).toThrow(/24,000 UTF-8 bytes/);
    expect(() =>
      parseSummarizeTextInput({ source: "€".repeat(16_001) }),
    ).toThrow(/48,000 UTF-8 bytes/);
  });
});

function silentPcmWav(seconds: number): string {
  const sampleRate = 8_000;
  const dataBytes = Math.ceil(sampleRate * seconds);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);
  return wav.toString("base64");
}

describe("bounded worker inputs", () => {
  it("accepts bounded classification, speech, and image jobs", () => {
    expect(
      parseClassifyTextInput({ source: "refund requested", labels: ["refund", "other"] }),
    ).toEqual({ source: "refund requested", labels: ["refund", "other"] });
    expect(parseTextToSpeechInput({ text: "hello" })).toMatchObject({
      voice: "af_heart",
      speed: 1,
    });
    expect(parseGenerateDraftImageInput({ prompt: "a small robot" })).toEqual({
      prompt: "a small robot",
    });
  });

  it("rejects undeclared request fields", () => {
    expect(() =>
      parseClassifyTextInput({ source: "x", labels: ["a", "b"], model: "expensive" }),
    ).toThrow(/Unexpected request field/);
  });

  it("verifies PCM WAV duration before payment", () => {
    const parsed = parseTranscribeAudioInput({
      audioBase64: silentPcmWav(0.25),
      language: "en",
    });
    expect(parsed.durationSeconds).toBeCloseTo(0.25);
    expect(() =>
      parseTranscribeAudioInput({ audioBase64: silentPcmWav(61) }),
    ).toThrow(/duration/);
  });
});
