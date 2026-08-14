import { chmod, lstat, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

const ENV_PATH = path.resolve(".env");

function envValue(text: string, name: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith(`${name}=`));
  return line?.slice(name.length + 1).trim();
}

function updateEnv(text: string, updates: Record<string, string>): string {
  const remaining = new Map(Object.entries(updates));
  const lines = text.split(/\r?\n/).map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (!match) return line;
    const name = match[1];
    if (!name || !remaining.has(name)) return line;
    const value = remaining.get(name) ?? "";
    remaining.delete(name);
    return `${name}=${value}`;
  });
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  for (const [name, value] of remaining) lines.push(`${name}=${value}`);
  return `${lines.join("\n")}\n`;
}

async function writeEnvSafely(text: string): Promise<void> {
  const temporaryPath = `${ENV_PATH}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.write(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, ENV_PATH);
}

const sourceArgument = process.argv[2];
if (!sourceArgument) {
  throw new Error("Usage: import-cdp-key.ts /absolute/path/to/cdp_api_key.json");
}
const sourcePath = path.resolve(sourceArgument);
const sourceStat = await lstat(sourcePath);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
  throw new Error("CDP credential source must be a regular file, not a symlink");
}

const currentEnv = await readFile(ENV_PATH, "utf8");
if (envValue(currentEnv, "CDP_API_KEY_ID") || envValue(currentEnv, "CDP_API_KEY_SECRET")) {
  throw new Error("CDP credentials are already configured; refusing to overwrite them");
}

let parsed: unknown;
try {
  parsed = JSON.parse(await readFile(sourcePath, "utf8"));
} catch {
  throw new Error("CDP credential file is not valid JSON");
}
if (!parsed || typeof parsed !== "object") {
  throw new Error("CDP credential file must contain an object");
}
const id = Reflect.get(parsed, "id");
const privateKey = Reflect.get(parsed, "privateKey");
if (typeof id !== "string" || !/^[0-9a-fA-F-]{36}$/.test(id)) {
  throw new Error("CDP credential file has an invalid API key id");
}
if (
  typeof privateKey !== "string" ||
  privateKey.length < 40 ||
  /[\r\n]/.test(privateKey)
) {
  throw new Error("CDP credential file has an invalid private key");
}

await chmod(sourcePath, 0o600);
try {
  await writeEnvSafely(
    updateEnv(currentEnv, {
      CDP_API_KEY_ID: id,
      CDP_API_KEY_SECRET: privateKey,
    }),
  );
} catch (error) {
  await unlink(`${ENV_PATH}.${process.pid}.tmp`).catch(() => undefined);
  throw error;
}

console.info("CDP API key imported without displaying credential values");
console.info("Project .env permissions: 600");
console.info("Downloaded credential file permissions: 600");
console.info("Payments remain unchanged; importing a key does not enable x402");
