import "dotenv/config";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ENV_PATH = path.resolve(".env");
const DEFAULT_KEYCHAIN_SERVICE = "com.diem-agent-workers.treasury";
const KEYCHAIN_HELPER_SOURCE = path.resolve("scripts/keychain-helper.c");
const KEYCHAIN_HELPER_PATH = path.resolve(".local/bin/diem-keychain-helper");
const execFileAsync = promisify(execFile);

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

function normalizePrivateKey(value: string): Hex {
  const unwrapped = value
    .replace(/^\u001b\[200~/, "")
    .replace(/\u001b\[201~$/, "")
    .trim();
  const normalized = unwrapped.startsWith("0x") ? unwrapped : `0x${unwrapped}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Expected one 32-byte EVM private key (64 hex characters)");
  }
  return normalized as Hex;
}

async function readHiddenLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stderr.isTTY || !process.stdin.setRawMode) {
    throw new Error("Run this command in an interactive Terminal window");
  }

  process.stderr.write(prompt);
  process.stdin.setEncoding("utf8");
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (): void => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("Wallet import cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function securityCommand(
  args: string[],
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
    child.stdin.end();
  });
}

async function ensureNativeKeychainHelper(): Promise<string> {
  await mkdir(path.dirname(KEYCHAIN_HELPER_PATH), { recursive: true, mode: 0o700 });
  await chmod(path.resolve(".local"), 0o700);
  await chmod(path.dirname(KEYCHAIN_HELPER_PATH), 0o700);
  try {
    await access(KEYCHAIN_HELPER_PATH, fsConstants.X_OK);
    return KEYCHAIN_HELPER_PATH;
  } catch {
    // Compile below. The helper binary contains no wallet data.
  }

  const temporaryPath = `${KEYCHAIN_HELPER_PATH}.${process.pid}.tmp`;
  try {
    await execFileAsync(
      "xcrun",
      [
        "clang",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-Wno-deprecated-declarations",
        "-framework",
        "Security",
        "-framework",
        "CoreFoundation",
        KEYCHAIN_HELPER_SOURCE,
        "-o",
        temporaryPath,
      ],
      { encoding: "utf8", maxBuffer: 16_384 },
    );
    await chmod(temporaryPath, 0o700);
    await rename(temporaryPath, KEYCHAIN_HELPER_PATH);
    return KEYCHAIN_HELPER_PATH;
  } catch {
    await unlink(temporaryPath).catch(() => undefined);
    throw new Error("Unable to build the local macOS Keychain helper");
  }
}

async function nativeKeychainCommand(
  helperPath: string,
  args: string[],
  secretInput?: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", () => reject(new Error("Unable to start local Keychain helper")));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Local Keychain helper failed with code ${code}`));
    });
    child.stdin.end(secretInput);
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
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, ENV_PATH);
}

if (process.argv.includes("--help")) {
  console.info("Import a seed-derived EVM account into the DIEM treasury Keychain item.");
  console.info("The private key is entered through a hidden interactive prompt.");
  console.info("Never enter a seed phrase; this command accepts one account private key only.");
  process.exit(0);
}

if (process.platform !== "darwin") {
  throw new Error("This wallet import currently requires macOS Keychain");
}

const currentEnv = await readFile(ENV_PATH, "utf8");
if (envValue(currentEnv, "PAYMENTS_MODE") !== "off") {
  throw new Error("Set PAYMENTS_MODE=off before replacing the treasury wallet");
}
if (envValue(currentEnv, "TREASURY_MODE") !== "disabled") {
  throw new Error("Set TREASURY_MODE=disabled before replacing the treasury wallet");
}
if (envValue(currentEnv, "TREASURY_PRIVATE_KEY")) {
  throw new Error("Remove the plaintext TREASURY_PRIVATE_KEY before importing a wallet");
}

