// Lists the open demo listings judges can question and buy on the live site.
// They are listed from the Sphinx owner account, and the website labels every
// listing from that account as "Demo".
// Usage: node list-demo.mjs [mainnet|testnet]
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, connect, keyStores } from "near-api-js";
import { sealTo, sha256Hex } from "./seal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, "..", ".env") });

const network = process.argv[2] ?? "mainnet";
const isMain = network === "mainnet";
const accountId = isMain ? process.env.MAINNET_ACCOUNT_ID : process.env.NEAR_ACCOUNT_ID;
const privateKey = isMain ? process.env.MAINNET_PRIVATE_KEY : process.env.NEAR_PRIVATE_KEY;
const nodeUrl = isMain ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";
const milli = (n) => (BigInt(n) * 10n ** 24n) / 1000n;

const keyStore = new keyStores.InMemoryKeyStore();
await keyStore.setKey(network, accountId, KeyPair.fromString(privateKey));
const near = await connect({ networkId: network, nodeUrl, keyStore });
const account = new Account(near.connection, accountId);
const { box_public_key: boxKey } = await account.viewFunction({ contractId: accountId, methodName: "get_config" });

const demos = [
  {
    title: "Missing slippage check in a swap router's multi-hop path",
    pitch: "A bug class that lets a sandwich bot take most of a multi-hop swap, the exact place it hides, and the one-line fix.",
    category: "audit",
    floorMilli: 50,
    secret: [
      "FINDING: The router checks amountOutMin only on the first hop of a multi-hop swap.",
      "Every later hop is executed with amountOutMin = 0, so a searcher can sandwich hop 2 or hop 3",
      "and push the price to the limit of the pool's liquidity while the first-hop check still passes.",
      "Where to look: the loop that calls the pair for each hop forwards 0 instead of the remaining minimum.",
      "Fix: check the final output against amountOutMin after the last hop (or pass per-hop minimums computed off-chain).",
    ].join("\n"),
  },
  {
    title: "Why most 'gasless' agent payments still leak the payer",
    pitch: "Research note: the on-chain trail that links a relayed payment back to its real payer, and how to break it on NEAR.",
    category: "research",
    floorMilli: 40,
    secret: [
      "NOTE: A meta-transaction relayer hides who paid the gas, not who signed the action.",
      "The signed delegate action still carries the sender account and a nonce that increases by one per account,",
      "so anyone can link every relayed payment from the same agent by sender_id and nonce order.",
      "On NEAR the fix is to give each payment its own sub-account or implicit account funded through Intents,",
      "or to settle inside a confidential Intents balance so only the final transfer is public.",
    ].join("\n"),
  },
];

for (const d of demos) {
  const tx = await account.functionCall({
    contractId: accountId,
    methodName: "list",
    args: {
      title: d.title,
      pitch: d.pitch,
      category: d.category,
      sealed_secret: sealTo(boxKey, d.secret),
      secret_hash: sha256Hex(d.secret),
      sealed_floor: sealTo(boxKey, milli(d.floorMilli).toString()),
    },
    gas: 100_000_000_000_000n,
    attachedDeposit: milli(60),
  });
  const id = JSON.parse(Buffer.from(tx.status.SuccessValue, "base64").toString());
  console.log(`listed #${id} "${d.title}" tx ${tx.transaction.hash}`);
}
