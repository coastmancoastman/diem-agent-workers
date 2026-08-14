import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";

function jsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, jsonSafe(child)]),
    );
  }
  return value;
}

export async function appendAudit(
  auditPath: string,
  event: Record<string, unknown>,
): Promise<void> {
  await mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  const handle = await open(auditPath, "a", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.write(
      `${JSON.stringify(jsonSafe({ at: new Date().toISOString(), ...event }))}\n`,
    );
  } finally {
    await handle.close();
  }
}

export async function withTreasuryLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Treasury lock already exists at ${lockPath}`);
    }
    throw error;
  }
  try {
    await handle.write(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
    return await fn();
  } finally {
    await handle.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export interface PendingTreasuryTransaction {
  version: 1;
  status: "pending";
  transaction: `0x${string}`;
  address: `0x${string}`;
  sellAmount: string;
  usdcBefore: string;
  diemBefore: string;
  createdAt: string;
}

export async function readTreasuryState(
  statePath: string,
): Promise<PendingTreasuryTransaction | undefined> {
  try {
    const parsed = JSON.parse(await readFile(statePath, "utf8")) as PendingTreasuryTransaction;
    if (
      parsed.version !== 1 ||
      parsed.status !== "pending" ||
      !/^0x[0-9a-fA-F]{64}$/.test(parsed.transaction) ||
      !/^0x[0-9a-fA-F]{40}$/.test(parsed.address) ||
      !/^\d+$/.test(parsed.sellAmount) ||
      !/^\d+$/.test(parsed.usdcBefore) ||
      !/^\d+$/.test(parsed.diemBefore)
    ) {
      throw new Error("Treasury state file is invalid");
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function writeTreasuryState(
  statePath: string,
  state: PendingTreasuryTransaction,
): Promise<void> {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.write(`${JSON.stringify(state)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, statePath);
  await chmod(statePath, 0o600);
}

export async function clearTreasuryState(statePath: string): Promise<void> {
  await unlink(statePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
