"use client";

import {
  ArrowUp,
  ChevronLeft,
  KeyRound,
  ShieldCheck,
  UserCheck,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormEvent,
  KeyboardEvent,
  PointerEvent,
  useEffect,
  useState,
} from "react";
import type { DemoResult, PlannerAttestation } from "@/src/domain";
import { UnknownCityError } from "@/src/catalog";
import { organizeVerifiedPrivatePurchase } from "@/src/orchestrator";
import {
  VerifiedUnknownCityError,
  ZeroGPrivatePlanner,
} from "@/src/planner";
import { privateKeyToAccount } from "viem/accounts";
import {
  PrivacyDetails,
  ZeroGVerificationReceipt,
} from "@/components/execution-details";
import { usePurchaseSession } from "@/components/purchase-session";

const examples = [
  "Organize me a date tomorrow in Lisbon. My budget is $200.",
  "Plan a memorable birthday in Lisbon. My budget is $150.",
  "Arrange a romantic evening tomorrow. I can spend $180.",
];

const CREDENTIAL_FADE_MS = 340;

function isUsableZeroGKey(value: string): boolean {
  return value.trim().startsWith("sk-") && value.trim().length >= 12;
}

type CredentialPanelState = "open" | "closing" | "collapsed";

interface StoredWorldIdentity {
  address?: `0x${string}`;
  privateKey?: `0x${string}`;
  humanId?: string;
}

interface DemoReadiness {
  hedera: {
    network: "testnet";
    operatorIdConfigured: boolean;
    operatorKeyConfigured: boolean;
    operatorBalanceHbar: number | null;
    requiredHbar: number;
    balanceOk: boolean;
    ready: boolean;
  };
}

function storedWorldIdentityIsReady(stored: StoredWorldIdentity | null): boolean {
  if (!stored?.humanId || !stored.address || !stored.privateKey) return false;

  try {
    return (
      privateKeyToAccount(stored.privateKey).address.toLowerCase() ===
      stored.address.toLowerCase()
    );
  } catch {
    return false;
  }
}

