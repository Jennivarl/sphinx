// Deploys contract/target/near/sphinx_contract.wasm to the Sphinx account and
// initialises it. Network and account come from ../.env:
//   NETWORK=mainnet -> MAINNET_ACCOUNT_ID / MAINNET_PRIVATE_KEY, outlayer.near
//   NETWORK=testnet -> NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY, outlayer.testnet
// Usage: node deploy-contract.mjs [mainnet|testnet]
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, connect, keyStores } from "near-api-js";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

const network = process.argv[2] ?? "mainnet";
const isMain = network === "mainnet";
const accountId = isMain ? process.env.MAINNET_ACCOUNT_ID : process.env.NEAR_ACCOUNT_ID;
const privateKey = isMain ? process.env.MAINNET_PRIVATE_KEY : process.env.NEAR_PRIVATE_KEY;
const outlayer = isMain ? "outlayer.near" : "outlayer.testnet";
const nodeUrl = isMain ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";
if (!accountId || !privateKey) throw new Error(`missing ${network} account in .env`);

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(network, accountId, KeyPair.fromString(privateKey));
const near = await connect({ networkId: network, nodeUrl, keyStore });
const account = new Account(near.connection, accountId);

const wasm = fs.readFileSync(path.join(here, "..", "contract", "target", "near", "sphinx_contract.wasm"));
console.log(`Deploying ${wasm.length} bytes to ${accountId} on ${network}...`);
const deployed = await account.deployContract(wasm);
console.log(`  deploy tx: ${deployed.transaction.hash}`);

const state = await near.connection.provider.query({
  request_type: "view_state", finality: "final", account_id: accountId, prefix_base64: "U1RBVEU=",
}).catch(() => ({ values: [] }));
if (state.values?.length) {
  console.log("  already initialised, skipping new()");
} else {
  const init = await account.functionCall({
    contractId: accountId,
    methodName: "new",
    args: { outlayer, project_id: `${accountId}/sphinx` },
    gas: 30_000_000_000_000n,
  });
  console.log(`  init tx: ${init.transaction.hash}`);
}
const config = await account.viewFunction({ contractId: accountId, methodName: "get_config" });
console.log("Config:", JSON.stringify(config));
