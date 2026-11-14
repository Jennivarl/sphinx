import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Fingerprint,
  Home,
  KeyRound,
  Lock,
  Moon,
  PlusCircle,
  Search,
  ShieldAlert,
  ShieldCheck,
  Store,
  Sun,
  Terminal,
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

type Route = { page: "landing" } | { page: "market"; q: string } | { page: "sell" } | { page: "verify" } | { page: "listing"; id: number };

function parseRoute(): Route {
  const [h, query = ""] = window.location.hash.replace(/^#\/?/, "").split("?");
  if (h === "market") return { page: "market", q: new URLSearchParams(query).get("q") ?? "" };
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
const isOpen = (l: Listing) => l.status === "Open" || l.status === "Settling";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Config = { box_public_key: string | null; project_id: string; listings: number; outlayer: string };

const LOGO_SMALL = `${import.meta.env.BASE_URL}logo-128.png`;
const LOGO_DARK_SMALL = `${import.meta.env.BASE_URL}logo-dark-128.png`;
const BOX_IMAGE = `${import.meta.env.BASE_URL}sealed-box.jpg`;
const REPO = "https://github.com/Jennivarl/sphinx";

/** The Sphinx mark, an eye whose pupil is a keyhole: drawn in ink on light, in cream on dark. */
function Mark({ size }: { size: number }) {
  return (
    <span className="mark" style={{ width: size, height: size }} aria-hidden="true">
      <img className="mark-light" src={LOGO_SMALL} alt="" width={size} height={size} />
      <img className="mark-dark" src={LOGO_DARK_SMALL} alt="" width={size} height={size} />
    </span>
  );
}

/** Listings, loaded once per page. */
function useListings() {
  const [items, setItems] = useState<Listing[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    view<Listing[]>("get_listings", { limit: 50 })
      .then((all) => setItems(all.filter((l) => l.status !== "Closed")))
      .catch((e) => setError(String(e.message ?? e)));
  }, []);
  return { items, error };
}

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
  const accountButton = account ? (
    <button className="quiet" onClick={signOut} title="Sign out">{short(account)}</button>
  ) : (
    <button onClick={signIn}>Sign in</button>
  );

  if (route.page === "landing") return <Landing accountButton={accountButton} />;

  const page = route.page;
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="#/" aria-label="Sphinx home">
          <Mark size={36} />
          <span>Sphinx</span>
        </a>
        <AppNav page={page} />
        <div className="sidebar-foot">
          <div className="sidebar-account">
            <ThemeToggle />
            {accountButton}
          </div>
          <div className="promo">
            <strong>Sealed by hardware</strong>
            <p>Secrets open only inside Intel TDX. Every answer is signed by NEAR AI's secure hardware.</p>
          </div>
        </div>
      </aside>

      <header className="topbar">
        <a className="brand" href="#/" aria-label="Sphinx home">
          <Mark size={32} />
          <span>Sphinx</span>
        </a>
        <div className="topbar-actions">
          <ThemeToggle />
          {accountButton}
        </div>
        <AppNav page={page} />
      </header>

      <main className="main">
        <div className="column">
          {route.page === "market" && <Market q={route.q} />}
          {route.page === "sell" && <Sell account={account} config={config} signIn={signIn} />}
          {route.page === "verify" && <Verify config={config} />}
          {route.page === "listing" && <ListingPage id={route.id} account={account} signIn={signIn} />}
          <footer className="app-foot">
            <span>{NETWORK === "mainnet" ? "NEAR mainnet" : "NEAR testnet"}</span>
            <span>Contract <a href={`${EXPLORER}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">{short(CONTRACT_ID)}</a></span>
            <span>Sealed box on <a href={OUTLAYER_APP} target="_blank" rel="noreferrer">OutLayer</a></span>
            <a href={REPO} target="_blank" rel="noreferrer">Source</a>
          </footer>
        </div>
      </main>
    </div>
  );
}

function AppNav({ page }: { page: Route["page"] }) {
  const items = [
    { href: "#/", label: "Home", icon: Home, on: false },
    { href: "#/market", label: "Market", icon: Store, on: page === "market" || page === "listing" },
    { href: "#/sell", label: "Sell a secret", icon: PlusCircle, on: page === "sell" },
    { href: "#/verify", label: "Verify", icon: ShieldCheck, on: page === "verify" },
  ];
  return (
    <nav className="app-nav" aria-label="Main">
      {items.map(({ href, label, icon: Icon, on }) => (
        <a key={href} href={href} className={on ? "on" : undefined} aria-current={on ? "page" : undefined}>
          <Icon size={18} strokeWidth={1.5} aria-hidden="true" />
          <span>{label}</span>
        </a>
      ))}
    </nav>
  );
}

type Theme = "light" | "dark";

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const set = document.documentElement.dataset.theme;
    return set === "dark" ? "dark" : "light";
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
      {theme === "dark" ? <Sun size={18} strokeWidth={1.5} /> : <Moon size={18} strokeWidth={1.5} />}
    </button>
  );
}

/**
 * A listing's seal: its SHA-256 fingerprint drawn as a ring of 64 marks, one
 * per hex digit, around the Sphinx medallion. Anyone can redraw it from the
 * fingerprint on-chain.
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
          <line key={i} x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} className={m.strong ? "tick strong" : "tick"} />
        ))}
      </g>
      <circle cx="100" cy="100" r="45" className="seal-core" />
      <image href={LOGO_SMALL} x="60" y="60" width="80" height="80" className="seal-medal mark-light" />
      <image href={LOGO_DARK_SMALL} x="60" y="60" width="80" height="80" className="seal-medal mark-dark" />
    </svg>
  );
}

/** Status as a small filled tag, like a paid stamp on an invoice. */
function Status({ status }: { status: Listing["status"] }) {
  return <span className={`badge b-${status.toLowerCase()}`}>{status}</span>;
}

/** One listing as a row: seal, title and details, then the figure that matters. */
function ListingRow({ l }: { l: Listing }) {
  const sold = l.status === "Sold";
  return (
    <a className="row-item" href={`#/s/${l.id}`}>
      <span className="row-seal"><Seal hash={l.secret_hash} size={56} state={sold ? "sold" : "open"} /></span>
      <span className="row-main">
        <strong>{l.title}</strong>
        <small>
          {categoryLabel(l.category)}
          {l.seller === CONTRACT_ID ? " · Demo" : ""} · {plural(l.questions, "question")} asked
        </small>
      </span>
      <span className="row-end">
        {sold && l.price ? (
          <span className="row-value num">{yoctoToNear(l.price)} <em>NEAR</em></span>
        ) : (
          <span className="row-value sealed"><Lock size={14} strokeWidth={1.75} aria-hidden="true" /> Sealed</span>
        )}
        <Status status={l.status} />
      </span>
    </a>
  );
}

