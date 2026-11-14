// Checks a NEAR AI signature receipt in the browser. The model's TEE signed
// "<model>:<request hash>:<response hash>" (EIP-191, secp256k1); the signer
// must be the key NEAR AI's attestation report lists for that model.
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex, concatBytes, utf8ToBytes } from "@noble/hashes/utils";

export type Receipt = {
  chat_id: string;
  request_hash: string;
  response_hash: string;
  signature: string;
  signing_address: string;
};

export type ReceiptCheck = "checking" | "verified" | "unlisted" | "signature-only" | "invalid";

const ATTESTATION_URL = "https://cloud-api.near.ai/v1/attestation/report";

export function signedText(model: string, r: Receipt): string {
  return `${model}:${r.request_hash}:${r.response_hash}`;
}

/** The Ethereum-style address that produced an EIP-191 signature over `text`. */
export function recoverSigner(text: string, signatureHex: string): string {
  const message = utf8ToBytes(text);
  const digest = keccak_256(concatBytes(utf8ToBytes(`\x19Ethereum Signed Message:\n${message.length}`), message));
  const sig = signatureHex.replace(/^0x/, "");
  const v = parseInt(sig.slice(128, 130), 16);
  const publicKey = secp256k1.Signature.fromCompact(sig.slice(0, 128))
    .addRecoveryBit(v >= 27 ? v - 27 : v)
    .recoverPublicKey(digest)
    .toRawBytes(false);
  return `0x${bytesToHex(keccak_256(publicKey.slice(1)).slice(-20))}`;
}

/** Keys NEAR AI's attestation report lists for a model (fetched fresh). */
async function attestedSigners(model: string): Promise<string[]> {
  const url = `${ATTESTATION_URL}?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  const report = await (await fetch(url)).json();
  return (report.model_attestations ?? [])
    .filter((m: { model_name?: string }) => m.model_name === model)
    .map((m: { signing_address: string }) => m.signing_address.toLowerCase());
}

/** "verified": the signature recovers to the receipt's key and that key is in the
 *  model's attestation report. "unlisted": the signature is good but today's
 *  report lists another key (keys rotate). "signature-only": no report. */
export async function checkReceipt(model: string, r: Receipt): Promise<ReceiptCheck> {
  let signer: string;
  try {
    signer = recoverSigner(signedText(model, r), r.signature);
  } catch {
    return "invalid";
  }
  if (signer !== r.signing_address.toLowerCase()) return "invalid";
  try {
    return (await attestedSigners(model)).includes(signer) ? "verified" : "unlisted";
  } catch {
    return "signature-only";
  }
}
