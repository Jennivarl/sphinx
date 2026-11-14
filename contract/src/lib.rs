//! Sphinx: a market for sealed secrets on NEAR.
//!
//! A seller locks a secret to the sealed box (an OutLayer TEE program) and
//! commits its SHA-256. Each buyer may ask five yes/no questions (thirty per
//! listing), answered by an attested NEAR AI model called from inside the box.
//! To buy, the buyer seals a price ceiling and deposits at least that much; the
//! box opens both sealed prices, and if they overlap the deal settles at a
//! random point 25-75% of the way between them: the seller is paid, the buyer
//! gets the change and the secret re-sealed to their own key. If anything
//! fails, the buyer is refunded in full and the listing reopens.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
};

pub const MAX_QUESTIONS_PER_ASKER: u32 = 5;
/// Caps what many accounts together can learn about one secret.
pub const MAX_QUESTIONS_PER_LISTING: u32 = 30;
/// Caps how far one account can probe the seller's sealed lowest price.
pub const MAX_OFFERS_PER_ACCOUNT: u32 = 3;
/// Forwarded to OutLayer for each sealed-box run. OutLayer refunds what the run
/// does not use to the payer (the asker or buyer).
pub const RUN_FEE: NearToken = NearToken::from_millinear(10);
/// Kept by the contract to pay for a question's storage.
pub const QUESTION_STORAGE: NearToken = NearToken::from_millinear(10);
pub const ASK_DEPOSIT: NearToken = NearToken::from_millinear(20);
const CALLBACK_GAS: Gas = Gas::from_tgas(30);
const MAX_TITLE: usize = 120;
const MAX_PITCH: usize = 600;
const MAX_SEALED: usize = 24_000;
/// Bytes a sale record needs beyond the re-sealed secret (ids, price, keys, borsh overhead).
const SALE_RECORD_OVERHEAD: u64 = 400;