/* ---------------- Landing: tiles drifting through space around a calm centre ---------------- */

type Tile = { kind: "seal" | "medal" | "box" | "yes" | "no" | "lock" | "price"; x: number; z: number; s: number; d: number; delay: number; rx: number; ry: number; rz: number; hash: string };

/** A fixed, seeded field of tiles, so the scene is the same on every visit. */
function makeTiles(count: number, seed: number): Tile[] {
  let t = seed;
  const rnd = () => {
    t = (t * 1664525 + 1013904223) % 4294967296;
    return t / 4294967296;
  };
  const kinds: Tile["kind"][] = ["seal", "medal", "seal", "box", "yes", "seal", "lock", "price", "seal", "no", "medal", "seal"];
  return Array.from({ length: count }, (_, i) => {
    // Keep the middle third clear for the words.
    const side = i % 2 === 0 ? rnd() * 0.36 : 0.64 + rnd() * 0.36;
    const hash = Array.from({ length: 64 }, () => Math.floor(rnd() * 16).toString(16)).join("");
    return {
      kind: kinds[i % kinds.length],
      x: side * 100,
      z: Math.round(-420 + rnd() * 520),
      s: Math.round(52 + rnd() * 52),
      d: Math.round(22 + rnd() * 26),
      delay: -Math.round(rnd() * 48),
      rx: Math.round(-28 + rnd() * 56),
      ry: Math.round(-34 + rnd() * 68),
      rz: Math.round(-30 + rnd() * 60),
      hash,
    };
  });
}