const oldAddress = envValue(currentEnv, "TREASURY_ADDRESS");
const oldService =
  envValue(currentEnv, "TREASURY_KEYCHAIN_SERVICE") ?? DEFAULT_KEYCHAIN_SERVICE;
const oldAccount = envValue(currentEnv, "TREASURY_KEYCHAIN_ACCOUNT") ?? oldAddress;
const oldBackend =
  envValue(currentEnv, "TREASURY_KEYCHAIN_BACKEND") ?? "security-cli";
const keychainHelper = await ensureNativeKeychainHelper();

console.info("Paste only the exported private key for the dedicated seed-backed account.");
console.info("Input is hidden and is never written to .env, logs, argv, or temporary files.");
const privateKey = normalizePrivateKey(
  await readHiddenLine("Private key (hidden; never the 12-word seed phrase): "),
);
const newAccount = privateKeyToAccount(privateKey);

if (newAccount.address.toLowerCase() === oldAddress?.toLowerCase()) {
  throw new Error("That key belongs to the wallet already configured; nothing was changed");
}

console.info(`Derived public address: ${newAccount.address}`);
console.info("Confirm this exactly matches the account shown in your wallet app.");
const confirmationText = `REPLACE WITH ${newAccount.address}`;
const prompts = createInterface({ input: process.stdin, output: process.stdout });
const confirmation = await prompts.question(`Type '${confirmationText}' to continue: `);
prompts.close();
if (confirmation.trim() !== confirmationText) {
  throw new Error("Address confirmation did not match; nothing was changed");
}

let newKeychainItemCreated = false;
let envUpdated = false;
try {
  await nativeKeychainCommand(
    keychainHelper,
    [
      "store",
      DEFAULT_KEYCHAIN_SERVICE,
      newAccount.address,
      "DIEM Agent Workers Treasury",
      "Seed-backed dedicated Base treasury account; never share this secret",
    ],
    privateKey,
  );
  newKeychainItemCreated = true;

  const retrieved = await nativeKeychainCommand(keychainHelper, [
    "read",
    DEFAULT_KEYCHAIN_SERVICE,
    newAccount.address,
  ]);
  if (retrieved.stdout.trim() !== privateKey) {
    throw new Error("Keychain readback did not match the imported wallet");
  }

  await writeEnvSafely(
    updateEnv(currentEnv, {
      TREASURY_ADDRESS: newAccount.address,
      TREASURY_KEYCHAIN_SERVICE: DEFAULT_KEYCHAIN_SERVICE,
      TREASURY_KEYCHAIN_ACCOUNT: newAccount.address,
      TREASURY_KEYCHAIN_BACKEND: "native-helper",
      TREASURY_PRIVATE_KEY: "",
    }),
  );
  envUpdated = true;
} catch (error) {
  if (newKeychainItemCreated && !envUpdated) {
    await nativeKeychainCommand(keychainHelper, [
      "delete",
      DEFAULT_KEYCHAIN_SERVICE,
      newAccount.address,
    ]).catch(() => undefined);
  }
  await unlink(`${ENV_PATH}.${process.pid}.tmp`).catch(() => undefined);
  throw error;
}

let oldItemRemoved = true;
if (oldAccount) {
  const removal =
    oldBackend === "native-helper"
      ? nativeKeychainCommand(keychainHelper, ["delete", oldService, oldAccount])
      : securityCommand([
          "delete-generic-password",
          "-a",
          oldAccount,
          "-s",
          oldService,
        ]);
  oldItemRemoved = await removal
    .then(() => true)
    .catch(() => false);
}

console.info(`Treasury wallet imported: ${newAccount.address}`);
console.info(`Base explorer: https://basescan.org/address/${newAccount.address}`);
console.info("Private key storage: macOS Keychain (not .env)");
console.info("Payments: off; treasury: disabled");
console.info("Next: verify the wallet using the command in docs/WALLET_ACCESS.md");
if (!oldItemRemoved) {
  console.warn("The old, unused Keychain item could not be removed automatically.");
}
