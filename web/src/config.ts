export const NETWORK = (import.meta.env.VITE_NEAR_NETWORK ?? "mainnet") as "mainnet" | "testnet";

export const CONTRACT_ID: string =
  import.meta.env.VITE_CONTRACT_ID ?? "7c3bcf93a61a597e5d07547926a3e06e0d4f6d99b12323523234faa53cee9681";

export const RPC_URL: string =
  import.meta.env.VITE_RPC_URL ??
  (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com");

export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export const OUTLAYER_APP = "https://app.outlayer.ai";

/** Deposits the contract expects (yoctoNEAR). Mirrors contract/src/lib.rs. */
export const ASK_DEPOSIT = "20000000000000000000000"; // 0.02 NEAR
export const RUN_FEE = "10000000000000000000000"; // 0.01 NEAR
export const LIST_DEPOSIT = "50000000000000000000000"; // 0.05 NEAR, unused part refunded
export const GAS_300 = "300000000000000";

export const CATEGORIES = [
  { id: "audit", label: "Security finding" },
  { id: "research", label: "On-chain research" },
  { id: "data", label: "Dataset" },
  { id: "solution", label: "Solution / fix" },
] as const;
