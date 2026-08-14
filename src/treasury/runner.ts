import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  keccak256,
  parseUnits,
  TransactionReceiptNotFoundError,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import {
  BASE_DIEM_ADDRESS,
  BASE_USDC_ADDRESS,
  ZEROX_ALLOWANCE_HOLDER,
} from "../constants.js";
import {
  appendAudit,
  clearTreasuryState,
  readTreasuryState,
  withTreasuryLock,
  writeTreasuryState,
} from "./audit.js";
import { decideTreasuryAction } from "./policy.js";
import { fetchZeroExPrice, fetchZeroExQuote } from "./zerox.js";
import { resolveTreasuryPrivateKey } from "./keychain.js";

export interface TreasuryRunResult {
  action: "skip" | "quote" | "execute";
  reason: string;
  address?: Address;
  usdcBalance?: string;
  ethBalance?: string;
  sellUsdc?: string;
  quotedDiem?: string;
  minimumDiem?: string;
  transaction?: `0x${string}`;
}

export async function runTreasuryOnce(
  config: AppConfig,
): Promise<TreasuryRunResult> {
  if (config.treasuryMode === "disabled") {
    return { action: "skip", reason: "treasury_disabled" };
  }
  if (!config.treasuryAddress) throw new Error("TREASURY_ADDRESS is required");
  const configuredAddress = config.treasuryAddress;

  return withTreasuryLock(config.treasuryLockPath, async () => {
    const publicClient = createPublicClient({ chain: base, transport: http(config.baseRpcUrl) });
    const address = getAddress(configuredAddress);
    const treasuryPrivateKey = await resolveTreasuryPrivateKey(config);
    const account = treasuryPrivateKey
      ? privateKeyToAccount(treasuryPrivateKey)
      : undefined;
    if (account && account.address.toLowerCase() !== address.toLowerCase()) {
      throw new Error("TREASURY_PRIVATE_KEY does not match TREASURY_ADDRESS");
    }

    const pending = await readTreasuryState(config.treasuryStatePath);
    if (pending) {
      if (pending.address.toLowerCase() !== address.toLowerCase()) {
        throw new Error("Pending treasury state belongs to a different address");
      }
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: pending.transaction });
      } catch (error) {
        if (error instanceof TransactionReceiptNotFoundError) {
          const result: TreasuryRunResult = {
            action: "skip",
            reason: "pending_transaction",
            address,
            transaction: pending.transaction,
          };
          await appendAudit(config.treasuryAuditPath, {
            event: "treasury_pending",
            ...result,
          });
          return result;
        }
        throw error;
      }
      if (receipt.status !== "success") {
        await clearTreasuryState(config.treasuryStatePath);
        throw new Error(`Pending treasury transaction reverted: ${pending.transaction}`);
      }
      const [usdcNow, diemNow] = await Promise.all([
        publicClient.readContract({
          address: BASE_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
        publicClient.readContract({
          address: BASE_DIEM_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
      ]);
      const usdcBefore = BigInt(pending.usdcBefore);
      const diemBefore = BigInt(pending.diemBefore);
      const spent = usdcBefore - usdcNow;
      const received = diemNow - diemBefore;
      if (spent <= 0n || spent > BigInt(pending.sellAmount) || received <= 0n) {
        throw new Error("Confirmed pending transaction failed treasury balance invariants");
      }
      await clearTreasuryState(config.treasuryStatePath);
      const result: TreasuryRunResult = {
        action: "execute",
        reason: "recovered_confirmed_purchase",
        address,
        sellUsdc: formatUnits(spent, 6),
        quotedDiem: formatUnits(received, 18),
        transaction: pending.transaction,
      };
      await appendAudit(config.treasuryAuditPath, {
        event: "diem_purchase_recovered",
        ...result,
      });
      return result;
    }

    const [usdcDecimals, diemDecimals, usdcBalance, diemBefore, ethBalance] =
      await Promise.all([
        publicClient.readContract({
          address: BASE_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "decimals",
        }),
        publicClient.readContract({
          address: BASE_DIEM_ADDRESS,
          abi: erc20Abi,
          functionName: "decimals",
        }),
        publicClient.readContract({
          address: BASE_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
        publicClient.readContract({
          address: BASE_DIEM_ADDRESS,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [address],
        }),
        publicClient.getBalance({ address }),
      ]);

    if (usdcDecimals !== 6) throw new Error("Base USDC decimals check failed");
    if (diemDecimals !== 18) throw new Error("Venice DIEM decimals check failed");

    const decision = decideTreasuryAction(usdcBalance, ethBalance, config);
    const baseResult: TreasuryRunResult = {
      action: decision.action,
      reason: decision.reason,
      address,
      usdcBalance: formatUnits(usdcBalance, 6),
      ethBalance: formatEther(ethBalance),
      ...(decision.sellAmount > 0n
        ? { sellUsdc: formatUnits(decision.sellAmount, 6) }
        : {}),
    };

    if (decision.action === "skip") {
      await appendAudit(config.treasuryAuditPath, {
        event: "treasury_skip",
        ...baseResult,
      });
      return baseResult;
    }

    if (decision.action === "quote") {
      const price = await fetchZeroExPrice(address, decision.sellAmount, config);
      const quoted: TreasuryRunResult = {
        ...baseResult,
        quotedDiem: formatUnits(price.buyAmount, 18),
        minimumDiem: formatUnits(price.minBuyAmount, 18),
      };
      await appendAudit(config.treasuryAuditPath, {
        event: "treasury_price",
        ...quoted,
      });
      return quoted;
    }

    let quote = await fetchZeroExQuote(address, decision.sellAmount, config);
    const quoted = {
      ...baseResult,
      quotedDiem: formatUnits(quote.buyAmount, 18),
      minimumDiem: formatUnits(quote.minBuyAmount, 18),
    };
    await appendAudit(config.treasuryAuditPath, {
      event: "treasury_quote",
      ...quoted,
      allowanceTarget: quote.allowanceTarget,
    });
    if (!account || !treasuryPrivateKey) {
      throw new Error("Live execution requires the treasury signer");
    }

    const walletClient = createWalletClient({
      account,
      chain: base,
      transport: http(config.baseRpcUrl),
    });
    const allowance = await publicClient.readContract({
      address: BASE_USDC_ADDRESS,
      abi: erc20Abi,
      functionName: "allowance",
      args: [address, ZEROX_ALLOWANCE_HOLDER],
    });
    if (allowance !== decision.sellAmount) {
      const [approvalGas, approvalGasPrice, approvalEthBalance] = await Promise.all([
        publicClient.estimateContractGas({
          account,
          address: BASE_USDC_ADDRESS,
          abi: erc20Abi,
          functionName: "approve",
          args: [ZEROX_ALLOWANCE_HOLDER, decision.sellAmount],
        }),
        publicClient.getGasPrice(),
        publicClient.getBalance({ address }),
      ]);
      const bufferedApprovalGas = (approvalGas * 120n) / 100n;
      const minimumReserve = parseUnits(config.treasuryMinEthReserve.toString(), 18);
      if (approvalEthBalance < minimumReserve + bufferedApprovalGas * approvalGasPrice) {
        throw new Error("USDC approval would consume the configured ETH gas reserve");
      }
      const approvalHash = await walletClient.writeContract({
        address: BASE_USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "approve",
        args: [ZEROX_ALLOWANCE_HOLDER, decision.sellAmount],
        gas: bufferedApprovalGas,
      });
      const approval = await publicClient.waitForTransactionReceipt({ hash: approvalHash });
      if (approval.status !== "success") throw new Error("USDC approval reverted");
      await appendAudit(config.treasuryAuditPath, {
        event: "usdc_approval",
        transaction: approvalHash,
        amount: decision.sellAmount,
      });
      // Refresh the firm quote after the approval transaction changes chain state.
      quote = await fetchZeroExQuote(address, decision.sellAmount, config);
    }

    const estimatedGas = await publicClient.estimateGas({
      account: address,
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: quote.transaction.value,
    });
    const gasWithBuffer = (estimatedGas * 120n) / 100n;
    if (gasWithBuffer > config.treasuryMaxGas) {
      throw new Error("Buffered swap gas exceeds configured maximum");
    }
    const prepared = await publicClient.prepareTransactionRequest({
      account,
      to: quote.transaction.to,
      data: quote.transaction.data,
      value: quote.transaction.value,
      gas: gasWithBuffer,
    });
    const maximumFeePerGas = prepared.maxFeePerGas ?? prepared.gasPrice;
    if (maximumFeePerGas === undefined) {
      throw new Error("Prepared transaction did not include a gas price");
    }
    const currentEthBalance = await publicClient.getBalance({ address });
    const minimumReserve = parseUnits(config.treasuryMinEthReserve.toString(), 18);
    if (currentEthBalance < minimumReserve + gasWithBuffer * maximumFeePerGas) {
      throw new Error("Swap would consume the configured ETH gas reserve");
    }

    const serializedTransaction = await walletClient.signTransaction(prepared);
    const expectedTransaction = keccak256(serializedTransaction);
    await writeTreasuryState(config.treasuryStatePath, {
      version: 1,
      status: "pending",
      transaction: expectedTransaction,
      address,
      sellAmount: decision.sellAmount.toString(),
      usdcBefore: usdcBalance.toString(),
      diemBefore: diemBefore.toString(),
      createdAt: new Date().toISOString(),
    });
    let transaction: `0x${string}`;
    try {
      transaction = await publicClient.sendRawTransaction({ serializedTransaction });
    } catch (error) {
      // Keep the state journal: the broadcast may have reached the node even if
      // the response was lost. A later run will reconcile the known hash.
      throw error;
    }
    if (transaction.toLowerCase() !== expectedTransaction.toLowerCase()) {
      throw new Error("Broadcast transaction hash differs from signed transaction hash");
    }
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transaction });
    if (receipt.status !== "success") throw new Error("USDC-to-DIEM swap reverted");

    const [usdcAfter, diemAfter] = await Promise.all([
      publicClient.readContract({
        address: BASE_USDC_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
      publicClient.readContract({
        address: BASE_DIEM_ADDRESS,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [address],
      }),
    ]);
    const spent = usdcBalance - usdcAfter;
    const received = diemAfter - diemBefore;
    if (spent <= 0n || spent > decision.sellAmount) {
      throw new Error("Post-swap USDC balance invariant failed");
    }
    if (received <= 0n) throw new Error("Post-swap DIEM balance did not increase");
    await clearTreasuryState(config.treasuryStatePath);

    const result: TreasuryRunResult = {
      ...quoted,
      action: "execute",
      reason: "usdc_swapped_to_diem",
      transaction,
      quotedDiem: formatUnits(received, 18),
    };
    await appendAudit(config.treasuryAuditPath, {
      event: "diem_purchase_complete",
      ...result,
      actualUsdcSpent: formatUnits(spent, 6),
      actualDiemReceived: formatUnits(received, 18),
    });
    return result;
  });
}
