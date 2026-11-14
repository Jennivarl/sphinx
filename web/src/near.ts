import { actionCreators, setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupModal, type WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupHotWallet } from "@near-wallet-selector/hot-wallet";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import "@near-wallet-selector/modal-ui/styles.css";
import { CONTRACT_ID, GAS_300, NETWORK, RPC_URL } from "./config";

export type Status = "Open" | "Settling" | "Sold" | "Closed";

export interface Listing {
  id: number;
  seller: string;
  title: string;
  pitch: string;
  category: string;
  sealed_secret: string;
  secret_hash: string;
  sealed_floor: string;
  created_at_ms: number;
  status: Status;
  questions: number;
  buyer: string | null;
  price: string | null;
}

export interface Question {
  asker: string;
  question: string;
  answer: "pending" | "yes" | "no" | "refused" | "failed";
  confidence: number;
  model: string | null;
  asked_at_ms: number;
}

export interface Sale {
  listing_id: number;
  buyer: string;
  price: string;
  sealed_for_buyer: string;
  settled_at_ms: number;
}

let selectorPromise: Promise<{ selector: WalletSelector; modal: WalletSelectorModal }> | null = null;

export function wallet() {
  if (!selectorPromise) {
    selectorPromise = setupWalletSelector({
      network: NETWORK,
      modules: [setupMeteorWallet(), setupHotWallet(), setupIntearWallet(), setupMyNearWallet()],
    }).then((selector) => ({ selector, modal: setupModal(selector, { contractId: CONTRACT_ID }) }));
  }
  return selectorPromise;
}

export async function view<T>(method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "sphinx",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "optimistic",
        account_id: CONTRACT_ID,
        method_name: method,
        args_base64: btoa(JSON.stringify(args)),
      },
    }),
  });
  const json = await res.json();
  if (json.error || json.result?.error) {
    throw new Error(json.error?.cause?.name ?? json.result?.error ?? "The NEAR network did not answer");
  }
  return JSON.parse(new TextDecoder().decode(new Uint8Array(json.result.result))) as T;
}

/** Sends one function call from the signed-in wallet and returns its receipt outcome. */
export async function call(method: string, args: object, deposit: string) {
  const { selector } = await wallet();
  const w = await selector.wallet();
  return w.signAndSendTransaction({
    receiverId: CONTRACT_ID,
    actions: [actionCreators.functionCall(method, args, BigInt(GAS_300), BigInt(deposit))],
  });
}

/** Reads the value a transaction's first call returned, when the wallet hands back the outcome. */
export function returnedValue(outcome: unknown): unknown {
  const o = outcome as { status?: { SuccessValue?: string } } | undefined;
  const v = o?.status?.SuccessValue;
  if (!v) return undefined;
  try {
    return JSON.parse(atob(v));
  } catch {
    return undefined;
  }
}
