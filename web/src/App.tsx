import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  Terminal,
  Fingerprint,
  KeyRound,
  Lock,
  Moon,
  ShieldAlert,
  ShieldCheck,
  Sun,
  Upload,
} from "lucide-react";
import { call, returnedValue, view, wallet, type Listing, type Question, type Sale } from "./near";
import { checkReceipt, type Receipt, type ReceiptCheck } from "./receipt";
import {
  getOrCreateUnlockKey,
  nearToYocto,
  openSealed,
  ready,
  restoreUnlockKey,
  sealFor,
  sha256Hex,
  yoctoToNear,
} from "./seal";
import { ASK_DEPOSIT, CATEGORIES, CONTRACT_ID, EXPLORER, NETWORK, OUTLAYER_APP, RUN_FEE } from "./config";

type Route = { page: "landing" } | { page: "market" } | { page: "sell" } | { page: "verify" } | { page: "listing"; id: number };

function parseRoute(): Route {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h === "market") return { page: "market" };
  if (h === "sell") return { page: "sell" };
  if (h === "verify") return { page: "verify" };
  const m = h.match(/^s\/(\d+)$/);
  if (m) return { page: "listing", id: Number(m[1]) };
  return { page: "landing" };
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
    const onHash = () => {
      setRoute(parseRoute());
      window.scrollTo({ top: 0 });
    };
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
        <a className="brand" href="#/" aria-label="Sphinx, back to the market">
          <img src={LOGO_SMALL} alt="" width={36} height={36} />
          <span>Sphinx</span>
        </a>
        <nav aria-label="Main">
          <a href="#/market" aria-current={route.page === "market" || route.page === "listing" ? "page" : undefined}>Market</a>
          <a href="#/sell" aria-current={route.page === "sell" ? "page" : undefined}>Sell a secret</a>
          <a href="#/verify" aria-current={route.page === "verify" ? "page" : undefined}>Verify</a>
        </nav>
        <div className="top-actions">
          <ThemeToggle />
          {account ? (
            <button className="quiet" onClick={signOut} title="Sign out">{short(account)}</button>
          ) : (
            <button onClick={signIn}>Sign in</button>
          )}
        </div>
      </header>

      <main>
        {route.page === "landing" && <Landing />}
        {route.page === "market" && <Market />}
        {route.page === "sell" && <Sell account={account} config={config} signIn={signIn} />}
        {route.page === "verify" && <Verify config={config} />}
        {route.page === "listing" && <ListingPage id={route.id} account={account} signIn={signIn} />}
      </main>

      <footer>
        <span>{NETWORK === "mainnet" ? "NEAR mainnet" : "NEAR testnet"}</span>
        <span>
          Contract{" "}
          <a href={`${EXPLORER}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">{short(CONTRACT_ID)}</a>
        </span>
        <span>
          Sealed box on <a href={OUTLAYER_APP} target="_blank" rel="noreferrer">OutLayer</a>
        </span>
        <span>
          <a href="https://github.com/Jennivarl/sphinx" target="_blank" rel="noreferrer">Source</a>
        </span>
      </footer>
    </div>
  );
}

const LOGO_SMALL = `${import.meta.env.BASE_URL}logo-128.png`;
const LOGO_LARGE = `${import.meta.env.BASE_URL}logo-512.png`;

/** PC and phone render separate layouts, so changing one never moves the other. */
function useIsDesktop() {
  const query = "(min-width: 961px)";
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return desktop;
}

type Theme = "light" | "dark";

function systemTheme(): Theme {
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const set = document.documentElement.dataset.theme;
    return set === "light" || set === "dark" ? set : systemTheme();
  });
  const flip = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("sphinx.theme", next);
    } catch {
      /* the choice just lasts for this visit */
    }
    setTheme(next);
  };
  return (
    <button className="icon-button" onClick={flip} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`} title="Switch theme">
      {theme === "dark" ? <Sun size={16} strokeWidth={1.5} /> : <Moon size={16} strokeWidth={1.5} />}
    </button>
  );
}

/**
 * A listing's seal: its SHA-256 fingerprint drawn as a ring of 64 marks, one
 * per hex digit. Every secret gets a different seal, and anyone can redraw it
 * from the fingerprint on-chain.
 */
