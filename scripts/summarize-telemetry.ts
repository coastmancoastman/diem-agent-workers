import fs from "node:fs";
import { parseTelemetryLine, summarizeTelemetry } from "../src/telemetry-report.js";

const path = process.argv[2];
const raw = path ? fs.readFileSync(path, "utf8") : fs.readFileSync(0, "utf8");
const events = raw
  .split(/\r?\n/)
  .map(parseTelemetryLine)
  .filter((event): event is Record<string, unknown> => event !== undefined);

process.stdout.write(`${JSON.stringify(summarizeTelemetry(events), null, 2)}\n`);