function TileFace({ tile }: { tile: Tile }) {
  switch (tile.kind) {
    case "seal":
      return <Seal hash={tile.hash} size={tile.s} />;
    case "medal":
      return <Mark size={Math.round(tile.s * 0.7)} />;
    case "box":
      return <img src={BOX_IMAGE} alt="" className="tile-photo" />;
    case "yes":
      return <span className="tile-word v-yes">Yes</span>;
    case "no":
      return <span className="tile-word v-no">No</span>;
    case "lock":
      return <Lock size={Math.round(tile.s * 0.4)} strokeWidth={1.5} />;
    case "price":
      return <span className="tile-word num">0.045</span>;
  }
}

function Field({ count, seed }: { count: number; seed: number }) {
  const tiles = useMemo(() => makeTiles(count, seed), [count, seed]);
  return (
    <div className="field" aria-hidden="true">
      {tiles.map((tile, i) => (
        <span
          key={i}
          className={`tile tile-${tile.kind}`}
          style={{
            "--x": `${tile.x}%`, "--z": `${tile.z}px`, "--s": `${tile.s}px`, "--d": `${tile.d}s`, "--delay": `${tile.delay}s`,
            "--rx": `${tile.rx}deg`, "--ry": `${tile.ry}deg`, "--rz": `${tile.rz}deg`,
          } as CSSProperties}
        >
          <TileFace tile={tile} />
        </span>
      ))}
    </div>
  );
}

/** A search that opens the market filtered to the words typed. */
function SearchPill() {
  const [q, setQ] = useState("");
  return (
    <form
      className="search-pill"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        go(q.trim() ? `#/market?q=${encodeURIComponent(q.trim())}` : "#/market");
      }}
    >
      <Search size={16} strokeWidth={1.5} aria-hidden="true" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Try 'slippage bug in a swap router'" aria-label="Search sealed secrets" />
    </form>
  );
}

/** One row of names that drifts sideways and fades out at both edges. */
function Marquee({ items, reverse = false }: { items: string[]; reverse?: boolean }) {
  return (
    <div className={reverse ? "marquee reverse" : "marquee"} aria-label={items.join(", ")}>
      <div className="marquee-track" aria-hidden="true">
        {[...items, ...items].map((name, i) => <span key={i}>{name}</span>)}
      </div>
    </div>
  );
}

type Showcase = { listing: Listing; question: Question; receipt: Receipt } | null;