function Seal({ hash, size = 200, state = "open" }: { hash: string; size?: number; state?: "open" | "sold" }) {
  const marks = useMemo(() => {
    const digits = (hash || "").padEnd(64, "0").slice(0, 64);
    return [...digits].map((d, i) => {
      const v = parseInt(d, 16) || 0;
      const angle = (i / 64) * Math.PI * 2 - Math.PI / 2;
      const r1 = 52;
      const r2 = r1 + 8 + v * 2.4;
      return {
        x1: 100 + Math.cos(angle) * r1,
        y1: 100 + Math.sin(angle) * r1,
        x2: 100 + Math.cos(angle) * r2,
        y2: 100 + Math.sin(angle) * r2,
        strong: v >= 10,
      };
    });
  }, [hash]);
  return (
    <svg className={`seal seal-${state}`} viewBox="0 0 200 200" width={size} height={size} aria-hidden="true">
      <g className="seal-ring">
        {marks.map((m, i) => (
          <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} className={m.strong ? "mark strong" : "mark"} />
        ))}
      </g>
      <circle cx="100" cy="100" r="45" className="seal-core" />
      <image href={LOGO_SMALL} x="57" y="57" width="86" height="86" className="seal-medal" />
    </svg>
  );
}

/* ---------------- Landing ---------------- */

type Showcase = { listing: Listing; question: Question; receipt: Receipt } | null;

