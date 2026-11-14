// Sealing helpers shared by scripts and tests: libsodium sealed boxes
// (X25519 + XSalsa20-Poly1305), the same construction the enclave opens.
import { createRequire } from "node:module";
import crypto from "node:crypto";

// libsodium-wrappers' ESM build is broken in some releases; its CJS build is fine.
const sodium = createRequire(import.meta.url)("libsodium-wrappers");

await sodium.ready;

export function sealTo(boxPublicKeyB64, plaintext) {
  const pk = sodium.from_base64(boxPublicKeyB64, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), pk);
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export function newKeyPair() {
  const kp = sodium.crypto_box_keypair();
  return {
    publicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
    privateKey: sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL),
  };
}

export function openSealed(sealedB64, keyPair) {
  const pk = sodium.from_base64(keyPair.publicKey, sodium.base64_variants.ORIGINAL);
  const sk = sodium.from_base64(keyPair.privateKey, sodium.base64_variants.ORIGINAL);
  const sealed = sodium.from_base64(sealedB64, sodium.base64_variants.ORIGINAL);
  return sodium.to_string(sodium.crypto_box_seal_open(sealed, pk, sk));
}

export function sha256Hex(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
