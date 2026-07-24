import { IntentBox } from "@/components/intent-box";
import Link from "next/link";

export default function Home() {
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
          <Link className="mode-link" href="/seller">
            Seller
          </Link>
          <div className="network-status">
            <span className="network-dot" />
            0G
          </div>
        </div>
      </header>

      <main>
        <IntentBox />
      </main>
    </div>
  );
}