export function IntentBox() {
  const router = useRouter();
  const { setResult, setSettlement, setSettlementError, setJobId } =
    usePurchaseSession();
  const [intent, setIntent] = useState(examples[0] ?? "");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [departing, setDeparting] = useState(false);
  const [worldVerified, setWorldVerified] = useState(false);
  const [demoReadiness, setDemoReadiness] = useState<DemoReadiness | null>(
    null,
  );
  const [readinessUnavailable, setReadinessUnavailable] = useState(false);
  const [zerogStatus, setZerogStatus] = useState<
    "idle" | "checking" | "ok" | "failed"
  >("idle");
  const [zerogReason, setZerogReason] = useState("");
  const [cityMiss, setCityMiss] = useState<{
    location: string;
    available: string[];
    attestation?: PlannerAttestation;
  } | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem("pastel-world-identity");
        const stored = raw ? (JSON.parse(raw) as StoredWorldIdentity) : null;
        setWorldVerified(storedWorldIdentityIsReady(stored));
      } catch {
        setWorldVerified(false);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/readiness", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Readiness check failed.");
        setDemoReadiness((await response.json()) as DemoReadiness);
      })
      .catch((readinessError: unknown) => {
        if (
          !(readinessError instanceof DOMException) ||
          readinessError.name !== "AbortError"
        ) {
          setReadinessUnavailable(true);
        }
      });

    return () => controller.abort();
  }, []);
  const [credentialPanelState, setCredentialPanelState] =
    useState<CredentialPanelState>("open");
  const hasUsableKey = isUsableZeroGKey(apiKey);
  const credentialsClosing =
    hasUsableKey && credentialPanelState === "closing";
  const credentialsCollapsed =
    hasUsableKey && credentialPanelState === "collapsed";
  const hederaStatus = demoReadiness?.hedera;

  // Live 0G probe: a one-token inference proves the key is valid AND the
  // router account is funded — the two ways a run would otherwise die after
  // the user already typed their intent.
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!hasUsableKey) {
        setZerogStatus("idle");
        setZerogReason("");
        return;
      }
      setZerogStatus("checking");
      void (async () => {
        try {
          const response = await fetch(
            "https://router-api.0g.ai/v1/chat/completions",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${apiKey.trim()}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "0gm-1.0-35b-a3b",
                max_tokens: 1,
                messages: [{ role: "user", content: "ok" }],
              }),
              signal: AbortSignal.timeout(20_000),
            },
          );
          if (cancelled) return;
          if (response.ok) {
            setZerogStatus("ok");
            setZerogReason("");
            return;
          }
          const body = (await response.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          setZerogStatus("failed");
          setZerogReason(
            response.status === 402
              ? "Router balance empty — top up at pc.0g.ai"
              : response.status === 401
                ? "Key rejected by the 0G Router"
                : (body.error?.message ?? `Router returned ${response.status}`),
          );
        } catch {
          if (cancelled) return;
          setZerogStatus("failed");
          setZerogReason("Could not reach the 0G Router.");
        }
      })();
    }, hasUsableKey ? 900 : 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [apiKey, hasUsableKey]);
  const presentPrerequisites =
    Number(zerogStatus === "ok") +
    Number(worldVerified) +
    Number(hederaStatus?.ready ?? false);
  const allPrerequisitesPresent = presentPrerequisites === 3;
  const hederaStatusLabel = readinessUnavailable
    ? "Check unavailable"
    : !hederaStatus
      ? "Checking…"
      : hederaStatus.ready
        ? `Funded · ${Math.round(hederaStatus.operatorBalanceHbar ?? 0).toLocaleString()} ℏ`
        : hederaStatus.operatorIdConfigured &&
            hederaStatus.operatorKeyConfigured &&
            !hederaStatus.balanceOk
          ? hederaStatus.operatorBalanceHbar === null
            ? "Balance unknown"
            : `Balance low · ${Math.round(hederaStatus.operatorBalanceHbar)} ℏ < ${hederaStatus.requiredHbar}`
          : !hederaStatus.operatorIdConfigured &&
            !hederaStatus.operatorKeyConfigured
          ? "ID + key missing"
          : !hederaStatus.operatorIdConfigured
            ? "ID missing"
            : "Key missing";

  useEffect(() => {
    if (
      process.env.NODE_ENV === "development" &&
      window.location.origin === "http://127.0.0.1:3000"
    ) {
      window.location.replace("http://localhost:3000/");
    }
  }, []);

  useEffect(() => {
    if (credentialPanelState !== "closing") return;

    const settleTimer = window.setTimeout(
      () => setCredentialPanelState("collapsed"),
      CREDENTIAL_FADE_MS,
    );
    return () => window.clearTimeout(settleTimer);
  }, [credentialPanelState]);

  function closeCredentialPanel() {
    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    setCredentialPanelState(reducedMotion ? "collapsed" : "closing");
  }

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
      void settleOnHedera(purchase);
      setDeparting(true);
      if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        await new Promise((resolve) => window.setTimeout(resolve, 520));
      }
      router.push("/market");
    } catch (requestError) {
      setDeparting(false);
      if (requestError instanceof VerifiedUnknownCityError) {
        setCityMiss({
          location: requestError.location,
          available: requestError.available,
          attestation: requestError.attestation,
        });
      } else if (requestError instanceof UnknownCityError) {
        setCityMiss({
          location: requestError.location,
          available: requestError.available,
        });
      } else {
        setError(
          requestError instanceof Error
            ? requestError.message
            : "Something went wrong.",
        );
      }
    } finally {
      setLoading(false);
    }
  }

  /**
   * Start real testnet settlement in the trusted local coordinator. The
   * derived plan and mock auction trace leave browser memory; the original
   * prompt and 0G key do not. The market page streams the ledger activity.
   */
  async function settleOnHedera(purchase: DemoResult) {
    setSettlement("pending");
    setSettlementError("");
    setJobId(null);
    try {
      let identityProof:
        | {
            identityAgent: `0x${string}`;
            challengeId: string;
            signature: `0x${string}`;
          }
        | undefined;
      let stored: StoredWorldIdentity | null = null;
      try {
        const raw = window.localStorage.getItem("pastel-world-identity");
        stored = raw ? (JSON.parse(raw) as StoredWorldIdentity) : null;
      } catch {
        // Corrupt optional identity state must not block open listings.
      }
      if (stored?.humanId && stored.address && stored.privateKey) {
        const account = privateKeyToAccount(stored.privateKey);
        if (account.address.toLowerCase() !== stored.address.toLowerCase()) {
          throw new Error("Stored World identity key does not match its address.");
        }
        const challengeResponse = await fetch("/api/world/challenge", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Pastel-Local-Demo": "1",
          },
          body: JSON.stringify({
            identityAgent: account.address,
            planId: purchase.plan.planId,
          }),
        });
        const challenge = (await challengeResponse.json()) as {
          challengeId?: string;
          message?: string;
          error?: string;
        };
        if (
          !challengeResponse.ok ||
          !challenge.challengeId ||
          !challenge.message
        ) {
          throw new Error(
            challenge.error ?? "Could not obtain a World identity challenge.",
          );
        }
        identityProof = {
          identityAgent: account.address,
          challengeId: challenge.challengeId,
          signature: await account.signMessage({
            message: challenge.message,
          }),
        };
      }

      const response = await fetch("/api/hedera/jobs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Pastel-Local-Demo": "1",
        },
        body: JSON.stringify({
          plan: purchase.plan,
          auctions: purchase.auctions,
          mode: "market",
          ...(identityProof ? { identityProof } : {}),
        }),
      });
      const body = (await response.json()) as {
        jobId?: string;
        error?: string;
      };
      if (!response.ok || !body.jobId) {
        throw new Error(body.error ?? "Settlement failed to start.");
      }
      setJobId(body.jobId);
    } catch (settleError) {
      setSettlementError(
        settleError instanceof Error
          ? settleError.message
          : "Settlement failed to start.",
      );
      setSettlement("failed");
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
            credentialsClosing ? "credential-sidebar-closing" : ""
          } ${
            credentialsCollapsed ? "credential-sidebar-collapsed" : ""
          }`}
          id="zerog-credentials-panel"
          aria-label="0G credentials"
        >
          {credentialsCollapsed && (
            <button
              className="credential-sidebar-toggle"
              type="button"
              onClick={() => setCredentialPanelState("open")}
              aria-controls="zerog-credentials-panel"
              aria-expanded={false}
              aria-label="Open 0G key settings"
              title="Edit 0G key"
            >
              <KeyRound size={17} />
              <i />
            </button>
          )}

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
                onClick={closeCredentialPanel}
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
                    setCredentialPanelState("open");
                  }
                }}
                onBlur={(event) => {
                  if (isUsableZeroGKey(event.currentTarget.value)) {
                    closeCredentialPanel();
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
          {cityMiss ? (
            <div className="no-market-result">
              <div className="no-market" role="alert">
                <span className="no-market-eyebrow">NO MARKET HERE YET</span>
                <h2>We don&apos;t have sellers in {cityMiss.location}.</h2>
                <p>
                  Your private plan was understood — but no seller has listed
                  inventory in this city. Pick a live market and your agents
                  will take it from there.
                </p>
                <div className="no-market-cities">
                  {cityMiss.available.map((city) => (
                    <button
                      key={city}
                      type="button"
                      onClick={() => {
                        setIntent(
                          `Organize me a date tomorrow in ${city}. My budget is $200.`,
                        );
                        setCityMiss(null);
                      }}
                    >
                      {city}
                    </button>
                  ))}
                </div>
                <button
                  className="no-market-reset"
                  type="button"
                  onClick={() => setCityMiss(null)}
                >
                  New request
                </button>
              </div>
              {cityMiss.attestation && (
                <ZeroGVerificationReceipt
                  attestation={cityMiss.attestation}
                />
              )}
            </div>
          ) : (
            <>
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
                  loading ||
                  intent.trim().length < 3 ||
                  zerogStatus !== "ok" ||
                  !hederaStatus?.ready
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
              <Link
                className={worldVerified ? "world-note world-note-ok" : "world-note"}
                href="/world"
                title={
                  worldVerified
                    ? "Your agents are backed by your World ID"
                    : "Scarce listings are one-per-human — verify to bid on them"
                }
              >
                <UserCheck size={13} />
                {worldVerified ? "Human-backed · World ID" : "Not verified · scarce listings locked"}
              </Link>
              <div className="character-count">
                <span>⌘ ENTER</span>
                <b>{intent.length.toString().padStart(4, "0")}</b>
              </div>
            </div>
          </form>

          <section
            className={`demo-readiness ${
              allPrerequisitesPresent ? "demo-readiness-complete" : ""
            }`}
            aria-label="Local demo prerequisites"
          >
            <header>
              <div>
                <span>LOCAL DEMO PREFLIGHT</span>
                <strong>{presentPrerequisites}/3 present</strong>
              </div>
              <small>
                {allPrerequisitesPresent
                  ? "Ready for the full demo"
                  : "See exactly what still needs setup"}
              </small>
            </header>
            <div className="readiness-items">
              <div
                className={`readiness-item ${
                  zerogStatus === "ok" ? "readiness-item-ready" : ""
                }`}
                title={
                  zerogStatus === "failed"
                    ? zerogReason
                    : "A one-token live inference verifies the key and the router balance before you can prompt."
                }
              >
                <i />
                <span>
                  <b>0G Router key</b>
                  <small>
                    {zerogStatus === "failed" ? zerogReason : "Verified live"}
                  </small>
                </span>
                <em>
                  {zerogStatus === "ok"
                    ? "Verified"
                    : zerogStatus === "checking"
                      ? "Checking…"
                      : zerogStatus === "failed"
                        ? "Failed"
                        : "Missing"}
                </em>
              </div>
              <Link
                className={`readiness-item ${
                  worldVerified ? "readiness-item-ready" : ""
                }`}
                href="/world"
                title="A complete locally stored World identity is required for scarce listings. Its proof is verified during settlement."
              >
                <i />
                <span>
                  <b>World identity</b>
                  <small>Scarce listings</small>
                </span>
                <em>{worldVerified ? "Present" : "Set up"}</em>
              </Link>
              <div
                className={`readiness-item ${
                  hederaStatus?.ready ? "readiness-item-ready" : ""
                } ${readinessUnavailable ? "readiness-item-unavailable" : ""}`}
                title="Checks only that HEDERA_OPERATOR_ID and HEDERA_OPERATOR_KEY are loaded by this local server. Hedera validates the signature during settlement."
              >
                <i />
                <span>
                  <b>Hedera testnet</b>
                  <small>Local coordinator</small>
                </span>
                <em>{hederaStatusLabel}</em>
              </div>
            </div>
            <p>
              Presence only. 0G TEE proof and Hedera signatures are verified
              live when the run executes.
            </p>
          </section>

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
                <span>REQUESTING + VERIFYING 0G PRIVATE COMPUTE</span>
                <strong>Turning your intent into market mandates</strong>
                <p>
                  Auctions wait for local decryption, the on-chain signer, and
                  exact request + response hash matches
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
            </>
          )}
        </div>
      </div>
    </section>
  );
}
