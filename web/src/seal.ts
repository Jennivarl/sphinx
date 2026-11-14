// Everything that is sealed is sealed here, in the user's browser, to the
// Sphinx box's public key (libsodium sealed box: X25519 + XSalsa20-Poly1305).
// Plaintext never leaves this tab.
import sodium from "libsodium-wrappers";

const B64 = () => sodium.base64_variants.ORIGINAL;

export async function ready() {
  await sodium.ready;
}

export function sealTo(boxPublicKeyB64: string, plaintext: string): string {
  const pk = sodium.from_base64(boxPublicKeyB64, B64());
  return sodium.to_base64(sodium.crypto_box_seal(sodium.from_string(plaintext), pk), B64());
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type UnlockKey = { publicKey: string; privateKey: string };

const keyName = (account: string) => `sphinx.unlock.${account}`;

/** The buyer's unlock key: created once per account and kept in this browser. */
export function getOrCreateUnlockKey(account: string): UnlockKey {
  try {
    const saved = localStorage.getItem(keyName(account));
    if (saved) return JSON.parse(saved) as UnlockKey;
  } catch {
    /* storage blocked: fall through to a fresh key */
  }
  const kp = sodium.crypto_box_keypair();
  const key = {
    publicKey: sodium.to_base64(kp.publicKey, B64()),
    privateKey: sodium.to_base64(kp.privateKey, B64()),
  };
  try {
    localStorage.setItem(keyName(account), JSON.stringify(key));
  } catch {
    /* the caller offers a backup download */
  }
  return key;
}

export function restoreUnlockKey(account: string, json: string): UnlockKey {
  const key = JSON.parse(json) as UnlockKey;
  if (!key.publicKey || !key.privateKey) throw new Error("This is not a Sphinx unlock key file.");
  localStorage.setItem(keyName(account), JSON.stringify(key));
  return key;
}

export function openSealed(sealedB64: string, key: UnlockKey): string {
  const sealed = sodium.from_base64(sealedB64, B64());
  const pk = sodium.from_base64(key.publicKey, B64());
  const sk = sodium.from_base64(key.privateKey, B64());
  return sodium.to_string(sodium.crypto_box_seal_open(sealed, pk, sk));
}

const YOCTO = 10n ** 24n;

/** "1.5" NEAR -> yoctoNEAR string. Rejects anything that is not a plain decimal. */
export function nearToYocto(near: string): string {
  const t = near.trim();
  if (!/^\d+(\.\d{1,24})?$/.test(t)) throw new Error("Enter an amount like 1.5");
  const [whole, frac = ""] = t.split(".");
  const yocto = BigInt(whole) * YOCTO + BigInt((frac + "0".repeat(24)).slice(0, 24));
  if (yocto <= 0n) throw new Error("Amount must be more than 0");
  return yocto.toString();
}

export function yoctoToNear(yocto: string | bigint, digits = 4): string {
  const v = BigInt(yocto);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").slice(0, digits).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
