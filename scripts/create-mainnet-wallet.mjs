// Creates a fresh NEAR mainnet implicit account key for Sphinx and stores it in
// ../.env. An implicit account's address is the hex of its public key; it exists
// on-chain as soon as someone sends NEAR to it. The private key is never printed.
import { KeyPair } from "near-api-js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(here, "..", ".env");
let env = fs.readFileSync(envPath, "utf8");

const existing = env.match(/^MAINNET_ACCOUNT_ID=(.+)$/m);
if (existing) {
  console.log(`Mainnet wallet already exists: ${existing[1].trim()}`);
  process.exit(0);
}

const keyPair = KeyPair.fromRandom("ed25519");
const publicKeyBytes = keyPair.getPublicKey().data;
const accountId = Buffer.from(publicKeyBytes).toString("hex");

const set = (text, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  return re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.trimEnd()}\n${key}=${value}\n`;
};
env = set(env, "MAINNET_ACCOUNT_ID", accountId);
env = set(env, "MAINNET_PRIVATE_KEY", keyPair.toString());
fs.writeFileSync(envPath, env);
console.log(`Mainnet wallet address: ${accountId}`);