/** The landing page shows real on-chain data: a live answer with its receipt and a real sale. */
function Landing() {
  const [open, setOpen] = useState<Listing | null>(null);
  const [sold, setSold] = useState<Listing | null>(null);
  const [showcase, setShowcase] = useState<Showcase>(null);

  useEffect(() => {
    view<Listing[]>("get_listings", { limit: 50 })
      .then(async (all) => {
        setOpen(all.find((l) => l.status === "Open") ?? null);
        setSold(all.find((l) => l.status === "Sold" && l.price) ?? null);
        for (const l of all.filter((x) => x.questions > 0)) {
          const [qs, rs] = await Promise.all([
            view<Question[]>("get_questions", { listing_id: l.id }),
            view<(Receipt | null)[]>("get_receipts", { listing_id: l.id }).catch(() => []),
          ]);
          const i = qs.findIndex((q, k) => (q.answer === "yes" || q.answer === "no") && rs[k]);
          if (i >= 0) return setShowcase({ listing: l, question: qs[i], receipt: rs[i]! });
        }
      })
      .catch(() => {});
  }, []);

  const demoHref = open ? `#/s/${open.id}` : "#/market";

  return (
    <div className="landing">
      <section className="tile tile-hero">
        <img className="tile-hero-medal" src={LOGO_LARGE} alt="The Sphinx seal" width={300} height={300} />
        <h1>Sphinx</h1>
        <p className="tile-sub">Buy secrets you can trust before you see them</p>
        <p className="tile-note">Sealed secrets on NEAR, questioned by an attested AI</p>
        <div className="tile-actions">
          <a className="pill-button" href="#/market">Open the market</a>
          <a className="pill-button outline" href="#/sell">Seal a secret</a>
        </div>
      </section>

      <section className="tile tile-dark">
        <h2>The sealed box</h2>
        <p className="tile-sub">A secret goes in and nobody can open it</p>
        <p className="tile-note">Not the buyer, not the operator, not us. It runs inside Intel TDX on OutLayer, called by a contract on NEAR mainnet.</p>
        <div className="tile-actions">
          <a className="pill-button" href="#/verify">See how it's verified</a>
          <a className="pill-button outline" href="https://github.com/Jennivarl/sphinx" target="_blank" rel="noreferrer">Read the code</a>
        </div>
        <img className="tile-product" src={`${import.meta.env.BASE_URL}sealed-box.jpg`} alt="A sealed obsidian box with a gold seam and seal" width={1536} height={1024} />
      </section>

      <section className="tile tile-light">
        <h2>Ask the Sphinx</h2>
        <p className="tile-sub">Yes or no, signed by the AI's own hardware</p>
        <p className="tile-note">An attested NEAR AI model reads the sealed secret and answers only yes, no or refused. Each answer carries a signature anyone can check.</p>
        <div className="tile-actions">
          <a className="pill-button" href={demoHref}>Ask a demo listing</a>
          <a className="pill-button outline" href="#/verify">Learn more</a>
        </div>
        <div className="answer-card" aria-label="A real answer from the market">
          {showcase ? (
            <>
              <span className="answer-from">From listing #{showcase.listing.id} · {showcase.listing.title}</span>
              <p className="answer-q">{showcase.question.question}</p>
              <div className="answer-row">
                <span className={`answer-verdict v-${showcase.question.answer}`}>{showcase.question.answer}</span>
                <span className="muted">{confidenceLabel(showcase.question.confidence)}</span>
              </div>
              {showcase.question.model && <ReceiptBadge model={showcase.question.model} receipt={showcase.receipt} />}
            </>
          ) : (
            <span className="muted">Loading a real answer from NEAR…</span>
          )}
        </div>
      </section>

      <section className="tile tile-surface">
        <h2>Name your price, keep it secret</h2>
        <p className="tile-sub">Both sides seal a price and the box settles between them</p>
        <p className="tile-note">If the sealed prices overlap, the deal lands at a hidden random point between them and the secret is re-sealed to the buyer, all in one transaction. If not, everyone is refunded.</p>
        <div className="tile-actions">
          <a className="pill-button" href={demoHref}>Make an offer</a>
          <a className="pill-button outline" href="#/market">Browse the market</a>
        </div>
        <div className="settle" aria-label="How a sealed price settles">
          <div className="settle-track">
            <span className="settle-end"><Lock size={16} strokeWidth={1.5} /> Seller's lowest<small>sealed</small></span>
            <span className="settle-line"><span className="settle-dot" /></span>
            <span className="settle-end right"><Lock size={16} strokeWidth={1.5} /> Buyer's highest<small>sealed</small></span>
          </div>
          <p className="settle-result">
            {sold?.price ? (
              <>Settled at <strong className="num">{yoctoToNear(sold.price)} NEAR</strong> on listing #{sold.id}. Neither limit was ever revealed.</>
            ) : (
              "Neither limit is ever revealed."
            )}
          </p>
        </div>
      </section>

      <section className="tile-grid">
        <a className="grid-tile" href="https://github.com/Jennivarl/sphinx/tree/main/agent" target="_blank" rel="noreferrer">
          <h3>Built for agents</h3>
          <p>AI agents browse, ask, check receipts and buy through the Sphinx MCP server, with a spending limit.</p>
          <pre className="grid-code">{"list_secrets\nask_secret\nmake_offer\nopen_secret"}</pre>
          <span className="grid-link">Agent kit <ArrowUpRight size={16} strokeWidth={1.5} /></span>
        </a>
        <a className="grid-tile" href="#/verify">
          <h3>Sealed to its owner</h3>
          <p>Every secret and price is sealed with its owner's account, so a copied seal is refused.</p>
          <div className="grid-seal"><Seal hash={showcase?.listing.secret_hash ?? open?.secret_hash ?? ""} size={150} /></div>
          <span className="grid-link">How sealing works <ArrowUpRight size={16} strokeWidth={1.5} /></span>
        </a>
        <a className="grid-tile" href="#/verify">
          <h3>Answers that hold up</h3>
          <p>A trap scan blocks secrets that try to steer the AI, and every question is asked twice, once reversed.</p>
          <div className="grid-pair"><span className="answer-verdict v-yes">yes</span><ArrowLeftRight className="grid-arrow" size={22} strokeWidth={1.5} /><span className="answer-verdict v-no">no</span></div>
          <span className="grid-link">The checks <ArrowUpRight size={16} strokeWidth={1.5} /></span>
        </a>
        <a className="grid-tile" href="https://github.com/Jennivarl/sphinx" target="_blank" rel="noreferrer">
          <h3>Open and on-chain</h3>
          <p>Contract, sealed box, website and agent kit are open source. Every step is a NEAR transaction.</p>
          <img className="grid-medal" src={LOGO_SMALL} alt="" width={96} height={96} />
          <span className="grid-link">GitHub <ArrowUpRight size={16} strokeWidth={1.5} /></span>
        </a>
      </section>
    </div>
  );
}

/* ---------------- Market ---------------- */

type Filter = "Open" | "Sold" | "All";

const isOpen = (l: Listing) => l.status === "Open" || l.status === "Settling";

