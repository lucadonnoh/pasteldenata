import Link from "next/link";

import { MarketWorkspace } from "@/components/market-workspace";

import styles from "./market.module.css";

export default function MarketPage() {
  return (
    <div className="app-shell">
      <div className="ambient-field" aria-hidden="true">
        <i className="ambient-blue" />
        <i className="ambient-violet" />
        <i className="ambient-mint" />
      </div>

      <header className="site-header">
        <Link className="wordmark" href="/" aria-label="Pastel home">
          <span className="wordmark-symbol">
            <i />
          </span>
          <span className="wordmark-type">pastel</span>
        </Link>

        <div className="header-actions">
          <Link className="mode-link" href="/catalog">
            Catalog
          </Link>
          <Link className="mode-link" href="/">
            New intent
          </Link>
          <div className="network-status">
            <span className="network-dot" />
            Private market
          </div>
        </div>
      </header>

      <main className={styles.marketMain}>
        <MarketWorkspace />
      </main>
    </div>
  );
}