function Landing({ accountButton }: { accountButton: ReactNode }) {
  const { items } = useListings();
  const [showcase, setShowcase] = useState<Showcase>(null);

  useEffect(() => {
    if (!items) return;
    (async () => {
      for (const l of items.filter((x) => x.questions > 0)) {
        const [qs, rs] = await Promise.all([
          view<Question[]>("get_questions", { listing_id: l.id }),
          view<(Receipt | null)[]>("get_receipts", { listing_id: l.id }).catch(() => []),
        ]);
        const i = qs.findIndex((q, k) => (q.answer === "yes" || q.answer === "no") && rs[k]);
        if (i >= 0) return setShowcase({ listing: l, question: qs[i], receipt: rs[i]! });
      }
    })().catch(() => {});
  }, [items]);

  const open = (items ?? []).filter(isOpen);
  const sold = (items ?? []).filter((l) => l.status === "Sold");
  const demoHref = open[0] ? `#/s/${open[0].id}` : "#/market";

  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="brand" href="#/" aria-label="Sphinx home">
          <Mark size={32} />
          <span>Sphinx</span>
        </a>
        <nav aria-label="Main">
          <a href="#/market">Market</a>
          <a href="#/sell">Sell a secret</a>
          <a href="#/verify">Verify</a>
        </nav>
        <SearchPill />
        <div className="landing-actions">
          <ThemeToggle />
          <span className="landing-account">{accountButton}</span>
          <a className="pill-ink" href="#/market">Open the market</a>
        </div>
      </header>

      <section className="space">
        <Field count={44} seed={7} />
        <div className="space-copy">
          <h1>Buy secrets you can trust before you see them</h1>
          <p>Ask a sealed secret yes or no. An attested AI answers from secure hardware, then you name a hidden price</p>
          <div className="space-actions">
            <a className="button" href="#/market">Open the market</a>
            <a className="text-link" href="#/sell">Seal a secret <ArrowRight size={16} strokeWidth={1.5} /></a>
          </div>
        </div>
      </section>

      <section className="stack">
        <h2>Built on the stack that keeps secrets sealed</h2>
        <Marquee items={["NEAR Protocol", "OutLayer", "NEAR AI Cloud", "Intel TDX", "Model Context Protocol", "libsodium", "Rust", "WebAssembly"]} />
        <Marquee reverse items={["Security researchers", "Smart contract auditors", "On-chain analysts", "Trading agents", "Bug bounty hunters", "Data sellers", "Research desks", "AI agents"]} />
      </section>

      <section className="chapter">
        <h2>Every secret stays sealed</h2>
        <div className="product-frame">
          <div className="product-window">
            <div className="product-bar">
              <span>Market</span>
              <span className="muted">{plural(open.length, "open secret")} · {sold.length} sold</span>
            </div>
            <div className="rows">
              {(items ?? []).slice(0, 4).map((l) => <ListingRow key={l.id} l={l} />)}
              {!items && <p className="muted">Loading listings from NEAR…</p>}
            </div>
          </div>
        </div>
        <p className="chapter-note">Findings, research and fixes, sealed in your browser.<br />Questioned, priced and sold without being shown.</p>
      </section>

      <section className="chapter split">
        <h2 className="split-title">Know what you're buying</h2>
        <figure className="split-figure">
          <img src={BOX_IMAGE} alt="A sealed obsidian box with a gold seam" />
          {showcase && (
            <figcaption className="answer-float">
              <span className="af-label">Asked the Sphinx · listing #{showcase.listing.id}</span>
              <span className="answer-q">{showcase.question.question}</span>
              <span className="af-verdict">
                <span className={`answer-verdict v-${showcase.question.answer}`}>{showcase.question.answer}</span>
                <span className={`badge b-${showcase.question.answer}`}>{confidenceLabel(showcase.question.confidence)}</span>
              </span>
              {showcase.question.model && <span className="af-receipt"><ReceiptBadge model={showcase.question.model} receipt={showcase.receipt} /></span>}
            </figcaption>
          )}
        </figure>
        <p className="split-note">Sphinx asks an attested NEAR AI model about the secret, inside secure hardware. Every answer comes back signed, so you can check it yourself.</p>
      </section>

      <section className="chapter">
        <h2>How it works</h2>
        <ol className="how">
          <li><span className="how-n">1</span><div><strong>Seal it</strong><p>The seller's browser seals the secret and a lowest price to the box. The contract keeps only ciphertext and a fingerprint.</p></div></li>
          <li><span className="how-n">2</span><div><strong>Ask it</strong><p>Buyers ask yes or no. A trap scan and a reversed question keep the answers honest, and each one is signed.</p></div></li>
          <li><span className="how-n">3</span><div><strong>Price it secretly</strong><p>Both sides seal a price. If they overlap, the deal lands at a hidden point between them.</p></div></li>
          <li><span className="how-n">4</span><div><strong>Swap it fairly</strong><p>The secret is re-sealed to the buyer and the seller is paid in one transaction, or everyone is refunded.</p></div></li>
        </ol>
        <div className="how-links">
          <a href="#/verify">See how it's verified <ArrowUpRight size={16} strokeWidth={1.5} /></a>
          <a href={`${REPO}/tree/main/agent`} target="_blank" rel="noreferrer">Agent kit for AI agents <ArrowUpRight size={16} strokeWidth={1.5} /></a>
          <a href={REPO} target="_blank" rel="noreferrer">Source on GitHub <ArrowUpRight size={16} strokeWidth={1.5} /></a>
        </div>
      </section>

      <section className="space space-end">
        <Field count={36} seed={23} />
        <div className="space-copy">
          <p className="space-kicker">Ask the Sphinx</p>
          <a className="button big" href={demoHref}>Try a demo listing</a>
          <a className="text-link" href="#/market">Browse the market</a>
        </div>
      </section>

      <footer className="landing-foot">
        <div className="landing-foot-links">
          <span>{NETWORK === "mainnet" ? "NEAR mainnet" : "NEAR testnet"}</span>
          <a href={`${EXPLORER}/address/${CONTRACT_ID}`} target="_blank" rel="noreferrer">Contract</a>
          <a href={OUTLAYER_APP} target="_blank" rel="noreferrer">OutLayer</a>
          <a href={REPO} target="_blank" rel="noreferrer">Source</a>
        </div>
      </footer>
    </div>
  );
}

