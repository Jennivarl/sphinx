// End-to-end proof run against the live contract. Every step is a real
// transaction; the hashes printed here go into the README's proof section.
//
//   seller (the Sphinx owner account) seals and lists a secret with a sealed floor
//   buyer  (a second account of the same owner) asks the sealed box questions,
//          makes a sealed offer, and opens the secret re-sealed to its own key
//
// Usage: node e2e.mjs [mainnet|testnet] [listingId]   (with a listingId, reuses that open listing)
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Account, KeyPair, connect, keyStores } from "near-api-js";
import { newKeyPair, openSealed, sealFor, sha256Hex } from "./seal.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env");
dotenv.config({ path: envPath });

const network = process.argv[2] ?? "mainnet";
const isMain = network === "mainnet";
const sellerId = isMain ? process.env.MAINNET_ACCOUNT_ID : process.env.NEAR_ACCOUNT_ID;
const sellerKey = isMain ? process.env.MAINNET_PRIVATE_KEY : process.env.NEAR_PRIVATE_KEY;
const contractId = sellerId;
const nodeUrl = isMain ? "https://rpc.mainnet.fastnear.com" : "https://rpc.testnet.fastnear.com";
const NEAR = 10n ** 24n;
const milli = (n) => (BigInt(n) * NEAR) / 1000n;

const keyStore = new keyStores.InMemoryKeyStore();
const near = await connect({ networkId: network, nodeUrl, keyStore });

// Buyer: a second implicit account of the same owner, kept in .env.
let buyerId = isMain ? process.env.MAINNET_BUYER_ACCOUNT_ID : process.env.NEAR_BUYER_ACCOUNT_ID;
let buyerKey = isMain ? process.env.MAINNET_BUYER_PRIVATE_KEY : process.env.NEAR_BUYER_PRIVATE_KEY;
if (!buyerId) {
  const kp = KeyPair.fromRandom("ed25519");
  buyerId = Buffer.from(kp.getPublicKey().data).toString("hex");
  buyerKey = kp.toString();
  fs.appendFileSync(envPath, `\nMAINNET_BUYER_ACCOUNT_ID=${buyerId}\nMAINNET_BUYER_PRIVATE_KEY=${buyerKey}\n`);
}
await keyStore.setKey(network, sellerId, KeyPair.fromString(sellerKey));
await keyStore.setKey(network, buyerId, KeyPair.fromString(buyerKey));
const seller = new Account(near.connection, sellerId);
const buyer = new Account(near.connection, buyerId);

const proof = [];
const log = (step, tx, extra = "") => {
  proof.push({ step, tx, extra });
  console.log(`${step.padEnd(34)} ${tx}${extra ? "  " + extra : ""}`);
};
const view = (methodName, args = {}) => seller.viewFunction({ contractId, methodName, args });

// 0. Fund the buyer from the seller (owner's own money moving between owner's accounts).
const buyerState = await buyer.state().catch(() => null);
if (!buyerState || BigInt(buyerState.amount) < milli(500)) {
  const t = await seller.sendMoney(buyerId, milli(300));
  log("fund buyer 0.30 NEAR", t.transaction.hash);
}

// 1. Seller seals and lists.
const config = await view("get_config");
const boxKey = config.box_public_key;
const secret = [
  "FINDING: Unchecked share price in an ERC-4626 vault deposit path.",
  "Impact: the first depositor can donate assets to inflate the share price so the next depositor's",
  "shares round down to zero; the attacker then redeems and takes the victim's deposit.",
  "Proof: deposit(1 wei) -> transfer 10_000e18 underlying to the vault -> victim deposit(9_999e18) mints 0 shares.",
  "Fix: mint dead shares on the first deposit (or use virtual shares/assets offsets) and require shares > 0 on every deposit.",
].join("\n");
const floorYocto = milli(50).toString(); // 0.05 NEAR, sealed
const reuseId = process.argv[3];
let listingId;
if (reuseId !== undefined) {
  listingId = Number(reuseId);
  console.log(`reusing listing #${listingId}`);
} else {
const listTx = await seller.functionCall({
  contractId,
  methodName: "list",
  args: {
    title: "First-depositor inflation bug in an ERC-4626 vault",
    pitch: "A live exploit path that steals the second depositor's funds, with proof steps and a two-line fix.",
    category: "audit",
    sealed_secret: sealFor(boxKey, sellerId, secret),
    secret_hash: sha256Hex(secret),
    sealed_floor: sealFor(boxKey, sellerId, floorYocto),
  },
  gas: 100_000_000_000_000n,
  attachedDeposit: milli(60),
});
listingId = JSON.parse(Buffer.from(listTx.status.SuccessValue, "base64").toString());
log(`list #${listingId}`, listTx.transaction.hash, "floor sealed: 0.05 NEAR");
}

// 2. Buyer asks the sealed box.
const questions = [
  "Does the secret explain how to fix the problem?",
  "Is the affected contract an NFT marketplace?",
  "What is the first word of the finding?",
];
for (const [i, question] of questions.entries()) {
  const t0 = Date.now();
  const tx = await buyer.functionCall({
    contractId,
    methodName: "ask",
    args: { listing_id: listingId, question },
    gas: 300_000_000_000_000n,
    attachedDeposit: milli(20),
  });
  const all = await view("get_questions", { listing_id: listingId });
  const q = all[all.length - 1];
  log(`ask ${i + 1}`, tx.transaction.hash, `${q.answer} ${q.confidence}% in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

// 3. Buyer makes a sealed offer: ceiling 0.09 NEAR; the box settles at a random point between the two limits.
const unlock = newKeyPair();
const ceiling = milli(90);
const storage = BigInt(await view("sale_storage", { listing_id: listingId }));
const t0 = Date.now();
const buyTx = await buyer.functionCall({
  contractId,
  methodName: "buy",
  args: { listing_id: listingId, sealed_ceiling: sealFor(boxKey, buyerId, ceiling.toString()), buyer_public_key: unlock.publicKey },
  gas: 300_000_000_000_000n,
  attachedDeposit: ceiling + milli(10) + storage,
});
const listing = await view("get_listing", { listing_id: listingId });
log("buy (sealed ceiling 0.09)", buyTx.transaction.hash, `${listing.status} at ${Number(BigInt(listing.price ?? 0) * 1000n / NEAR) / 1000} NEAR in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 4. Buyer opens the secret with its own key and checks the fingerprint.
const sale = await view("get_sale", { listing_id: listingId });
const opened = openSealed(sale.sealed_for_buyer, unlock);
const match = sha256Hex(opened) === listing.secret_hash;
console.log(`\nopened secret matches the listed fingerprint: ${match}`);
fs.writeFileSync(path.join(here, `proof-${network}.json`), JSON.stringify({ contractId, listingId, proof, match }, null, 2));
if (!match) process.exit(1);
