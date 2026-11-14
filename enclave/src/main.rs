//! Sphinx sealed box. Runs inside OutLayer's TEE (wasm32-wasip2).
//!
//! Reads one JSON request on stdin and prints one JSON reply on stdout:
//!   {"op":"pubkey"}                                      -> the box's public key
//!   {"op":"ask", title, sealed_secret, question}         -> yes / no / refused + confidence
//!   {"op":"settle", sealed_secret, secret_hash, sealed_floor, sealed_ceiling,
//!                   deposit, buyer_public_key}           -> deal price + secret sealed to the buyer
//!
//! The box's private key is derived inside the TEE from an OutLayer encryption
//! key bound to this project and to the calling contract, so nobody (not the
//! seller, the buyer, the operator or us) ever holds it.

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use crypto_box::{aead::OsRng, PublicKey, SecretKey};
use serde::Deserialize;
use serde_json::{json, Value};
use sphinx_enclave::*;
use std::io::Read;

#[cfg(target_arch = "wasm32")]
#[used]
#[link_section = "outlayer.manifest"]
static OUTLAYER_MANIFEST: [u8; include_bytes!("../manifest.json").len()] = *include_bytes!("../manifest.json");

#[cfg(target_arch = "wasm32")]
mod host {
    wit_bindgen::generate!({ world: "encryption-keys-host", path: "wit" });
}

const KEY_PATH: &str = "sphinx-box";
const KEY_LABEL: &[u8] = b"sphinx-x25519-v1";
const NEAR_AI_URL: &str = "https://cloud-api.near.ai/v1/chat/completions";
/// Thinking models spend tokens reasoning before they answer.
const MAX_TOKENS: u32 = 800;

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Pubkey,
    Ask {
        title: String,
        sealed_secret: String,
        question: String,
        model: Option<String>,
    },
    Settle {
        sealed_secret: String,
        secret_hash: String,
        sealed_floor: String,
        sealed_ceiling: String,
        deposit: String,
        buyer_public_key: String,
    },
}

fn main() {
    let mut input = String::new();
    let reply = match std::io::stdin().read_to_string(&mut input) {
        Ok(_) => handle(&input).unwrap_or_else(|e| json!({ "ok": false, "error": e })),
        Err(e) => json!({ "ok": false, "error": format!("stdin: {e}") }),
    };
    print!("{reply}");
}

fn handle(input: &str) -> Result<Value, String> {
    let request: Request = serde_json::from_str(input).map_err(|e| format!("bad request: {e}"))?;
    let secret_key = box_secret_key()?;
    match request {
        Request::Pubkey => Ok(json!({
            "ok": true,
            "public_key": B64.encode(secret_key.public_key().as_bytes()),
        })),
        Request::Ask { title, sealed_secret, question, model } => {
            if let Err(reason) = check_question(&question) {
                return Ok(json!({ "ok": true, "answer": "refused", "confidence": 0, "reason": reason }));
            }
            let model = choose_model(model.as_deref())?;
            let secret = open(&secret_key, &sealed_secret)?;
            let secret = String::from_utf8(secret).map_err(|_| "secret is not text".to_string())?;
            let reply = ask_model(model, &user_prompt(&title, &secret, &question))?;
            let verdict = parse_verdict(&reply);
            Ok(json!({
                "ok": true,
                "answer": verdict.answer,
                "confidence": verdict.confidence,
                "model": model,
            }))
        }
        Request::Settle { sealed_secret, secret_hash, sealed_floor, sealed_ceiling, deposit, buyer_public_key } => {
            let secret = open(&secret_key, &sealed_secret)?;
            if sha256_hex(&secret) != secret_hash.to_lowercase() {
                return Ok(json!({ "ok": true, "deal": false, "reason": "secret does not match the seller's committed hash" }));
            }
            let floor = parse_amount(&String::from_utf8(open(&secret_key, &sealed_floor)?).map_err(|_| "bad floor")?)?;
            let ceiling = parse_amount(&String::from_utf8(open(&secret_key, &sealed_ceiling)?).map_err(|_| "bad ceiling")?)?;
            let deposit = parse_amount(&deposit)?;
            match settle_price(floor, ceiling, deposit) {
                None => Ok(json!({ "ok": true, "deal": false, "reason": "the sealed limits do not overlap" })),
                Some(price) => {
                    let buyer_key = public_key_from_b64(&buyer_public_key)?;
                    let for_buyer = buyer_key.seal(&mut OsRng, &secret).map_err(|_| "could not seal for buyer")?;
                    Ok(json!({
                        "ok": true,
                        "deal": true,
                        "price": price.to_string(),
                        "sealed_for_buyer": B64.encode(for_buyer),
                    }))
                }
            }
        }
    }
}

fn open(secret_key: &SecretKey, sealed_b64: &str) -> Result<Vec<u8>, String> {
    let sealed = B64.decode(sealed_b64.trim()).map_err(|_| "sealed value is not base64".to_string())?;
    secret_key.unseal(&sealed).map_err(|_| "sealed value was not locked to this box".to_string())
}

fn public_key_from_b64(text: &str) -> Result<PublicKey, String> {
    let bytes = B64.decode(text.trim()).map_err(|_| "buyer key is not base64".to_string())?;
    let array: [u8; 32] = bytes.try_into().map_err(|_| "buyer key must be 32 bytes".to_string())?;
    Ok(PublicKey::from(array))
}

#[cfg(target_arch = "wasm32")]
fn box_secret_key() -> Result<SecretKey, String> {
    let seed = host::outlayer::encryption_keys::api::mac(KEY_PATH, None, KEY_LABEL)?;
    let array: [u8; 32] = seed.try_into().map_err(|_| "key derivation returned the wrong length".to_string())?;
    Ok(SecretKey::from(array))
}

#[cfg(not(target_arch = "wasm32"))]
fn box_secret_key() -> Result<SecretKey, String> {
    Err("the sealed box only runs inside OutLayer".into())
}

#[cfg(target_arch = "wasm32")]
fn ask_model(model: &str, prompt: &str) -> Result<String, String> {
    use std::time::Duration;
    use wasi_http_client::Client;

    let api_key = std::env::var("NEAR_AI_API_KEY").map_err(|_| "NEAR_AI_API_KEY secret is missing".to_string())?;
    let body = json!({
        "model": model,
        "temperature": 0,
        "max_tokens": MAX_TOKENS,
        "messages": [
            { "role": "system", "content": SYSTEM_PROMPT },
            { "role": "user", "content": prompt },
        ],
    })
    .to_string();
    let response = Client::new()
        .post(NEAR_AI_URL)
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {api_key}"))
        .connect_timeout(Duration::from_secs(15))
        .body(body.as_bytes())
        .send()
        .map_err(|e| format!("NEAR AI request failed: {e}"))?;
    let status = response.status();
    let bytes = response.body().map_err(|e| format!("NEAR AI body: {e}"))?;
    if status != 200 {
        return Err(format!("NEAR AI returned HTTP {status}"));
    }
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| "NEAR AI reply is not JSON".to_string())?;
    match parsed["choices"][0]["message"]["content"].as_str() {
        Some(text) if !text.trim().is_empty() => Ok(text.to_string()),
        _ => Err(format!(
            "NEAR AI reply has no answer (finish_reason: {})",
            parsed["choices"][0]["finish_reason"].as_str().unwrap_or("unknown")
        )),
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn ask_model(_model: &str, _prompt: &str) -> Result<String, String> {
    Err("the sealed box only runs inside OutLayer".into())
}
