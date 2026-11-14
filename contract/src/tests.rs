#![allow(unused_must_use)] // calls under test return promises the test does not need
use super::*;
use near_sdk::test_utils::{accounts, VMContextBuilder};
use near_sdk::testing_env;

const NEAR: u128 = 1_000_000_000_000_000_000_000_000;
const HASH: &str = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const BUYER_KEY: &str = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

fn ctx(predecessor: usize, deposit_yocto: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id("sphinx.testnet".parse().unwrap())
        .predecessor_account_id(accounts(predecessor))
        .attached_deposit(NearToken::from_yoctonear(deposit_yocto))
        .account_balance(NearToken::from_near(100));
    testing_env!(b.build());
}

/// owner = accounts(0), seller = accounts(1), buyer = accounts(2)
fn setup() -> Sphinx {
    ctx(0, 0);
    let mut c = Sphinx::new("outlayer.testnet".parse().unwrap(), "sphinx.testnet/sphinx".into());
    ctx(0, 0);
    c.on_box_key(Ok(Some(json!({ "ok": true, "public_key": "PUBKEY" }))));
    c
}

fn listed() -> (Sphinx, u64) {
    let mut c = setup();
    ctx(1, NEAR);
    let id = c.list(
        "Reentrancy in a lending vault".into(),
        "Working exploit path and fix".into(),
        "audit".into(),
        "SEALED_SECRET".into(),
        HASH.into(),
        "SEALED_FLOOR".into(),
    );
    (c, id)
}

#[test]
fn box_key_is_stored_from_a_good_run() {
    let c = setup();
    assert_eq!(c.box_public_key(), Some("PUBKEY".into()));
}

#[test]
fn failed_box_key_run_keeps_old_key() {
    let mut c = setup();
    c.on_box_key(Err(PromiseError::Failed));
    c.on_box_key(Ok(Some(json!({ "ok": false, "error": "x" }))));
    assert_eq!(c.box_public_key(), Some("PUBKEY".into()));
}

#[test]
#[should_panic(expected = "only the owner")]
fn only_owner_refreshes_box_key() {
    let mut c = setup();
    ctx(1, NEAR);
    c.refresh_box_key();
}

#[test]
fn listing_is_stored_open() {
    let (c, id) = listed();
    let l = c.get_listing(id).unwrap();
    assert_eq!(l.status, Status::Open);
    assert_eq!(l.seller, accounts(1));
    assert_eq!(c.get_listings(None, None).len(), 1);
}

#[test]
#[should_panic(expected = "the box key is not set yet")]
fn cannot_list_before_box_key() {
    ctx(0, 0);
    let mut c = Sphinx::new("outlayer.testnet".parse().unwrap(), "p".into());
    ctx(1, NEAR);
    c.list("t".into(), "".into(), "audit".into(), "S".into(), HASH.into(), "F".into());
}

#[test]
#[should_panic(expected = "secret hash must be 64 hex characters")]
fn listing_needs_a_real_hash() {
    let mut c = setup();
    ctx(1, NEAR);
    c.list("t".into(), "".into(), "audit".into(), "S".into(), "nothex".into(), "F".into());
}

#[test]
#[should_panic(expected = "attach at least")]
fn listing_must_pay_storage() {
    let mut c = setup();
    ctx(1, 0);
    c.list("t".into(), "".into(), "audit".into(), "S".into(), HASH.into(), "F".into());
}

