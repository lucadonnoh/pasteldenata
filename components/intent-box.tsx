"use client";

import {
  ArrowUp,
  ChevronLeft,
  KeyRound,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  useEffect,
  useState,
} from "react";
import { organizeVerifiedPrivatePurchase } from "@/src/orchestrator";
import { ZeroGPrivatePlanner } from "@/src/planner";
import { PrivacyDetails } from "@/components/execution-details";
import { usePurchaseSession } from "@/components/purchase-session";

const examples = [
  "Organize me a date tomorrow in Lisbon. My budget is $200.",
  "Plan a memorable birthday in Lisbon. My budget is $150.",
  "Arrange a romantic evening tomorrow. I can spend $180.",
];

function isUsableZeroGKey(value: string): boolean {
  return value.trim().startsWith("sk-") && value.trim().length >= 12;
}

export function IntentBox() {
  const router = useRouter();
  const { setResult } = usePurchaseSession();
  const [intent, setIntent] = useState(examples[0] ?? "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [departing, setDeparting] = useState(false);
  const [credentialPanelOpen, setCredentialPanelOpen] = useState(true);
  const hasUsableKey = isUsableZeroGKey(apiKey);
  const credentialsCollapsed = hasUsableKey && !credentialPanelOpen;

  useEffect(() => {
    if (
      process.env.NODE_ENV === "development" &&
      window.location.origin === "http://127.0.0.1:3000"
    ) {
      window.location.replace("http://localhost:3000/");
    }
  }, []);

  useEffect(() => {
    if (!hasUsableKey) return;

    const collapseTimer = window.setTimeout(
      () => setCredentialPanelOpen(false),
      900,
    );
    return () => window.clearTimeout(collapseTimer);
  }, [hasUsableKey]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (intent.trim().length < 3 || !hasUsableKey || loading) return;

    setLoading(true);
    setError("");
    setResult(null);
    setDeparting(false);

    try {
      const planner = new ZeroGPrivatePlanner(apiKey.trim());
      const purchase = await organizeVerifiedPrivatePurchase(
        planner,
        intent.trim(),
      );
      setResult(purchase);
      setDeparting(true);
      await new Promise((resolve) => window.setTimeout(resolve, 520));
      router.push("/market");
    } catch (requestError) {
      setDeparting(false);
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Something went wrong.",
      );
    } finally {
      setLoading(false);
    }
  }

  function handleShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  function moveGlassHighlight(event: PointerEvent<HTMLFormElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - bounds.left) / bounds.width) * 100;
    const y = ((event.clientY - bounds.top) / bounds.height) * 100;
    event.currentTarget.style.setProperty("--glass-x", `${x}%`);
    event.currentTarget.style.setProperty("--glass-y", `${y}%`);
  }

  return (
    <section
      className={`workspace ${departing ? "workspace-departing" : ""}`}
      aria-label="Private intent planner"
    >
      <div
        className={`intent-layout ${
          credentialsCollapsed ? "credentials-collapsed" : ""
        }`}
      >
        <aside
          className={`credential-sidebar ${
            credentialsCollapsed ? "credential-sidebar-collapsed" : ""
          }`}
          id="zerog-credentials-panel"
          aria-label="0G credentials"
        >
          <button
            className="credential-sidebar-toggle"
            type="button"
            onClick={() => setCredentialPanelOpen(true)}
            aria-controls="zerog-credentials-panel"
            aria-expanded={!credentialsCollapsed}
            aria-label="Open 0G key settings"
            title="Edit 0G key"
          >
            <KeyRound size={17} />
            <i />
          </button>

          <header>
            <span>
              <KeyRound size={17} />
            </span>
            <div>
              <small>0G CONNECTION</small>
              <strong>Private compute</strong>
            </div>
            {hasUsableKey && (
              <button
                className="credential-sidebar-close"
                type="button"
                onClick={() => setCredentialPanelOpen(false)}
                aria-label="Collapse 0G key settings"
              >
                <ChevronLeft size={15} />
              </button>
            )}
          </header>

          <label className="sidebar-key-field" htmlFor="zerog-key">
            <span>ROUTER API KEY</span>
            <div>
              <KeyRound size={13} aria-hidden="true" />
              <input
                id="zerog-key"
                type="password"
                value={apiKey}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => {
                  const nextKey = event.target.value;
                  setApiKey(nextKey);
                  if (!isUsableZeroGKey(nextKey)) {
                    setCredentialPanelOpen(true);
                  }
                }}
                placeholder="sk-…"
                aria-describedby="zerog-key-help"
              />
            </div>
          </label>

          <div
            className={`credential-status ${
              hasUsableKey ? "credential-ready" : ""
            }`}
            aria-live="polite"
          >
            <i />
            <div>
              <strong>{hasUsableKey ? "Key ready" : "Key required"}</strong>
              <span>
                {hasUsableKey
                  ? "Ready for private inference"
                  : "Add a valid 0G Router key"}
              </span>
            </div>
          </div>

          <footer id="zerog-key-help">
            <ShieldCheck size={13} />
            Held only in this browser tab. Never stored by Pastel.
          </footer>
        </aside>

        <div className="intent-column">
          <form
            className="composer"
            onSubmit={submit}
            onPointerMove={moveGlassHighlight}
            onPointerLeave={(event) => {
              event.currentTarget.style.setProperty("--glass-x", "50%");
              event.currentTarget.style.setProperty("--glass-y", "0%");
            }}
          >
            <div className="composer-chrome">
              <span>What do you need?</span>
              <span>Private session</span>
            </div>

            <div className="composer-input">
              <textarea
                aria-label="Describe what you need"
                value={intent}
                maxLength={1200}
                onChange={(event) => setIntent(event.target.value)}
                onKeyDown={handleShortcut}
                placeholder="Tell the market what you need…"
                rows={3}
              />
              <button
                className="launch-button"
                type="submit"
                disabled={
                  loading || intent.trim().length < 3 || !hasUsableKey
                }
                aria-label="Send intent"
              >
                {loading ? (
                  <span className="spinner" />
                ) : (
                  <ArrowUp size={22} />
                )}
              </button>
            </div>

            <div className="composer-footer">
              <div className="privacy-note">
                <ShieldCheck size={13} />
                Direct to 0G · verified TEE required
              </div>
              <div className="character-count">
                <span>⌘ ENTER</span>
                <b>{intent.length.toString().padStart(4, "0")}</b>
              </div>
            </div>
          </form>

          {!loading && !error && (
            <div className="suggestions">
              <span>Examples</span>
              <div>
                {examples.slice(1).map((example) => (
                  <button
                    type="button"
                    key={example}
                    onClick={() => setIntent(example)}
                  >
                    <span>{example}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="thinking" aria-live="polite">
              <div className="thinking-visual">
                <div className="thinking-ring" />
                <Sparkles size={18} />
              </div>
              <div className="thinking-copy">
                <span>REQUESTING 0G PRIVATE COMPUTE</span>
                <strong>Turning your intent into market mandates</strong>
                <p>
                  Waiting for verified TEE attestation before running auctions
                </p>
              </div>
            </div>
          )}

          {error && (
            <div className="error-message" role="alert">
              <strong>We couldn&apos;t process this intent.</strong>
              <span>{error}</span>
            </div>
          )}

          {!loading && <PrivacyDetails />}
        </div>
      </div>
    </section>
  );
}
