import { mkdir, writeFile } from "node:fs/promises";
import { openApiDocument } from "../src/discovery.js";
import { loadConfig } from "../src/config.js";

const config = loadConfig({
  ...process.env,
  APP_ENV: "development",
  PAYMENTS_MODE: "off",
  TREASURY_MODE: "disabled",
  PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL ?? "https://api.example.com",
});
await mkdir("public", { recursive: true });
await writeFile(
  "public/openapi.json",
  `${JSON.stringify(openApiDocument(config), null, 2)}\n`,
  { mode: 0o644 },
);