/* ---------------- Market ---------------- */

function Market({ q }: { q: string }) {
  const { items, error } = useListings();
  const [category, setCategory] = useState<string>("all");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (l: Listing) => {
    const text = `${l.title} ${l.pitch} ${categoryLabel(l.category)}`.toLowerCase();
    return words.every((w) => text.includes(w));
  };
  const inCategory = (items ?? []).filter((l) => (category === "all" || l.category === category) && matches(l));
  const open = inCategory.filter(isOpen).sort((a, b) => b.questions - a.questions || b.id - a.id);
  const sold = inCategory.filter((l) => l.status === "Sold");
  const allOpen = (items ?? []).filter(isOpen).length;
  const allSold = (items ?? []).filter((l) => l.status === "Sold");
  const settled = allSold.reduce((sum, l) => sum + BigInt(l.price ?? "0"), 0n);

  return (
    <>
      <section className="summary">
        <div className="summary-label">
          <span>Secrets on the market</span>
          <span className="tag">NEAR · mainnet</span>
        </div>
        <p className="figure num">{items ? allOpen : "–"} <span>open</span></p>
        <p className="summary-meta">{allSold.length} sold · {yoctoToNear(settled)} NEAR settled · every answer signed</p>
      </section>
      <div className="actions">
        <a className="big-button primary" href="#/sell">Seal a secret</a>
        <a className="big-button secondary" href="#/verify">How it works</a>
      </div>

      {q && (
        <p className="search-note">
          Showing secrets matching <strong>"{q}"</strong> · <a href="#/market">Clear</a>
        </p>
      )}
      <div className="filters" role="tablist" aria-label="Kind of secret">
        {[{ id: "all", label: "All" }, ...CATEGORIES].map((c) => (
          <button key={c.id} role="tab" aria-selected={category === c.id} className={category === c.id ? "filter on" : "filter"} onClick={() => setCategory(c.id)}>
            {c.label}
          </button>
        ))}
      </div>

      {error && <p className="error">Could not load listings: {error}</p>}
      <section className="block">
        <h2>Open</h2>
        {!items && !error && <div className="rows">{[0, 1].map((i) => <div key={i} className="row-item skeleton" />)}</div>}
        {items && open.length === 0 && <p className="empty-line">Nothing open in this kind right now. <a href="#/sell">Seal one</a></p>}
        <div className="rows">{open.map((l) => <ListingRow key={l.id} l={l} />)}</div>
      </section>
      <section className="block">
        <h2>Sold</h2>
        {items && sold.length === 0 && <p className="empty-line">Nothing sold in this kind yet.</p>}
        <div className="rows">{sold.map((l) => <ListingRow key={l.id} l={l} />)}</div>
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
    <>
      <section className="page-head">
        <h1>Seal a secret</h1>
        <p className="lead">
          Your secret and your lowest price are sealed in this browser to the box's public key before anything is sent. The contract only
          ever stores sealed bytes and a fingerprint.
        </p>
      </section>

      <div className="card form">
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
          The secret <span className="hint"><Lock size={16} strokeWidth={1.5} /> sealed before sending</span>
          <textarea className="secret" value={secret} rows={8} maxLength={12000} onChange={(e) => setSecret(e.target.value)} placeholder="The full finding, dataset or answer." />
        </label>
        <div className="fingerprint">
          <Seal hash={secret ? hash : ""} size={64} />
          <div>
            <span>Fingerprint (SHA-256), committed on-chain so buyers get exactly this</span>
            <code>{secret ? hash : "Appears as you type"}</code>
          </div>
        </div>
        <label>
          Your lowest price in NEAR <span className="hint"><Lock size={16} strokeWidth={1.5} /> sealed: buyers never see it</span>
          <input value={floor} inputMode="decimal" onChange={(e) => setFloor(e.target.value)} placeholder="2" />
        </label>

        <button className="big-button primary wide" disabled={busy} onClick={submit}>{busy ? "Sealing…" : account ? "Seal and list" : "Sign in to list"}</button>
        {msg && <p className={msg.kind === "ok" ? "ok" : "error"} role="status">{msg.text}</p>}
      </div>
    </>
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
    <>
      <a href="#/market" className="back"><ArrowLeft size={16} strokeWidth={1.5} /> Market</a>
      <header className="listing-head">
        <span className="listing-seal"><Seal hash={listing.secret_hash} size={112} state={listing.status === "Sold" ? "sold" : "open"} /></span>
        <div>
          <div className="listing-meta">
            <span>{categoryLabel(listing.category)}</span>
            {isDemo && <span>Demo</span>}
            <span>#{listing.id}</span>
            <Status status={listing.status} />
          </div>
          <h1>{listing.title}</h1>
        </div>
      </header>
      <p className="lead">{listing.pitch}</p>
      {isDemo && (
        <p className="fine">
          Demo listing: an example sealed by the Sphinx team so you can try asking and buying. The flow, the sealed box and every
          transaction are real.
        </p>
      )}

      <dl className="facts">
        <div>
          <dt>Seller</dt>
          <dd><a href={`${EXPLORER}/address/${listing.seller}`} target="_blank" rel="noreferrer">{short(listing.seller)}</a></dd>
        </div>
        <div>
          <dt><Lock size={16} strokeWidth={1.5} /> Lowest price</dt>
          <dd>Sealed. Only the box knows it.</dd>
        </div>
        <div>
          <dt>{listing.price ? "Sold for" : "Questions"}</dt>
          <dd className="num">{listing.price ? `${yoctoToNear(listing.price)} NEAR` : `${listing.questions} of 30`}</dd>
        </div>
        <div className="wide-fact">
          <dt><Fingerprint size={16} strokeWidth={1.5} /> Fingerprint</dt>
          <dd className="hash">{listing.secret_hash}</dd>
        </div>
      </dl>

      <Oracle listing={listing} questions={questions} receipts={receipts} left={left} account={account} isSeller={isSeller} signIn={signIn} onAsked={load} />

      {listing.status === "Open" && !isSeller && (
        <Offer listing={listing} account={account} config={config} signIn={signIn} onSent={load} />
      )}
      {listing.status === "Settling" && (
        <div className="panel settling" role="status">
          <span className="pulse" aria-hidden="true" />
          <p>
            The sealed box is comparing the two hidden prices. If they overlap, the seller is paid a price at a hidden point between them and
            the buyer gets the change back. Otherwise everything is refunded.
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
    </>
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
    <>
      <section className="page-head">
        <h1>Don't trust us, check</h1>
        <p className="lead">Eight guarantees, and where each one is enforced. Every one of them can be checked without asking us.</p>
      </section>
      <ol className="how verify-list">
        <li>
          <span className="how-n">1</span>
          <div>
            <h3>The box's key never leaves secure hardware</h3>
            <p>
              The box's private key is derived inside OutLayer's Intel TDX enclave from an encryption key bound to this project and to the
              Sphinx contract as caller. Anything sealed to the public key below can only be opened by a run the contract starts.
            </p>
            <code className="block">{config?.box_public_key ?? "loading…"}</code>
          </div>
        </li>
        <li>
          <span className="how-n">2</span>
          <div>
            <h3>The code that runs is fixed</h3>
            <p>
              OutLayer runs project <code>{config?.project_id ?? "…"}</code>. Each version is a WebAssembly file named by its SHA-256, and every
              execution has a TEE attestation you can open on OutLayer. The source is in the repository under <code>enclave/</code>.
            </p>
            <a className="link" href={`${OUTLAYER_APP}/executions`} target="_blank" rel="noreferrer">
              Open OutLayer executions <ArrowUpRight size={16} strokeWidth={1.5} />
            </a>
          </div>
        </li>
        <li>
          <span className="how-n">3</span>
          <div>
            <h3>A sealed value only works where it was made</h3>
            <p>
              Every secret and every hidden price is sealed together with its owner's account. The box opens a value only for the account the
              contract says owns it, so a sealed secret copied into someone else's listing, or a hidden price copied into someone else's offer,
              is refused.
            </p>
          </div>
        </li>
        <li>
          <span className="how-n">4</span>
          <div>
            <h3>Only attested models ever see a secret</h3>
            <p>
              Questions go to NEAR AI Cloud models that run inside TEEs and publish attestation reports (DeepSeek V4.1 Flash by default). The
              box refuses any other model, so a secret never reaches a third-party API.
            </p>
          </div>
        </li>
        <li>
          <span className="how-n">5</span>
          <div>
            <h3>Every answer is signed by the AI's secure hardware</h3>
            <p>
              For each answer the box keeps the exact bytes it sent to NEAR AI and the exact reply, and fetches NEAR AI's signature over their
              SHA-256 hashes, made by a key that lives inside the model's TEE. The contract stores that receipt next to the question
              (<code>get_receipts</code>). This page recovers the signer from the signature and checks it against the key in the model's live
              attestation report, so you do not have to trust us that a real attested model answered. The hashes reveal nothing about the
              secret or the question.
            </p>
          </div>
        </li>
        <li>
          <span className="how-n">6</span>
          <div>
            <h3>Nothing but yes, no or refused comes out</h3>
            <p>
              The box turns the model's reply into yes, no or refused plus a coarse confidence level (low, medium or high). Anything else
              becomes "refused", so even a tricked model cannot leak text. Five questions per account and thirty per listing cap what anyone
              can learn.
            </p>
          </div>
        </li>
        <li>
          <span className="how-n">7</span>
          <div>
            <h3>Answers have to hold up</h3>
            <p>
              Before answering, the box checks whether the secret tries to give the AI instructions, and refuses if it does. Every question is
              then asked twice, once reversed: if the two answers do not flip, the answer is withheld. A seller cannot plant "always say yes".
            </p>
          </div>
        </li>
        <li>
          <span className="how-n">8</span>
          <div>
            <h3>The swap is one transaction</h3>
            <p>
              The contract pauses, the box opens both sealed prices, picks a random point between them (25% to 75% of the way up, so the price
              does not reveal either limit) and re-seals the secret to the buyer, and the contract resumes: it pays the seller and refunds the
              buyer's change, or refunds everything. Each account gets three offers per listing. The buyer checks the secret against the
              listed fingerprint.
            </p>
          </div>
        </li>
      </ol>
      <p className="fine verify-foot">
        <Terminal size={16} strokeWidth={1.5} /> Prefer the command line? <code>node scripts/verify-answers.mjs &lt;listing&gt;</code> in the{" "}
        <a href={REPO} target="_blank" rel="noreferrer">repository</a> checks every receipt from public data.
      </p>
    </>
  );
}
