# Sphinx

**Buy secrets you can trust before you see them.**

Sphinx is a market for sealed information on NEAR. A seller locks a secret (a security finding, on-chain research, a dataset, a fix) inside a sealed box that nobody can open, not the buyer, not the operator, not us. Buyers ask the box yes-or-no questions, answered by a private AI model running in secure hardware. When a buyer wants it, both sides name a hidden price; if the prices overlap, the deal settles at a hidden random point between them in one NEAR transaction and the secret is re-sealed to the buyer's own key. If anything fails, the buyer is refunded in full.

- **Live app:** https://sphinx-near.vercel.app
- **Contract (NEAR mainnet):** [`7c3bcf93…cee9681`](https://nearblocks.io/address/7c3bcf93a61a597e5d07547926a3e06e0d4f6d99b12323523234faa53cee9681)
- **Sealed box (OutLayer mainnet project):** `7c3bcf93a61a597e5d07547926a3e06e0d4f6d99b12323523234faa53cee9681/sphinx`
- **Tracks:** Privacy & Private AI, Agent Economy, AI Security & Defense, Open Innovation

## The problem

Information is hard to sell. If the seller shows it to prove it is real, the buyer no longer needs to pay. If the seller hides it, the buyer cannot trust it. Security researchers, analysts and data sellers either give their work away to prove it, or get ignored. Sphinx lets a buyer check what a secret contains, through narrow questions, without anyone ever seeing it, and then swaps it for payment fairly.

## How it works

```mermaid
sequenceDiagram
  participant S as Seller (browser)
  participant C as Sphinx contract (NEAR)
  participant O as OutLayer (Intel TDX)
  participant AI as NEAR AI Cloud (TEE model)
  participant B as Buyer (browser)
  S->>S: seal secret + lowest price to the box key, stamped with the seller's account
  S->>C: list(sealed secret, SHA-256 of secret, sealed floor)
  B->>C: ask(question) + 0.02 NEAR
  C->>O: request_execution (yield)
  O->>O: derive box key, open secret
  O->>AI: trap scan: does the secret instruct the AI?
  O->>AI: question + secret (attested model only)
  O->>AI: the reversed question
  AI-->>O: answers must flip, or refused
  O-->>C: resume: verdict + confidence
  B->>B: seal highest price to the box, stamped with the buyer's account
  B->>C: buy(sealed ceiling, buyer key) + deposit
  C->>O: request_execution (yield)
  O->>O: check stamps + SHA-256, price = random point 25-75% between
  O-->>C: resume: price + secret sealed to buyer
  C->>S: pay price
  C->>B: refund change (or everything if no deal)
  B->>B: open secret with own key, check SHA-256
```

1. **Seal it.** The seller's browser seals the secret and the seller's lowest price to the box's public key (libsodium sealed box, X25519 + XSalsa20-Poly1305), each stamped with the seller's account inside the seal, and commits the secret's SHA-256 on-chain. The contract only ever stores ciphertext, and the box refuses a sealed value whose stamp does not match the account the contract says owns it. ([`web/src/seal.ts`](web/src/seal.ts), [`contract/src/lib.rs`](contract/src/lib.rs) `list`)
2. **Ask it.** Each question pauses the contract with NEAR's yield/resume, and OutLayer runs the sealed box inside Intel TDX. The box opens the secret and first runs a trap scan (does the secret try to give the AI instructions?); then it asks an attested NEAR AI Cloud model the question and its reverse. It returns only `yes`, `no` or `refused` with a coarse confidence level, and the answer is withheld unless the two answers flip. Five questions per account, thirty per listing. ([`enclave/src/main.rs`](enclave/src/main.rs) `ask`, [`contract/src/lib.rs`](contract/src/lib.rs) `ask` / `on_answer`)
3. **Price it secretly.** The buyer seals the most they would pay. The box opens both sealed prices; if they overlap, the price lands at a random point 25% to 75% of the way between them, drawn inside the TEE, so the final price does not reveal either limit. Three offers per account per listing stop anyone from probing the seller's price. ([`enclave/src/lib.rs`](enclave/src/lib.rs) `settle_price`, `point_from_random`)
4. **Swap it fairly.** In the same transaction the box re-seals the secret to the buyer's key and the contract pays the seller and refunds the buyer's change. Any failure refunds the buyer in full and reopens the listing. ([`contract/src/lib.rs`](contract/src/lib.rs) `buy` / `on_settled`)

## NEAR technology used (and where)

| Technology | How Sphinx uses it | Code |
|---|---|---|
| **OutLayer** (TEE execution, Intel TDX) | Runs the sealed box: `request_execution` from the contract, result delivered back through yield/resume | `contract/src/lib.rs` `run_box` |
| **OutLayer encryption keys** | The box's X25519 private key is `mac("sphinx-box", …)` of an encryption key bound to this project and to the Sphinx contract as caller; it never exists outside the TEE | `enclave/src/main.rs` `box_secret_key`, `enclave/manifest.json` |
| **OutLayer author secrets + access rules** | The NEAR AI key is an encrypted OutLayer secret, readable only by this exact build of the box and only for calls that come through the Sphinx contract | `enclave/manifest.json` `author_secrets` |
| **OutLayer network allowlist** | The box may only reach `cloud-api.near.ai` | `enclave/manifest.json` `capabilities.network` |
| **NEAR AI Cloud** (private inference in TEEs) | Answers questions; the box refuses any model that does not publish a TEE attestation, so a secret never reaches a third-party API | `enclave/src/lib.rs` `ATTESTED_MODELS`, `choose_model` |
| **NEAR yield/resume** (inside OutLayer) | OutLayer's `request_execution` yields until the TEE worker resumes it with the box's output; Sphinx's callback then records the answer or settles the sale, so every question and every sale completes as one chain of receipts | `contract/src/lib.rs` `run_box`, `on_answer`, `on_settled` |
| **NEAR smart contract (Rust, near-sdk 5)** | Listings, question limits, sale lock, escrow, pay-on-confirmation, refunds | `contract/src/lib.rs` |
| **NEAR wallets** (Wallet Selector: Meteor, HOT, Intear, MyNearWallet) | Sign in and sign `list`, `ask`, `buy` | `web/src/near.ts` |

## Proof: real mainnet run

The current contract and sealed box (build `38e3f784…`), run on mainnet on 14 Nov 2026 against open listing #3, "Missing slippage check in a swap router's multi-hop path" (seller lowest price 0.05 NEAR, sealed). Seller and buyer are two accounts of the same owner. Script: [`scripts/e2e.mjs`](scripts/e2e.mjs) `mainnet 3`, results: [`scripts/proof-mainnet.json`](scripts/proof-mainnet.json).

| Step | Result | Transaction |
|---|---|---|
| Contract publishes the box key (contract → OutLayer → contract) | key `zzV8vOdQ…JRY=` | [`6s8ycWMU…`](https://nearblocks.io/txns/6s8ycWMU46FS5mHBueKxq94LJ6mzkcCHN87TSjaw8Dri) |
| "Does the secret explain how to fix the problem?" (trap scan, question, reversed question) | **yes**, high confidence, 21.6 s | [`CxJw34oF…`](https://nearblocks.io/txns/CxJw34oFwBvT4MWHUpmko9J5rC3Mvxii7hBRBLrhDd3M) |
| "Is the affected contract an NFT marketplace?" | **no**, high confidence, 20.1 s | [`4WUUGpvk…`](https://nearblocks.io/txns/4WUUGpvkVJD5Mud2kAmz2QuiepyEPWdK3SpNMAfusEM1) |
| "What is the first word of the finding?" | **refused** (fishing question, never reaches the model) | [`6e9Xvnqx…`](https://nearblocks.io/txns/6e9XvnqxtgVWwrPxJbatiNrAqanbVYqaDdqrGajTmFD8) |
| Sealed offer: buyer max 0.09 NEAR vs seller min 0.05 NEAR | **sold at 0.067516 NEAR**, a random point 44% of the way between the two limits; change refunded | [`39wzsmv8…`](https://nearblocks.io/txns/39wzsmv8eDTLyrdR2h6yusm1NKKPguxXiqvvjEs6JkwG) |
| Buyer opens the secret with their own key | SHA-256 matches the listed fingerprint | `scripts/proof-mainnet.json` `"match": true` |
| Earlier run (first contract version): a buy while the box could not answer | full refund, listing reopened | [`8QTTmNeM…`](https://nearblocks.io/txns/8QTTmNeMkfnsNqkEWVUnEXEXYV7aoXWZyBtqaaApN8f3) |

Measured on mainnet: a question round trip takes 10 to 22 s; with the trap scan and the reversed question the box itself runs in 10 to 13 s (three model calls), a refused fishing question or a settlement in about 1 s. A box run costs 0.001 to 0.0023 NEAR; the rest of each 0.01 NEAR run fee is refunded by OutLayer.

## How to Test

### Quick test (5 minutes, on the live site)

You need a NEAR **mainnet** wallet (Meteor, HOT, Intear or MyNearWallet) with about **0.5 NEAR**. Most of it is only reserved for gas and comes straight back; a question really costs about 0.011 NEAR.

1. Open https://sphinx-near.vercel.app → you see the market: an open **Demo** listing, and listings #0 and #3 marked **Sold** with their answered questions (the proof runs above).
2. Click **Verify** → you see the box's public key, read live from the contract, and how each guarantee is enforced.
3. Click **Sell a secret**, sign in, type a title, at least 20 characters of secret and a lowest price like `0.05`, then **Seal and list** → your wallet asks you to approve `list`; after it confirms you land on your new listing, showing the fingerprint and "Lowest price: Sealed".
4. Sign in with a **different** account (or open a **Demo** listing) and ask "Does it explain how to fix the problem?" → the answer shows "the box is thinking…", then within about 40 seconds turns into **YES** or **NO** with a confidence level.
5. Ask "What is the first word of the secret?" → it comes back **REFUSED**.
6. Under **Make a sealed offer**, click **Download a backup of your unlock key**, then enter a maximum above the seller's price (for example `0.09`) and **Seal offer** → the listing shows "comparing the two hidden prices", then **Sold** at a price between the two.
7. Click **Open with my key** → the secret appears, with "Fingerprint matches the seller's commitment".

### Full test (run everything yourself)

Prerequisites: Git, Docker (or Rust 1.84 and 1.86 with `wasm32-wasip2`), Node.js 22+.

```bash
git clone https://github.com/Jennivarl/sphinx.git
cd sphinx
```

1. **Contract unit tests** (30 tests: listing rules, question limits per account and per listing, failed runs give questions back, three offers per account, the buyer pays the sale record storage, sale lock, pay only on a confirmed deal, never more than the deposit, full refund on failure):
   ```bash
   cd contract && cargo +1.86 test
   ```
   Expected: `test result: ok. 30 passed`.
2. **Sealed box unit tests** (22 tests: owner stamps, random price point and its bounds, no overlap, deposit cap, overflow, leak-proof verdict parsing, coarse confidence, trap scan fails closed, reversed answers must flip, fishing questions, attested models only):
   ```bash
   cd ../enclave && cargo +1.84 test --lib
   ```
   Expected: `test result: ok. 22 passed`.
3. **Build the sealed box** exactly as deployed (Rust 1.84 keeps its WASI imports at 0.2.2, which OutLayer's wasmtime 36 workers load):
   ```bash
   cargo +1.84 build --release --target wasm32-wasip2
   sha256sum target/wasm32-wasip2/release/sphinx-enclave.wasm
   ```
   Expected: `38e3f784ec210da5a16eff32b164a85756a36ca72054ba097676a81f7e02a94c`, the version the deployed project and the AI-key access rule are pinned to.
4. **Run the website locally:**
   ```bash
   cd ../web && npm ci && npm run dev
   ```
   Expected: open the printed `http://localhost:5173` and see the same market as the live site, read from mainnet.
5. **Replay the end-to-end proof** with your own accounts (costs real NEAR, about 0.1 NEAR moved between your two accounts plus about 0.05 NEAR of fees): copy `.env.example` to `.env`, set `MAINNET_ACCOUNT_ID` and `MAINNET_PRIVATE_KEY` for an account that already runs your own deployment, then:
   ```bash
   cd ../scripts && npm ci && node e2e.mjs mainnet
   ```
   Expected: three answered questions (yes / no / refused), `Sold` at a price between 0.06 and 0.08 NEAR, and `opened secret matches the listed fingerprint: true`.

To deploy your own instance: build both parts as above, publish the box with the OutLayer CLI (`outlayer upload`, `outlayer deploy sphinx <url>`), store your NEAR AI key with `outlayer secrets set` bound to the project, then run `scripts/deploy-contract.mjs` and `scripts/refresh-box-key.mjs`.

## Security model and honest limits

- **What is trusted:** Intel TDX on OutLayer's workers and NEAR AI Cloud's TEE models. If those enclaves were broken, a secret could be read.
- **What leaks:** each question reveals one answer (yes / no / refused plus low, medium or high confidence), never text. Five questions per account and thirty per listing cap what anyone learns, and every question is public on-chain.
- **The AI can be wrong.** The trap scan and the reversed-question check catch a secret that tries to steer the model, but a model can still misjudge content. The fingerprint guarantees the buyer gets exactly what was listed, not that the AI judged it correctly.
- **After a deal, both sides learn a range, not the other's limit.** The price sits at a random point between the two limits, so each side can only bound the other's number.
- **The buyer's deposit is public.** The true maximum inside it stays sealed, but the deposit is an upper bound.
- **The unlock key lives in the buyer's browser.** Download the backup before buying; without it a purchased secret cannot be opened again.
- **Developer mode:** the contract account still holds its full-access key, so its owner could deploy new code. The owner has no method to move funds or read secrets, but an upgrade could add one. Before Sphinx holds real value, upgrade rights move to a Sputnik DAO with a 7-day timelock and reproducible, verified builds. The AI-key secret is already pinned to one exact build of the box.

## Business

Free during the hackathon. The model: a small fee on each settled sale (taken in the same settlement transaction), plus paid question bundles for buyers who need more than five questions per listing.

## Repository layout

| Path | What it is |
|---|---|
| `contract/` | NEAR smart contract (Rust, near-sdk 5) and its unit tests |
| `enclave/` | The sealed box: a `wasm32-wasip2` program OutLayer runs inside Intel TDX, with unit tests for its pure logic |
| `web/` | The website (Vite, React, TypeScript) |
| `scripts/` | Mainnet wallet setup, deploy, box key refresh, demo listings and the end-to-end proof |

## Libraries

near-sdk, crypto_box (RustCrypto), sha2, serde, base64, wit-bindgen, wasi-http-client, near-api-js, @near-wallet-selector, libsodium-wrappers, React, Vite.

## License

MIT
