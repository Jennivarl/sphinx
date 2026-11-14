// Creates two funded NEAR testnet accounts through the public testnet faucet
// and writes their keys into ../.env. Keys are never printed.
import { KeyPair } from "near-api-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env");
const FAUCET = "https://helper.nearprotocol.com/account";

function setEnv(text, key, value) {
  const line = `${key}=${value}`;
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : `${text.trimEnd()}\n${line}\n`;
}

async function create(prefix) {
  const suffix = Math.random().toString(36).slice(2, 8);
  const accountId = `${prefix}-${suffix}.testnet`;
  const keyPair = KeyPair.fromRandom("ed25519");
  const res = await fetch(FAUCET, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: keyPair.getPublicKey().toString() }),
  });
  if (!res.ok) throw new Error(`faucet refused ${accountId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return { accountId, privateKey: keyPair.toString() };
}

let env = fs.readFileSync(envPath, "utf8");
if (/^NEAR_ACCOUNT_ID=.+$/m.test(env)) {
  console.log("Accounts already in .env, nothing to do.");
  process.exit(0);
}

const owner = await create("sphinx");
const buyer = await create("sphinx-buyer");
env = setEnv(env, "NEAR_ACCOUNT_ID", owner.accountId);
env = setEnv(env, "NEAR_PRIVATE_KEY", owner.privateKey);
env = setEnv(env, "NEAR_BUYER_ACCOUNT_ID", buyer.accountId);
env = setEnv(env, "NEAR_BUYER_PRIVATE_KEY", buyer.privateKey);
fs.writeFileSync(envPath, env);
console.log(`Created ${owner.accountId} and ${buyer.accountId}. Keys saved to .env (not shown).`);
