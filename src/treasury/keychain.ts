import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { Hex } from "viem";
import type { AppConfig } from "../config.js";

const execFileAsync = promisify(execFile);

export function validatePrivateKey(value: string): Hex {
  const normalized = value.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("Keychain item is not a valid 32-byte EVM private key");
  }
  return normalized as Hex;
}

export async function resolveTreasuryPrivateKey(
  config: AppConfig,
): Promise<Hex | undefined> {
  if (config.treasuryPrivateKey) return config.treasuryPrivateKey;
  if (!config.treasuryKeychainService || !config.treasuryKeychainAccount) {
    return undefined;
  }
  if (process.platform !== "darwin") {
    throw new Error("macOS Keychain treasury storage is only available on macOS");
  }
  try {
    const command =
      config.treasuryKeychainBackend === "native-helper"
        ? path.resolve(".local/bin/diem-keychain-helper")
        : "security";
    const args =
      config.treasuryKeychainBackend === "native-helper"
        ? [
            "read",
            config.treasuryKeychainService,
            config.treasuryKeychainAccount,
          ]
        : [
            "find-generic-password",
            "-a",
            config.treasuryKeychainAccount,
            "-s",
            config.treasuryKeychainService,
            "-w",
          ];
    const { stdout } = await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 4_096,
    });
    return validatePrivateKey(stdout);
  } catch (error) {
    if (error instanceof Error && /valid 32-byte/.test(error.message)) throw error;
    throw new Error("Unable to read the treasury key from macOS Keychain");
  }
}
