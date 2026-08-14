import "dotenv/config";
import { loadConfig } from "../config.js";
import { runTreasuryOnce } from "./runner.js";

try {
  const result = await runTreasuryOnce(loadConfig());
  console.info(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ error: String(error) }));
  process.exitCode = 1;
}
