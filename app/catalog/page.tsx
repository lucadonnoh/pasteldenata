import Link from "next/link";

import { CatalogDirectory } from "@/components/catalog-directory";
import { publicCatalogForPlanner } from "@/src/catalog";

export default function CatalogPage() {
  const listings = publicCatalogForPlanner();

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
          <Link className="mode-link" href="/">
            Buyer
          </Link>
          <Link className="mode-link" href="/seller">
            Seller
          </Link>
          <div className="network-status">
            <span className="network-dot" />
            {listings.length} mock listings
          </div>
        </div>
      </header>

      <main>
        <CatalogDirectory listings={listings} />
      </main>
    </div>
  );
}
