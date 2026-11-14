import { useCallback, useEffect, useMemo, useState } from "react";
import { call, returnedValue, view, wallet, type Listing, type Question, type Sale } from "./near";
import {
  getOrCreateUnlockKey,
  nearToYocto,
  openSealed,
  ready,
  restoreUnlockKey,
  sealTo,
  sha256Hex,
  yoctoToNear,
} from "./seal";
import { ASK_DEPOSIT, CATEGORIES, CONTRACT_ID, EXPLORER, NETWORK, OUTLAYER_APP, RUN_FEE } from "./config";

type Route = { page: "market" } | { page: "sell" } | { page: "verify" } | { page: "listing"; id: number };

function parseRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h === "sell") return { page: "sell" };
  if (h === "verify") return { page: "verify" };
  const m = h.match(/^s\/(\d+)$/);
  if (m) return { page: "listing", id: Number(m[1]) };
  return { page: "market" };
}

const go = (hash: string) => {
  window.location.hash = hash;
};

const short = (a: string) => (a.length > 24 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a);
const categoryLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? id;

type Config = { box_public_key: string | null; project_id: string; listings: number; outlayer: string };

export default function App() {
  const [route, setRoute] = useState<Route>(parseRoute());
  const [account, setAccount] = useState<string | null>(null);
  const [config, setConfig] = useState<Config | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    ready();
    view<Config>("get_config").then(setConfig).catch(() => setConfig(null));
    wallet().then(({ selector }) => {
      const sync = () => setAccount(selector.store.getState().accounts.find((a) => a.active)?.accountId ?? null);
      sync();
      selector.store.observable.subscribe(sync);
    });
  }, []);

  const signIn = async () => (await wallet()).modal.show();
  const signOut = async () => {
    const { selector } = await wallet();
    await (await selector.wallet()).signOut();
  };

  return (
    <div className="shell">
      <header className="top">
        <a className="brand" href="#/">
          <SphinxMark />
          <span>Sphinx</span>
        </a>
        <nav>
          <a href="#/" className={route.page === "market" ? "on" : ""}>Market</a>
          <a href="#/sell" className={route.page === "sell" ? "on" : ""}>Sell a secret</a>
          <a href="#/verify" className={route.page === "verify" ? "on" : ""}>Verify</a>
        </nav>
        {account ? (
          <button className="ghost" onClick={signOut} title="Sign out">{short(account)}</button>
        ) : (
          <button onClick={signIn}>Sign in</button>
        )}
      </header>

      <main>
        {route.page === "market" && <Market />}
        {route.page === "sell" && <Sell account={account} config={config} signIn={signIn} />}
        {route.page === "verify" && <Verify config={config} />}
        {route.page === "listing" && <ListingPage id={route.id} account={account} signIn={signIn} />}
      </main>

      <footer>
        <span>{NETWORK === "mainnet" ? "NEAR mainnet" : "NEAR testnet"} · contract </span>
        <a href={`${EXPLORER}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">{short(CONTRACT_ID)}</a>
        <span> · sealed box on </span>
        <a href={OUTLAYER_APP} target="_blank" rel="noreferrer">OutLayer</a>
      </footer>
    </div>
  );
}

function SphinxMark() {
  return (
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden="true">
      <path d="M16 3 29 27H3Z" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="16" cy="18" r="3.2" fill="currentColor" />
    </svg>
  );
}

/* ---------------- Market ---------------- */

function Market() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    view<Listing[]>("get_listings", { limit: 50 })
      .then(setItems)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <>
      <section className="hero">
        <h1>Buy secrets you can trust before you see them.</h1>
        <p>
          Sellers lock research, findings and fixes inside a sealed box that no one can open, not even us.
          Buyers ask it yes-or-no questions, answered by a private AI running in secure hardware.
          Then both sides name a hidden price, and the deal settles in the middle, in one transaction.
        </p>
        <div className="row">
          <a className="button" href="#/sell">Seal a secret</a>
          <a className="button ghost" href="#/verify">How do I know it's sealed?</a>
        </div>
      </section>

      <section>
        <h2>On the market</h2>
        {error && <p className="error">Could not load listings: {error}</p>}
        {!items && !error && <p className="muted">Loading listings from NEAR…</p>}
        {items && items.length === 0 && (
          <div className="empty">
            <p>No sealed secrets yet.</p>
            <a className="button" href="#/sell">Be the first to seal one</a>
          </div>
        )}
        <div className="grid">
          {items?.map((l) => (
            <a key={l.id} className="card" href={`#/s/${l.id}`}>
              <div className="card-top">
                <span className="tag">{categoryLabel(l.category)}</span>
                <span className={`status s-${l.status.toLowerCase()}`}>{l.status}</span>
              </div>
              <h3>{l.title}</h3>
              <p>{l.pitch || "No public description."}</p>
              <div className="card-foot">
                <span>{l.questions} question{l.questions === 1 ? "" : "s"} asked</span>
                <span className="mono">#{l.secret_hash.slice(0, 10)}</span>
              </div>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

/* ---------------- Sell ---------------- */

function Sell({ account, config, signIn }: { account: string | null; config: Config | null; signIn: () => void }) {
  const [title, setTitle] = useState("");
  const [pitch, setPitch] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0].id);
  const [secret, setSecret] = useState("");
  const [floor, setFloor] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [hash, setHash] = useState("");

  useEffect(() => {
    sha256Hex(secret).then(setHash);
  }, [secret]);

  const submit = async () => {
    setMsg(null);
    if (!account) return signIn();
    if (!config?.box_public_key) return setMsg({ kind: "error", text: "The sealed box key is not published yet. Try again in a minute." });
    if (!title.trim()) return setMsg({ kind: "error", text: "Give your listing a title." });
    if (secret.trim().length < 20) return setMsg({ kind: "error", text: "The secret must be at least 20 characters." });
    let floorYocto: string;
    try {
      floorYocto = nearToYocto(floor);
    } catch (e) {
      return setMsg({ kind: "error", text: `Lowest price: ${(e as Error).message}` });
    }
    setBusy(true);
    try {
      const sealedSecret = sealTo(config.box_public_key, secret);
      const sealedFloor = sealTo(config.box_public_key, floorYocto);
      const bytes = title.length + pitch.length + category.length + sealedSecret.length + sealedFloor.length + 64 + 600;
      // 1e19 yoctoNEAR per byte of storage, plus 30% headroom; the contract refunds what it does not use.
      const deposit = ((BigInt(bytes) * 10n ** 19n * 13n) / 10n).toString();
      const outcome = await call(
        "list",
        { title, pitch, category, sealed_secret: sealedSecret, secret_hash: hash, sealed_floor: sealedFloor },
        deposit,
      );
      const id = returnedValue(outcome);
      setMsg({ kind: "ok", text: "Sealed and listed. Only the box can open it." });
      if (typeof id === "number") go(`#/s/${id}`);
    } catch (e) {
      setMsg({ kind: "error", text: (e as Error).message ?? "The transaction did not go through." });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="narrow">
      <h1>Seal a secret</h1>
      <p className="muted">
        Your secret and your lowest price are sealed in this browser to the box's public key before anything is sent.
        The contract only ever stores sealed bytes and a fingerprint.
      </p>

      <label>Title <span className="muted">(public)</span>
        <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Re-entrancy in a lending vault on Base" />
      </label>
      <label>What buyers see <span className="muted">(public)</span>
        <textarea value={pitch} maxLength={600} rows={3} onChange={(e) => setPitch(e.target.value)} placeholder="A working exploit path and a one-line fix. Affects one live vault." />
      </label>
      <label>Kind
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
        </select>
      </label>
      <label>The secret <span className="seal-note">sealed before sending</span>
        <textarea className="secret" value={secret} rows={8} maxLength={12000} onChange={(e) => setSecret(e.target.value)} placeholder="The full finding, dataset or answer." />
      </label>
      <div className="fingerprint">
        <span>Fingerprint (SHA-256), committed on-chain so buyers get exactly this:</span>
        <code>{secret ? hash : "—"}</code>
      </div>
      <label>Your lowest price in NEAR <span className="seal-note">sealed: buyers never see it</span>
        <input value={floor} inputMode="decimal" onChange={(e) => setFloor(e.target.value)} placeholder="2" />
      </label>

      <button disabled={busy} onClick={submit}>{busy ? "Sealing…" : account ? "Seal and list" : "Sign in to list"}</button>
      {msg && <p className={msg.kind === "ok" ? "ok" : "error"}>{msg.text}</p>}
    </section>
  );
}

/* ---------------- Listing ---------------- */

function ListingPage({ id, account, signIn }: { id: number; account: string | null; signIn: () => void }) {
  const [listing, setListing] = useState<Listing | null | undefined>(undefined);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [left, setLeft] = useState<number | null>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  const [config, setConfig] = useState<Config | null>(null);

  const load = useCallback(async () => {
    const [l, q, s, c] = await Promise.all([
      view<Listing | null>("get_listing", { listing_id: id }),
      view<Question[]>("get_questions", { listing_id: id }),
      view<Sale | null>("get_sale", { listing_id: id }),
      view<Config>("get_config"),
    ]);
    setListing(l);
    setQuestions(q);
    setSale(s);
    setConfig(c);
    if (account) setLeft(await view<number>("questions_left", { listing_id: id, account_id: account }));
  }, [id, account]);

  useEffect(() => {
    load().catch(() => setListing(null));
  }, [load]);

  // While anything is pending, refresh until the sealed box answers.
  const pending = listing?.status === "Settling" || questions.some((q) => q.answer === "pending");
  useEffect(() => {
    if (!pending) return;
    const t = setInterval(() => load().catch(() => {}), 5000);
    return () => clearInterval(t);
  }, [pending, load]);

  if (listing === undefined) return <p className="muted">Loading…</p>;
  if (listing === null) return <p className="error">There is no listing #{id}.</p>;

  const isSeller = account === listing.seller;
  const isBuyer = !!sale && account === sale.buyer;

  return (
    <section className="listing">
      <a href="#/" className="back">← Market</a>
      <div className="card-top">
        <span className="tag">{categoryLabel(listing.category)}</span>
        <span className={`status s-${listing.status.toLowerCase()}`}>{listing.status}</span>
      </div>
      <h1>{listing.title}</h1>
      <p className="lead">{listing.pitch}</p>
      <dl className="facts">
        <div><dt>Seller</dt><dd><a href={`${EXPLORER}/address/${listing.seller}`} target="_blank" rel="noreferrer">{short(listing.seller)}</a></dd></div>
        <div><dt>Fingerprint</dt><dd className="mono">{listing.secret_hash}</dd></div>
        <div><dt>Lowest price</dt><dd>Sealed. Only the box knows it.</dd></div>
        {listing.price && <div><dt>Sold for</dt><dd>{yoctoToNear(listing.price)} NEAR</dd></div>}
      </dl>

      <Oracle listing={listing} questions={questions} left={left} account={account} isSeller={isSeller} signIn={signIn} onAsked={load} />

      {listing.status === "Open" && !isSeller && (
        <Offer listing={listing} account={account} config={config} signIn={signIn} onSent={load} />
      )}
      {listing.status === "Settling" && (
        <div className="panel settling">
          <div className="pulse" />
          <p>The sealed box is comparing the two hidden prices. If they overlap, the seller is paid the middle price and the buyer gets the change back. Otherwise everything is refunded.</p>
        </div>
      )}
      {isBuyer && sale && <Unlock sale={sale} listing={listing} account={account!} />}
      {listing.status === "Sold" && !isBuyer && (
        <div className="panel"><p>Sold to {short(listing.buyer ?? "")} for {yoctoToNear(listing.price ?? "0")} NEAR. The secret was re-sealed to the buyer's own key.</p></div>
      )}
    </section>
  );
}

function Oracle(props: {
  listing: Listing;
  questions: Question[];
  left: number | null;
  account: string | null;
  isSeller: boolean;
  signIn: () => void;
  onAsked: () => Promise<void>;
}) {
  const { listing, questions, left, account, isSeller, signIn, onAsked } = props;
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const ask = async () => {
    setErr("");
    if (!account) return signIn();
    if (q.trim().length < 8) return setErr("Ask a full yes-or-no question.");
    setBusy(true);
    try {
      await call("ask", { listing_id: listing.id, question: q.trim() }, ASK_DEPOSIT);
      setQ("");
      await onAsked();
    } catch (e) {
      setErr((e as Error).message ?? "The question was not sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel oracle">
      <h2>Ask the Sphinx</h2>
      <p className="muted">
        A private model inside secure hardware reads the sealed secret and answers only yes, no, or refused, with a confidence score.
        Five questions per account. Each costs 0.02 NEAR; the unused part of the run fee is refunded.
      </p>
      <ol className="qa">
        {questions.length === 0 && <li className="muted">No questions yet.</li>}
        {questions.map((item, i) => (
          <li key={i}>
            <span className="q">{item.question}</span>
            <span className={`verdict v-${item.answer}`}>
              {item.answer === "pending" ? "the box is thinking…" : item.answer === "failed" ? "failed · not counted" : item.answer}
              {(item.answer === "yes" || item.answer === "no") && <small> {item.confidence}%</small>}
            </span>
          </li>
        ))}
      </ol>
      {listing.status === "Open" && !isSeller && (
        <div className="ask">
          <input value={q} maxLength={280} onChange={(e) => setQ(e.target.value)} placeholder="Does it describe a bug that can drain user funds?" onKeyDown={(e) => e.key === "Enter" && ask()} />
          <button disabled={busy || left === 0} onClick={ask}>{busy ? "Sending…" : account ? `Ask (${left ?? 5} left)` : "Sign in to ask"}</button>
        </div>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function Offer({ listing, account, config, signIn, onSent }: { listing: Listing; account: string | null; config: Config | null; signIn: () => void; onSent: () => Promise<void> }) {
  const [max, setMax] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const offer = async () => {
    setErr("");
    if (!account) return signIn();
    if (!config?.box_public_key) return setErr("The sealed box key is not published yet.");
    let maxYocto: string;
    try {
      maxYocto = nearToYocto(max);
    } catch (e) {
      return setErr((e as Error).message);
    }
    setBusy(true);
    try {
      const key = getOrCreateUnlockKey(account);
      const sealedCeiling = sealTo(config.box_public_key, maxYocto);
      const deposit = (BigInt(maxYocto) + BigInt(RUN_FEE)).toString();
      await call("buy", { listing_id: listing.id, sealed_ceiling: sealedCeiling, buyer_public_key: key.publicKey }, deposit);
      await onSent();
    } catch (e) {
      setErr((e as Error).message ?? "The offer was not sent.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel offer">
      <h2>Make a sealed offer</h2>
      <p className="muted">
        Enter the most you would pay. It is sealed to the box; the seller never sees it. If it is at least the seller's sealed lowest price,
        you pay exactly the middle of the two and get the rest back in the same transaction. If not, you are refunded in full and nobody learns either number.
      </p>
      <div className="ask">
        <input value={max} inputMode="decimal" onChange={(e) => setMax(e.target.value)} placeholder="Most you would pay, in NEAR" />
        <button disabled={busy} onClick={offer}>{busy ? "Sealing…" : account ? "Seal offer" : "Sign in to offer"}</button>
      </div>
      <p className="fine">You attach your maximum plus 0.01 NEAR for the sealed run, so the attached amount is visible on-chain; your true limit inside it is not.</p>
      {account && (
        <p className="fine">
          The secret will be sealed to an unlock key kept in this browser.{" "}
          <a href="#" onClick={(e) => { e.preventDefault(); downloadUnlockKey(account); }}>Download a backup of your unlock key</a> before you buy.
        </p>
      )}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function downloadUnlockKey(account: string) {
  const key = getOrCreateUnlockKey(account);
  const blob = new Blob([JSON.stringify(key, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `sphinx-unlock-key-${account}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function Unlock({ sale, listing, account }: { sale: Sale; listing: Listing; account: string }) {
  const [text, setText] = useState<string | null>(null);
  const [verified, setVerified] = useState<boolean | null>(null);
  const [err, setErr] = useState("");

  const key = useMemo(() => {
    try {
      return getOrCreateUnlockKey(account);
    } catch {
      return null;
    }
  }, [account]);

  const open = async () => {
    setErr("");
    try {
      if (!key) throw new Error("No unlock key in this browser.");
      const plain = openSealed(sale.sealed_for_buyer, key);
      setText(plain);
      setVerified((await sha256Hex(plain)) === listing.secret_hash);
    } catch {
      setErr("This browser does not hold the key this secret was sealed to. Restore your key backup.");
    }
  };

  const restore = async (file: File | undefined) => {
    if (!file) return;
    try {
      restoreUnlockKey(account, await file.text());
      setErr("");
      await open();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="panel unlock">
      <h2>Your secret</h2>
      <p className="muted">Paid {yoctoToNear(sale.price)} NEAR. The box re-sealed the secret to a key that exists only in your browser.</p>
      {text === null ? (
        <button onClick={open}>Open with my key</button>
      ) : (
        <>
          <pre className="secret-out">{text}</pre>
          <p className={verified ? "ok" : "error"}>
            {verified ? "Fingerprint matches the seller's commitment: this is exactly what was listed." : "Fingerprint does NOT match the listing."}
          </p>
        </>
      )}
      {err && <p className="error">{err}</p>}
      <details>
        <summary>Restore an unlock key backup</summary>
        <input type="file" accept="application/json" onChange={(e) => restore(e.target.files?.[0])} />
      </details>
    </div>
  );
}

/* ---------------- Verify ---------------- */

function Verify({ config }: { config: Config | null }) {
  return (
    <section className="narrow verify">
      <h1>Don't trust us. Check.</h1>
      <ol className="steps">
        <li>
          <h3>The box's key never leaves secure hardware</h3>
          <p>
            The box's private key is derived inside OutLayer's Intel TDX enclave from an encryption key bound to this project and to the
            Sphinx contract as caller. Anything sealed to the public key below can only be opened by a run the contract starts.
          </p>
          <code className="block">{config?.box_public_key ?? "loading…"}</code>
        </li>
        <li>
          <h3>The code that runs is fixed</h3>
          <p>
            OutLayer runs project <code>{config?.project_id ?? "…"}</code>. Each version is a WebAssembly file named by its SHA-256, and every
            execution has a TEE attestation you can open on OutLayer. The source is in the repository under <code>enclave/</code>.
          </p>
          <a href={`${OUTLAYER_APP}/executions`} target="_blank" rel="noreferrer">Open OutLayer executions →</a>
        </li>
        <li>
          <h3>Only attested models ever see a secret</h3>
          <p>
            Questions go to NEAR AI Cloud models that run inside TEEs and publish attestation reports (DeepSeek V4.1 Flash by default).
            The box refuses any other model, so a secret never reaches a third-party API.
          </p>
        </li>
        <li>
          <h3>Nothing but yes, no or refused comes out</h3>
          <p>
            The box turns the model's reply into one of three words and a number. Anything else becomes "refused", so even a tricked
            model cannot leak text. Five questions per account cap what any buyer can learn.
          </p>
        </li>
        <li>
          <h3>The swap is one transaction</h3>
          <p>
            The contract pauses, the box opens both sealed prices and re-seals the secret to the buyer, and the contract resumes: it pays
            the seller and refunds the buyer's change, or refunds everything. The buyer checks the secret against the listed fingerprint.
          </p>
        </li>
      </ol>
    </section>
  );
}