#[test]
fn ask_records_a_pending_question() {
    let (mut c, id) = listed();
    ctx(2, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
    let qs = c.get_questions(id);
    assert_eq!(qs.len(), 1);
    assert_eq!(qs[0].answer, "pending");
    assert_eq!(c.questions_left(id, accounts(2)), 4);
}

#[test]
#[should_panic(expected = "you already asked 5 questions")]
fn sixth_question_is_refused() {
    let (mut c, id) = listed();
    for _ in 0..6 {
        ctx(2, ASK_DEPOSIT.as_yoctonear());
        c.ask(id, "Does it describe a bug that can drain funds?".into());
    }
}

#[test]
#[should_panic(expected = "sellers cannot question their own secret")]
fn seller_cannot_ask() {
    let (mut c, id) = listed();
    ctx(1, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
}

#[test]
#[should_panic(expected = "attach 0.02 NEAR to ask")]
fn ask_needs_deposit() {
    let (mut c, id) = listed();
    ctx(2, 1);
    c.ask(id, "Does it describe a bug that can drain funds?".into());
}

#[test]
fn answer_is_written_from_the_box() {
    let (mut c, id) = listed();
    ctx(2, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
    let out = c.on_answer(id, 0, Ok(Some(json!({ "ok": true, "answer": "yes", "confidence": 91, "model": "m" }))));
    assert_eq!(out, "yes");
    let q = &c.get_questions(id)[0];
    assert_eq!((q.answer.as_str(), q.confidence), ("yes", 91));
}

#[test]
fn unexpected_answer_text_becomes_refused() {
    let (mut c, id) = listed();
    ctx(2, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
    let out = c.on_answer(id, 0, Ok(Some(json!({ "ok": true, "answer": "the key is 0xabc", "confidence": 900 }))));
    assert_eq!(out, "refused");
    assert_eq!(c.get_questions(id)[0].confidence, 100);
}

#[test]
fn failed_run_gives_the_question_back() {
    let (mut c, id) = listed();
    ctx(2, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
    assert_eq!(c.questions_left(id, accounts(2)), 4);
    assert_eq!(c.on_answer(id, 0, Err(PromiseError::Failed)), "failed");
    assert_eq!(c.questions_left(id, accounts(2)), 5);
}

fn storage_of(c: &Sphinx, id: u64) -> u128 {
    c.sale_storage(id).0
}

fn bought(escrow_near: u128) -> (Sphinx, u64) {
    let (mut c, id) = listed();
    let storage = storage_of(&c, id);
    ctx(2, escrow_near * NEAR + RUN_FEE.as_yoctonear() + storage);
    c.buy(id, "SEALED_CEILING".into(), BUYER_KEY.into());
    (c, id)
}

#[test]
fn buy_locks_the_listing() {
    let (c, id) = bought(5);
    assert_eq!(c.get_listing(id).unwrap().status, Status::Settling);
}

#[test]
#[should_panic(expected = "listing is not open")]
fn no_second_buyer_while_settling() {
    let (mut c, id) = bought(5);
    ctx(3, 5 * NEAR);
    c.buy(id, "SEALED_CEILING".into(), BUYER_KEY.into());
}

#[test]
#[should_panic(expected = "listing is not open")]
fn no_questions_while_settling() {
    let (mut c, id) = bought(5);
    ctx(3, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
}

#[test]
fn deal_marks_sold_and_stores_the_sealed_secret() {
    let (mut c, id) = bought(5);
    let price = 3 * NEAR;
    let out = c.on_settled(
        id,
        accounts(2),
        U128(5 * NEAR),
        U128(storage_of(&c, id)),
        Ok(Some(json!({ "ok": true, "deal": true, "price": price.to_string(), "sealed_for_buyer": "FOR_BUYER" }))),
    );
    assert_eq!(out["deal"], json!(true));
    let l = c.get_listing(id).unwrap();
    assert_eq!(l.status, Status::Sold);
    assert_eq!(l.buyer, Some(accounts(2)));
    assert_eq!(l.price, Some(U128(price)));
    let s = c.get_sale(id).unwrap();
    assert_eq!(s.sealed_for_buyer, "FOR_BUYER");
    assert_eq!(s.buyer, accounts(2));
}

#[test]
fn no_overlap_reopens_the_listing() {
    let (mut c, id) = bought(5);
    let out = c.on_settled(
        id,
        accounts(2),
        U128(5 * NEAR),
        U128(storage_of(&c, id)),
        Ok(Some(json!({ "ok": true, "deal": false, "reason": "the sealed limits do not overlap" }))),
    );
    assert_eq!(out["deal"], json!(false));
    assert_eq!(c.get_listing(id).unwrap().status, Status::Open);
    assert!(c.get_sale(id).is_none());
}

#[test]
fn price_above_escrow_is_never_paid() {
    let (mut c, id) = bought(5);
    let out = c.on_settled(
        id,
        accounts(2),
        U128(5 * NEAR),
        U128(storage_of(&c, id)),
        Ok(Some(json!({ "ok": true, "deal": true, "price": (6 * NEAR).to_string(), "sealed_for_buyer": "X" }))),
    );
    assert_eq!(out["deal"], json!(false));
    assert_eq!(c.get_listing(id).unwrap().status, Status::Open);
}

#[test]
fn box_failure_refunds_and_reopens() {
    let (mut c, id) = bought(5);
    let out = c.on_settled(id, accounts(2), U128(5 * NEAR), U128(storage_of(&c, id)), Err(PromiseError::Failed));
    assert_eq!(out["deal"], json!(false));
    assert_eq!(out["reason"], json!("the sealed box did not answer"));
    assert_eq!(c.get_listing(id).unwrap().status, Status::Open);
}

#[test]
fn missing_sealed_secret_is_no_deal() {
    let (mut c, id) = bought(5);
    let out = c.on_settled(
        id,
        accounts(2),
        U128(5 * NEAR),
        U128(storage_of(&c, id)),
        Ok(Some(json!({ "ok": true, "deal": true, "price": NEAR.to_string() }))),
    );
    assert_eq!(out["deal"], json!(false));
}

#[test]
#[should_panic(expected = "sellers cannot buy their own secret")]
fn seller_cannot_buy() {
    let (mut c, id) = listed();
    ctx(1, 5 * NEAR);
    c.buy(id, "SEALED_CEILING".into(), BUYER_KEY.into());
}

#[test]
fn seller_can_close_an_open_listing() {
    let (mut c, id) = listed();
    ctx(1, 0);
    c.close(id);
    assert_eq!(c.get_listing(id).unwrap().status, Status::Closed);
}

#[test]
fn offers_are_capped_per_account() {
    let (mut c, id) = listed();
    for _ in 0..MAX_OFFERS_PER_ACCOUNT {
        ctx(2, NEAR + RUN_FEE.as_yoctonear() + storage_of(&c, id));
        c.buy(id, "SEALED_CEILING".into(), BUYER_KEY.into());
        c.on_settled(id, accounts(2), U128(NEAR), U128(storage_of(&c, id)), Ok(Some(json!({ "ok": true, "deal": false, "reason": "no overlap" }))));
    }
    assert_eq!(c.offers_left(id, accounts(2)), 0);
    assert_eq!(c.offers_left(id, accounts(3)), MAX_OFFERS_PER_ACCOUNT);
}

#[test]
#[should_panic(expected = "you already made 3 offers")]
fn fourth_offer_is_refused() {
    let (mut c, id) = listed();
    for _ in 0..=MAX_OFFERS_PER_ACCOUNT {
        ctx(2, NEAR + RUN_FEE.as_yoctonear() + storage_of(&c, id));
        c.buy(id, "SEALED_CEILING".into(), BUYER_KEY.into());
        c.on_settled(id, accounts(2), U128(NEAR), U128(storage_of(&c, id)), Ok(Some(json!({ "ok": true, "deal": false }))));
    }
}

#[test]
#[should_panic(expected = "30-question limit")]
fn listing_question_cap_holds_across_accounts() {
    let (mut c, id) = listed();
    // Six accounts x five questions reach the cap; the next account is refused.
    for i in 0..=MAX_QUESTIONS_PER_LISTING {
        let mut b = VMContextBuilder::new();
        b.current_account_id("sphinx.testnet".parse().unwrap())
            .predecessor_account_id(format!("asker{}.testnet", i / MAX_QUESTIONS_PER_ASKER).parse().unwrap())
            .attached_deposit(ASK_DEPOSIT)
            .account_balance(NearToken::from_near(100));
        testing_env!(b.build());
        c.ask(id, "Does it describe a bug that can drain funds?".into());
    }
}

#[test]
#[should_panic(expected = "for the sale record")]
fn buy_must_cover_the_sale_record_storage() {
    let (mut c, id) = listed();
    // Enough for a price and the run fee, but nothing for the sale record.
    ctx(2, RUN_FEE.as_yoctonear() + 1);
    c.buy(id, "SEALED_CEILING".into(), BUYER_KEY.into());
}

#[test]
fn sale_storage_grows_with_the_secret() {
    let (c, id) = listed();
    let small = storage_of(&c, id);
    ctx(1, NEAR);
    let mut c = c;
    let big = c.list("t".into(), "".into(), "audit".into(), "S".repeat(10_000), HASH.into(), "F".into());
    assert!(storage_of(&c, big) > small);
}

#[test]
fn failed_run_gives_the_listing_question_back() {
    let (mut c, id) = listed();
    ctx(2, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
    assert_eq!(c.get_listing(id).unwrap().questions, 1);
    c.on_answer(id, 0, Err(PromiseError::Failed));
    assert_eq!(c.get_listing(id).unwrap().questions, 0);
}

fn receipt() -> serde_json::Value {
    serde_json::json!({
        "chat_id": "chatcmpl-f953d03b-0be6-42aa-bdbe-0e5f98f89903",
        "request_hash": "1".repeat(64),
        "response_hash": "2".repeat(64),
        "signature": format!("0x{}", "ab".repeat(65)),
        "signing_address": "0xfe0071895500a9755c18044948ab4f4e1a7f337e",
    })
}

#[test]
fn answer_keeps_the_near_ai_signature_receipt() {
    let (mut c, id) = listed();
    ctx(2, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
    let mut out = serde_json::json!({ "ok": true, "answer": "yes", "confidence": 100, "model": "m" });
    out["receipt"] = receipt();
    out["receipt"]["extra"] = "dropped".into();
    c.on_answer(id, 0, Ok(Some(out)));
    let receipts = c.get_receipts(id);
    assert_eq!(receipts.len(), 1);
    let stored = receipts[0].clone().unwrap();
    assert_eq!(stored["signing_address"], "0xfe0071895500a9755c18044948ab4f4e1a7f337e");
    assert!(stored.get("extra").is_none());
}

#[test]
fn malformed_or_missing_receipts_are_not_stored() {
    let (mut c, id) = listed();
    ctx(2, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Does it describe a bug that can drain funds?".into());
    let mut bad = receipt();
    bad["signature"] = "0xabcd".into();
    c.on_answer(id, 0, Ok(Some(serde_json::json!({ "ok": true, "answer": "yes", "confidence": 100, "receipt": bad }))));
    ctx(3, ASK_DEPOSIT.as_yoctonear());
    c.ask(id, "Is the affected contract an NFT marketplace?".into());
    c.on_answer(id, 1, Ok(Some(serde_json::json!({ "ok": true, "answer": "no", "confidence": 100 }))));
    assert_eq!(c.get_receipts(id), vec![None, None]);
}
