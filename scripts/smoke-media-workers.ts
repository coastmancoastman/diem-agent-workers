import "dotenv/config";
import { loadConfig } from "../src/config.js";
import {
  generateDraftImageWithVenice,
  textToSpeechWithVenice,
  transcribeAudioWithVenice,
} from "../src/venice.js";

function silentPcmWav(seconds: number): Buffer {
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
  return wav;
}

if (process.env.ALLOW_VENICE_MEDIA_SMOKE !== "1") {
  throw new Error("Live media smoke test requires ALLOW_VENICE_MEDIA_SMOKE=1");
}

const config = loadConfig({
  ...process.env,
  APP_ENV: "test",
  PAYMENTS_MODE: "off",
  TREASURY_MODE: "disabled",
  PUBLIC_BASE_URL: "http://smoke.local",
});

const speech = await textToSpeechWithVenice(
  { text: "DIEM agent workers are ready.", voice: "af_heart", speed: 1 },
  config,
);
const image = await generateDraftImageWithVenice(
  { prompt: "A small friendly robot storefront icon, centered, simple flat design." },
  config,
);
const transcription = await transcribeAudioWithVenice(
  { audio: silentPcmWav(0.25), durationSeconds: 0.25, language: "en" },
  config,
);

const imageBytes = Buffer.from(image.result.base64, "base64");
if (
  imageBytes.toString("ascii", 0, 4) !== "RIFF" ||
  imageBytes.toString("ascii", 8, 12) !== "WEBP"
) {
  throw new Error("Draft image result is not a WebP file");
}

process.stdout.write(
  `${JSON.stringify({
    result: "PASS",
    speech: { mediaType: speech.result.mediaType, bytes: speech.result.bytes },
    image: { mediaType: image.result.mediaType, bytes: image.result.bytes },
    transcription: {
      returnedText: typeof (transcription.result as { text?: unknown }).text === "string",
      durationSeconds: (transcription.result as { durationSeconds?: unknown }).durationSeconds,
    },
  })}\n`,
);
