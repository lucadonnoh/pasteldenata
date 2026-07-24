import { IntentBox } from "@/components/intent-box";

export default function Home() {
  return (
    <div className="app-shell">
      <div className="ambient-field" aria-hidden="true">
        <i className="ambient-blue" />
        <i className="ambient-violet" />
        <i className="ambient-mint" />
      </div>

      <header className="site-header">
        <a className="wordmark" href="#" aria-label="Pastel home">
          <span className="wordmark-symbol">
            <i />
          </span>
          <span className="wordmark-type">pastel</span>
        </a>

        <div className="network-status">
          <span className="network-dot" />
          0G
        </div>
      </header>

      <main>
        <IntentBox />
      </main>
    </div>
  );
}
