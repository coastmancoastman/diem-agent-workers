import "dotenv/config";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../src/config.js";
import { parseClassifyTextInput, parseExtractJsonInput } from "../src/schema.js";
import { classifyTextWithVenice, extractJsonWithVenice } from "../src/venice.js";

interface EvalCase {
  id: string;
  worker: "extract" | "classify";
  input: unknown;
  expected?: unknown;
  expectedLabel?: string;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

if (process.env.ALLOW_VENICE_EVAL !== "1") {
  throw new Error("Live evaluation requires ALLOW_VENICE_EVAL=1");
}

const models = (process.env.VENICE_EVAL_MODELS ?? "qwen3-5-9b")
  .split(",")
  .map((model) => model.trim())
  .filter(Boolean);
if (models.length === 0 || models.length > 3) {
  throw new Error("VENICE_EVAL_MODELS must select between 1 and 3 models");
}
const cases = JSON.parse(
  await readFile(new URL("../eval/text-cases.json", import.meta.url), "utf8"),
) as EvalCase[];

for (const model of models) {
  const config = loadConfig({
    ...process.env,
    APP_ENV: "test",
    PAYMENTS_MODE: "off",
    TREASURY_MODE: "disabled",
    PUBLIC_BASE_URL: "http://eval.local",
    VENICE_TEXT_MODEL: model,
  });
  let passed = 0;
  let totalLatencyMs = 0;
  for (const item of cases) {
    const started = performance.now();
    let correct = false;
    try {
      if (item.worker === "extract") {
        const response = await extractJsonWithVenice(parseExtractJsonInput(item.input), config);
        correct = stable(response.result) === stable(item.expected);
      } else {
        const response = await classifyTextWithVenice(
          parseClassifyTextInput(item.input),
          config,
        );
        correct =
          typeof response.result === "object" &&
          response.result !== null &&
          (response.result as { label?: string }).label === item.expectedLabel;
      }
    } catch {
      correct = false;
    }
    totalLatencyMs += performance.now() - started;
    if (correct) passed += 1;
  }
  process.stdout.write(
    `${JSON.stringify({
      model,
      passed,
      cases: cases.length,
      accuracy: passed / cases.length,
      averageLatencyMs: Math.round(totalLatencyMs / cases.length),
    })}\n`,
  );
}
