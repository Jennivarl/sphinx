// Asks the deployed contract to fetch the sealed box's public key from OutLayer.
// The key is derived inside the TEE for this contract as caller, so it must be
// requested through the contract, not directly.
// Usage: node refresh-box-key.mjs [mainnet|testnet]
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, connect, keyStores } from "near-api-js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

const network = process.argv[2] ?? "mainnet";
const isMain = network === "mainnet";
const accountId = isMain ? process.env.MAINNET_ACCOUNT_ID : process.env.NEAR_ACCOUNT_ID;
const privateKey = isMain ? process.env.MAINNET_PRIVATE_KEY : process.env.NEAR_PRIVATE_KEY;
const nodeUrl = isMain ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(network, accountId, KeyPair.fromString(privateKey));
const near = await connect({ networkId: network, nodeUrl, keyStore });
const account = new Account(near.connection, accountId);

const t0 = Date.now();
const out = await account.functionCall({
  contractId: accountId,
  methodName: "refresh_box_key",
  args: {},
  gas: 300_000_000_000_000n,
  attachedDeposit: 10_000_000_000_000_000_000_000n, // 0.01 NEAR, unused part refunded by OutLayer
});
console.log(`tx ${out.transaction.hash} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
const key = await account.viewFunction({ contractId: accountId, methodName: "box_public_key" });
console.log("box_public_key:", key);
