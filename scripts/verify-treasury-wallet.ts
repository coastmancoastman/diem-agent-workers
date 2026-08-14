import "dotenv/config";
import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { loadConfig } from "../src/config.js";
import { BASE_DIEM_ADDRESS, BASE_USDC_ADDRESS } from "../src/constants.js";
import { resolveTreasuryPrivateKey } from "../src/treasury/keychain.js";

const config = loadConfig();
if (!config.treasuryAddress) throw new Error("TREASURY_ADDRESS is not configured");
const configuredAddress = getAddress(config.treasuryAddress);
const privateKey = await resolveTreasuryPrivateKey(config);
if (!privateKey) throw new Error("No treasury signer is configured");
const derivedAddress = privateKeyToAccount(privateKey).address;
if (derivedAddress.toLowerCase() !== configuredAddress.toLowerCase()) {
  throw new Error("Stored treasury signer does not match TREASURY_ADDRESS");
}

const client = createPublicClient({ chain: base, transport: http(config.baseRpcUrl) });
const [chainId, ethBalance, usdcBalance, diemBalance] = await Promise.all([
  client.getChainId(),
  client.getBalance({ address: configuredAddress }),
  client.readContract({
    address: BASE_USDC_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [configuredAddress],
  }),
  client.readContract({
    address: BASE_DIEM_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [configuredAddress],
  }),
]);
if (chainId !== base.id) throw new Error(`Expected Base chain ${base.id}, received ${chainId}`);

console.info(`Wallet access verified: ${configuredAddress}`);
console.info("Signer: macOS Keychain readback matched the public address");
console.info(`Base chain ID: ${chainId}`);
console.info(`ETH balance: ${formatEther(ethBalance)}`);
console.info(`USDC balance: ${formatUnits(usdcBalance, 6)}`);
console.info(`DIEM balance: ${formatUnits(diemBalance, 18)}`);
console.info(`Explorer: https://basescan.org/address/${configuredAddress}`);
