// Checks every answer's NEAR AI signature receipt on a listing, from public
// data only: the contract's view methods and NEAR AI's attestation report.
//
// For each answer: rebuild the signed text "<model>:<request hash>:<response hash>",
// recover the EIP-191 signer, and require it to be the receipt's key and a key
// the model's live attestation report lists.
//
// Usage: node verify-answers.mjs <listingId> [contractId]
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";

const listingId = Number(process.argv[2]);
const contractId = process.argv[3] ?? "7c3bcf93a61a597e5d07547926a3e06e0d4f6d99b12323523234faa53cee9681";
if (!Number.isInteger(listingId)) {
  console.error("usage: node verify-answers.mjs <listingId> [contractId]");
  process.exit(2);
}

async function view(method, args) {
  const res = await fetch("https://rpc.mainnet.fastnear.com", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") },
    }),
  });
  const { result, error } = await res.json();
  if (error || !result?.result) throw new Error(`${method}: ${JSON.stringify(error ?? result)}`);
  return JSON.parse(Buffer.from(result.result).toString());
}

function recoverSigner(text, signatureHex) {
  const message = utf8ToBytes(text);
  const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), message));
  const sig = signatureHex.replace(/^0x/, "");
  const v = parseInt(sig.slice(128, 130), 16);
  const publicKey = secp256k1.Signature.fromCompact(sig.slice(0, 128)).addRecoveryBit(v >= 27 ? v - 27 : v).recoverPublicKey(digest).toRawBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

const reports = new Map();
async function attestedSigners(model) {
  if (!reports.has(model)) {
    const url = `https://cloud-api.near.ai/v1/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
    const report = await (await fetch(url)).json();
    reports.set(model, (report.model_attestations ?? []).filter((m) => m.model_name === model).map((m) => m.signing_address.toLowerCase()));
  }
  return reports.get(model);
}

const questions = await view("get_questions", { listing_id: listingId });
const receipts = await view("get_receipts", { listing_id: listingId });
let failures = 0;
for (const [i, q] of questions.entries()) {
  const r = receipts[i];
  const label = `#${i} ${q.answer.padEnd(8)} "${q.question}"`;
  if (!r || !q.model) {
    console.log(`${label}\n    no receipt (refused answers, failed runs and answers from before receipts existed carry none)`);
    continue;
  }
  const signer = recoverSigner(`${q.model}:${r.request_hash}:${r.response_hash}`, r.signature);
  const listed = (await attestedSigners(q.model)).includes(signer);
  const ok = signer === r.signing_address.toLowerCase();
  if (!ok) failures++;
  console.log(`${label}\n    model ${q.model}\n    signer ${signer} ${ok ? "matches the receipt" : "DOES NOT match the receipt"}; ${listed ? "listed in the model's live NEAR AI attestation report" : "not in today's report (keys rotate)"}`);
}
process.exit(failures ? 1 : 0);
