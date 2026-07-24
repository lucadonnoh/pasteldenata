import { SellerStudio } from "@/components/seller-studio";
import Link from "next/link";

export default function SellerPage() {
  return (
    <div className="app-shell seller-shell">
      <div className="ambient-field seller-ambient" aria-hidden="true">
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
          <div className="surface-label">Seller studio</div>
        </div>
      </header>

      <main className="seller-main">
        <SellerStudio />
      </main>
    </div>
  );
}