#[derive(BorshStorageKey)]
#[near]
enum Key {
    Listings,
    Questions,
    Asked,
    Sales,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum Status {
    Open,
    Settling,
    Sold,
    Closed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Listing {
    pub id: u64,
    pub seller: AccountId,
    pub title: String,
    pub pitch: String,
    pub category: String,
    pub sealed_secret: String,
    pub secret_hash: String,
    pub sealed_floor: String,
    pub created_at_ms: u64,
    pub status: Status,
    pub questions: u32,
    pub buyer: Option<AccountId>,
    pub price: Option<U128>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Question {
    pub asker: AccountId,
    pub question: String,
    /// "pending", "yes", "no", "refused" or "failed"
    pub answer: String,
    pub confidence: u8,
    pub model: Option<String>,
    pub asked_at_ms: u64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Sale {
    pub listing_id: u64,
    pub buyer: AccountId,
    pub price: U128,
    /// The secret sealed to the buyer's own public key by the box.
    pub sealed_for_buyer: String,
    pub settled_at_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Sphinx {
    owner: AccountId,
    outlayer: AccountId,
    project_id: String,
    box_public_key: Option<String>,
    next_id: u64,
    listings: IterableMap<u64, Listing>,
    questions: LookupMap<u64, Vec<Question>>,
    asked: LookupMap<String, u32>,
    sales: LookupMap<u64, Sale>,
}

fn event(name: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({ "standard": "sphinx", "version": "1.0.0", "event": name, "data": [data] })
    ));
}

fn asked_key(listing_id: u64, account: &AccountId) -> String {
    format!("{listing_id}:{account}")
}

fn offers_key(listing_id: u64, account: &AccountId) -> String {
    format!("offer:{listing_id}:{account}")
}

#[near]
impl Sphinx {
    #[init]
    pub fn new(outlayer: AccountId, project_id: String) -> Self {
        Self {
            owner: env::predecessor_account_id(),
            outlayer,
            project_id,
            box_public_key: None,
            next_id: 0,
            listings: IterableMap::new(Key::Listings),
            questions: LookupMap::new(Key::Questions),
            asked: LookupMap::new(Key::Asked),
            sales: LookupMap::new(Key::Sales),
        }
    }

    // ---------- the sealed box's key ----------

    /// Asks the box for the public key sellers and buyers seal to. The key is
    /// bound to this contract as the caller, so only runs this contract
    /// starts can open what was sealed to it.
    #[payable]
    pub fn refresh_box_key(&mut self) -> Promise {
        require!(env::predecessor_account_id() == self.owner, "only the owner");
        require!(env::attached_deposit() >= RUN_FEE, "attach 0.01 NEAR for the run");
        self.run_box(json!({ "op": "pubkey" }), env::predecessor_account_id(), env::attached_deposit())
            .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_box_key())
    }

    #[private]
    pub fn on_box_key(&mut self, #[callback_result] result: Result<Option<Value>, PromiseError>) -> Option<String> {
        let key = match result {
            Ok(Some(v)) if v["ok"] == json!(true) => v["public_key"].as_str().map(str::to_string),
            _ => None,
        };
        if let Some(k) = &key {
            self.box_public_key = Some(k.clone());
            event("box_key", json!({ "public_key": k }));
        }
        key
    }

    // ---------- selling ----------

    /// Lists a sealed secret. Every sealed value must be locked to the box's
    /// public key in the seller's browser; the contract never sees plaintext.
    /// Attach enough NEAR to cover storage; the rest is refunded.
    #[payable]
    pub fn list(
        &mut self,
        title: String,
        pitch: String,
        category: String,
        sealed_secret: String,
        secret_hash: String,
        sealed_floor: String,
    ) -> u64 {
        require!(self.box_public_key.is_some(), "the box key is not set yet");
        require!(!title.trim().is_empty() && title.len() <= MAX_TITLE, "title must be 1-120 characters");
        require!(pitch.len() <= MAX_PITCH, "pitch must be at most 600 characters");
        require!(
            !sealed_secret.is_empty() && sealed_secret.len() <= MAX_SEALED,
            "sealed secret must be 1-24000 characters"
        );
        require!(!sealed_floor.is_empty() && sealed_floor.len() <= 512, "sealed floor is missing");
        require!(
            secret_hash.len() == 64 && secret_hash.bytes().all(|b| b.is_ascii_hexdigit()),
            "secret hash must be 64 hex characters"
        );

        let before = env::storage_usage();
        let id = self.next_id;
        self.next_id += 1;
        let listing = Listing {
            id,
            seller: env::predecessor_account_id(),
            title: title.trim().to_string(),
            pitch,
            category,
            sealed_secret,
            secret_hash: secret_hash.to_lowercase(),
            sealed_floor,
            created_at_ms: env::block_timestamp_ms(),
            status: Status::Open,
            questions: 0,
            buyer: None,
            price: None,
        };
        self.listings.insert(id, listing);
        self.listings.flush();
        let cost = env::storage_byte_cost().saturating_mul((env::storage_usage() - before) as u128);
        let attached = env::attached_deposit();
        require!(attached >= cost, format!("attach at least {} yoctoNEAR for storage", cost.as_yoctonear()));
        let refund = attached.saturating_sub(cost);
        if !refund.is_zero() {
            let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
        }
        event("listed", json!({ "id": id, "seller": env::predecessor_account_id() }));
        id
    }

    /// The seller can withdraw a listing that is not being sold.
    pub fn close(&mut self, listing_id: u64) {
        let mut listing = self.listings.get(&listing_id).cloned().expect("no such listing");
        require!(env::predecessor_account_id() == listing.seller, "only the seller");
        require!(listing.status == Status::Open, "listing is not open");
        listing.status = Status::Closed;
        self.listings.insert(listing_id, listing);
        event("closed", json!({ "id": listing_id }));
    }

    // ---------- asking ----------

    /// Asks the sealed box one yes/no question. At most five per account per
    /// listing. Attach 0.02 NEAR: 0.01 pays the run (unused part refunded by
    /// OutLayer), 0.01 pays for storing the question and answer.
    #[payable]
    pub fn ask(&mut self, listing_id: u64, question: String) -> Promise {
        let asker = env::predecessor_account_id();
        let mut listing = self.listings.get(&listing_id).cloned().expect("no such listing");
        require!(listing.status == Status::Open, "listing is not open");
        require!(asker != listing.seller, "sellers cannot question their own secret");
        require!(listing.questions < MAX_QUESTIONS_PER_LISTING, "this listing has reached its 30-question limit");
        require!(env::attached_deposit() >= ASK_DEPOSIT, "attach 0.02 NEAR to ask");
        let q = question.trim().to_string();
        require!(q.chars().count() >= 8 && q.chars().count() <= 280, "question must be 8-280 characters");

        let key = asked_key(listing_id, &asker);
        let count = self.asked.get(&key).copied().unwrap_or(0);
        require!(count < MAX_QUESTIONS_PER_ASKER, "you already asked 5 questions about this listing");
        self.asked.insert(key, count + 1);

        let mut list = self.questions.get(&listing_id).cloned().unwrap_or_default();
        let index = list.len() as u32;
        list.push(Question {
            asker: asker.clone(),
            question: q.clone(),
            answer: "pending".into(),
            confidence: 0,
            model: None,
            asked_at_ms: env::block_timestamp_ms(),
        });
        self.questions.insert(listing_id, list);
        listing.questions += 1;
        let title = listing.title.clone();
        let seller = listing.seller.clone();
        let sealed_secret = listing.sealed_secret.clone();
        self.listings.insert(listing_id, listing);

        let run_deposit = env::attached_deposit().saturating_sub(QUESTION_STORAGE);
        self.run_box(
            json!({ "op": "ask", "title": title, "seller": seller, "sealed_secret": sealed_secret, "question": q }),
            asker,
            run_deposit,
        )
        .then(Self::ext(env::current_account_id()).with_static_gas(CALLBACK_GAS).on_answer(listing_id, index))
    }

    #[private]
    pub fn on_answer(
        &mut self,
        listing_id: u64,
        index: u32,
        #[callback_result] result: Result<Option<Value>, PromiseError>,
    ) -> String {
        let mut list = self.questions.get(&listing_id).cloned().unwrap_or_default();
        let Some(q) = list.get_mut(index as usize) else { return "missing".into() };
        match result {
            Ok(Some(v)) if v["ok"] == json!(true) => {
                q.answer = match v["answer"].as_str() {
                    Some("yes") => "yes".into(),
                    Some("no") => "no".into(),
                    _ => "refused".into(),
                };
                q.confidence = v["confidence"].as_u64().unwrap_or(0).min(100) as u8;
                q.model = v["model"].as_str().map(str::to_string);
            }
            _ => {
                q.answer = "failed".into();
                // A failed run uses up neither one of the asker's five questions
                // nor one of the listing's thirty.
                let key = asked_key(listing_id, &q.asker);
                if let Some(c) = self.asked.get(&key).copied() {
                    self.asked.insert(key, c.saturating_sub(1));
                }
                if let Some(mut listing) = self.listings.get(&listing_id).cloned() {
                    listing.questions = listing.questions.saturating_sub(1);
                    self.listings.insert(listing_id, listing);
                }
            }
        }
        let answer = q.answer.clone();
        event("answered", json!({ "id": listing_id, "index": index, "answer": answer }));
        self.questions.insert(listing_id, list);
        answer
    }

    // ---------- buying ----------

    /// Buys a secret. `sealed_ceiling` is the buyer's highest price, sealed to
    /// the box. Attach the most you could pay, plus 0.01 NEAR for the run, plus
    /// the storage for the sale record (`sale_storage`). The box charges a random
    /// point 25-75% between the two sealed prices and the rest comes back.
    /// `buyer_public_key` (base64, 32 bytes) is the key the secret is sealed to.
    #[payable]
    pub fn buy(&mut self, listing_id: u64, sealed_ceiling: String, buyer_public_key: String) -> Promise {
        let buyer = env::predecessor_account_id();
        let mut listing = self.listings.get(&listing_id).cloned().expect("no such listing");
        require!(listing.status == Status::Open, "listing is not open");
        require!(buyer != listing.seller, "sellers cannot buy their own secret");
        require!(!sealed_ceiling.is_empty() && sealed_ceiling.len() <= 512, "sealed ceiling is missing");
        require!(buyer_public_key.len() == 44, "buyer public key must be 32 bytes in base64");
        let attached = env::attached_deposit();
        let storage = Self::sale_storage_cost(&listing);
        require!(
            attached > RUN_FEE.saturating_add(storage),
            format!("attach your maximum price plus 0.01 NEAR plus {} yoctoNEAR for the sale record", storage.as_yoctonear())
        );
        let escrow = attached.saturating_sub(RUN_FEE).saturating_sub(storage);
        let key = offers_key(listing_id, &buyer);
        let offers = self.asked.get(&key).copied().unwrap_or(0);
        require!(offers < MAX_OFFERS_PER_ACCOUNT, "you already made 3 offers on this listing");
        self.asked.insert(key, offers + 1);

        listing.status = Status::Settling;
        let input = json!({
            "op": "settle",
            "seller": listing.seller,
            "buyer": buyer,
            "sealed_secret": listing.sealed_secret,
            "secret_hash": listing.secret_hash,
            "sealed_floor": listing.sealed_floor,
            "sealed_ceiling": sealed_ceiling,
            "deposit": escrow.as_yoctonear().to_string(),
            "buyer_public_key": buyer_public_key,
        });
        self.listings.insert(listing_id, listing);
        event("settling", json!({ "id": listing_id, "buyer": buyer, "escrow": U128(escrow.as_yoctonear()) }));

        self.run_box(input, buyer.clone(), RUN_FEE).then(
            Self::ext(env::current_account_id())
                .with_static_gas(CALLBACK_GAS)
                .on_settled(listing_id, buyer, U128(escrow.as_yoctonear()), U128(storage.as_yoctonear())),
        )
    }

    #[private]
    pub fn on_settled(
        &mut self,
        listing_id: u64,
        buyer: AccountId,
        escrow: U128,
        storage: U128,
        #[callback_result] result: Result<Option<Value>, PromiseError>,
    ) -> Value {
        let mut listing = self.listings.get(&listing_id).cloned().expect("no such listing");
        let escrow = NearToken::from_yoctonear(escrow.0);
        // Paid by the buyer in `buy`: kept for the sale record, or refunded with the escrow.
        let storage = NearToken::from_yoctonear(storage.0);

        let deal = match &result {
            Ok(Some(v)) if v["ok"] == json!(true) && v["deal"] == json!(true) => {
                let price = v["price"].as_str().and_then(|p| p.parse::<u128>().ok());
                let sealed = v["sealed_for_buyer"].as_str().map(str::to_string);
                match (price, sealed) {
                    (Some(p), Some(s)) if p > 0 && p <= escrow.as_yoctonear() && !s.is_empty() => Some((p, s)),
                    _ => None,
                }
            }
            _ => None,
        };

        match deal {
            Some((price, sealed_for_buyer)) => {
                let price_token = NearToken::from_yoctonear(price);
                let _ = Promise::new(listing.seller.clone()).transfer(price_token);
                let change = escrow.saturating_sub(price_token);
                if !change.is_zero() {
                    let _ = Promise::new(buyer.clone()).transfer(change);
                }
                listing.status = Status::Sold;
                listing.buyer = Some(buyer.clone());
                listing.price = Some(U128(price));
                self.listings.insert(listing_id, listing);
                self.sales.insert(
                    listing_id,
                    Sale {
                        listing_id,
                        buyer: buyer.clone(),
                        price: U128(price),
                        sealed_for_buyer,
                        settled_at_ms: env::block_timestamp_ms(),
                    },
                );
                event("sold", json!({ "id": listing_id, "buyer": buyer, "price": U128(price) }));
                json!({ "deal": true, "price": U128(price) })
            }
            None => {
                let _ = Promise::new(buyer.clone()).transfer(escrow.saturating_add(storage));
                listing.status = Status::Open;
                self.listings.insert(listing_id, listing);
                let reason = match &result {
                    Ok(Some(v)) => v["reason"].as_str().or(v["error"].as_str()).unwrap_or("no deal").to_string(),
                    _ => "the sealed box did not answer".to_string(),
                };
                event("no_deal", json!({ "id": listing_id, "buyer": buyer, "reason": reason }));
                json!({ "deal": false, "reason": reason })
            }
        }
    }

    // ---------- views ----------

    pub fn get_config(&self) -> Value {
        json!({
            "owner": self.owner,
            "outlayer": self.outlayer,
            "project_id": self.project_id,
            "box_public_key": self.box_public_key,
            "listings": self.next_id,
        })
    }

    pub fn box_public_key(&self) -> Option<String> {
        self.box_public_key.clone()
    }

    pub fn get_listing(&self, listing_id: u64) -> Option<Listing> {
        self.listings.get(&listing_id).cloned()
    }

    /// Newest first.
    pub fn get_listings(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Listing> {
        let limit = limit.unwrap_or(20).min(50);
        let start = from.unwrap_or(self.next_id);
        (0..start)
            .rev()
            .filter_map(|id| self.listings.get(&id).cloned())
            .take(limit as usize)
            .collect()
    }

    pub fn get_questions(&self, listing_id: u64) -> Vec<Question> {
        self.questions.get(&listing_id).cloned().unwrap_or_default()
    }

    /// What a buyer must attach on top of their maximum price and the run fee.
    pub fn sale_storage(&self, listing_id: u64) -> U128 {
        let listing = self.listings.get(&listing_id).expect("no such listing");
        U128(Self::sale_storage_cost(listing).as_yoctonear())
    }

    pub fn offers_left(&self, listing_id: u64, account_id: AccountId) -> u32 {
        MAX_OFFERS_PER_ACCOUNT - self.asked.get(&offers_key(listing_id, &account_id)).copied().unwrap_or(0)
    }

    pub fn questions_left(&self, listing_id: u64, account_id: AccountId) -> u32 {
        MAX_QUESTIONS_PER_ASKER - self.asked.get(&asked_key(listing_id, &account_id)).copied().unwrap_or(0)
    }

    pub fn get_sale(&self, listing_id: u64) -> Option<Sale> {
        self.sales.get(&listing_id).cloned()
    }
}

impl Sphinx {
    /// The re-sealed secret is never longer than the seller's sealed envelope,
    /// so this always covers the sale record the callback writes.
    fn sale_storage_cost(listing: &Listing) -> NearToken {
        env::storage_byte_cost().saturating_mul(u128::from(listing.sealed_secret.len() as u64 + SALE_RECORD_OVERHEAD))
    }

    fn run_box(&self, input: Value, payer: AccountId, deposit: NearToken) -> Promise {
        let args = json!({
            "source": { "Project": { "project_id": self.project_id, "version_key": null } },
            "resource_limits": { "max_instructions": 10_000_000_000u64, "max_memory_mb": 128, "max_execution_seconds": 45 },
            "input_data": serde_json::to_string(&input).unwrap(),
            // No secrets_ref: the box's manifest declares `author_secrets`, so OutLayer
            // injects the project author's NEAR AI key itself. Passing it here too makes
            // OutLayer refuse the run ("both define NEAR_AI_API_KEY").
            "response_format": "Json",
            "payer_account_id": payer,
        });
        Promise::new(self.outlayer.clone()).function_call_weight(
            "request_execution".to_string(),
            serde_json::to_vec(&args).unwrap(),
            deposit,
            Gas::from_tgas(0),
            near_sdk::GasWeight(1),
        )
    }
}

#[cfg(test)]
mod tests;
