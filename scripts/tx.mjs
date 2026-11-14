// Prints a short, readable outcome of a NEAR testnet transaction.
// Usage: node tx.mjs <tx_hash> <sender_account_id>
const [hash, sender] = process.argv.slice(2);
const RPC = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";

const res = await fetch(RPC, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "EXPERIMENTAL_tx_status",
    params: { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" },
  }),
});
const json = await res.json();
if (json.error) {
  console.log("RPC error:", JSON.stringify(json.error).slice(0, 300));
  process.exit(1);
}
const r = json.result;
const actions = r.transaction.actions.map((a) => (typeof a === "string" ? a : Object.keys(a)[0]));
const method = r.transaction.actions[0]?.FunctionCall?.method_name;
console.log(`tx ${hash} -> ${r.transaction.receiver_id} ${actions.join(",")}${method ? " " + method : ""}`);
for (const o of r.receipts_outcome) {
  const s = o.outcome.status;
  let status = Object.keys(s)[0];
  if (s.SuccessValue) {
    const text = Buffer.from(s.SuccessValue, "base64").toString("utf8");
    status = `SuccessValue ${text.slice(0, 400)}`;
  } else if (s.Failure) {
    status = `Failure ${JSON.stringify(s.Failure).slice(0, 400)}`;
  }
  console.log(`  ${o.outcome.executor_id}: ${status}`);
  for (const log of o.outcome.logs) console.log(`    log: ${log.slice(0, 300)}`);
}
