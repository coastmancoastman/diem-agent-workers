import "dotenv/config";
import { spawn } from "node:child_process";
import { chmod, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const ENV_PATH = path.resolve(".env");
const KEYCHAIN_SERVICE = "com.diem-agent-workers.treasury";

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

async function securityCommand(
  args: string[],
  secretInput?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => reject(new Error("Unable to start macOS Keychain")));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`macOS Keychain command failed with code ${code}`));
    });
    // macOS `security add-generic-password -w` asks for the value twice when
    // prompting. Both copies travel only through this child process's private
    // stdin pipe, so the key never appears in argv or a temporary file.
    child.stdin.end(
      secretInput === undefined ? undefined : `${secretInput}\n${secretInput}\n`,
    );
  });
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
  await rename(temporaryPath, ENV_PATH);
  await chmod(ENV_PATH, 0o600);
}

if (process.platform !== "darwin") {
  throw new Error("This wallet setup currently requires macOS Keychain");
}

const currentEnv = await readFile(ENV_PATH, "utf8");
for (const name of [
  "TREASURY_ADDRESS",
  "TREASURY_PRIVATE_KEY",
  "TREASURY_KEYCHAIN_ACCOUNT",
]) {
  if (envValue(currentEnv, name)) {
    throw new Error(`${name} is already configured; refusing to replace an existing wallet`);
  }
}
if (envValue(currentEnv, "PAYMENTS_MODE") !== "off") {
  throw new Error("Set PAYMENTS_MODE=off before creating the treasury wallet");
}
if (envValue(currentEnv, "TREASURY_MODE") !== "disabled") {
  throw new Error("Set TREASURY_MODE=disabled before creating the treasury wallet");
}

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);
let keychainCreated = false;
try {
  // Passing -w without a following argument makes `security` prompt for the
  // secret and confirmation on its private stdin pipe, keeping it out of argv
  // and process listings.
  await securityCommand(
    [
      "add-generic-password",
      "-a",
      account.address,
      "-s",
      KEYCHAIN_SERVICE,
      "-l",
      "DIEM Agent Workers Treasury",
      "-j",
      "Dedicated Base treasury wallet; never paste or export this secret",
      "-w",
    ],
    privateKey,
  );
  keychainCreated = true;
  const retrieved = await securityCommand([
    "find-generic-password",
    "-a",
    account.address,
    "-s",
    KEYCHAIN_SERVICE,
    "-w",
  ]);
  if (retrieved.stdout.trim() !== privateKey) {
    throw new Error("Keychain readback did not match the generated wallet");
  }

  await writeEnvSafely(
    updateEnv(currentEnv, {
      TREASURY_ADDRESS: account.address,
      TREASURY_KEYCHAIN_SERVICE: KEYCHAIN_SERVICE,
      TREASURY_KEYCHAIN_ACCOUNT: account.address,
      TREASURY_KEYCHAIN_BACKEND: "security-cli",
      TREASURY_PRIVATE_KEY: "",
    }),
  );
} catch (error) {
  if (keychainCreated) {
    await securityCommand([
      "delete-generic-password",
      "-a",
      account.address,
      "-s",
      KEYCHAIN_SERVICE,
    ]).catch(() => undefined);
  }
  await unlink(`${ENV_PATH}.${process.pid}.tmp`).catch(() => undefined);
  throw error;
}

console.info(`Treasury wallet created: ${account.address}`);
console.info(`Base explorer: https://basescan.org/address/${account.address}`);
console.info("Private key storage: macOS Keychain (not .env)");
console.info("Payments: off; treasury: disabled; wallet balance: expected to be zero");