function Market() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [error, setError] = useState("");
  const desktop = useIsDesktop();

  useEffect(() => {
    view<Listing[]>("get_listings", { limit: 50 })
      .then((all) => setItems(all.filter((l) => l.status !== "Closed")))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return desktop ? <MarketWide items={items} error={error} /> : <MarketCompact items={items} error={error} />;
}

/* ----- PC: wide, OpenSea-style: categories, featured row, ranked list ----- */

function MarketWide({ items, error }: { items: Listing[] | null; error: string }) {
  const [category, setCategory] = useState<string>("all");
  const [filter, setFilter] = useState<"Open" | "Sold">("Open");
  const inCategory = (items ?? []).filter((l) => category === "all" || l.category === category);
  const featured = [...inCategory].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.id - a.id).slice(0, 4);
  const ranked = inCategory
    .filter((l) => (filter === "Open" ? isOpen(l) : l.status === "Sold"))
    .sort((a, b) => b.questions - a.questions || b.id - a.id);

  return (
    <div className="wide-market">
      <header className="market-title">
        <h1>Market</h1>
        <p className="lead">Sealed secrets you can question before you buy, every answer signed by the AI's secure hardware</p>
      </header>

      <div className="categories" role="tablist" aria-label="Kind of secret">
        {[{ id: "all", label: "All" }, ...CATEGORIES].map((c) => (
          <button key={c.id} role="tab" aria-selected={category === c.id} className={category === c.id ? "pill on" : "pill"} onClick={() => setCategory(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      {error && <p className="error">Could not load listings: {error}</p>}
      {!items && !error && <div className="featured">{[0, 1, 2, 3].map((i) => <div key={i} className="feature skeleton" />)}</div>}
      {items && featured.length === 0 && (
        <div className="empty">
          <p>No sealed secrets of this kind yet.</p>
          <a className="button" href="#/sell">Seal one</a>
        </div>
      )}
      <div className="featured">
        {featured.map((l) => (
          <a key={l.id} className="feature" href={`#/s/${l.id}`}>
            <Seal hash={l.secret_hash} size={220} state={l.status === "Sold" ? "sold" : "open"} />
            <div className="feature-caption">
              <strong>{l.title}</strong>
              <span>
                <Status status={l.status} /> · {categoryLabel(l.category)} · {l.status === "Sold" && l.price ? <span className="num">{yoctoToNear(l.price)} NEAR</span> : `${l.questions} question${l.questions === 1 ? "" : "s"}`}
              </span>
            </div>
          </a>
        ))}
      </div>

      <section className="ranked" aria-labelledby="ranked-title">
        <div className="ranked-head">
          <div className="ranked-tabs" role="tablist" aria-label="Open or sold">
            <h2 id="ranked-title" className="sr-only">Listings</h2>
            {(["Open", "Sold"] as const).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "big-tab on" : "big-tab"} onClick={() => setFilter(f)}>
                {f === "Open" ? "Most asked" : "Recently sold"}
              </button>
            ))}
          </div>
          <a className="button quiet" href="#/sell">Seal a secret</a>
        </div>
        <div className="ranked-cols" role="row" aria-hidden="true">
          <span>#</span><span>Secret</span><span className="r-num">Questions</span><span className="r-num">{filter === "Open" ? "Status" : "Price"}</span>
        </div>
        {ranked.length === 0 && items && <p className="muted ranked-empty">{filter === "Open" ? "Nothing open in this kind right now." : "Nothing sold in this kind yet."}</p>}
        <ol className="ranked-list">
          {ranked.map((l, i) => (
            <li key={l.id}>
              <a href={`#/s/${l.id}`}>
                <span className="rank num">{i + 1}</span>
                <span className="thumb"><Seal hash={l.secret_hash} size={52} state={l.status === "Sold" ? "sold" : "open"} /></span>
                <span className="r-title">
                  <strong>{l.title}</strong>
                  <small>
                    {categoryLabel(l.category)}
                    {l.seller === CONTRACT_ID && <span className="demo">Demo</span>}
                  </small>
                </span>
                <span className="r-num num">{l.questions}</span>
                <span className="r-num">{l.status === "Sold" && l.price ? <span className="num">{yoctoToNear(l.price)} NEAR</span> : <Status status={l.status} />}</span>
              </a>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

/* ----- Phone and tablet: stacked hero, card grid ----- */

function MarketCompact({ items, error }: { items: Listing[] | null; error: string }) {
  const [filter, setFilter] = useState<Filter>("Open");

  const counts = useMemo(() => {
    const list = items ?? [];
    return { Open: list.filter(isOpen).length, Sold: list.filter((l) => l.status === "Sold").length, All: list.length };
  }, [items]);

  const shown = (items ?? []).filter((l) => (filter === "All" ? true : filter === "Sold" ? l.status === "Sold" : isOpen(l)));

  return (
    <>
      <header className="market-title">
        <h1>Market</h1>
        <p className="lead">Sealed secrets you can question before you buy</p>
      </header>

      <section className="market" aria-labelledby="market-title">
        <div className="market-head">
          <h2 id="market-title" className="sr-only">Listings</h2>
          <div className="tabs" role="tablist" aria-label="Filter listings">
            {(["Open", "Sold", "All"] as Filter[]).map((f) => (
              <button key={f} role="tab" aria-selected={filter === f} className={filter === f ? "tab on" : "tab"} onClick={() => setFilter(f)}>
                {f} <span className="count">{items ? counts[f] : "·"}</span>
              </button>
            ))}
          </div>
        </div>
        {error && <p className="error">Could not load listings: {error}</p>}
        {!items && !error && (
          <div className="grid" aria-busy="true">
            {[0, 1, 2].map((i) => <div key={i} className="card skeleton" />)}
          </div>
        )}
        {items && shown.length === 0 && (
          <div className="empty">
            <p>{filter === "Sold" ? "Nothing has sold yet." : "No sealed secrets are open right now."}</p>
            <a className="button" href="#/sell">Seal one</a>
          </div>
        )}
        <div className="grid">
          {shown.map((l) => (
            <a key={l.id} className="card" href={`#/s/${l.id}`}>
              <div className="card-art">
                <Seal hash={l.secret_hash} size={150} state={l.status === "Sold" ? "sold" : "open"} />
              </div>
              <div className="card-body">
                <div className="card-meta">
                  <Status status={l.status} />
                  <span>{categoryLabel(l.category)}</span>
                  {l.seller === CONTRACT_ID && <span className="demo" title="Example listed by the Sphinx team to show the flow">Demo</span>}
                </div>
                <h3>{l.title}</h3>
                <p>{l.pitch || "No public description."}</p>
              </div>
              <div className="card-foot">
                <span>{l.questions} question{l.questions === 1 ? "" : "s"} asked</span>
                {l.status === "Sold" && l.price ? (
                  <span className="num">Sold {yoctoToNear(l.price)} NEAR</span>
                ) : (
                  <span className="hash">#{l.secret_hash.slice(0, 8)}</span>
                )}
              </div>
            </a>
          ))}
        </div>
      </section>
    </>
  );
}

/** Status as a coloured word, the way a store marks a product, not a chip. */
function Status({ status }: { status: Listing["status"] }) {
  return <span className={`state s-${status.toLowerCase()}`}>{status === "Settling" ? "Settling" : status}</span>;
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
      const sealedSecret = sealFor(config.box_public_key, account, secret);
      const sealedFloor = sealFor(config.box_public_key, account, floorYocto);
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
    <section className="sell">
      <div className="sell-intro">
        <h1>Seal a secret</h1>
        <p className="lead">
          Your secret and your lowest price are sealed in this browser to the box's public key before anything is sent. The
          contract only ever stores sealed bytes and a fingerprint.
        </p>
        <div className="sell-seal">
          <Seal hash={secret ? hash : ""} size={180} />
          <p className="fine">{secret ? "Your secret's seal, drawn from its fingerprint." : "Your seal appears as you type."}</p>
        </div>
      </div>

      <div className="form">
        <label>
          Title <span className="hint">public</span>
          <input value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="Re-entrancy in a lending vault on Base" />
        </label>
        <label>
          What buyers see <span className="hint">public</span>
          <textarea value={pitch} maxLength={600} rows={3} onChange={(e) => setPitch(e.target.value)} placeholder="A working exploit path and a one-line fix. Affects one live vault." />
        </label>
        <label>
          Kind
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </label>
        <label>
          The secret <span className="hint sealed"><Lock size={16} strokeWidth={1.5} /> sealed before sending</span>
          <textarea className="secret" value={secret} rows={8} maxLength={12000} onChange={(e) => setSecret(e.target.value)} placeholder="The full finding, dataset or answer." />
        </label>
        <div className="fingerprint">
          <span>Fingerprint (SHA-256), committed on-chain so buyers get exactly this</span>
          <code>{secret ? hash : "—"}</code>
        </div>
        <label>
          Your lowest price in NEAR <span className="hint sealed"><Lock size={16} strokeWidth={1.5} /> sealed: buyers never see it</span>
          <input value={floor} inputMode="decimal" onChange={(e) => setFloor(e.target.value)} placeholder="2" />
        </label>

        <button className="wide" disabled={busy} onClick={submit}>{busy ? "Sealing…" : account ? "Seal and list" : "Sign in to list"}</button>
        {msg && <p className={msg.kind === "ok" ? "ok" : "error"} role="status">{msg.text}</p>}
      </div>
    </section>
  );
}

/* ---------------- Listing ---------------- */

function ListingPage({ id, account, signIn }: { id: number; account: string | null; signIn: () => void }) {
  const [listing, setListing] = useState<Listing | null | undefined>(undefined);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [receipts, setReceipts] = useState<(Receipt | null)[]>([]);
  const [left, setLeft] = useState<number | null>(null);
  const [sale, setSale] = useState<Sale | null>(null);
  const [config, setConfig] = useState<Config | null>(null);

  const load = useCallback(async () => {
    const [l, q, s, c, r] = await Promise.all([
      view<Listing | null>("get_listing", { listing_id: id }),
      view<Question[]>("get_questions", { listing_id: id }),
      view<Sale | null>("get_sale", { listing_id: id }),
      view<Config>("get_config"),
      view<(Receipt | null)[]>("get_receipts", { listing_id: id }).catch(() => []),
    ]);
    setListing(l);
    setQuestions(q);
    setReceipts(r);
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

  if (listing === undefined) return <p className="muted loading">Loading listing #{id} from NEAR…</p>;
  if (listing === null) return <p className="error">There is no listing #{id}.</p>;

  const isSeller = account === listing.seller;
  const isBuyer = !!sale && account === sale.buyer;
  const isDemo = listing.seller === CONTRACT_ID;

  return (
    <section className="listing">
      <a href="#/market" className="back"><ArrowLeft size={16} strokeWidth={1.5} /> Market</a>
      <div className="listing-grid">
        <aside className="listing-side">
          <div className="art">
            <Seal hash={listing.secret_hash} size={300} state={listing.status === "Sold" ? "sold" : "open"} />
          </div>
          <dl className="facts">
            <div>
              <dt>Seller</dt>
              <dd><a href={`${EXPLORER}/address/${listing.seller}`} target="_blank" rel="noreferrer">{short(listing.seller)}</a></dd>
            </div>
            <div>
              <dt><Fingerprint size={16} strokeWidth={1.5} /> Fingerprint</dt>
              <dd className="hash">{listing.secret_hash}</dd>
            </div>
            <div>
              <dt><Lock size={16} strokeWidth={1.5} /> Lowest price</dt>
              <dd>Sealed. Only the box knows it.</dd>
            </div>
            {listing.price && (
              <div>
                <dt>Sold for</dt>
                <dd className="num">{yoctoToNear(listing.price)} NEAR</dd>
              </div>
            )}
          </dl>
        </aside>

        <div className="listing-main">
          <div className="listing-meta">
            <span>{categoryLabel(listing.category)}</span>
            {isDemo && <span className="demo">Demo</span>}
            <Status status={listing.status} />
          </div>
          <h1>{listing.title}</h1>
          <p className="lead">{listing.pitch}</p>
          {isDemo && (
            <p className="fine">
              Demo listing: an example sealed by the Sphinx team so you can try asking and buying. The flow, the sealed box and every
              transaction are real.
            </p>
          )}

          <Oracle listing={listing} questions={questions} receipts={receipts} left={left} account={account} isSeller={isSeller} signIn={signIn} onAsked={load} />

          {listing.status === "Open" && !isSeller && (
            <Offer listing={listing} account={account} config={config} signIn={signIn} onSent={load} />
          )}
          {listing.status === "Settling" && (
            <div className="panel settling" role="status">
              <span className="pulse" aria-hidden="true" />
              <p>
                The sealed box is comparing the two hidden prices. If they overlap, the seller is paid a price at a hidden point between them
                and the buyer gets the change back. Otherwise everything is refunded.
              </p>
            </div>
          )}
          {isBuyer && sale && <Unlock sale={sale} listing={listing} account={account!} />}
          {listing.status === "Sold" && !isBuyer && (
            <div className="panel sold-note">
              <p>
                Sold to {short(listing.buyer ?? "")} for <span className="num">{yoctoToNear(listing.price ?? "0")} NEAR</span>. The secret was
                re-sealed to the buyer's own key.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function Oracle(props: {
  listing: Listing;
  questions: Question[];
  receipts: (Receipt | null)[];
  left: number | null;
  account: string | null;
  isSeller: boolean;
  signIn: () => void;
  onAsked: () => Promise<void>;
}) {
  const { listing, questions, receipts, left, account, isSeller, signIn, onAsked } = props;
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
        A private model inside secure hardware reads the sealed secret and answers only yes, no, or refused, with a confidence level.
        Every answer must survive the reversed question, and a secret that tries to steer the AI is never answered. Five questions per
        account, thirty per listing. Each costs 0.02 NEAR; the unused part of the run fee is refunded.
      </p>
      <ol className="qa">
        {questions.length === 0 && <li className="none">No questions yet. Be the first to ask.</li>}
        {questions.map((item, i) => (
          <li key={i}>
            <span className="q">{item.question}</span>
            <span className={`verdict v-${item.answer}`}>
              {item.answer === "pending" ? "the box is thinking…" : item.answer === "failed" ? "failed · not counted" : item.answer}
              {(item.answer === "yes" || item.answer === "no") && <small>{confidenceLabel(item.confidence)}</small>}
            </span>
            {receipts[i] && item.model && <ReceiptBadge model={item.model} receipt={receipts[i]} />}
          </li>
        ))}
      </ol>
      {listing.status === "Open" && !isSeller && (
        <div className="ask">
          <input
            value={q}
            maxLength={280}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Does it describe a bug that can drain user funds?"
            aria-label="Your yes-or-no question"
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <button disabled={busy || left === 0} onClick={ask}>{busy ? "Sending…" : account ? `Ask (${left ?? 5} left)` : "Sign in to ask"}</button>
        </div>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

function Offer({ listing, account, config, signIn, onSent }: { listing: Listing; account: string | null; config: Config | null; signIn: () => void; onSent: () => Promise<void> }) {
  const [max, setMax] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [offersLeft, setOffersLeft] = useState<number | null>(null);
  const [storage, setStorage] = useState<string>("0");

  useEffect(() => {
    view<string>("sale_storage", { listing_id: listing.id }).then(setStorage).catch(() => setStorage("0"));
    if (account) view<number>("offers_left", { listing_id: listing.id, account_id: account }).then(setOffersLeft).catch(() => {});
  }, [listing.id, account]);

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
      const sealedCeiling = sealFor(config.box_public_key, account, maxYocto);
      const deposit = (BigInt(maxYocto) + BigInt(RUN_FEE) + BigInt(storage)).toString();
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
        you pay a price at a hidden random point between the two (25% to 75% of the way up) and get the rest back in the same transaction.
        If not, you are refunded in full and nobody learns either number. Three offers per account.
      </p>
      <div className="ask">
        <div className="amount">
          <input value={max} inputMode="decimal" onChange={(e) => setMax(e.target.value)} placeholder="Most you would pay" aria-label="Most you would pay, in NEAR" />
          <span aria-hidden="true">NEAR</span>
        </div>
        <button disabled={busy || offersLeft === 0} onClick={offer}>
          {busy ? "Sealing…" : account ? `Seal offer (${offersLeft ?? 3} left)` : "Sign in to offer"}
        </button>
      </div>
      <p className="fine">
        You attach your maximum, plus 0.01 NEAR for the sealed run, plus {yoctoToNear(storage)} NEAR to store the sale (refunded if there is
        no deal). The attached amount is visible on-chain; your true limit inside it is not.
      </p>
      {account && (
        <p className="fine key-note">
          <KeyRound size={16} strokeWidth={1.5} />
          <span>
            The secret will be sealed to an unlock key kept in this browser.{" "}
            <a href="#" onClick={(e) => { e.preventDefault(); downloadUnlockKey(account); }}>Download a backup of your unlock key</a> before you buy.
          </span>
        </p>
      )}
      {err && <p className="error" role="alert">{err}</p>}
    </div>
  );
}

const RECEIPT_LABEL: Record<ReceiptCheck, string> = {
  checking: "checking the AI's signature…",
  verified: "signed inside NEAR AI's secure hardware",
  unlisted: "signed by NEAR AI (key since rotated)",
  "signature-only": "NEAR AI signature valid",
  invalid: "signature does not check out",
};

/** Checks, in this browser, that NEAR AI's TEE signed the exchange behind an
 *  answer and that the signing key is in the model's attestation report. */
function ReceiptBadge({ model, receipt }: { model: string; receipt: Receipt }) {
  const [state, setState] = useState<ReceiptCheck>("checking");
  useEffect(() => {
    checkReceipt(model, receipt).then(setState);
  }, [model, receipt]);
  const key = `${receipt.signing_address.slice(0, 6)}…${receipt.signing_address.slice(-4)}`;
  const Icon = state === "invalid" ? ShieldAlert : ShieldCheck;
  return (
    <small className={`receipt r-${state}`} title={`Model ${model}\nCompletion ${receipt.chat_id}\nSigner ${receipt.signing_address}`}>
      {state !== "checking" && <Icon size={16} strokeWidth={1.5} aria-hidden="true" />}
      <span>{RECEIPT_LABEL[state]}</span>
      <span className="hash">key {key}</span>
    </small>
  );
}

function confidenceLabel(confidence: number) {
  return confidence >= 100 ? "high confidence" : confidence >= 70 ? "medium confidence" : "low confidence";
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
      <p className="muted">
        Paid <span className="num">{yoctoToNear(sale.price)} NEAR</span>. The box re-sealed the secret to a key that exists only in your browser.
      </p>
      {text === null ? (
        <button onClick={open}><KeyRound size={16} strokeWidth={1.5} /> Open with my key</button>
      ) : (
        <>
          <pre className="secret-out">{text}</pre>
          <p className={verified ? "ok with-icon" : "error with-icon"}>
            {verified ? <Check size={16} strokeWidth={1.5} /> : <ShieldAlert size={16} strokeWidth={1.5} />}
            {verified ? "Fingerprint matches the seller's commitment: this is exactly what was listed." : "Fingerprint does NOT match the listing."}
          </p>
        </>
      )}
      {err && <p className="error" role="alert">{err}</p>}
      <details>
        <summary><Upload size={16} strokeWidth={1.5} /> Restore an unlock key backup</summary>
        <input type="file" accept="application/json" onChange={(e) => restore(e.target.files?.[0])} />
      </details>
    </div>
  );
}

/* ---------------- Verify ---------------- */

function Verify({ config }: { config: Config | null }) {
  return (
    <section className="verify">
      <header className="verify-head">
        <h1>Don't trust us, check</h1>
        <p className="lead">Eight guarantees, and where each one is enforced. Every one of them can be checked without asking us.</p>
      </header>
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
          <a className="link" href={`${OUTLAYER_APP}/executions`} target="_blank" rel="noreferrer">
            Open OutLayer executions <ArrowUpRight size={16} strokeWidth={1.5} />
          </a>
        </li>
        <li>
          <h3>A sealed value only works where it was made</h3>
          <p>
            Every secret and every hidden price is sealed together with its owner's account. The box opens a value only for the account the
            contract says owns it, so a sealed secret copied into someone else's listing, or a hidden price copied into someone else's offer,
            is refused.
          </p>
        </li>
        <li>
          <h3>Only attested models ever see a secret</h3>
          <p>
            Questions go to NEAR AI Cloud models that run inside TEEs and publish attestation reports (DeepSeek V4.1 Flash by default).
            The box refuses any other model, so a secret never reaches a third-party API.
          </p>
        </li>
        <li>
          <h3>Every answer is signed by the AI's secure hardware</h3>
          <p>
            For each answer the box keeps the exact bytes it sent to NEAR AI and the exact reply, and fetches NEAR AI's signature over
            their SHA-256 hashes, made by a key that lives inside the model's TEE. The contract stores that receipt next to the question
            (<code>get_receipts</code>). This page recovers the signer from the signature and checks it against the key in the model's
            live attestation report, so you do not have to trust us that a real attested model answered. The hashes reveal nothing about
            the secret or the question.
          </p>
        </li>
        <li>
          <h3>Nothing but yes, no or refused comes out</h3>
          <p>
            The box turns the model's reply into yes, no or refused plus a coarse confidence level (low, medium or high). Anything else becomes
            "refused", so even a tricked model cannot leak text. Five questions per account and thirty per listing cap what anyone can learn.
          </p>
        </li>
        <li>
          <h3>Answers have to hold up</h3>
          <p>
            Before answering, the box checks whether the secret tries to give the AI instructions, and refuses if it does. Every question is
            then asked twice, once reversed: if the two answers do not flip, the answer is withheld. A seller cannot plant "always say yes".
          </p>
        </li>
        <li>
          <h3>The swap is one transaction</h3>
          <p>
            The contract pauses, the box opens both sealed prices, picks a random point between them (25% to 75% of the way up, so the price
            does not reveal either limit) and re-seals the secret to the buyer, and the contract resumes: it pays the seller and refunds the
            buyer's change, or refunds everything. Each account gets three offers per listing. The buyer checks the secret against the listed fingerprint.
          </p>
        </li>
      </ol>
      <p className="fine verify-foot">
        <Terminal size={16} strokeWidth={1.5} /> Prefer the command line? <code>node scripts/verify-answers.mjs &lt;listing&gt;</code> in the{" "}
        <a href="https://github.com/Jennivarl/sphinx" target="_blank" rel="noreferrer">repository</a> checks every receipt from public data.
      </p>
    </section>
  );
}
